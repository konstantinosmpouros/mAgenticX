import { ArrowDownToLine, Clock, FileText, FolderArchive, Loader2, type LucideIcon } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { useDataExport } from "@/features/settings/hooks/useDataExport";
import { describeCooldownWindow, formatAvailableAt } from "@/features/settings/lib/exportCooldown";
import { InfoCard, SoftPanel } from "./shared";

// Data controls → "Export data" (plan 27).
//
// The two exports are offered as option tiles rather than a pair of plain
// buttons: each one has to say what it contains, and a tile carries that line
// where a button label cannot. Built on a native <button> because the shadcn
// Button is a single-line, fixed-height control.

type ExportOptionProps = {
  icon: LucideIcon;
  title: string;
  detail: string;
  /** The recommended option: accent-tinted, with a filled icon chip. */
  emphasis?: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
};

function ExportOption({ icon: Icon, title, detail, emphasis = false, busy, disabled, onClick }: ExportOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      className={cn(
        "group flex min-h-[4.5rem] w-full items-center gap-3.5 rounded-[1.1rem] border px-4 py-3.5 text-left",
        "transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "enabled:active:scale-[0.99] motion-reduce:transition-none motion-reduce:enabled:active:scale-100",
        "disabled:cursor-not-allowed disabled:opacity-50",
        emphasis
          ? "border-primary/35 bg-primary/[0.07] enabled:hover:border-primary/60 enabled:hover:bg-primary/[0.12] enabled:hover:shadow-[0_10px_28px_-14px_hsl(var(--primary)/0.55)]"
          : "border-border/60 bg-background/40 enabled:hover:border-border enabled:hover:bg-[hsl(var(--hover-surface))]",
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
          emphasis ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-foreground/80",
        )}
      >
        {busy ? (
          <Loader2 className="h-[1.1rem] w-[1.1rem] animate-spin" aria-hidden />
        ) : (
          <Icon className="h-[1.1rem] w-[1.1rem]" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{detail}</span>
      </span>
      <ArrowDownToLine
        className={cn(
          "h-4 w-4 shrink-0 text-muted-foreground transition-[color,transform] duration-200 ease-out",
          "group-enabled:group-hover:translate-y-0.5 group-enabled:group-hover:text-foreground motion-reduce:transition-none",
        )}
        aria-hidden
      />
    </button>
  );
}

export function ExportDataCard({ userId }: { userId: string | null }) {
  const dataExport = useDataExport(userId);
  const readyAt = dataExport.status?.availableAt ? new Date(dataExport.status.availableAt) : null;
  const blocked = !dataExport.status?.enabled || readyAt !== null || dataExport.preparing !== null;

  const note = dataExport.loading
    ? "Checking export availability…"
    : !dataExport.status?.enabled
      ? "Data export is turned off right now."
      : `Large accounts can take a few minutes. One export per ${describeCooldownWindow(dataExport.status.cooldownMinutes)}, with or without attachments.`;

  return (
    <InfoCard
      eyebrow="Your data"
      title="Export data"
      description="Download a copy of your conversations, files, agents, skills and settings as one .zip."
      headerAction={
        readyAt ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">Available {formatAvailableAt(readyAt)}</span>
          </span>
        ) : null
      }
    >
      <SoftPanel className="p-3 sm:p-4">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <ExportOption
            icon={FolderArchive}
            title="Everything"
            detail="Conversations, files, agents, skills and settings"
            emphasis
            busy={dataExport.preparing === "full"}
            disabled={blocked}
            onClick={() => void dataExport.start(true)}
          />
          <ExportOption
            icon={FileText}
            title="Without attachments"
            detail="Skips attached files — smaller and faster"
            busy={dataExport.preparing === "text"}
            disabled={blocked}
            onClick={() => void dataExport.start(false)}
          />
        </div>
        <p className="mt-3 px-1 text-xs text-muted-foreground">{note}</p>
        {dataExport.error ? (
          <p role="alert" className="mt-2 px-1 text-sm text-destructive">
            {dataExport.error}
          </p>
        ) : null}
      </SoftPanel>
    </InfoCard>
  );
}
