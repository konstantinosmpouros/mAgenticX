// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMemories } from "@/features/settings/hooks/useMemories";

/**
 * The Memories tab holds no cache, and that is the whole design.
 *
 * The writer here is an **agent**, running in the background via its `remember`
 * tool. Nothing tells the client when it writes, so anything held from an
 * earlier read can already be wrong and there is no way to know. Re-reading on
 * every open is the only answer that is always correct.
 *
 * It replaced a cache whose failure was invisible: the list carried name +
 * summary while the body lived under a separate key, so a memory the agent
 * rewrote showed its **new summary above its old content**. Making the Refresh
 * button honest took a reconciliation pass comparing `updatedAt` per row —
 * machinery that existed only to repair a cache nobody needed. Button and pass
 * are both gone.
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

const row = (updatedAt: string, summary = "a summary") => ({
  name: "m1",
  summary,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt,
  sourceConversationId: null,
});
const body = (updatedAt: string, content: string) => ({ ...row(updatedAt), content });

const mount = () => renderHook(() => useMemories({ userId: "u1", toast: vi.fn() }));

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the latter drains recorded calls but
  // leaves queued mockResolvedValueOnce responses in place, so a response one
  // test never consumed leaks into the next and can mask a real failure.
  vi.resetAllMocks();
});

describe("opening an agent", () => {
  it("re-reads the list every time, not once per session", async () => {
    api.listAgentMemories.mockResolvedValue([row("T1")]);
    const { result } = mount();

    await act(async () => {
      await result.current.loadAgent(AGENT);
    });
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });

    expect(api.listAgentMemories).toHaveBeenCalledTimes(2);
  });

  it("shows what the second read returned, not the first", async () => {
    api.listAgentMemories.mockResolvedValueOnce([row("T1", "old summary")]);
    const { result } = mount();
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });
    expect(result.current.memories[AGENT][0].summary).toBe("old summary");

    api.listAgentMemories.mockResolvedValueOnce([row("T2", "new summary")]);
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });
    expect(result.current.memories[AGENT][0].summary).toBe("new summary");
  });

  it("keeps the previous list when a re-read fails", async () => {
    // A failed refresh must not blank a list the user is reading.
    api.listAgentMemories.mockResolvedValueOnce([row("T1", "old summary")]);
    const { result } = mount();
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });

    api.listAgentMemories.mockRejectedValueOnce(new Error("upstream down"));
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });

    expect(result.current.memories[AGENT][0].summary).toBe("old summary");
  });
});

describe("opening a memory", () => {
  it("re-reads the body every time", async () => {
    api.getAgentMemory.mockResolvedValue(body("T1", "content"));
    const { result } = mount();

    await act(async () => {
      await result.current.loadDetail(AGENT, "m1");
    });
    await act(async () => {
      await result.current.loadDetail(AGENT, "m1");
    });

    expect(api.getAgentMemory).toHaveBeenCalledTimes(2);
  });

  it("shows the body the agent last wrote, not the one first read", async () => {
    // The exact defect the cache produced: a new summary over an old body.
    api.getAgentMemory.mockResolvedValueOnce(body("T1", "old content"));
    const { result } = mount();
    await act(async () => {
      await result.current.loadDetail(AGENT, "m1");
    });
    expect(result.current.detail[KEY].content).toBe("old content");

    api.getAgentMemory.mockResolvedValueOnce(body("T2", "new content"));
    await act(async () => {
      await result.current.loadDetail(AGENT, "m1");
    });
    expect(result.current.detail[KEY].content).toBe("new content");
  });

  it("does not fire a second request while one is in flight", async () => {
    // The one guard that survives: concurrency, not caching.
    let release: (value: unknown) => void = () => {};
    api.getAgentMemory.mockReturnValueOnce(new Promise((r) => (release = r)));
    const { result } = mount();

    await act(async () => {
      void result.current.loadDetail(AGENT, "m1");
      void result.current.loadDetail(AGENT, "m1");
      release(body("T1", "content"));
    });

    expect(api.getAgentMemory).toHaveBeenCalledTimes(1);
  });
});

describe("deleting", () => {
  it("drops the row and its body immediately", async () => {
    api.listAgentMemories.mockResolvedValueOnce([row("T1")]);
    api.getAgentMemory.mockResolvedValueOnce(body("T1", "content"));
    api.deleteAgentMemory.mockResolvedValueOnce(undefined);
    const { result } = mount();
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });
    await act(async () => {
      await result.current.loadDetail(AGENT, "m1");
    });

    await act(async () => {
      await result.current.deleteMemory(AGENT, "m1");
    });

    expect(result.current.memories[AGENT]).toEqual([]);
    expect(result.current.detail[KEY]).toBeUndefined();
  });

  it("restores the row when the delete fails", async () => {
    api.listAgentMemories.mockResolvedValueOnce([row("T1")]);
    api.deleteAgentMemory.mockRejectedValueOnce(new Error("nope"));
    const { result } = mount();
    await act(async () => {
      await result.current.loadAgent(AGENT);
    });

    await act(async () => {
      await result.current.deleteMemory(AGENT, "m1");
    });

    expect(result.current.memories[AGENT].map((m) => m.name)).toEqual(["m1"]);
  });
});
