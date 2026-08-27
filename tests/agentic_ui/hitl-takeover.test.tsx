// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HitlInputTakeover } from "@/features/chat/components/HitlInputTakeover";

/**
 * The approval surface. Worth covering before the ChatPage restructure moves it:
 * a sub-agent approval failing here is what produced a run that died with no
 * message, and the failure was only visible by exercising the UI.
 */
const interrupt = {
  interruptId: "int-1",
  threadId: "thread-1",
  content: {
    id: "int-1",
    value: { action_requests: [{ action: "write_file", args: { file_path: "/out/a.txt" } }] },
  },
};

const renderTakeover = (onResolve: (d: unknown[]) => Promise<void>) =>
  render(
    <HitlInputTakeover interrupt={interrupt} pendingCount={1} onResolve={onResolve as never} />,
  );

describe("HitlInputTakeover", () => {
  it("names the tool awaiting approval", () => {
    renderTakeover(async () => {});
    expect(screen.getByText(/write_file/)).toBeInTheDocument();
  });

  it("sends an approve decision", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderTakeover(onResolve);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.calls[0][0]).toEqual([expect.objectContaining({ decision: "approve" })]);
  });

  it("surfaces a failed decision instead of failing silently", async () => {
    // The run-died-with-no-message case: onResolve rejects, and the component
    // must say so rather than leaving the user staring at a dead prompt.
    const onResolve = vi.fn().mockRejectedValue(new Error("stale interrupt"));
    renderTakeover(onResolve);

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(screen.getByText(/stale interrupt/)).toBeInTheDocument());
  });
});
