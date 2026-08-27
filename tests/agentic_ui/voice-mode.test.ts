// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatVoiceMode } from "@/features/voice/hooks/useChatVoiceMode";
import { useVoiceBodyTransition } from "@/features/voice/hooks/useVoiceBodyTransition";

/**
 * Entering and leaving voice mode.
 *
 * Two halves, both previously untested. `useChatVoiceMode` owns the refusals —
 * each one must stop short of `start()`, because a half-started realtime session
 * holds a live mic and a WebRTC peer connection that nothing then closes.
 * `useVoiceBodyTransition` owns the staged swap of the conversation body, whose
 * beats are pure timers: get the ordering wrong and the composer either
 * teleports between slots or disappears entirely.
 */

// Hoisted: `vi.mock` is lifted above the imports, so the stub it closes over has
// to be created there too.
const { session } = vi.hoisted(() => ({
  session: {
    isActive: false,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  },
}));

vi.mock("@/features/voice/hooks/useRealtimeVoiceSession", () => ({
  useRealtimeVoiceSession: () => session,
}));

describe("useChatVoiceMode", () => {
  beforeEach(() => {
    session.isActive = false;
    session.start.mockClear();
    session.stop.mockClear();
  });

  const setup = (overrides: { userId?: string | null; selectedAgent?: string } = {}) => {
    const toast = vi.fn();
    const { result } = renderHook(() =>
      useChatVoiceMode({
        toast,
        userId: "u1",
        selectedAgent: "agent-1",
        ...overrides,
      }),
    );
    return { toast, result };
  };

  it("refuses to open a session without a signed-in user", async () => {
    const { toast, result } = setup({ userId: null });

    await act(async () => result.current.handleVoiceMode());

    expect(session.start).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("refuses to open a session with no agent selected", async () => {
    const { toast, result } = setup({ selectedAgent: "" });

    await act(async () => result.current.handleVoiceMode());

    expect(session.start).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("starts the session for the selected agent", async () => {
    const { toast, result } = setup();

    await act(async () => result.current.handleVoiceMode());

    expect(session.start).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", selectedAgent: "agent-1" }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not start a second session over a live one", async () => {
    // Double-triggering (button plus shortcut) would otherwise open a second
    // peer connection and orphan the first, leaving the mic hot after exit.
    session.isActive = true;
    const { result } = setup();

    await act(async () => result.current.handleVoiceMode());

    expect(session.start).not.toHaveBeenCalled();
  });
});

describe("useVoiceBodyTransition", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mount = (voiceActive: boolean, isEmptyConversation = true) =>
    renderHook(
      (props: { voiceActive: boolean; isEmptyConversation: boolean }) =>
        useVoiceBodyTransition(props),
      { initialProps: { voiceActive, isEmptyConversation } },
    );

  /** Advance past a staging beat and let the resulting state settle. */
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("starts in chat mode with the chat bar mounted", () => {
    const { result } = mount(false);

    expect(result.current.bodyTransition.current).toBe("chat");
    expect(result.current.chatBarReady).toBe(true);
    expect(result.current.voiceBarReady).toBe(false);
    expect(result.current.settledVoiceActive).toBe(false);
  });

  it("stages entry: the voice bar waits for the persona to land", () => {
    const { result, rerender } = mount(false);

    rerender({ voiceActive: true, isEmptyConversation: true });
    // Immediately after the flip the body is still chat and the voice bar is
    // NOT ready — showing it here is what made the composer jump slots.
    expect(result.current.voiceBarReady).toBe(false);

    advance(180);
    expect(result.current.bodyTransition.current).toBe("voice");
    expect(result.current.voiceBarReady).toBe(false);

    advance(560);
    expect(result.current.voiceBarReady).toBe(true);
    expect(result.current.settledVoiceActive).toBe(true);
  });

  it("stages exit: the slot stays at the bottom until the voice bar has gone", () => {
    const { result, rerender } = mount(false);
    rerender({ voiceActive: true, isEmptyConversation: true });
    advance(180 + 560);

    rerender({ voiceActive: false, isEmptyConversation: true });
    expect(result.current.voiceBarReady).toBe(false);
    expect(result.current.chatBarReady).toBe(false);
    // Still bottom-anchored: releasing it now teleports the exiting voice bar
    // to the centered slot mid-animation.
    expect(result.current.settledVoiceActive).toBe(true);

    advance(200);
    expect(result.current.settledVoiceActive).toBe(false);

    advance(180 + 560);
    expect(result.current.bodyTransition.current).toBe("chat");
    expect(result.current.chatBarReady).toBe(true);
  });

  it("swaps in parallel once the conversation has messages", () => {
    // Both bars share the sticky-bottom slot there, so staging would only add
    // a gap where neither is mounted.
    const { result, rerender } = mount(false, false);

    rerender({ voiceActive: true, isEmptyConversation: false });

    expect(result.current.bodyTransition.current).toBe("voice");
    expect(result.current.voiceBarReady).toBe(true);
    expect(result.current.chatBarReady).toBe(true);
  });

  it("ignores a re-render that does not change voice mode", () => {
    // Navigating conversations with voice off used to re-run the reverse stage,
    // unmounting and remounting the chat bar with a visible flicker.
    const { result, rerender } = mount(false);

    rerender({ voiceActive: false, isEmptyConversation: false });

    expect(result.current.chatBarReady).toBe(true);
    expect(result.current.bodyTransition.current).toBe("chat");
    expect(result.current.bodyTransition.exiting).toBeNull();
  });

  it("keeps the outgoing surface mounted for its exit beat", () => {
    const { result, rerender } = mount(false, false);

    rerender({ voiceActive: true, isEmptyConversation: false });
    expect(result.current.bodyTransition.exiting).toBe("chat");

    advance(560);
    expect(result.current.bodyTransition.exiting).toBeNull();
  });
});
