// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/**
 * The Agents section (plan 37, P2): its routes, the gallery and the picker.
 *
 * Pinned: an agent id that is not in the catalog gets one fresh look at the
 * catalog and then a friendly "Agent not found" with a way back; editing a
 * platform agent redirects to its page; `?section=` opens that tab; the gallery
 * splits mine from the platform's by the catalog's `kind` (not by the custom
 * list), shows a custom agent's summary and invites a first agent when Mine is
 * empty; the agent's page offers Chat / Schedule (and Edit / Export only for
 * your own); a stored Settings "agents" tab opens General; the chat picker
 * groups My agents above the Platform's and "Manage agents…" never becomes
 * the selection.
 */
vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  getAgentTools: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  getTools: vi.fn(async () => []),
  getAgentModels: vi.fn(async () => []),
  // A custom agent's page loads its version list (the Overview's Version row).
  listMyAgentVersions: vi.fn(async () => []),
  getBuiltinTools: vi.fn(async () => []),
}));

import AgentsGallery from "@/features/agents/pages/AgentsGallery";
import AgentPage from "@/features/agents/pages/AgentPage";
import AgentBuilderPage from "@/features/agents/pages/AgentBuilderPage";
import type { AgentsPageContext } from "@/features/agents/context";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";
import {
  buildAgentCards,
  cardFacts,
  filterAgentCards,
} from "@/features/agents/lib/gallery";
import { isAgentsPath, parseSection, DETAIL_SECTIONS } from "@/features/agents/lib/routes";
import { duplicateDefinition } from "@/features/agents/lib/agentSpec";
import { resolveSettingsTab } from "@/features/settings/lib/settingsTabs";
import { PICKER_LIMIT, pickerDefaults, rememberAgentPick, searchPickerAgents } from "@/features/chat/lib/agentPicker";
import { AgentSearchDialog } from "@/features/chat/components/AgentSearchDialog";
import ChatHeader from "@/features/chat/components/ChatHeader";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";
import type { Agent, CustomAgentDetail, MyAgent } from "@/shared/lib/types";

const Icon = () => <svg aria-hidden />;
const agent = (over: Partial<Agent>): Agent =>
  ({
    id: "x",
    name: "Agent",
    description: "",
    icon: Icon,
    iconName: null,
    isActive: true,
    type: "deep agent",
    ...over,
  }) as Agent;

const platform = agent({ id: "p1", name: "Platform Analyst", kind: "platform" });
const mine = agent({ id: "c1", name: "My Researcher", description: "Digs.", kind: "custom" });
const summary: MyAgent = {
  ...mine,
  model: "openai:gpt-5",
  toolCount: 3,
  skillCount: 2,
  subagentCount: 1,
};

const userAgents = (over: Partial<UserAgentsHandlers> = {}): UserAgentsHandlers => ({
  myAgents: [],
  loadingMyAgents: false,
  refreshMyAgents: vi.fn(async () => {}),
  getAgentDefinition: vi.fn(async () => null),
  validateAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  createAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  deleteAgent: vi.fn(async () => true),
  busyAgentId: null,
  ...over,
});

const context = (over: Partial<AgentsPageContext> = {}): AgentsPageContext => ({
  userId: "u1",
  agents: [platform, mine],
  mySkills: [],
  userAgents: userAgents(),
  refreshCatalog: vi.fn(async () => {}),
  onChatWith: vi.fn(),
  onSchedule: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

/** The section's routes as App.tsx declares them, under a stand-in for AgentsView. */
function renderAt(path: string, ctx: AgentsPageContext = context()) {
  render(
    <SidebarProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents" element={<Outlet context={ctx} />}>
            <Route index element={<AgentsGallery />} />
            <Route path="new" element={<AgentBuilderPage mode="create" />} />
            <Route path=":agentId" element={<AgentPage />} />
            <Route path=":agentId/edit" element={<AgentBuilderPage mode="edit" />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </SidebarProvider>,
  );
  return ctx;
}

const where = () => screen.getByTestId("where").textContent;

describe("agents routes", () => {
  it("re-pulls the catalog once for an unknown id, then says not found with a way back", async () => {
    const ctx = renderAt("/agents/nope");
    expect(await screen.findByRole("heading", { name: "Agent not found" })).toBeInTheDocument();
    expect(ctx.refreshCatalog).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Back to Agents/ }));
    expect(where()).toBe("/agents");
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
  });

  it("shows not found for editing an unknown agent", async () => {
    renderAt("/agents/nope/edit");
    expect(await screen.findByRole("heading", { name: "Agent not found" })).toBeInTheDocument();
  });

  it("redirects editing a platform agent to its page", async () => {
    renderAt("/agents/p1/edit");
    expect(await screen.findByRole("heading", { name: "Platform Analyst" })).toBeInTheDocument();
    expect(where()).toBe("/agents/p1");
  });

  it("opens the section named in ?section=, and an unknown one on Overview", async () => {
    renderAt("/agents/c1?section=approvals");
    const tab = await screen.findByRole("button", { name: /Approvals/ });
    expect(tab).toHaveAttribute("aria-current", "page");

    expect(parseSection("bogus", DETAIL_SECTIONS, "overview")).toBe("overview");
    expect(parseSection(null, DETAIL_SECTIONS, "overview")).toBe("overview");
    expect(parseSection("tools", DETAIL_SECTIONS, "overview")).toBe("tools");
  });

  it("offers chat and schedule on every agent, edit and export only on your own", async () => {
    const ctx = renderAt("/agents/p1");
    await screen.findByRole("heading", { name: "Platform Analyst" });
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Chat with it/ }));
    expect(ctx.onChatWith).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: /Schedule it/ }));
    expect(ctx.onSchedule).toHaveBeenCalledWith("p1");
  });

  it("goes from your agent's page to its builder", async () => {
    renderAt("/agents/c1");
    await screen.findByRole("heading", { name: "My Researcher" });
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    expect(where()).toBe("/agents/c1/edit");
  });

  it("treats only the paths of the section as the section", () => {
    expect(isAgentsPath("/agents")).toBe(true);
    expect(isAgentsPath("/agents/c1/edit")).toBe(true);
    expect(isAgentsPath("/agentsfoo")).toBe(false);
    expect(isAgentsPath("/tasks")).toBe(false);
  });
});

describe("agents gallery", () => {
  it("splits mine from the platform's by the catalog's kind", () => {
    // The custom list naming the platform agent must not make it "mine".
    const stray: MyAgent = { ...summary, id: "p1" };
    const cards = buildAgentCards([platform, mine], [summary, stray]);
    expect(cards.map((c) => [c.agent.id, c.custom])).toEqual([
      ["p1", false],
      ["c1", true],
    ]);
    expect(cards[0].summary).toBeNull();
    expect(filterAgentCards(cards, "mine", "").map((c) => c.agent.id)).toEqual(["c1"]);
    expect(filterAgentCards(cards, "platform", "").map((c) => c.agent.id)).toEqual(["p1"]);
    expect(filterAgentCards(cards, "all", "digs").map((c) => c.agent.id)).toEqual(["c1"]);
  });

  it("states a custom agent's facts, leaving out what the summary lacks", () => {
    const models = [{ id: "openai:gpt-5", label: "GPT-5", default: true }];
    expect(cardFacts(summary, models)).toEqual(["GPT-5", "3 tools", "2 skills", "1 sub-agent"]);
    // Without the server's list, the id reads without its provider prefix.
    expect(cardFacts(summary)[0]).toBe("gpt-5");
    expect(
      cardFacts({ model: null, toolCount: 0, skillCount: null, subagentCount: 0 }),
    ).toEqual(["0 tools"]);
    expect(cardFacts(null)).toEqual([]);
  });

  it("filters by scope in the page and shows the summary on the custom card", async () => {
    renderAt("/agents", context({ userAgents: userAgents({ myAgents: [summary] }) }));
    expect(await screen.findByText("Platform Analyst")).toBeInTheDocument();
    expect(screen.getByText("My Researcher")).toBeInTheDocument();
    expect(screen.getByText("3 tools")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Mine/ }));
    expect(screen.queryByText("Platform Analyst")).toBeNull();
    expect(screen.getByText("My Researcher")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Platform/ }));
    expect(screen.getByText("Platform Analyst")).toBeInTheDocument();
    expect(screen.queryByText("My Researcher")).toBeNull();

    // Only your own agents carry the Edit / Duplicate / Export / Delete menu.
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByRole("button", { name: "Actions for My Researcher" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for Platform Analyst" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /My Researcher, custom agent/ }));
    expect(where()).toBe("/agents/c1");
  });

  it("deletes from the card menu and leaves the page clickable", async () => {
    const ctx = context({ userAgents: userAgents({ myAgents: [summary] }) });
    renderAt("/agents", ctx);
    const trigger = await screen.findByRole("button", { name: "Actions for My Researcher" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await waitFor(() => expect(ctx.userAgents.deleteAgent).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // No menu or dialog left its page lock behind.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  });

  it("invites a first agent when Mine is empty", async () => {
    renderAt("/agents", context({ agents: [platform] }));
    fireEvent.click(await screen.findByRole("button", { name: /^Mine/ }));
    expect(screen.getByText("Build your first agent")).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Agents" });
    fireEvent.click(within(region).getByRole("button", { name: /New agent/ }));
    expect(where()).toBe("/agents/new");
  });

  it("duplicates with a fresh name and slug", () => {
    const detail = {
      id: "c1",
      slug: "researcher",
      name: "Researcher",
      description: "",
      icon: "Bot",
      version: undefined,
      type: "deep agent",
      spec: { slug: "researcher", name: "Researcher", prompt: "./AGENT.md" },
      files: [],
    } as CustomAgentDetail;
    const copy = duplicateDefinition(detail);
    expect(copy).toMatchObject({ id: "", name: "Researcher copy", slug: "researcher-copy" });
    expect(copy.spec).toMatchObject({ slug: "researcher-copy", name: "Researcher copy" });
  });
});

describe("settings without the Agents tab", () => {
  it("opens General for a stored or linked agents tab", () => {
    expect(resolveSettingsTab("agents")).toBe("general");
    expect(resolveSettingsTab("archived")).toBe("data-controls");
    expect(resolveSettingsTab("skills")).toBe("skills");
    expect(resolveSettingsTab("nonsense")).toBe("general");
  });
});

describe("chat picker", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    agent({ id: `a${i}`, name: `Agent ${i}`, kind: i < 4 ? "custom" : "platform" }),
  );

  it("never shows more than five rows: the selected, the recent, then mine and the platform's", () => {
    const rows = pickerDefaults(many, "a6", ["a2", "a6", "gone", "a8"]);
    expect(rows.map((a) => a.id)).toEqual(["a6", "a2", "a8", "a0", "a1"]);
    expect(rows).toHaveLength(PICKER_LIMIT);
  });

  it("searches names before descriptions, at most five, and counts the rest", () => {
    const research = agent({ id: "r", name: "Research", kind: "custom" });
    const deep = agent({ id: "d", name: "Deep research team", kind: "platform" });
    const desc = agent({ id: "x", name: "Omni", description: "Does research.", kind: "platform" });
    expect(searchPickerAgents([desc, deep, research], "res").rows.map((a) => a.id)).toEqual(["r", "d", "x"]);
    const { rows, total } = searchPickerAgents(many, "agent");
    expect(rows).toHaveLength(5);
    expect(total).toBe(9);
  });

  it("opens on the recent agents, filters as you type, and browses all from the last row", async () => {
    window.localStorage.clear();
    rememberAgentPick("c1");
    const onAgentChange = vi.fn();
    const onManageAgents = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <SidebarProvider>
        <TooltipProvider>
          <ChatHeader
            agents={[platform, mine, ...many]}
            selectedAgent="p1"
            onAgentChange={onAgentChange}
            agentPickerOpen
            onAgentPickerOpenChange={onOpenChange}
            showPrivateToggle={false}
            isPrivateMode={false}
            onTogglePrivate={() => {}}
            onManageAgents={onManageAgents}
          />
        </TooltipProvider>
      </SidebarProvider>,
    );
    const list = await screen.findByRole("listbox", { name: "Agents" });
    const names = () => within(list).getAllByRole("option").map((o) => o.textContent ?? "");
    // The selected first, then the recent pick: five agents and Browse all.
    expect(names()).toHaveLength(PICKER_LIMIT + 1);
    expect(names()[0]).toContain("Platform Analyst");
    expect(names()[1]).toContain("My Researcher");
    expect(names()[PICKER_LIMIT]).toContain("Browse all agents");

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "agent" } });
    // Five matches, "See all 9 results", and Browse all under its separator.
    await waitFor(() => expect(names()).toHaveLength(PICKER_LIMIT + 2));
    expect(names()[PICKER_LIMIT]).toContain("See all 9 results");
    expect(list.querySelector("[cmdk-separator]")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "research" } });
    await waitFor(() => expect(names()[0]).toContain("My Researcher"));
    fireEvent.click(within(list).getByRole("option", { name: /My Researcher/ }));
    expect(onAgentChange).toHaveBeenCalledWith("c1");

    fireEvent.click(within(list).getByRole("option", { name: /Browse all agents/ }));
    await waitFor(() => expect(onManageAgents).toHaveBeenCalledTimes(1));
  });
});

describe("agent search panel", () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    agent({ id: `s${i}`, name: `Scout ${i}`, description: `Finds things ${i}.`, kind: i < 5 ? "custom" : "platform" }),
  );

  it("pages the results six at a time, filters by kind, and picks with Enter", async () => {
    const onPick = vi.fn();
    render(
      <AgentSearchDialog
        open
        onOpenChange={() => {}}
        agents={many}
        selectedId="s0"
        initialQuery="scout"
        onPick={onPick}
      />,
    );
    const page = () => screen.getByRole("listbox");
    expect(within(page()).getAllByRole("option")).toHaveLength(6);
    expect(screen.getByText("1–6 of 14")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    await waitFor(() => expect(screen.getByText("13–14 of 14")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /My agents/ }));
    await waitFor(() => expect(screen.getByText("1–5 of 5")).toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: "Result pages" })).not.toBeInTheDocument();

    const input = screen.getByLabelText("Search agents");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("s2");
  });

  it("says when nothing matches", () => {
    render(
      <AgentSearchDialog open onOpenChange={() => {}} agents={many} selectedId="s0" initialQuery="zzz" onPick={() => {}} />,
    );
    expect(screen.getByText(/No agent matches/)).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();
  });
});
