import { Bot, ChevronDown, ChevronRight, GitBranch, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { agentNodeDuration, type AgentMapNode } from "@/features/chat/lib/agentMap";
import { STATUS_META } from "@/features/chat/components/message_parts/subagentStatus";

const normalizeName = (value: string) => value.toLowerCase().replace(/[-_\s]+/g, "");

type AgentNodeCardProps = {
  node: AgentMapNode;
  now: number;
  /** Children shown under it in the tree; undefined when it cannot collapse. */
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
};

/**
 * One sub-agent in the agent map: the inline card's collapsed row in miniature
 * — icon, name and type, its task on one line, the sub-agents it delegated to,
 * tool calls, time, status chip — with the same running light round its border
 * (styles/subagent.css). Presentational: the tree or the detail view around it
 * owns the click and the keyboard.
 */
export function AgentNodeCard({ node, now, expanded, onToggle, className }: AgentNodeCardProps) {
  const meta = node.status ? STATUS_META[node.status] : null;
  const active = node.status === "running";
  const duration = agentNodeDuration(node, now);
  const childCount = node.children.length;
  // "fact-checker" under "Fact Checker" says nothing new (the inline card's rule).
  const showType = Boolean(node.type && normalizeName(node.type) !== normalizeName(node.title));

  return (
    <div
      className={cn("subagent-card rounded-2xl", className)}
      data-active={active ? "true" : "false"}
    >
      <div
        className={cn(
          "relative flex h-14 items-center gap-3 overflow-hidden rounded-2xl border px-3 transition-[border-color,box-shadow,background-color] duration-200",
          "bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--secondary)/0.5)_100%)]",
          "supports-[hover:hover]:group-hover/node:border-primary/40 supports-[hover:hover]:group-hover/node:shadow-card",
          active ? "border-transparent" : "border-border/70",
        )}
      >
        <span className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-primary/[0.05] to-transparent" />
        <span
          className={cn(
            "relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-transform duration-300 ease-out motion-safe:supports-[hover:hover]:group-hover/node:scale-110",
            active
              ? "bg-[hsl(var(--subagent-active)/0.12)] text-[hsl(var(--subagent-active))]"
              : "bg-primary/[0.1] text-primary",
          )}
        >
          <Bot className="h-4 w-4" aria-hidden />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">
              {node.title}
            </span>
            {showType ? (
              <span className="hidden flex-shrink-0 rounded-full bg-primary/[0.08] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.16em] text-primary sm:inline">
                {node.type}
              </span>
            ) : null}
          </span>
          {node.task ? (
            <span className="block truncate text-[12px] leading-[1.15rem] text-muted-foreground">
              {node.task}
            </span>
          ) : null}
        </span>
        {childCount ? (
          onToggle ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              aria-label={`${expanded ? "Hide" : "Show"} the ${childCount} sub-agent${childCount === 1 ? "" : "s"} it delegated to`}
              className="relative flex h-7 flex-shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 text-xs font-medium tabular-nums text-muted-foreground transition-colors supports-[hover:hover]:hover:border-primary/40 supports-[hover:hover]:hover:text-foreground"
            >
              <GitBranch className="h-3 w-3" aria-hidden />
              {childCount}
              <ChevronDown
                className={cn(
                  "h-3 w-3 transition-transform duration-200",
                  !expanded && "-rotate-90",
                )}
                aria-hidden
              />
            </button>
          ) : (
            <span
              className="relative flex flex-shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"
              title={`${childCount} nested sub-agent${childCount === 1 ? "" : "s"}`}
            >
              <GitBranch className="h-3 w-3" aria-hidden />
              {childCount}
            </span>
          )
        ) : null}
        {node.toolCount ? (
          <span
            className="relative hidden flex-shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground sm:flex"
            title={`${node.toolCount} tool call${node.toolCount === 1 ? "" : "s"}`}
          >
            <Wrench className="h-3 w-3" aria-hidden />
            {node.toolCount}
          </span>
        ) : null}
        {duration ? (
          <span className="relative hidden flex-shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
            {duration}
          </span>
        ) : null}
        {meta ? (
          <span
            className={cn(
              "relative flex flex-shrink-0 items-center gap-0 whitespace-nowrap rounded-full px-1.5 py-1 text-[11px] font-medium min-[420px]:gap-1 min-[420px]:px-2 min-[420px]:py-0.5",
              meta.chip,
            )}
          >
            {meta.icon}
            <span className="hidden min-[420px]:inline">{meta.label}</span>
          </span>
        ) : null}
        <ChevronRight
          aria-hidden
          className="relative hidden h-4 w-4 flex-shrink-0 text-muted-foreground/70 transition-transform sm:block duration-200 motion-safe:supports-[hover:hover]:group-hover/node:translate-x-0.5"
        />
      </div>
    </div>
  );
}
