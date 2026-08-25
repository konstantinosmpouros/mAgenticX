import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, Bot, Pencil, Plus, Trash2 } from "lucide-react";

import { getAgentTools, toggleAgentTool } from "@/shared/lib/api";
import { loadSession } from "@/shared/lib/authStorage";
import { cn } from "@/shared/lib/utils";
import type {
  Agent,
  AgentsSubView,
  AgentToolRow,
  AgentToolsResponse,
  CustomAgentDetail,
  CustomAgentValidation,
  CustomAgentWritePayload,
  UserSkill,
} from "@/shared/lib/types";
import AgentBuilder from "./AgentBuilder";
import { InfoCard, SoftPanel } from "./shared";

/**
 * AgentsTab — pick a (deep) agent and toggle which tools it may use in your
 * conversations. The disabled set is per-(user, agent); the agents service
 * subtracts it from the agent's declared tools at run time. Self-contained:
 * reads the current user from the session and drives its own load/toggle via
 * the api layer (optimistic, with rollback on failure). Only deep agents expose
 * a tool model, so the selector is filtered to them.
 */
type AgentsTabProps = {
  agents: Agent[];
  /** The agents this user authored (a subset of `agents`, by id). */
  myAgents?: Agent[];
  mySkills?: UserSkill[];
  busyAgentId?: string | null;
  onCreateAgent?: (payload: CustomAgentWritePayload) => Promise<Agent | null>;
  onUpdateAgent?: (agentId: string, payload: CustomAgentWritePayload) => Promise<Agent | null>;
  onDeleteAgent?: (agentId: string) => Promise<boolean>;
  onValidateAgent?: (payload: CustomAgentWritePayload) => Promise<CustomAgentValidation | null>;
  onLoadAgentDefinition?: (agentId: string) => Promise<CustomAgentDetail | null>;
};

export default function AgentsTab({
  agents,
  myAgents = [],
  mySkills = [],
  busyAgentId = null,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onValidateAgent,
  onLoadAgentDefinition,
}: AgentsTabProps) {
  const userId = loadSession()?.userId ?? null;
  // Subview state, mirroring the Skills tab: the tab opens on the tool
  // manager and navigates into the agent list / builder, with Back returning.
  const [view, setView] = useState<AgentsSubView>("tools");
  const [editing, setEditing] = useState<CustomAgentDetail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const canAuthor = Boolean(onCreateAgent && onValidateAgent);

  const openCreate = () => {
    setEditing(null);
    setView("create");
  };

  const openEdit = async (agentId: string) => {
    if (!onLoadAgentDefinition) return;
    setOpeningId(agentId);
    const detail = await onLoadAgentDefinition(agentId);
    setOpeningId(null);
    if (detail) {
      setEditing(detail);
      setView("edit");
    }
  };

  const closeBuilder = () => {
    setEditing(null);
    setView("mine");
  };
  const toolAgents = useMemo(() => agents.filter((a) => a.type === "deep agent"), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resp, setResp] = useState<AgentToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  // Default to the first deep agent once the list is known, and re-point if the
  // selected one leaves the list — deleting the agent whose tools are open
  // would otherwise keep fetching a dead id and surface a load error.
  useEffect(() => {
    setSelectedId((prev) =>
      prev && toolAgents.some((a) => a.id === prev) ? prev : (toolAgents[0]?.id ?? null),
    );
  }, [toolAgents]);

  const selectedAgent = useMemo(
    () => toolAgents.find((a) => a.id === selectedId) ?? null,
    [toolAgents, selectedId],
  );

  const load = useCallback(
    async (agentId: string) => {
      if (!userId) {
        setError("Sign in to manage agent tools.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setResp(await getAgentTools(userId, agentId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load agent tools.");
        setResp(null);
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    if (selectedId) void load(selectedId);
  }, [selectedId, load]);

  const onToggle = async (row: AgentToolRow) => {
    if (!userId || !selectedId || togglingKey) return;
    setTogglingKey(row.key);
    setError(null);
    const nextDisabled = !row.disabled;
    // Optimistic flip; reconcile with the server response (or roll back).
    setResp((prev) =>
      prev
        ? {
            ...prev,
            tools: prev.tools.map((t) =>
              t.key === row.key ? { ...t, disabled: nextDisabled } : t,
            ),
          }
        : prev,
    );
    try {
      setResp(await toggleAgentTool(userId, selectedId, row.key, nextDisabled));
    } catch (err) {
      setResp((prev) =>
        prev
          ? {
              ...prev,
              tools: prev.tools.map((t) =>
                t.key === row.key ? { ...t, disabled: row.disabled } : t,
              ),
            }
          : prev,
      );
      setError(err instanceof Error ? err.message : "Failed to update tool.");
    } finally {
      setTogglingKey(null);
    }
  };

  const renderRow = (row: AgentToolRow) => {
    const enabled = !row.disabled;
    const busy = togglingKey === row.key;
    return (
      <div key={row.key} className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{row.name}</p>
            <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {row.source}
            </span>
          </div>
          {row.description ? (
            // MCP tools ship a long LLM-facing description; show a 2-line
            // preview here (full text lives in the read-only MCP Servers tab).
            <p
              className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground"
              title={row.description}
            >
              {row.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${row.name}`}
          disabled={busy}
          onClick={() => void onToggle(row)}
          className={cn(
            "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            enabled ? "border-primary/40 bg-primary/20" : "border-transparent bg-background/80",
            busy && "cursor-not-allowed opacity-60",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 rounded-full shadow transition-transform",
              enabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60",
            )}
          />
        </button>
      </div>
    );
  };

  // Split the agent's baseline tools from the gateway tools the user may add.
  const declaredRows = resp?.tools.filter((t) => t.declared) ?? [];
  const availableRows = resp?.tools.filter((t) => !t.declared) ?? [];

  const backButton = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <ArrowLeft size={13} aria-hidden /> {label}
    </button>
  );

  // --- builder ---------------------------------------------------------
  if (view === "create" || view === "edit") {
    return (
      <div className="space-y-6 animate-fade-in">
        <InfoCard
          eyebrow={view === "edit" ? "Edit" : "Create"}
          title={view === "edit" ? `Edit ${editing?.name ?? "agent"}` : "New agent"}
          description="Describe the agent and it will be available in your composer straight away."
          headerAction={backButton("Back", closeBuilder)}
        >
          <AgentBuilder
            agents={agents}
            mySkills={mySkills}
            initial={view === "edit" ? editing : null}
            submitting={Boolean(busyAgentId)}
            onValidate={onValidateAgent ?? (async () => null)}
            onSubmit={async (payload) =>
              view === "edit" && editing
                ? ((await onUpdateAgent?.(editing.id, payload)) ?? null)
                : ((await onCreateAgent?.(payload)) ?? null)
            }
            onClose={closeBuilder}
          />
        </InfoCard>
      </div>
    );
  }

  // --- my agents -------------------------------------------------------
  if (view === "mine") {
    return (
      <div className="space-y-6 animate-fade-in">
        <InfoCard
          eyebrow="Workspace"
          title="Your agents"
          description="Agents you built. Only you can see and use them."
          headerAction={backButton("Back", () => setView("tools"))}
        >
          <div className="space-y-4">
            {canAuthor ? (
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <Plus size={15} aria-hidden /> New agent
              </button>
            ) : null}

            {myAgents.length === 0 ? (
              <SoftPanel className="px-6 py-10 text-center">
                <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Bot size={18} aria-hidden />
                </span>
                <p className="text-sm font-semibold text-foreground">No agents yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Build one with its own instructions, model, skills and sub-agents.
                </p>
              </SoftPanel>
            ) : (
              <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                {myAgents.map((agent) => {
                  const Icon = agent.icon;
                  const busy = busyAgentId === agent.id || openingId === agent.id;
                  const confirming = confirmDeleteId === agent.id;
                  return (
                    <div
                      key={agent.id}
                      className="flex items-start justify-between gap-4 px-5 py-4"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-background/70 text-muted-foreground">
                          {Icon ? <Icon size={15} aria-hidden /> : <Bot size={15} aria-hidden />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">{agent.name}</p>
                          {agent.description ? (
                            <p className="mt-0.5 break-words text-sm text-muted-foreground">
                              {agent.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {confirming ? (
                          <>
                            <span className="text-xs text-muted-foreground">Delete?</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={async () => {
                                setConfirmDeleteId(null);
                                await onDeleteAgent?.(agent.id);
                              }}
                              className="rounded-lg border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-lg border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void openEdit(agent.id)}
                              aria-label={`Edit ${agent.name}`}
                              className={cn(
                                "rounded-lg p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                busy && "cursor-not-allowed opacity-60",
                              )}
                            >
                              <Pencil size={15} aria-hidden />
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteId(agent.id)}
                              aria-label={`Delete ${agent.name}`}
                              className={cn(
                                "rounded-lg p-1.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50",
                                busy && "cursor-not-allowed opacity-60",
                              )}
                            >
                              <Trash2 size={15} aria-hidden />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </SoftPanel>
            )}
          </div>
        </InfoCard>
      </div>
    );
  }

  // --- tools (default) -------------------------------------------------
  return (
    <div className="space-y-6 animate-fade-in">
      <InfoCard
        eyebrow="Workspace"
        title="Choose an agent"
        description="Pick an agent to manage its tools. Your choices apply to this agent only."
        headerAction={
          canAuthor ? (
            <button
              type="button"
              onClick={() => setView("mine")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <Bot size={13} aria-hidden /> Your agents
              {myAgents.length > 0 ? ` (${myAgents.length})` : ""}
            </button>
          ) : null
        }
      >
        {toolAgents.length === 0 ? (
          <SoftPanel className="px-6 py-10 text-center">
            <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Bot size={18} aria-hidden />
            </span>
            <p className="text-sm font-semibold text-foreground">No configurable agents</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Only deep agents expose per-agent tool controls.
            </p>
          </SoftPanel>
        ) : (
          <div className="flex flex-wrap gap-2">
            {toolAgents.map((agent) => {
              const Icon = agent.icon;
              const active = agent.id === selectedId;
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border/60 bg-background/60 text-muted-foreground hover:bg-background/80 hover:text-foreground",
                  )}
                >
                  {Icon ? <Icon size={15} aria-hidden /> : <Bot size={15} aria-hidden />}
                  <span className="font-medium">{agent.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </InfoCard>

      {selectedAgent ? (
        <InfoCard
          eyebrow="Tools"
          title={`${selectedAgent.name}'s tools`}
          description="Turn off any of the agent's own tools, or turn on extra tools from the connected apps to grant them to just this agent."
        >
          {error ? (
            <SoftPanel className="flex items-center gap-3 px-4 py-3">
              <AlertCircle size={16} className="shrink-0 text-destructive" aria-hidden />
              <p className="text-sm text-muted-foreground">{error}</p>
            </SoftPanel>
          ) : loading && !resp ? (
            <SoftPanel className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">Loading tools…</p>
            </SoftPanel>
          ) : resp && resp.tools.length > 0 ? (
            <div className="space-y-5">
              {declaredRows.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    The agent's tools
                  </p>
                  <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    {declaredRows.map(renderRow)}
                  </SoftPanel>
                </div>
              ) : null}
              {availableRows.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Available to add
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Tools from the connected apps. Turn one on to let this agent use it in your
                    conversations.
                  </p>
                  <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    {availableRows.map(renderRow)}
                  </SoftPanel>
                </div>
              ) : null}
            </div>
          ) : (
            <SoftPanel className="px-6 py-10 text-center">
              <p className="text-sm font-semibold text-foreground">No configurable tools</p>
              <p className="mt-1 text-sm text-muted-foreground">
                This agent has no tools to toggle right now.
              </p>
            </SoftPanel>
          )}
        </InfoCard>
      ) : null}
    </div>
  );
}
