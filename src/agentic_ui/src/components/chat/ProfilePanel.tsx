import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    User,
    Settings,
    Palette,
    HelpCircle,
    LogOut,
    Sparkles,
    MoonStar,
    ChevronDown,
    X,
    ExternalLink,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { ToolMetadata, UserPreferences, UserProfile } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ProfilePanelProps = {
    open: boolean;
    onClose: () => void;
    activeTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
    user: UserProfile | null;
    availableTools: (ToolMetadata & { enabled?: boolean })[];
    userPreferences: UserPreferences;
    onToggleToolPreference?: (tool: ToolMetadata) => void;
    preferencesSaving?: boolean;
};

type ToolWithStatus = ToolMetadata & { enabled?: boolean };
type HelpCard = {
    title: string;
    desc: string;
    href?: string;
    external?: boolean;
};

const MCP_ICON_SRCS = {
    grey: "/mcp-server-stroke-rounded (3).png",
    darkGrey: "/mcp-server-stroke-rounded (4).png",
    white: "/mcp-server-Stroke-Rounded (2).png",
    magenta: "/mcp-server-Stroke-Rounded (1).png",
    black: "/mcp-server-Stroke-Rounded.png",
} as const;

type McpIconVariant = keyof typeof MCP_ICON_SRCS;

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

export default function ProfilePanel({
    open,
    onClose,
    activeTab,
    setActiveTab,
    onLogout,
    user,
    availableTools,
    userPreferences,
    onToggleToolPreference,
    preferencesSaving = false,
}: ProfilePanelProps) {
    const [hoveredNavId, setHoveredNavId] = useState<string | null>(null);
    const [serverCollapsed, setServerCollapsed] = useState<Record<string, boolean>>({});
    const [navCollapsed, setNavCollapsed] = useState<boolean>(() =>
        typeof window !== "undefined" ? window.innerWidth < 960 : false
    );
    const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
    const { theme, setTheme } = useTheme();

    const toolKey = (tool: ToolWithStatus) => {
        const prefix = tool.serverId && tool.serverId.length > 0 ? tool.serverId : "default";
        return `${prefix}::${tool.toolName}`;
    };

    const preferencesDisabledKeys = useMemo(() => {
        const entries = userPreferences?.tools?.disabled ?? [];
        const keys = entries.map((item) => {
            const name = (item as any).toolName ?? (item as any).tool_name ?? "";
            const serverPrefix = item.serverId && item.serverId.length > 0 ? item.serverId : "default";
            return `${serverPrefix}::${name}`;
        });
        return new Set(keys);
    }, [userPreferences]);

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

    const handleToggleServer = (tool: ToolMetadata) => {
        onToggleToolPreference?.(tool);
    };

    useEffect(() => {
        const handleResize = () => {
            if (typeof window === "undefined") return;
            setNavCollapsed(window.innerWidth < 960);
        };
        handleResize();
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);



    if (!open) return null;

    const NA = "N/A";

    const safeText = (v?: string | null) =>
        v && String(v).trim().length > 0 ? String(v).trim() : NA;

    const fmtDateTime = (v?: Date | string | null) => {
        if (!v) return NA;
        const d = typeof v === "string" ? new Date(v) : v;
        return isNaN(d.getTime()) ? NA : d.toLocaleString();
    };

    const fmtBoolean = (b?: boolean) => (typeof b === "boolean" ? (b ? "Yes" : "No") : NA);

    const displayName =
        safeText(user?.displayName) !== NA
            ? safeText(user?.displayName)
            : safeText(user?.fullName) !== NA
            ? safeText(user?.fullName)
            : safeText(user?.username);

    const displayEmail = safeText(user?.email);
    const displayDepartment = safeText(user?.department);
    const displayRole = safeText(user?.roleTitle);

    const displayLastLogin = fmtDateTime(user?.lastLoginAt);
    const displayCreatedAt = fmtDateTime(user?.createdAt);
    const displayUpdatedAt = fmtDateTime(user?.updatedAt);

    const prefersAgentic = typeof userPreferences?.prefersAgenticChat === "boolean" ? userPreferences.prefersAgenticChat : undefined;
    const displayIsActive = fmtBoolean(user?.isActive);
    const displayPrefersAgentic = fmtBoolean(prefersAgentic);

    const navItems = [
        { id: "profile", label: "User Profile", icon: User },
        { id: "mcp", label: "MCP Servers", icon: McpIcon },
        { id: "appearance", label: "Appearance", icon: Palette },
        { id: "settings", label: "Settings", icon: Settings },
        { id: "help", label: "Help", icon: HelpCircle },
    ];

    const profileFields = [
        { label: "Full Name", value: safeText(user?.fullName) },
        { label: "Display Name", value: safeText(user?.displayName) },
        { label: "Username", value: safeText(user?.username) },
        { label: "Email", value: displayEmail },
        { label: "Department", value: displayDepartment },
        { label: "Role Title", value: displayRole },
        { label: "Last Login", value: displayLastLogin },
        { label: "Created At", value: displayCreatedAt },
        { label: "Updated At", value: displayUpdatedAt },
        { label: "Active Account", value: displayIsActive },
        { label: "Prefers Agentic Chat", value: displayPrefersAgentic },
        { label: "User ID", value: safeText(user?.id) },
    ];

    const themeOptions = [
        { name: "Elegant", value: "light", icon: Sparkles },
        { name: "Dark Magenta", value: "dark", icon: MoonStar },
    ];

    const settingsCards = [
        { title: "Notifications", desc: "Manage your notification preferences" },
        { title: "Privacy", desc: "Control your privacy settings" },
    ];

    const helpCards: HelpCard[] = [
        {
            title: "Architecture Docs",
            desc: "Open the system architecture reference (services, flows, ports).",
            href: "/architecture",
            external: true,
        },
        {
            title: "Contact Support",
            desc: "Get help from our support team.",
        },
    ];

    const handleHelpCardClick = (card: HelpCard) => {
        if (!card.href) return;
        const target = card.external ? "_blank" : "_self";
        const features = card.external ? "noopener,noreferrer" : undefined;
        window.open(card.href, target, features ?? undefined);
    };

    return (
        <div className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center px-4 py-8">
            <div
                className="absolute inset-0 z-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />
            <div className="relative z-10 w-full max-w-3xl">
                <Card className="relative flex h-[min(38rem,82vh)] w-full overflow-hidden rounded-[20px] border border-border/60 bg-card text-foreground shadow-2xl animate-scale-in">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Close profile panel"
                        onClick={onClose}
                        className="absolute right-4 top-4 z-20 h-9 w-9 rounded-full text-muted-foreground shadow-sm transition hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0 focus-visible:outline-none"
                    >
                        <X size={18} />
                    </Button>
                    <div className="relative z-10 flex h-full w-full">
                        <aside
                            className={cn(
                                "relative flex h-full flex-col border-r border-border/50 bg-muted/30 px-2.5 py-4 transition-[width,padding] duration-300 ease-in-out",
                                navCollapsed ? "w-16 px-2" : "w-48"
                            )}
                        >
                            <ScrollArea className="h-full">
                                <div className="flex h-full flex-col pt-6">
                                <div
                                    className={cn(
                                        "relative mb-6 h-24 pb-1.5 transition-opacity duration-200",
                                        navCollapsed ? "opacity-0 pointer-events-none" : "opacity-100"
                                    )}
                                >
                                        <div
                                        className="flex flex-col items-center gap-3 text-center"
                                    >
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

                                <nav className="flex flex-1 flex-col items-start justify-start gap-0 pt-0">
                                        {navItems.map((tab) => {
                                            const Icon = tab.icon;
                                            const isActive = activeTab === tab.id;
                                            const iconSize = 20;
                                            const isLightTheme = theme === "light";
                                            const isHovered = hoveredNavId === tab.id;

                                            const mcpVariant: McpIconVariant =
                                                tab.id === "mcp"
                                                    ? isActive
                                                        ? "magenta"
                                                        : isHovered
                                                            ? isLightTheme
                                                                ? "black"
                                                                : "white"
                                                            : isLightTheme
                                                                ? "grey"
                                                                : "darkGrey"
                                                    : "grey";

                                            return (
                                                <button
                                                    key={tab.id}
                                                    onClick={() => setActiveTab(tab.id)}
                                                    onMouseEnter={() => setHoveredNavId(tab.id)}
                                                    onMouseLeave={() => setHoveredNavId((prev) => (prev === tab.id ? null : prev))}
                                                    className={cn(
                                                        "group relative grid w-full grid-cols-[auto,1fr] items-center gap-2 rounded-xl px-2 py-1 text-left text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface))]",
                                                        navCollapsed && "grid-cols-[auto,0fr] justify-items-center",
                                                        isActive ? "text-primary hover:bg-transparent hover:text-primary focus-visible:bg-transparent" : ""
                                                    )}
                                                    aria-label={tab.label}
                                                    style={navCollapsed ? { height: "2.5rem" } : { height: "2.75rem" }}
                                                >
                                                    <div
                                                        className={cn(
                                                            "flex h-8 w-8 items-center justify-center rounded-lg border border-transparent transition-colors",
                                                            isActive
                                                                ? "border-primary/50 bg-primary/10 text-primary"
                                                                : "text-muted-foreground group-hover:text-foreground"
                                                        )}
                                                    >
                                                        {tab.id === "mcp" ? (
                                                            <McpIcon size={20} variant={mcpVariant} />
                                                        ) : (
                                                            <Icon size={18} />
                                                        )}
                                                    </div>
                                                    <span
                                                        className={cn(
                                                            "overflow-hidden text-[0.7rem] font-semibold uppercase tracking-[0.22em] transition-opacity duration-200 ease-in-out",
                                                            navCollapsed ? "opacity-0" : "opacity-100"
                                                        )}
                                                    >
                                                        {tab.label}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </nav>

                                    <Tooltip delayDuration={0}>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={onLogout}
                                                className={cn(
                                                    "mt-auto grid w-full grid-cols-[auto,1fr] items-center gap-2 rounded-xl px-2 py-1 text-left text-[0.9rem] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:bg-[hsl(var(--hover-surface))]",
                                                    navCollapsed && "grid-cols-[auto,0fr] justify-items-center"
                                                )}
                                                aria-label="Logout"
                                                style={navCollapsed ? { height: "2.5rem" } : { height: "2.75rem" }}
                                            >
                                                <div
                                                    className={cn(
                                                        "flex h-8 w-8 items-center justify-center rounded-lg border border-transparent transition-colors",
                                                        "text-muted-foreground group-hover:text-foreground"
                                                    )}
                                                >
                                                    <LogOut className="h-[18px] w-[18px]" />
                                                </div>
                                                <span
                                                    className={cn(
                                                        "overflow-hidden text-[0.7rem] font-semibold uppercase tracking-[0.22em] transition-all duration-200 ease-in-out",
                                                        navCollapsed ? "w-0 max-w-0 overflow-hidden opacity-0" : "opacity-100"
                                                    )}
                                                >
                                                    Logout
                                                </span>
                                            </button>
                                        </TooltipTrigger>
                                    </Tooltip>
                                </div>
                            </ScrollArea>
                        </aside>

                        <div className="relative flex-1 overflow-hidden">
                            <ScrollArea className="h-full w-full">
                                <div className="space-y-6 px-5 py-6 text-foreground sm:px-8">
                                    {activeTab === "profile" && (
                                        <div className="space-y-8 animate-fade-in">
                                                <div className="space-y-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                    Overview
                                                </p>
                                                <div className="rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm">
                                                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                                                        <div className="flex items-center gap-5">
                                                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/50 bg-gradient-to-br from-white/5 via-transparent to-transparent text-muted-foreground">
                                                                <User size={24} />
                                                            </div>
                                                            <div className="flex flex-col gap-1 text-left">
                                                                <h3 className="text-base font-semibold leading-snug break-words whitespace-normal">{displayName}</h3>
                                                                <p className="text-[0.7rem] text-muted-foreground break-words whitespace-normal">{displayEmail}</p>
                                                                <span className="inline-flex items-center rounded-full bg-muted/60 px-2.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                                                                    {displayRole}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="space-y-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                    Profile Details
                                                </p>
                                                <div className="rounded-2xl border border-border/60 bg-card/60 p-4 shadow-sm">
                                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                        {profileFields.map((field) => (
                                                            <div
                                                                key={field.label}
                                                                className="rounded-xl border border-border/40 bg-background/40 p-3"
                                                            >
                                                                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                                                                    {field.label}
                                                                </span>
                                                                <p
                                                                    className={cn(
                                                                        "mt-1 text-[0.78rem] font-semibold break-words whitespace-normal",
                                                                        field.value === NA ? "text-muted-foreground" : "text-foreground"
                                                                    )}
                                                                >
                                                                    {field.value}
                                                                </p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "mcp" && (
                                            <div className="space-y-6 animate-fade-in">
                                                <div className="space-y-2 border-b border-border/60 pb-4">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                        Integration
                                                    </p>
                                                <h3 className="text-lg font-semibold">MCP Tools</h3>
                                                    <p className="text-[0.7rem] text-muted-foreground">
                                                        Review the live tool catalog exposed by the MCP server and decide which ones stay active.
                                                    </p>
                                                </div>

                                            <div className="space-y-3">
                                                {availableTools.length === 0 ? (
                                                    <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-4 py-8 text-center">
                                                        <p className="text-sm text-muted-foreground">
                                                            No tools discovered yet. Ensure the MCP tools server is running and refresh after login.
                                                        </p>
                                                    </div>
                                                ) : (
                                                    Object.entries(
                                                        availableTools.reduce<Record<string, ToolWithStatus[]>>((acc, tool) => {
                                                            const serverKey = tool.serverId || "default";
                                                            if (!acc[serverKey]) acc[serverKey] = [];
                                                            acc[serverKey].push(tool);
                                                            return acc;
                                                        }, {})
                                                    ).map(([serverKey, tools]) => {
                                                        const collapsed = serverCollapsed[serverKey] ?? false;
                                                        const serverLabel = serverKey === "default" ? "Unassigned Server" : serverKey;
                                                        const serverDisplayName = serverLabel.toUpperCase();
                                                        return (
                                                            <div key={serverKey} className="px-3 py-1">
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setServerCollapsed((prev) => ({
                                                                            ...prev,
                                                                            [serverKey]: !collapsed,
                                                                        }))
                                                                    }
                                                                    className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/20"
                                                                >
                                                                    <div className="flex flex-wrap items-baseline gap-3">
                                                                        <p className="text-sm font-semibold text-foreground">{serverDisplayName}</p>
                                                                        <p className="text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                                                                            {tools.length} tool{tools.length === 1 ? "" : "s"}
                                                                        </p>
                                                                    </div>
                                                                    <ChevronDown
                                                                        size={16}
                                                                        className={cn(
                                                                            "text-muted-foreground transition-transform",
                                                                            collapsed ? "-rotate-90" : "rotate-0"
                                                                        )}
                                                                    />
                                                                </button>
                                                                {!collapsed && (
                                                                    <div className="mt-2 space-y-2">
                                                                        {tools.map((tool: ToolWithStatus, idx) => {
                                                                            const uniqueKey = toolKey(tool);
                                                                            const enabled = typeof tool.enabled === "boolean" ? tool.enabled : !preferencesDisabledKeys.has(uniqueKey);
                                                                            const parameterCount = Math.max(0, tool.parameterCount ?? 0);
                                                                            const parameterLabel =
                                                                                parameterCount === 0
                                                                                    ? "0 parameters"
                                                                                    : `${parameterCount} parameter${parameterCount > 1 ? "s" : ""}`;
                                                                            const description = (tool.description || "").trim() || "No description provided.";
                                                                            const maxDescriptionLength = 150;
                                                                            const isTruncated = description.length > maxDescriptionLength;
                                                                            const showFull = expandedDescriptions[uniqueKey] ?? false;
                                                                            const displayText = showFull || !isTruncated ? description : description.slice(0, maxDescriptionLength);
                                                                            const fadeTailCount = 20;
                                                                            const headText = !showFull && isTruncated
                                                                                ? displayText.slice(0, Math.max(0, displayText.length - fadeTailCount))
                                                                                : displayText;
                                                                            const tailText = !showFull && isTruncated
                                                                                ? displayText.slice(Math.max(0, displayText.length - fadeTailCount))
                                                                                : "";
                                                                            const tailFadeStyle = {
                                                                                WebkitMaskImage:
                                                                                    "linear-gradient(90deg, #000 0%, #000 30%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.25) 80%, rgba(0,0,0,0) 90%, transparent 100%)",
                                                                                maskImage:
                                                                                    "linear-gradient(90deg, #000 0%, #000 30%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.25) 80%, rgba(0,0,0,0) 90%, transparent 100%)",
                                                                            } as React.CSSProperties;
                                                                            return (
                                                                                <div key={uniqueKey} className="px-1 py-2">
                                                                                    <div className="grid grid-cols-[auto,1fr,auto] gap-4">
                                                                                        <div className="flex w-4 justify-center pt-2">
                                                                                            <span
                                                                                                className={cn(
                                                                                                    "h-2.5 w-2.5 rounded-full transition-colors",
                                                                                                    enabled ? "bg-emerald-400" : "bg-muted-foreground/40"
                                                                                                )}
                                                                                            />
                                                                                        </div>
                                                                                        <div className="flex-1 space-y-1.5">
                                                                                            <div className="flex flex-wrap items-center gap-2">
                                                                                                <p className="text-sm font-semibold text-foreground">{tool.toolName}</p>
                                                                                                <span className="text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                                                                                                    {parameterLabel}
                                                                                                </span>
                                                                                            </div>
                                                                                            <div className="relative text-sm text-muted-foreground break-words whitespace-normal">
                                                                                                <span>{headText}</span>
                                                                                                {!showFull && isTruncated ? (
                                                                                                    <span className="inline-flex items-center align-middle">
                                                                                                        <span className="inline-block" style={tailFadeStyle}>
                                                                                                            {tailText}
                                                                                                        </span>
                                                                                                        <button
                                                                                                            type="button"
                                                                                                            onClick={() =>
                                                                                                                setExpandedDescriptions((prev) => ({
                                                                                                                    ...prev,
                                                                                                                    [uniqueKey]: true,
                                                                                                                }))
                                                                                                            }
                                                                                                            className="ml-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-0"
                                                                                                        >
                                                                                                            See more
                                                                                                        </button>
                                                                                                    </span>
                                                                                                ) : null}
                                                                                            </div>
                                                                                        </div>
                                                                                        <button
                                                                                            type="button"
                                                                                            role="switch"
                                                                                            aria-checked={enabled}
                                                                                            onClick={() => !preferencesSaving && handleToggleServer(tool)}
                                                                                            aria-disabled={preferencesSaving}
                                                                                            className={cn(
                                                                                                "relative inline-flex h-6 w-11 items-center self-center rounded-full border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                                                                                enabled ? "border-primary/50 bg-primary/20" : "border-border/70 bg-muted/70",
                                                                                                preferencesSaving && "opacity-60 cursor-not-allowed"
                                                                                            )}
                                                                                        >
                                                                                            <span
                                                                                                className={cn(
                                                                                                    "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
                                                                                                    enabled ? "translate-x-[1.4rem] bg-primary" : "translate-x-1 bg-muted-foreground/60"
                                                                                                )}
                                                                                            />
                                                                                        </button>
                                                                                    </div>
                                                                                    {idx < tools.length - 1 && (
                                                                                        <div className="pointer-events-none mx-auto mt-2 h-px w-[96%] rounded-full bg-gradient-to-r from-transparent via-border/60 to-transparent" />
                                                                                    )}
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "appearance" && (
                                            <div className="space-y-6 animate-fade-in">
                                                <div className="space-y-2 border-b border-border/60 pb-4">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                        Personalization
                                                    </p>
                                                <h3 className="text-lg font-semibold">Appearance Settings</h3>
                                                    <p className="text-[0.7rem] text-muted-foreground">
                                                        Choose a theme that matches your workspace.
                                                    </p>
                                                </div>

                                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                {themeOptions.map((themeOption) => {
                                                    const Icon = themeOption.icon;
                                                    const isActive = theme === themeOption.value;

                                                    return (
                                                        <button
                                                            key={themeOption.value}
                                                            onClick={() => setTheme(themeOption.value)}
                                                            className={cn(
                                                                "flex flex-col items-center gap-2 rounded-xl border px-5 py-5 text-center transition-colors",
                                                                isActive
                                                                    ? "border-primary/60 bg-primary/10 text-foreground"
                                                                    : "border-border/60 bg-card hover:border-primary/40 hover:bg-muted/40"
                                                            )}
                                                        >
                                                            <div
                                                                className={cn(
                                                                    "flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 text-muted-foreground transition-colors",
                                                                    isActive && "border-primary bg-primary/20 text-primary"
                                                                )}
                                                            >
                                                                <Icon size={22} />
                                                            </div>
                                                            <span className="text-[0.78rem] font-semibold uppercase tracking-[0.22em]">
                                                                {themeOption.name}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                                {isActive ? "Active theme" : "Switch theme"}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "settings" && (
                                            <div className="space-y-6 animate-fade-in">
                                                <div className="space-y-2 border-b border-border/60 pb-4">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                        Configuration
                                                    </p>
                                                <h3 className="text-lg font-semibold">General Settings</h3>
                                                    <p className="text-[0.7rem] text-muted-foreground">
                                                        Configure your application preferences.
                                                    </p>
                                                </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {settingsCards.map((setting) => (
                                                    <div
                                                        key={setting.title}
                                                        className="rounded-2xl border border-border/60 bg-card p-5 text-left shadow-sm"
                                                    >
                                                        <h4 className="text-[0.95rem] font-semibold">{setting.title}</h4>
                                                        <p className="mt-2 text-[0.7rem] text-muted-foreground">{setting.desc}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "help" && (
                                        <div className="space-y-6 animate-fade-in">
                                                <div className="space-y-2 border-b border-border/60 pb-4">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                        Guidance
                                                    </p>
                                                <h3 className="text-lg font-semibold">Help & Support</h3>
                                                    <p className="text-[0.7rem] text-muted-foreground">
                                                        Get assistance and learn more.
                                                    </p>
                                                </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {helpCards.map((help) => {
                                                    if (help.href) {
                                                        return (
                                                            <button
                                                                type="button"
                                                                key={help.title}
                                                                onClick={() => handleHelpCardClick(help)}
                                                                className="relative flex h-full flex-col gap-2 rounded-2xl border border-border/60 bg-card p-5 text-left shadow-sm transition hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                                                aria-label={`${help.title} (opens in new tab)`}
                                                            >
                                                                <h4 className="text-base font-semibold">{help.title}</h4>
                                                                <p className="text-[0.7rem] text-muted-foreground">{help.desc}</p>
                                                                {help.external && (
                                                                    <span className="pointer-events-none absolute bottom-4 right-4 inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                                                                        <ExternalLink size={14} aria-hidden="true" />
                                                                        <span className="sr-only">Opens in new tab</span>
                                                                    </span>
                                                                )}
                                                            </button>
                                                        );
                                                    }

                                                    return (
                                                        <div
                                                            key={help.title}
                                                            className="rounded-2xl border border-border/60 bg-card p-5 text-left shadow-sm"
                                                        >
                                                            <h4 className="text-[0.95rem] font-semibold">{help.title}</h4>
                                                            <p className="mt-2 text-[0.7rem] text-muted-foreground">{help.desc}</p>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
