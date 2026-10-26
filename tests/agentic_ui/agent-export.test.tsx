// @vitest-environment happy-dom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exportMyAgent, getAgents, getMyAgents } from "@/shared/lib/api";
import ScheduledTasksPage from "@/features/tasks/components/ScheduledTasksPage";
import { SidebarProvider } from "@/shared/ui/sidebar";
import type { Agent } from "@/shared/lib/types";

/**
 * The Agents section's bridge calls (plan 44, P2).
 *
 * Pinned: Export fetches the agent's `.zip` and saves it under the server's
 * filename (the slug fallback only without a Content-Disposition), and a
 * failure throws the bridge's detail; the custom list asks for its summary
 * only when told to, and reads the counts as null when the bridge sends none;
 * the catalog's `kind` reaches the app's Agent; and Schedules opens its
 * new-task form with an agent preset from "Schedule it".
 */

const fetchMock = vi.fn();
let clicked: { href: string; download: string }[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clicked = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:agent");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const zip = (headers: Record<string, string> = {}) =>
  new Response(new Blob(["PK"], { type: "application/zip" }), {
    status: 200,
    headers: { "Content-Type": "application/zip", ...headers },
  });

describe("export", () => {
  it("downloads the agent's zip under the server's filename", async () => {
    fetchMock.mockResolvedValueOnce(
      zip({ "Content-Disposition": 'attachment; filename="researcher.zip"' }),
    );
    await exportMyAgent("u1", "agent 1", "fallback");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/agents/u1/custom/agent%201/export");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Accept")).toBe("application/zip");
    expect(clicked).toEqual([{ href: "blob:agent", download: "researcher.zip" }]);
  });

  it("falls back to the given name without a Content-Disposition", async () => {
    fetchMock.mockResolvedValueOnce(zip());
    await exportMyAgent("u1", "a1", "my-researcher");
    expect(clicked[0].download).toBe("my-researcher.zip");
  });

  it("throws the bridge's detail and saves nothing on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Agent not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(exportMyAgent("u1", "a1")).rejects.toThrow("Agent not found");
    expect(clicked).toEqual([]);
  });
});

describe("agent lists", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("asks for the summary only when told to, and reads absent counts as null", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { id: "c1", name: "Mine", description: "", icon: "Bot", isActive: true, model: "openai:gpt-5", toolCount: 3, skillCount: 0, subagentCount: 2 },
      ]),
    );
    const [withSummary] = await getMyAgents("u1", { summary: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/agents/u1/custom?include=summary");
    expect(withSummary).toMatchObject({
      id: "c1",
      kind: "custom",
      model: "openai:gpt-5",
      toolCount: 3,
      skillCount: 0,
      subagentCount: 2,
    });

    // An older bridge: no summary fields at all, and no kind.
    fetchMock.mockResolvedValueOnce(
      json([{ id: "c1", name: "Mine", description: "", icon: "Bot", isActive: true }]),
    );
    const [plain] = await getMyAgents("u1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/agents/u1/custom");
    expect(plain).toMatchObject({
      kind: "custom",
      model: null,
      toolCount: null,
      skillCount: null,
      subagentCount: null,
    });
  });

  it("carries the catalog's kind, and leaves it unset when the row has none", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        { id: "p1", name: "P", description: "", icon: "Bot", isActive: true, kind: "platform" },
        { id: "c1", name: "C", description: "", icon: "Bot", isActive: true, kind: "custom" },
        { id: "x", name: "X", description: "", icon: "Bot", isActive: true, kind: "weird" },
        { id: "y", name: "Y", description: "", icon: "Bot", isActive: true },
      ]),
    );
    const agents = await getAgents();
    expect(agents.map((a) => a.kind)).toEqual(["platform", "custom", undefined, undefined]);
  });
});

describe("schedule it", () => {
  const Bot = () => <svg aria-hidden />;
  const agents = [
    { id: "a1", name: "Research Analyst", icon: Bot, isActive: true },
    { id: "a2", name: "My Researcher", icon: Bot, isActive: true },
  ] as unknown as Agent[];

  it("opens the new-task form with the agent chosen, once", async () => {
    const handled = vi.fn();
    render(
      <SidebarProvider>
        <ScheduledTasksPage
          tasks={[]}
          loading={false}
          error={null}
          agents={agents}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onOpenResult={vi.fn()}
          createForAgentId="a2"
          onCreateForAgentHandled={handled}
        />
      </SidebarProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    // The form's agent select shows the preset, not the list's first agent.
    const select = within(dialog).getByLabelText("Agent");
    expect(select).toHaveTextContent("My Researcher");
    expect(select).not.toHaveTextContent("Research Analyst");
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
