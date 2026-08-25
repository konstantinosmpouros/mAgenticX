import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  FilePlus,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn, skillMatchesTokens, tokenizeSkillQuery } from "@/shared/lib/utils";
import { CATALOG_BROWSE_LIMIT, CATALOG_RESULT_LIMIT } from "@/shared/lib/consts";
import type {
  Agent,
  CustomSkillCreatePayload,
  Skill,
  SkillsSubView,
  UserAgentSkillSelection,
  UserSkill,
  UserSkillDetail,
} from "@/shared/lib/types";
import { InfoCard, SkillHubRow, SoftPanel } from "./shared";
import SkillBuilder from "./SkillBuilder";
import SkillFilesViewer from "./SkillFilesViewer";

// Minimum visible spin duration. The bypass-Redis path is fast enough
// (~50-150ms on localhost) that without a floor the spinner can flash for
// a single frame and feel like "nothing happened." 600ms reads as a
// deliberate refresh without dragging.
const MIN_REFRESH_SPIN_MS = 600;

type SkillsTabProps = {
  availableSkills: Skill[];
  mySkills?: UserSkill[];
  loadingMySkills?: boolean;
  mySkillDetails?: Record<string, UserSkillDetail>;
  isMySkillDetailLoading?: (skillName: string) => boolean;
  onLoadMySkillDetail?: (skillName: string) => Promise<void>;
  onRefreshMySkills?: () => Promise<void>;
  onAddGlobalSkillToPool?: (skillName: string) => Promise<void>;
  onCreateCustomSkill?: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
  onRemoveSkillFromPool?: (skillName: string) => Promise<void>;
  agents?: Agent[];
  skillSelections?: UserAgentSkillSelection;
  onLoadAgentSkills?: (agentId: string) => Promise<void>;
  onToggleUserAgentSkill?: (agentId: string, skillName: string) => Promise<void>;
  isAgentSkillLoading?: (agentId: string) => boolean;
  isSkillToggling?: (agentId: string, skillName: string) => boolean;
};

export default function SkillsTab({
  availableSkills,
  mySkills,
  loadingMySkills = false,
  mySkillDetails,
  isMySkillDetailLoading,
  onLoadMySkillDetail,
  onRefreshMySkills,
  onAddGlobalSkillToPool,
  onCreateCustomSkill,
  onRemoveSkillFromPool,
  agents,
  skillSelections,
  onLoadAgentSkills,
  onToggleUserAgentSkill,
  isAgentSkillLoading,
  isSkillToggling,
}: SkillsTabProps) {
  const prefersReducedMotion = useReducedMotion();
  // Sub-view transitions in the Skills tab — slide-in from the side with a
  // touch of fade. Layout-shift duration (300ms) per CLAUDE.md, exit at
  // 65% of enter so dismissals feel responsive, transform+opacity only.
  const skillsViewMotionProps = useMemo(() => {
    if (prefersReducedMotion) {
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.1 },
      };
    }
    return {
      initial: { opacity: 0, x: 16 },
      animate: { opacity: 1, x: 0 },
      exit: { opacity: 0, x: -12 },
      transition: { duration: 0.3, ease: "easeOut" as const },
    };
  }, [prefersReducedMotion]);
  // Per-card entrance for skill lists — staggered fade+rise on enter,
  // faster ease-in fade on exit. Transform+opacity only; stagger is capped
  // so a long list doesn't drip in for seconds.
  const skillCardMotion = useCallback(
    (index: number) => {
      if (prefersReducedMotion) {
        return {
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          exit: { opacity: 0 },
          transition: { duration: 0.1 },
        };
      }
      return {
        initial: { opacity: 0, y: 8 },
        animate: {
          opacity: 1,
          y: 0,
          transition: {
            duration: 0.22,
            ease: "easeOut" as const,
            delay: Math.min(index, 8) * 0.035,
          },
        },
        exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: "easeIn" as const } },
      };
    },
    [prefersReducedMotion],
  );

  // Manage-per-agent UI: which deep-agent cards are expanded. Loading the
  // selection set is deferred to the first expansion so we don't fan out
  // N concurrent GETs on Skills-tab open.
  const [expandedAgentSkills, setExpandedAgentSkills] = useState<Record<string, boolean>>({});

  const [skillsView, setSkillsView] = useState<SkillsSubView>("hub");
  // Two independent, clearly-scoped queries: ``registrySearch`` filters the
  // user's own pool; ``catalogSearch`` drives the "add from catalog" search.
  // Splitting them is the fix for the old single-box layout that merged the
  // pool and catalog results into one confusing list.
  const [registrySearch, setRegistrySearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  // Per-skill in-flight state for the catalog "+ Add" button so each card
  // can show its own spinner and guard against double-adds.
  const [addingSkills, setAddingSkills] = useState<Record<string, boolean>>({});
  const [mySkillsRefreshing, setMySkillsRefreshing] = useState(false);
  // Optional name to prefill the create-skill builder (e.g. when the user
  // clicks "Create 'x' as a custom skill" from the catalog empty state). The
  // builder owns the rest of its form state internally.
  const [addPrefillName, setAddPrefillName] = useState("");
  // Pool-card expansion (My skills view) — separate from the global-catalog
  // expansion state so the two lists track independently.
  const [expandedPoolSkills, setExpandedPoolSkills] = useState<Record<string, boolean>>({});

  const deepAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.type === "deep agent" && agent.isActive),
    [agents],
  );

  const handleToggleAgentSkillsCard = useCallback(
    (agentId: string) => {
      setExpandedAgentSkills((prev) => {
        const isOpening = !prev[agentId];
        if (isOpening && onLoadAgentSkills) {
          // Fire-and-forget — the hook tracks per-agent loading state and
          // the UI shows a placeholder while the request is in flight.
          void onLoadAgentSkills(agentId);
        }
        return { ...prev, [agentId]: !prev[agentId] };
      });
    },
    [onLoadAgentSkills],
  );

  const handleRefreshMySkills = useCallback(async () => {
    if (!onRefreshMySkills || mySkillsRefreshing) return;
    setMySkillsRefreshing(true);
    const minSpin = new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_SPIN_MS));
    try {
      await Promise.all([onRefreshMySkills(), minSpin]);
    } finally {
      setMySkillsRefreshing(false);
    }
  }, [onRefreshMySkills, mySkillsRefreshing]);

  const openAddView = useCallback((prefillName?: string) => {
    setAddPrefillName(typeof prefillName === "string" ? prefillName : "");
    setSkillsView("create");
  }, []);

  const cancelAddView = useCallback(() => {
    setAddPrefillName("");
    setSkillsView("hub");
  }, []);

  const togglePoolSkill = useCallback(
    (skillName: string) => {
      setExpandedPoolSkills((prev) => {
        const willBeOpen = !prev[skillName];
        if (willBeOpen) {
          void onLoadMySkillDetail?.(skillName);
        }
        return { ...prev, [skillName]: !prev[skillName] };
      });
    },
    [onLoadMySkillDetail],
  );

  const handleAddFromCatalog = useCallback(
    async (skillName: string) => {
      if (!onAddGlobalSkillToPool || addingSkills[skillName]) return;
      setAddingSkills((prev) => ({ ...prev, [skillName]: true }));
      try {
        await onAddGlobalSkillToPool(skillName);
      } finally {
        setAddingSkills((prev) => {
          const next = { ...prev };
          delete next[skillName];
          return next;
        });
      }
    },
    [onAddGlobalSkillToPool, addingSkills],
  );

  // Registry filter — narrows the user's own pool. Cheap, runs on every
  // keystroke (the pool is small).
  const registryTokens = useMemo(() => tokenizeSkillQuery(registrySearch), [registrySearch]);
  const filteredRegistry = useMemo(() => {
    const pool = mySkills ?? [];
    if (registryTokens.length === 0) return pool;
    return pool.filter((s) => skillMatchesTokens(s, registryTokens));
  }, [mySkills, registryTokens]);

  // Catalog search is deferred so scoring the (potentially large) global
  // catalog never blocks typing.
  const deferredCatalogSearch = useDeferredValue(catalogSearch);
  const catalogTokens = useMemo(
    () => tokenizeSkillQuery(deferredCatalogSearch),
    [deferredCatalogSearch],
  );
  const hasCatalogQuery = catalogTokens.length > 0;

  const myPoolNames = useMemo(() => new Set((mySkills ?? []).map((s) => s.name)), [mySkills]);
  const catalogPool = useMemo(
    () => availableSkills.filter((s) => !myPoolNames.has(s.name)),
    [availableSkills, myPoolNames],
  );

  const catalogMatches = useMemo(() => {
    if (!hasCatalogQuery) return [];
    return catalogPool
      .filter((s) => skillMatchesTokens(s, catalogTokens))
      .map((s) => {
        const name = s.name.toLowerCase().replace(/[-_./]/g, "");
        const category = s.category.toLowerCase().replace(/[-_./]/g, "");
        let score = 0;
        for (const tok of catalogTokens) {
          if (name === tok) score += 1000;
          else if (name.startsWith(tok)) score += 500;
          else if (name.includes(tok)) score += 100;
          if (category.includes(tok)) score += 20;
        }
        return { s, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }, [catalogPool, catalogTokens, hasCatalogQuery]);

  // With a query → ranked matches; without → an alphabetical browse slice so
  // the "Add from catalog" section is a useful starting point, never blank.
  const catalogResults = useMemo(() => {
    if (!hasCatalogQuery) {
      return [...catalogPool]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, CATALOG_BROWSE_LIMIT);
    }
    return catalogMatches.slice(0, CATALOG_RESULT_LIMIT);
  }, [hasCatalogQuery, catalogPool, catalogMatches]);

  const catalogTruncated = hasCatalogQuery
    ? Math.max(0, catalogMatches.length - catalogResults.length)
    : Math.max(0, catalogPool.length - catalogResults.length);

  return (
    <div className="space-y-6 animate-fade-in">
      <AnimatePresence mode="wait" initial={false}>
        {skillsView === "hub" ? (
          <motion.div key="skills-hub" className="space-y-3" {...skillsViewMotionProps}>
            <SkillHubRow
              index={0}
              reduceMotion={Boolean(prefersReducedMotion)}
              icon={<Library className="h-5 w-5" aria-hidden />}
              title="Global registry"
              subtitle="Browse the shared catalog"
              meta={`${availableSkills.length} skills`}
              actionLabel="Manage"
              onClick={() => setSkillsView("global")}
            />
            <SkillHubRow
              index={1}
              reduceMotion={Boolean(prefersReducedMotion)}
              icon={<Sparkles className="h-5 w-5" aria-hidden />}
              title="My skills"
              subtitle="Your added + custom skills"
              meta={`${mySkills?.length ?? 0} in pool`}
              actionLabel="Manage"
              onClick={() => setSkillsView("mine")}
            />
            <SkillHubRow
              index={2}
              reduceMotion={Boolean(prefersReducedMotion)}
              icon={<Bot className="h-5 w-5" aria-hidden />}
              title="Agent skills"
              subtitle="Assign skills to deep agents"
              meta={`${deepAgents.length} agent${deepAgents.length === 1 ? "" : "s"}`}
              actionLabel="Manage"
              onClick={() => setSkillsView("agents")}
            />
            <SkillHubRow
              index={3}
              reduceMotion={Boolean(prefersReducedMotion)}
              icon={<FilePlus className="h-5 w-5" aria-hidden />}
              title="Create a skill"
              subtitle="SKILL.md + scripts & assets"
              meta="multi-file"
              actionLabel="Create"
              onClick={() => openAddView()}
            />
            <p className="flex items-center gap-2 px-1 pt-2 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
              Reusable playbooks your deep agents load when relevant — add or author them here, then
              assign per agent.
            </p>
          </motion.div>
        ) : null}

        {skillsView === "mine" ? (
          <motion.div key="skills-mine" className="space-y-6" {...skillsViewMotionProps}>
            <InfoCard
              eyebrow="My pool"
              title="Your skills"
              headerAction={
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSkillsView("hub")}
                    className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                    Back
                  </Button>
                  {onRefreshMySkills ? (
                    <Tooltip delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void handleRefreshMySkills()}
                          disabled={mySkillsRefreshing}
                          aria-label="Refresh my skills"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-[hsl(var(--hover-surface))] focus:bg-[hsl(var(--hover-surface-strong))] focus:outline-none focus:ring-0 focus-visible:ring-0 transition-colors disabled:opacity-100"
                        >
                          <RefreshCw
                            size={16}
                            className={cn(mySkillsRefreshing && "animate-spin")}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {mySkillsRefreshing ? "Refreshing…" : "Refresh"}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              }
            >
              <div className="flex flex-col gap-3">
                {(mySkills?.length ?? 0) > 6 ? (
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={registrySearch}
                      onChange={(e) => setRegistrySearch(e.target.value)}
                      placeholder="Filter your skills…"
                      aria-label="Filter your skills"
                      className="w-full rounded-md border border-border/60 bg-background/60 py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                ) : null}

                {loadingMySkills && (mySkills?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">Loading your skills…</p>
                ) : null}

                {!loadingMySkills && (mySkills?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing here yet — add from the Global registry, or Create a skill.
                  </p>
                ) : null}

                <AnimatePresence initial={false}>
                  {filteredRegistry.map((skill, index) => {
                    const isExpanded = Boolean(expandedPoolSkills[skill.name]);
                    const detail = mySkillDetails?.[skill.name];
                    const loadingDetail = isMySkillDetailLoading?.(skill.name) ?? false;
                    return (
                      <motion.div key={skill.name} {...skillCardMotion(index)}>
                        <SoftPanel className="p-4">
                          <button
                            type="button"
                            onClick={() => togglePoolSkill(skill.name)}
                            className="flex w-full items-start justify-between gap-3 text-left"
                            aria-expanded={isExpanded}
                          >
                            <div className="flex flex-col gap-1 min-w-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <p className="truncate text-sm font-semibold text-foreground">
                                  {skill.name}
                                </p>
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                                    skill.type === "custom"
                                      ? "bg-primary/15 text-primary"
                                      : "bg-muted text-muted-foreground",
                                  )}
                                >
                                  {skill.type}
                                </span>
                                {skill.category ? (
                                  <span className="inline-flex shrink-0 items-center rounded-md border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {skill.category}
                                  </span>
                                ) : null}
                              </div>
                              <p className="text-xs text-muted-foreground line-clamp-2">
                                {skill.description || "No description provided."}
                              </p>
                            </div>
                            <div className="flex items-center gap-1">
                              {onRemoveSkillFromPool ? (
                                <Tooltip delayDuration={200}>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      aria-label={`Remove ${skill.name} from your pool`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void onRemoveSkillFromPool(skill.name);
                                      }}
                                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="left">Remove from my pool</TooltipContent>
                                </Tooltip>
                              ) : null}
                              <ChevronDown
                                className={cn(
                                  "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                                  isExpanded && "rotate-180",
                                )}
                              />
                            </div>
                          </button>
                          {isExpanded ? (
                            <div className="mt-3">
                              {loadingDetail && !detail ? (
                                <p className="text-xs text-muted-foreground">Loading content…</p>
                              ) : detail ? (
                                <SkillFilesViewer
                                  files={detail.files ?? []}
                                  fallbackContent={detail.content}
                                  prefersReducedMotion={prefersReducedMotion}
                                />
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  Could not load content.
                                </p>
                              )}
                            </div>
                          ) : null}
                        </SoftPanel>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>

                {registryTokens.length > 0 && filteredRegistry.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No skills in your pool match “{registrySearch.trim()}”.
                  </p>
                ) : null}
              </div>
            </InfoCard>
          </motion.div>
        ) : null}

        {skillsView === "global" ? (
          <motion.div key="skills-global" {...skillsViewMotionProps}>
            <InfoCard
              eyebrow="Catalog"
              title="Add from catalog"
              headerAction={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSkillsView("hub")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
              }
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder="Search skills to add…"
                      aria-label="Search the skills catalog"
                      className="w-full rounded-md border border-border/60 bg-background/60 py-2 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <AnimatePresence>
                      {catalogSearch ? (
                        <motion.button
                          type="button"
                          onClick={() => setCatalogSearch("")}
                          aria-label="Clear catalog search"
                          initial={
                            prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }
                          }
                          animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                          transition={{ duration: 0.15, ease: "easeOut" }}
                          className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="h-3.5 w-3.5" />
                        </motion.button>
                      ) : null}
                    </AnimatePresence>
                  </div>
                  <span className="shrink-0 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                    {hasCatalogQuery
                      ? `${catalogResults.length}${catalogTruncated > 0 ? "+" : ""} result${catalogResults.length === 1 ? "" : "s"}`
                      : `${catalogPool.length} available`}
                  </span>
                </div>

                {catalogPool.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    You've added every catalog skill to your pool.
                  </p>
                ) : hasCatalogQuery && catalogResults.length === 0 ? (
                  <div className="flex flex-col items-start gap-2 rounded-[1.1rem] bg-muted/30 px-4 py-4">
                    <p className="text-sm text-muted-foreground">
                      No catalog skills match “{deferredCatalogSearch.trim()}”.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openAddView(deferredCatalogSearch.trim())}
                      className="h-8 gap-1.5 px-3 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                      Create “{deferredCatalogSearch.trim()}” as a custom skill
                    </Button>
                  </div>
                ) : (
                  <>
                    <AnimatePresence initial={false}>
                      {catalogResults.map((skill, index) => {
                        const adding = Boolean(addingSkills[skill.name]);
                        return (
                          <motion.div
                            key={`${skill.category}/${skill.name}`}
                            {...skillCardMotion(index)}
                          >
                            <SoftPanel className="p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <p className="truncate text-sm font-medium text-foreground">
                                      {skill.name}
                                    </p>
                                    {skill.category ? (
                                      <span className="inline-flex shrink-0 items-center rounded-md border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        {skill.category}
                                      </span>
                                    ) : null}
                                  </div>
                                  <p className="line-clamp-2 text-xs text-muted-foreground">
                                    {skill.description || "No description provided."}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleAddFromCatalog(skill.name)}
                                  disabled={!onAddGlobalSkillToPool || adding}
                                  className="h-7 shrink-0 gap-1 px-2.5 text-xs"
                                >
                                  {adding ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                  ) : (
                                    <Plus className="h-3.5 w-3.5" aria-hidden />
                                  )}
                                  {adding ? "Adding…" : "Add"}
                                </Button>
                              </div>
                            </SoftPanel>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                    {catalogTruncated > 0 ? (
                      <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                        {hasCatalogQuery
                          ? `+${catalogTruncated} more match${catalogTruncated === 1 ? "" : "es"}. Refine your search to narrow down.`
                          : `+${catalogTruncated} more in the catalog. Search to find a specific skill.`}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </InfoCard>
          </motion.div>
        ) : null}

        {skillsView === "create" ? (
          <motion.div key="skills-create" {...skillsViewMotionProps}>
            <InfoCard
              eyebrow="Create"
              title="New custom skill"
              description="Author a private skill — a SKILL.md playbook plus any scripts or reference files. Assign it from Agent skills once it's saved."
              headerAction={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={cancelAddView}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
              }
            >
              <SkillBuilder
                mySkills={mySkills ?? []}
                availableSkills={availableSkills}
                initialName={addPrefillName}
                onCreate={onCreateCustomSkill ?? (async () => null)}
                onClose={cancelAddView}
                prefersReducedMotion={prefersReducedMotion}
              />
            </InfoCard>
          </motion.div>
        ) : null}

        {skillsView === "agents" ? (
          <motion.div key="skills-agents" {...skillsViewMotionProps}>
            <InfoCard
              eyebrow="Agents"
              title="Agent skills"
              description="Assign skills from your pool to specific deep agents. Toggles take effect on the next conversation."
              headerAction={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSkillsView("hub")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back
                </Button>
              }
            >
              <div className="flex flex-col gap-3">
                {(mySkills?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Your pool is empty. Go back and add some skills first.
                  </p>
                ) : null}
                {(mySkills?.length ?? 0) > 0 && deepAgents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active deep agents to manage.</p>
                ) : null}
                {(mySkills?.length ?? 0) > 0 &&
                  deepAgents.map((agent) => {
                    const isExpanded = Boolean(expandedAgentSkills[agent.id]);
                    const enabledSet = new Set(skillSelections?.[agent.id] ?? []);
                    const loading = isAgentSkillLoading?.(agent.id) ?? false;
                    const AgentIcon = agent.icon;
                    return (
                      <SoftPanel key={agent.id} className="p-4">
                        <button
                          type="button"
                          onClick={() => handleToggleAgentSkillsCard(agent.id)}
                          className="flex w-full items-start justify-between gap-3 text-left"
                          aria-expanded={isExpanded}
                        >
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                              <AgentIcon className="h-4 w-4" aria-hidden />
                            </span>
                            <div className="flex flex-col gap-1">
                              <p className="text-sm font-semibold text-foreground">{agent.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {enabledSet.size === 0
                                  ? "No skills enabled."
                                  : `${enabledSet.size} skill${enabledSet.size === 1 ? "" : "s"} enabled.`}
                              </p>
                            </div>
                          </div>
                          <ChevronDown
                            className={cn(
                              "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </button>
                        {isExpanded ? (
                          <div className="mt-4 space-y-2">
                            {loading && enabledSet.size === 0 ? (
                              <p className="text-xs text-muted-foreground">Loading…</p>
                            ) : null}
                            {(mySkills ?? []).map((skill) => {
                              const enabled = enabledSet.has(skill.name);
                              const toggling = isSkillToggling?.(agent.id, skill.name) ?? false;
                              return (
                                <div
                                  key={skill.name}
                                  className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                                >
                                  <div className="flex flex-col gap-0.5 min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <p className="truncate text-sm font-medium text-foreground">
                                        {skill.name}
                                      </p>
                                      <span
                                        className={cn(
                                          "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                                          skill.type === "custom"
                                            ? "bg-primary/15 text-primary"
                                            : "bg-muted text-muted-foreground",
                                        )}
                                      >
                                        {skill.type}
                                      </span>
                                      {skill.category ? (
                                        <span className="shrink-0 rounded-md border border-border/40 bg-background/50 px-1 py-0.5 text-[9px] text-muted-foreground">
                                          {skill.category}
                                        </span>
                                      ) : null}
                                    </div>
                                    <p className="line-clamp-2 text-[0.72rem] text-muted-foreground">
                                      {skill.description || "No description provided."}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={enabled}
                                    aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name} for ${agent.name}`}
                                    disabled={toggling || !onToggleUserAgentSkill}
                                    onClick={() => onToggleUserAgentSkill?.(agent.id, skill.name)}
                                    className={cn(
                                      "relative mt-1 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                                      "disabled:cursor-wait disabled:opacity-70",
                                      enabled ? "bg-primary" : "bg-muted",
                                    )}
                                  >
                                    <span
                                      aria-hidden
                                      className={cn(
                                        "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
                                        enabled ? "translate-x-4" : "translate-x-0.5",
                                      )}
                                    />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </SoftPanel>
                    );
                  })}
              </div>
            </InfoCard>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
