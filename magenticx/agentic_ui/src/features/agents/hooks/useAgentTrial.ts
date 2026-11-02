import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelInferenceRun,
  connectInferenceWebSocket,
  downloadAttachment,
  resetAgentTrial,
  resumeInferenceRun,
  startAgentTrial,
  type ResumeInferenceRunBody,
} from "@/shared/lib/api";
import {
  dropDecision,
  isActiveRun,
  isDecisionInFlight,
  markDecisionSent,
  mergeRunEvent,
  nextDecisionDeadline,
  patchMessage,
  pendingTimelineInterrupts,
  pruneExpiredDecisions,
  runHasAgentSignal,
  runThoughts,
  settleDecisionsForRun,
  type DecisionsInFlight,
} from "@/features/inference";
import { trialDraftKey } from "@/features/agents/lib/agentTrial";
import type {
  AgentTrialStartRequest,
  InferenceRun,
  InferenceRunEvent,
  MessageOut,
  TimelineHitlApproval,
} from "@/shared/lib/types";

/** Delay before following a run again after its socket closed while it still ran. */
const REOBSERVE_DELAY_MS = 1000;

export type TrialSendInput = Omit<AgentTrialStartRequest, "conversationId">;
export type TrialSendResult = { ok: true } | { ok: false; error: unknown };

export type AgentTrial = {
  /** The trial conversation, once the first message started it. */
  conversationId: string | null;
  messages: MessageOut[];
  /** The latest run, folded like the main chat's (null before the first message). */
  run: InferenceRun | null;
  /** A run is queued, running or being stopped. */
  active: boolean;
  /** The message is on its way to the bridge (before the run exists). */
  sending: boolean;
  /** Between sending and the agent's first signal: the thinking orb. */
  awaitingSignal: boolean;
  /** User messages a "Draft changed" marker goes before. */
  draftChangedBefore: ReadonlySet<string>;
  /** The approvals and questions still waiting, oldest first. */
  pendingInterrupts: TimelineHitlApproval[];
  send: (input: TrialSendInput) => Promise<TrialSendResult>;
  stop: () => Promise<void>;
  resume: (body: ResumeInferenceRunBody) => Promise<void>;
  /** Clear the chat and delete its conversation on the server. */
  reset: () => Promise<void>;
  /** Save a file the agent attached to an answer. */
  download: (attachment: { blobId?: string | null; name?: string | null }, message: MessageOut) => Promise<void>;
};

/**
 * The builder's "Try it" chat (plan 40): a small, local run loop over the
 * low-level inference API. A message goes to `POST …/custom/try` with the
 * draft as it is now; the run it starts is followed over the ordinary run
 * WebSocket and folded with the main chat's own pure functions
 * (`mergeRunEvent`, the timeline reducer), so it renders exactly as a chat
 * does. Approvals and questions resume it, Stop cancels it, Reset deletes the
 * trial conversation.
 *
 * Nothing here touches the workspace's conversations or `useInferenceRuns`:
 * the run is observed on its own socket and kept in this hook's state only,
 * and the bridge leaves trial runs out of the active-run hydration, so the
 * main chat never adopts one. Leaving the builder (unmount) deletes the trial
 * conversation, fire-and-forget.
 */
export function useAgentTrial({ userId }: { userId: string | null }): AgentTrial {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageOut[]>([]);
  const [run, setRun] = useState<InferenceRun | null>(null);
  const [sending, setSending] = useState(false);
  const [draftChangedBefore, setDraftChangedBefore] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [decisions, setDecisions] = useState<DecisionsInFlight>(() => new Map());

  // Mirrors for callbacks that run outside React's render (socket frames, the
  // unmount cleanup), so they always see the latest values.
  const runRef = useRef<InferenceRun | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastDraftKeyRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const reobserveTimerRef = useRef<number | undefined>(undefined);
  const sendingRef = useRef(false);
  const tempSeqRef = useRef(0);
  // Bumped by Reset and unmount: anything still in flight from before is dropped.
  const generationRef = useRef(0);
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const stopObserving = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    window.clearTimeout(reobserveTimerRef.current);
  }, []);

  const applyEvent = useCallback(
    (event: InferenceRunEvent, generation: number) => {
      if (generation !== generationRef.current) return;
      const next = mergeRunEvent(runRef.current, event);
      runRef.current = next;
      setRun(next);
      const { message } = event;
      if (message) setMessages((prev) => patchMessage(prev, message));
      const active = isActiveRun(next);
      setDecisions((prev) =>
        settleDecisionsForRun(
          prev,
          {
            runId: next.id,
            active,
            pendingInterruptIds: pendingTimelineInterrupts(next.timeline).map((item) => item.id),
            streamed: event.type === "events" && (event.events?.length ?? 0) > 0,
          },
          Date.now(),
        ),
      );
      if (!active) stopObserving();
    },
    [stopObserving],
  );

  const observe = useCallback(
    (runId: string, generation: number) => {
      const owner = userIdRef.current;
      if (!owner || generation !== generationRef.current) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      // The socket client retries drops itself; it settles when the socket
      // closed for good. A run still active then is followed again (the server
      // answers a finished run with its final snapshot, so this converges).
      const again = () => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        if (!isActiveRun(runRef.current) || runRef.current?.id !== runId) return;
        window.clearTimeout(reobserveTimerRef.current);
        reobserveTimerRef.current = window.setTimeout(
          () => observe(runId, generation),
          REOBSERVE_DELAY_MS,
        );
      };
      void connectInferenceWebSocket(
        owner,
        runId,
        (event) => applyEvent(event, generation),
        controller.signal,
      )
        .then(again)
        .catch((error: unknown) => {
          if ((error as { name?: string })?.name === "AbortError") return;
          again();
        });
    },
    [applyEvent],
  );

  const send = useCallback(
    async (input: TrialSendInput): Promise<TrialSendResult> => {
      const owner = userIdRef.current;
      if (!owner) return { ok: false, error: new Error("Not signed in.") };
      if (sendingRef.current || isActiveRun(runRef.current)) {
        return { ok: false, error: new Error("The agent is still answering.") };
      }
      const generation = generationRef.current;
      const key = trialDraftKey(input);
      const changed = lastDraftKeyRef.current !== null && lastDraftKeyRef.current !== key;

      // The question shows at once ("sending"), as in the main chat.
      const tempId = `temp-trial-${++tempSeqRef.current}`;
      const now = new Date();
      const echo: MessageOut = {
        id: tempId,
        sender: "user",
        content: input.message,
        created_at: now,
        updated_at: now,
        attachments: [],
      };
      sendingRef.current = true;
      setSending(true);
      setMessages((prev) => [...prev, echo]);
      if (changed) setDraftChangedBefore((prev) => new Set(prev).add(tempId));

      const withoutEcho = () => {
        setMessages((prev) => prev.filter((item) => item.id !== tempId));
        setDraftChangedBefore((prev) => {
          if (!prev.has(tempId)) return prev;
          const next = new Set(prev);
          next.delete(tempId);
          return next;
        });
      };

      try {
        const response = await startAgentTrial(owner, {
          ...input,
          conversationId: conversationIdRef.current,
        });
        const startedId = response.run.conversationId || response.detail.id;
        if (generation !== generationRef.current) {
          // Reset (or leaving) while the message was on its way: the chat it
          // started is not wanted any more.
          void resetAgentTrial(owner, startedId).catch(() => undefined);
          return { ok: false, error: new Error("The chat was reset.") };
        }
        conversationIdRef.current = startedId;
        setConversationId(startedId);
        lastDraftKeyRef.current = key;
        const questionId =
          response.message.parentMessageId ?? response.run.parentMessageId ?? null;
        setMessages((prev) => {
          let next = prev.filter((item) => item.id !== tempId);
          for (const item of response.detail.messages ?? []) next = patchMessage(next, item);
          return patchMessage(next, response.message);
        });
        setDraftChangedBefore((prev) => {
          if (!prev.has(tempId)) return prev;
          const next = new Set(prev);
          next.delete(tempId);
          if (questionId) next.add(questionId);
          return next;
        });
        applyEvent({ type: "snapshot", run: response.run, message: response.message }, generation);
        if (isActiveRun(runRef.current)) observe(response.run.id, generation);
        return { ok: true };
      } catch (error) {
        if (generation === generationRef.current) withoutEcho();
        return { ok: false, error };
      } finally {
        if (generation === generationRef.current) {
          sendingRef.current = false;
          setSending(false);
        }
      }
    },
    [applyEvent, observe],
  );

  const stop = useCallback(async () => {
    const owner = userIdRef.current;
    const current = runRef.current;
    if (!owner || !current || !isActiveRun(current)) return;
    const generation = generationRef.current;
    const cancelled = await cancelInferenceRun(owner, current.id);
    applyEvent({ type: "update", run: cancelled }, generation);
  }, [applyEvent]);

  const resume = useCallback(
    async (body: ResumeInferenceRunBody) => {
      const owner = userIdRef.current;
      const current = runRef.current;
      if (!owner || !current) throw new Error("Nothing to answer.");
      const generation = generationRef.current;
      let resumed: InferenceRun;
      try {
        resumed = await resumeInferenceRun(owner, current.id, body);
      } catch (error) {
        setDecisions((prev) => dropDecision(prev, current.id, body.interruptId));
        throw error;
      }
      applyEvent({ type: "update", run: resumed }, generation);
      if (generation === generationRef.current) {
        setDecisions((prev) => markDecisionSent(prev, current.id, body.interruptId, Date.now()));
      }
    },
    [applyEvent],
  );

  const reset = useCallback(async () => {
    const owner = userIdRef.current;
    const id = conversationIdRef.current;
    const current = runRef.current;
    generationRef.current += 1;
    stopObserving();
    runRef.current = null;
    conversationIdRef.current = null;
    lastDraftKeyRef.current = null;
    sendingRef.current = false;
    setSending(false);
    setRun(null);
    setConversationId(null);
    setMessages([]);
    setDraftChangedBefore(new Set());
    setDecisions(new Map());
    if (!owner || !id) return;
    if (current && isActiveRun(current)) {
      await cancelInferenceRun(owner, current.id).catch(() => undefined);
    }
    await resetAgentTrial(owner, id);
  }, [stopObserving]);

  const download = useCallback(
    async (attachment: { blobId?: string | null; name?: string | null }, message: MessageOut) => {
      const owner = userIdRef.current;
      const id = conversationIdRef.current;
      if (!owner || !id || !attachment.blobId) throw new Error("This file can't be downloaded.");
      await downloadAttachment({
        userId: owner,
        conversationId: id,
        messageId: message.id,
        blobId: attachment.blobId,
        filename: attachment.name || "attachment",
      });
    },
    [],
  );

  // Leaving the builder discards the chat: stop following it, stop its run
  // and delete the conversation. Fire-and-forget — the page is going away,
  // and the bridge sweeps trial conversations it missed.
  useEffect(
    () => () => {
      generationRef.current += 1;
      stopObserving();
      const owner = userIdRef.current;
      const id = conversationIdRef.current;
      const current = runRef.current;
      conversationIdRef.current = null;
      if (!owner || !id) return;
      const cancel =
        current && isActiveRun(current)
          ? cancelInferenceRun(owner, current.id).catch(() => undefined)
          : Promise.resolve(undefined);
      void cancel.then(() => resetAgentTrial(owner, id)).catch(() => undefined);
    },
    [stopObserving],
  );

  // A sent decision whose window ran out shows its approval again.
  useEffect(() => {
    const deadline = nextDecisionDeadline(decisions);
    if (deadline === null) return undefined;
    const timer = window.setTimeout(
      () => setDecisions((prev) => pruneExpiredDecisions(prev, Date.now())),
      Math.max(0, deadline - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [decisions]);

  const active = isActiveRun(run);
  const pendingInterrupts = useMemo(() => {
    if (!run?.timeline || !active) return [];
    return pendingTimelineInterrupts(run.timeline).filter(
      (item) => !isDecisionInFlight(decisions, run.id, item.id, Date.now()),
    );
  }, [run, active, decisions]);

  return {
    conversationId,
    messages,
    run,
    active,
    sending,
    awaitingSignal: sending || (active && run !== null && !runHasAgentSignal(run, runThoughts(run))),
    draftChangedBefore,
    pendingInterrupts,
    send,
    stop,
    resume,
    reset,
    download,
  };
}
