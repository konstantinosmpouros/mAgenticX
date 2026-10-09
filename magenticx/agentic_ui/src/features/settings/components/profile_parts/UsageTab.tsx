import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";

import type { UsageRange } from "@/shared/lib/api";
import type { Agent, UsageAgentEntity, UsageAgentGroup, UsageSummary } from "@/shared/lib/types";
import { usePanelHeader } from "@/features/settings/panel-header-context";
import { UsageOverview } from "./usage/UsageOverview";
import { UsageConversations } from "./usage/UsageConversations";
import { UsageConversationDetail } from "./usage/UsageConversationDetail";
import { UsageAgents } from "./usage/UsageAgents";
import { UsageAgentCompare } from "./usage/UsageAgentCompare";
import { UsageAgentDetail } from "./usage/UsageAgentDetail";

/**
 * UsageTab — the Settings → Usage dashboard and its drill-downs (plan 33).
 *
 * Not one screen but a small stack, like the Skills and Memories tabs: the
 * Overview, then two parallel paths — Conversations → one conversation, and
 * Agents → (compare) → one agent — which also link into each other. Each page
 * publishes the panel's header (title, back to where you came from, and the
 * refresh action), so there is one header, never two.
 *
 * The time range is chosen once and shared by every page that has one, so
 * drilling in keeps the period you were looking at.
 */

type UsagePage =
  | { page: "overview" }
  | { page: "conversations" }
  | { page: "conversation"; id: string; title: string | null }
  | { page: "agents" }
  | { page: "compare"; agents: UsageAgentEntity[] }
  | { page: "agent"; key: string; name: string };

const pageTitle = (page: UsagePage): string => {
  switch (page.page) {
    case "overview":
      return "Usage";
    case "conversations":
      return "Conversations";
    case "conversation":
      return page.title || "Untitled conversation";
    case "agents":
      return "Agents";
    case "compare":
      return "Compare agents";
    case "agent":
      return page.name;
  }
};

const PAGE_DESCRIPTIONS: Record<UsagePage["page"], string> = {
  overview: "What your agents spend, how fast they answer, and where it goes.",
  conversations: "Every conversation, ranked by what it spent.",
  conversation: "Its context over time, who did the work, and every answer.",
  agents: "Every agent you've worked with — platform and your own — side by side.",
  compare: "The same measures, agent by agent.",
  agent: "One agent across all your conversations.",
};

type UsageTabProps = {
  userId: string | null;
  summary: UsageSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** The conversation open in the chat, for a shortcut straight to its analysis. */
  openConversation: { id: string; title: string | null } | null;
  agents: Agent[];
  /** Close the settings panel (before opening a chat). */
  onClosePanel: () => void;
  onManageAgents: () => void;
};

export default function UsageTab({
  userId,
  summary,
  loading,
  error,
  onRefresh,
  openConversation,
  agents,
  onClosePanel,
  onManageAgents,
}: UsageTabProps) {
  const navigate = useNavigate();
  const [stack, setStack] = useState<UsagePage[]>([{ page: "overview" }]);
  const [range, setRange] = useState<UsageRange>("30d");
  const [refreshToken, setRefreshToken] = useState(0);
  const [pageBusy, setPageBusy] = useState(false);

  const current = stack[stack.length - 1];
  const previous = stack.length > 1 ? stack[stack.length - 2] : null;
  const push = useCallback((page: UsagePage) => setStack((pages) => [...pages, page]), []);
  const back = useCallback(() => setStack((pages) => (pages.length > 1 ? pages.slice(0, -1) : pages)), []);
  const onBusyChange = useCallback((busy: boolean) => setPageBusy(busy), []);

  const refresh = useCallback(() => {
    if (current.page === "overview") onRefresh();
    else setRefreshToken((token) => token + 1);
  }, [current.page, onRefresh]);

  usePanelHeader({
    eyebrow: current.page === "overview" ? undefined : "Usage",
    title: pageTitle(current),
    description: PAGE_DESCRIPTIONS[current.page],
    backLabel: previous ? pageTitle(previous) : undefined,
    onBack: previous ? back : undefined,
    action:
      current.page === "compare"
        ? undefined
        : {
            icon: RefreshCw,
            label: "Refresh usage",
            onClick: refresh,
            busy: current.page === "overview" ? loading : pageBusy,
          },
  });

  const openConversationPage = (id: string, title: string | null) => push({ page: "conversation", id, title });
  const openAgentPage = (agent: Pick<UsageAgentEntity, "key" | "name">) =>
    push({ page: "agent", key: agent.key, name: agent.name });
  const openChat = (conversationId: string) => {
    onClosePanel();
    navigate(`/c/${encodeURIComponent(conversationId)}`);
  };
  const agentOptions = agents.map((agent) => ({ id: agent.id, name: agent.name }));

  switch (current.page) {
    case "overview":
      return (
        <UsageOverview
          summary={summary}
          error={error}
          onRetry={onRefresh}
          openConversation={openConversation}
          onOpenConversation={openConversationPage}
          onOpenConversations={() => push({ page: "conversations" })}
          onOpenAgents={() => push({ page: "agents" })}
        />
      );
    case "conversations":
      return (
        <UsageConversations
          userId={userId}
          range={range}
          onRangeChange={setRange}
          agentOptions={agentOptions}
          refreshToken={refreshToken}
          onBusyChange={onBusyChange}
          onOpenConversation={openConversationPage}
        />
      );
    case "conversation":
      return (
        <UsageConversationDetail
          key={current.id}
          userId={userId}
          conversationId={current.id}
          refreshToken={refreshToken}
          onBusyChange={onBusyChange}
          onOpenChat={openChat}
          onOpenAgent={(group: UsageAgentGroup) =>
            group.agentId ? openAgentPage({ key: group.agentId, name: group.agentName }) : undefined
          }
        />
      );
    case "agents":
      return (
        <UsageAgents
          userId={userId}
          range={range}
          onRangeChange={setRange}
          refreshToken={refreshToken}
          onBusyChange={onBusyChange}
          onOpenAgent={openAgentPage}
          onCompare={(selected) => push({ page: "compare", agents: selected })}
        />
      );
    case "compare":
      return <UsageAgentCompare agents={current.agents} onOpenAgent={openAgentPage} />;
    case "agent":
      return (
        <UsageAgentDetail
          key={current.key}
          userId={userId}
          agentKey={current.key}
          range={range}
          onRangeChange={setRange}
          refreshToken={refreshToken}
          onBusyChange={onBusyChange}
          onOpenConversation={openConversationPage}
          onManageAgents={onManageAgents}
        />
      );
  }
}
