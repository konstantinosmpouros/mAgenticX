import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ChevronDown,
  FileText,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { mapIcon } from "@/shared/lib/consts";
import { ToggleSwitch } from "@/features/settings/components/profile_parts/shared";
import type { AgentDraftFile, AgentDraftSubAgent } from "@/shared/lib/types";
import {
  FILE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  byteLength,
  draftUsage,
  formatBytes,
  isAllowedFile,
  normaliseFilePath,
} from "@/features/agents/lib/agentRules";
import { MANIFEST_FILE, PROMPT_FILE, slugify } from "@/features/agents/lib/agentSpec";
import { ROOT_UID, fieldId } from "@/features/agents/lib/agentIssues";
import { useBuilder } from "../builderContext";
import { CatalogPicker } from "./CatalogPicker";
import { InstructionsEditor, ModelSelect } from "./controls";
import {
  EmptyNote,
  Field,
  FieldIssues,
  ICON_BUTTON,
  INPUT,
  SMALL_BUTTON,
  SectionHeading,
} from "./fields";
import { invalidProps } from "./fieldProps";

/**
 * The main agent's tabs, but Approvals (ApprovalsSection): Identity,
 * Instructions, Tools, Skills and Files. Each edits the shared draft through
 * the builder's dispatch and shows the issues placed on its fields.
 */

// A short list of Lucide names, so the icon is a pick rather than free text
// (mapIcon falls back to Building2 for anything unknown).
const ICON_CHOICES = [
  "Bot",
  "BrainCircuit",
  "Telescope",
  "Sparkles",
  "Compass",
  "Scale",
  "FlaskConical",
  "Library",
  "PenLine",
  "Wrench",
  "BarChart3",
  "Search",
] as const;

export function IdentitySection() {
  const { draft, dispatch, mode, catalogs, issuesFor, touch } = useBuilder();
  const nameIssues = issuesFor(ROOT_UID, "name");
  const descriptionIssues = issuesFor(ROOT_UID, "description");
  const modelIssues = issuesFor(ROOT_UID, "model");
  const iconIssues = issuesFor(ROOT_UID, "icon");
  const generalIssues = issuesFor(ROOT_UID, "general");
  const nameId = fieldId(ROOT_UID, "name");
  return (
    <div className="flex flex-col gap-5">
      {generalIssues.length ? <FieldIssues issues={generalIssues} /> : null}
      <Field
        label="Name"
        htmlFor={nameId}
        required
        issues={nameIssues}
        issuesId={`${nameId}-issues`}
        hint={
          draft.slug ? (
            <>
              Identifier <code className="rounded bg-muted/60 px-1 py-px font-mono text-[11px]">{draft.slug}</code>
              {mode === "edit" ? " · fixed once created" : " · built from the name, fixed once created"}
            </>
          ) : null
        }
      >
        <input
          id={nameId}
          className={INPUT}
          value={draft.name}
          maxLength={120}
          placeholder="Market Researcher"
          autoComplete="off"
          onChange={(event) =>
            dispatch({
              type: "set-name",
              value: event.target.value,
              // On create the slug follows the name — unless an import gave it
              // its own; on edit it never changes.
              followSlug: mode === "create" && (!draft.slug || draft.slug === slugify(draft.name)),
            })
          }
          onBlur={() => touch(ROOT_UID, "name")}
          {...invalidProps(nameIssues, `${nameId}-issues`)}
        />
      </Field>

      <Field
        label="Description"
        htmlFor={fieldId(ROOT_UID, "description")}
        issues={descriptionIssues}
        issuesId={`${fieldId(ROOT_UID, "description")}-issues`}
        aside={
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {draft.description.length}/500
          </span>
        }
        hint="Shown on its card in Agents and in the chat's agent picker."
      >
        <textarea
          id={fieldId(ROOT_UID, "description")}
          className={cn(INPUT, "min-h-[4.5rem] resize-y")}
          value={draft.description}
          rows={3}
          placeholder="Scans filings and news, and writes a short brief."
          onChange={(event) => dispatch({ type: "set", field: "description", value: event.target.value })}
          {...invalidProps(descriptionIssues, `${fieldId(ROOT_UID, "description")}-issues`)}
        />
      </Field>

      <Field
        label="Model"
        htmlFor={fieldId(ROOT_UID, "model")}
        issues={modelIssues}
        issuesId={`${fieldId(ROOT_UID, "model")}-issues`}
        hint="Its sub-agents use it too, unless one picks its own."
      >
        <ModelSelect
          id={fieldId(ROOT_UID, "model")}
          value={draft.model}
          models={catalogs.models}
          onChange={(value) => dispatch({ type: "set", field: "model", value })}
          invalid={modelIssues.some((i) => i.severity === "error")}
          describedBy={modelIssues.length ? `${fieldId(ROOT_UID, "model")}-issues` : undefined}
        />
      </Field>

      <Field label="Icon" issues={iconIssues}>
        <div
          id={fieldId(ROOT_UID, "icon")}
          role="radiogroup"
          aria-label="Icon"
          className="grid grid-cols-6 gap-1.5"
        >
          {ICON_CHOICES.map((name) => {
            const Glyph = mapIcon(name);
            const on = draft.icon === name;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name.replace(/([a-z])([A-Z0-9])/g, "$1 $2")}
                onClick={() => dispatch({ type: "set", field: "icon", value: name })}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  on
                    ? "border-primary/50 bg-primary/12 text-primary"
                    : "border-border/60 bg-background/60 text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground",
                )}
              >
                <Glyph className="h-[17px] w-[17px]" aria-hidden />
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

export function InstructionsSection() {
  const { draft, dispatch, issuesFor, touch } = useBuilder();
  const issues = issuesFor(ROOT_UID, "prompt");
  const memoryIssues = issuesFor(ROOT_UID, "memory");
  const id = fieldId(ROOT_UID, "prompt");
  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Instructions"
        htmlFor={id}
        required
        issues={issues}
        issuesId={`${id}-issues`}
        hint="Its system prompt: who it is, what it does, how it answers. Markdown is fine."
      >
        <InstructionsEditor
          id={id}
          value={draft.prompt}
          fileName={PROMPT_FILE}
          minRows={16}
          placeholder={"You are Market Researcher. You scan filings and news on a company and write a short, sourced brief.\n\n## How you work\n- …"}
          onChange={(value) => dispatch({ type: "set", field: "prompt", value })}
          onBlur={() => touch(ROOT_UID, "prompt")}
          invalid={issues.some((i) => i.severity === "error")}
          describedBy={issues.length ? `${id}-issues` : undefined}
        />
      </Field>

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">Long-term memory</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Lets it remember lasting facts between your conversations.
          </p>
          <FieldIssues issues={memoryIssues} />
        </div>
        <span id={fieldId(ROOT_UID, "memory")} tabIndex={-1}>
          <ToggleSwitch
            checked={draft.memory}
            onToggle={() => dispatch({ type: "set", field: "memory", value: !draft.memory })}
            label={`${draft.memory ? "Turn off" : "Turn on"} long-term memory`}
          />
        </span>
      </div>
    </div>
  );
}

export function ToolsSection() {
  const { draft, dispatch, catalogs, issuesFor } = useBuilder();
  const issues = issuesFor(ROOT_UID, "tools");
  const reduceMotion = useReducedMotion();
  const [builtinsOpen, setBuiltinsOpen] = useState(false);
  const catalogByKey = useMemo(
    () => new Map(catalogs.tools.map((tool) => [`${tool.serverId}/${tool.toolName}`, tool])),
    [catalogs.tools],
  );
  const groups = useMemo(() => {
    const byServer = new Map<string, typeof catalogs.tools>();
    for (const tool of catalogs.tools) {
      const list = byServer.get(tool.serverId) ?? [];
      list.push(tool);
      byServer.set(tool.serverId, list);
    }
    return [...byServer.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([server, tools]) => ({
        heading: server || "MCP",
        items: tools
          .sort((a, b) => a.toolName.localeCompare(b.toolName))
          .map((tool) => ({
            key: `${tool.serverId}/${tool.toolName}`,
            title: tool.toolName,
            subtitle: tool.description,
          })),
      }));
  }, [catalogs]);
  const selected = useMemo(() => new Set(draft.tools), [draft.tools]);
  // The agent's tools grouped by server, as the picker shows them.
  const chosenGroups = useMemo(() => {
    const byServer = new Map<string, string[]>();
    for (const key of draft.tools) {
      const server = key.slice(0, Math.max(0, key.indexOf("/"))) || "MCP";
      byServer.set(server, [...(byServer.get(server) ?? []), key]);
    }
    return [...byServer.entries()];
  }, [draft.tools]);
  const usedBelow = (key: string) => countUsesBelow(draft.subagents, key);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionHeading
          title="MCP tools"
          description="Tools from your connected servers. Its sub-agents get all of them, unless one is given fewer."
          aside={
            <CatalogPicker
              label="Add tools"
              title="Add tools"
              placeholder="Search tools…"
              empty="No tool matches."
              groups={groups}
              selected={selected}
              disabled={!catalogs.tools.length}
              icon={<Wrench className="h-3.5 w-3.5" aria-hidden />}
              onToggle={(key) =>
                dispatch({ type: selected.has(key) ? "remove-tool" : "add-tool", key })
              }
            />
          }
        />
        <div id={fieldId(ROOT_UID, "tools")} tabIndex={-1} className="focus-visible:outline-none">
          <FieldIssues issues={issues} />
        </div>
        {!catalogs.tools.length && catalogs.loaded ? (
          <EmptyNote>
            No MCP tools are available right now: the gateway is unreachable, or no servers are
            connected. An agent saved now simply has none; you can add them later.
          </EmptyNote>
        ) : !draft.tools.length ? (
          <EmptyNote>
            None yet. Without them it can still think, write, plan and use its built-in tools —
            add tools to let it reach outside the conversation.
          </EmptyNote>
        ) : (
          <div className="flex flex-col gap-3">
            {chosenGroups.map(([server, keys]) => (
              <div key={server}>
                <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {server}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {keys.map((key) => {
                    const tool = catalogByKey.get(key);
                    const below = usedBelow(key);
                    return (
                      <li
                        key={key}
                        className="group flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
                      >
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Wrench className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-foreground">
                            {tool?.toolName ?? key.slice(key.indexOf("/") + 1)}
                          </span>
                          {tool?.description ? (
                            <span className="block truncate text-[11.5px] text-muted-foreground">
                              {tool.description}
                            </span>
                          ) : catalogs.loaded && !tool ? (
                            // Kept, not dropped: the gateway may simply be down.
                            <span className="block truncate text-[11.5px] text-[hsl(var(--warning))]">
                              Not offered by the gateway right now
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          className={cn(ICON_BUTTON, "hover:text-destructive")}
                          aria-label={`Remove ${key}${below ? ` (also from ${below} sub-agent${below === 1 ? "" : "s"})` : ""}`}
                          title={below ? `Also removed from ${below} sub-agent${below === 1 ? "" : "s"}` : "Remove"}
                          onClick={() => dispatch({ type: "remove-tool", key })}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border/60 bg-muted/20">
        <button
          type="button"
          onClick={() => setBuiltinsOpen((open) => !open)}
          aria-expanded={builtinsOpen}
          className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-foreground">
              Built-in tools · always available
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {catalogs.builtins.length
                ? `${catalogs.builtins.length} tools every agent has: files, planning, memory, delegation… Choose which ask first in Approvals.`
                : "Files, planning, memory and delegation — every agent has them. Choose which ask first in Approvals."}
            </span>
          </span>
          <ChevronDown
            className={cn("h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform", builtinsOpen && "rotate-180")}
            aria-hidden
          />
        </button>
        <AnimatePresence initial={false}>
          {builtinsOpen && catalogs.builtins.length ? (
            <motion.ul
              initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden px-4"
            >
              {catalogs.builtins.map((tool) => (
                <li
                  key={tool.name}
                  className="flex items-start gap-2.5 border-t border-border/40 py-2 first:border-t-0"
                >
                  <code className="mt-px flex-shrink-0 rounded bg-muted/60 px-1.5 py-px font-mono text-[11px] text-foreground">
                    {tool.name}
                  </code>
                  <span className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
                    {tool.description || tool.group}
                    {tool.mainOnly ? " · main agent only" : ""}
                  </span>
                </li>
              ))}
              <li className="h-2" aria-hidden />
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** How many sub-agents, at any depth, list this tool themselves. */
const countUsesBelow = (nodes: AgentDraftSubAgent[], key: string): number =>
  nodes.reduce(
    (sum, node) => sum + (node.tools.includes(key) ? 1 : 0) + countUsesBelow(node.subagents ?? [], key),
    0,
  );

export function SkillsSection() {
  const { draft, dispatch, mySkills, issuesFor } = useBuilder();
  const issues = issuesFor(ROOT_UID, "skills");
  const selected = useMemo(() => new Set(draft.skills), [draft.skills]);
  const groups = useMemo(
    () => [
      {
        heading: "Your skills",
        items: mySkills.map((skill) => ({
          key: skill.name,
          title: skill.name,
          subtitle: skill.description,
          keywords: skill.category,
          badge:
            skill.type === "custom" ? (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
                custom
              </span>
            ) : undefined,
        })),
      },
    ],
    [mySkills],
  );
  return (
    <div className="flex flex-col gap-3">
      <SectionHeading
        title="Skills"
        description="Know-how from your skill pool, always at hand for this agent. Copied into it when you save."
        aside={
          <CatalogPicker
            label="Add skills"
            title="Add skills"
            placeholder="Search your skills…"
            empty="No skill in your pool matches."
            groups={groups}
            selected={selected}
            disabled={!mySkills.length}
            icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
            onToggle={(name) =>
              dispatch({ type: selected.has(name) ? "remove-skill" : "add-skill", name })
            }
          />
        }
      />
      <div id={fieldId(ROOT_UID, "skills")} tabIndex={-1} className="focus-visible:outline-none">
        <FieldIssues issues={issues} />
      </div>
      {!mySkills.length && !draft.skills.length ? (
        <EmptyNote>
          Your skill pool is empty. Skills you add to your pool can then be given to any of your
          agents.
        </EmptyNote>
      ) : !draft.skills.length ? (
        <EmptyNote>None yet. Add skills to give this agent focused know-how.</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {draft.skills.map((name) => {
            const skill = mySkills.find((s) => s.name === name);
            return (
              <li
                key={name}
                className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">{name}</span>
                  {skill?.description ? (
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {skill.description}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, "hover:text-destructive")}
                  aria-label={`Remove skill ${name}`}
                  onClick={() => dispatch({ type: "remove-skill", name })}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Where the agent's folder is mounted at run time — the path its instructions use. */
const REFERENCE_MOUNT = "/reference/";

/** Read one dropped or picked file as text. Agent folders are text-only. */
const readTextFile = (file: File): Promise<AgentDraftFile | { error: string }> =>
  new Promise((resolve) => {
    if (!isAllowedFile(file.name)) {
      resolve({ error: `${file.name}: only ${FILE_EXTENSIONS.join(", ")} files can be added.` });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      resolve({ error: `${file.name} is over ${formatBytes(MAX_FILE_BYTES)}.` });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve({ error: `${file.name} could not be read.` });
    reader.onload = () => resolve({ path: file.name, content: String(reader.result ?? "") });
    reader.readAsText(file);
  });

export function FilesSection() {
  const { draft, dispatch, issuesFor, openFile, setOpenFile } = useBuilder();
  const issues = issuesFor(ROOT_UID, "files");
  const usage = useMemo(() => draftUsage(draft), [draft]);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Every path a save writes already: the prompts and the reference files.
  const taken = useMemo(() => {
    const paths = new Set<string>([PROMPT_FILE, MANIFEST_FILE, ...draft.files.map((f) => f.path)]);
    return paths;
  }, [draft.files]);

  const addFiles = (incoming: AgentDraftFile[], errors: string[]) => {
    const accepted: AgentDraftFile[] = [];
    for (const file of incoming) {
      const path = normaliseFilePath(file.path);
      if (!path) {
        errors.push(`${file.path}: not a valid path inside the agent's folder (at most 3 folders deep).`);
      } else if (!isAllowedFile(path)) {
        errors.push(`${path}: only ${FILE_EXTENSIONS.join(", ")} files can be added.`);
      } else if (taken.has(path) || path.startsWith("subagents/")) {
        errors.push(`${path}: that path is taken.`);
      } else if (usage.fileCount + accepted.length >= MAX_FILES) {
        errors.push(`An agent holds at most ${MAX_FILES} files, its prompts included.`);
        break;
      } else {
        accepted.push({ path, content: file.content });
      }
    }
    if (accepted.length) {
      dispatch({ type: "add-files", files: accepted });
      setOpenFile(accepted[0].path);
    }
    setError(errors.join(" "));
  };

  const ingest = async (list: FileList | null) => {
    if (!list?.length) return;
    const results = await Promise.all(Array.from(list).map(readTextFile));
    const errors: string[] = [];
    const ok: AgentDraftFile[] = [];
    for (const result of results) {
      if ("error" in result) errors.push(result.error);
      else ok.push(result);
    }
    addFiles(ok, errors);
  };

  const fileShare = Math.min(1, usage.fileCount / MAX_FILES);
  const byteShare = Math.min(1, usage.totalBytes / MAX_TOTAL_BYTES);

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl transition-shadow",
        dragOver && "ring-2 ring-primary/60 ring-offset-4 ring-offset-background",
      )}
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setDragOver(false);
        void ingest(event.dataTransfer.files);
      }}
    >
      <SectionHeading
        title="Reference files"
        description={
          <>
            Notes, checklists or examples it can read while it works. Its instructions refer to
            them by path, e.g. <code className="font-mono">{REFERENCE_MOUNT}notes/style.md</code>.
          </>
        }
        aside={
          <>
            <button type="button" className={SMALL_BUTTON} onClick={() => inputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" aria-hidden /> Upload
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={FILE_EXTENSIONS.join(",")}
              className="hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                void ingest(event.target.files);
                event.target.value = "";
              }}
            />
          </>
        }
      />

      {/* Usage, counted as the server counts it: every prompt at every depth too. */}
      <div id={fieldId(ROOT_UID, "files")} tabIndex={-1} className="rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-foreground tabular-nums">
            {usage.fileCount} of {MAX_FILES} files
          </span>
          <span className="tabular-nums text-muted-foreground">
            {formatBytes(usage.totalBytes)} of {formatBytes(MAX_TOTAL_BYTES)}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2" aria-hidden>
          {[fileShare, byteShare].map((share, index) => (
            <span key={index} className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-300",
                  share >= 1 ? "bg-destructive" : share > 0.85 ? "bg-[hsl(var(--warning))]" : "bg-primary/70",
                )}
                style={{ width: `${Math.max(share * 100, 2)}%` }}
              />
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Counts every prompt — the agent&apos;s and each sub-agent&apos;s — and your files.
        </p>
        <FieldIssues issues={issues} />
      </div>

      {draft.files.length ? (
        <ul className="flex flex-col gap-1.5">
          {draft.files.map((file) => {
            const open = openFile === file.path;
            const fileIssues = issuesFor(ROOT_UID, "files").filter((i) => i.target.file === file.path);
            return (
              <li key={file.path} className="flex flex-col gap-1.5">
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors",
                    open ? "border-primary/40 bg-primary/[0.06]" : "border-border/60 bg-background/60",
                    fileIssues.length && "border-destructive/50",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setOpenFile(open ? null : file.path)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
                  >
                    <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono text-[11.5px] text-foreground">
                      <span className="text-muted-foreground">{REFERENCE_MOUNT}</span>
                      {file.path}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatBytes(byteLength(file.content))}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn(ICON_BUTTON, "h-6 w-6 hover:text-destructive")}
                    aria-label={`Remove ${file.path}`}
                    onClick={() => {
                      dispatch({ type: "remove-file", path: file.path });
                      if (open) setOpenFile(null);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                {open ? (
                  <textarea
                    className={cn(INPUT, "min-h-[9rem] resize-y font-mono text-[12px]")}
                    value={file.content}
                    onChange={(event) =>
                      dispatch({ type: "update-file", path: file.path, content: event.target.value })
                    }
                    placeholder="File contents…"
                    aria-label={`Contents of ${file.path}`}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyNote>No reference files. Drop files here, upload them, or add an empty one by path.</EmptyNote>
      )}

      <div className="flex items-center gap-2">
        <input
          className={cn(INPUT, "font-mono text-xs")}
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newPath.trim()) {
              event.preventDefault();
              addFiles([{ path: newPath, content: "" }], []);
              setNewPath("");
            }
          }}
          placeholder="notes/style-guide.md"
          aria-label="New reference file path"
        />
        <button
          type="button"
          className={cn(SMALL_BUTTON, "py-2")}
          disabled={!newPath.trim()}
          onClick={() => {
            addFiles([{ path: newPath, content: "" }], []);
            setNewPath("");
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add
        </button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3" aria-hidden />
        Text only ({FILE_EXTENSIONS.join(", ")}), up to {formatBytes(MAX_FILE_BYTES)} each.
      </p>
    </div>
  );
}
