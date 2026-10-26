import type { ReactNode } from "react";
import { ArrowLeft, SearchX } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { SidebarTrigger } from "@/shared/ui/sidebar";
import { SoftPanel } from "@/features/settings/components/profile_parts/shared";
import { PRIMARY_BUTTON } from "@/features/agents/lib/styles";

/**
 * The chrome every Agents page shares — header, badge, the not-found state —
 * so the gallery, an agent's page and the builder read as one section, in the
 * same style as Schedules beside them.
 */

export function PageHeader({
  title,
  subtitle,
  icon,
  badge,
  back,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A leading tile, e.g. the agent's icon on its own page. */
  icon?: ReactNode;
  badge?: ReactNode;
  /** A link back up the section ("Agents", or the agent being edited). */
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
}) {
  return (
    <header className="relative flex-shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        {back ? (
          <button
            type="button"
            onClick={back.onClick}
            className="-ml-1.5 inline-flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ArrowLeft size={13} aria-hidden />
            {back.label}
          </button>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* On mobile the sidebar is an overlay sheet and this page covers
                ChatHeader's own trigger — the same md:hidden toggle Schedules
                carries, so there is always a way back to the sidebar. */}
            <SidebarTrigger
              aria-label="Toggle sidebar"
              className="inline-flex h-10 w-10 flex-shrink-0 rounded-xl bg-transparent text-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:ring-2 focus-visible:ring-ring md:hidden [&_svg]:size-5"
            />
            {icon}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                  {title}
                </h1>
                {badge}
              </div>
              {subtitle ? (
                <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>
              ) : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </header>
  );
}

/** Custom or Platform, the same pill on a card and on an agent's page. */
export function KindBadge({ custom, className }: { custom: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
        custom ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {custom ? "Custom" : "Platform"}
    </span>
  );
}

/**
 * An agent id that is not in the user's catalog: unknown, deleted, or someone
 * else's. One answer for all three — telling them apart would confirm that
 * another user's agent exists.
 */
export function AgentNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-10 sm:px-6">
      <SoftPanel className="px-6 py-12 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
          <SearchX size={19} aria-hidden />
        </span>
        <h1 className="text-base font-semibold text-foreground">Agent not found</h1>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          It may have been deleted, or the link is wrong. Your agents and the platform&apos;s are
          all in the gallery.
        </p>
        <button type="button" onClick={onBack} className={cn(PRIMARY_BUTTON, "mt-5")}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Agents
        </button>
      </SoftPanel>
    </div>
  );
}
