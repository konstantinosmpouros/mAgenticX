import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { NA } from "@/shared/lib/consts";
import type { InfoRow } from "@/shared/lib/types";

export const InfoCard = ({
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

export const SoftPanel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("rounded-[1.4rem] bg-muted/30", className)}>{children}</div>
);

export const InfoRowsCard = ({
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
                row.value === NA && "text-muted-foreground",
              )}
            >
              {row.value}
            </p>
            {row.hint ? <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p> : null}
          </div>
        </div>
      ))}
    </SoftPanel>
  </InfoCard>
);

export const MetricCard = ({
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

// Preference toggle switch — the pill switch used across settings tabs. Kept as
// one primitive so every toggle in settings stays visually identical.
//
// Two sizes because two genuinely different rows exist: `md` for a settings row
// with its own line, `sm` for the dense per-skill rows inside an agent card.
// They differ in more than scale (the small one signals an in-flight toggle with
// `cursor-wait`), so the variants carry their own classes rather than deriving
// one from the other.
export const ToggleSwitch = ({
  checked,
  disabled = false,
  onToggle,
  label,
  size = "md",
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  label: string;
  size?: "sm" | "md";
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-disabled={disabled}
    aria-label={label}
    disabled={disabled}
    onClick={() => !disabled && onToggle?.()}
    className={cn(
      "relative inline-flex shrink-0 items-center rounded-full transition-all",
      size === "md"
        ? cn(
            "h-7 w-12 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            checked ? "border-primary/40 bg-primary/20" : "border-transparent bg-background/80",
            disabled && "cursor-not-allowed opacity-60",
          )
        : cn(
            "h-5 w-9 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            checked ? "bg-primary" : "bg-muted",
            "disabled:cursor-wait disabled:opacity-70",
          ),
    )}
  >
    <span
      aria-hidden
      className={cn(
        "inline-block transform rounded-full shadow transition-transform",
        size === "md"
          ? cn(
              "h-5 w-5",
              checked ? "translate-x-6 bg-primary" : "translate-x-1 bg-muted-foreground/60",
            )
          : cn("h-4 w-4 bg-background", checked ? "translate-x-4" : "translate-x-0.5"),
      )}
    />
  </button>
);

// A titled settings row with a trailing toggle — one preference per row inside
// a SoftPanel stack.
export const PrefToggleRow = ({
  title,
  description,
  checked,
  disabled = false,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) => (
  <div className="px-5 py-4">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ToggleSwitch checked={checked} disabled={disabled} onToggle={onToggle} label={title} />
      </div>
    </div>
  </div>
);

// One row on the Skills hub — icon, title, subtitle, a count chip, and a
// trailing action button. The whole row is the button; the trailing element
// reads as "Manage"/"Create" and carries a chevron for affordance.
export const SkillHubRow = ({
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
    className="group flex w-full items-center gap-4 rounded-[1.4rem] bg-muted/30 px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[639px]:gap-3 max-[639px]:px-4"
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
    {/* On phones the row itself is the tap target — collapse the pill to the
            chevron so the title isn't squeezed into an ellipsis by two shrink-0
            neighbors (meta badge + action label). */}
    <span className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors group-hover:bg-background max-[639px]:px-1.5">
      <span className="max-[639px]:hidden">{actionLabel}</span>
      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
    </span>
  </motion.button>
);
