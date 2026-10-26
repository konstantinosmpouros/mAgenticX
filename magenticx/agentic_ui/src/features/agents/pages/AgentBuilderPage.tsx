import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { getTools } from "@/shared/lib/api";
import type { CustomAgentDetail, ToolMetadata } from "@/shared/lib/types";
import { useAgentsPage } from "@/features/agents/context";
import AgentBuilder from "@/features/agents/components/builder/AgentBuilder";
import { AgentNotFound, PageHeader } from "@/features/agents/components/page";
import { usePageTitle } from "@/features/agents/hooks/usePageChrome";
import { duplicateDefinition } from "@/features/agents/lib/agentSpec";
import { useAgentTools } from "@/features/agents/hooks/useAgentTools";
import { useResolvedAgent } from "@/features/agents/hooks/useResolvedAgent";
import type { AgentPageState } from "@/features/agents/pages/AgentPage";
import {
  AGENTS_PATH,
  BUILDER_SECTIONS,
  agentPath,
  parseSection,
  type BuilderSection,
} from "@/features/agents/lib/routes";

const CREATED_NOTICE =
  "Agent created. Choose which of its tools should ask before running — it applies right away.";

/**
 * `/agents/new` (create; `?from=<agentId>` duplicates one of your agents) and
 * `/agents/:agentId/edit`.
 *
 * Hosts today's builder form unchanged, on a page instead of in the settings
 * panel; the full-page builder replaces it later. The save flow is the one it
 * had: validate, then create or update, and the catalog is re-pulled so the
 * chat's picker has the change. A new agent then lands on its own page's
 * Approvals, since choosing what asks first is the next thing to do with it.
 * Cancel and Back return to where the builder was opened from: the agent's
 * page when editing, the gallery when creating.
 */
export default function AgentBuilderPage({ mode }: { mode: "create" | "edit" }) {
  const { agentId: routeAgentId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, agents, mySkills, userAgents } = useAgentsPage();
  const isEdit = mode === "edit";

  // The agent the builder starts from: the one being edited, or the one `?from=`
  // duplicates. Only a custom agent has a definition to load.
  const sourceId = isEdit ? routeAgentId : (searchParams.get("from") ?? "");
  const { agent: source, resolving } = useResolvedAgent(sourceId);
  const sourceIsCustom = source?.kind === "custom";

  const [initial, setInitial] = useState<CustomAgentDetail | null>(null);
  const [loadingDefinition, setLoadingDefinition] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const { getAgentDefinition } = userAgents;
  // Keyed by id, not the agent object: a catalog re-pull (every save does one)
  // hands back new objects, and reloading on that would unmount the form.
  const definitionId = sourceIsCustom && source ? source.id : null;
  useEffect(() => {
    setInitial(null);
    setLoadFailed(false);
    if (!definitionId) return;
    let cancelled = false;
    setLoadingDefinition(true);
    void getAgentDefinition(definitionId)
      .then((detail) => {
        if (cancelled) return;
        if (!detail) setLoadFailed(true);
        else setInitial(isEdit ? detail : duplicateDefinition(detail));
      })
      .finally(() => {
        if (!cancelled) setLoadingDefinition(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId, isEdit, getAgentDefinition]);

  // The gateway's tool catalog for the Tools picker, fetched when the builder
  // opens. Silent on failure: the section explains an empty catalog itself,
  // and an agent can be saved without tools.
  const [toolCatalog, setToolCatalog] = useState<ToolMetadata[]>([]);
  useEffect(() => {
    let cancelled = false;
    void getTools()
      .then((tools) => {
        if (!cancelled) setToolCatalog(tools);
      })
      .catch(() => {
        if (!cancelled) setToolCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Editing shows the agent's live, per-account tool rows too, as its page does.
  const live = useAgentTools({ userId, agentId: isEdit ? routeAgentId : null });

  const section = parseSection<BuilderSection>(
    searchParams.get("section"),
    BUILDER_SECTIONS,
    "identity",
  );
  const onSectionChange = useCallback(
    (next: BuilderSection) =>
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("section", next);
          return params;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  const created = useRef<string | null>(null);
  const close = () => {
    if (created.current) {
      const state: AgentPageState = { notice: CREATED_NOTICE };
      navigate(agentPath(created.current, "approvals"), { replace: true, state });
    } else if (isEdit) {
      navigate(agentPath(routeAgentId));
    } else {
      navigate(AGENTS_PATH);
    }
  };

  const title = isEdit
    ? `Edit ${source?.name ?? "agent"}`
    : sourceIsCustom
      ? `Duplicate ${source?.name ?? "agent"}`
      : "New agent";
  usePageTitle(title);

  // Edit is for your own agents only: an unknown id is not found, and a
  // platform agent's id goes to its page, which is all there is to see of it.
  if (isEdit && !source) {
    if (resolving) return <PageLoading />;
    return <AgentNotFound onBack={() => navigate(AGENTS_PATH)} />;
  }
  if (isEdit && !sourceIsCustom) {
    return <Navigate to={agentPath(routeAgentId)} replace />;
  }

  const waiting = (sourceId && resolving) || loadingDefinition;
  const ready = !waiting && (!sourceIsCustom || initial !== null);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        back={
          isEdit
            ? { label: source?.name ?? "Agent", onClick: close }
            : { label: "Agents", onClick: close }
        }
        title={title}
        subtitle={
          isEdit
            ? "Changes apply the next time you start a conversation with it."
            : "Describe the agent and it will be available in your chat straight away."
        }
      />
      <div className="min-h-0 flex-1 px-4 pb-4 sm:px-6">
        <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col">
          {loadFailed ? (
            <AgentNotFound onBack={() => navigate(AGENTS_PATH)} />
          ) : ready ? (
            <AgentBuilder
              // Re-mounted per definition: the form seeds its draft once.
              key={initial?.id || initial?.slug || "blank"}
              agents={agents}
              mySkills={mySkills}
              toolCatalog={toolCatalog}
              // A duplicate seeds CREATE from an existing definition, so
              // `initial` is not the same question as "are we editing".
              mode={mode}
              initial={initial}
              submitting={Boolean(userAgents.busyAgentId)}
              onValidate={userAgents.validateAgent}
              onSubmit={async (payload) => {
                if (isEdit) return userAgents.updateAgent(routeAgentId, payload);
                const agent = await userAgents.createAgent(payload);
                if (agent) created.current = agent.id;
                return agent;
              }}
              onClose={close}
              liveTools={isEdit ? live.tools : null}
              liveToolsLoading={live.loading}
              liveToolsError={live.error}
              togglingKey={live.togglingKey}
              onToggleTool={(row) => void live.toggleTool(row)}
              onToggleApproval={(row) => void live.toggleApproval(row)}
              initialSection={section}
              onSectionChange={onSectionChange}
            />
          ) : (
            <PageLoading />
          )}
        </div>
      </div>
    </div>
  );
}

function PageLoading() {
  return (
    <div
      className="flex h-full items-center justify-center text-muted-foreground"
      aria-busy="true"
      aria-label="Loading agent"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}
