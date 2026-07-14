import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
    Bell,
    Brain,
    Database,
    Gauge,
    HardDrive,
    KeyRound,
    Palette,
    Puzzle,
    Shield,
    SlidersHorizontal,
    Sparkles,
    User,
    Waves,
    type LucideProps,
} from "lucide-react";

import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { MCP_VARIANTS, MOBILE_PROFILE_NAV_BREAKPOINT, type McpIconVariant } from "@/shared/lib/consts";
import { McpIcon } from "./icons";

type NavItem = {
    id: string;
    label: string;
    icon?: ComponentType<LucideProps>;
};

/**
 * The settings taxonomy mirrors ChatGPT's left-nav section list (minus the
 * consumer-only sections that have no meaning here; not-yet-built sections
 * render a ComingSoon page), followed by a "Workspace" group for the sections
 * that are ours alone (Skills, MCP, Memory). Shortcuts and Help are NOT
 * settings sections — they open as dedicated panels from the sidebar profile
 * menu — and logout lives only in that menu.
 */
export const SETTINGS_NAV_ITEMS: readonly NavItem[] = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "personalization", label: "Personalization", icon: Palette },
    { id: "plugins", label: "Plugins", icon: Puzzle },
    { id: "voice", label: "Voice", icon: Waves },
    { id: "usage", label: "Usage", icon: Gauge },
    { id: "data-controls", label: "Data controls", icon: Database },
    { id: "storage", label: "Storage", icon: HardDrive },
    { id: "safety", label: "Safety", icon: Shield },
    { id: "security", label: "Security", icon: KeyRound },
    { id: "account", label: "Account", icon: User },
] as const;

export const WORKSPACE_NAV_ITEMS: readonly NavItem[] = [
    { id: "skills", label: "Skills", icon: Sparkles },
    { id: "mcp", label: "MCP Servers" }, // custom McpIcon, rendered specially
    { id: "memories", label: "Memory", icon: Brain },
] as const;

export const NAV_ITEMS: readonly NavItem[] = [...SETTINGS_NAV_ITEMS, ...WORKSPACE_NAV_ITEMS];

/**
 * Vertical rails scroll inside a ScrollArea; the mobile strip must NOT — Radix
 * ScrollArea wraps its content in a `display:table` div that ignores `min-w-0`
 * and grows to the strip's full content width, spilling the nav (and its
 * scrollbar) under the panel's close button. The strip scrolls itself
 * horizontally, so on mobile the children render bare.
 */
const RailWrapper = ({ mobile, children }: { mobile: boolean; children: ReactNode }) =>
    mobile ? (
        <>{children}</>
    ) : (
        // The overlay scrollbar renders at the ScrollArea's right edge — exactly
        // where the nav pills end. -mr-2 shifts the slimmed 6px bar OUT into the
        // aside's 10px padding gutter (px-2.5), centered, clear of the pills.
        <ScrollArea className="min-h-0 flex-1" scrollBarClassName="w-1.5 border-l-0 p-0 -mr-2">
            {children}
        </ScrollArea>
    );

type ProfileSidebarProps = {
    normalizedActiveTab: string;
    setActiveTab: (tabId: string) => void;
};

export default function ProfileSidebar({ normalizedActiveTab, setActiveTab }: ProfileSidebarProps) {
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

    // Labeled divider above a nav group: a text+line row when expanded, a short
    // centered line in the icon rail, a small vertical separator in the mobile strip.
    const renderGroupDivider = (label: string) => (
        <div
            key={`divider-${label}`}
            className={cn(
                "mb-1 mt-3 w-full max-[639px]:mx-0.5 max-[639px]:my-0 max-[639px]:w-auto max-[639px]:flex-none",
                navCollapsed && "flex justify-center"
            )}
        >
            {navCollapsed ? (
                <div
                    className="h-px w-8 bg-white/12 max-[639px]:h-5 max-[639px]:w-px max-[639px]:bg-white/15"
                    aria-hidden
                />
            ) : (
                <div className="flex items-center gap-2 px-2">
                    <span className="text-[0.56rem] font-semibold uppercase tracking-[0.22em] text-white/35">
                        {label}
                    </span>
                    <span className="h-px flex-1 bg-white/10" aria-hidden />
                </div>
            )}
        </div>
    );

    const renderNavItem = (item: NavItem) => {
        const isActive = normalizedActiveTab === item.id;
        const isHovered = hoveredNavId === item.id;
        const iconSize = mobileProfileNav ? 15 : 17;
        // The panel shell is always dark, so MCP icon variants are pinned dark.
        const mcpVariant: McpIconVariant =
            item.id === "mcp"
                ? isActive
                    ? MCP_VARIANTS.active
                    : isHovered
                      ? MCP_VARIANTS.hoverDark
                      : MCP_VARIANTS.idleDark
                : MCP_VARIANTS.idleDark;

        const Icon = item.icon;
        const iconNode =
            item.id === "mcp" ? (
                <McpIcon size={mobileProfileNav ? 16 : 19} variant={mcpVariant} />
            ) : Icon ? (
                <Icon size={iconSize} />
            ) : null;

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
                            // Identical geometry expanded AND collapsed (grid + px-2): the
                            // icon column never moves — collapsing only hides the label, so
                            // the icons read as frozen in place, like the main app sidebar.
                            // gap-0 when collapsed: with the label gone, the leftover column
                            // gap would push the button's min-content past the 2.75rem rail
                            // (ScrollArea's display:table wrapper grows to min-content) and
                            // clip the active pill on the right.
                            "group grid h-9 w-full grid-cols-[auto,1fr] items-center overflow-hidden rounded-xl px-2 py-1 text-left font-medium transition-colors focus-visible:outline-none",
                            navCollapsed ? "gap-0" : "gap-2",
                            "max-[639px]:flex max-[639px]:h-8 max-[639px]:w-auto max-[639px]:flex-none max-[639px]:gap-1 max-[639px]:overflow-visible max-[639px]:px-1.5",
                            // Simple, instant selection: a static background on the active
                            // row — identical in the left rail and the mobile strip.
                            isActive
                                ? "bg-white/[0.09] text-white"
                                : "text-white/55 hover:bg-white/[0.05] hover:text-white focus-visible:bg-white/[0.05] focus-visible:text-white"
                        )}
                        aria-label={item.label}
                        aria-current={isActive ? "page" : undefined}
                    >
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg max-[639px]:h-6 max-[639px]:w-6">
                            {iconNode}
                        </div>
                        {navCollapsed ? (
                            <span className="sr-only min-w-0 whitespace-nowrap text-[0.66rem] font-semibold uppercase tracking-[0.12em] max-[639px]:not-sr-only max-[639px]:relative max-[639px]:text-[0.58rem] max-[639px]:tracking-[0.1em]">
                                {item.label}
                            </span>
                        ) : (
                            <span className="min-w-0 whitespace-nowrap text-[0.66rem] font-semibold uppercase tracking-[0.12em]">
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
    };

    return (
        <aside
            className={cn(
                // px-2.5 is constant across states: aside 0.625rem + button px-2 0.5rem
                // puts the 1.75rem icon box at 1.125rem — exactly (4rem − 1.75rem)/2 in
                // the collapsed w-16 rail. Icons stay frozen in place; only width moves.
                "relative flex h-full flex-col border-r border-white/10 bg-white/[0.02] px-2.5 py-4 transition-[width] duration-300 ease-in-out max-[639px]:h-auto max-[639px]:w-full max-[639px]:flex-none max-[639px]:border-b max-[639px]:border-white/10 max-[639px]:border-r-0 max-[639px]:py-2 max-[639px]:pl-3 max-[639px]:pr-16",
                navCollapsed ? "w-16" : "w-60"
            )}
        >
            {/* Fixed brand header — OUTSIDE the scroll region so it never scrolls
                away, and constant-height in both rail states so the nav below never
                shifts vertically. pl-0.5 makes the logo lead 0.75rem — exactly
                (4rem − 2.5rem logo box)/2 — so the mark is frozen in place AND
                centered when the rail collapses; only the text fades out. */}
            <div className="mb-3 flex shrink-0 items-center gap-3 pl-0.5 max-[639px]:hidden">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-gradient-to-br from-white/10 via-transparent to-transparent">
                    <img
                        src="/logo2_white_magentaX.png"
                        alt="mAgenticX mark"
                        className="h-7 w-7 object-contain drop-shadow-[0_4px_12px_rgba(255,0,123,0.45)]"
                    />
                </div>
                <div
                    className={cn(
                        "min-w-0 overflow-hidden transition-opacity duration-200",
                        navCollapsed ? "w-0 opacity-0" : "opacity-100"
                    )}
                >
                    <h2 className="truncate text-sm font-semibold tracking-tight text-white">Settings</h2>
                    <p className="whitespace-nowrap text-[0.58rem] uppercase tracking-[0.2em] text-white/40">mAgenticX</p>
                </div>
            </div>

            <RailWrapper mobile={mobileProfileNav}>
                <div className="flex h-full flex-col max-[639px]:h-auto max-[639px]:min-w-0 max-[639px]:flex-row max-[639px]:items-center max-[639px]:gap-1.5">
                    <nav
                        className={cn(
                            // Mobile: one horizontal, scrollable strip (no wrapping) with a
                            // thin scrollbar — keeps the top rail short on small screens.
                            "flex flex-1 flex-col items-stretch justify-start gap-0.5 pt-0",
                            "max-[639px]:min-w-0 max-[639px]:flex-row max-[639px]:flex-nowrap max-[639px]:items-center max-[639px]:gap-1 max-[639px]:overflow-x-auto max-[639px]:pb-1",
                            "max-[639px]:[scrollbar-width:thin] max-[639px]:[scrollbar-color:rgba(255,255,255,0.22)_transparent]",
                            "[&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20"
                        )}
                    >
                        {SETTINGS_NAV_ITEMS.map(renderNavItem)}

                        {/* Workspace group — sections that are ours, beyond the mirrored taxonomy. */}
                        {renderGroupDivider("Workspace")}
                        {WORKSPACE_NAV_ITEMS.map(renderNavItem)}
                    </nav>
                </div>
            </RailWrapper>
        </aside>
    );
}
