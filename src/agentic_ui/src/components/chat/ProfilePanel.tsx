import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    User,
    Edit,
    Settings,
    Palette,
    HelpCircle,
    LogOut,
    ChevronRight,
    ChevronLeft,
    Sparkles,
    MoonStar,
    ChevronDown,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { ToolMetadata, UserPreferences, UserProfile } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProfileSidebarCollapseEffect } from "@/components/handlers";

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
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [userCollapsed, setUserCollapsed] = useState(false);
    const [forcedCollapsed, setForcedCollapsed] = useState(false);
    const [hoveredNavId, setHoveredNavId] = useState<string | null>(null);
    const [serverCollapsed, setServerCollapsed] = useState<Record<string, boolean>>({});
    const { theme, setTheme } = useTheme();

    useProfileSidebarCollapseEffect({
        forcedCollapsed,
        setForcedCollapsed,
        setSidebarCollapsed,
        userCollapsed,
    });

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
                    next[serverKey] = serverKey in prev ? prev[serverKey] : false;
                }
            });
            return next;
        });
    }, [availableTools]);

    const handleToggleServer = (tool: ToolMetadata) => {
        onToggleToolPreference?.(tool);
    };


    const handleToggleSidebar = () => {
        if (forcedCollapsed) return;
        setSidebarCollapsed((prev) => {
            const next = !prev;
            setUserCollapsed(next);
            return next;
        });
    };

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

    const displayIsActive = fmtBoolean(user?.isActive);
    const displayPrefersAgentic = fmtBoolean(user?.prefersAgenticChat);

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

    const helpCards = [
        { title: "Documentation", desc: "Access user guides and tutorials" },
        { title: "Contact Support", desc: "Get help from our support team" },
    ];

    return (
        <div className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center px-4 py-10">
            <div
                className="absolute inset-0 z-0 bg-black/60 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />
            <div className="relative z-10 w-full max-w-5xl">
                <Card className="relative flex h-[min(46rem,85vh)] w-full overflow-hidden rounded-[28px] border border-border/60 bg-card text-foreground shadow-2xl animate-scale-in">
                    <div className="relative z-10 flex h-full w-full">
                        <aside
                            className={cn(
                                "relative flex h-full flex-col border-r border-border/50 bg-muted/30 px-3 py-6 transition-[width] duration-300 ease-in-out",
                                sidebarCollapsed ? "w-[4.5rem]" : "w-64"
                            )}
                        >
                            <Button
                                onClick={handleToggleSidebar}
                                size="icon"
                                variant="ghost"
                                disabled={forcedCollapsed}
                                className={cn(
                                    "absolute top-4 right-2 z-10 h-8 w-8 rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground",
                                    forcedCollapsed && "cursor-not-allowed opacity-70"
                                )}
                            >
                                {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                            </Button>

                            <ScrollArea className="h-full">
                                <div className="flex h-full flex-col pt-6">
                                <div className="relative h-28 pb-2">
                                    <div
                                        className={cn(
                                            "flex flex-col items-center gap-3 text-center transition-all duration-300",
                                            sidebarCollapsed ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
                                        )}
                                    >
                                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-gradient-to-br from-white/10 via-transparent to-transparent shadow-[0_10px_30px_-18px_rgba(0,0,0,0.8)]">
                                            <img
                                                src="/logo2_white_magentaX.png"
                                                alt="mAgenticX mark"
                                                className="h-10 w-10 object-contain drop-shadow-[0_4px_12px_rgba(255,0,123,0.45)]"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <h2 className="text-sm font-semibold tracking-tight">mAgenticX Profile</h2>
                                            <p className="text-[0.65rem] uppercase tracking-[0.25em] text-muted-foreground">
                                                Manage your space
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <nav className="flex flex-1 flex-col justify-start gap-1 pt-2.5">
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

                                        const navButton = (
                                            <button
                                                onClick={() => setActiveTab(tab.id)}
                                                onMouseEnter={() => setHoveredNavId(tab.id)}
                                                onMouseLeave={() => setHoveredNavId((prev) => (prev === tab.id ? null : prev))}
                                                className={cn(
                                                    "group relative flex w-full items-center rounded-xl py-1 text-sm font-medium text-muted-foreground transition-colors hover:!bg-[#262626] focus-visible:!bg-[#262626]",
                                                    sidebarCollapsed ? "justify-start pl-1 pr-0" : "justify-start px-2 text-left",
                                                    isActive ? "text-foreground hover:!bg-transparent focus-visible:!bg-transparent" : ""
                                                )}
                                                aria-label={tab.label}
                                            >
                                                <div
                                                    className={cn(
                                                        "flex w-full items-center transition-all duration-300",
                                                        sidebarCollapsed ? "gap-0" : "gap-3"
                                                    )}
                                                >
                                                    <div
                                                        className={cn(
                                                            "flex h-10 w-10 items-center justify-center rounded-lg border border-transparent transition-colors",
                                                            isActive
                                                                ? "border-primary/50 bg-primary/10 text-primary"
                                                                : "text-muted-foreground group-hover:text-foreground"
                                                        )}
                                                    >
                                                        {tab.id === "mcp" ? (
                                                            <McpIcon size={20} variant={mcpVariant} />
                                                        ) : (
                                                            <Icon size={iconSize} />
                                                        )}
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            "overflow-hidden transition-all duration-200",
                                                            sidebarCollapsed
                                                                ? "max-w-0 opacity-0 delay-0"
                                                                : "max-w-[220px] opacity-100 delay-200"
                                                        )}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "inline-block text-xs font-semibold uppercase tracking-[0.26em] whitespace-nowrap",
                                                                sidebarCollapsed ? "ml-0" : "ml-3"
                                                            )}
                                                        >
                                                            {tab.label}
                                                        </span>
                                                    </div>
                                                </div>
                                            </button>
                                        );

                                        return (
                                            <Fragment key={tab.id}>
                                                {sidebarCollapsed ? (
                                                    <Tooltip delayDuration={0}>
                                                        <TooltipTrigger asChild>{navButton}</TooltipTrigger>
                                                        <TooltipContent
                                                            side="right"
                                                            align="center"
                                                            className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground shadow-card"
                                                        >
                                                            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.32em]">
                                                                {tab.label}
                                                            </p>
                                                        </TooltipContent>
                                                    </Tooltip>
                                                ) : (
                                                    navButton
                                                )}
                                            </Fragment>
                                        );
                                    })}
                                </nav>

                                <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                            <button
                                                onClick={onLogout}
                                                className={cn(
                                                "mt-auto flex w-full items-center rounded-xl border border-border/60 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground transition-colors hover:border-border/40 hover:!bg-[#262626] hover:text-foreground",
                                                sidebarCollapsed ? "justify-start pl-3 pr-2 gap-0" : "gap-3 px-3"
                                            )}
                                            aria-label="Logout"
                                        >
                                            <LogOut className="h-5 w-5" />
                                            <div
                                                className={cn(
                                                    "overflow-hidden transition-all duration-200",
                                                    sidebarCollapsed
                                                        ? "max-w-0 opacity-0 delay-0"
                                                        : "max-w-[120px] opacity-100 delay-200"
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "inline-block whitespace-nowrap text-xs font-semibold uppercase tracking-[0.26em]",
                                                        sidebarCollapsed ? "ml-0" : "ml-3"
                                                    )}
                                                >
                                                    Logout
                                                </span>
                                            </div>
                                        </button>
                                    </TooltipTrigger>
                                    {sidebarCollapsed && (
                                        <TooltipContent
                                            side="right"
                                            align="center"
                                            className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground shadow-card"
                                        >
                                            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.32em]">
                                                Logout
                                            </p>
                                        </TooltipContent>
                                    )}
                                </Tooltip>
                            </div>
                            </ScrollArea>
                        </aside>

                        <div className="relative flex-1 overflow-hidden">
                            <ScrollArea className="h-full w-full">
                                <div className="space-y-8 px-8 py-10 text-foreground sm:px-12">
                                    {activeTab === "profile" && (
                                        <div className="space-y-8 animate-fade-in">
                                            <div className="space-y-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                    Overview
                                                </p>
                                                <div className="rounded-2xl border border-border/60 bg-card/70 p-6 shadow-sm">
                                                    <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                                                        <div className="flex items-center gap-5">
                                                            <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-border/50 bg-gradient-to-br from-white/5 via-transparent to-transparent text-muted-foreground">
                                                                <User size={36} />
                                                            </div>
                                                            <div className="flex flex-col gap-1 text-left">
                                                                <h3 className="text-2xl font-semibold">{displayName}</h3>
                                                                <p className="text-sm text-muted-foreground">{displayEmail}</p>
                                                                <span className="inline-flex items-center rounded-full bg-muted/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                                                                    {displayRole}
                                                                </span>
                                                            </div>
                                                        </div>

                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="flex h-11 items-center gap-2 rounded-full border-border/50 px-5 text-sm font-medium hover:!bg-[#262626] focus-visible:!bg-[#262626]"
                                                        >
                                                            <Edit size={16} />
                                                            Edit
                                                        </Button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="space-y-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                                                    Profile Details
                                                </p>
                                                <div className="rounded-2xl border border-border/60 bg-card/60 p-6 shadow-sm">
                                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                        {profileFields.map((field) => (
                                                            <div
                                                                key={field.label}
                                                                className="rounded-xl border border-border/40 bg-background/40 p-4"
                                                            >
                                                                <span className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                                                                    {field.label}
                                                                </span>
                                                                <p
                                                                    className={cn(
                                                                        "mt-1 text-base font-semibold",
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
                                                <h3 className="text-2xl font-semibold">MCP Tools</h3>
                                                <p className="text-sm text-muted-foreground">
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
                                                                        <p className="text-base font-semibold text-foreground">{serverDisplayName}</p>
                                                                        <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
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
                                                                                                <p className="text-base font-semibold text-foreground">{tool.toolName}</p>
                                                                                                <span className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                                                                                                    {parameterLabel}
                                                                                                </span>
                                                                                            </div>
                                                                                            <p className="text-sm text-muted-foreground">
                                                                                                {(tool.description || "").trim() || "No description provided."}
                                                                                            </p>
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
                                                <h3 className="text-2xl font-semibold">Appearance Settings</h3>
                                                <p className="text-sm text-muted-foreground">
                                                    Choose a theme that matches your workspace.
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                {themeOptions.map((themeOption) => {
                                                    const Icon = themeOption.icon;
                                                    const isActive = theme === themeOption.value;

                                                    return (
                                                        <button
                                                            key={themeOption.value}
                                                            onClick={() => setTheme(themeOption.value)}
                                                            className={cn(
                                                                "flex flex-col items-center gap-3 rounded-xl border px-6 py-6 text-center transition-colors",
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
                                                            <span className="text-sm font-semibold uppercase tracking-[0.24em]">
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
                                                <h3 className="text-2xl font-semibold">General Settings</h3>
                                                <p className="text-sm text-muted-foreground">
                                                    Configure your application preferences.
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {settingsCards.map((setting) => (
                                                    <div
                                                        key={setting.title}
                                                        className="rounded-2xl border border-border/60 bg-card p-6 text-left shadow-sm"
                                                    >
                                                        <h4 className="text-lg font-semibold">{setting.title}</h4>
                                                        <p className="mt-2 text-sm text-muted-foreground">{setting.desc}</p>
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
                                                <h3 className="text-2xl font-semibold">Help & Support</h3>
                                                <p className="text-sm text-muted-foreground">
                                                    Get assistance and learn more.
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {helpCards.map((help) => (
                                                    <div
                                                        key={help.title}
                                                        className="rounded-2xl border border-border/60 bg-card p-6 text-left shadow-sm"
                                                    >
                                                        <h4 className="text-lg font-semibold">{help.title}</h4>
                                                        <p className="mt-2 text-sm text-muted-foreground">{help.desc}</p>
                                                    </div>
                                                ))}
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
