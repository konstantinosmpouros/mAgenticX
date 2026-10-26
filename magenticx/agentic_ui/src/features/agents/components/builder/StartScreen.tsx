import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, FileUp, History, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/utils";

/**
 * `/agents/new`: how to start — on the canvas, or from a YAML file. Two large
 * choices, each with a small picture of what it leads to, and a way back into
 * an unsaved agent an earlier visit left behind.
 */
export function StartScreen({
  onCanvas,
  onImport,
  leftover,
}: {
  onCanvas: () => void;
  onImport: () => void;
  /** When an unsaved new agent is stored on this device: when it was saved. */
  leftover: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const rise = (index: number) =>
    reduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.42, delay: 0.06 + index * 0.07, ease: [0.22, 1, 0.36, 1] as const },
        };
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-10 sm:px-6">
      <div className="grid gap-4 md:grid-cols-2">
        <motion.div {...rise(0)}>
          <StartCard
            icon={<Workflow className="h-5 w-5" aria-hidden />}
            title="Start on the canvas"
            body="Lay out the agent and its team as a graph — up to three levels of sub-agents, each with its own instructions, model and tools."
            art={<CanvasArt />}
            onClick={onCanvas}
          />
        </motion.div>
        <motion.div {...rise(1)}>
          <StartCard
            icon={<FileUp className="h-5 w-5" aria-hidden />}
            title="Import a YAML"
            body="Drop an agent.yaml with its .md files, or a .zip of the folder — or paste the YAML. It's checked straight away."
            art={<YamlArt />}
            onClick={onImport}
          />
        </motion.div>
      </div>
      {leftover ? (
        <motion.button
          {...rise(2)}
          type="button"
          onClick={onCanvas}
          className="mx-auto inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <History className="h-3.5 w-3.5 text-primary" aria-hidden />
          Continue the agent you left unsaved at {leftover}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </motion.button>
      ) : null}
    </div>
  );
}

function StartCard({
  icon,
  title,
  body,
  art,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  art: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-[1.75rem] border border-border/70 bg-card text-left",
        "shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_18px_40px_-28px_hsl(var(--foreground)/0.4)]",
        "transition-[border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_24px_50px_-26px_hsl(var(--primary)/0.45)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transform-none motion-reduce:transition-none",
      )}
    >
      <div className="relative h-40 overflow-hidden border-b border-border/50 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.10),transparent_70%)]">
        <div
          className="absolute inset-0 opacity-60 [background-image:radial-gradient(hsl(var(--muted-foreground)/0.22)_1px,transparent_1.2px)] [background-size:16px_16px]"
          aria-hidden
        />
        <div className="relative flex h-full items-center justify-center" aria-hidden>
          {art}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-5 sm:p-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/[0.12] text-primary">
          {icon}
        </span>
        <span className="mt-1 text-lg font-semibold tracking-tight text-foreground">{title}</span>
        <span className="text-sm leading-relaxed text-muted-foreground">{body}</span>
        <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-[13px] font-semibold text-primary">
          Start
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
        </span>
      </div>
    </button>
  );
}

/** A small team tree, in the canvas's own look. */
function CanvasArt() {
  const card = "absolute rounded-xl border border-border/80 bg-card shadow-[0_6px_16px_-10px_hsl(var(--foreground)/0.35)]";
  return (
    <div className="relative h-32 w-64">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 256 128" fill="none">
        <path
          d="M128 34 V48 Q128 56 120 56 H68 Q60 56 60 64 V76 M128 48 Q128 56 136 56 H188 Q196 56 196 64 V76 M60 98 V104"
          stroke="hsl(var(--primary) / 0.38)"
          strokeWidth="1.5"
        />
      </svg>
      <div className={cn(card, "left-[78px] top-[8px] flex h-[26px] w-[100px] items-center gap-1.5 border-primary/50 px-2")}>
        <span className="h-3 w-3 rounded-md bg-primary/30" />
        <span className="h-1.5 w-12 rounded-full bg-foreground/25" />
      </div>
      {[
        { left: 18, top: 76 },
        { left: 154, top: 76 },
      ].map((pos) => (
        <div key={pos.left} className={cn(card, "flex h-[22px] w-[84px] items-center gap-1.5 px-2")} style={pos}>
          <span className="h-2.5 w-2.5 rounded-full bg-primary/25" />
          <span className="h-1.5 w-10 rounded-full bg-foreground/20" />
        </div>
      ))}
      <div
        className="absolute flex h-[16px] w-[16px] items-center justify-center rounded-full border border-primary/40 bg-card text-[11px] font-semibold leading-none text-primary"
        style={{ left: 52, top: 104 }}
      >
        +
      </div>
    </div>
  );
}

/** A few lines of YAML, in the YAML view's colours. */
function YamlArt() {
  const line = (indent: number, key: number, value: number, dash = false) => (
    <span className="flex items-center gap-1.5" style={{ paddingLeft: indent * 10 }}>
      {dash ? <span className="h-1 w-1.5 rounded-full bg-muted-foreground/50" /> : null}
      <span className="h-1.5 rounded-full bg-primary/55" style={{ width: key }} />
      <span className="h-1.5 rounded-full bg-[hsl(var(--success)/0.5)]" style={{ width: value }} />
    </span>
  );
  return (
    <div className="flex w-56 flex-col gap-2 rounded-xl border border-border/80 bg-card px-4 py-3.5 shadow-[0_6px_16px_-10px_hsl(var(--foreground)/0.35)]">
      {line(0, 26, 70)}
      {line(0, 40, 54)}
      {line(0, 34, 0)}
      {line(1, 28, 48, true)}
      {line(2, 44, 60)}
      {line(2, 30, 36)}
    </div>
  );
}
