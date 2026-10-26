import { useMemo } from "react";
import { Bot, ChevronRight, Copy, Layers, Plus, Trash2, Wrench } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { AgentDraftSubAgent } from "@/shared/lib/types";
import { nestedSubagentPromptPath, toSubagentName } from "@/features/agents/lib/agentSpec";
import { canAddChild, MAX_SUBAGENT_DEPTH } from "@/features/agents/lib/agentRules";
import { fieldId } from "@/features/agents/lib/agentIssues";
import { locate } from "@/features/agents/hooks/useAgentDraft";
import { useBuilder } from "../builderContext";
import { InstructionsEditor, ModelSelect } from "./controls";
import { EmptyNote, Field, FieldIssues, INPUT, SMALL_BUTTON, SectionHeading } from "./fields";
import { invalidProps } from "./fieldProps";

/**
 * A sub-agent's form: one column, no tabs — a sub-agent is a name, a short
 * description its agent reads to decide when to use it, instructions, a model
 * and tools (each "same as above" until changed), and its own team.
 */
export function SubagentForm({ uid }: { uid: string }) {
  const { draft, dispatch, catalogs, issuesFor, touch, modelLabel, select, addChild, duplicate, requestDelete } =
    useBuilder();
  const at = useMemo(() => locate(draft, uid), [draft, uid]);
  // What it inherits: the nearest model and tool set above it.
  const above = useMemo(() => {
    if (!at) return { model: draft.model, tools: draft.tools, names: [] as string[] };
    let model = draft.model;
    let tools = draft.tools;
    const names: string[] = [];
    let list = draft.subagents;
    for (const index of at.path.slice(0, -1)) {
      const node = list[index];
      if (node.model) model = node.model;
      if (node.tools.length) tools = node.tools.filter((key) => tools.includes(key));
      names.push(node.name.trim());
      list = node.subagents ?? [];
    }
    return { model, tools, names };
  }, [at, draft]);
  if (!at) return null;
  const node: AgentDraftSubAgent = at.node;
  const nameId = fieldId(uid, "name");
  const nameIssues = issuesFor(uid, "name");
  const descriptionIssues = issuesFor(uid, "description");
  const promptIssues = issuesFor(uid, "prompt");
  const modelIssues = issuesFor(uid, "model");
  const toolIssues = issuesFor(uid, "tools");
  const teamIssues = [...issuesFor(uid, "subagents"), ...issuesFor(uid, "general")];
  const parentName = above.names[above.names.length - 1] || draft.name.trim() || "the agent";
  const inherits = node.tools.length === 0;
  const canAdd = canAddChild(at.depth);
  const catalogByKey = new Map(catalogs.tools.map((t) => [`${t.serverId}/${t.toolName}`, t]));
  const promptFile = nestedSubagentPromptPath([...above.names, node.name]);

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Name"
        htmlFor={nameId}
        required
        issues={nameIssues}
        issuesId={`${nameId}-issues`}
        hint="Lowercase words joined by hyphens: how its agent calls it, and what the chat shows."
      >
        <input
          id={nameId}
          className={cn(INPUT, "font-mono text-[13px]")}
          value={node.name}
          placeholder="fact-checker"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            dispatch({ type: "update-node", uid, patch: { name: toSubagentName(event.target.value) } })
          }
          onBlur={() => {
            touch(uid, "name");
            // A trailing hyphen is only ever a word half-typed.
            if (node.name.endsWith("-")) {
              dispatch({ type: "update-node", uid, patch: { name: node.name.replace(/-+$/, "") } });
            }
          }}
          {...invalidProps(nameIssues, `${nameId}-issues`)}
        />
      </Field>

      <Field
        label="When to use it"
        htmlFor={fieldId(uid, "description")}
        required
        issues={descriptionIssues}
        issuesId={`${fieldId(uid, "description")}-issues`}
        hint={`${parentName === "the agent" ? "The agent" : `“${parentName}”`} reads this to decide when to hand it work.`}
      >
        <textarea
          id={fieldId(uid, "description")}
          className={cn(INPUT, "min-h-[4.5rem] resize-y")}
          rows={3}
          value={node.description}
          placeholder="Checks one claim against a second, independent source."
          onChange={(event) => dispatch({ type: "update-node", uid, patch: { description: event.target.value } })}
          onBlur={() => touch(uid, "description")}
          {...invalidProps(descriptionIssues, `${fieldId(uid, "description")}-issues`)}
        />
      </Field>

      <Field
        label="Instructions"
        htmlFor={fieldId(uid, "prompt")}
        required
        issues={promptIssues}
        issuesId={`${fieldId(uid, "prompt")}-issues`}
      >
        <InstructionsEditor
          id={fieldId(uid, "prompt")}
          value={node.prompt}
          fileName={promptFile.replace(/^subagents\//, "")}
          minRows={9}
          placeholder="You check one claim at a time. Find a second, independent source and say whether it agrees…"
          onChange={(value) => dispatch({ type: "update-node", uid, patch: { prompt: value } })}
          onBlur={() => touch(uid, "prompt")}
          invalid={promptIssues.some((i) => i.severity === "error")}
          describedBy={promptIssues.length ? `${fieldId(uid, "prompt")}-issues` : undefined}
        />
      </Field>

      <Field
        label="Model"
        htmlFor={fieldId(uid, "model")}
        issues={modelIssues}
        issuesId={`${fieldId(uid, "model")}-issues`}
      >
        <ModelSelect
          id={fieldId(uid, "model")}
          value={node.model}
          models={catalogs.models}
          inheritLabel={modelLabel(above.model)}
          onChange={(value) => dispatch({ type: "update-node", uid, patch: { model: value } })}
          invalid={modelIssues.some((i) => i.severity === "error")}
          describedBy={modelIssues.length ? `${fieldId(uid, "model")}-issues` : undefined}
        />
      </Field>

      <div className="flex flex-col gap-2.5">
        <SectionHeading
          title="Tools"
          description={
            above.tools.length
              ? `Some or all of the ${above.tools.length} MCP tool${above.tools.length === 1 ? "" : "s"} ${parentName === "the agent" ? "the agent" : `“${parentName}”`} has. Built-in tools come with every agent.`
              : `${parentName === "the agent" ? "The agent" : `“${parentName}”`} has no MCP tools to share; built-in tools come with every agent.`
          }
        />
        <FieldIssues issues={toolIssues} />
        {above.tools.length ? (
          <div
            id={fieldId(uid, "tools")}
            tabIndex={-1}
            className="overflow-hidden rounded-2xl border border-border/60 bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <div role="radiogroup" aria-label="Its tools" className="grid grid-cols-2 gap-1 border-b border-border/50 bg-muted/20 p-1">
              {(
                [
                  { value: true, label: "Same as above" },
                  { value: false, label: "Choose some" },
                ] as const
              ).map(({ value, label }) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={inherits === value}
                  onClick={() =>
                    dispatch({
                      type: "set-node-tools",
                      uid,
                      // Choosing starts from everything, so nothing is lost by the switch.
                      tools: value ? [] : [...above.tools],
                    })
                  }
                  className={cn(
                    "rounded-xl px-2 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                    inherits === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <ul className="max-h-64 overflow-y-auto p-1.5">
              {above.tools.map((key) => {
                const on = inherits || node.tools.includes(key);
                const tool = catalogByKey.get(key);
                return (
                  <li key={key}>
                    <label
                      className={cn(
                        "flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors",
                        inherits ? "opacity-70" : "cursor-pointer hover:bg-[hsl(var(--hover-surface))]",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                        checked={on}
                        disabled={inherits}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...node.tools, key]
                            : node.tools.filter((k) => k !== key);
                          // Unticking the last one would read as "inherit all":
                          // keep at least one picked while choosing.
                          if (next.length) dispatch({ type: "set-node-tools", uid, tools: next });
                        }}
                      />
                      <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                        {tool?.toolName ?? key.slice(key.indexOf("/") + 1)}
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          {key.slice(0, key.indexOf("/"))}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <span id={fieldId(uid, "tools")} tabIndex={-1} />
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionHeading
          title="Its team"
          description={
            canAdd
              ? "Sub-agents it can hand work to in turn."
              : `Level ${at.depth} of ${MAX_SUBAGENT_DEPTH}: three levels is the most, so this one does its work itself.`
          }
          aside={
            canAdd ? (
              <button type="button" className={SMALL_BUTTON} onClick={() => addChild(uid)}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add sub-agent
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                <Layers className="h-3 w-3" aria-hidden /> {at.depth} of {MAX_SUBAGENT_DEPTH}
              </span>
            )
          }
        />
        <span id={fieldId(uid, "subagents")} tabIndex={-1} />
        <FieldIssues issues={teamIssues} />
        {node.subagents.length ? (
          <ul className="flex flex-col gap-1.5">
            {node.subagents.map((child) => (
              <li key={child.uid}>
                <button
                  type="button"
                  onClick={() => select(child.uid)}
                  className="group flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-left transition-colors hover:bg-[hsl(var(--hover-surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[13px] font-medium",
                        child.name ? "text-foreground" : "italic text-muted-foreground",
                      )}
                    >
                      {child.name || "Unnamed sub-agent"}
                    </span>
                    {child.description ? (
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {child.description}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : canAdd ? (
          <EmptyNote>No sub-agents of its own. Most don&apos;t need any.</EmptyNote>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-4">
        <button type="button" className={SMALL_BUTTON} onClick={() => duplicate(uid)}>
          <Copy className="h-3.5 w-3.5" aria-hidden /> Duplicate
        </button>
        <button
          type="button"
          className={cn(SMALL_BUTTON, "hover:border-destructive/40 hover:text-destructive")}
          onClick={() => requestDelete(uid)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
        </button>
      </div>
    </div>
  );
}
