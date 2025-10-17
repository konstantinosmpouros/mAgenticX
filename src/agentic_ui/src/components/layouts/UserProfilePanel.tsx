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
} from "lucide-react";
import { useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { UserProfile } from "@/lib/types";

type Props = {
    open: boolean;
    onClose: () => void;
    activeTab: string;
    setActiveTab: (tabId: string) => void;
    onLogout: () => void;
    user: UserProfile | null;
};

export default function UserProfilePanel({
    open,
    onClose,
    activeTab,
    setActiveTab,
    onLogout,
    user,
}: Props) {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
    const { theme, setTheme } = useTheme();

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
        <div className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center px-4 py-10 dark">
            <div
                className="absolute inset-0 z-0 bg-[rgba(10,12,18,0.82)] backdrop-blur-[18px] transition-opacity"
                onClick={onClose}
            />
            <div className="relative z-10 w-full max-w-5xl">
                <Card className="relative flex h-[min(46rem,85vh)] w-full overflow-hidden rounded-[32px] border border-white/12 bg-gradient-to-br from-[#1e212b]/94 via-[#12151d]/97 to-[#090b12]/98 text-white shadow-[0_44px_120px_-46px_rgba(5,8,15,0.9)] backdrop-blur-[30px] animate-scale-in">
                    <div
                        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.18)_0%,_rgba(16,22,33,0)_70%)] opacity-75"
                        aria-hidden="true"
                    />
                    <div
                        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_bottom,_rgba(140,140,155,0.15)_0%,_rgba(12,18,28,0)_72%)] opacity-55 mix-blend-lighten"
                        aria-hidden="true"
                    />
                    <div
                        className="pointer-events-none absolute inset-x-20 bottom-[-5rem] h-48 rounded-full bg-white/12 blur-[120px] opacity-70"
                        aria-hidden="true"
                    />

                    <div className="relative z-10 flex h-full w-full">
                        <aside
                            className={cn(
                                "relative flex h-full flex-col border-r border-white/12 bg-[linear-gradient(210deg,rgba(34,38,46,0.92),rgba(12,15,22,0.96))] px-3 py-8 backdrop-blur-2xl transition-all duration-500 ease-in-out",
                                sidebarCollapsed ? "w-[4.5rem]" : "w-64"
                            )}
                            onMouseEnter={() => setSidebarCollapsed(false)}
                            onMouseLeave={() => setSidebarCollapsed(true)}
                        >
                            <div
                                className="pointer-events-none absolute inset-0 bg-[linear-gradient(188deg,rgba(255,255,255,0.08)_0%,rgba(19,23,33,0.45)_46%,rgba(12,16,24,0.82)_100%)] opacity-90"
                                aria-hidden="true"
                            />
                            <div
                                className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-white/25 to-transparent"
                                aria-hidden="true"
                            />

                            <Button
                                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                                size="icon"
                                variant="ghost"
                                className="absolute top-5 right-2 z-20 h-8 w-8 rounded-full border border-white/15 bg-[linear-gradient(145deg,rgba(46,52,64,0.55),rgba(14,18,26,0.86))] text-white/80 shadow-[0_18px_44px_-30px_rgba(8,11,18,0.8)] backdrop-blur transition hover:bg-[linear-gradient(145deg,rgba(60,66,78,0.58),rgba(16,20,28,0.9))] hover:text-white"
                            >
                                {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                            </Button>

                            <div className="relative z-10 flex h-full flex-col">
                                <div className="relative h-32 pb-2.5">
                                    <div
                                        className={cn(
                                            "absolute inset-0 flex flex-col items-center gap-4 text-center transition-all duration-300",
                                            sidebarCollapsed
                                                ? "translate-y-2 opacity-0"
                                                : "translate-y-0 opacity-100"
                                        )}
                                    >
                                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/25 bg-gradient-to-br from-white/30 via-white/12 to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
                                            <img
                                                src="/logo2.png"
                                                alt="mAgenticX mark"
                                                className="h-9 w-9 object-contain"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <h2 className="text-base font-semibold tracking-tight text-white">
                                                mAgenticX Profile
                                            </h2>
                                            <p className="text-[0.7rem] uppercase tracking-[0.28em] text-white/60">
                                                Manage your space
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <nav className="flex-1 space-y-2.5">
                                    {navItems.map((tab) => {
                                        const Icon = tab.icon;
                                        const isActive = activeTab === tab.id;

                                        return (
                                            <button
                                                key={tab.id}
                                                onClick={() => setActiveTab(tab.id)}
                                                className={cn(
                                                    "group relative flex w-full items-center rounded-2xl py-2.5 transition-all duration-300",
                                                    sidebarCollapsed ? "justify-center px-1.5" : "px-3"
                                                )}
                                                title={sidebarCollapsed ? tab.label : undefined}
                                            >
                                                {!sidebarCollapsed && (
                                                    <div
                                                        className={cn(
                                                            "absolute inset-0 rounded-2xl border border-white/14 bg-white/[0.05] transition-all duration-300 group-hover:border-white/22 group-hover:bg-white/[0.07] group-hover:opacity-100",
                                                            isActive &&
                                                                "border-white/35 bg-white/[0.12] opacity-100 shadow-[0_26px_70px_-38px_rgba(10,12,18,0.7)]"
                                                        )}
                                                    />
                                                )}
                                                <div
                                                    className={cn(
                                                        "relative z-10 flex w-full items-center transition-all duration-300",
                                                        sidebarCollapsed ? "justify-center" : "gap-3"
                                                    )}
                                                >
                                                    <div
                                                        className={cn(
                                                            "flex h-10 w-10 items-center justify-center rounded-[1rem] border border-white/14 bg-white/[0.06] transition-all duration-300 group-hover:border-white/24 group-hover:bg-white/[0.09]",
                                                            isActive &&
                                                                "border-white/35 bg-white/[0.14] shadow-[0_20px_48px_-32px_rgba(8,11,18,0.75)]"
                                                        )}
                                                    >
                                                         <Icon
                                                             size={18}
                                                             className={cn(
                                                                "text-white/70 transition-colors duration-300",
                                                                isActive ? "text-white" : "group-hover:text-white"
                                                            )}
                                                        />
                                                    </div>
                                                    {!sidebarCollapsed && (
                                                        <span
                                                            className={cn(
                                                                "text-[0.66rem] font-semibold uppercase tracking-[0.32em] text-white/70 transition-colors duration-300",
                                                                isActive ? "text-white" : "group-hover:text-white"
                                                            )}
                                                        >
                                                            {tab.label}
                                                        </span>
                                                    )}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </nav>

                                <button
                                    onClick={onLogout}
                                    className={cn(
                                        "group relative mt-auto flex w-full items-center overflow-hidden rounded-2xl px-3 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-white/60 transition-all duration-300",
                                        sidebarCollapsed ? "justify-center" : "gap-3"
                                    )}
                                    title={sidebarCollapsed ? "Logout" : undefined}
                                >
                                    <div className="absolute inset-0 rounded-2xl border border-white/14 bg-white/[0.05] opacity-85 transition-all duration-300 group-hover:border-white/22 group-hover:bg-white/[0.08] group-hover:opacity-100" />
                                    <LogOut className="relative z-10 h-5 w-5 text-white/70 transition-colors group-hover:text-white" />
                                    {!sidebarCollapsed && (
                                        <span className="relative z-10 text-xs font-semibold uppercase tracking-[0.32em] text-white/75">
                                            Logout
                                        </span>
                                    )}
                                </button>
                            </div>
                        </aside>

                        <div className="relative flex-1 overflow-hidden">
                            <ScrollArea className="h-full w-full">
                                <div className="space-y-10 px-8 py-10 text-white/90 sm:px-12">
                                    {activeTab === "profile" && (
                                        <div className="space-y-10 animate-fade-in">
                                            <div className="flex flex-col gap-8 rounded-2xl border border-white/12 bg-white/[0.05] p-8 shadow-[0_36px_96px_-48px_rgba(6,8,14,0.82)] backdrop-blur-2xl sm:flex-row sm:items-center sm:justify-between">
                                                <div className="flex items-center gap-6">
                                                    <div className="flex h-24 w-24 items-center justify-center rounded-2xl border border-white/20 bg-white/[0.08] shadow-[0_24px_70px_-42px_rgba(7,9,15,0.75)]">
                                                        <User size={42} className="text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.24)]" />
                                                    </div>
                                                    <div className="flex flex-col gap-2 text-left">
                                                        <h3 className="text-3xl font-semibold tracking-tight text-white">
                                                            {displayName}
                                                        </h3>
                                                        <p className="text-sm text-white/70">{displayEmail}</p>
                                                        <p className="inline-flex items-center rounded-full border border-white/18 bg-white/[0.07] px-4 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-white/75">
                                                            {displayRole}
                                                        </p>
                                                    </div>
                                                </div>

                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="relative h-11 w-11 rounded-full border border-white/18 bg-white/[0.08] text-white/75 shadow-[0_24px_66px_-36px_rgba(8,11,18,0.75)] transition hover:border-white/26 hover:bg-white/[0.12] hover:text-white"
                                                >
                                                    <Edit size={16} />
                                                </Button>
                                            </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {profileFields.map((field) => (
                                                    <div
                                                        key={field.label}
                                                        className="space-y-4 rounded-2xl border border-white/12 bg-white/[0.04] p-6 backdrop-blur-xl transition hover:border-white/18 hover:bg-white/[0.07] hover:shadow-[0_30px_76px_-46px_rgba(8,11,18,0.7)]"
                                                    >
                                                        <span className="text-[0.62rem] font-semibold uppercase tracking-[0.32em] text-white/60">
                                                            {field.label}
                                                        </span>
                                                        <div className="rounded-xl border border-white/14 bg-white/[0.07] px-4 py-3 text-sm font-medium text-white">
                                                            {field.value}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "appearance" && (
                                        <div className="space-y-8 animate-fade-in">
                                            <div className="rounded-2xl border border-white/12 bg-white/[0.05] p-8 shadow-[0_34px_90px_-48px_rgba(6,8,14,0.82)] backdrop-blur-2xl">
                                                <h3 className="text-2xl font-semibold text-white">
                                                    Appearance Settings
                                                </h3>
                                                <p className="mt-2 text-sm text-white/65">
                                                    Customize your visual experience
                                                </p>

                                                <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                    {themeOptions.map((themeOption) => {
                                                        const Icon = themeOption.icon;
                                                        const isActive = theme === themeOption.value;

                                                        return (
                                                            <button
                                                                key={themeOption.value}
                                                                onClick={() => setTheme(themeOption.value)}
                                                                className={cn(
                                                                    "group relative flex flex-col items-center gap-4 rounded-2xl border px-6 py-8 text-center transition-all duration-300",
                                                                    isActive
                                                                        ? "border-white/35 bg-white/[0.1] shadow-[0_28px_72px_-40px_rgba(8,11,18,0.75)]"
                                                                        : "border-white/12 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.08] hover:shadow-[0_24px_60px_-40px_rgba(8,11,18,0.7)]"
                                                                )}
                                                            >
                                                                <div
                                                                    className={cn(
                                                                        "flex h-12 w-12 items-center justify-center rounded-xl border border-white/15 bg-white/[0.07] text-white/75 transition",
                                                                        isActive
                                                                            ? "border-white/40 text-white"
                                                                            : "group-hover:border-white/25 group-hover:text-white"
                                                                    )}
                                                                >
                                                                    <Icon size={24} />
                                                                </div>
                                                                <span
                                                                    className={cn(
                                                                        "text-sm font-semibold uppercase tracking-[0.26em]",
                                                                        isActive ? "text-white" : "text-white/70 group-hover:text-white"
                                                                    )}
                                                                >
                                                                    {themeOption.name}
                                                                </span>
                                                                {isActive && (
                                                                    <div className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-[#cdb2ff] shadow-[0_0_10px_rgba(205,178,255,0.6)]" />
                                                                )}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "settings" && (
                                        <div className="space-y-8 animate-fade-in">
                                            <div className="rounded-2xl border border-white/12 bg-white/[0.05] p-8 shadow-[0_34px_90px_-48px_rgba(6,8,14,0.82)] backdrop-blur-2xl">
                                                <h3 className="text-2xl font-semibold text-white">
                                                    General Settings
                                                </h3>
                                                <p className="mt-2 text-sm text-white/65">
                                                    Configure your application preferences
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {settingsCards.map((setting) => (
                                                    <div
                                                        key={setting.title}
                                                        className="rounded-2xl border border-white/12 bg-white/[0.04] p-8 text-left backdrop-blur-xl transition hover:border-white/18 hover:bg-white/[0.07] hover:shadow-[0_30px_76px_-46px_rgba(8,11,18,0.7)]"
                                                    >
                                                        <h4 className="text-lg font-semibold text-white">
                                                            {setting.title}
                                                        </h4>
                                                        <p className="mt-2 text-sm text-white/65">{setting.desc}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {activeTab === "help" && (
                                        <div className="space-y-8 animate-fade-in">
                                            <div className="rounded-2xl border border-white/12 bg-white/[0.05] p-8 shadow-[0_34px_90px_-48px_rgba(6,8,14,0.82)] backdrop-blur-2xl">
                                                <h3 className="text-2xl font-semibold text-white">
                                                    Help & Support
                                                </h3>
                                                <p className="mt-2 text-sm text-white/65">
                                                    Get assistance and learn more
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                                {helpCards.map((help) => (
                                                    <div
                                                        key={help.title}
                                                        className="rounded-2xl border border-white/12 bg-white/[0.04] p-8 text-left backdrop-blur-xl transition hover:border-white/18 hover:bg-white/[0.07] hover:shadow-[0_30px_76px_-46px_rgba(8,11,18,0.7)]"
                                                    >
                                                        <h4 className="text-lg font-semibold text-white">
                                                            {help.title}
                                                        </h4>
                                                        <p className="mt-2 text-sm text-white/65">{help.desc}</p>
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
