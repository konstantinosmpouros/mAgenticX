// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDraftAutosave } from "@/features/agents/hooks/useDraftAutosave";
import { AGENT_TEMPLATES } from "@/features/agents/lib/agentTemplates";
import {
  draftStorageKey,
  readStoredDraft,
  writeStoredDraft,
} from "@/features/agents/lib/draftStorage";
import type { AgentDraft } from "@/shared/lib/types";

/**
 * The new-agent autosave: an untouched draft (a starter template opened and
 * left) stores nothing, an edit is stored, and edits undone back to the start
 * take the stored copy with them — but never one an earlier visit left.
 */
const KEY = draftStorageKey("u1", null);
const template = AGENT_TEMPLATES[0].draft("m");
const edited: AgentDraft = { ...template, name: "Changed" };

type Props = { draft: AgentDraft; dirty: boolean };
const mount = (initial: Props) =>
  renderHook(
    ({ draft, dirty }: Props) =>
      useDraftAutosave({
        userId: "u1",
        agentId: null,
        draft,
        dirty,
        initial: template,
        offerStored: false,
      }),
    { initialProps: initial },
  );

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("autosave of a new agent", () => {
  it("stores nothing for a template opened and left untouched", () => {
    mount({ draft: template, dirty: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(readStoredDraft(KEY)).toBeNull();
  });

  it("stores an edit, and forgets it when the edit is undone", () => {
    const hook = mount({ draft: template, dirty: false });
    hook.rerender({ draft: edited, dirty: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(readStoredDraft(KEY)?.draft.name).toBe("Changed");

    hook.rerender({ draft: template, dirty: false });
    expect(readStoredDraft(KEY)).toBeNull();
  });

  it("leaves an earlier visit's leftover alone while nothing is changed", () => {
    writeStoredDraft(KEY, { ...template, name: "From before" });
    mount({ draft: template, dirty: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(readStoredDraft(KEY)?.draft.name).toBe("From before");
  });
});
