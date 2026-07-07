import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Brain, HelpCircle, Keyboard, LogOut, Palette, ShieldCheck, Sparkles, User } from "lucide-react";

import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { MCP_VARIANTS, MOBILE_PROFILE_NAV_BREAKPOINT, type McpIconVariant } from "@/shared/lib/consts";
import { McpIcon } from "./icons";

export const NAV_ITEMS = [
    { id: "profile", label: "Account", hint: "Identity and workspace" },
    { id: "appearance", label: "Personalization", hint: "Theme and defaults" },
    { id: "archived", label: "Data Controls", hint: "History and archive" },
    { id: "mcp", label: "MCP Servers", hint: "MCP tools and servers" },
    { id: "skills", label: "Skills", hint: "Available skill library" },
    { id: "memories", label: "Memories", hint: "What agents remember about you" },
    { id: "shortcuts", label: "Shortcuts", hint: "Keyboard commands" },
    { id: "help", label: "Help", hint: "Docs and support" },
] as const;

type ProfileSidebarProps = {
    normalizedActiveTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
};

export default function ProfileSidebar({ normalizedActiveTab, setActiveTab, onLogout }: ProfileSidebarProps) {
    const { theme } = useTheme();
    const currentTheme = theme === "dark" ? "dark" : "light";

    const [hoveredNavId, setHoveredNavId] = useState<string | null>(null);
    const [openNavTooltipId, setOpenNavTooltipId] = useState<string | null>(null);
    const navTooltipClickSuppressedUntilRef = useRef(0);
    const [navCollapsed, setNavCollapsed] = useState<boolean>(() =>
        typeof window !== "undefined" ? window.innerWidth < 960 : false
    );
    const [mobileProfileNav, setMobileProfileNav] = useState<boolean>(() =>
        typeof window !== "undefined" ? window.innerWidth < MOBILE_PROFILE_NAV_BREAKPOINT : false
    );

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

    const suppressCollapsedNavTooltip = () => {
        navTooltipClickSuppressedUntilRef.current = Date.now() + 350;
        setOpenNavTooltipId(null);
    };
    const canOpenCollapsedNavTooltip = () => Date.now() > navTooltipClickSuppressedUntilRef.current;

    return (
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
                        {NAV_ITEMS.map((item) => {
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
                                ) : item.id === "memories" ? (
                                    <Brain size={iconSize} />
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
    );
}
