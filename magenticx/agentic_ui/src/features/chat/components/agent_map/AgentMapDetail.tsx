import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bot, CornerDownRight, MessageSquare, Timer, Wrench } from "lucide-react";

import { cn, normalizeBulletMarkdown } from "@/shared/lib/utils";
import { Card } from "@/shared/ui/card";
import { Response } from "@/shared/ui/ai-elements/response";
import type { SubagentBlock } from "@/shared/lib/types";
import {
  agentNodeDuration,
  agentTranscript,
  type AgentMapAnswer,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";
import {
  TimelineSequence,
  type TimelineSubagentLinks,
} from "@/features/chat/components/message_parts/TimelineSequence";
import { AiTransitionIndicator } from "@/features/chat/components/AiTransitionIndicator";
import { STATUS_META } from "@/features/chat/components/message_parts/subagentStatus";

// The agent map's detail view: one sub-agent, opened from the tree. A header
// with what it is and where it sits (the answer, the sub-agent that delegated
// to it), then its work read as a conversation: the instruction it was given,
// as a user message from the agent that delegated, and its reply drawn by the
// main chat's own renderers (thinking and tool steps, Markdown with diagrams
// and tables, the cards of the sub-agents it delegated to — a click on one
// opens it here, a step deeper). Read only: there is no composer.

const EASE = [0.22, 1, 0.36, 1] as const;

type AgentMapDetailProps = {
  node: AgentMapNode;
  answer: AgentMapAnswer;
  /** The sub-agents above it, outermost first. */
  ancestors: AgentMapNode[];
  /** The conversation's main agent: who delegated to a top-level sub-agent. */
  agentName: string;
  onOpenNode: (id: string) => void;
  now: number;
};

function Fact({ icon: Icon, children }: { icon: typeof Bot; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground tabular-nums">
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

const CLAMP_PX = 168;

/**
 * The instruction, as the chat draws a user message. A long one starts clipped
 * behind "Show more", as the approval card does.
 */
function InstructionBubble({ from, to, text }: { from: string; to: string; text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const markdown = useMemo(() => normalizeBulletMarkdown(text), [text]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > CLAMP_PX + 24);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [markdown]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <p className="flex max-w-full items-center gap-1.5 pr-1 text-[11.5px] text-muted-foreground">
        <CornerDownRight className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">
          {from} <span aria-hidden>→</span>
          <span className="sr-only">to</span> {to}
        </span>
      </p>
      <Card className="ml-auto max-w-[88%] border-border bg-chat-user p-4 text-chat-user-foreground shadow-card">
        <div
          className={cn("relative min-w-0", long && !open && "overflow-hidden")}
          style={long && !open ? { maxHeight: CLAMP_PX } : undefined}
        >
          <div ref={bodyRef}>
            {markdown.trim() ? (
              <Response>{markdown}</Response>
            ) : (
              <p className="text-sm opacity-70">No instruction was recorded.</p>
            )}
          </div>
          {long && !open ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[hsl(var(--chat-user))] to-transparent"
            />
          ) : null}
        </div>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="mt-1.5 rounded text-[12px] font-medium underline-offset-2 opacity-80 hover:underline hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {open ? "Show less" : "Show more"}
          </button>
        ) : null}
      </Card>
    </div>
  );
}

export function AgentMapDetail({
  node,
  answer,
  ancestors,
  agentName,
  onOpenNode,
  now,
}: AgentMapDetailProps) {
  const reduceMotion = useReducedMotion();
  const meta = node.status ? STATUS_META[node.status] : null;
  const active = node.status === "running";
  const duration = agentNodeDuration(node, now);
  const parent = ancestors[ancestors.length - 1];
  const transcript = useMemo(() => agentTranscript(node), [node]);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const onToggleThinking = useCallback((key: string, next?: boolean) => {
    setExpandedThinking((current) => ({ ...current, [key]: next ?? !current[key] }));
  }, []);
  // Its sub-agents' cards: the map's status for each, and a click opens it here.
  // Stable while the children are (the panel re-renders every second while a
  // sub-agent runs), so the reply's blocks are not re-derived on each tick.
  const openNodeRef = useRef(onOpenNode);
  openNodeRef.current = onOpenNode;
  const subagentLinks = useMemo<TimelineSubagentLinks>(() => {
    const byTask = new Map(node.children.map((child) => [child.taskId, child]));
    return {
      statusOf: (block: SubagentBlock) => byTask.get(block.taskId)?.status ?? null,
      onOpen: (block: SubagentBlock) => {
        const child = byTask.get(block.taskId);
        if (child) openNodeRef.current(child.id);
      },
    };
  }, [node.children]);

  const reveal = (step: number) =>
    reduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.32, ease: EASE, delay: 0.05 + step * 0.05 },
        };
  const hasReply = transcript.timeline.blocks.length > 0;

  return (
    <div className="space-y-5 pb-2">
      <motion.header {...reveal(0)} className="flex items-start gap-3.5">
        <span
          className={cn(
            "relative flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border",
            active
              ? "border-[hsl(var(--subagent-active)/0.35)] bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))] shadow-[0_0_24px_-4px_hsl(var(--subagent-active-glow)/0.7)]"
              : "border-border/70 bg-primary/[0.08] text-primary",
          )}
        >
          <Bot className="h-5 w-5" aria-hidden />
        </span>
        <div className="flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground">
              {node.title}
            </h3>
            {meta ? (
              <span
                className={cn(
                  "flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                  meta.chip,
                )}
              >
                {meta.icon}
                {meta.label}
              </span>
            ) : null}
          </div>
          {node.type ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{node.type}</p>
          ) : null}
        </div>
      </motion.header>

      <motion.div {...reveal(1)} className="flex flex-wrap gap-2">
        <Fact icon={MessageSquare}>
          Q{answer.number} · {answer.question || "Untitled question"}
        </Fact>
        {parent ? <Fact icon={CornerDownRight}>Delegated by {parent.title}</Fact> : null}
        {duration ? <Fact icon={Timer}>{duration}</Fact> : null}
        {node.toolCount ? (
          <Fact icon={Wrench}>
            {node.toolCount} tool call{node.toolCount === 1 ? "" : "s"}
          </Fact>
        ) : null}
      </motion.div>

      {/* The conversation. Keyed by node: another sub-agent mounts fresh, its
          thinking blocks in their own default state. */}
      <motion.section
        key={node.id}
        {...reveal(2)}
        aria-label={`${node.title}: instruction and reply`}
        className="space-y-5 border-t border-border/50 pt-5"
      >
        <InstructionBubble
          from={parent?.title ?? agentName}
          to={node.title}
          text={transcript.instruction}
        />

        <div className="flex w-full min-w-0 flex-col gap-3 text-card-foreground">
          {hasReply ? (
            <TimelineSequence
              timeline={transcript.timeline}
              runId={node.messageId}
              isStreaming={transcript.live}
              expandedThinking={expandedThinking}
              onToggleThinking={onToggleThinking}
              subagentLinks={subagentLinks}
            />
          ) : transcript.live ? null : (
            <p className="text-sm text-muted-foreground">No reply was recorded.</p>
          )}
          {/* Before its first step, the thinking orb the chat shows. */}
          <AiTransitionIndicator visible={transcript.live && !hasReply} />
        </div>
      </motion.section>
    </div>
  );
}
