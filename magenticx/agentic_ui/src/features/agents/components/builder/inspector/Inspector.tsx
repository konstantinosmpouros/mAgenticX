import { forwardRef, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bot, ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { ROOT_UID, type PlacedIssue } from "@/features/agents/lib/agentIssues";
import { BUILDER_SECTIONS, type BuilderSection } from "@/features/agents/lib/routes";
import { locate } from "@/features/agents/hooks/useAgentDraft";
import { MAX_SUBAGENT_DEPTH } from "@/features/agents/lib/agentRules";
import { useBuilder } from "../builderContext";
import {
  FilesSection,
  IdentitySection,
  InstructionsSection,
  SkillsSection,
  ToolsSection,
} from "./MainSections";
import { ApprovalsSection } from "./ApprovalsSection";
import { SubagentForm } from "./SubagentForm";

const SECTION_LABELS: Record<BuilderSection, string> = {
  identity: "Identity",
  instructions: "Instructions",
  tools: "Tools",
  skills: "Skills",
  files: "Files",
  approvals: "Approvals",
};

/**
 * The right-hand panel: whatever node is picked on the canvas. The main agent
 * gets its tabs (Identity, Instructions, Tools, Skills, Files, Approvals),
 * each marked when an issue sits in it; a sub-agent gets its one form, under
 * the path of names that leads to it.
 */
export const Inspector = forwardRef<
  HTMLDivElement,
  {
    selectedUid: string;
    section: BuilderSection;
    onSection: (section: BuilderSection) => void;
    issues: PlacedIssue[];
    approvalsFailed: boolean;
    retryingApprovals: boolean;
    onRetryApprovals: () => void;
  }
>(function Inspector(
  { selectedUid, section, onSection, issues, approvalsFailed, retryingApprovals, onRetryApprovals },
  ref,
) {
  const { draft, select, draft: { name } } = useBuilder();
  const reduceMotion = useReducedMotion();
  const at = useMemo(
    () => (selectedUid === ROOT_UID ? null : locate(draft, selectedUid)),
    [draft, selectedUid],
  );
  const isRoot = selectedUid === ROOT_UID || !at;

  const tabs: InspectorTab[] = useMemo(() => {
    const flagged = new Set(
      issues
        .filter((item) => item.target.uid === ROOT_UID && item.severity === "error")
        .map((item) => item.target.section),
    );
    return BUILDER_SECTIONS.map((id) => ({
      id,
      label: SECTION_LABELS[id],
      flagged: flagged.has(id),
      count:
        id === "tools"
          ? draft.tools.length || null
          : id === "skills"
            ? draft.skills.length || null
            : id === "files"
              ? draft.files.length || null
              : null,
    }));
  }, [issues, draft.tools.length, draft.skills.length, draft.files.length]);

  const Glyph = mapIcon(draft.icon || "Bot");
  const trail = at
    ? at.ancestors.map((uid) => {
        if (uid === ROOT_UID) return { uid, label: name.trim() || "Untitled agent" };
        const node = locate(draft, uid)?.node;
        return { uid, label: node?.name.trim() || "Unnamed" };
      })
    : [];
  const motionKey = isRoot ? `root:${section}` : `node:${selectedUid}`;

  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col" aria-label="Inspector" role="region">
      <div className="flex-shrink-0 border-b border-border/50 px-5 pt-4">
        {isRoot ? (
          <div className="flex items-center gap-3 pb-3">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
              <Glyph className="h-[17px] w-[17px]" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/80">Main agent</p>
              <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                {name.trim() || "Untitled agent"}
              </h2>
            </div>
          </div>
        ) : (
          <div className="pb-4">
            <nav aria-label="Where this sub-agent sits" className="mb-2 flex min-w-0 flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground">
              {trail.map((step) => (
                <span key={step.uid} className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => select(step.uid)}
                    className="max-w-[9rem] truncate rounded px-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {step.label}
                  </button>
                  <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-60" aria-hidden />
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/[0.1] text-primary">
                <Bot className="h-[17px] w-[17px]" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Sub-agent · level {at?.depth} of {MAX_SUBAGENT_DEPTH}
                </p>
                <h2
                  className={cn(
                    "truncate font-mono text-[14px] font-semibold text-foreground",
                    !at?.node.name && "font-sans italic text-muted-foreground",
                  )}
                >
                  {at?.node.name || "Unnamed sub-agent"}
                </h2>
              </div>
            </div>
          </div>
        )}
        {isRoot ? <InspectorTabs tabs={tabs} active={section} onSelect={onSection} /> : null}
      </div>
      <div data-inspector-body className="scrollbar-muted min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={motionKey}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {!isRoot && at ? (
              <SubagentForm uid={selectedUid} />
            ) : section === "identity" ? (
              <IdentitySection />
            ) : section === "instructions" ? (
              <InstructionsSection />
            ) : section === "tools" ? (
              <ToolsSection />
            ) : section === "skills" ? (
              <SkillsSection />
            ) : section === "files" ? (
              <FilesSection />
            ) : (
              <ApprovalsSection
                saveFailed={approvalsFailed}
                retrying={retryingApprovals}
                onRetry={onRetryApprovals}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
});

type InspectorTab = { id: BuilderSection; label: string; flagged: boolean; count: number | null };

/**
 * The main agent's six tabs as a 3 × 2 segmented control: every tab in view
 * at the inspector's width, none scrolled off. A tab holding an error carries
 * a dot; Tools, Skills and Files their counts. The active one slides.
 */
function InspectorTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: InspectorTab[];
  active: BuilderSection;
  onSelect: (id: BuilderSection) => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <nav aria-label="Main agent sections" className="mb-3.5 grid grid-cols-3 gap-0.5 rounded-xl bg-muted/45 p-0.5">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "relative flex items-center justify-center gap-1.5 rounded-[0.6rem] px-2 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {selected ? (
              <motion.span
                layoutId="agent-inspector-tab"
                className="absolute inset-0 rounded-[0.6rem] bg-background shadow-[0_1px_3px_hsl(var(--foreground)/0.12)]"
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }}
                aria-hidden
              />
            ) : null}
            <span className="relative">{tab.label}</span>
            {tab.count ? (
              <span className="relative text-[10.5px] tabular-nums text-muted-foreground">{tab.count}</span>
            ) : null}
            {tab.flagged ? (
              <span className="relative h-1.5 w-1.5 rounded-full bg-destructive" aria-label="has issues" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
