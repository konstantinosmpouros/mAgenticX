import { cn, fmtBoolean, fmtDate, fmtDateTime, safeText } from "@/lib/utils";
import { NA } from "@/lib/consts";
import type { InfoRow, UserPreferences, UserProfile } from "@/lib/types";
import { InfoRowsCard } from "./shared";

type AccountTabProps = {
    user: UserProfile | null;
    userPreferences: UserPreferences;
};

export default function AccountTab({ user, userPreferences }: AccountTabProps) {
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
    const avatarInitial = (displayName !== NA ? displayName : "Profile").charAt(0).toUpperCase();

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

    return (
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
    );
}
