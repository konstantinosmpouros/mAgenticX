// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCatalogueSearch } from "@/features/settings/hooks/useCatalogueSearch";
import { CATALOG_SEARCH_DEBOUNCE_MS } from "@/shared/lib/consts";
import { CatalogueSearchPageSchema } from "@/shared/lib/schemas";

/**
 * The Skills tab's catalogue is a server-side search (plan 30): there is no list
 * to download, so every query is a request. Three properties keep that cheap
 * and correct, and each fails silently when broken:
 *
 * - keystrokes are debounced — typing "postgres" is one request, not eight;
 * - a newer query aborts the one in flight, so a slow response for "pos" can
 *   never overwrite the results for "postgres";
 * - the empty-query total is remembered as the catalogue size for the hub row.
 */

const { api } = vi.hoisted(() => ({ api: { searchCatalogue: vi.fn() } }));
vi.mock("@/shared/lib/api", () => api);

const page = (skillIds: string[], total = skillIds.length, remoteEnabled = true) => ({
  results: skillIds.map((skillId) => ({
    sourceId: "ecc",
    sourceLabel: "affaan-m/ECC",
    skillId,
    name: skillId,
    description: "",
    category: "",
    licence: "MIT",
    commit: "c".repeat(40),
    upstreamUrl: null,
  })),
  total,
  limit: 10,
  offset: 0,
  remoteEnabled,
});

const flush = async (ms = CATALOG_SEARCH_DEBOUNCE_MS) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  api.searchCatalogue.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCatalogueSearch", () => {
  it("debounces keystrokes into one request", async () => {
    api.searchCatalogue.mockResolvedValue(page(["postgres-patterns"]));
    const { rerender, result } = renderHook(({ q }) => useCatalogueSearch(q, 10), {
      initialProps: { q: "p" },
    });
    for (const q of ["po", "pos", "post", "postgres"]) {
      rerender({ q });
      await flush(CATALOG_SEARCH_DEBOUNCE_MS / 5);
    }
    await flush();

    expect(api.searchCatalogue).toHaveBeenCalledTimes(1);
    expect(api.searchCatalogue.mock.calls[0][0]).toBe("postgres");
    expect(result.current.results.map((r) => r.skillId)).toEqual(["postgres-patterns"]);
    expect(result.current.loading).toBe(false);
  });

  it("aborts a superseded request so a slow answer cannot overwrite a newer one", async () => {
    let resolveSlow: (value: unknown) => void = () => {};
    api.searchCatalogue
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce(page(["postgres-patterns"]));
    const { rerender, result } = renderHook(({ q }) => useCatalogueSearch(q, 10), {
      initialProps: { q: "pos" },
    });
    await flush();
    const firstSignal: AbortSignal = api.searchCatalogue.mock.calls[0][1].signal;

    rerender({ q: "postgres" });
    await flush();
    expect(firstSignal.aborted).toBe(true);

    // The stale answer finally arrives — and is ignored.
    await act(async () => {
      resolveSlow(page(["stale-result"]));
      await Promise.resolve();
    });
    expect(result.current.results.map((r) => r.skillId)).toEqual(["postgres-patterns"]);
  });

  it("remembers the empty-query total as the catalogue size", async () => {
    api.searchCatalogue
      .mockResolvedValueOnce(page(["a", "b"], 970))
      .mockResolvedValueOnce(page(["react-performance"], 3));
    const { rerender, result } = renderHook(({ q }) => useCatalogueSearch(q, 6), {
      initialProps: { q: "" },
    });
    await flush();
    expect(result.current.catalogueSize).toBe(970);

    rerender({ q: "react" });
    await flush();
    expect(result.current.total).toBe(3);
    expect(result.current.catalogueSize).toBe(970);      // unchanged by a query
  });

  it("surfaces a failure inline and retries on demand", async () => {
    api.searchCatalogue
      .mockRejectedValueOnce(new Error("Searching too quickly"))
      .mockResolvedValueOnce(page(["pdf"]));
    const { result } = renderHook(() => useCatalogueSearch("pdf", 10));
    await flush();
    expect(result.current.error).toBe("Searching too quickly");

    act(() => result.current.retry());
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.results.map((r) => r.skillId)).toEqual(["pdf"]);
  });

  it("reports when the server has remote sources switched off", async () => {
    api.searchCatalogue.mockResolvedValue(page([], 0, false));
    const { result } = renderHook(() => useCatalogueSearch("", 6));
    await flush();
    expect(result.current.remoteEnabled).toBe(false);
  });
});

describe("CatalogueSearchPageSchema", () => {
  it("only lets an https upstream link through to the DOM", () => {
    const parsed = CatalogueSearchPageSchema.parse({
      results: [
        { source_id: "ecc", skill_id: "a", upstream_url: "https://github.com/x" },
        { source_id: "ecc", skill_id: "b", upstream_url: "javascript:alert(1)" },
        { source_id: "ecc", skill_id: "c", upstream_url: "http://plain.example" },
        { skill_id: "no-source" },
      ],
      total: 3,
      remote_enabled: true,
    });
    expect(parsed.results.map((r) => [r.skillId, r.upstreamUrl])).toEqual([
      ["a", "https://github.com/x"],
      ["b", null],
      ["c", null],
    ]);
    expect(parsed.remoteEnabled).toBe(true);
  });
});
