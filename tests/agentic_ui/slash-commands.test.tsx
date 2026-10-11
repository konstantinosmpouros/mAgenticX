// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Slash commands in the composer (plan 35, phase 3).
 *
 * Pinned:
 * - the rules: a `/word` at the caret — at the start or mid-sentence, never
 *   inside a word — is a query; runnable commands first, prefix matches first;
 *   the first runnable `/name` in the draft is its command; picking writes
 *   `/name ` in place (or takes an action's token out); actions the app cannot
 *   run are never offered;
 * - the contract drops malformed rows and reads anything unclear as unavailable;
 *   the message transform keeps only a well-formed command;
 * - the hook: the caret opens the menu mid-sentence, ↓/Enter picks, the send
 *   carries the draft's command, an action runs at once, an unavailable one only
 *   explains itself, Esc closes, an action command runs instead of sending;
 * - the actions call what their buttons call, with the same guards;
 * - sending: the command goes in the payload and the optimistic bubble, is
 *   cleared, and comes back if the send fails.
 */
vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  getAgentCommands: vi.fn(),
}));

import { getAgentCommands } from "@/shared/lib/api";
import { SlashCommandListSchema } from "@/shared/lib/schemas";
import { transformMessage } from "@/shared/lib/consts";
import {
  applyPick,
  filterCommands,
  findCommand,
  offeredCommands,
  textWithout,
  tokenAtCaret,
} from "@/features/chat/lib/slashCommands";
import { useSlashCommands } from "@/features/chat/hooks/useSlashCommands";
import { useSpaceAbove } from "@/features/chat/hooks/useSpaceAbove";
import { createCommandActions } from "@/features/chat/handlers/commandActions";
import { createInferenceHandlers } from "@/features/inference";
import type { InferenceStartResponse, MessageOut, SlashCommand } from "@/shared/lib/types";

const cmd = (name: string, overrides: Partial<SlashCommand> = {}): SlashCommand => ({
  name, kind: "prompt", description: name, argumentHint: "", readOnly: false,
  source: "builtin", available: true, unavailableReason: null, ...overrides,
});
const CATALOG = [
  cmd("explain"), cmd("export", { kind: "action" }), cmd("compact", { kind: "action" }),
  cmd("rename", { kind: "action", argumentHint: "[new title]" }),
  cmd("remember", { available: false, unavailableReason: "Memory is turned off in your settings." }),
  cmd("files", { kind: "action" }),
];

describe("the rules", () => {
  it("reads the /word at the caret, at the start or mid-sentence, never inside a word", () => {
    expect(tokenAtCaret("/ex", 3)).toEqual({ start: 0, end: 3, query: "ex" });
    expect(tokenAtCaret("please /ex now", 10)).toEqual({ start: 7, end: 10, query: "ex" });
    expect(tokenAtCaret("please /explain", 10)).toEqual({ start: 7, end: 15, query: "ex" }); // caret mid-word
    expect(tokenAtCaret("see a/b", 7)).toBeNull();
    expect(tokenAtCaret("please /ex now", 14)).toBeNull();               // the caret moved on
  });

  it("offers runnable commands first, prefix matches first, and no action the app lacks", () => {
    const offered = offeredCommands(CATALOG);
    expect(offered.map((c) => c.name)).not.toContain("files");
    expect(filterCommands(offered, "e").map((c) => c.name)).toEqual(["explain", "export", "rename", "remember"]);
  });

  it("finds the draft's command: the first runnable /name that lives in the text", () => {
    expect(findCommand("please /explain this", CATALOG)).toMatchObject({ command: { name: "explain" }, start: 7, end: 15 });
    expect(findCommand("/remember x /explain y", CATALOG)?.command.name).toBe("explain"); // unavailable skipped
    expect(findCommand("/compact now", CATALOG)).toBeNull();     // an action without text never lives in the text
    expect(findCommand("a/explain", CATALOG)).toBeNull();
    expect(findCommand("/explainer", CATALOG)).toBeNull();
  });

  it("writes the pick in place, or takes an action's token out", () => {
    const token = tokenAtCaret("please /ex now", 10)!;
    expect(applyPick("please /ex now", token, CATALOG[0])).toEqual({ draft: "please /explain now", caret: 16 });
    expect(applyPick("please /co now", tokenAtCaret("please /co now", 10)!, CATALOG[2])).toEqual({ draft: "please now", caret: 7 });
    expect(textWithout("/rename  Quarterly plan", findCommand("/rename  Quarterly plan", CATALOG)!)).toBe("Quarterly plan");
  });
});

describe("the contract", () => {
  it("drops malformed rows and reads unclear availability as unavailable", () => {
    const parsed = SlashCommandListSchema.parse({
      commands: [{ name: "explain", kind: "prompt", available: true }, { name: "Bad Name", kind: "prompt" },
        { name: "x", kind: "macro" }, { name: "fix", kind: "prompt" }],
    });
    expect(parsed.map((c) => [c.name, c.available])).toEqual([["explain", true], ["fix", false]]);
  });

  it("keeps a well-formed command on a message and drops junk", () => {
    expect(transformMessage({ id: "m", sender: "user", command: { name: "explain" } }).command).toEqual({ name: "explain" });
    expect(transformMessage({ id: "m", sender: "user", command: { name: "<script>" } }).command).toBeNull();
    expect(transformMessage({ id: "m", sender: "user" }).command).toBeNull();
  });
});

describe("useSlashCommands", () => {
  beforeEach(() => vi.mocked(getAgentCommands).mockResolvedValue(CATALOG));

  const setup = (draft: string, caret = draft.length) => {
    const props = {
      userId: "u1", agentId: `agent-${Math.random()}`, draft,
      setDraft: vi.fn(), setPendingCommand: vi.fn(), runAction: vi.fn(), notify: vi.fn(),
      textareaRef: { current: null },
    };
    const hook = renderHook((p) => useSlashCommands(p), { initialProps: props });
    act(() => hook.result.current.onCaretMove(caret));
    return { props, hook };
  };
  const key = (key: string) => ({ key, shiftKey: false, preventDefault: vi.fn() }) as never;

  it("opens at the caret mid-sentence and writes the pick in place", async () => {
    const { props, hook } = setup("please /ex now", 10);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    expect(hook.result.current.items[0].name).toBe("explain");
    act(() => void hook.result.current.onKeyDown(key("Enter")));
    expect(props.setDraft).toHaveBeenCalledWith("please /explain now");
    expect(props.runAction).not.toHaveBeenCalled();
  });

  it("makes the draft's command the one a send carries", async () => {
    const { props, hook } = setup("please /explain this");
    await waitFor(() => expect(hook.result.current.found?.command.name).toBe("explain"));
    expect(props.setPendingCommand).toHaveBeenLastCalledWith({ name: "explain" });
  });

  it("runs an action at once and only explains an unavailable command", async () => {
    const { props, hook } = setup("/");
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    act(() => hook.result.current.select(CATALOG.find((c) => c.name === "compact")!));
    expect(props.runAction).toHaveBeenCalledWith("compact", "");
    act(() => hook.result.current.select(CATALOG.find((c) => c.name === "remember")!));
    expect(props.notify).toHaveBeenCalledWith("/remember isn't available", "Memory is turned off in your settings.");
  });

  it("closes on Escape, and runs an action command instead of sending", async () => {
    const { hook } = setup("/ex");
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    act(() => void hook.result.current.onKeyDown(key("Escape")));
    expect(hook.result.current.open).toBe(false);

    const rename = setup("/rename Quarterly plan");
    await waitFor(() => expect(rename.hook.result.current.found?.command.name).toBe("rename"));
    let handled = false;
    act(() => { handled = rename.hook.result.current.submitAction(); });
    expect(handled).toBe(true);
    expect(rename.props.runAction).toHaveBeenCalledWith("rename", "Quarterly plan");
  });
});

describe("the actions", () => {
  const ctx = (overrides = {}) => ({
    conversationId: "c1", compaction: null, handleNewChat: vi.fn(), openProfilePanel: vi.fn(),
    handleRenameConversation: vi.fn(), openFullConversationShareDialog: vi.fn(), exportConversationPdf: vi.fn(),
    notify: vi.fn(), ...overrides,
  });

  it("call what their buttons call, with the same guards", () => {
    const c = ctx({ compaction: { status: "idle", disabledReason: "Not yet.", compactingMessageId: null, compact: vi.fn() } });
    const run = createCommandActions(c);
    run("compact", "");
    expect(c.notify).toHaveBeenCalledWith("Can't compact right now", "Not yet.");
    run("memories", "");
    expect(c.openProfilePanel).toHaveBeenCalledWith("memories");
    run("rename", "");
    expect(c.notify).toHaveBeenCalledWith("Type the new title after /rename");
    run("rename", "New title");
    expect(c.handleRenameConversation).toHaveBeenCalledWith("c1", "New title");
    run("files", "");   // not offered yet: ignored
  });
});

describe("sending a command", () => {
  const startResponse = { runId: "r1" } as unknown as InferenceStartResponse;
  const makeCtx = (overrides: Record<string, unknown> = {}) => ({
    userId: "u1", selectedAgent: "agent-1", isPrivateMode: false, messages: [] as MessageOut[],
    attachments: [] as File[], agents: [{ id: "agent-1", name: "Omni" }], currentConversation: null,
    currentMessage: "/explain the loop", pendingCommand: { name: "explain" }, isSendingMessage: false,
    setMessages: vi.fn(), setCurrentMessage: vi.fn(), setPendingCommand: vi.fn(), setAttachments: vi.fn(),
    setIsSendingMessage: vi.fn(), setCurrentConversation: vi.fn(), setConversations: vi.fn(), toast: vi.fn(),
    setThinkingState: vi.fn(), setShowAiTransition: vi.fn(), streamAbortRef: { current: null },
    beginInferenceRun: vi.fn(async () => startResponse), stopActiveInferenceRun: vi.fn(), persistUIState: vi.fn(),
    ...overrides,
  });

  it("sends the command beside the text, never in it, then clears it", async () => {
    const ctx = makeCtx();
    await createInferenceHandlers(ctx as never).handleSendMessage();
    expect(ctx.beginInferenceRun).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ content: "the loop", command: { name: "explain" } }) }),
    );
    const optimistic = (ctx.setMessages.mock.calls[0][0] as (p: MessageOut[]) => MessageOut[])([]);
    expect(optimistic[0]).toMatchObject({ content: "the loop", command: { name: "explain" } });
    expect(ctx.setPendingCommand).toHaveBeenCalledWith(null);
  });

  it("gives the command back if the send fails", async () => {
    const ctx = makeCtx({ beginInferenceRun: vi.fn(async () => { throw new Error("down"); }) });
    await createInferenceHandlers(ctx as never).handleSendMessage();
    expect(ctx.beginInferenceRun).toHaveBeenCalled();
    expect(ctx.setPendingCommand).toHaveBeenLastCalledWith({ name: "explain" });
    expect(ctx.setCurrentMessage).toHaveBeenLastCalledWith("/explain the loop");   // the draft, as typed
  });

  it("sends a command alone as a command with no text", async () => {
    const ctx = makeCtx({ currentMessage: "/explain" });
    await createInferenceHandlers(ctx as never).handleSendMessage();
    expect(ctx.beginInferenceRun).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ content: undefined, command: { name: "explain" } }) }),
    );
  });
});

describe("the menu stays below the header", () => {
  const rect = (el: HTMLElement, box: Partial<DOMRect>) => {
    el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...box }) as DOMRect;
  };

  it("is as tall as the room between the header and the composer, and follows it while open", async () => {
    const header = document.createElement("div");
    header.setAttribute("data-chat-header", "");
    rect(header, { bottom: 64 });
    const composer = document.createElement("div");
    rect(composer, { top: 300 });
    const panel = document.createElement("div");
    composer.appendChild(panel);
    document.body.append(header, composer);

    const { result } = renderHook(() => useSpaceAbove({ current: panel }, { gapPx: 8, fallbackPx: 288 }));
    expect(result.current).toBe(300 - 64 - 16);   // never reaches the header

    // The browser is resized while the menu is open: the composer moves up.
    rect(composer, { top: 200 });
    await waitFor(() => expect(result.current).toBe(200 - 64 - 16));

    header.remove();
    composer.remove();
  });
});
