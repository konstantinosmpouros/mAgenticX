import { useEffect, useRef, type ReactNode } from "react";
import { Download, HelpCircle } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { triggerBrowserDownload } from "@/shared/lib/download";
import type { AgentModelOption, BuiltinToolInfo } from "@/shared/lib/types";
import {
  COMMON_ERRORS,
  EXAMPLE_AGENT_YAML,
  FILE_RULES,
  HELP_FIELDS,
  TEAM_RULES,
  helpAnchor,
} from "@/features/agents/lib/yamlHelp";
import { YamlCode } from "./YamlCode";
import { CopyButton } from "./CopyButton";
import { SMALL_BUTTON } from "./inspector/fields";

/**
 * "How to write an agent.yaml": a complete example to start from, every field
 * with its rules, the team and file rules, and the errors people meet with
 * their fixes. The models and built-in tools are the server's own lists, live.
 *
 * Each field's row has an anchor (`yaml-help-<field>`), so an issue can open
 * the help right at the field it is about (`focus`).
 */
export function YamlHelp({
  models,
  builtins,
  focus,
}: {
  models: AgentModelOption[];
  builtins: BuiltinToolInfo[];
  /** A field id (`subagents.tools`) or "errors" / "files" / "team" to scroll to and mark. */
  focus?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const frame = window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(`#${helpAnchor(focus)}`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);

  return (
    <div ref={rootRef} className="flex flex-col gap-7 pb-2 text-sm">
      <HelpSection title="A complete example" id="example">
        <p className="text-xs leading-relaxed text-muted-foreground">
          A main agent with a three-level team, an MCP tool, a skill and approval settings. Start
          from it: copy it, or download it and change what you need.
        </p>
        <div className="flex items-center gap-2">
          <CopyButton text={EXAMPLE_AGENT_YAML} label="Copy example" />
          <button
            type="button"
            className={SMALL_BUTTON}
            onClick={() =>
              triggerBrowserDownload(
                new Blob([EXAMPLE_AGENT_YAML], { type: "application/yaml" }),
                "agent.yaml",
              )
            }
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> Download example
          </button>
        </div>
        <YamlCode text={EXAMPLE_AGENT_YAML} label="Example agent.yaml" className="max-h-[26rem]" />
      </HelpSection>

      <HelpSection title="Fields" id="fields">
        <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-2xl border border-border/60 text-left">
          <caption className="sr-only">The fields of an agent.yaml</caption>
          <thead className="bg-muted/30 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th scope="col" className="w-[38%] px-3 py-2 font-semibold">Field</th>
              <th scope="col" className="px-3 py-2 font-semibold">What it is · rules</th>
            </tr>
          </thead>
          <tbody>
            {HELP_FIELDS.map((field) => (
              <tr
                key={field.id}
                id={helpAnchor(field.id)}
                tabIndex={-1}
                className={cn(
                  "align-top transition-colors focus:outline-none",
                  focus === field.id && "bg-primary/[0.07]",
                )}
              >
                <th scope="row" className="border-t border-border/50 px-3 py-2.5 font-normal">
                  <code className="break-all font-mono text-[12px] font-semibold text-primary">{field.label}</code>
                  <span
                    className={cn(
                      "mt-1 block w-fit rounded-full px-1.5 py-px text-[10px] font-medium",
                      field.required ? "bg-primary/10 text-primary" : "bg-muted/70 text-muted-foreground",
                    )}
                  >
                    {field.required ? "Required" : "Optional"}
                  </span>
                </th>
                <td className="border-t border-border/50 px-3 py-2.5 text-xs leading-relaxed text-foreground/90">
                  <p>{field.meaning}</p>
                  {field.rules.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {field.rules.map((rule) => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                  ) : null}
                  {field.live === "models" ? <ModelList models={models} /> : null}
                  {field.live === "builtins" ? <BuiltinList builtins={builtins} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </HelpSection>

      <HelpSection title="The team" id="team">
        <Bullets items={TEAM_RULES} />
      </HelpSection>

      <HelpSection title="Files" id="files">
        <Bullets items={FILE_RULES} />
      </HelpSection>

      <HelpSection title="Common errors" id="errors">
        <ul className="flex flex-col gap-2">
          {COMMON_ERRORS.map((item) => (
            <li key={item.message} className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
              <p className="font-mono text-[11.5px] text-destructive">{item.message}</p>
              <p className="mt-1 text-xs leading-relaxed text-foreground/90">{item.fix}</p>
            </li>
          ))}
        </ul>
      </HelpSection>
    </div>
  );
}

function HelpSection({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section id={helpAnchor(id)} tabIndex={-1} className="flex flex-col gap-2.5 focus:outline-none" aria-label={title}>
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-foreground/90 marker:text-primary/60">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function ModelList({ models }: { models: AgentModelOption[] }) {
  return (
    <div className="mt-2" aria-label="Allowed models">
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Allowed here
      </p>
      <ul className="flex flex-wrap gap-1">
        {models.map((model) => (
          <li key={model.id}>
            <code className="rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {model.id}
            </code>
            {model.default ? <span className="ml-1 text-[10.5px] text-muted-foreground">default</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuiltinList({ builtins }: { builtins: BuiltinToolInfo[] }) {
  if (!builtins.length) return null;
  return (
    <div className="mt-2" aria-label="Built-in tools">
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Built-in, always on
      </p>
      <ul className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {builtins.map((tool) => (
          <li key={tool.name} className="flex items-baseline justify-between gap-2">
            <code className="truncate font-mono text-[11px] text-foreground">{tool.name}</code>
            <span className="flex-shrink-0 text-[10.5px] text-muted-foreground">
              {tool.locked ? "always asks" : !tool.gateable ? "never asks" : tool.hitlDefault ? "asks" : "doesn't ask"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The help's trigger: a ? and its label, wherever YAML is written or read. */
export function YamlHelpButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn(SMALL_BUTTON, className)}>
      <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      How to write an agent.yaml
    </button>
  );
}
