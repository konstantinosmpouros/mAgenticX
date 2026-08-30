import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Lock, Minus, Pencil, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { Agent, AgentToolRow } from "@/shared/lib/types";
import { ALWAYS_GATED } from "@/features/settings/lib/agentTools";
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
 * Sections that need backend work before they can be honest — Approvals over
 * MCP tools especially — render an explicit note instead of a control that
 * silently does nothing.
 */

type DetailSection = "overview" | "tools" | "approvals";

export function AgentDetail({
  agent,
  mine,
  configurable,
  tools,
  loading,
  error,
  togglingKey,
  onToggleTool,
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
  onEdit?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [section, setSection] = useState<DetailSection>("tools");

  const enabledCount = useMemo(() => tools.filter((t) => !t.disabled).length, [tools]);

  const tabs: SectionTab<DetailSection>[] = [
    { id: "overview", label: "Overview" },
    { id: "tools", label: "Tools", count: enabledCount },
    { id: "approvals", label: "Approvals" },
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
              gatedNames={ALWAYS_GATED}
              emptyHint="Connect an MCP server, or give this agent tools when you edit it."
            />
          ) : null}

          {section === "overview" ? (
            <SoftPanel className="divide-y divide-border/40 overflow-hidden">
              {[
                { label: "Type", value: agent.type ?? "—" },
                { label: "Version", value: agent.version ?? "—" },
                { label: "Tools on", value: `${enabledCount} of ${tools.length}` },
                { label: "Source", value: mine ? "Custom agent" : "Platform agent" },
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
          ) : null}

          {section === "approvals" ? (
            <div className="space-y-3">
              <SoftPanel className="divide-y divide-border/30 overflow-hidden">
                {[...ALWAYS_GATED].map((name) => (
                  <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                    <span
                      className={cn(
                        "flex-1 text-sm font-medium",
                        configurable ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {name}
                    </span>
                    {configurable ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Lock size={11} aria-hidden /> Always
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <Minus size={11} aria-hidden /> Not available
                      </span>
                    )}
                  </div>
                ))}
              </SoftPanel>
              <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                {configurable ? (
                  <>
                    These five always ask before running, on every agent, and cannot be turned off.
                    Choosing which of an agent&rsquo;s other tools need approval is set when you
                    edit it.
                  </>
                ) : (
                  <>
                    These are deep-agent tools, so {agent.name} does not have them and there is
                    nothing to approve. Any pause it asks for comes from its own graph, not from a
                    per-tool rule.
                  </>
                )}
              </p>
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
