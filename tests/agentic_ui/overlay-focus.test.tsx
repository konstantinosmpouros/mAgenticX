// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

/**
 * Overlays never act on their own: a tooltip opens on focus only when the user
 * tabbed there, and a menu that opens a dialog never leaves the page locked.
 */

function HelpButton() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Help</button>
        </TooltipTrigger>
        <TooltipContent>Pages the agent read</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const tooltipShown = () => screen.queryAllByText("Pages the agent read").length > 0;

describe("a tooltip opened by focus", () => {
  it("stays closed when focus comes after a pointer action (a dialog opening, focus handed back)", () => {
    render(<HelpButton />);
    fireEvent.pointerDown(document.body);
    vi.useFakeTimers();
    act(() => screen.getByRole("button", { name: "Help" }).focus());
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    expect(tooltipShown()).toBe(false);
  });

  it("opens when the user tabbed to it", async () => {
    render(<HelpButton />);
    fireEvent.keyDown(window, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Help" }).focus());
    await waitFor(() => expect(tooltipShown()).toBe(true));
  });
});

function MenuThatOpensADialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setOpen(true)}>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>
      <button type="button">Sidebar link</button>
    </>
  );
}

describe("a modal menu that opens a dialog", () => {
  it("leaves the page clickable once the dialog closes", async () => {
    render(<MenuThatOpensADialog />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Menu and dialog share one Radix layer stack now (dropdown-menu 2.1.16);
    // two copies left `pointer-events: none` on <body> behind.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  });
});
