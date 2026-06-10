import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import { useTheme } from "next-themes";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
    AppWindow,
    Archive,
    ArrowLeft,
    Ban,
    Bot,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    ExternalLink,
    FilePlus,
    HelpCircle,
    Keyboard,
    Library,
    Link2,
    LogOut,
    Loader2,
    MoonStar,
    Palette,
    Plus,
    RefreshCw,
    Search,
    ShieldCheck,
    Sparkles,
    User,
    X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    VoiceSelector,
    VoiceSelectorAttributes,
    VoiceSelectorContent,
    VoiceSelectorDescription,
    VoiceSelectorEmpty,
    VoiceSelectorGroup,
    VoiceSelectorInput,
    VoiceSelectorItem,
    VoiceSelectorList,
    VoiceSelectorName,
    VoiceSelectorPreview,
    VoiceSelectorTrigger,
} from "@/components/ui/ai-elements/voice-selector";
import { cn, normalizeRealtimeVoice, normalizeVoiceModeLanguage } from "@/lib/utils";
import {
    REALTIME_VOICES,
    VOICE_MODE_LANGUAGES,
    type RealtimeVoice,
    type VoiceModeLanguage,
} from "@/lib/consts";
import { Agent, ConversationShareListItem, ConversationSummary, CustomSkillCreatePayload, Skill, ToolMetadata, UserAgentSkillSelection, UserPreferences, UserProfile, UserSkill, UserSkillDetail } from "@/lib/types";
import SkillBuilder from "@/components/chat/SkillBuilder";
import SkillFilesViewer from "@/components/chat/SkillFilesViewer";
import { generateReadAloudPreviewAudio } from "@/lib/api";
import {
    SHORTCUTS,
    detectShortcutPlatform,
    getShortcutLabel,
    type ShortcutCategory,
    type ShortcutPlatform,
} from "@/lib/shortcuts";

type ProfilePanelProps = {
    open: boolean;
    onClose: () => void;
    activeTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
    user: UserProfile | null;
    availableTools: (ToolMetadata & { enabled?: boolean })[];
    // Global catalog — admin-curated, read-only at runtime. Surface searched
    // from the My skills view via the "+ Add" path when the user wants to
    // pull a global into their personal pool.
    availableSkills: Skill[];
    onRefreshSkills?: () => Promise<void>;
    // User pool ("My skills"): the user's personal registry. Mixed globals
    // (references) + customs (user-authored). Mutation handlers below.
    mySkills?: UserSkill[];
    loadingMySkills?: boolean;
    mySkillDetails?: Record<string, UserSkillDetail>;
    isMySkillDetailLoading?: (skillName: string) => boolean;
    onLoadMySkillDetail?: (skillName: string) => Promise<void>;
    onRefreshMySkills?: () => Promise<void>;
    onAddGlobalSkillToPool?: (skillName: string) => Promise<void>;
    onCreateCustomSkill?: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
    onRemoveSkillFromPool?: (skillName: string) => Promise<void>;
    // Manage-per-agent skill selection. The Skills tab "Manage" sub-view
    // renders one card per deep agent; ``skillSelections`` is the per-agent
    // enabled set keyed by ``agentId``. The hook lazy-loads selection when
    // the user expands an agent card via ``onLoadAgentSkills``.
    agents?: Agent[];
    skillSelections?: UserAgentSkillSelection;
    onLoadAgentSkills?: (agentId: string) => Promise<void>;
    onToggleUserAgentSkill?: (agentId: string, skillName: string) => Promise<void>;
    isAgentSkillLoading?: (agentId: string) => boolean;
    isSkillToggling?: (agentId: string, skillName: string) => boolean;
    userPreferences: UserPreferences;
    archivedConversations: ConversationSummary[];
    archivedConversationsLoading?: boolean;
    archivedConversationsHasMore?: boolean;
    onLoadMoreArchivedConversations?: () => void;
    onSelectArchivedConversation?: (conversation: ConversationSummary) => void;
    onUnarchiveConversation?: (conversation: ConversationSummary) => void;
    sharedConversations?: ConversationShareListItem[];
    sharedConversationsLoading?: boolean;
    sharedConversationsHasMore?: boolean;
    onLoadMoreSharedConversations?: () => void;
    onSelectSharedConversation?: (share: ConversationShareListItem) => void;
    onRevokeSharedConversation?: (share: ConversationShareListItem) => void;
    onToggleToolPreference?: (tool: ToolMetadata) => void;
    onToggleSuggestionsEnabled?: () => void;
    onSelectVoiceModeVoice?: (voice: RealtimeVoice) => void;
    onSelectVoiceModeLanguage?: (language: VoiceModeLanguage) => void;
    preferencesSaving?: boolean;
};

type ToolWithStatus = ToolMetadata & { enabled?: boolean };
type HelpCard = {
    title: string;
    desc: string;
    href?: string;
    external?: boolean;
};
type InfoRow = {
    label: string;
    value: string;
    hint?: string;
};

const MCP_ICON_SRCS = {
    grey: "/mcp-server-stroke-rounded (3).png",
    darkGrey: "/mcp-server-stroke-rounded (4).png",
    white: "/mcp-server-Stroke-Rounded (2).png",
    magenta: "/mcp-server-Stroke-Rounded (1).png",
    black: "/mcp-server-Stroke-Rounded.png",
} as const;

type McpIconVariant = keyof typeof MCP_ICON_SRCS;

const MCP_VARIANTS = {
    idleLight: "grey" as const,
    idleDark: "darkGrey" as const,
    hoverLight: "black" as const,
    hoverDark: "white" as const,
    active: "magenta" as const,
};

const MOBILE_PROFILE_NAV_BREAKPOINT = 640;

const McpIcon = ({
    size = 22,
    className,
    variant = "grey",
}: {
    size?: number;
    className?: string;
    variant?: McpIconVariant;
}) => (
    <img
        src={MCP_ICON_SRCS[variant]}
        alt="MCP servers"
        width={size}
        height={size}
        className={cn("object-contain", className)}
        draggable={false}
    />
);

const VoiceGenderIcon = ({
    gender,
    className,
}: {
    gender: "female" | "male";
    className?: string;
}) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        {gender === "female" ? (
            <>
                <circle cx="12" cy="8" r="4.5" />
                <path d="M12 12.5v8" />
                <path d="M8.5 17h7" />
            </>
        ) : (
            <>
                <circle cx="9" cy="15" r="4.5" />
                <path d="M12.25 11.75 19 5" />
                <path d="M15 5h4v4" />
            </>
        )}
    </svg>
);

const NA = "N/A";

const safeText = (value?: string | null) =>
    value && String(value).trim().length > 0 ? String(value).trim() : NA;

const fmtDateTime = (value?: Date | string | null) => {
    if (!value) return NA;
    const date = typeof value === "string" ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? NA : date.toLocaleString();
};

const fmtDate = (value?: Date | string | null) => {
    if (!value) return NA;
    const date = typeof value === "string" ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? NA : date.toLocaleDateString();
};

const fmtBoolean = (value?: boolean) => {
    if (typeof value !== "boolean") return NA;
    return value ? "Enabled" : "Disabled";
};

// Skill search is intentionally simple: tokenize on whitespace, normalize away
// separators (-, _, ., /) so "gws admin" matches "gws-admin-reports", and
// require every token to appear somewhere in name/description/category.
const tokenizeSkillQuery = (query: string): string[] =>
    query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .map((tok) => tok.replace(/[-_./]/g, ""))
        .filter(Boolean);

const skillMatchesTokens = (
    s: { name: string; description: string; category: string },
    tokens: string[],
): boolean => {
    if (tokens.length === 0) return true;
    const haystack = `${s.name} ${s.description} ${s.category}`
        .toLowerCase()
        .replace(/[-_./]/g, "");
    return tokens.every((tok) => haystack.includes(tok));
};

const CATALOG_RESULT_LIMIT = 10;
const CATALOG_BROWSE_LIMIT = 6;

const InfoCard = ({
    eyebrow,
    title,
    description,
    children,
    className,
    headerAction,
}: {
    eyebrow?: string;
    title: string;
    description?: string;
    children: ReactNode;
    className?: string;
    // Optional element rendered to the right of the title row — currently
    // used by the Skills tab to slot a "force refresh / bypass Redis" button.
    headerAction?: ReactNode;
}) => (
    <section className={cn("space-y-4", className)}>
        <div className="space-y-1.5">
            {eyebrow ? (
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {eyebrow}
                </p>
            ) : null}
            <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-foreground">{title}</h3>
                {headerAction}
            </div>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="mt-5">{children}</div>
    </section>
);

const SoftPanel = ({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) => (
    <div className={cn("rounded-[1.4rem] bg-muted/30", className)}>
        {children}
    </div>
);

const InfoRowsCard = ({
    eyebrow,
    title,
    description,
    rows,
}: {
    eyebrow?: string;
    title: string;
    description?: string;
    rows: InfoRow[];
}) => (
    <InfoCard eyebrow={eyebrow} title={title} description={description}>
        <SoftPanel className="max-w-full divide-y divide-border/40 overflow-hidden">
            {rows.map((row) => (
                <div
                    key={row.label}
                    className="grid min-w-0 gap-2 px-5 py-4 max-[420px]:px-4 md:grid-cols-[minmax(0,10rem),1fr]"
                >
                    <div className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {row.label}
                    </div>
                    <div className="min-w-0">
                        <p
                            className={cn(
                                "break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]",
                                row.value === NA && "text-muted-foreground"
                            )}
                        >
                            {row.value}
                        </p>
                        {row.hint ? (
                            <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p>
                        ) : null}
                    </div>
                </div>
            ))}
        </SoftPanel>
    </InfoCard>
);

const MetricCard = ({
    label,
    value,
    hint,
}: {
    label: string;
    value: string;
    hint: string;
}) => (
    <SoftPanel className="px-4 py-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {label}
        </p>
        <p className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </SoftPanel>
);

// One row on the Skills hub — icon, title, subtitle, a count chip, and a
// trailing action button. The whole row is the button; the trailing element
// reads as "Manage"/"Create" and carries a chevron for affordance.
const SkillHubRow = ({
    icon,
    title,
    subtitle,
    meta,
    actionLabel,
    onClick,
    index,
    reduceMotion,
}: {
    icon: ReactNode;
    title: string;
    subtitle: string;
    meta?: string;
    actionLabel: string;
    onClick: () => void;
    index: number;
    reduceMotion: boolean;
}) => (
    <motion.button
        type="button"
        onClick={onClick}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut", delay: index * 0.05 }}
        whileTap={reduceMotion ? undefined : { scale: 0.99 }}
        className="group flex w-full items-center gap-4 rounded-[1.4rem] bg-muted/30 px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background/60 text-primary">
            {icon}
        </span>
        <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-foreground">{title}</p>
                {meta ? (
                    <span className="shrink-0 rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {meta}
                    </span>
                ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors group-hover:bg-background">
            {actionLabel}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </span>
    </motion.button>
);

export default function ProfilePanel({
    open,
    onClose,
    activeTab,
    setActiveTab,
    onLogout,
    user,
    availableTools,
    availableSkills,
    onRefreshSkills,
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
    userPreferences,
    archivedConversations,
    archivedConversationsLoading = false,
    archivedConversationsHasMore = false,
    onLoadMoreArchivedConversations,
    onSelectArchivedConversation,
    onUnarchiveConversation,
    sharedConversations = [],
    sharedConversationsLoading = false,
    sharedConversationsHasMore = false,
    onLoadMoreSharedConversations,
    onSelectSharedConversation,
    onRevokeSharedConversation,
    onToggleToolPreference,
    onToggleSuggestionsEnabled,
    onSelectVoiceModeVoice,
    onSelectVoiceModeLanguage,
    preferencesSaving = false,
}: ProfilePanelProps) {
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
                    transition: { duration: 0.22, ease: "easeOut" as const, delay: Math.min(index, 8) * 0.035 },
                },
                exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: "easeIn" as const } },
            };
        },
        [prefersReducedMotion],
    );
    const [hoveredNavId, setHoveredNavId] = useState<string | null>(null);
    const [openNavTooltipId, setOpenNavTooltipId] = useState<string | null>(null);
    const navTooltipClickSuppressedUntilRef = useRef(0);
    const [serverCollapsed, setServerCollapsed] = useState<Record<string, boolean>>({});
    const [navCollapsed, setNavCollapsed] = useState<boolean>(() =>
        typeof window !== "undefined" ? window.innerWidth < 960 : false
    );
    const [mobileProfileNav, setMobileProfileNav] = useState<boolean>(() =>
        typeof window !== "undefined" ? window.innerWidth < MOBILE_PROFILE_NAV_BREAKPOINT : false
    );
    const [copiedShareId, setCopiedShareId] = useState<string | null>(null);
    const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
    const [shortcutPlatform, setShortcutPlatform] = useState<ShortcutPlatform>(() => detectShortcutPlatform());
    const [voiceSelectorOpen, setVoiceSelectorOpen] = useState(false);
    const [previewLoadingVoice, setPreviewLoadingVoice] = useState<RealtimeVoice | null>(null);
    const [previewPlayingVoice, setPreviewPlayingVoice] = useState<RealtimeVoice | null>(null);
    // Manage-per-agent UI: which deep-agent cards are expanded. Loading the
    // selection set is deferred to the first expansion so we don't fan out
    // N concurrent GETs on Skills-tab open.
    const [expandedAgentSkills, setExpandedAgentSkills] = useState<Record<string, boolean>>({});

    // Skills tab sub-view. The tab opens on the hub (a row per area); each row
    // navigates into a dedicated view, and a Back control returns to the hub.
    type SkillsSubView = "hub" | "global" | "mine" | "agents" | "create";
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
        [agents]
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
        [onLoadAgentSkills]
    );

    // Minimum visible spin duration. The bypass-Redis path is fast enough
    // (~50-150ms on localhost) that without a floor the spinner can flash for
    // a single frame and feel like "nothing happened." 600ms reads as a
    // deliberate refresh without dragging.
    const MIN_REFRESH_SPIN_MS = 600;

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
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const previewAudioUrlRef = useRef<string | null>(null);
    const { theme, setTheme } = useTheme();

    const currentTheme = theme === "dark" ? "dark" : "light";

    const toolKey = (tool: ToolWithStatus) => {
        const prefix = tool.serverId && tool.serverId.length > 0 ? tool.serverId : "default";
        return `${prefix}::${tool.toolName}`;
    };

    const preferencesDisabledKeys = useMemo(() => {
        const entries = userPreferences?.tools?.disabled ?? [];
        const keys = entries.map((item) => {
            const name = (item as { toolName?: string; tool_name?: string }).toolName
                ?? (item as { toolName?: string; tool_name?: string }).tool_name
                ?? "";
            const serverPrefix = item.serverId && item.serverId.length > 0 ? item.serverId : "default";
            return `${serverPrefix}::${name}`;
        });
        return new Set(keys);
    }, [userPreferences]);

    const serverGroups = useMemo(
        () =>
            Object.entries(
                availableTools.reduce<Record<string, ToolWithStatus[]>>((acc, tool) => {
                    const serverKey = tool.serverId || "default";
                    if (!acc[serverKey]) acc[serverKey] = [];
                    acc[serverKey].push(tool);
                    return acc;
                }, {})
            ),
        [availableTools]
    );

    const enabledToolsCount = useMemo(
        () =>
            availableTools.filter((tool) =>
                typeof tool.enabled === "boolean" ? tool.enabled : !preferencesDisabledKeys.has(toolKey(tool))
            ).length,
        [availableTools, preferencesDisabledKeys]
    );

    useEffect(() => {
        setServerCollapsed((prev) => {
            const next: Record<string, boolean> = {};
            availableTools.forEach((tool) => {
                const serverKey = tool.serverId || "default";
                if (!(serverKey in next)) {
                    next[serverKey] = serverKey in prev ? prev[serverKey] : true;
                }
            });
            return next;
        });
    }, [availableTools]);

    useEffect(() => {
        const handleResize = () => {
            if (typeof window === "undefined") return;
            setHoveredNavId(null);
            setOpenNavTooltipId(null);
            setNavCollapsed(window.innerWidth < 960);
            setMobileProfileNav(window.innerWidth < MOBILE_PROFILE_NAV_BREAKPOINT);
        };

        handleResize();
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => {
        setHoveredNavId(null);
        setOpenNavTooltipId(null);
    }, [navCollapsed]);

    const prefersAgentic =
        typeof userPreferences?.prefersAgenticChat === "boolean" ? userPreferences.prefersAgenticChat : undefined;
    const displayName =
        safeText(user?.displayName) !== NA
            ? safeText(user?.displayName)
            : safeText(user?.fullName) !== NA
              ? safeText(user?.fullName)
              : safeText(user?.username);
    const displayEmail = safeText(user?.email);
    const displayDepartment = safeText(user?.department);
    const displayRole = safeText(user?.roleTitle);
    const displayIsActive = fmtBoolean(user?.isActive);
    const displayPrefersAgentic = fmtBoolean(prefersAgentic);
    const suggestionsEnabled = userPreferences?.suggestionsEnabled !== false;
    const voiceModeVoice = normalizeRealtimeVoice(userPreferences?.voiceModeVoice);
    const selectedVoiceModeVoice =
        REALTIME_VOICES.find((voice) => voice.id === voiceModeVoice) ?? REALTIME_VOICES[0];
    const voiceModeLanguage = normalizeVoiceModeLanguage(userPreferences?.voiceModeLanguage);
    const avatarInitial = (displayName !== NA ? displayName : "Profile").charAt(0).toUpperCase();

    const clearVoicePreview = useCallback(() => {
        previewAudioRef.current?.pause();
        previewAudioRef.current = null;
        if (previewAudioUrlRef.current) {
            URL.revokeObjectURL(previewAudioUrlRef.current);
            previewAudioUrlRef.current = null;
        }
        setPreviewPlayingVoice(null);
    }, []);

    useEffect(() => () => clearVoicePreview(), [clearVoicePreview]);

    const handlePreviewVoice = async (voice: RealtimeVoice) => {
        if (!user?.id) return;
        if (previewPlayingVoice === voice) {
            clearVoicePreview();
            return;
        }

        clearVoicePreview();
        setPreviewLoadingVoice(voice);

        try {
            const audioBlob = await generateReadAloudPreviewAudio(user.id, voice, "Hey! I am your AI speaker.");
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            previewAudioUrlRef.current = audioUrl;
            previewAudioRef.current = audio;
            audio.onended = clearVoicePreview;
            audio.onerror = clearVoicePreview;
            setPreviewPlayingVoice(voice);
            await audio.play();
        } catch (error) {
            console.error("Failed to preview read-aloud voice:", error);
            clearVoicePreview();
        } finally {
            setPreviewLoadingVoice(null);
        }
    };

    const latestArchivedConversation = useMemo(() => {
        if (archivedConversations.length === 0) return null;

        return archivedConversations.reduce<ConversationSummary | null>((latest, conversation) => {
            const latestStamp = latest
                ? new Date(latest.archivedAt ?? latest.updated_at).getTime()
                : Number.NEGATIVE_INFINITY;
            const currentStamp = new Date(conversation.archivedAt ?? conversation.updated_at).getTime();
            return currentStamp > latestStamp ? conversation : latest;
        }, null);
    }, [archivedConversations]);

    const activeSharedCount = useMemo(
        () => sharedConversations.filter((share) => share.status === "active").length,
        [sharedConversations]
    );

    const navItems = [
        { id: "profile", label: "Account", hint: "Identity and workspace" },
        { id: "appearance", label: "Personalization", hint: "Theme and defaults" },
        { id: "archived", label: "Data Controls", hint: "History and archive" },
        { id: "mcp", label: "MCP Servers", hint: "MCP tools and servers" },
        { id: "skills", label: "Skills", hint: "Available skill library" },
        { id: "shortcuts", label: "Shortcuts", hint: "Keyboard commands" },
        { id: "help", label: "Help", hint: "Docs and support" },
    ] as const;

    const normalizedActiveTab = navItems.some((item) => item.id === activeTab) ? activeTab : "profile";
    const previousActiveTabRef = useRef(normalizedActiveTab);

    useEffect(() => {
        const wasMcpActive = previousActiveTabRef.current === "mcp";
        previousActiveTabRef.current = normalizedActiveTab;

        if (normalizedActiveTab !== "mcp" || wasMcpActive) return;

        setServerCollapsed(() => {
            const next: Record<string, boolean> = {};
            availableTools.forEach((tool) => {
                const serverKey = tool.serverId || "default";
                next[serverKey] = true;
            });
            return next;
        });
    }, [availableTools, normalizedActiveTab]);

    // Reset the Skills tab to its hub whenever the user leaves it (switches
    // nav tab or closes the panel) so re-entering never lands deep in an inner
    // view (global / create / …). Also clears the transient search/prefill state.
    useEffect(() => {
        if (open && normalizedActiveTab === "skills") return;
        setSkillsView("hub");
        setAddPrefillName("");
        setCatalogSearch("");
        setRegistrySearch("");
    }, [open, normalizedActiveTab]);


    const sectionMeta: Record<string, { eyebrow?: string; title: string; description: string }> = {
        profile: {
            title: "Account",
            description: "Review your identity, workspace role, and recent account activity.",
        },
        appearance: {
            title: "Personalization",
            description: "Adjust how the workspace feels and which default experience is visible to you.",
        },
        archived: {
            title: "Data Controls",
            description: "Manage archived conversations and understand how history behaves in the workspace.",
        },
        mcp: {
            title: "MCP Servers",
            description: "Choose which MCP-powered tools stay available inside conversations.",
        },
        skills: {
            title: "Skills",
            description: "Your pool and the shared catalog.",
        },
        shortcuts: {
            title: "Keyboard Shortcuts",
            description: "Browse the same shortcut registry the UI runtime uses.",
        },
        help: {
            title: "Help & Resources",
            description: "Open product documentation and support entry points.",
        },
    };

    const activeSection = sectionMeta[normalizedActiveTab];
    const showActiveSectionEyebrow =
        Boolean(activeSection.eyebrow)
        && activeSection.eyebrow.trim().toLowerCase() !== activeSection.title.trim().toLowerCase();

    const identityRows: InfoRow[] = [
        { label: "Full Name", value: safeText(user?.fullName) },
        { label: "Display Name", value: safeText(user?.displayName) },
        { label: "Username", value: safeText(user?.username) },
        { label: "Email", value: displayEmail },
    ];

    const workspaceRows: InfoRow[] = [
        { label: "Department", value: displayDepartment },
        { label: "Role", value: displayRole },
        { label: "Account Status", value: displayIsActive },
        {
            label: "Agentic Chat",
            value: displayPrefersAgentic,
            hint: "Derived from the stored user preferences profile.",
        },
    ];

    const activityRows: InfoRow[] = [
        { label: "Last Login", value: fmtDateTime(user?.lastLoginAt) },
        { label: "Created", value: fmtDateTime(user?.createdAt) },
        { label: "Updated", value: fmtDateTime(user?.updatedAt) },
        { label: "User ID", value: safeText(user?.id) },
    ];

    const helpCards: HelpCard[] = [
        {
            title: "Architecture Docs",
            desc: "Open the internal architecture page for services, flows, and deployment topology.",
            href: "/architecture",
            external: true,
        },
        {
            title: "Support",
            desc: "Reach the team for operational or product help when something blocks your workflow.",
        },
        {
            title: "Terms & Conditions",
            desc: "Read the terms governing your use of mAgenticX and its services.",
            href: "/terms",
            external: true,
        },
        {
            title: "Privacy Policy",
            desc: "Learn how we collect, use, and protect your personal data.",
            href: "/privacy",
            external: true,
        },
    ];

    const themeOptions = [
        {
            name: "Light",
            value: "light",
            icon: Sparkles,
            previewClassName:
                "bg-[linear-gradient(135deg,hsl(0_0%_100%)_0%,hsl(240_4.8%_95.9%)_52%,hsl(216_50%_92%)_100%)]",
            cardClassName: "border-white/70 bg-white/80",
        },
        {
            name: "Dark",
            value: "dark",
            icon: MoonStar,
            previewClassName:
                "bg-[linear-gradient(135deg,hsl(240_6%_6%)_0%,hsl(240_8%_10%)_55%,hsl(216_100%_8%)_100%)]",
            cardClassName: "border-white/10 bg-black/20",
        },
    ] as const;

    const shortcutSections = (["Workspace", "Chat", "Composer", "Dismiss"] as ShortcutCategory[]).map((category) => ({
        category,
        items: SHORTCUTS.filter((shortcut) => shortcut.category === category),
    }));

    const handleArchivedScroll = (event: UIEvent<HTMLDivElement>) => {
        if (!archivedConversationsHasMore || archivedConversationsLoading) {
            return;
        }

        const node = event.currentTarget;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) {
            onLoadMoreArchivedConversations?.();
        }
    };

    const handleSharedScroll = (event: UIEvent<HTMLDivElement>) => {
        if (!sharedConversationsHasMore || sharedConversationsLoading) {
            return;
        }

        const node = event.currentTarget;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) {
            onLoadMoreSharedConversations?.();
        }
    };

    const handleCopyShareLink = (share: ConversationShareListItem) => {
        const url =
            typeof window !== "undefined"
                ? new URL(share.shareUrl, window.location.origin).toString()
                : share.shareUrl;
        void navigator.clipboard?.writeText(url);
        setCopiedShareId(share.id);
        window.setTimeout(() => setCopiedShareId(null), 1200);
    };

    const sharedActionButtonClass = `
        h-8 w-8 text-muted-foreground
        hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
        active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
        focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none
        focus:ring-0 focus-visible:ring-0 transition-colors
        disabled:pointer-events-none disabled:opacity-45
    `;

    const sharedTooltipClass = "!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md";
    const suppressCollapsedNavTooltip = () => {
        navTooltipClickSuppressedUntilRef.current = Date.now() + 350;
        setOpenNavTooltipId(null);
    };
    const canOpenCollapsedNavTooltip = () => Date.now() > navTooltipClickSuppressedUntilRef.current;
    const dataControlListClass = cn(
        "max-h-[22rem] overflow-y-auto rounded-[1.35rem]",
        "[scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)_/_0.25)_transparent]",
        "[&::-webkit-scrollbar]:w-3 [&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-button]:h-0 [&::-webkit-scrollbar-button]:w-0",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2",
        "[&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[hsl(var(--muted-foreground)/0.25)]",
        "[&::-webkit-scrollbar-thumb:hover]:bg-[hsl(var(--muted-foreground)/0.35)]"
    );

    const handleHelpCardClick = (card: HelpCard) => {
        if (!card.href) return;
        const target = card.external ? "_blank" : "_self";
        const features = card.external ? "noopener,noreferrer" : undefined;
        window.open(card.href, target, features ?? undefined);
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center px-4 py-6">
            <div
                className="absolute inset-0 bg-black/65 backdrop-blur-sm animate-in fade-in-0 duration-200"
                onClick={onClose}
            />

            <div className="relative z-10 w-full max-w-5xl animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
                <Card className="relative flex h-[min(44rem,88vh)] w-full overflow-hidden rounded-[30px] border border-border/60 bg-card/95 text-foreground shadow-[0_32px_90px_-36px_rgba(15,23,42,0.65)] backdrop-blur-xl">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Close profile panel"
                        onClick={onClose}
                        className="absolute right-4 top-4 z-20 h-9 w-9 rounded-full text-muted-foreground transition hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0 focus-visible:outline-none"
                    >
                        <X size={18} />
                    </Button>

                    <div className="flex h-full w-full min-w-0 max-[639px]:flex-col">
                        <aside
                            className={cn(
                                "relative flex h-full flex-col border-r border-border/50 bg-muted/30 px-2.5 py-4 transition-[width,padding] duration-300 ease-in-out max-[639px]:h-auto max-[639px]:w-full max-[639px]:flex-none max-[639px]:border-b max-[639px]:border-r-0 max-[639px]:py-2 max-[639px]:pl-3 max-[639px]:pr-12",
                                navCollapsed ? "w-16 px-0" : "w-56"
                            )}
                        >
                            <ScrollArea className="h-full max-[639px]:h-auto">
                                <div className="flex h-full flex-col pt-6 max-[639px]:h-auto max-[639px]:flex-row max-[639px]:items-start max-[639px]:gap-2 max-[639px]:pt-0">
                                    <div
                                        className={cn(
                                            "relative mb-6 h-24 pb-1.5 transition-opacity duration-200 max-[639px]:hidden",
                                            navCollapsed ? "pointer-events-none opacity-0" : "opacity-100"
                                        )}
                                    >
                                        <div className="flex flex-col items-center gap-3 text-center">
                                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-gradient-to-br from-white/10 via-transparent to-transparent shadow-[0_10px_30px_-18px_rgba(0,0,0,0.8)]">
                                                <img
                                                    src={theme === "light" ? "/logo2.png" : "/logo2_white_magentaX.png"}
                                                    alt="mAgenticX mark"
                                                    className="h-9 w-9 object-contain drop-shadow-[0_4px_12px_rgba(255,0,123,0.45)]"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <h2 className="text-sm font-semibold tracking-tight">mAgenticX Profile</h2>
                                                <p className="text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground">
                                                    Manage your space
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <nav className={cn(
                                        "flex flex-1 flex-col justify-start gap-1 pt-0 max-[639px]:min-w-0 max-[639px]:flex-row max-[639px]:flex-wrap max-[639px]:items-center max-[639px]:gap-1.5 max-[639px]:overflow-visible",
                                        navCollapsed ? "items-center" : "items-start"
                                    )}>
                                        {navItems.map((item) => {
                                            const isActive = normalizedActiveTab === item.id;
                                            const isHovered = hoveredNavId === item.id;
                                            const iconSize = mobileProfileNav ? 15 : 18;
                                            const isLightTheme = currentTheme === "light";
                                            const mcpVariant: McpIconVariant =
                                                item.id === "mcp"
                                                    ? isActive
                                                        ? MCP_VARIANTS.active
                                                        : isHovered
                                                          ? isLightTheme
                                                              ? MCP_VARIANTS.hoverLight
                                                              : MCP_VARIANTS.hoverDark
                                                          : isLightTheme
                                                            ? MCP_VARIANTS.idleLight
                                                            : MCP_VARIANTS.idleDark
                                                    : MCP_VARIANTS.idleLight;

                                            const iconNode =
                                                item.id === "profile" ? (
                                                    <User size={iconSize} />
                                                ) : item.id === "appearance" ? (
                                                    <Palette size={iconSize} />
                                                ) : item.id === "archived" ? (
                                                    <ShieldCheck size={iconSize} />
                                                ) : item.id === "mcp" ? (
                                                    <McpIcon size={mobileProfileNav ? 17 : 20} variant={mcpVariant} />
                                                ) : item.id === "skills" ? (
                                                    <Sparkles size={iconSize} />
                                                ) : item.id === "shortcuts" ? (
                                                    <Keyboard size={iconSize} />
                                                ) : (
                                                    <HelpCircle size={iconSize} />
                                                );

                                            return (
                                                <Tooltip
                                                    key={item.id}
                                                    delayDuration={0}
                                                    open={navCollapsed ? openNavTooltipId === item.id : false}
                                                    onOpenChange={(nextOpen) => {
                                                        if (!navCollapsed) return;
                                                        if (nextOpen && !canOpenCollapsedNavTooltip()) return;
                                                        setOpenNavTooltipId(nextOpen ? item.id : null);
                                                    }}
                                                >
                                                    <TooltipTrigger asChild>
                                                        <button
                                                            type="button"
                                                            onPointerDown={() => {
                                                                if (navCollapsed) suppressCollapsedNavTooltip();
                                                            }}
                                                            onClick={() => {
                                                                if (navCollapsed) suppressCollapsedNavTooltip();
                                                                setActiveTab(item.id);
                                                            }}
                                                            onMouseEnter={() => {
                                                                setHoveredNavId(item.id);
                                                                if (navCollapsed && canOpenCollapsedNavTooltip()) {
                                                                    setOpenNavTooltipId(item.id);
                                                                }
                                                            }}
                                                            onMouseLeave={() => {
                                                                setHoveredNavId((prev) => (prev === item.id ? null : prev));
                                                                setOpenNavTooltipId((prev) => (prev === item.id ? null : prev));
                                                            }}
                                                            onBlur={() => {
                                                                setHoveredNavId((prev) => (prev === item.id ? null : prev));
                                                                setOpenNavTooltipId((prev) => (prev === item.id ? null : prev));
                                                            }}
                                                            className={cn(
                                                                "group relative grid grid-cols-[auto,1fr] items-center gap-2 rounded-xl px-2 py-1 text-left text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface))]",
                                                                navCollapsed ? "flex h-10 w-10 flex-none items-center justify-center p-0 max-[639px]:h-8 max-[639px]:w-auto max-[639px]:gap-1 max-[639px]:px-1.5" : "h-11 w-full",
                                                                isActive ? "text-primary hover:bg-transparent hover:text-primary focus-visible:bg-transparent" : ""
                                                            )}
                                                            aria-label={item.label}
                                                        >
                                                            <div
                                                                className={cn(
                                                                    "flex h-8 w-8 items-center justify-center rounded-lg border border-transparent transition-colors max-[639px]:h-6 max-[639px]:w-6",
                                                                    isActive
                                                                        ? "text-primary"
                                                                        : "text-muted-foreground group-hover:text-foreground"
                                                                )}
                                                            >
                                                                {iconNode}
                                                            </div>
                                                            {navCollapsed ? (
                                                                <span className="sr-only min-w-0 whitespace-nowrap text-[0.68rem] font-semibold uppercase tracking-[0.14em] max-[639px]:not-sr-only max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.12em]">
                                                                    {item.label}
                                                                </span>
                                                            ) : (
                                                                <span className="min-w-0 whitespace-nowrap text-[0.68rem] font-semibold uppercase tracking-[0.14em] opacity-100 transition-opacity duration-200 ease-in-out">
                                                                    {item.label}
                                                                </span>
                                                            )}
                                                        </button>
                                                    </TooltipTrigger>
                                                    {navCollapsed ? (
                                                        <TooltipContent
                                                            side={mobileProfileNav ? "bottom" : "right"}
                                                            sideOffset={10}
                                                            className="z-[80] whitespace-nowrap px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em]"
                                                        >
                                                            {item.label}
                                                        </TooltipContent>
                                                    ) : null}
                                                </Tooltip>
                                            );
                                        })}
                                        <button
                                            type="button"
                                            onClick={onLogout}
                                            className="group relative hidden h-8 w-auto flex-none items-center justify-center gap-1 rounded-xl px-1.5 py-1 text-left text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface))] max-[639px]:flex"
                                            aria-label="Logout"
                                        >
                                            <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors group-hover:text-foreground">
                                                <LogOut className="h-[15px] w-[15px]" />
                                            </div>
                                            <span className="min-w-0 whitespace-nowrap text-[0.58rem] font-semibold uppercase tracking-[0.12em]">
                                                Logout
                                            </span>
                                        </button>
                                    </nav>

                                    <Tooltip
                                        delayDuration={0}
                                        open={navCollapsed ? openNavTooltipId === "logout" : false}
                                        onOpenChange={(nextOpen) => {
                                            if (!navCollapsed) return;
                                            if (nextOpen && !canOpenCollapsedNavTooltip()) return;
                                            setOpenNavTooltipId(nextOpen ? "logout" : null);
                                        }}
                                    >
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                onPointerDown={() => {
                                                    if (navCollapsed) suppressCollapsedNavTooltip();
                                                }}
                                                onClick={() => {
                                                    if (navCollapsed) suppressCollapsedNavTooltip();
                                                    onLogout();
                                                }}
                                                onMouseEnter={() => {
                                                    if (navCollapsed && canOpenCollapsedNavTooltip()) {
                                                        setOpenNavTooltipId("logout");
                                                    }
                                                }}
                                                onMouseLeave={() => {
                                                    setOpenNavTooltipId((prev) => (prev === "logout" ? null : prev));
                                                }}
                                                onBlur={() => {
                                                    setOpenNavTooltipId((prev) => (prev === "logout" ? null : prev));
                                                }}
                                                className={cn(
                                                    "mt-auto grid grid-cols-[auto,1fr] items-center gap-2 rounded-xl px-2 py-1 text-left text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface))] max-[639px]:hidden",
                                                    navCollapsed ? "flex h-10 w-10 flex-none items-center justify-center self-center p-0" : "h-11 w-full"
                                                )}
                                                aria-label="Logout"
                                            >
                                                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent transition-colors text-muted-foreground group-hover:text-foreground">
                                                    <LogOut className="h-[18px] w-[18px]" />
                                                </div>
                                                {!navCollapsed ? (
                                                    <span className="min-w-0 whitespace-nowrap text-[0.68rem] font-semibold uppercase tracking-[0.14em] opacity-100 transition-opacity duration-200 ease-in-out">
                                                        Logout
                                                    </span>
                                                ) : null}
                                            </button>
                                        </TooltipTrigger>
                                        {navCollapsed ? (
                                            <TooltipContent
                                                side={mobileProfileNav ? "bottom" : "right"}
                                                sideOffset={10}
                                                className="z-[80] whitespace-nowrap px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em]"
                                            >
                                                Logout
                                            </TooltipContent>
                                        ) : null}
                                    </Tooltip>
                                </div>
                            </ScrollArea>
                        </aside>

                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            <div className="border-b border-border/60 px-6 py-5 sm:px-8 max-[639px]:px-4 max-[639px]:py-3">
                                {showActiveSectionEyebrow ? (
                                    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.18em]">
                                        {activeSection.eyebrow}
                                    </p>
                                ) : null}
                                <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between max-[639px]:gap-2">
                                    <div className="space-y-1">
                                        <h2 className="text-2xl font-semibold tracking-tight text-foreground max-[639px]:text-xl">
                                            {activeSection.title}
                                        </h2>
                                        <p className="max-w-2xl text-sm text-muted-foreground max-[639px]:text-xs">
                                            {activeSection.description}
                                        </p>
                                    </div>
                                    <div className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-full border border-emerald-500/20 bg-background/70 px-2.5 py-1 text-xs font-medium text-muted-foreground sm:max-w-xs max-[639px]:gap-1.5 max-[639px]:px-2 max-[639px]:py-0.5 max-[639px]:text-[0.68rem]">
                                        <span className="flex h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)] max-[639px]:h-1.5 max-[639px]:w-1.5" aria-hidden="true" />
                                        <span className="min-w-0 truncate">
                                            <span className="text-emerald-600 dark:text-emerald-400">Signed in</span>
                                            <span className="text-muted-foreground"> as </span>
                                            <span className="font-medium text-foreground">{displayName}</span>
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <ScrollArea className="h-full w-full">
                                <div className="space-y-6 px-6 py-6 sm:px-8">
                                    {normalizedActiveTab === "profile" ? (
                                        <div className="min-w-0 max-w-full space-y-6 overflow-hidden animate-fade-in">
                                            <section className="relative min-w-0 max-w-full overflow-hidden rounded-[28px] bg-card/70 p-4 sm:p-6">
                                                <div className="absolute inset-0 bg-gradient-to-br from-background via-muted/40 to-primary/10" />
                                                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
                                                <div className="relative flex min-w-0 flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                                                    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
                                                        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-[1.35rem] bg-background/80 text-lg font-semibold text-primary">
                                                            {user?.avatarUrl ? (
                                                                <img
                                                                    src={user.avatarUrl}
                                                                    alt={displayName}
                                                                    className="h-full w-full object-cover"
                                                                />
                                                            ) : (
                                                                avatarInitial
                                                            )}
                                                        </div>
                                                        <div className="min-w-0 space-y-2">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <h3 className="min-w-0 break-words text-xl font-semibold text-foreground [overflow-wrap:anywhere]">
                                                                    {displayName}
                                                                </h3>
                                                                <span className="inline-flex max-w-full items-center rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                    {displayRole}
                                                                </span>
                                                                <span
                                                                    className={cn(
                                                                        "inline-flex items-center rounded-full px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em]",
                                                                        user?.isActive
                                                                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                                            : "bg-muted text-muted-foreground"
                                                                    )}
                                                                >
                                                                {displayIsActive}
                                                                </span>
                                                            </div>
                                                            <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                                                {displayEmail}
                                                            </p>
                                                            <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                                                                {displayDepartment}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="grid min-w-0 max-w-full gap-4 rounded-[1.4rem] bg-black/10 px-4 py-4 sm:grid-cols-3 lg:w-[22rem] dark:bg-white/[0.03]">
                                                        <div className="space-y-1 sm:border-r sm:border-border/30 sm:pr-3">
                                                            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                                                                Last Login
                                                            </p>
                                                            <p className="break-words text-base font-semibold text-foreground [overflow-wrap:anywhere]">
                                                                {fmtDate(user?.lastLoginAt)}
                                                            </p>
                                                            <p className="break-words text-xs text-muted-foreground">
                                                                Most recent authenticated session
                                                            </p>
                                                        </div>
                                                        <div className="space-y-1 sm:border-r sm:border-border/30 sm:px-1">
                                                            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                                                                Workspace
                                                            </p>
                                                            <p className="break-words text-base font-semibold text-foreground [overflow-wrap:anywhere]">
                                                                {displayDepartment === NA ? "Unset" : displayDepartment}
                                                            </p>
                                                            <p className="break-words text-xs text-muted-foreground">
                                                                Current team or department
                                                            </p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                                                                Mode
                                                            </p>
                                                            <p className="break-words text-base font-semibold text-foreground [overflow-wrap:anywhere]">
                                                                {displayPrefersAgentic}
                                                            </p>
                                                            <p className="break-words text-xs text-muted-foreground">
                                                                Default agentic chat preference
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            </section>

                                            <div className="grid gap-6 xl:grid-cols-2">
                                                <InfoRowsCard
                                                    eyebrow="Identity"
                                                    title="Profile"
                                                    description="Core account information used across the interface."
                                                    rows={identityRows}
                                                />
                                                <InfoRowsCard
                                                    eyebrow="Workspace"
                                                    title="Workspace & Access"
                                                    description="Role, team, and current workspace defaults."
                                                    rows={workspaceRows}
                                                />
                                            </div>

                                            <InfoRowsCard
                                                eyebrow="Activity"
                                                title="Account Activity"
                                                description="Audit-friendly timestamps and immutable identifiers."
                                                rows={activityRows}
                                            />
                                        </div>
                                    ) : null}

                                    {normalizedActiveTab === "appearance" ? (
                                        <div className="space-y-6 animate-fade-in">
                                            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr),minmax(18rem,0.85fr)]">
                                                <InfoCard
                                                    eyebrow="Theme"
                                                    title="Choose a theme"
                                                    description="Keep the selection explicit and lightweight, similar to a settings-first chat product."
                                                >
                                                    <div className="grid gap-4 md:grid-cols-2">
                                                        {themeOptions.map((themeOption) => {
                                                            const Icon = themeOption.icon;
                                                            const isActive = currentTheme === themeOption.value;

                                                            return (
                                                                <button
                                                                    key={themeOption.value}
                                                                    type="button"
                                                                    onClick={() => setTheme(themeOption.value)}
                                                                    className={cn(
                                                                        "rounded-[1.5rem] p-4 text-left transition-colors",
                                                                        isActive
                                                                            ? "bg-primary/10"
                                                                            : "bg-muted/30 hover:bg-muted/45"
                                                                    )}
                                                                >
                                                                    <div
                                                                        className={cn(
                                                                            "h-28 rounded-[1.2rem] p-4",
                                                                            themeOption.cardClassName
                                                                        )}
                                                                    >
                                                                        <div className={cn("flex h-full flex-col justify-between", themeOption.previewClassName)}>
                                                                            <div className="flex items-center gap-2">
                                                                                <div className="h-2.5 w-2.5 rounded-full bg-primary/70" />
                                                                                <div className="h-2 w-16 rounded-full bg-black/10 dark:bg-white/10" />
                                                                            </div>
                                                                            <div className="grid gap-2">
                                                                                <div className="h-3 rounded-full bg-black/10 dark:bg-white/10" />
                                                                                <div className="h-3 w-4/5 rounded-full bg-black/10 dark:bg-white/10" />
                                                                                <div className="h-8 w-28 rounded-2xl bg-primary/70" />
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                    <div className="mt-4 flex items-start justify-between gap-4">
                                                                        <div>
                                                                            <p className="text-sm font-semibold text-foreground">
                                                                                {themeOption.name}
                                                                            </p>
                                                                            <p className="mt-1 text-sm text-muted-foreground">
                                                                                {isActive ? "Currently applied" : "Switch workspace theme"}
                                                                            </p>
                                                                        </div>
                                                                        <div
                                                                            className={cn(
                                                                                "flex h-10 w-10 items-center justify-center rounded-2xl bg-black/10 text-muted-foreground dark:bg-white/[0.04]",
                                                                                isActive && "bg-primary/12 text-primary"
                                                                            )}
                                                                        >
                                                                            <Icon size={18} />
                                                                        </div>
                                                                    </div>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </InfoCard>

                                                <InfoCard
                                                    eyebrow="Defaults"
                                                    title="Conversation defaults"
                                                    description="Read-only defaults surfaced from stored preferences and active workspace state."
                                                >
                                                    <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                                                        <div className="px-5 py-4">
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div>
                                                                    <p className="text-sm font-semibold text-foreground">
                                                                        Agentic chat
                                                                    </p>
                                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                                        Controls whether the user profile prefers the agentic chat experience.
                                                                    </p>
                                                                </div>
                                                                <span className="inline-flex rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                    {displayPrefersAgentic}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <div className="px-5 py-4">
                                                            <div className="flex items-start justify-between gap-4">
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-semibold text-foreground">
                                                                        Conversation suggestions
                                                                    </p>
                                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                                        Show personalized starter prompts below the composer on new chats.
                                                                    </p>
                                                                </div>
                                                                <div className="flex shrink-0 items-center gap-3">
                                                                    <button
                                                                        type="button"
                                                                        role="switch"
                                                                        aria-checked={suggestionsEnabled}
                                                                        aria-disabled={preferencesSaving}
                                                                        onClick={() => !preferencesSaving && onToggleSuggestionsEnabled?.()}
                                                                        className={cn(
                                                                            "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                                                            suggestionsEnabled
                                                                                ? "border-primary/40 bg-primary/20"
                                                                                : "border-transparent bg-background/80",
                                                                            preferencesSaving && "cursor-not-allowed opacity-60"
                                                                        )}
                                                                    >
                                                                        <span
                                                                            className={cn(
                                                                                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                                                suggestionsEnabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                                                            )}
                                                                        />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="px-5 py-4">
                                                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-semibold text-foreground">
                                                                        Voice mode
                                                                    </p>
                                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                                        Voice used for live voice mode and read aloud.
                                                                    </p>
                                                                </div>
                                                                <VoiceSelector
                                                                    value={voiceModeVoice}
                                                                    open={voiceSelectorOpen}
                                                                    onOpenChange={setVoiceSelectorOpen}
                                                                >
                                                                    <VoiceSelectorTrigger asChild>
                                                                        <button
                                                                            type="button"
                                                                            disabled={preferencesSaving}
                                                                            className={cn(
                                                                                "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 px-3 text-left text-sm transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60 sm:w-56",
                                                                                voiceSelectorOpen && "bg-background/80"
                                                                            )}
                                                                        >
                                                                            <span className="min-w-0">
                                                                                <span className="block truncate font-semibold text-foreground">
                                                                                    {selectedVoiceModeVoice.label}
                                                                                </span>
                                                                                <span className="block truncate text-xs text-muted-foreground">
                                                                                    {selectedVoiceModeVoice.description}
                                                                                </span>
                                                                            </span>
                                                                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                                                                <Sparkles size={13} />
                                                                            </span>
                                                                        </button>
                                                                    </VoiceSelectorTrigger>
                                                                    <VoiceSelectorContent
                                                                        title="Voice mode"
                                                                        className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                                                                    >
                                                                        <VoiceSelectorInput placeholder="Search voices..." />
                                                                        <VoiceSelectorList className="max-h-[22rem]">
                                                                            <VoiceSelectorEmpty>No voice found.</VoiceSelectorEmpty>
                                                                            <VoiceSelectorGroup heading="Voices">
                                                                                {REALTIME_VOICES.map((voice) => {
                                                                                    const isSelected = voice.id === voiceModeVoice;

                                                                                    return (
                                                                                        <VoiceSelectorItem
                                                                                            key={voice.id}
                                                                                            value={`${voice.label} ${voice.description}`}
                                                                                            onSelect={() => {
                                                                                                setVoiceSelectorOpen(false);
                                                                                                onSelectVoiceModeVoice?.(normalizeRealtimeVoice(voice.id));
                                                                                            }}
                                                                                            className={cn(
                                                                                                "items-center gap-3 rounded-xl px-3 py-3",
                                                                                                isSelected && "bg-primary/10"
                                                                                            )}
                                                                                        >
                                                                                            <VoiceSelectorPreview
                                                                                                loading={previewLoadingVoice === voice.id}
                                                                                                playing={previewPlayingVoice === voice.id}
                                                                                                onPlay={() => handlePreviewVoice(voice.id)}
                                                                                                className={cn(
                                                                                                    "size-6 shrink-0 rounded-lg border",
                                                                                                    isSelected
                                                                                                        ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/20"
                                                                                                        : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60"
                                                                                                )}
                                                                                            />
                                                                                            <span className="min-w-0 flex-1">
                                                                                                <span className="flex min-w-0 items-center gap-2">
                                                                                                    <VoiceSelectorName>{voice.label}</VoiceSelectorName>
                                                                                                    <VoiceSelectorAttributes className="ml-auto shrink-0 gap-2">
                                                                                                        <VoiceSelectorDescription className="whitespace-nowrap">
                                                                                                            {voice.description}
                                                                                                        </VoiceSelectorDescription>
                                                                                                    </VoiceSelectorAttributes>
                                                                                                    <span
                                                                                                        className={cn(
                                                                                                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                                                                                                            isSelected
                                                                                                                ? "bg-primary/20 text-primary"
                                                                                                                : "bg-muted/60 text-muted-foreground"
                                                                                                        )}
                                                                                                        title={voice.gender === "female" ? "Female voice" : "Male voice"}
                                                                                                    >
                                                                                                        <VoiceGenderIcon gender={voice.gender} className="h-3.5 w-3.5" />
                                                                                                    </span>
                                                                                                </span>
                                                                                            </span>
                                                                                        </VoiceSelectorItem>
                                                                                    );
                                                                                })}
                                                                            </VoiceSelectorGroup>
                                                                        </VoiceSelectorList>
                                                                    </VoiceSelectorContent>
                                                                </VoiceSelector>
                                                            </div>
                                                        </div>
                                                        <div className="px-5 py-4">
                                                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-semibold text-foreground">
                                                                        Voice mode language
                                                                    </p>
                                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                                        Default response language for live voice conversations.
                                                                    </p>
                                                                </div>
                                                                <Select
                                                                    value={voiceModeLanguage}
                                                                    onValueChange={(value) => onSelectVoiceModeLanguage?.(normalizeVoiceModeLanguage(value))}
                                                                    disabled={preferencesSaving}
                                                                >
                                                                    <SelectTrigger className="h-11 w-full rounded-xl border-border/60 bg-background/60 px-3 text-sm font-semibold hover:bg-background/80 focus:ring-primary/60 sm:w-36">
                                                                        <SelectValue />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        {VOICE_MODE_LANGUAGES.map((language) => (
                                                                            <SelectItem key={language.id} value={language.id}>
                                                                                {language.label}
                                                                            </SelectItem>
                                                                        ))}
                                                                    </SelectContent>
                                                                </Select>
                                                            </div>
                                                        </div>
                                                    </SoftPanel>
                                                </InfoCard>
                                            </div>
                                        </div>
                                    ) : null}

                                    {normalizedActiveTab === "archived" ? (
                                        <div className="space-y-6 animate-fade-in">
                                            <div className="grid gap-4 lg:grid-cols-3">
                                                <MetricCard
                                                    label="Archived Chats"
                                                    value={String(archivedConversations.length)}
                                                    hint="Hidden from the sidebar, still restorable"
                                                />
                                                <MetricCard
                                                    label="Latest Archive"
                                                    value={fmtDate(latestArchivedConversation?.archivedAt ?? latestArchivedConversation?.updated_at)}
                                                    hint="Most recent archived conversation date"
                                                />
                                                <MetricCard
                                                    label="Shared Links"
                                                    value={String(activeSharedCount)}
                                                    hint="Active links visible to people with the URL"
                                                />
                                            </div>

                                            <InfoCard
                                                eyebrow="History"
                                                title="Archived conversations"
                                                description="Archive is a reversible history action. It removes clutter from the main sidebar without deleting the underlying conversation."
                                            >
                                                <div className={dataControlListClass} onScroll={handleArchivedScroll}>
                                                    <div className="space-y-3 p-4">
                                                        {archivedConversations.length === 0 && !archivedConversationsLoading ? (
                                                            <SoftPanel className="px-4 py-10 text-center">
                                                                <p className="text-sm text-muted-foreground">
                                                                    No archived conversations yet.
                                                                </p>
                                                            </SoftPanel>
                                                        ) : (
                                                            archivedConversations.map((conversation) => (
                                                                <SoftPanel key={conversation.id} className="p-4 transition hover:bg-muted/40">
                                                                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => onSelectArchivedConversation?.(conversation)}
                                                                            className="min-w-0 flex-1 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                                                        >
                                                                            <div className="space-y-1.5">
                                                                                <div className="flex flex-wrap items-center gap-2">
                                                                                    <p className="truncate text-sm font-semibold text-foreground">
                                                                                        {conversation.title?.trim() || "Untitled conversation"}
                                                                                    </p>
                                                                                    <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                                        {conversation.agent.name}
                                                                                    </span>
                                                                                </div>
                                                                                {conversation.lastMessage ? (
                                                                                    <p className="line-clamp-2 text-sm text-muted-foreground">
                                                                                        {conversation.lastMessage}
                                                                                    </p>
                                                                                ) : null}
                                                                            </div>
                                                                        </button>

                                                                        <div className="flex items-center gap-3 md:flex-col md:items-end">
                                                                            <div className="text-left md:text-right">
                                                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                                                                                    Archived
                                                                                </p>
                                                                                <p className="mt-1 text-sm text-muted-foreground">
                                                                                    {fmtDate(conversation.archivedAt ?? conversation.updated_at)}
                                                                                </p>
                                                                            </div>
                                                                            <Button
                                                                                type="button"
                                                                                variant="outline"
                                                                                size="sm"
                                                                                onClick={() => onUnarchiveConversation?.(conversation)}
                                                                                className="h-9 rounded-xl border-0 bg-background/80 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.18em]"
                                                                            >
                                                                                Unarchive
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                </SoftPanel>
                                                            ))
                                                        )}

                                                        {archivedConversationsLoading ? (
                                                            <SoftPanel className="px-4 py-4 text-center">
                                                                <p className="text-sm text-muted-foreground">
                                                                    Loading archived conversations...
                                                                </p>
                                                            </SoftPanel>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </InfoCard>

                                            <InfoCard
                                                eyebrow="Sharing"
                                                title="Shared conversations"
                                                description="Review links created from your conversations. Revoking a link immediately blocks public access to that shared snapshot."
                                            >
                                                <div className={dataControlListClass} onScroll={handleSharedScroll}>
                                                    <div className="space-y-3 p-4">
                                                        {sharedConversations.length === 0 && !sharedConversationsLoading ? (
                                                            <SoftPanel className="px-4 py-10 text-center">
                                                                <p className="text-sm text-muted-foreground">
                                                                    No shared conversations yet.
                                                                </p>
                                                            </SoftPanel>
                                                        ) : (
                                                            sharedConversations.map((share) => {
                                                                const statusClass =
                                                                    share.status === "active"
                                                                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                                        : share.status === "expired"
                                                                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                                                            : "bg-muted text-muted-foreground";
                                                                const modeLabel =
                                                                    share.shareMode === "message"
                                                                        ? "Response"
                                                                        : share.shareMode === "branch"
                                                                            ? "Thread"
                                                                            : "Full";

                                                                return (
                                                                    <SoftPanel key={share.id} className="p-4 transition hover:bg-muted/40">
                                                                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => onSelectSharedConversation?.(share)}
                                                                                className="min-w-0 flex-1 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                                                            >
                                                                                <div className="space-y-1.5">
                                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                                        <p className="truncate text-sm font-semibold text-foreground">
                                                                                            {share.title?.trim() || "Untitled conversation"}
                                                                                        </p>
                                                                                        <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                                            {modeLabel}
                                                                                        </span>
                                                                                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em]", statusClass)}>
                                                                                            {share.status}
                                                                                        </span>
                                                                                    </div>
                                                                                    <p className="text-sm text-muted-foreground">
                                                                                        Created {fmtDate(share.createdAt)} · Expires {fmtDate(share.expiresAt)}
                                                                                    </p>
                                                                                </div>
                                                                            </button>

                                                                            <div className="flex flex-wrap items-center gap-0.5 md:justify-end">
                                                                                <Tooltip delayDuration={0}>
                                                                                    <TooltipTrigger asChild>
                                                                                        <Button
                                                                                            type="button"
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            onMouseDown={(event) => event.preventDefault()}
                                                                                            onClick={(event) => {
                                                                                                event.stopPropagation();
                                                                                                handleCopyShareLink(share);
                                                                                            }}
                                                                                            className={sharedActionButtonClass}
                                                                                            aria-label={copiedShareId === share.id ? "Copied" : "Copy share link"}
                                                                                        >
                                                                                            <span className="relative inline-block h-4 w-4">
                                                                                                <Copy
                                                                                                    className={cn(
                                                                                                        "absolute inset-0 h-4 w-4 transition-all duration-200",
                                                                                                        copiedShareId === share.id ? "scale-75 opacity-0" : "scale-100 opacity-100"
                                                                                                    )}
                                                                                                />
                                                                                                <Check
                                                                                                    className={cn(
                                                                                                        "absolute inset-0 h-4 w-4 transition-all duration-200",
                                                                                                        copiedShareId === share.id ? "scale-100 opacity-100" : "scale-75 opacity-0"
                                                                                                    )}
                                                                                                />
                                                                                            </span>
                                                                                        </Button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                                                        <p>{copiedShareId === share.id ? "Copied" : "Copy"}</p>
                                                                                    </TooltipContent>
                                                                                </Tooltip>

                                                                                <Tooltip delayDuration={0}>
                                                                                    <TooltipTrigger asChild>
                                                                                        <Button
                                                                                            type="button"
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            onMouseDown={(event) => event.preventDefault()}
                                                                                            onClick={(event) => {
                                                                                                event.stopPropagation();
                                                                                                window.open(new URL(share.shareUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer");
                                                                                            }}
                                                                                            className={sharedActionButtonClass}
                                                                                            aria-label="Open share link"
                                                                                        >
                                                                                            <Link2 size={16} />
                                                                                        </Button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                                                        <p>Open link</p>
                                                                                    </TooltipContent>
                                                                                </Tooltip>

                                                                                <Tooltip delayDuration={0}>
                                                                                    <TooltipTrigger asChild>
                                                                                        <Button
                                                                                            type="button"
                                                                                            variant="ghost"
                                                                                            size="icon"
                                                                                            disabled={share.status !== "active"}
                                                                                            onMouseDown={(event) => event.preventDefault()}
                                                                                            onClick={(event) => {
                                                                                                event.stopPropagation();
                                                                                                onRevokeSharedConversation?.(share);
                                                                                            }}
                                                                                            className={sharedActionButtonClass}
                                                                                            aria-label="Revoke share link"
                                                                                        >
                                                                                            <Ban size={16} />
                                                                                        </Button>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                                                        <p>Revoke</p>
                                                                                    </TooltipContent>
                                                                                </Tooltip>
                                                                            </div>
                                                                        </div>
                                                                    </SoftPanel>
                                                                );
                                                            })
                                                        )}

                                                        {sharedConversationsLoading ? (
                                                            <SoftPanel className="px-4 py-4 text-center">
                                                                <p className="text-sm text-muted-foreground">
                                                                    Loading shared conversations...
                                                                </p>
                                                            </SoftPanel>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </InfoCard>
                                        </div>
                                    ) : null}

                                    {normalizedActiveTab === "mcp" ? (
                                        <div className="space-y-6 animate-fade-in">
                                            <div className="grid gap-4 lg:grid-cols-3">
                                                <MetricCard
                                                    label="Servers"
                                                    value={String(serverGroups.length)}
                                                    hint="Discovered MCP server groups"
                                                />
                                                <MetricCard
                                                    label="Enabled Tools"
                                                    value={String(enabledToolsCount)}
                                                    hint="Currently allowed in conversation"
                                                />
                                                <MetricCard
                                                    label="Disabled Tools"
                                                    value={String(Math.max(availableTools.length - enabledToolsCount, 0))}
                                                    hint="Hidden until re-enabled"
                                                />
                                            </div>

                                            <InfoCard
                                                eyebrow="Apps"
                                                title="Manage MCP tools"
                                                description="This mirrors the apps/connectors mental model: browse grouped integrations, inspect descriptions, and keep only the tools you want available."
                                            >
                                                <div className="space-y-4">
                                                    {availableTools.length === 0 ? (
                                                        <SoftPanel className="px-4 py-10 text-center">
                                                            <p className="text-sm text-muted-foreground">
                                                                No tools discovered yet. Make sure the MCP tools server is running and refresh after login.
                                                            </p>
                                                        </SoftPanel>
                                                    ) : (
                                                        serverGroups.map(([serverKey, tools]) => {
                                                            const collapsed = serverCollapsed[serverKey] ?? false;
                                                            const serverLabel = serverKey === "default" ? "Unassigned server" : serverKey;

                                                            return (
                                                                <SoftPanel key={serverKey} className="p-4">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            setServerCollapsed((prev) => ({
                                                                                ...prev,
                                                                                [serverKey]: !collapsed,
                                                                            }))
                                                                        }
                                                                        className="flex w-full items-center justify-between gap-4 rounded-2xl text-left"
                                                                    >
                                                                        <div className="flex items-center gap-3">
                                                                            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-background/75">
                                                                                <McpIcon
                                                                                    size={20}
                                                                                    variant={currentTheme === "dark" ? "white" : "black"}
                                                                                />
                                                                            </div>
                                                                            <div>
                                                                                <p className="text-sm font-semibold text-foreground">
                                                                                    {serverLabel}
                                                                                </p>
                                                                                <p className="text-sm text-muted-foreground">
                                                                                    {tools.length} tool{tools.length === 1 ? "" : "s"}
                                                                                </p>
                                                                            </div>
                                                                        </div>
                                                                        <ChevronDown
                                                                            size={18}
                                                                            className={cn(
                                                                                "text-muted-foreground transition-transform",
                                                                                collapsed ? "-rotate-90" : "rotate-0"
                                                                            )}
                                                                        />
                                                                    </button>

                                                                    {!collapsed ? (
                                                                        <div className="mt-4 divide-y divide-border/35 overflow-hidden rounded-[1.1rem] bg-black/10 dark:bg-white/[0.03]">
                                                                            {tools.map((tool) => {
                                                                                const uniqueKey = toolKey(tool);
                                                                                const enabled =
                                                                                    typeof tool.enabled === "boolean"
                                                                                        ? tool.enabled
                                                                                        : !preferencesDisabledKeys.has(uniqueKey);
                                                                                const parameterCount = Math.max(0, tool.parameterCount ?? 0);
                                                                                const parameterLabel =
                                                                                    parameterCount === 0
                                                                                        ? "0 parameters"
                                                                                        : `${parameterCount} parameter${parameterCount > 1 ? "s" : ""}`;
                                                                                const description =
                                                                                    tool.description?.trim() || "No description provided.";
                                                                                const maxDescriptionLength = 160;
                                                                                const isTruncated =
                                                                                    description.length > maxDescriptionLength;
                                                                                const showFull = expandedDescriptions[uniqueKey] ?? false;
                                                                                const displayText =
                                                                                    showFull || !isTruncated
                                                                                        ? description
                                                                                        : description.slice(0, maxDescriptionLength);

                                                                                return (
                                                                                    <div
                                                                                        key={uniqueKey}
                                                                                        className="px-4 py-4"
                                                                                    >
                                                                                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                                                                            <div className="min-w-0 flex-1 space-y-2">
                                                                                                <div className="flex flex-wrap items-center gap-2">
                                                                                                    <p className="text-sm font-semibold text-foreground">
                                                                                                        {tool.toolName}
                                                                                                    </p>
                                                                                                    <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                                                        {parameterLabel}
                                                                                                    </span>
                                                                                                    <span
                                                                                                        className={cn(
                                                                                                            "inline-flex rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em]",
                                                                                                            enabled
                                                                                                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                                                                                : "bg-muted text-muted-foreground"
                                                                                                        )}
                                                                                                    >
                                                                                                        {enabled ? "Enabled" : "Disabled"}
                                                                                                    </span>
                                                                                                </div>
                                                                                                <p className="text-sm text-muted-foreground">
                                                                                                    {displayText}
                                                                                                    {!showFull && isTruncated ? (
                                                                                                        <button
                                                                                                            type="button"
                                                                                                            onClick={() =>
                                                                                                                setExpandedDescriptions((prev) => ({
                                                                                                                    ...prev,
                                                                                                                    [uniqueKey]: true,
                                                                                                                }))
                                                                                                            }
                                                                                                            className="ml-2 text-[0.72rem] font-semibold text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                                                                                        >
                                                                                                            See more
                                                                                                        </button>
                                                                                                    ) : null}
                                                                                                </p>
                                                                                            </div>

                                                                                            <button
                                                                                                type="button"
                                                                                                role="switch"
                                                                                                aria-checked={enabled}
                                                                                                aria-disabled={preferencesSaving}
                                                                                                onClick={() =>
                                                                                                    !preferencesSaving && onToggleToolPreference?.(tool)
                                                                                                }
                                                                                                className={cn(
                                                                                                    "relative inline-flex h-7 w-12 items-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                                                                                    enabled
                                                                                                        ? "border-primary/40 bg-primary/20"
                                                                                                        : "border-transparent bg-background/80",
                                                                                                    preferencesSaving && "cursor-not-allowed opacity-60"
                                                                                                )}
                                                                                            >
                                                                                                <span
                                                                                                    className={cn(
                                                                                                        "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                                                                                                        enabled ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                                                                                    )}
                                                                                                />
                                                                                            </button>
                                                                                        </div>
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    ) : null}
                                                                </SoftPanel>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </InfoCard>
                                        </div>
                                    ) : null}

                                    {normalizedActiveTab === "skills" ? (
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
                                                            Reusable playbooks your deep agents load when relevant — add or author them here, then assign per agent.
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
                                                                                <RefreshCw size={16} className={cn(mySkillsRefreshing && "animate-spin")} />
                                                                            </Button>
                                                                        </TooltipTrigger>
                                                                        <TooltipContent side="top">{mySkillsRefreshing ? "Refreshing…" : "Refresh"}</TooltipContent>
                                                                    </Tooltip>
                                                                ) : null}
                                                            </div>
                                                        }
                                                    >
                                                        <div className="flex flex-col gap-3">
                                                            {(mySkills?.length ?? 0) > 6 ? (
                                                                <div className="relative">
                                                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
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
                                                                                    <p className="truncate text-sm font-semibold text-foreground">{skill.name}</p>
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
                                                                                    <p className="text-xs text-muted-foreground">Could not load content.</p>
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
                                                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
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
                                                                                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
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
                                                                                <motion.div key={`${skill.category}/${skill.name}`} {...skillCardMotion(index)}>
                                                                                    <SoftPanel className="p-3">
                                                                                        <div className="flex items-start justify-between gap-3">
                                                                                            <div className="flex min-w-0 flex-col gap-0.5">
                                                                                                <div className="flex min-w-0 items-center gap-2">
                                                                                                    <p className="truncate text-sm font-medium text-foreground">{skill.name}</p>
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
                                                        {(mySkills?.length ?? 0) > 0 && deepAgents.map((agent) => {
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
                                    ) : null}

                                    {normalizedActiveTab === "shortcuts" ? (
                                        <div className="space-y-6 animate-fade-in">
                                            <InfoCard
                                                eyebrow="Platform"
                                                title="Shortcut platform"
                                                description="Swap the visible key labels without changing the underlying shortcut registry."
                                            >
                                                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                                                    <SoftPanel className="flex-1 p-4">
                                                        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                                                            Escape behavior
                                                        </p>
                                                        <p className="mt-2 text-sm text-foreground">
                                                            `Esc` dismisses the top active app surface first: image preview, profile panel, agent picker, conversation action menus, sidebar rename or action menus, then inline message editing. It never stops inference or voice dictation.
                                                        </p>
                                                    </SoftPanel>
                                                    <div className="inline-flex rounded-2xl bg-muted/30 p-1">
                                                        {[
                                                            { id: "mac" as const, label: "Mac" },
                                                            { id: "win" as const, label: "Windows/Linux" },
                                                        ].map((platform) => {
                                                            const isActive = shortcutPlatform === platform.id;
                                                            return (
                                                                <button
                                                                    key={platform.id}
                                                                    type="button"
                                                                onClick={() => setShortcutPlatform(platform.id)}
                                                                className={cn(
                                                                    "rounded-xl px-4 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] transition-colors",
                                                                    isActive
                                                                        ? "bg-primary/15 text-primary"
                                                                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                                                                )}
                                                            >
                                                                {platform.label}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            </InfoCard>

                                            <div className="space-y-5">
                                                {shortcutSections.map(({ category, items }) => (
                                                    <section key={category} className="space-y-3">
                                                        <div className="space-y-1">
                                                            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                                                                {category}
                                                            </p>
                                                            <p className="text-sm text-muted-foreground">
                                                                {category === "Workspace" && "Global workspace navigation and panel actions."}
                                                                {category === "Chat" && "Conversation-level actions that affect the current chat shell."}
                                                                {category === "Composer" && "Composer-local keys handled directly inside the input."}
                                                                {category === "Dismiss" && "Context-aware closing and cancellation behavior."}
                                                            </p>
                                                        </div>
                                                        <div className="space-y-3">
                                                            {items.map((shortcut) => (
                                                                <SoftPanel
                                                                    key={shortcut.id}
                                                                    className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr),auto]"
                                                                >
                                                                    <div className="space-y-1.5">
                                                                        <div className="flex flex-wrap items-center gap-2">
                                                                            <p className="text-sm font-semibold text-foreground">
                                                                                {shortcut.title}
                                                                            </p>
                                                                            <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                                                {shortcut.scope}
                                                                            </span>
                                                                            <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-primary">
                                                                                {shortcut.implementation}
                                                                            </span>
                                                                        </div>
                                                                        <p className="text-sm text-muted-foreground">
                                                                            {shortcut.description}
                                                                        </p>
                                                                        {shortcut.availabilityNote ? (
                                                                            <p className="text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                                                                {shortcut.availabilityNote}
                                                                            </p>
                                                                        ) : null}
                                                                    </div>
                                                                    <div className="flex items-start md:items-center">
                                                                        <div className="inline-flex min-w-[9rem] justify-center rounded-xl bg-background/80 px-3 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-foreground">
                                                                            {getShortcutLabel(shortcut, shortcutPlatform)}
                                                                        </div>
                                                                    </div>
                                                                </SoftPanel>
                                                            ))}
                                                        </div>
                                                    </section>
                                                ))}
                                            </div>
                                        </div>
                                    ) : null}

                                    {normalizedActiveTab === "help" ? (
                                        <div className="space-y-6 animate-fade-in">
                                            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr),minmax(18rem,0.8fr)]">
                                                <InfoCard
                                                    eyebrow="Resources"
                                                    title="Documentation"
                                                    description="Docs, support, and legal resources for mAgenticX."
                                                >
                                                    <div className="grid gap-4 md:grid-cols-2">
                                                        {helpCards.map((card) =>
                                                            card.href ? (
                                                                <button
                                                                    key={card.title}
                                                                    type="button"
                                                                    onClick={() => handleHelpCardClick(card)}
                                                                    className="relative rounded-[1.4rem] bg-muted/30 p-5 text-left transition hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                                                    aria-label={`${card.title}${card.external ? " (opens in new tab)" : ""}`}
                                                                >
                                                                    <h3 className="text-sm font-semibold text-foreground">
                                                                        {card.title}
                                                                    </h3>
                                                                    <p className="mt-2 text-sm text-muted-foreground">{card.desc}</p>
                                                                    {card.external ? (
                                                                        <span className="absolute right-4 top-4 text-muted-foreground">
                                                                            <ExternalLink size={16} />
                                                                        </span>
                                                                    ) : null}
                                                                </button>
                                                            ) : (
                                                                <div
                                                                    key={card.title}
                                                                    className="rounded-[1.4rem] bg-muted/30 p-5"
                                                                >
                                                                    <h3 className="text-sm font-semibold text-foreground">
                                                                        {card.title}
                                                                    </h3>
                                                                    <p className="mt-2 text-sm text-muted-foreground">{card.desc}</p>
                                                                </div>
                                                            )
                                                        )}
                                                    </div>
                                                </InfoCard>

                                                <InfoCard
                                                    eyebrow="At a glance"
                                                    title="Workspace health"
                                                    description="A compact status summary for the most visible settings surfaces."
                                                >
                                                    <SoftPanel className="divide-y divide-border/35 overflow-hidden">
                                                        <div className="flex items-center gap-3 px-4 py-4">
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                                                <AppWindow size={18} />
                                                            </div>
                                                            <div>
                                                                <p className="text-sm font-semibold text-foreground">
                                                                    {enabledToolsCount} enabled tool{enabledToolsCount === 1 ? "" : "s"}
                                                                </p>
                                                                <p className="text-sm text-muted-foreground">
                                                                    MCP tools currently available in chat.
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3 px-4 py-4">
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                                                <Archive size={18} />
                                                            </div>
                                                            <div>
                                                                <p className="text-sm font-semibold text-foreground">
                                                                    {archivedConversations.length} archived conversation{archivedConversations.length === 1 ? "" : "s"}
                                                                </p>
                                                                <p className="text-sm text-muted-foreground">
                                                                    History kept out of the main sidebar.
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3 px-4 py-4">
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                                                {currentTheme === "dark" ? <MoonStar size={18} /> : <Sparkles size={18} />}
                                                            </div>
                                                            <div>
                                                                <p className="text-sm font-semibold text-foreground">
                                                                    Theme: {currentTheme}
                                                                </p>
                                                                <p className="text-sm text-muted-foreground">
                                                                    Active shell appearance for the workspace.
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </SoftPanel>
                                                </InfoCard>
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            </ScrollArea>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
