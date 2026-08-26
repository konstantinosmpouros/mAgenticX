import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bot, Check, Copy, Hand, MessageSquareText, Wrench } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/utils";

import type { SubagentInterrupt, SubagentItem, SubagentTool } from "@/shared/lib/types";

export type { SubagentInterrupt, SubagentItem, SubagentTool };

function SmoothCollapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: { duration: 0.3, ease: "easeOut" } }}
          exit={
            reduceMotion
              ? { opacity: 0, transition: { duration: 0.1 } }
              : { height: 0, opacity: 0, transition: { duration: 0.2, ease: "easeIn" } }
          }
          className={cn("overflow-hidden", className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function SectionLabel({ icon, title }: { icon: React.ReactNode; title: string }) {
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
    subagent.label || subagent.type || subagent.namespace || subagent.id || `Subagent ${index + 1}`
  );
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
        <div key={`${interrupt.threadId}-${index}`} className="relative pl-7">
          <span className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full bg-amber-500 shadow-[0_0_0_6px_hsl(var(--background))]" />
          <div className="absolute left-[5px] top-4 bottom-[-12px] w-px bg-gradient-to-b from-amber-500/35 to-transparent last:hidden" />

          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded-full bg-amber-500/[0.12] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-500">
              Interrupt
            </span>
            <span className="text-[11px] text-muted-foreground">thread {interrupt.threadId}</span>
          </div>
          <CopyableContentBox content={toDisplayText(interrupt.content)} tone="code" size="md">
            <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-6 text-white">
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
    <div className={cn("group relative overflow-hidden rounded-[20px] px-4 py-3", "bg-zinc-950")}>
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
        <div className="max-w-[calc(100%-1rem)]">{children}</div>
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
      className={cn("flex w-full items-center gap-3 text-left", className)}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function ToolCallItem({
  toolCall,
  defaultExpanded = true,
}: {
  toolCall: SubagentTool;
  defaultExpanded?: boolean;
}) {
  const [toolExpanded, setToolExpanded] = React.useState(defaultExpanded);
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
          <span className="text-sm font-medium text-foreground">{toolCall.name}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
              toolCall.status === "error"
                ? "bg-destructive/[0.12] text-destructive"
                : toolCall.status === "completed"
                  ? "bg-emerald-500/[0.12] text-emerald-500"
                  : "bg-sky-500/[0.12] text-sky-500",
            )}
          >
            {toolCall.status === "error"
              ? "failed"
              : toolCall.status === "completed"
                ? "completed"
                : "running"}
          </span>
        </span>
      </DisclosureButton>

      <SmoothCollapse open={toolExpanded}>
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
              <SmoothCollapse open={argsExpanded}>
                <CopyableContentBox content={toolCall.args} tone="code" size="sm">
                  <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-6 text-zinc-100">
                    {toolCall.args}
                  </pre>
                </CopyableContentBox>
              </SmoothCollapse>
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
              <SmoothCollapse open={resultExpanded}>
                <CopyableContentBox content={toolCall.result} tone="code" size="md">
                  <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-6 text-zinc-100">
                    {toolCall.result}
                  </pre>
                </CopyableContentBox>
              </SmoothCollapse>
            </div>
          ) : null}
        </div>
      </SmoothCollapse>
    </div>
  );
}

export type SubagentCardProps = {
  subagent: SubagentItem;
  index?: number;
  // Side-panel mode: expanding the card reveals the section headers only;
  // each section (and each tool) opens on demand instead of all at once.
  defaultCollapsedSections?: boolean;
};

export function SubagentCard({
  subagent,
  index = 0,
  defaultCollapsedSections = false,
}: SubagentCardProps) {
  const transcript = getSubagentTranscript(subagent);
  const title = getSubagentTitle(subagent, index);
  const tools = subagent.tools ?? [];
  const interrupts = subagent.interrupts ?? [];
  const hasTranscript = Boolean(transcript);
  const hasTools = tools.length > 0;
  const hasInterrupts = interrupts.length > 0;
  const [cardExpanded, setCardExpanded] = React.useState(false);
  const [textExpanded, setTextExpanded] = React.useState(!defaultCollapsedSections);
  const [toolsExpanded, setToolsExpanded] = React.useState(!defaultCollapsedSections);
  const [interruptsExpanded, setInterruptsExpanded] = React.useState(!defaultCollapsedSections);
  const [promptExpanded, setPromptExpanded] = React.useState(false);
  const [promptClampable, setPromptClampable] = React.useState(false);
  const [promptFullHeight, setPromptFullHeight] = React.useState(0);
  const [promptClampHeight, setPromptClampHeight] = React.useState(72);
  const promptRef = React.useRef<HTMLParagraphElement>(null);
  const reduceMotion = useReducedMotion();
  const promptText =
    subagent.prompt || subagent.description || "Delegated subagent task in progress.";

  // Measure the paragraph's true full height and the height of its first three
  // lines from real line metrics (line-height rounds per browser, so a hard 72px
  // shaves the third line's descender). Re-measure on expand and on resize so
  // the expanded clamp never clips the last line with a stale height.
  React.useLayoutEffect(() => {
    if (!cardExpanded) return;
    const measure = () => {
      const el = promptRef.current;
      if (!el) return;
      const full = el.offsetHeight;
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
      const clamp = Math.ceil(lineHeight * 3);
      setPromptFullHeight(full);
      setPromptClampHeight(clamp);
      setPromptClampable(full > clamp + 4);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [cardExpanded, promptExpanded, promptText]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[30px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--secondary)/0.42)_100%)] shadow-card transition-[padding,colors] duration-300",
        cardExpanded ? "px-5 py-5" : "px-3 py-2.5",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.05] via-primary/[0.02] to-transparent" />
      <AnimatePresence initial={false}>
        {cardExpanded ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.3, delay: 0.15 } }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="pointer-events-none absolute left-9 top-[4rem] bottom-8 w-px bg-[linear-gradient(180deg,hsl(var(--primary)/0.28)_0%,hsl(var(--border)/0.88)_72%,hsl(var(--border)/0.72)_88%,transparent_100%)]"
          />
        ) : null}
      </AnimatePresence>

      <DisclosureButton
        title={`Toggle ${title}`}
        expanded={cardExpanded}
        onClick={() => setCardExpanded((current) => !current)}
        className={cn("relative -ml-1", cardExpanded ? "mb-1" : "mb-0")}
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
              <Bot
                className={cn(
                  "transition-[height,width] duration-300",
                  cardExpanded ? "h-4 w-4" : "h-3.5 w-3.5",
                )}
              />
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

          {!cardExpanded ? (
            <p className="max-h-[2.3rem] max-w-3xl overflow-hidden pl-5 text-[12px] leading-[1.15rem] text-muted-foreground">
              {promptText}
            </p>
          ) : null}
        </div>
      </DisclosureButton>

      {/* The task description lives outside the header button so the
          Show more toggle isn't a button nested inside a button. */}
      {cardExpanded ? (
        <div className="relative mb-5 max-w-3xl pl-8 pr-4">
          <motion.div
            className="overflow-hidden"
            initial={false}
            animate={{ maxHeight: promptExpanded ? promptFullHeight + 16 : promptClampHeight }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
          >
            <p ref={promptRef} className="text-sm leading-6 text-muted-foreground">
              {promptText}
            </p>
          </motion.div>
          {promptClampable ? (
            <button
              type="button"
              onClick={() => setPromptExpanded((current) => !current)}
              className="mt-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              {promptExpanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}

      <SmoothCollapse open={cardExpanded}>
        <div className="relative flex flex-col gap-6 pl-8 pr-4 pt-2">
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
              <SmoothCollapse open={textExpanded}>
                <CopyableContentBox content={transcript} size="xl">
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[14px] leading-7 text-zinc-100">
                    {transcript}
                  </p>
                </CopyableContentBox>
              </SmoothCollapse>
            </section>
          ) : null}

          {hasTools ? (
            <section>
              <DisclosureButton
                title="Toggle tool activity"
                expanded={toolsExpanded}
                onClick={() => setToolsExpanded((current) => !current)}
                className="mb-3"
              >
                <SectionLabel icon={<Wrench className="h-3.5 w-3.5" />} title="Tool Activity" />
              </DisclosureButton>
              <SmoothCollapse open={toolsExpanded}>
                <div className="space-y-4 pl-5">
                  {tools.map((toolCall, toolIndex) => (
                    <div key={toolCall.id} className="relative">
                      {toolIndex < tools.length - 1 ? (
                        <span className="absolute left-[5px] top-4 bottom-[-16px] w-px bg-gradient-to-b from-primary/35 via-border/80 to-transparent" />
                      ) : null}
                      <ToolCallItem
                        toolCall={toolCall}
                        defaultExpanded={!defaultCollapsedSections}
                      />
                    </div>
                  ))}
                </div>
              </SmoothCollapse>
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
                <SectionLabel icon={<Hand className="h-3.5 w-3.5" />} title="HITL Interrupts" />
              </DisclosureButton>
              <SmoothCollapse open={interruptsExpanded}>
                <InterruptList interrupts={interrupts} />
              </SmoothCollapse>
            </section>
          ) : null}
        </div>
      </SmoothCollapse>
    </div>
  );
}
