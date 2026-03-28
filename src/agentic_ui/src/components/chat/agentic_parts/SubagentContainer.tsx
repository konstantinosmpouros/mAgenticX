import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Check, Copy, Hand, MessageSquareText, Wrench, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <div className="space-y-3 pl-5">
      {interrupts.map((interrupt, index) => (
        <div
          key={`${interrupt.threadId}-${index}`}
          className="relative pl-7"
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
          <CopyableContentBox content={toDisplayText(interrupt.content)} tone="code" size="md">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-6 text-white">
              {toDisplayText(interrupt.content)}
            </pre>
          </CopyableContentBox>
        </div>
      ))}
    </div>
  );
}

function CopyableContentBox({
  content,
  children,
  tone = "body",
  size = "md",
}: {
  content: string;
  children: React.ReactNode;
  tone?: "body" | "code";
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[20px] px-4 py-3",
        "bg-zinc-950",
      )}
    >
      <div className="absolute right-9 top-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="
                h-8 w-8 text-zinc-400
                hover:bg-white/10 hover:text-zinc-100
                active:bg-white/15 active:text-zinc-100
                focus:bg-white/15 focus:text-zinc-100 focus:outline-none
                focus:ring-0 focus-visible:ring-0 transition-colors
              "
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy"}
            >
              <span className="relative inline-block h-4 w-4">
                <Copy
                  className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
                    copied ? "opacity-0 scale-75" : "opacity-100 scale-100"
                  }`}
                />
                <Check
                  className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
                    copied ? "opacity-100 scale-100" : "opacity-0 scale-75"
                  }`}
                />
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            className="!opacity-100 rounded-md border border-border bg-background px-2 py-1 text-foreground shadow-card"
          >
            <p>Copy</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div
        className={cn(
          "overflow-y-auto pr-[4.75rem] pt-1 [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)_/_0.25)_transparent] [&::-webkit-scrollbar]:w-3.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-button]:h-0 [&::-webkit-scrollbar-button]:w-0 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[hsl(var(--muted-foreground)/0.25)] [&::-webkit-scrollbar-thumb:hover]:bg-[hsl(var(--muted-foreground)/0.35)]",
          size === "sm" && "max-h-[3.25rem]",
          size === "md" && "max-h-[6.5rem]",
          size === "lg" && "max-h-[8.75rem]",
          size === "xl" && "max-h-[14rem]",
          "text-zinc-100",
        )}
      >
        <div className="max-w-[calc(100%-1rem)]">
          {children}
        </div>
      </div>
    </div>
  );
}

function DisclosureButton({
  title,
  expanded,
  onClick,
  className,
  children,
}: {
  title?: string;
  expanded: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={title}
      className={cn(
        "flex w-full items-center gap-3 text-left",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function ToolCallItem({ toolCall }: { toolCall: SubagentTool }) {
  const [toolExpanded, setToolExpanded] = React.useState(true);
  const [argsExpanded, setArgsExpanded] = React.useState(true);
  const [resultExpanded, setResultExpanded] = React.useState(false);
  const previousStatusRef = React.useRef(toolCall.status);
  const autoCollapsedRef = React.useRef(false);

  React.useEffect(() => {
    const didJustComplete =
      toolCall.status === "completed" && previousStatusRef.current !== "completed";

    if (didJustComplete && !autoCollapsedRef.current) {
      setToolExpanded(false);
      autoCollapsedRef.current = true;
    }

    previousStatusRef.current = toolCall.status;
  }, [toolCall.status]);

  return (
    <div className="relative pl-7">
      <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full bg-primary" />

      <DisclosureButton
        title={`Toggle ${toolCall.name}`}
        expanded={toolExpanded}
        onClick={() => setToolExpanded((current) => !current)}
        className="mb-1.5"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {toolCall.name}
          </span>
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
        </span>
      </DisclosureButton>

      {toolExpanded ? (
        <div className="space-y-2">
          {toolCall.args ? (
            <div>
              <DisclosureButton
                title="Toggle args"
                expanded={argsExpanded}
                onClick={() => setArgsExpanded((current) => !current)}
                className="mb-1"
              >
                <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Args
                </span>
              </DisclosureButton>
              {argsExpanded ? (
                <CopyableContentBox content={toolCall.args} tone="code" size="sm">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-6 text-zinc-100">
                    {toolCall.args}
                  </pre>
                </CopyableContentBox>
              ) : null}
            </div>
          ) : null}

          {toolCall.result ? (
            <div>
              <DisclosureButton
                title="Toggle result"
                expanded={resultExpanded}
                onClick={() => setResultExpanded((current) => !current)}
                className="mb-1"
              >
                <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Result
                </span>
              </DisclosureButton>
              {resultExpanded ? (
                <CopyableContentBox content={toolCall.result} tone="code" size="md">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-6 text-zinc-100">
                    {toolCall.result}
                  </pre>
                </CopyableContentBox>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type SubagentCardProps = {
  subagent: SubagentItem;
  index?: number;
};

export function SubagentCard({
  subagent,
  index = 0,
}: SubagentCardProps) {
  const transcript = getSubagentTranscript(subagent);
  const title = getSubagentTitle(subagent, index);
  const tools = subagent.tools ?? [];
  const interrupts = subagent.interrupts ?? [];
  const hasTranscript = Boolean(transcript);
  const hasTools = tools.length > 0;
  const hasInterrupts = interrupts.length > 0;
  const [cardExpanded, setCardExpanded] = React.useState(false);
  const [textExpanded, setTextExpanded] = React.useState(true);
  const [toolsExpanded, setToolsExpanded] = React.useState(true);
  const [interruptsExpanded, setInterruptsExpanded] = React.useState(true);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[30px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--secondary)/0.42)_100%)] shadow-card transition-[padding,colors] duration-300",
        cardExpanded ? "px-5 py-5" : "px-3 py-2.5",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.05] via-primary/[0.02] to-transparent" />
      {cardExpanded ? (
        <div className="pointer-events-none absolute left-9 top-[4rem] bottom-8 w-px bg-[linear-gradient(180deg,hsl(var(--primary)/0.28)_0%,hsl(var(--border)/0.88)_72%,hsl(var(--border)/0.72)_88%,transparent_100%)]" />
      ) : null}

      <DisclosureButton
        title={`Toggle ${title}`}
        expanded={cardExpanded}
        onClick={() => setCardExpanded((current) => !current)}
        className={cn("relative -ml-1", cardExpanded ? "mb-5" : "mb-0")}
      >
        <div className="min-w-0 flex-1 pr-4">
          <div
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-2",
              cardExpanded ? "mb-1" : "mb-0",
            )}
          >
            <div
              className={cn(
                "flex items-center justify-center rounded-full bg-primary/[0.1] text-primary transition-[height,width] duration-300",
                cardExpanded ? "h-10 w-10" : "h-7 w-7",
              )}
            >
              <Bot className={cn("transition-[height,width] duration-300", cardExpanded ? "h-4 w-4" : "h-3.5 w-3.5")} />
            </div>
            <h4
              className={cn(
                "min-w-0 break-words font-semibold text-foreground transition-[font-size] duration-300",
                cardExpanded ? "text-base" : "text-[13px]",
              )}
            >
              {title}
            </h4>
            {subagent.type ? (
              <span
                className={cn(
                  "rounded-full bg-primary/[0.08] font-medium uppercase tracking-[0.16em] text-primary transition-[padding,font-size] duration-300",
                  cardExpanded ? "px-2.5 py-1 text-[10px]" : "px-2 py-0.5 text-[9px]",
                )}
              >
                {subagent.type}
              </span>
            ) : null}
          </div>

          <p
            className={cn(
              "max-w-3xl text-muted-foreground transition-[max-height,padding,font-size,line-height] duration-300",
              cardExpanded
                ? "pl-8 text-sm leading-6"
                : "max-h-[2.3rem] overflow-hidden pl-5 text-[12px] leading-[1.15rem]",
            )}
          >
            {subagent.prompt || subagent.description || "Delegated subagent task in progress."}
          </p>
        </div>
      </DisclosureButton>

      <div
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out",
          cardExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0">
      <div className="relative grid gap-8 pl-8 pt-2 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          {hasTranscript ? (
          <section>
            <DisclosureButton
              title="Toggle streamed text"
              expanded={textExpanded}
              onClick={() => setTextExpanded((current) => !current)}
              className="mb-3"
            >
              <SectionLabel
                icon={<MessageSquareText className="h-3.5 w-3.5" />}
                title="Response"
              />
            </DisclosureButton>
            {textExpanded ? (
                <CopyableContentBox content={transcript} size="xl">
                  <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-zinc-100">
                    {transcript}
                  </p>
                </CopyableContentBox>
            ) : null}
          </section>
          ) : null}
        </div>

        <div className="space-y-6">
          {hasTools ? (
          <section>
            <DisclosureButton
              title="Toggle tool activity"
              expanded={toolsExpanded}
              onClick={() => setToolsExpanded((current) => !current)}
              className="mb-3"
            >
              <SectionLabel
                icon={<Wrench className="h-3.5 w-3.5" />}
                title="Tool Activity"
              />
            </DisclosureButton>
            {toolsExpanded ? (
                <div className="space-y-4 pl-5">
                  {tools.map((toolCall, toolIndex) => (
                    <div key={toolCall.id} className="relative">
                      {toolIndex < tools.length - 1 ? (
                        <span className="absolute left-[5px] top-4 bottom-[-16px] w-px bg-gradient-to-b from-primary/35 via-border/80 to-transparent" />
                      ) : null}
                      <ToolCallItem toolCall={toolCall} />
                    </div>
                  ))}
                </div>
            ) : null}
          </section>
          ) : null}

          {hasInterrupts ? (
          <section>
            <DisclosureButton
              title="Toggle HITL interrupts"
              expanded={interruptsExpanded}
              onClick={() => setInterruptsExpanded((current) => !current)}
              className="mb-3"
            >
              <SectionLabel
                icon={<Hand className="h-3.5 w-3.5" />}
                title="HITL Interrupts"
              />
            </DisclosureButton>
            {interruptsExpanded ? (
                <InterruptList interrupts={interrupts} />
            ) : null}
          </section>
          ) : null}
        </div>
      </div>
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

  React.useEffect(() => {
    if (!expanded) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <>
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
          <div className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {subtitle ? (
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
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

            <div className="hidden shrink-0 items-center gap-2 self-start rounded-full bg-secondary/45 px-2.5 py-1 transition-colors duration-500 ease-out sm:mt-1 sm:flex">
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
        </div>
      </div>
    </div>
    <AnimatePresence>
    {expanded ? (
      <motion.div
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm sm:p-6"
        onClick={onToggle}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <motion.div
          className="relative flex w-full max-w-6xl flex-col overflow-hidden rounded-[32px] border border-border/70 bg-background shadow-2xl"
          onClick={(event) => event.stopPropagation()}
          initial={{ opacity: 0, scale: 0.975, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.985, y: 6 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/[0.05] via-primary/[0.02] to-transparent" />
          <button
            type="button"
            onClick={onToggle}
            className="absolute right-4 top-4 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground shadow-sm transition hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0"
            aria-label="Close subagent activity"
          >
            <X size={18} />
          </button>

          <div className="relative flex flex-col border-b border-border/70 px-4 py-4 pr-16 sm:px-5 sm:pr-20">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                {subtitle ? (
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
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

              <div className="hidden shrink-0 items-center gap-2 self-start rounded-full bg-secondary/45 px-2.5 py-1 transition-colors duration-500 ease-out sm:mt-1 sm:flex">
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
          </div>

          <div
            className="max-h-[calc(88vh-8.5rem)] overflow-y-auto px-3 sm:px-4 [scrollbar-color:hsl(var(--muted-foreground)_/_0.25)_transparent] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[hsl(var(--muted-foreground)/0.25)] [&::-webkit-scrollbar-thumb:hover]:bg-[hsl(var(--muted-foreground)/0.35)]"
          >
            <div className="space-y-3 px-1 py-4">
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
          </div>
        </motion.div>
      </motion.div>
    ) : null}
    </AnimatePresence>
    </>
  );
}
