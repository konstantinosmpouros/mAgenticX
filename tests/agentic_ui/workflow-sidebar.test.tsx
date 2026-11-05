// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const motionSpies = vi.hoisted(() => ({
  sectionListMotion: vi.fn(),
  rowMotion: vi.fn(),
}));

// The sidebar's motion helpers, spied on: every section must go through them.
vi.mock("@/features/chat/lib/sidebarMotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/lib/sidebarMotion")>();
  motionSpies.sectionListMotion.mockImplementation(actual.sectionListMotion);
  motionSpies.rowMotion.mockImplementation(actual.rowMotion);
  return { ...actual, ...motionSpies };
});

import ChatSidebar from "@/features/chat/components/ChatSidebar";
import {
  PAGE_GLIDE,
  SIDEBAR_PAGE_LAYOUT_ID,
  SIDEBAR_ROW_LAYOUT_ID,
} from "@/features/chat/lib/sidebarMotion";
import type { Agent, ConversationSummary, Workflow } from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The sidebar's Workflows section (plan 38, step 2).
 *
 * Hidden with no workflows (like Pinned) and never offers a + — workflows are
 * created on the Automations page; one entry per workflow, the open one marked
 * current; clicking an entry opens it; the heading folds the list and the
 * choice is remembered per browser.
 */

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  description: null,
  spec: null,
  latestVersionNo: 1,
  createdAt: null,
  updatedAt: null,
});

const conversation = (id: string, title: string): ConversationSummary => ({
  id,
  agent: { id: "a1", name: "Agent" } as Agent,
  title,
  isPrivate: false,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
});

const listOf = (name: string) => {
  const heading = screen.getByRole("button", { name });
  return document.getElementById(heading.getAttribute("aria-controls")!);
};

const interaction = () => ({
  isLogoHovered: false,
  handleSidebarMouseEnter: () => {},
  handleSidebarMouseLeave: () => {},
  toggleCollapsedOnBlankArea: () => {},
});

function renderSidebar(props: Partial<React.ComponentProps<typeof ChatSidebar>> = {}) {
  return render(
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <ChatSidebar
          conversations={[]}
          currentConversationId={null}
          onSelectConversation={() => {}}
          onDeleteConversation={() => {}}
          onLoadMore={() => {}}
          isLoadingMore={false}
          isInitialLoading={false}
          hasMore={false}
          onTitleClick={() => {}}
          onNewChat={() => {}}
          onOpenSearch={() => {}}
          onOpenSettings={() => {}}
          onEditProfile={() => {}}
          onOpenShortcuts={() => {}}
          onOpenHelp={() => {}}
          onLogout={() => {}}
          userProfile={null}
          sidebarInteractionHook={interaction}
          {...props}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("sidebar Workflows section", () => {
  it("is hidden with no workflows", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Workflows" })).toBeNull();
    expect(screen.queryByText("No workflows yet")).toBeNull();
  });

  it("offers no + to create a workflow", () => {
    renderSidebar({ workflows: [workflow("wf-1", "Deploy")] });
    expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New workflow" })).toBeNull();
  });

  it("lists one entry per workflow, marks the open one, and opens on click", () => {
    const onOpenWorkflow = vi.fn();
    renderSidebar({
      workflows: [workflow("wf-1", "Deploy"), workflow("wf-2", "Nightly report")],
      activeWorkflowId: "wf-2",
      onOpenWorkflow,
    });
    const heading = screen.getByRole("button", { name: "Workflows" });
    const list = document.getElementById(heading.getAttribute("aria-controls")!)!;
    const entries = within(list).getAllByRole("button");
    expect(entries.map((entry) => entry.textContent)).toEqual(["Deploy", "Nightly report"]);
    expect(entries[1]).toHaveAttribute("aria-current", "page");
    expect(entries[0]).not.toHaveAttribute("aria-current");

    fireEvent.click(entries[0]);
    expect(onOpenWorkflow).toHaveBeenCalledWith("wf-1");
  });

  it("folds and remembers its open state", () => {
    const { unmount } = renderSidebar({ workflows: [workflow("wf-1", "Deploy")] });
    const heading = screen.getByRole("button", { name: "Workflows" });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("mx_sidebar_workflows_open")).toBe("0");
    unmount();

    renderSidebar({ workflows: [workflow("wf-1", "Deploy")] });
    expect(screen.getByRole("button", { name: "Workflows" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

describe("sidebar sections expand alike", () => {
  it("opens and folds Workflows through the same list and row motion as Chats", () => {
    renderSidebar({
      workflows: [workflow("wf-1", "Deploy"), workflow("wf-2", "Nightly report")],
      conversations: [conversation("c-1", "First chat"), conversation("c-2", "Second chat")],
    });
    // Fold both, then open both again: each list mounts afresh.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    motionSpies.sectionListMotion.mockClear();
    motionSpies.rowMotion.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    const workflows = listOf("Workflows")!;
    const chats = listOf("Chats")!;
    for (const list of [workflows, chats]) {
      // The same list wrapper (fade-and-drop) and the same staggered rows.
      expect(list).toHaveAttribute("data-motion", "section-list");
      expect(list).toHaveAttribute("data-sidebar", "chats-list");
      const rows = list.querySelectorAll('[data-motion="row"]');
      expect(rows).toHaveLength(2);
    }
    expect(motionSpies.sectionListMotion).toHaveBeenCalled();
    // Every row of both lists got its staggered entrance, by its index.
    const indexes = motionSpies.rowMotion.mock.calls.map(([, index]) => index);
    expect(indexes.filter((index) => index === 0).length).toBeGreaterThanOrEqual(2);
    expect(indexes.filter((index) => index === 1).length).toBeGreaterThanOrEqual(2);

    // Folding mirrors it: the heading says so and the list goes.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByRole("button", { name: "Workflows" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the open page's highlight apart from the selected row's", () => {
    renderSidebar({
      workflows: [workflow("wf-1", "Deploy")],
      activeWorkflowId: "wf-1",
      activePage: "agents",
      onOpenAgents: () => {},
    });
    const page = document.querySelector<HTMLElement>('[data-indicator="page"]');
    const row = document.querySelector<HTMLElement>('[data-indicator="row"]');
    expect(page).not.toBeNull();
    expect(row).not.toBeNull();
    expect(SIDEBAR_PAGE_LAYOUT_ID).not.toBe(SIDEBAR_ROW_LAYOUT_ID);
    expect(page!.dataset.layoutId).toBe(SIDEBAR_PAGE_LAYOUT_ID);
    expect(row!.dataset.layoutId).toBe(SIDEBAR_ROW_LAYOUT_ID);
    // A short ease-out glide: no spring, so no bounce or overshoot.
    expect(PAGE_GLIDE.type).toBe("tween");
    expect(PAGE_GLIDE.duration).toBeGreaterThanOrEqual(0.18);
    expect(PAGE_GLIDE.duration).toBeLessThanOrEqual(0.22);
  });
});
