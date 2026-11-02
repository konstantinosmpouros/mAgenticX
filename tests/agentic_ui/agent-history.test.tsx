// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A custom agent's History tab: the saved versions newest first as collapsed
 * one-line rows, what an opened one changed compared with the version before it (fields, lists and
 * a line diff of each prompt) or with any version picked, restoring an older
 * one behind a confirmation — it moves "Current", it adds no version —
 * a 422's issues shown in the tab, and the empty state for an agent saved
 * before history began. The Overview's Version row shows the latest version
 * number from the same single list request.
 */
const api = vi.hoisted(() => ({
  getAgentTools: vi.fn(async () => ({ agentSlug: "x", tools: [] })),
  listMyAgentVersions: vi.fn(),
  getMyAgentVersion: vi.fn(),
  restoreMyAgentVersion: vi.fn(),
}));

vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

import AgentPage from "@/features/agents/pages/AgentPage";
import type { AgentsPageContext } from "@/features/agents/context";
import type { UserAgentsHandlers } from "@/features/agents/hooks/useUserAgents";
import { DETAIL_SECTIONS, agentPath } from "@/features/agents/lib/routes";
import { ApiError } from "@/shared/lib/http";
import { SidebarProvider } from "@/shared/ui/sidebar";
import type { Agent, AgentVersionDetail, AgentVersionSummary } from "@/shared/lib/types";

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
    version: "1.0.0",
    ...over,
  }) as Agent;

const platform = agent({ id: "p1", name: "Platform Analyst", kind: "platform" });
const mine = agent({ id: "c1", name: "My Researcher", kind: "custom" });

const userAgents = (): UserAgentsHandlers => ({
  myAgents: [],
  loadingMyAgents: false,
  refreshMyAgents: vi.fn(async () => {}),
  getAgentDefinition: vi.fn(async () => null),
  validateAgent: vi.fn(async () => ({ valid: true, errors: [], issues: [] })),
  createAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  deleteAgent: vi.fn(async () => true),
  busyAgentId: null,
});

const context = (): AgentsPageContext => ({
  userId: "u1",
  agents: [platform, mine],
  mySkills: [],
  userAgents: userAgents(),
  refreshCatalog: vi.fn(async () => {}),
  onChatWith: vi.fn(),
  onSchedule: vi.fn(),
  onClose: vi.fn(),
});

const summary = (over: Partial<AgentVersionSummary>): AgentVersionSummary => ({
  versionNo: 1,
  kind: "saved",
  changes: [],
  restoredFrom: null,
  basedOn: null,
  current: false,
  createdAt: "2026-10-30T09:15:00Z",
  ...over,
});

const detail = (
  versionNo: number,
  spec: Record<string, unknown>,
  files: Record<string, string>,
): AgentVersionDetail => ({
  ...VERSIONS.find((v) => v.versionNo === versionNo)!,
  spec,
  files: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    encoding: "utf-8" as const,
  })),
});

const VERSIONS: AgentVersionSummary[] = [
  summary({
    versionNo: 3,
    kind: "restored",
    restoredFrom: 1,
    changes: ["details", "team", "instructions"],
    current: true,
  }),
  summary({ versionNo: 2, kind: "saved", changes: ["details", "tools", "team", "instructions"] }),
  summary({ versionNo: 1, kind: "created", changes: [] }),
];

const v1Spec = {
  name: "Researcher",
  description: "Digs.",
  model: { main: "openai:gpt-5" },
  tools: [],
  skills: [],
  subagents: [],
};
const v2Spec = {
  ...v1Spec,
  name: "My Researcher",
  tools: [{ server_id: "web", tool_name: "search" }],
  subagents: [{ name: "Scout", description: "Finds.", prompt: "./subagents/scout.md" }],
};
const DETAILS: Record<number, AgentVersionDetail> = {
  1: detail(1, v1Spec, { "AGENT.md": "You research.\nBe brief." }),
  2: detail(2, v2Spec, {
    "AGENT.md": "You research.\nBe thorough.",
    "subagents/scout.md": "Scout ahead.",
  }),
  3: detail(3, v1Spec, { "AGENT.md": "You research.\nBe brief." }),
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(path: string, ctx: AgentsPageContext = context()) {
  render(
    <SidebarProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents" element={<Outlet context={ctx} />}>
            <Route path=":agentId" element={<AgentPage />} />
            <Route path=":agentId/edit" element={<p>Editing</p>} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </SidebarProvider>,
  );
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listMyAgentVersions.mockResolvedValue(VERSIONS);
  api.getMyAgentVersion.mockImplementation(
    async (_u: string, _a: string, no: number) => DETAILS[no],
  );
  api.restoreMyAgentVersion.mockResolvedValue(mine);
});

describe("an agent's history", () => {
  it("is a section of the agent's page", () => {
    expect(DETAIL_SECTIONS).toContain("history");
    expect(agentPath("c1", "history")).toBe("/agents/c1?section=history");
  });

  it("lists the versions newest first, collapsed, the latest marked current, with a plain summary", async () => {
    renderAt("/agents/c1?section=history");
    const list = await screen.findByRole("list", { name: "Versions" });
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => within(b).getByText(/^Version \d+$/).textContent)).toEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "true");
    expect(within(items[0]).getByText("Current")).toBeInTheDocument();
    expect(within(items[0]).getByText(/Restored from version 1/)).toBeInTheDocument();
    expect(
      within(items[0]).getByText("Changed details, sub-agents and instructions."),
    ).toBeInTheDocument();
    expect(within(items[2]).getByText(/Created/)).toBeInTheDocument();
    // Nothing is open, and no version is fetched, until a row is opened.
    items.forEach((b) => expect(b).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByText(/Changes since version/)).not.toBeInTheDocument();
    expect(api.getMyAgentVersion).not.toHaveBeenCalled();
    // One list request, shared with the Overview.
    expect(api.listMyAgentVersions).toHaveBeenCalledTimes(1);
  });

  it("shows what an opened version changed since the one before it", async () => {
    renderAt("/agents/c1?section=history");
    // Version 3 (restored v1) against version 2.
    const row = await screen.findByRole("button", { name: /Version 3/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Changes since version 2.")).toBeInTheDocument();
    const details = screen.getByRole("region", { name: "Details changed" });
    expect(within(details).getByText("Name")).toBeInTheDocument();
    expect(within(details).getByText("My Researcher")).toBeInTheDocument();
    expect(within(details).getByText("Researcher")).toBeInTheDocument();
    const lists = screen.getByRole("region", { name: "Lists changed" });
    expect(within(lists).getByText("search")).toBeInTheDocument();
    expect(within(lists).getByText("Scout")).toBeInTheDocument();
    const files = screen.getByRole("region", { name: "Files changed" });
    expect(within(files).getByText("AGENT.md")).toBeInTheDocument();
    expect(within(files).getByText("subagents/scout.md")).toBeInTheDocument();
    expect(within(files).getByText("Removed")).toBeInTheDocument();
    expect(within(files).getByText("Be brief.")).toBeInTheDocument();
    expect(within(files).getByText("Be thorough.")).toBeInTheDocument();

    // The oldest kept version has nothing before it.
    fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
    expect(await screen.findByText(/nothing earlier to compare it with/)).toBeInTheDocument();
  });

  it("compares an opened version with any other version the user picks", async () => {
    renderAt("/agents/c1?section=history");
    fireEvent.click(await screen.findByRole("button", { name: /Version 3/ }));
    expect(await screen.findByText("Changes since version 2.")).toBeInTheDocument();

    // Version 3 restored version 1, so the two are the same.
    const picker = screen.getByRole("combobox", { name: "Compare with" });
    fireEvent.keyDown(picker, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Version 1/ }));
    expect(await screen.findByText("Changes since version 1.")).toBeInTheDocument();
    expect(
      await screen.findByText("Nothing in the definition differs from version 1."),
    ).toBeInTheDocument();
  });

  it("restores an older version after confirming, then re-reads the list and the agent", async () => {
    const ctx = renderAt("/agents/c1?section=history");
    fireEvent.click(await screen.findByRole("button", { name: /Version 2/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Restore this version/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/No version is added or\s+deleted/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(api.restoreMyAgentVersion).toHaveBeenCalledWith("u1", "c1", 2));
    await waitFor(() => expect(api.listMyAgentVersions).toHaveBeenCalledTimes(2));
    expect(ctx.refreshCatalog).toHaveBeenCalled();
    expect(ctx.userAgents.refreshMyAgents).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("marks a restored older version current, and offers Restore on the newer ones", async () => {
    api.listMyAgentVersions.mockResolvedValue(
      VERSIONS.map((v) => ({ ...v, current: v.versionNo === 2 })),
    );
    renderAt("/agents/c1?section=history");
    const list = await screen.findByRole("list", { name: "Versions" });
    const items = within(list).getAllByRole("button");
    expect(items[1]).toHaveAttribute("aria-current", "true");
    expect(within(items[1]).getByText("Current")).toBeInTheDocument();
    expect(within(items[0]).queryByText("Current")).not.toBeInTheDocument();

    fireEvent.click(items[1]);
    expect(await screen.findByText("Changes since version 1.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore this version/ })).not.toBeInTheDocument();
    fireEvent.click(items[0]);
    expect(await screen.findByRole("button", { name: /Restore this version/ })).toBeInTheDocument();
  });

  it("compares a save made after a restore with the version it was based on", async () => {
    api.listMyAgentVersions.mockResolvedValue([
      summary({ versionNo: 3, kind: "saved", basedOn: 1, changes: ["details"], current: true }),
      ...VERSIONS.slice(1),
    ]);
    renderAt("/agents/c1?section=history");
    expect(await screen.findByText(/Saved on top of version 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Version 3/ }));
    expect(await screen.findByText("Changes since version 1.")).toBeInTheDocument();
  });

  it("shows a refused restore's issues in the tab", async () => {
    api.restoreMyAgentVersion.mockRejectedValue(
      new ApiError("The agent definition is invalid.", {
        status: 422,
        detailObject: {
          message: "The agent definition is invalid.",
          errors: [],
          issues: [
            { path: "model.main", message: "Model 'old' is no longer offered.", severity: "error" },
          ],
        },
      }),
    );
    renderAt("/agents/c1?section=history");
    fireEvent.click(await screen.findByRole("button", { name: /Version 2/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Restore this version/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Restore" }),
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Version 2 could not be restored")).toBeInTheDocument();
    expect(within(alert).getByText("Model 'old' is no longer offered.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains an empty history and offers the editor", async () => {
    api.listMyAgentVersions.mockResolvedValue([]);
    renderAt("/agents/c1?section=history");
    expect(await screen.findByText(/History starts with the next save/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Edit agent/ }));
    expect(screen.getByTestId("where").textContent).toBe("/agents/c1/edit");
  });

  it("shows the latest version number on the Overview instead of the spec's 1.0.0", async () => {
    renderAt("/agents/c1");
    const row = (await screen.findByText("Version")).parentElement!;
    await waitFor(() => expect(within(row).getByText("3")).toBeInTheDocument());
    expect(within(row).queryByText("1.0.0")).not.toBeInTheDocument();
  });

  it("does not exist for a platform agent, which opens on Overview and loads nothing", async () => {
    renderAt("/agents/p1?section=history");
    expect(await screen.findByRole("heading", { name: "Platform Analyst" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const row = screen.getByText("Version").parentElement!;
    expect(within(row).getByText("1.0.0")).toBeInTheDocument();
    expect(api.listMyAgentVersions).not.toHaveBeenCalled();
  });
});
