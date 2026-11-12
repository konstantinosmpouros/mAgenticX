// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AIActionBar } from "@/features/chat/components/message_parts/ActionBars";
import { AnswerSourcesPanel } from "@/features/chat/components/message_parts/AnswerSourcesPanel";
import type { CitationSource, MessageOut } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

/** The answer's Sources panel and the "More" menu item that opens it (plan 42). */

const src = (n: number, over: Partial<CitationSource> = {}): CitationSource => ({
  id: `a${String(n).padStart(5, "0")}`,
  url: `https://site${n}.example.com/page`,
  title: `Page ${n}`,
  snippet: `Snippet ${n}`,
  tool: "web_search",
  ...over,
});

const message = { id: "m1", sender: "ai", content: "Hi", created_at: new Date(0) } as MessageOut;

const renderBar = (onOpenSources?: () => void) =>
  render(
    <TooltipProvider>
      <AIActionBar
        message={message}
        copiedId={null}
        onCopy={() => {}}
        onLike={() => {}}
        onDislike={() => {}}
        onOpenSources={onOpenSources}
      />
    </TooltipProvider>,
  );

const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More message actions" }), { key: "Enter" });
  return screen.findByRole("menu");
};

describe("the Sources menu item", () => {
  it("is hidden when the answer has no sources", async () => {
    renderBar(undefined);
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: /Sources/ })).toBeNull();
  });

  it("opens the panel when the answer has sources", async () => {
    const open = vi.fn();
    renderBar(open);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Sources/ }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("never locks the page: the menu is not modal, so a panel it opens leaves the page clickable", async () => {
    renderBar(() => {});
    await openMenu();
    // A modal Radix menu sets pointer-events: none on <body> while open; one
    // left behind after the Sources panel closed made the sidebar unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});

describe("the Sources panel", () => {
  it("lists what the answer points at first, then More with an expander", () => {
    const cited = [src(1), src(2, { title: "" })];
    const more = Array.from({ length: 11 }, (_, i) => src(i + 10));
    render(<AnswerSourcesPanel sources={{ cited, more }} open onOpenChange={() => {}} />);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "About sources" })).toBeTruthy();
    expect(dialog.textContent ?? "").not.toMatch(/cited/i);

    const first = within(dialog).getByRole("list", { name: "Sources of this answer" });
    const firstLinks = within(first).getAllByRole("link");
    expect(firstLinks.map((a) => a.textContent)).toEqual(["Page 1", "site2.example.com"]);
    expect(firstLinks[0].getAttribute("href")).toBe("https://site1.example.com/page");
    expect(firstLinks[0].getAttribute("target")).toBe("_blank");
    expect(firstLinks[0].getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(within(first).getByText("Snippet 1")).toBeTruthy();

    expect(within(dialog).getByRole("heading", { name: "More" })).toBeTruthy();
    const rest = within(dialog).getByRole("list", { name: "More sources" });
    expect(within(rest).getAllByRole("link")).toHaveLength(8);

    fireEvent.click(within(dialog).getByRole("button", { name: /3 more/ }));
    expect(within(rest).getAllByRole("link")).toHaveLength(11);
    expect(within(dialog).queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("opens with focus on the panel, so the help tooltip stays closed", async () => {
    render(<AnswerSourcesPanel sources={{ cited: [src(1)], more: [] }} open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a snippet as plain text, not the page's markdown", () => {
    render(
      <AnswerSourcesPanel
        sources={{ cited: [src(1, { snippet: "## Background\n**At the onset** of the crisis" })], more: [] }}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Background At the onset of the crisis")).toBeTruthy();
  });

  it("keeps More as its own titled section even when the text points at nothing", () => {
    render(
      <AnswerSourcesPanel sources={{ cited: [], more: [src(1)] }} open onOpenChange={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "More" })).toBeTruthy();
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
  });
});
