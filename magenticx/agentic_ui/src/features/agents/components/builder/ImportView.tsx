import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileArchive,
  FileText,
  FileUp,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { importMyAgent } from "@/shared/lib/api";
import { mapIcon } from "@/shared/lib/consts";
import type { AgentCatalogs } from "@/features/agents/hooks/useAgentCatalogs";
import { importOutcome, IMPORT_ACCEPT, type ImportOutcome } from "@/features/agents/lib/importResult";
import { countByNode, FIELD_LABELS, ROOT_UID, type PlacedIssue } from "@/features/agents/lib/agentIssues";
import { modelLabel as labelOf } from "@/features/agents/lib/agentSpec";
import { formatBytes } from "@/features/agents/lib/agentRules";
import { helpFieldFor } from "@/features/agents/lib/yamlHelp";
import { locate } from "@/features/agents/hooks/useAgentDraft";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/features/agents/lib/styles";
import { SidePanel } from "./SidePanel";
import { YamlHelp, YamlHelpButton } from "./YamlHelp";
import { INPUT } from "./inspector/fields";

const loadBuilderCanvas = () => import("./canvas/BuilderCanvas");
const BuilderCanvas = React.lazy(loadBuilderCanvas);

type Opened = Extract<ImportOutcome, { kind: "valid" | "invalid" }>;

/**
 * Import a YAML (`/agents/new?via=import`): drop or pick `agent.yaml` with its
 * `.md` files, or one `.zip`, or paste the text; the server checks it (saving
 * nothing) and the result is drawn on the same canvas the builder uses, read
 * only, beside a summary and its issues. From there: create it as it is, open
 * it in the builder (to change or fix it), or choose another file. The help
 * ("How to write an agent.yaml") is one click away throughout, and each issue
 * links into it at its own field.
 */
export function ImportView({
  userId,
  catalogs,
  creating,
  onCreate,
  onOpen,
}: {
  userId: string | null;
  catalogs: AgentCatalogs;
  creating: boolean;
  onCreate: (outcome: Opened) => void;
  onOpen: (outcome: Opened) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [tab, setTab] = React.useState<"files" | "paste">("files");
  const [files, setFiles] = React.useState<File[]>([]);
  const [text, setText] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);
  const [help, setHelp] = React.useState<{ open: boolean; focus: string | null }>({ open: false, focus: null });
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const openHelp = (focus: string | null = null) => setHelp({ open: true, focus });

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const names = new Set(incoming.map((f) => f.name));
      return [...prev.filter((f) => !names.has(f.name)), ...incoming];
    });
    setError(null);
  };

  const ready = tab === "files" ? files.length > 0 : text.trim().length > 0;

  const check = async () => {
    if (!userId || !ready || checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await importMyAgent(userId, tab === "files" ? { files } : { yaml: text });
      setOutcome(importOutcome(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The file couldn't be checked. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  const reset = () => {
    setOutcome(null);
    setFiles([]);
    setError(null);
  };

  const fade = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -6 },
        transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
      };

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {outcome === null ? (
          <motion.div key="input" {...fade} className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-10 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" aria-label="How to import" className="inline-flex rounded-full border border-border/70 bg-muted/30 p-0.5">
                {(
                  [
                    { id: "files", label: "Upload files", Icon: FileUp },
                    { id: "paste", label: "Paste YAML", Icon: ClipboardPaste },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                      tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
              <YamlHelpButton onClick={() => openHelp()} />
            </div>

            {tab === "files" ? (
              <div className="flex flex-col gap-3">
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(false);
                    addFiles(event.dataTransfer.files);
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 rounded-[1.75rem] border-2 border-dashed px-6 py-12 text-center transition-colors",
                    dragOver ? "border-primary/70 bg-primary/[0.06]" : "border-border/80 bg-muted/15",
                  )}
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/[0.12] text-primary">
                    <FileUp className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-[15px] font-semibold text-foreground">Drop your agent here</p>
                    <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                      <code className="font-mono text-[12.5px]">agent.yaml</code> with its{" "}
                      <code className="font-mono text-[12.5px]">.md</code> files, or a{" "}
                      <code className="font-mono text-[12.5px]">.zip</code> of its folder.
                    </p>
                  </div>
                  <button type="button" className={SECONDARY_BUTTON} onClick={() => inputRef.current?.click()}>
                    Choose files
                  </button>
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept={IMPORT_ACCEPT}
                    className="hidden"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(event) => {
                      addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </div>
                {files.length ? (
                  <ul className="flex flex-wrap gap-2" aria-label="Chosen files">
                    {files.map((file) => {
                      const Icon = file.name.toLowerCase().endsWith(".zip") ? FileArchive : FileText;
                      return (
                        <li
                          key={file.name}
                          className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card py-1 pl-3 pr-1 text-[12.5px]"
                        >
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          <span className="max-w-[14rem] truncate font-mono text-foreground">{file.name}</span>
                          <span className="text-[11px] tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
                          <button
                            type="button"
                            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => setFiles((prev) => prev.filter((f) => f !== file))}
                          >
                            <X className="h-3 w-3" aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            ) : (
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={16}
                spellCheck={false}
                aria-label="agent.yaml"
                placeholder={"name: Market Researcher\ndescription: Scans filings and news and writes a short brief.\nprompt: |\n  You are Market Researcher…\nsubagents:\n  - name: researcher\n    description: Finds recent filings and news.\n    prompt: Research one company."}
                className={cn(INPUT, "min-h-[18rem] resize-y rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed")}
              />
            )}

            {error ? (
              <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <p className="mr-auto text-xs text-muted-foreground">Nothing is saved until you create it.</p>
              <button type="button" className={PRIMARY_BUTTON} disabled={!ready || checking} onClick={() => void check()}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {checking ? "Checking…" : "Check it"}
              </button>
            </div>
          </motion.div>
        ) : outcome.kind === "unparsed" ? (
          <motion.div key="unparsed" {...fade} className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-10 sm:px-6">
            <div role="alert" className="rounded-[1.5rem] border border-destructive/35 bg-destructive/[0.05] p-5">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                  <AlertCircle className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold text-foreground">This YAML couldn&apos;t be read</h2>
                  <ul className="mt-1.5 space-y-1">
                    {outcome.messages.map((message) => (
                      <li key={message} className="font-mono text-[12.5px] leading-relaxed text-foreground/90">
                        {message}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Look at the line it names: indent with spaces, not tabs, and quote a value that
                    holds a colon.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <YamlHelpButton onClick={() => openHelp("errors")} className="mr-auto" />
              <button type="button" className={PRIMARY_BUTTON} onClick={reset}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Choose another file
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="result" {...fade} className="flex min-h-0 flex-1 flex-col">
            <ImportResult
              outcome={outcome}
              catalogs={catalogs}
              creating={creating}
              onCreate={() => onCreate(outcome)}
              onOpen={() => onOpen(outcome)}
              onAgain={reset}
              onHelp={openHelp}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <SidePanel
        open={help.open}
        onOpenChange={(open) => setHelp((prev) => ({ ...prev, open }))}
        title="How to write an agent.yaml"
        description="Fields, rules and an example to start from."
        wide
      >
        <YamlHelp models={catalogs.models} builtins={catalogs.builtins} focus={help.open ? help.focus : null} />
      </SidePanel>
    </>
  );
}

function ImportResult({
  outcome,
  catalogs,
  creating,
  onCreate,
  onOpen,
  onAgain,
  onHelp,
}: {
  outcome: Opened;
  catalogs: AgentCatalogs;
  creating: boolean;
  onCreate: () => void;
  onOpen: () => void;
  onAgain: () => void;
  onHelp: (focus: string | null) => void;
}) {
  const [selected, setSelected] = React.useState(ROOT_UID);
  const { draft, issues, summary } = outcome;
  const valid = outcome.kind === "valid";
  const errors = issues.filter((i) => i.severity === "error");
  const counts = React.useMemo(() => countByNode(issues), [issues]);
  const errorNodes = React.useMemo(() => new Set(errors.map((i) => i.target.uid)), [errors]);
  const modelLabel = React.useCallback((id: string) => labelOf(id, catalogs.models), [catalogs.models]);
  const shown = selected === ROOT_UID ? issues : issues.filter((i) => i.target.uid === selected);
  const nodeName = (uid: string) =>
    uid === ROOT_UID ? summary.name || "The agent" : locate(draft, uid)?.node.name || "Unnamed sub-agent";
  const Glyph = mapIcon(draft.icon || "Bot");

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="relative min-h-[18rem] min-w-0 flex-1 border-b border-border/50 md:border-b-0">
        <span className="absolute left-4 top-3 z-10 rounded-full border border-border/60 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
          Preview · read-only
        </span>
        <React.Suspense fallback={null}>
          <BuilderCanvas
            draft={draft}
            selectedUid={selected}
            modelLabel={modelLabel}
            issueCounts={counts}
            errorNodes={errorNodes}
            readOnly
            onSelect={setSelected}
            label="The imported agent and its team"
          />
        </React.Suspense>
      </div>
      <aside className="scrollbar-muted flex w-full flex-shrink-0 flex-col gap-5 overflow-y-auto bg-card/60 p-5 md:w-[400px] md:border-l md:border-border/50">
        <div
          className={cn(
            "flex items-center gap-2 rounded-2xl px-3.5 py-2.5 text-[13px] font-medium",
            valid
              ? "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
              : "bg-destructive/[0.08] text-destructive",
          )}
          role="status"
        >
          {valid ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertCircle className="h-4 w-4" aria-hidden />}
          {valid
            ? "Ready to create"
            : `${errors.length} issue${errors.length === 1 ? "" : "s"} to fix before it can be created`}
        </div>

        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-primary/[0.12] text-primary">
            <Glyph className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold tracking-tight text-foreground">
              {summary.name || "Untitled agent"}
            </h2>
            {summary.description ? (
              <p className="mt-0.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{summary.description}</p>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2">
          {[
            ["Model", modelLabel(summary.model)],
            ["Team", summary.team ? `${summary.team} sub-agent${summary.team === 1 ? "" : "s"} · ${summary.levels} level${summary.levels === 1 ? "" : "s"}` : "None"],
            ["MCP tools", String(summary.tools)],
            ["Skills", String(summary.skills)],
            ["Files", String(summary.files)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border/60 bg-background/60 px-3 py-2">
              <dt className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 truncate text-[13px] font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        {issues.length ? (
          <section aria-label="Issues" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-foreground">
                {selected === ROOT_UID ? "Issues" : `Issues on ${nodeName(selected)}`}
              </h3>
              {selected !== ROOT_UID ? (
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  onClick={() => setSelected(ROOT_UID)}
                >
                  Show all
                </button>
              ) : null}
            </div>
            {shown.length ? (
              <ul className="flex flex-col gap-1.5">
                {shown.map((item) => (
                  <ImportIssue
                    key={item.id}
                    issue={item}
                    where={item.target.uid === ROOT_UID ? FIELD_LABELS[item.target.field] : `${nodeName(item.target.uid)} · ${FIELD_LABELS[item.target.field]}`}
                    onPick={() => setSelected(item.target.uid)}
                    onHelp={() => onHelp(helpFieldFor(item.path))}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing to fix on this one.</p>
            )}
          </section>
        ) : null}

        <div className="mt-auto flex flex-col gap-2 pt-1">
          {valid ? (
            <>
              <button type="button" className={cn(PRIMARY_BUTTON, "justify-center")} onClick={onCreate} disabled={creating}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Create agent
              </button>
              <button type="button" className={cn(SECONDARY_BUTTON, "justify-center")} onClick={onOpen} disabled={creating}>
                Open in the builder
              </button>
            </>
          ) : (
            <>
              <button type="button" className={cn(PRIMARY_BUTTON, "justify-center")} onClick={onOpen}>
                Open in the builder to fix
              </button>
              <button type="button" className={cn(SECONDARY_BUTTON, "justify-center")} onClick={onAgain}>
                Choose another file
              </button>
            </>
          )}
          <YamlHelpButton onClick={() => onHelp(null)} className="justify-center border-transparent bg-transparent" />
        </div>
      </aside>
    </div>
  );
}

function ImportIssue({
  issue,
  where,
  onPick,
  onHelp,
}: {
  issue: PlacedIssue;
  where: string;
  onPick: () => void;
  onHelp: () => void;
}) {
  const error = issue.severity === "error";
  const Icon = error ? AlertCircle : AlertTriangle;
  return (
    <li className="rounded-xl border border-border/60 bg-background/60 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-3.5 w-3.5 flex-shrink-0", error ? "text-destructive" : "text-[hsl(var(--warning))]")} aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onPick}
            className="block text-left text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {where}
            {issue.path ? <code className="ml-1.5 font-mono text-[10.5px] opacity-80">{issue.path}</code> : null}
          </button>
          <p className="mt-0.5 text-[12.5px] leading-snug text-foreground">{issue.message}</p>
          <button
            type="button"
            onClick={onHelp}
            className="mt-1 text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            What&apos;s this?
          </button>
        </div>
      </div>
    </li>
  );
}
