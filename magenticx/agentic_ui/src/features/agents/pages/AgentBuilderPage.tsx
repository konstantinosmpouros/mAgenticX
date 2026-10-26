import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";

import type { AgentDraft, CustomAgentDetail } from "@/shared/lib/types";
import { useAgentsPage } from "@/features/agents/context";
import { AgentNotFound, PageHeader } from "@/features/agents/components/page";
import { usePageTitle } from "@/features/agents/hooks/usePageChrome";
import { useAgentCatalogs } from "@/features/agents/hooks/useAgentCatalogs";
import { useAgentTools } from "@/features/agents/hooks/useAgentTools";
import { useExportAgent } from "@/features/agents/hooks/useExportAgent";
import { useResolvedAgent } from "@/features/agents/hooks/useResolvedAgent";
import { draftFromDetail, duplicateDefinition, emptyDraft } from "@/features/agents/lib/agentSpec";
import { draftStorageKey, formatSavedAt, readStoredDraft } from "@/features/agents/lib/draftStorage";
import type { ImportOutcome } from "@/features/agents/lib/importResult";
import type { PlacedIssue } from "@/features/agents/lib/agentIssues";
import { BuilderWorkspace, type BuilderSaved } from "@/features/agents/components/builder/BuilderWorkspace";
import { StartScreen } from "@/features/agents/components/builder/StartScreen";
import { ImportView } from "@/features/agents/components/builder/ImportView";
import type { AgentPageState } from "@/features/agents/pages/AgentPage";
import {
  AGENTS_PATH,
  BUILDER_SECTIONS,
  START_VIAS,
  agentPath,
  parseSection,
  type BuilderSection,
  type StartVia,
} from "@/features/agents/lib/routes";
import { guardedLeave } from "@/shared/lib/leaveGuard";

type Opened = Extract<ImportOutcome, { kind: "valid" | "invalid" }>;

/**
 * `/agents/new` and `/agents/:agentId/edit`.
 *
 * A new agent starts on a short start screen — the canvas, or import a YAML
 * (`?via=canvas|import`); `?from=<agentId>` (Duplicate) skips it and opens the
 * copy on the canvas. Editing opens the saved definition on the canvas, with
 * its current approval settings as the starting point. An imported YAML is
 * shown read-only first and opens in the builder from there.
 *
 * The page only gathers what the builder starts from (the definition, the
 * catalogs, the live tool rows) and where it goes after: a save lands on the
 * agent's page with a "Created" or "Saved" notice.
 */
export default function AgentBuilderPage({ mode }: { mode: "create" | "edit" }) {
  const { agentId: routeAgentId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, agents, mySkills, userAgents } = useAgentsPage();
  const isEdit = mode === "edit";
  const catalogs = useAgentCatalogs();
  const { exportAgent, exportingId } = useExportAgent(userId);

  // The agent the builder starts from: the one being edited, or the one `?from=`
  // duplicates. Only a custom agent has a definition to load.
  const fromId = isEdit ? "" : (searchParams.get("from") ?? "");
  const sourceId = isEdit ? routeAgentId : fromId;
  const { agent: source, resolving } = useResolvedAgent(sourceId);
  const sourceIsCustom = source?.kind === "custom";

  const [detail, setDetail] = useState<CustomAgentDetail | null>(null);
  const [loadingDefinition, setLoadingDefinition] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const { getAgentDefinition } = userAgents;
  // Keyed by id, not the agent object: a catalog re-pull (every save does one)
  // hands back new objects, and reloading on that would reset the builder.
  const definitionId = sourceIsCustom && source ? source.id : null;
  useEffect(() => {
    setDetail(null);
    setLoadFailed(false);
    if (!definitionId) return;
    let cancelled = false;
    setLoadingDefinition(true);
    void getAgentDefinition(definitionId)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) setLoadFailed(true);
        else setDetail(isEdit ? loaded : duplicateDefinition(loaded));
      })
      .finally(() => {
        if (!cancelled) setLoadingDefinition(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId, isEdit, getAgentDefinition]);

  // Editing: the agent's current per-account rows are the Approvals' baselines.
  const live = useAgentTools({ userId, agentId: isEdit ? routeAgentId : null });

  const section = parseSection<BuilderSection>(searchParams.get("section"), BUILDER_SECTIONS, "identity");
  const via = parseSection<StartVia | "start">(searchParams.get("via"), START_VIAS, "start");
  const setParam = useCallback(
    (key: string, value: string | null, replace = true) =>
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (value === null) params.delete(key);
          else params.set(key, value);
          return params;
        },
        { replace },
      ),
    [setSearchParams],
  );
  const onSection = useCallback((next: BuilderSection) => setParam("section", next), [setParam]);

  // An import opened in the builder: its draft and issues, for this visit.
  const [opened, setOpened] = useState<{ draft: AgentDraft; issues: PlacedIssue[]; at: number } | null>(null);
  const [creating, setCreating] = useState(false);

  const title = isEdit
    ? `Edit ${source?.name ?? "agent"}`
    : fromId
      ? `Duplicate ${source?.name ?? "agent"}`
      : via === "import"
        ? "Import an agent"
        : "New agent";
  usePageTitle(title);

  const exit = useCallback(() => {
    navigate(isEdit ? agentPath(routeAgentId) : AGENTS_PATH);
  }, [navigate, isEdit, routeAgentId]);

  const onSaved = useCallback(
    ({ agentId, created }: BuilderSaved) => {
      const state: AgentPageState = {
        notice: created
          ? "Created. It's ready in your chat's agent picker."
          : "Saved. The changes apply from your next conversation with it.",
      };
      navigate(agentPath(agentId), { replace: true, state });
    },
    [navigate],
  );

  const createImported = useCallback(
    async (outcome: Opened) => {
      setCreating(true);
      const agent = await userAgents.createAgent(outcome.payload, { quiet: true });
      setCreating(false);
      if (agent) onSaved({ agentId: agent.id, created: true });
    },
    [userAgents, onSaved],
  );

  const startDraft = useMemo(
    () => (catalogs.modelsLoaded ? emptyDraft(catalogs.defaultModel) : null),
    // The default model, once: a later catalog change must not reset a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogs.modelsLoaded],
  );
  const leftover = useMemo(() => {
    if (!userId || isEdit) return null;
    const stored = readStoredDraft(draftStorageKey(userId, null));
    return stored ? formatSavedAt(stored.savedAt) : null;
  }, [userId, isEdit]);

  // Edit is for your own agents only: an unknown id is not found, and a
  // platform agent's id goes to its page, which is all there is to see of it.
  if (isEdit && !source) {
    if (resolving) return <PageLoading />;
    return <AgentNotFound onBack={() => navigate(AGENTS_PATH)} />;
  }
  if (isEdit && !sourceIsCustom) {
    return <Navigate to={agentPath(routeAgentId)} replace />;
  }
  if (loadFailed) return <AgentNotFound onBack={() => navigate(AGENTS_PATH)} />;

  const workspace = (props: {
    initialDraft: AgentDraft;
    key: string;
    initialServerIssues?: PlacedIssue[];
    unsaved?: boolean;
    offerRestore?: boolean;
  }) => (
    <BuilderWorkspace
      key={props.key}
      mode={mode}
      agentId={isEdit ? routeAgentId : null}
      initialDraft={props.initialDraft}
      initialServerIssues={props.initialServerIssues}
      unsaved={props.unsaved}
      offerRestore={props.offerRestore}
      userId={userId}
      agents={agents}
      mySkills={mySkills}
      userAgents={userAgents}
      catalogs={catalogs}
      liveRows={isEdit ? live.tools : null}
      section={section}
      onSection={onSection}
      backLabel={isEdit ? (source?.name ?? "Agent") : "Agents"}
      onExit={exit}
      onSaved={onSaved}
      onDownloadZip={isEdit && source ? () => void exportAgent(source) : null}
      downloading={exportingId !== null}
    />
  );

  // ---- edit, and duplicate ----
  if (isEdit || fromId) {
    const waiting = (sourceId && resolving) || loadingDefinition || (isEdit && live.loading && !live.tools.length);
    if (waiting || (sourceIsCustom && !detail)) return <PageLoading />;
    if (!isEdit && !sourceIsCustom) {
      // Duplicating a platform agent (or an unknown id): a blank canvas.
      return startDraft ? workspace({ key: "blank", initialDraft: startDraft }) : <PageLoading />;
    }
    return workspace({
      key: detail?.id || detail?.slug || "definition",
      initialDraft: draftFromDetail(detail as CustomAgentDetail),
      unsaved: !isEdit,
      offerRestore: isEdit,
    });
  }

  // ---- create: an import opened in the builder ----
  if (via === "canvas" && opened) {
    return workspace({
      key: `import-${opened.at}`,
      initialDraft: opened.draft,
      initialServerIssues: opened.issues,
      unsaved: true,
      offerRestore: false,
    });
  }
  if (via === "canvas") {
    return startDraft ? workspace({ key: "new", initialDraft: startDraft }) : <PageLoading />;
  }

  // ---- create: the start screen, or the import ----
  return (
    <ImportOrStart
      via={via}
      leftover={leftover}
      onBack={() =>
        via === "import" ? setParam("via", null, false) : guardedLeave(() => navigate(AGENTS_PATH))
      }
      onChoose={(next) => setParam("via", next, false)}
    >
      {via === "import" ? (
        <ImportView
          userId={userId}
          catalogs={catalogs}
          creating={creating}
          onCreate={(outcome) => void createImported(outcome)}
          onOpen={(outcome) => {
            setOpened({ draft: outcome.draft, issues: outcome.issues, at: Date.now() });
            setParam("via", "canvas", false);
          }}
        />
      ) : null}
    </ImportOrStart>
  );
}

/** The start screen and the import share a header; the builder has its own bar. */
function ImportOrStart({
  via,
  leftover,
  onBack,
  onChoose,
  children,
}: {
  via: StartVia | "start";
  leftover: string | null;
  onBack: () => void;
  onChoose: (via: StartVia) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <PageHeader
        back={{ label: via === "import" ? "New agent" : "Agents", onClick: onBack }}
        title={via === "import" ? "Import a YAML" : "New agent"}
        subtitle={
          via === "import"
            ? "Bring in an agent written as YAML. It's checked first; nothing is saved until you create it."
            : "Build it on the canvas, or start from a YAML file."
        }
      />
      {via === "import" ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <StartScreen onCanvas={() => onChoose("canvas")} onImport={() => onChoose("import")} leftover={leftover} />
      )}
    </div>
  );
}

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground" aria-busy="true" aria-label="Loading agent">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
    </div>
  );
}
