import * as React from "react";
import {
  ArrowRightLeft,
  Check,
  CircleCheck,
  CircleX,
  GitBranch,
  Hourglass,
  Sparkles,
  SquareTerminal,
  Timer,
  TriangleAlert,
  X,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowExecution } from "@/shared/lib/types";
import { TONE_CHIP } from "@/features/workflows/lib/consts";
import { formatDuration, hasContent } from "@/features/workflows/lib/format";
import {
  asNumber,
  asRecord,
  asText,
  httpStatus,
  lineCount,
  payloadSize,
  shortContentType,
  splitModel,
  splitUrl,
} from "@/features/workflows/lib/stepSummary";
import { CopyJsonButton } from "./JsonView";
import { Disclosure } from "./Disclosure";
import { PanelHeading } from "./ValuePanel";
import { MarkdownBlock } from "./ValueView";
import { ValueTree } from "./ValueTree";

const CARD = "min-w-0 rounded-xl border border-border/60 bg-card/40";
const META = "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs tabular-nums text-muted-foreground";
const PILL = "inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold";

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground/80">{label}</span>
      <span className="font-medium text-foreground/85">{children}</span>
    </span>
  );
}

const TONE_ICON = {
  success: CircleCheck,
  info: ArrowRightLeft,
  warning: TriangleAlert,
  error: CircleX,
  muted: CircleCheck,
} as const;

/** fetch: status, method and URL, type and size; headers folded. */
function HttpSummary({ output, input }: { output: Record<string, unknown>; input: Record<string, unknown> }) {
  const status = httpStatus(asNumber(output.status), output.ok);
  const url = asText(output.url) || asText(input.url);
  const { host, rest } = splitUrl(url);
  const method = (asText(input.method) || "GET").toUpperCase();
  const type = shortContentType(asText(output.contentType));
  const size = payloadSize(output.body);
  const headers = asRecord(output.headers);
  const headerCount = Object.keys(headers).length;
  const Icon = TONE_ICON[status.tone];
  return (
    <div className="space-y-2">
      <div className={cn(CARD, "space-y-2 px-3 py-2.5")}>
        <div className="flex min-w-0 items-center gap-2">
          {status.code ? (
            <span className={cn(PILL, "tabular-nums", TONE_CHIP[status.tone])}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {status.code}
              {status.text ? <span className="font-medium">{status.text}</span> : null}
            </span>
          ) : null}
          <span className="flex-shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] font-semibold tracking-wide text-foreground/80">
            {method}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={url}>
            <span className="text-foreground">{host}</span>
            <span className="text-muted-foreground">{rest}</span>
          </span>
          {url ? <CopyJsonButton value={url} label="Copy URL" /> : null}
        </div>
        {type || size ? (
          <p className={META}>
            {type ? <Fact label="Type">{type}</Fact> : null}
            {type && size ? <Dot /> : null}
            {size ? <Fact label="Size">{size}</Fact> : null}
          </p>
        ) : null}
      </div>
      {headerCount ? (
        <Disclosure title="Response headers" count={String(headerCount)}>
          <div className={cn(CARD, "p-1.5")}>
            <ValueTree value={headers} label="Response headers" />
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** llm: the reply rendered, and which model wrote it. */
function LlmSummary({ text, output }: { text: string; output: Record<string, unknown> }) {
  const model = asText(output.model);
  const { provider, name } = splitModel(model);
  const json = "data" in output;
  return (
    <div className="space-y-2.5">
      {model ? (
        <p className={META}>
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/[0.08] px-2 py-0.5 font-medium text-primary">
            <Sparkles className="h-3 w-3 flex-shrink-0" aria-hidden />
            <span className="truncate">{name}</span>
          </span>
          {provider ? <span>{provider}</span> : null}
          <Dot />
          <span>{json ? "JSON answer" : "Text answer"}</span>
        </p>
      ) : null}
      {text ? (
        <section aria-label="Response" className="min-w-0">
          <div className="mb-2 flex min-h-[1.75rem] items-center">
            <PanelHeading>Response</PanelHeading>
          </div>
          <MarkdownBlock text={text} />
        </section>
      ) : null}
    </div>
  );
}

function Stream({ title, text, tone }: { title: string; text: string; tone?: "error" }) {
  const lines = lineCount(text);
  return (
    <Disclosure
      title={title}
      count={`${lines} line${lines === 1 ? "" : "s"}`}
      tone={tone}
      icon={<SquareTerminal className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />}
      action={<CopyJsonButton value={text} label={`Copy ${title}`} />}
    >
      <pre
        className={cn(
          "slim-scrollbar max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/50 px-3 py-2.5 font-mono text-[12px] leading-5 [overflow-wrap:anywhere]",
          tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {text}
      </pre>
    </Disclosure>
  );
}

/** code: exit code and run time; stdout / stderr folded when there is any. */
function CodeSummary({ output }: { output: Record<string, unknown> }) {
  const exitCode = asNumber(output.exitCode);
  const ran = formatDuration(asNumber(output.durationMs));
  const stdout = asText(output.stdout);
  const stderr = asText(output.stderr);
  const ok = exitCode === 0;
  return (
    <div className="space-y-1.5">
      <div className={cn(CARD, "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5")}>
        {exitCode !== null ? (
          <span className={cn(PILL, "tabular-nums", ok ? TONE_CHIP.success : TONE_CHIP.error)}>
            {ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            Exit {exitCode}
          </span>
        ) : null}
        <p className={META}>
          {ran ? (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" aria-hidden />
              ran {ran} in the sandbox
            </span>
          ) : null}
          {!stdout && !stderr ? (
            <>
              {ran ? <Dot /> : null}
              <span>no console output</span>
            </>
          ) : null}
        </p>
      </div>
      {stdout ? <Stream title="stdout" text={stdout} /> : null}
      {stderr ? <Stream title="stderr" text={stderr} tone="error" /> : null}
    </div>
  );
}

/** A labelled fact card: the branch a router took, an approval's decision, a wait. */
function FactCard({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(CARD, "flex min-w-0 items-center gap-3 px-3 py-2.5")}>
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/[0.1] text-primary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
        <div className="mt-0.5 min-w-0 text-[13.5px] font-semibold text-foreground">{children}</div>
      </div>
    </div>
  );
}

function BranchName({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-primary/[0.1] px-1.5 py-0.5 font-mono text-[12.5px] text-primary">
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * What a step did, for the top of its Output tab — one block per node kind
 * (docs/flows/workflows.md § Node kinds); nothing for kinds whose output is
 * only data (the tree below shows it).
 */
export function StepSummary({ kind, execution }: { kind: string; execution: WorkflowExecution }) {
  const output = asRecord(execution.output);
  const input = asRecord(execution.input);
  const text = execution.text || (kind === "llm" ? asText(output.text) : "");

  if (kind === "llm" || text) return <LlmSummary text={text} output={output} />;
  if (!hasContent(execution.output)) return null;

  switch (kind) {
    case "fetch":
      return <HttpSummary output={output} input={input} />;
    case "code":
      return <CodeSummary output={output} />;
    case "router":
    case "condition":
    case "loop": {
      const branch = execution.branch || asText(output.case);
      const iteration = asNumber(output.iteration);
      return (
        <FactCard icon={<GitBranch className="h-4 w-4" aria-hidden />} label="Branch taken">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {branch ? <BranchName name={branch} /> : <span className="text-muted-foreground">none</span>}
            {kind === "loop" && iteration !== null ? (
              <span className="text-xs font-medium text-muted-foreground">pass {iteration}</span>
            ) : null}
          </span>
        </FactCard>
      );
    }
    case "approval": {
      const decision = asText(output.decision);
      const approved = decision.startsWith("approve");
      const comment = asText(output.comment);
      return (
        <div className={cn(CARD, "space-y-1.5 px-3 py-2.5")}>
          <span className={cn(PILL, approved ? TONE_CHIP.success : TONE_CHIP.error)}>
            {approved ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            {approved ? "Approved" : decision ? "Rejected" : "No decision"}
          </span>
          {comment ? (
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-foreground [overflow-wrap:anywhere]">
              {comment}
            </p>
          ) : null}
        </div>
      );
    }
    case "wait": {
      const seconds = asNumber(output.waitedSeconds);
      return (
        <FactCard icon={<Hourglass className="h-4 w-4" aria-hidden />} label="Waited">
          {seconds !== null ? formatDuration(seconds * 1000) : "—"}
        </FactCard>
      );
    }
    case "set": {
      const count = Object.keys(output).length;
      return (
        <section aria-label="Variables written" className="min-w-0">
          <div className="mb-2 flex min-h-[1.75rem] items-center gap-2">
            <PanelHeading>Variables written</PanelHeading>
            <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">{count}</span>
          </div>
          <div className={cn(CARD, "p-1.5")}>
            <ValueTree value={output} label="Variables written" />
          </div>
        </section>
      );
    }
    default:
      return null;
  }
}
