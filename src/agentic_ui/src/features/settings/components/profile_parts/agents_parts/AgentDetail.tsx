import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Pencil, ShieldCheck, Wrench } from "lucide-react";

import type { Agent, AgentToolRow } from "@/shared/lib/types";
import { SectionTabs, type SectionTab } from "./SectionTabs";
import { ToolList } from "./ToolList";
import { SoftPanel } from "../shared";

/**
 * One agent's configuration, as sections rather than a stack of cards.
 *
 * This is where the old tool-toggle screen lives now. It used to be the tab's
 * landing page, which put a secondary task (switching individual tools on and
 * off) in front of the primary one (seeing what agents exist). Here it is one
 * section of one agent.
 *
 * Tools and Approvals render the same rows through one ToolList, differing only
 * by axis. Prebuilt tools are locked on the enable axis and mandated gates are
 * locked on the approval axis, because a live switch for either would be a
 * control that silently does nothing.
 */

type DetailSection = "overview" | "tools" | "approvals";

/**
 * The manifest's raw lifecycle type, in sentence case.
 *
 * The server speaks in lowercase internal names ("deep agent") because they are
 * registry keys; rendering them verbatim in a settings panel reads like a leaked
 * implementation detail.
 */
const agentTypeLabel = (raw?: string): string => {
  if (!raw) return "—";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

export function AgentDetail({
  agent,
  mine,
  configurable,
  tools,
  loading,
  error,
  togglingKey,
  onToggleTool,
  onToggleApproval,
  onEdit,
}: {
  agent: Agent;
  mine: boolean;
  /**
   * Whether this agent has a per-agent tool model at all. Only deep agents do:
   * the five gated builtins and the `interrupt_on` map are deep-agent concepts,
   * so a LangGraph agent has neither tools to toggle nor approvals to set.
   */
  configurable: boolean;
  tools: AgentToolRow[];
  loading: boolean;
  error: string | null;
  togglingKey: string | null;
  onToggleTool: (row: AgentToolRow) => void;
  onToggleApproval: (row: AgentToolRow) => void;
  onEdit?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [section, setSection] = useState<DetailSection>("tools");

  const enabledCount = useMemo(() => tools.filter((t) => t.enabled).length, [tools]);
  const gatedCount = useMemo(() => tools.filter((t) => t.approval).length, [tools]);

  const tabs: SectionTab<DetailSection>[] = [
    { id: "overview", label: "Overview" },
    { id: "tools", label: "Tools", count: enabledCount },
    { id: "approvals", label: "Approvals", count: gatedCount },
  ];

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-3 border-b border-border/50">
        <SectionTabs tabs={tabs} active={section} onSelect={setSection} idPrefix="agent-detail" />
        {mine && onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="mb-1 inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition-all hover:bg-background active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Pencil size={13} aria-hidden /> Edit
          </button>
        ) : null}
      </div>

      {error ? (
        <SoftPanel className="flex items-start gap-3 px-4 py-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-muted-foreground">{error}</p>
        </SoftPanel>
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={section}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {section === "tools" && !configurable ? (
            <SoftPanel className="px-6 py-10 text-center">
              <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
                <Wrench size={18} aria-hidden />
              </span>
              <p className="text-sm font-semibold text-foreground">No tool controls</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {agent.name} is a {agent.type ?? "non-deep"} agent. Its tools are fixed by its
                graph, so there is nothing to switch on or off per conversation.
              </p>
            </SoftPanel>
          ) : null}

          {section === "tools" && configurable ? (
            <ToolList
              tools={tools}
              loading={loading && tools.length === 0}
              togglingKey={togglingKey}
              onToggle={onToggleTool}
              emptyHint="Connect an MCP server, or give this agent tools when you edit it."
            />
          ) : null}

          {section === "overview" ? (
            <div className="space-y-3">
              {/* Two tiles, not the usual three-across: these are the only two
                  numbers that change as the user configures the agent, and the
                  rest is fixed metadata that belongs in a list, not a card. */}
              {configurable ? (
                <div className="grid grid-cols-2 gap-3">
                  <SoftPanel className="px-5 py-4">
                    <p className="text-xs text-muted-foreground">Tools on</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                      {enabledCount}
                      <span className="ml-1 text-sm font-normal text-muted-foreground">
                        of {tools.length}
                      </span>
                    </p>
                  </SoftPanel>
                  <SoftPanel className="px-5 py-4">
                    <p className="text-xs text-muted-foreground">Ask before running</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                      {gatedCount}
                    </p>
                  </SoftPanel>
                </div>
              ) : null}

              <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                {[
                  { label: "Type", value: agentTypeLabel(agent.type) },
                  { label: "Version", value: agent.version ?? "—" },
                  { label: "Source", value: mine ? "Yours" : "Built in" },
                  { label: "Status", value: agent.isActive ? "Available" : "Unavailable" },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-4 px-5 py-3.5"
                  >
                    <span className="text-sm text-muted-foreground">{row.label}</span>
                    <span className="text-sm font-medium tabular-nums text-foreground">
                      {row.value}
                    </span>
                  </div>
                ))}
              </SoftPanel>

              {mine && onEdit ? (
                <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                  This is your agent — its prompt, model and sub-agents are changed by editing
                  it. Tools and approvals are set here, per your account.
                </p>
              ) : (
                <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                  A built-in agent. Its definition is fixed, but the tools it may use and which
                  of them ask for approval are yours to set, for your account only.
                </p>
              )}
            </div>
          ) : null}

          {section === "approvals" ? (
            configurable ? (
              <div className="space-y-2">
                <ToolList
                  tools={tools}
                  axis="approval"
                  loading={loading && tools.length === 0}
                  togglingKey={togglingKey}
                  onToggle={onToggleApproval}
                  emptyHint="This agent has no tools to gate."
                />
                <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                  A tool set to ask pauses the run every time it is called, so gating one the
                  agent uses constantly will interrupt you a lot. Scheduled runs have nobody to
                  ask and will time out instead.
                </p>
              </div>
            ) : (
              <SoftPanel className="px-6 py-10 text-center">
                <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
                  <ShieldCheck size={18} aria-hidden />
                </span>
                <p className="text-sm font-semibold text-foreground">Nothing to approve</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  {agent.name} is a {agent.type ?? "non-deep"} agent, so it has no per-tool
                  approval model. Any pause it asks for comes from its own graph.
                </p>
              </SoftPanel>
            )
          ) : null}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
