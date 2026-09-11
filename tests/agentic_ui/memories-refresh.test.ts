// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMemories } from "@/features/settings/hooks/useMemories";

/**
 * The Memories tab keeps TWO caches: the per-agent list (name + summary) and a
 * per-memory body keyed `${agentId}::${name}`. Only the list is re-fetched by
 * the Refresh button, and `ensureDetail` short-circuits whenever the body key
 * already exists — so a memory the agent rewrote showed its **new summary above
 * its old content**, and an already-expanded row could never re-request because
 * `ensureDetail` fires only on expand. The only way out was a full page reload.
 *
 * These pin the reconciliation that fixes it. The body cache is invisible from
 * the screen until it is wrong, which is exactly why it needs a test.
 */

const { api } = vi.hoisted(() => ({
  api: {
    listAgentMemories: vi.fn(),
    getAgentMemory: vi.fn(),
    deleteAgentMemory: vi.fn(),
  },
}));

vi.mock("@/shared/lib/api", () => api);
vi.mock("@/shared/lib/toast", () => ({ toastError: vi.fn() }));

const AGENT = "omni-yaml-v1";
const KEY = `${AGENT}::m1`;

const row = (updatedAt: string, summary = "old summary") => ({
  name: "m1",
  summary,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt,
  sourceConversationId: null,
});
const body = (updatedAt: string, content: string) => ({ ...row(updatedAt), content });

const mount = () => renderHook(() => useMemories({ userId: "u1", toast: vi.fn() }));

/** Open the agent and expand `m1`, leaving its body cached. */
const openWithBody = async (updatedAt: string, content: string) => {
  api.listAgentMemories.mockResolvedValueOnce([row(updatedAt)]);
  api.getAgentMemory.mockResolvedValueOnce(body(updatedAt, content));
  const hook = mount();
  await act(async () => {
    await hook.result.current.ensureLoaded(AGENT);
  });
  await act(async () => {
    await hook.result.current.ensureDetail(AGENT, "m1");
  });
  return hook;
};

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the latter drains recorded calls but
  // leaves queued mockResolvedValueOnce responses in place, so a response one
  // test never consumed leaks into the next and can mask a real failure.
  vi.resetAllMocks();
});

describe("refreshAgent", () => {
  it("re-fetches a body whose updatedAt moved", async () => {
    const { result } = await openWithBody("T1", "old content");
    expect(result.current.detail[KEY].content).toBe("old content");

    // The agent rewrites the memory: new summary, new body, bumped timestamp.
    api.listAgentMemories.mockResolvedValueOnce([row("T2", "new summary")]);
    api.getAgentMemory.mockResolvedValueOnce(body("T2", "new content"));
    await act(async () => {
      await result.current.refreshAgent(AGENT);
    });

    // Both halves must move together — a new summary over an old body is the bug.
    expect(result.current.memories[AGENT][0].summary).toBe("new summary");
    expect(result.current.detail[KEY].content).toBe("new content");
  });

  it("leaves an unchanged body alone instead of re-fetching every row", async () => {
    const { result } = await openWithBody("T1", "old content");
    expect(api.getAgentMemory).toHaveBeenCalledTimes(1);

    api.listAgentMemories.mockResolvedValueOnce([row("T1")]);
    await act(async () => {
      await result.current.refreshAgent(AGENT);
    });

    expect(api.getAgentMemory).toHaveBeenCalledTimes(1);
    expect(result.current.detail[KEY].content).toBe("old content");
  });

  it("re-fetches when a timestamp is missing, since staleness cannot be ruled out", async () => {
    const { result } = await openWithBody("T1", "old content");

    api.listAgentMemories.mockResolvedValueOnce([{ ...row("T1"), updatedAt: null }]);
    api.getAgentMemory.mockResolvedValueOnce(body("T1", "re-read content"));
    await act(async () => {
      await result.current.refreshAgent(AGENT);
    });

    expect(result.current.detail[KEY].content).toBe("re-read content");
  });

  it("drops the body of a memory that is no longer listed", async () => {
    const { result } = await openWithBody("T1", "old content");

    api.listAgentMemories.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.refreshAgent(AGENT);
    });

    expect(result.current.detail[KEY]).toBeUndefined();
  });

  it("drops a stale body it could not replace, rather than keeping the old one", async () => {
    const { result } = await openWithBody("T1", "old content");

    api.listAgentMemories.mockResolvedValueOnce([row("T2", "new summary")]);
    api.getAgentMemory.mockRejectedValueOnce(new Error("upstream down"));
    await act(async () => {
      await result.current.refreshAgent(AGENT);
    });

    // Showing the old body under the new summary is precisely the defect.
    expect(result.current.detail[KEY]).toBeUndefined();
  });
});
