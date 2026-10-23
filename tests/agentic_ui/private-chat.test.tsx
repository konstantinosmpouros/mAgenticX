// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Private chats: the incognito card and "Save chat".
 *
 * Pinned: the chat card carries the incognito token scope (`private-scope`,
 * plus `dark`) exactly while private, with a short `private-shift` crossfade on
 * every change; in a stored private chat "Save chat" takes the private toggle's
 * place (and Share / Archive / Delete stay hidden), while a new chat keeps the
 * toggle; saving calls the bridge, moves the chat to the top of the list, takes
 * the open chat and the mode out of private, and toasts — a 409 (already saved)
 * lands the same way, any other failure changes nothing.
 */
vi.mock("@/shared/lib/api", () => ({
  saveConversation: vi.fn(),
  getConversationDetail: vi.fn(),
  deleteConversation: vi.fn(),
  getConversations: vi.fn(),
  renameConversation: vi.fn(),
  archiveConversation: vi.fn(),
  unarchiveConversation: vi.fn(),
  setConversationPinned: vi.fn(),
  getArchivedConversations: vi.fn(),
  forkConversation: vi.fn(),
}));

import { saveConversation } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { INCOGNITO_SHIFT_MS, useIncognitoCard } from "@/app/useIncognitoCard";
import ChatHeader from "@/features/chat/components/ChatHeader";
import { createConversationHandlers } from "@/features/chat/handlers/conversations";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Agent, ConversationDetail, ConversationSummary } from "@/shared/lib/types";

const agent = {
  id: "a1",
  name: "Analyst",
  description: "",
  icon: () => null,
  iconName: null,
  isActive: true,
} as unknown as Agent;

function Card({ active }: { active: boolean }) {
  return <main data-testid="card" className={useIncognitoCard(active)} />;
}

describe("useIncognitoCard", () => {
  afterEach(() => vi.useRealTimers());

  it("applies the incognito token scope only while private, crossfading each change", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Card active={false} />);
    const card = screen.getByTestId("card");
    expect(card.className).not.toContain("private-scope");

    rerender(<Card active />);
    expect(card).toHaveClass("private-scope", "dark", "private-shift");
    act(() => vi.advanceTimersByTime(INCOGNITO_SHIFT_MS));
    expect(card).toHaveClass("private-scope", "dark");
    expect(card).not.toHaveClass("private-shift");

    rerender(<Card active={false} />);
    expect(card).not.toHaveClass("private-scope");
    expect(card).not.toHaveClass("dark");
    expect(card).toHaveClass("private-shift");
    act(() => vi.advanceTimersByTime(INCOGNITO_SHIFT_MS));
    expect(card.className).toBe("");
  });

  it("opens straight into the scope without a crossfade", () => {
    render(<Card active />);
    expect(screen.getByTestId("card")).toHaveClass("private-scope");
    expect(screen.getByTestId("card")).not.toHaveClass("private-shift");
  });
});

const wrap = (node: JSX.Element) => (
  <SidebarProvider>
    <TooltipProvider>{node}</TooltipProvider>
  </SidebarProvider>
);

const header = (props: Partial<Parameters<typeof ChatHeader>[0]>) =>
  wrap(
    <ChatHeader
      agents={[agent]}
      selectedAgent="a1"
      onAgentChange={() => {}}
      showPrivateToggle={false}
      isPrivateMode={false}
      onTogglePrivate={() => {}}
      showConversationActions
      onShareConversation={() => {}}
      canShareConversation
      {...props}
    />,
  );

describe("ChatHeader private controls", () => {
  it("offers the private toggle on a new chat", () => {
    const onTogglePrivate = vi.fn();
    render(header({ showPrivateToggle: true, showConversationActions: false, onTogglePrivate }));

    fireEvent.click(screen.getByRole("button", { name: "Private chat" }));
    expect(onTogglePrivate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save chat" })).toBeNull();
    expect(screen.queryByTestId("private-pill")).toBeNull();
  });

  it("shows the Private pill as the off switch while a private chat is being written", () => {
    const onTogglePrivate = vi.fn();
    render(header({ showPrivateToggle: true, isPrivateMode: true, showConversationActions: false, onTogglePrivate }));

    fireEvent.click(screen.getByRole("button", { name: /Private chat is on/ }));
    expect(onTogglePrivate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save chat" })).toBeNull();
  });

  it("replaces the toggle with Save chat in a stored private chat", async () => {
    let resolve: (v: boolean) => void = () => {};
    const onSaveConversation = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    render(header({ isPrivateMode: true, onSaveConversation }));

    expect(screen.queryByRole("button", { name: "Private chat" })).toBeNull();
    expect(screen.getByTestId("private-pill")).toHaveAccessibleName(
      "Private chat. Hidden from your chat list, search and memory",
    );
    // Share, Archive and Delete stay hidden while it is private.
    expect(screen.queryByRole("button", { name: "Share full conversation" })).toBeNull();

    const save = screen.getByRole("button", { name: "Save chat" });
    fireEvent.click(save);
    expect(onSaveConversation).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    await act(async () => resolve(true));
    expect(save).not.toBeDisabled();
  });

  it("brings Share back once the chat is no longer private", () => {
    render(header({ isPrivateMode: false }));
    expect(screen.getByRole("button", { name: "Share full conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save chat" })).toBeNull();
  });
});

describe("handleSaveCurrentConversation", () => {
  const privateDetail: ConversationDetail = {
    id: "c-private",
    agent,
    title: "Secret plans",
    isPrivate: true,
    created_at: new Date("2026-10-20T10:00:00Z"),
    updated_at: new Date("2026-10-20T10:00:00Z"),
    messages: [],
  };
  const older: ConversationSummary = {
    id: "c-old",
    agent,
    title: "Older chat",
    isPrivate: false,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-22T10:00:00Z",
  };

  let conversations: ConversationSummary[];
  let current: ConversationDetail | null;
  const setIsPrivateMode = vi.fn();
  const toast = vi.fn();

  const handlers = () =>
    createConversationHandlers({
      userId: "u1",
      currentConversation: current,
      setConversations: (u) => {
        conversations = typeof u === "function" ? u(conversations) : u;
      },
      setCurrentConversation: (u) => {
        current = typeof u === "function" ? u(current) : u;
      },
      setIsPrivateMode,
      toast,
      persistUIState: () => {},
      navigate: () => {},
      convPage: 1,
      setConvPage: () => {},
      convHasMore: false,
      setConvHasMore: () => {},
      convIsLoadingMore: false,
      setConvIsLoadingMore: () => {},
      pageSize: 10,
      setArchivedConversations: () => {},
      archivedConvPage: 1,
      setArchivedConvPage: () => {},
      archivedConvHasMore: false,
      setArchivedConvHasMore: () => {},
      archivedConvIsLoading: false,
      setArchivedConvIsLoading: () => {},
      archivedPageSize: 10,
      setLoadingConversation: () => {},
      setSelectedAgent: () => {},
      setAttachments: () => {},
      setCurrentMessage: () => {},
    });

  beforeEach(() => {
    conversations = [older];
    current = privateDetail;
    setIsPrivateMode.mockReset();
    toast.mockReset();
    vi.mocked(saveConversation).mockReset();
  });

  it("saves through the bridge and moves the chat to the top of the list, out of private", async () => {
    vi.mocked(saveConversation).mockResolvedValue({
      id: "c-private",
      agent,
      title: "Secret plans",
      isPrivate: false,
      created_at: "2026-10-20T10:00:00Z",
      updated_at: "2026-10-24T09:00:00Z",
    });

    await expect(handlers().handleSaveCurrentConversation()).resolves.toBe(true);

    expect(saveConversation).toHaveBeenCalledWith("u1", "c-private");
    expect(conversations.map((c) => c.id)).toEqual(["c-private", "c-old"]);
    expect(conversations[0].title).toBe("Secret plans");
    expect(current?.isPrivate).toBe(false);
    expect(setIsPrivateMode).toHaveBeenCalledWith(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Chat saved" }));
  });

  it("treats 409 (already saved) as saved", async () => {
    vi.mocked(saveConversation).mockRejectedValue(new ApiError("conflict", { status: 409 }));

    await expect(handlers().handleSaveCurrentConversation()).resolves.toBe(true);

    expect(conversations[0]).toMatchObject({ id: "c-private", isPrivate: false });
    expect(current?.isPrivate).toBe(false);
    expect(setIsPrivateMode).toHaveBeenCalledWith(false);
  });

  it("changes nothing when the save fails", async () => {
    vi.mocked(saveConversation).mockRejectedValue(new ApiError("boom", { status: 500 }));

    await expect(handlers().handleSaveCurrentConversation()).resolves.toBe(false);

    expect(conversations.map((c) => c.id)).toEqual(["c-old"]);
    expect(current?.isPrivate).toBe(true);
    expect(setIsPrivateMode).not.toHaveBeenCalled();
  });

  it("does nothing for a chat that is not private", async () => {
    current = { ...privateDetail, isPrivate: false };
    await expect(handlers().handleSaveCurrentConversation()).resolves.toBe(false);
    expect(saveConversation).not.toHaveBeenCalled();
  });
});
