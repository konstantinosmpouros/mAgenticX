import * as React from "react";
import { Bot, Hand, MessageSquareText, Sparkles, Wrench } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type SubagentInterrupt = {
  threadId: string;
  content: unknown;
};

export type SubagentTool = {
  id: string;
  name: string;
  status?: "running" | "completed";
  args?: string;
  result?: string;
};

export type SubagentItem = {
  id: string;
  label?: string;
  type?: string;
  description?: string;
  namespace?: string;
  prompt?: string;
  text?: string;
  tools?: SubagentTool[];
  interrupts?: SubagentInterrupt[];
  eventCount?: number;
};

export type SubagentContainerProps = {
  subagents: SubagentItem[];
  expanded: boolean;
  onToggle: () => void;
  className?: string;
  title?: string;
  subtitle?: string;
};

function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTaskId(taskId: string): string {
  if (taskId.length <= 22) return taskId;
  return `${taskId.slice(0, 10)}...${taskId.slice(-8)}`;
}

function SectionLabel({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/[0.08] text-primary">
        {icon}
      </span>
      <span>{title}</span>
    </div>
  );
}

function getSubagentTitle(subagent: SubagentItem, index: number): string {
  return (
    subagent.label ||
    subagent.type ||
    subagent.namespace ||
    subagent.id ||
    `Subagent ${index + 1}`
  );
}

function getSubagentIdentity(subagent: SubagentItem): string {
  return subagent.id || subagent.namespace || "";
}

function getSubagentTranscript(subagent: SubagentItem): string {
  return subagent.text || "";
}

function InterruptList({ interrupts }: { interrupts: SubagentInterrupt[] }) {
  if (!interrupts.length) {
    return null;
  }

  return (
    <div className="space-y-3">
      {interrupts.map((interrupt, index) => (
        <div
          key={`${interrupt.threadId}-${index}`}
          className="relative pl-5"
        >
          <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_0_6px_hsl(var(--background))]" />
          <div className="absolute left-[5px] top-4 bottom-[-12px] w-px bg-gradient-to-b from-amber-500/35 to-transparent last:hidden" />

          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded-full bg-amber-500/[0.12] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-500">
              Interrupt
            </span>
            <span className="text-[11px] text-muted-foreground">
              thread {interrupt.threadId}
            </span>
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-2xl bg-amber-500/[0.05] px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
            {toDisplayText(interrupt.content)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function SubagentCard({
  subagent,
  index,
}: {
  subagent: SubagentItem;
  index: number;
}) {
  const transcript = getSubagentTranscript(subagent);
  const title = getSubagentTitle(subagent, index);
  const identity = getSubagentIdentity(subagent);
  const tools = subagent.tools ?? [];
  const interrupts = subagent.interrupts ?? [];
  const eventCount = subagent.eventCount ?? 0;

  return (
    <div className="relative overflow-hidden rounded-[30px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--secondary)/0.42)_100%)] px-5 py-5 shadow-card transition-colors duration-300">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.05] via-primary/[0.02] to-transparent" />
      <div className="pointer-events-none absolute left-7 top-20 bottom-8 w-px bg-gradient-to-b from-primary/25 via-border/80 to-transparent" />

      <div className="relative mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/[0.1] text-primary">
              <Bot className="h-4 w-4" />
            </div>
            <h4 className="text-base font-semibold text-foreground">
              {title}
            </h4>
            {subagent.type ? (
              <span className="rounded-full bg-primary/[0.08] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-primary">
                {subagent.type}
              </span>
            ) : null}
            {identity ? (
              <span className="rounded-full bg-background/80 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                {formatTaskId(identity)}
              </span>
            ) : null}
          </div>

          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            {subagent.description || "Delegated subagent task in progress."}
          </p>

          {subagent.namespace ? (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground/90">
              namespace {subagent.namespace}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 rounded-full bg-background/75 px-3 py-1.5">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
          <span className="text-[11px] text-muted-foreground">
            {eventCount} stream events
          </span>
        </div>
      </div>

      <div className="relative grid gap-8 pl-8 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <section>
            <SectionLabel
              icon={<Sparkles className="h-3.5 w-3.5" />}
              title="Spawned Instructions"
            />
            {subagent.prompt ? (
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-[24px] bg-background/70 px-4 py-3">
                  <div className="absolute inset-y-4 left-0 w-1 rounded-r-full bg-primary/60" />
                  <p className="whitespace-pre-wrap break-words pl-2 text-[13px] leading-6 text-foreground">
                    {subagent.prompt}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No before-agent instruction has been received yet.
              </p>
            )}
          </section>

          <section>
            <SectionLabel
              icon={<MessageSquareText className="h-3.5 w-3.5" />}
              title="Streamed Text"
            />
            {transcript ? (
              <div className="rounded-[26px] bg-background/55 px-4 py-4">
                <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-foreground">
                  {transcript}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No text chunks have been streamed from this subagent yet.
              </p>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section>
            <SectionLabel
              icon={<Wrench className="h-3.5 w-3.5" />}
              title="Tool Activity"
            />
            {tools.length ? (
              <div className="space-y-4">
                {tools.map((toolCall, toolIndex) => (
                  <div key={toolCall.id} className="relative pl-5">
                    <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_0_6px_hsl(var(--background))]" />
                    {toolIndex < tools.length - 1 ? (
                      <span className="absolute left-[5px] top-4 bottom-[-16px] w-px bg-gradient-to-b from-primary/35 via-border/80 to-transparent" />
                    ) : null}

                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {toolCall.name}
                      </p>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                          toolCall.status === "completed"
                            ? "bg-emerald-500/[0.12] text-emerald-500"
                            : "bg-sky-500/[0.12] text-sky-500"
                        )}
                      >
                        {toolCall.status === "completed" ? "completed" : "running"}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatTaskId(toolCall.id)}
                      </span>
                    </div>

                    {toolCall.args ? (
                      <div className="mb-2">
                        <p className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          Args
                        </p>
                        <pre className="whitespace-pre-wrap break-words rounded-[20px] bg-background/65 px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
                          {toolCall.args}
                        </pre>
                      </div>
                    ) : null}

                    {toolCall.result ? (
                      <div>
                        <p className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          Result
                        </p>
                        <pre className="whitespace-pre-wrap break-words rounded-[20px] bg-background/65 px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
                          {toolCall.result}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No tool lifecycle events have been recorded for this subagent.
              </p>
            )}
          </section>

          <section>
            <SectionLabel
              icon={<Hand className="h-3.5 w-3.5" />}
              title="HITL Interrupts"
            />
            {interrupts.length ? (
              <InterruptList interrupts={interrupts} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No human approval interrupts have been emitted for this subagent.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function SubagentContainer({
  subagents,
  expanded,
  onToggle,
  className,
  title = "Subagent activity",
  subtitle,
}: SubagentContainerProps) {
  const toolCount = subagents.reduce(
    (total, subagent) => total + (subagent.tools?.length ?? 0),
    0,
  );
  const interruptCount = subagents.reduce(
    (total, subagent) => total + (subagent.interrupts?.length ?? 0),
    0,
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative block w-full cursor-pointer select-none text-left outline-none",
        className,
      )}
    >
      <div className="absolute inset-x-12 top-2 h-10 rounded-full bg-[hsl(var(--primary)/0.1)] blur-3xl transition-opacity duration-300 group-hover:opacity-90" />

      <div className="relative overflow-hidden rounded-[30px] border border-border/70 bg-background shadow-lg">
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.04] to-transparent" />

        <div className="relative flex flex-col">
          <div
            className={cn(
              "flex items-start justify-between gap-3 px-3.5 py-3",
              expanded && "border-b border-border/70",
            )}
          >
            <div className="min-w-0">
              {subtitle ? (
                <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  <Sparkles className="h-3 w-3 text-primary" />
                  {subtitle}
                </div>
              ) : null}

              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-secondary/55 text-primary transition-colors duration-500 ease-out">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {title}
                  </h3>
                  <p className="truncate text-[11px] text-muted-foreground transition-colors duration-500 ease-out">
                    {subagents.length} subagents
                    {toolCount ? ` · ${toolCount} tool flows` : ""}
                    {interruptCount ? ` · ${interruptCount} interrupts` : ""}
                  </p>
                </div>
              </div>
            </div>

            <div className="hidden items-center gap-2 rounded-full bg-secondary/45 px-2.5 py-1 transition-colors duration-500 ease-out sm:flex">
              <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
              <span className="text-[11px] text-muted-foreground">
                {subagents.length}
              </span>
              <span className="inline-flex h-2 w-2 rounded-full bg-sky-500" />
              <span className="text-[11px] text-muted-foreground">{toolCount}</span>
              <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" />
              <span className="text-[11px] text-muted-foreground">
                {interruptCount}
              </span>
            </div>
          </div>

          <div
            className={cn(
              "overflow-hidden transition-[height,opacity] duration-300 ease-out",
              expanded ? "h-[38rem] opacity-100" : "h-0 opacity-0",
            )}
          >
            <ScrollArea
              className="h-full px-2.5"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="space-y-3 px-1 py-3">
                {subagents.length ? (
                  subagents.map((subagent, index) => (
                    <SubagentCard
                      key={getSubagentIdentity(subagent) || `subagent-${index}`}
                      subagent={subagent}
                      index={index}
                    />
                  ))
                ) : (
                  <div className="rounded-[26px] bg-secondary/25 px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      No subagent activity has been streamed yet.
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </div>
  );
}
