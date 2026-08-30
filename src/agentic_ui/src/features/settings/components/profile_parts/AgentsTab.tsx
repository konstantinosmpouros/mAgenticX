import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getAgentTools, toggleAgentTool } from "@/shared/lib/api";
import { loadSession } from "@/shared/lib/authStorage";
import type {
  Agent,
  AgentToolRow,
  AgentToolsResponse,
  CustomAgentDetail,
  CustomAgentValidation,
  CustomAgentWritePayload,
  UserSkill,
} from "@/shared/lib/types";
import { ALWAYS_GATED } from "@/features/settings/lib/agentTools";
import { usePanelHeader } from "@/features/settings/panel-header-context";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import AgentBuilder from "./AgentBuilder";
import { AgentsIndex, type AgentSummary } from "./agents_parts/AgentsIndex";
import { AgentDetail } from "./agents_parts/AgentDetail";
import { InfoCard } from "./shared";

/**
 * AgentsTab — the agents surface: list every agent, open one to configure what
 * it can do, or author your own.
 *
 * Restructured from a four-state screen that opened on per-agent tool toggles
 * and hid authoring behind a header button. The list is now the landing page
 * and tool management is one section of an agent's detail, which is what it
 * always was.
 *
 * Per-(user, agent) tool state still lives here: the disabled set is written
 * optimistically and rolled back on failure, and the agents service subtracts
 * it from the agent's declared tools at run time.
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

type View = "index" | "detail" | "create" | "edit";

/** Only deep agents expose a tool model, so only they get a tool fetch. */
const isConfigurable = (agent: Agent) => agent.type === "deep agent";

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
  const [view, setView] = useState<View>("index");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomAgentDetail | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  const [resp, setResp] = useState<AgentToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  // Per-agent tool tallies for the index rows, filled in the background so the
  // list paints immediately and the meta line fills in as counts arrive. A
  // failed fetch simply leaves that row's counts absent rather than erroring —
  // the row is still useful without them.
  const [counts, setCounts] = useState<Record<string, { tools: number; gated: number }>>({});
  const countsRequested = useRef<Set<string>>(new Set());

  const canAuthor = Boolean(onCreateAgent && onValidateAgent);
  const mineIds = useMemo(() => new Set(myAgents.map((a) => a.id)), [myAgents]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // ---- tools for the open agent ---------------------------------------
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
    if (view === "detail" && selectedId && selectedAgent && isConfigurable(selectedAgent)) {
      void load(selectedId);
    }
  }, [view, selectedId, selectedAgent, load]);

  // ---- background tallies for the index --------------------------------
  useEffect(() => {
    if (!userId || view !== "index") return;
    const pending = agents.filter((a) => isConfigurable(a) && !countsRequested.current.has(a.id));
    if (pending.length === 0) return;
    pending.forEach((a) => countsRequested.current.add(a.id));

    let cancelled = false;
    void Promise.all(
      pending.map(async (agent) => {
        try {
          const data = await getAgentTools(userId, agent.id);
          const enabled = data.tools.filter((t) => !t.disabled);
          return [
            agent.id,
            {
              tools: enabled.length,
              gated: enabled.filter((t) => ALWAYS_GATED.has(t.name)).length,
            },
          ] as const;
        } catch {
          // Silent: the row renders without counts rather than showing an
          // error for information that is decoration, not the point.
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, { tools: number; gated: number }> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      if (Object.keys(next).length) setCounts((prev) => ({ ...prev, ...next }));
    });

    return () => {
      cancelled = true;
    };
  }, [agents, userId, view]);

  const summaries: AgentSummary[] = useMemo(
    () =>
      agents.map((agent) => ({
        agent,
        mine: mineIds.has(agent.id),
        toolCount: counts[agent.id]?.tools ?? null,
        gatedCount: counts[agent.id]?.gated ?? null,
      })),
    [agents, mineIds, counts],
  );

  // The panel header names the page we are on; the detail and builder screens
  // therefore drop their own titles rather than stating it a second time.
  usePanelHeader(
    view === "create"
      ? {
          title: "Create new agent",
          description:
            "Describe the agent and it will be available in your composer straight away.",
          backLabel: "Agents",
          onBack: () => setView("index"),
        }
      : view === "edit"
        ? {
            title: `Edit ${editing?.name ?? "agent"}`,
            description: "Changes apply the next time you start a conversation with it.",
            backLabel: "Agents",
            onBack: () => setView("index"),
          }
        : view === "detail" && selectedAgent
          ? {
              title: selectedAgent.name,
              description: selectedAgent.description || undefined,
              backLabel: "Agents",
              onBack: () => setView("index"),
            }
          : null,
  );

  // ---- actions ---------------------------------------------------------
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
      // The index tally for this agent is now stale; drop it so it refetches.
      countsRequested.current.delete(selectedId);
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

  const openDetail = (agent: Agent) => {
    setSelectedId(agent.id);
    setResp(null);
    setError(null);
    setView("detail");
  };

  const openEdit = async (agent: Agent) => {
    if (!onLoadAgentDefinition) return;
    const detail = await onLoadAgentDefinition(agent.id);
    if (detail) {
      setEditing(detail);
      setView("edit");
    }
  };

  /**
   * Duplicate: load the source definition and open the builder in CREATE mode
   * with a fresh name and slug. The slug must differ — the server rejects a
   * create whose slug collides — and `-copy` is the least surprising suffix.
   */
  const openDuplicate = async (agent: Agent) => {
    if (!onLoadAgentDefinition) return;
    const detail = await onLoadAgentDefinition(agent.id);
    if (!detail) return;
    const spec = detail.spec as Record<string, unknown>;
    const baseSlug = typeof spec.slug === "string" ? spec.slug : detail.slug;
    setEditing({
      ...detail,
      id: "",
      name: `${detail.name} copy`,
      slug: `${baseSlug}-copy`,
      spec: { ...spec, slug: `${baseSlug}-copy`, name: `${detail.name} copy` },
    });
    setView("create");
  };

  const closeBuilder = () => {
    setEditing(null);
    setView("index");
  };

  // ---- render ----------------------------------------------------------
  if (view === "create" || view === "edit") {
    return (
      <div className="animate-fade-in space-y-6">
        <InfoCard>
          <AgentBuilder
            agents={agents}
            mySkills={mySkills}
            // A duplicate seeds CREATE from an existing definition, so `initial`
            // is not the same question as "are we editing".
            initial={editing}
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

  if (view === "detail" && selectedAgent) {
    const configurable = isConfigurable(selectedAgent);
    return (
      <div className="animate-fade-in">
        <AgentDetail
          agent={selectedAgent}
          mine={mineIds.has(selectedAgent.id)}
          configurable={configurable}
          tools={configurable ? (resp?.tools ?? []) : []}
          loading={configurable && loading}
          error={configurable ? error : null}
          togglingKey={togglingKey}
          onToggleTool={(row) => void onToggle(row)}
          onEdit={
            mineIds.has(selectedAgent.id) && onLoadAgentDefinition
              ? () => void openEdit(selectedAgent)
              : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <AgentsIndex
        summaries={summaries}
        canAuthor={canAuthor}
        busyAgentId={busyAgentId}
        onOpen={openDetail}
        onCreate={() => {
          setEditing(null);
          setView("create");
        }}
        onEdit={(agent) => void openEdit(agent)}
        onDuplicate={(agent) => void openDuplicate(agent)}
        onDelete={setPendingDelete}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.name ?? "agent"}?`}
        description="Its instructions, skills, sub-agents and files are removed. Conversations that used it are kept, but it will no longer appear in your composer."
        confirmLabel="Delete agent"
        onConfirm={async () => {
          if (pendingDelete) await onDeleteAgent?.(pendingDelete.id);
        }}
      />
    </div>
  );
}
