import * as React from "react";

import type { WorkflowExecution } from "@/shared/lib/types";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import { hasContent } from "@/features/workflows/lib/format";
import { asRecord, asText, outputTree, treeOpenDepth, withoutReply } from "@/features/workflows/lib/stepSummary";
import { CopyJsonButton } from "./JsonView";
import { StepSummary } from "./StepSummary";
import { PanelHeading, ValuePanel } from "./ValuePanel";

/**
 * A step's Output tab: the summary of what it did first (status and URL, the
 * reply, the branch taken, the variables written), then only what that does
 * not say — e.g. a fetch's response body — as a folding tree with its raw JSON
 * one switch away. The copy button always copies the whole output.
 */
export function StepOutput({ kind, execution }: { kind: string; execution: WorkflowExecution }) {
  const text = execution.text || (kind === "llm" ? asText(asRecord(execution.output).text) : "");
  const tree = outputTree(kind, execution.output);
  const value = React.useMemo(() => {
    if (!text || tree.value === undefined || kind === "llm") return tree.value;
    const rest = withoutReply(tree.value);
    return hasContent(rest) ? rest : undefined;
  }, [text, tree.value, kind]);

  if (!hasContent(execution.output) && !text) {
    return (
      <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs italic text-muted-foreground">
        {execution.status === "running" ? "Still running…" : "No output."}
      </p>
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      <StepSummary kind={kind} execution={execution} />
      {hasContent(execution.output) ? (
        <ValuePanel
          title={tree.title}
          value={value}
          raw={execution.output}
          openDepth={treeOpenDepth(value)}
          emptyText={kind === "fetch" ? "The response had no body." : "Empty."}
        />
      ) : null}
    </div>
  );
}

/** A code step's script, read as code rather than one long string. */
function Script({ code }: { code: string }) {
  return (
    <section aria-label="Script" className="min-w-0">
      <div className="mb-2 flex min-h-[2rem] items-center justify-between gap-2">
        <PanelHeading>Script</PanelHeading>
        <CopyJsonButton value={code} label="Copy the script" />
      </div>
      <div className="slim-scrollbar max-h-[20rem] min-w-0 overflow-auto overscroll-contain rounded-xl border border-border/60">
        <CodeBlock
          code={code}
          language="python"
          className="rounded-none border-0 [&_code]:text-[12px] [&_code]:leading-5 [&_pre]:p-3 [&_pre]:text-[12px]"
        />
      </div>
    </section>
  );
}

/** A step's Input tab: the resolved config it ran with (a code step's script on its own). */
export function StepInput({ kind, execution }: { kind: string; execution: WorkflowExecution }) {
  const input = asRecord(execution.input);
  const script = kind === "code" ? asText(input.code) : "";
  const rest = React.useMemo(
    () => (script ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "code")) : execution.input),
    [script, input, execution.input],
  );
  return (
    <div className="min-w-0 space-y-4">
      {script ? <Script code={script} /> : null}
      {!script || hasContent(rest) ? (
        <ValuePanel
          title={script ? "Settings" : "Input"}
          value={rest}
          openDepth={treeOpenDepth(rest)}
          emptyText="This step ran with no input."
        />
      ) : null}
    </div>
  );
}
