import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bot, CalendarClock, Download, Loader2, MessageSquarePlus, Pencil } from "lucide-react";

import { useAgentsPage } from "@/features/agents/context";
import { AgentNotFound, KindBadge, PageHeader } from "@/features/agents/components/page";
import { useEscapeTo, usePageTitle } from "@/features/agents/hooks/usePageChrome";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/agents/lib/styles";
import { AgentDetail } from "@/features/agents/components/detail/AgentDetail";
import { AgentMemory } from "@/features/agents/components/detail/AgentMemory";
import { useAgentTools } from "@/features/agents/hooks/useAgentTools";
import { useExportAgent } from "@/features/agents/hooks/useExportAgent";
import { useResolvedAgent } from "@/features/agents/hooks/useResolvedAgent";
import {
  AGENTS_PATH,
  DETAIL_SECTIONS,
  agentEditPath,
  parseSection,
  type DetailSection,
} from "@/features/agents/lib/routes";

/** Navigation state a page may land here with — the builder's "created" notice. */
export type AgentPageState = { notice?: string } | null;

/**
 * `/agents/:agentId` — one agent: what it is, the tools it may use and which of
 * them ask first (live, per account), and what to do with it next: chat with
 * it, schedule it, and for your own agents edit or export it.
 *
 * The open section is `?section=`, so a link can open Tools or Approvals
 * directly — which is where a newly created agent lands.
 */
export default function AgentPage() {
  const { agentId = "" } = useParams();
  const { userId, userAgents, onChatWith, onSchedule } = useAgentsPage();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { agent, resolving } = useResolvedAgent(agentId);
  const { exportAgent, exportingId } = useExportAgent(userId);

  const requested = parseSection<DetailSection>(
    searchParams.get("section"),
    DETAIL_SECTIONS,
    "overview",
  );
  const notice = (location.state as AgentPageState)?.notice ?? null;
  const setSection = useCallback(
    (next: DetailSection) =>
      // Replace, not push: switching tabs is not a step Back should retrace.
      // The state rides along so the "created" notice survives a tab switch.
      setSearchParams({ section: next }, { replace: true, state: location.state }),
    [setSearchParams, location.state],
  );

  const custom = agent?.kind === "custom";
  // Only deep agents have a per-agent tool model to load.
  const configurable = agent?.type === "deep agent";
  // Memory, like tools, is a deep-agent concept: another agent opens on Overview.
  const section: DetailSection = requested === "memory" && !configurable ? "overview" : requested;
  const tools = useAgentTools({ userId, agentId: agent?.id ?? null, enabled: configurable });
  const summary = useMemo(() => {
    const mine = custom ? userAgents.myAgents.find((a) => a.id === agentId) : undefined;
    return mine
      ? {
          model: mine.model,
          toolCount: mine.toolCount,
          skillCount: mine.skillCount,
          subagentCount: mine.subagentCount,
        }
      : null;
  }, [custom, userAgents.myAgents, agentId]);

  usePageTitle(agent?.name ?? "Agents");
  useEscapeTo(() => navigate(AGENTS_PATH));

  if (!agent) {
    if (resolving) {
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
    return <AgentNotFound onBack={() => navigate(AGENTS_PATH)} />;
  }

  const Icon = agent.icon ?? Bot;
  const exporting = exportingId === agent.id;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        back={{ label: "Agents", onClick: () => navigate(AGENTS_PATH) }}
        icon={
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-muted/50 text-primary">
            <Icon size={19} aria-hidden />
          </span>
        }
        title={agent.name}
        badge={<KindBadge custom={custom} />}
        subtitle={agent.description || undefined}
        actions={
          <>
            <button type="button" onClick={() => onChatWith(agent.id)} className={PRIMARY_BUTTON}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden /> Chat with it
            </button>
            <button type="button" onClick={() => onSchedule(agent.id)} className={SECONDARY_BUTTON}>
              <CalendarClock className="h-4 w-4" aria-hidden /> Schedule it
            </button>
            {custom ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate(agentEditPath(agent.id))}
                  className={SECONDARY_BUTTON}
                >
                  <Pencil className="h-4 w-4" aria-hidden /> Edit
                </button>
                <button
                  type="button"
                  onClick={() => void exportAgent(agent)}
                  disabled={exporting}
                  aria-busy={exporting}
                  className={SECONDARY_BUTTON}
                >
                  {exporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden />
                  )}
                  Export
                </button>
              </>
            ) : null}
          </>
        }
      />

      <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-5xl pb-10 pt-2">
          <AgentDetail
            agent={agent}
            mine={custom}
            configurable={configurable}
            tools={configurable ? tools.tools : []}
            loading={configurable && tools.loading}
            error={configurable ? tools.error : null}
            togglingKey={tools.togglingKey}
            onToggleTool={(row) => void tools.toggleTool(row)}
            onToggleApproval={(row) => void tools.toggleApproval(row)}
            section={section}
            onSectionChange={setSection}
            notice={notice}
            summary={summary}
            memory={
              section === "memory" ? (
                <AgentMemory userId={userId} agentId={agent.id} agentName={agent.name} />
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}
