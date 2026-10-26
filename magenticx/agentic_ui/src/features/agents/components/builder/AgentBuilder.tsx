import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ChangeEvent, DragEvent } from "react";
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  Compass,
  FileText,
  FlaskConical,
  Library,
  Loader2,
  PenLine,
  Plus,
  Scale,
  Search,
  Sparkles,
  Telescope,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";

import { cn } from "@/shared/lib/utils";
import type {
  Agent,
  AgentDraft,
  AgentToolRow,
  AgentDraftFile,
  CustomAgentValidation,
  AgentDraftSubAgent,
  CustomAgentWritePayload,
  CustomAgentDetail,
  ToolMetadata,
  UserSkill,
} from "@/shared/lib/types";
import {
  VoiceSelector,
  VoiceSelectorContent,
  VoiceSelectorEmpty,
  VoiceSelectorGroup,
  VoiceSelectorInput,
  VoiceSelectorItem,
  VoiceSelectorList,
  VoiceSelectorName,
  VoiceSelectorTrigger,
} from "@/shared/ui/ai-elements/voice-selector";
import {
  MODEL_CHOICES,
  MANIFEST_FILE,
  PROMPT_FILE,
  buildAgentPayload,
  draftFromDetail,
  emptyDraft,
  emptySubagent,
  modelLabel,
  slugify,
  subagentPromptPath,
} from "@/features/agents/lib/agentSpec";
import { SoftPanel, ToggleSwitch } from "@/features/settings/components/profile_parts/shared";
import { SectionTabs, type SectionTab } from "@/features/agents/components/detail/SectionTabs";
import { AgentSummary } from "@/features/agents/components/detail/AgentSummary";
import { ToolList } from "@/features/agents/components/detail/ToolList";
import type { BuilderSection } from "@/features/agents/lib/routes";

/**
 * AgentBuilder — a guided form that *generates* an agent definition.
 *
 * A form rather than a YAML editor on purpose: the spec has referential rules
 * (allowlisted models, native tools, a prompt path that must resolve to an
 * uploaded file, mandatory approval gates) that a free-text editor lets a user
 * violate and only discover on save. The form can only emit shapes that pass,
 * and the generated document is shown read-only so the format stays learnable.
 *
 * Renders bare — the page around it (AgentBuilderPage) supplies the chrome and
 * the height.
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
] as const;

// The actual glyph for each choice — a name-only list makes the user guess
// what "FlaskConical" looks like. Keyed by the same strings the spec stores.
const ICON_GLYPHS: Record<string, LucideIcon> = {
  Bot,
  BrainCircuit,
  Telescope,
  Sparkles,
  Compass,
  Scale,
  FlaskConical,
  Library,
  PenLine,
  Wrench,
};

const MAX_PROMPT_CHARS = 20000;
// The model picker's value for "use the agent's model". Radix Select rejects an
// empty-string item value, so the draft's `""` maps to this at the control only.
const INHERIT_MODEL = "inherit";
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Mirrors the agents service's own limits (runtime/declarative/user_agents.py).
// Enforced there too — these exist so a user hits a field error while typing
// instead of a rejected save.
const FILE_EXTENSIONS = [".md", ".txt", ".yaml", ".yml"] as const;
// Where the agents service mounts an agent's definition folder read-only. Shown
// in the UI because it is the path the instructions must use, not the stored one.
const REFERENCE_MOUNT = "/reference/";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_PATH_DEPTH = 3;

const extOf = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
};

const isAllowedExt = (path: string): boolean =>
  (FILE_EXTENSIONS as readonly string[]).includes(extOf(path));

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Normalise a user-typed or uploaded path, or return null if unusable.
 *
 * Applies the same shape rules as the backend's `_validate_relpath` — no
 * absolute paths, no traversal, no dot-segments, bounded depth — so a rejected
 * path is explained here rather than at save time.
 */
const normalisePath = (raw: string): string | null => {
  const parts = raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== ".");
  if (!parts.length || parts.length > MAX_PATH_DEPTH) return null;
  if (parts.some((seg) => seg === ".." || seg.startsWith("."))) return null;
  return parts.join("/");
};

/** Read one dropped/selected file as text. Agent folders are text-only. */
const readTextFile = (file: File): Promise<AgentDraftFile | { error: string }> =>
  new Promise((resolve) => {
    if (!isAllowedExt(file.name)) {
      resolve({ error: `${file.name}: only ${FILE_EXTENSIONS.join(", ")} files are allowed.` });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      resolve({ error: `${file.name}: exceeds ${formatBytes(MAX_FILE_BYTES)}.` });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve({ error: `${file.name}: could not be read.` });
    reader.onload = () => resolve({ path: file.name, content: String(reader.result ?? "") });
    reader.readAsText(file);
  });


type AgentBuilderProps = {
  /** Every agent already visible to the user — used for name/slug collisions. */
  agents: Agent[];
  /** The user's skill pool: the only skills an agent may declare. */
  mySkills: UserSkill[];
  /** Live MCP catalog. Empty when the gateway is down — the section says so
   *  rather than looking like the agent has nothing to choose from. */
  toolCatalog: ToolMetadata[];
  /**
   * `edit` changes a saved agent; `create` makes a new one. Stated rather than
   * inferred from `initial`, because Duplicate seeds a CREATE from an existing
   * definition — inferring "edit" from it froze the copy's identifier and
   * labelled the button "Save changes" on what was really a create.
   */
  mode: "create" | "edit";
  /** The definition to start from: the agent being edited, or the one being duplicated. */
  initial?: CustomAgentDetail | null;
  submitting?: boolean;
  onSubmit: (payload: CustomAgentWritePayload) => Promise<Agent | null>;
  /** Dry-run check. `null` means the call itself failed (already toasted by the
   *  hook) — distinct from a real `valid: false` answer. */
  onValidate: (payload: CustomAgentWritePayload) => Promise<CustomAgentValidation | null>;
  onClose: () => void;
  /**
   * Edit mode only — this account's live tool rows for the saved agent, the same
   * rows the agent's detail view shows. Their switches (on/off, ask first) save
   * instantly and per account, unlike the rest of the form, which changes the
   * agent itself on Save. `null` while not applicable.
   */
  liveTools?: AgentToolRow[] | null;
  liveToolsLoading?: boolean;
  liveToolsError?: string | null;
  togglingKey?: string | null;
  onToggleTool?: (row: AgentToolRow) => void;
  onToggleApproval?: (row: AgentToolRow) => void;
  /** The section to open on (the page's `?section=`), and where to report a switch. */
  initialSection?: BuilderSection;
  onSectionChange?: (section: BuilderSection) => void;
};

export default function AgentBuilder({
  agents,
  mySkills,
  toolCatalog,
  mode,
  initial,
  submitting = false,
  onSubmit,
  onValidate,
  onClose,
  liveTools = null,
  liveToolsLoading = false,
  liveToolsError = null,
  togglingKey = null,
  onToggleTool,
  onToggleApproval,
  initialSection = "identity",
  onSectionChange,
}: AgentBuilderProps) {
  const isEdit = mode === "edit";
  // The live, per-account rows only mean something for an agent that exists.
  const live = isEdit ? liveTools : null;
  const liveByKey = useMemo(() => new Map((live ?? []).map((row) => [row.key, row])), [live]);
  const gatedCount = useMemo(() => (live ?? []).filter((row) => row.approval).length, [live]);
  const [draft, setDraft] = useState<AgentDraft>(() =>
    initial ? draftFromDetail(initial) : emptyDraft(),
  );
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  // Index of the sub-agent whose tool picker is open; one at a time.
  const [subToolPicker, setSubToolPicker] = useState<number | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [fileError, setFileError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const reduceMotion = useReducedMotion();
  const [section, setSectionState] = useState<BuilderSection>(initialSection);
  const setSection = useCallback(
    (next: BuilderSection) => {
      setSectionState(next);
      onSectionChange?.(next);
    },
    [onSectionChange],
  );
  // Validation is reported only after a save attempt: a blank new-agent form
  // is incomplete, not wrong, and an error banner on first paint reads as a
  // failure the user caused. Required fields are marked instead.
  const [attempted, setAttempted] = useState(false);

  const set = useCallback(<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setServerErrors([]);
  }, []);

  // On create the slug always follows the name; on edit it is frozen, because
  // the backend rejects a rename outright.
  //
  // It used to stop following once `slugTouched` was set — but that flag is
  // raised by BLURRING the name field, not by editing a slug (this form has no
  // slug input), so the identifier froze after the first blur. A first name
  // that yields no slug then froze it empty, and no later edit could recover:
  // the form insisted "A name is required" over a filled-in name field.
  const onNameChange = (value: string) => {
    setDraft((prev) => ({
      ...prev,
      name: value,
      slug: isEdit ? prev.slug : slugify(value),
    }));
    setServerErrors([]);
  };

  const takenSlugs = useMemo(
    () =>
      new Set(agents.filter((a) => !isEdit || a.id !== initial?.id).map((a) => slugify(a.name))),
    [agents, isEdit, initial?.id],
  );

  const slugError = useMemo(() => {
    if (!draft.name.trim()) return "A name is required.";
    // A name in a non-Latin script leaves nothing to build an identifier from.
    // Saying "a name is required" over a filled field sends the user hunting
    // for an empty box that isn't there.
    if (!draft.slug) {
      return "The identifier is built from the name, so it needs at least one Latin letter (a–z) or digit.";
    }
    if (!SLUG_RE.test(draft.slug)) return "Use lowercase letters, numbers and single hyphens.";
    if (!isEdit && takenSlugs.has(draft.slug)) return "An agent with that name already exists.";
    return null;
  }, [draft.name, draft.slug, isEdit, takenSlugs]);

  const promptError = !draft.prompt.trim()
    ? "Instructions are required — this is the agent's system prompt."
    : draft.prompt.length > MAX_PROMPT_CHARS
      ? `Instructions must be ${MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`
      : null;

  const subagentError = useMemo(() => {
    const named = draft.subagents.filter((sa) => sa.name.trim());
    if (named.some((sa) => !sa.prompt.trim())) return "Every sub-agent needs instructions.";
    const slugs = named.map((sa) => slugify(sa.name));
    if (new Set(slugs).size !== slugs.length) return "Sub-agent names must be unique.";
    return null;
  }, [draft.subagents]);

  // Every file that will be written: the generated prompts plus the user's own.
  // Counted against the same caps the backend enforces.
  const generatedCount =
    1 + draft.subagents.filter((sa) => sa.name.trim() && sa.prompt.trim()).length;

  const totalBytes = useMemo(
    () =>
      byteLength(draft.prompt) +
      draft.subagents.reduce((sum, sa) => sum + byteLength(sa.prompt), 0) +
      draft.files.reduce((sum, file) => sum + byteLength(file.content), 0),
    [draft.prompt, draft.subagents, draft.files],
  );

  const fileLimitError = useMemo(() => {
    const oversize = draft.files.find((file) => byteLength(file.content) > MAX_FILE_BYTES);
    if (oversize) {
      return `${oversize.path} exceeds the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`;
    }
    if (generatedCount + draft.files.length > MAX_FILES) {
      return `An agent may have at most ${MAX_FILES} files.`;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return `The definition is ${formatBytes(totalBytes)} — the limit is ${formatBytes(MAX_TOTAL_BYTES)}.`;
    }
    return null;
  }, [draft.files, generatedCount, totalBytes]);

  const localError = slugError ?? promptError ?? subagentError ?? fileLimitError;
  const canSubmit = !localError && !submitting && !checking;

  // Per-section error flags, so a problem in a section you are not looking at
  // is visible on its tab instead of only surfacing when you press Save.
  const sectionTabs: SectionTab<BuilderSection>[] = useMemo(
    () => [
      {
        id: "identity",
        label: "Identity",
        flagged: Boolean(slugError) && (nameTouched || attempted),
      },
      { id: "instructions", label: "Instructions", flagged: Boolean(promptError) },
      { id: "tools", label: "Tools", count: draft.tools.length },
      { id: "skills", label: "Skills", count: draft.skills.length },
      {
        id: "team",
        label: "Team",
        count: draft.subagents.filter((sa) => sa.name.trim()).length,
        flagged: Boolean(subagentError),
      },
      { id: "files", label: "Files", count: draft.files.length, flagged: Boolean(fileLimitError) },
      { id: "approvals", label: "Approvals", count: live ? gatedCount : null },
    ],
    [
      slugError,
      nameTouched,
      attempted,
      promptError,
      subagentError,
      fileLimitError,
      draft.tools.length,
      draft.skills.length,
      live,
      gatedCount,
      draft.subagents,
      draft.files.length,
    ],
  );

  const payload = useMemo(() => buildAgentPayload(draft), [draft]);

  const handleSubmit = async () => {
    // Mark the attempt first: this is the moment an incomplete form becomes a
    // reportable error, and it must stick even when we bail out below.
    setAttempted(true);
    if (localError) {
      // Jump to the section that owns the problem rather than leaving the user
      // to find a red dot on a tab they are not looking at.
      if (slugError) setSection("identity");
      else if (promptError) setSection("instructions");
      else if (subagentError) setSection("team");
      else if (fileLimitError) setSection("files");
      return;
    }
    if (!canSubmit) return;
    setServerErrors([]);
    // Validate first so the server's referential rules (models, skills, prompt
    // resolution) surface as a list instead of one opaque failure toast.
    setChecking(true);
    const result = await onValidate(payload);
    setChecking(false);
    if (result && !result.valid) {
      const messages = result.errors ?? [];
      setServerErrors(messages.length ? messages : ["The definition was rejected."]);
      return;
    }
    const saved = await onSubmit(payload);
    if (saved) onClose();
  };

  const addSubagent = () =>
    setDraft((prev) => ({ ...prev, subagents: [...prev.subagents, emptySubagent()] }));

  const updateSubagent = (index: number, patch: Partial<AgentDraftSubAgent>) =>
    setDraft((prev) => ({
      ...prev,
      subagents: prev.subagents.map((sa, i) => (i === index ? { ...sa, ...patch } : sa)),
    }));

  const removeSubagent = (index: number) =>
    setDraft((prev) => ({ ...prev, subagents: prev.subagents.filter((_, i) => i !== index) }));

  // Only offer what isn't already attached, so the picker is a pure "add" list
  // rather than a toggle list that hides its state behind a search box.
  const unaddedSkills = useMemo(
    () => mySkills.filter((skill) => !draft.skills.includes(skill.name)),
    [mySkills, draft.skills],
  );

  const addSkill = (name: string) =>
    setDraft((prev) =>
      prev.skills.includes(name) ? prev : { ...prev, skills: [...prev.skills, name] },
    );

  const removeSkill = (name: string) =>
    setDraft((prev) => ({ ...prev, skills: prev.skills.filter((s) => s !== name) }));

  // The catalog keyed the way the spec and every override row key a tool, so
  // the picker, the chips and the saved document all speak one identifier.
  const catalogByKey = useMemo(() => {
    const map = new Map<string, ToolMetadata>();
    for (const tool of toolCatalog) map.set(`${tool.serverId}/${tool.toolName}`, tool);
    return map;
  }, [toolCatalog]);

  const unaddedTools = useMemo(
    () => [...catalogByKey.keys()].filter((key) => !draft.tools.includes(key)).sort(),
    [catalogByKey, draft.tools],
  );

  const addTool = (key: string) =>
    setDraft((prev) =>
      prev.tools.includes(key) ? prev : { ...prev, tools: [...prev.tools, key] },
    );

  // A sub-agent may only narrow its agent's tools, so a tool leaving the agent
  // leaves every sub-agent with it — otherwise the save would be refused.
  const removeTool = (key: string) =>
    setDraft((prev) => ({
      ...prev,
      tools: prev.tools.filter((t) => t !== key),
      subagents: prev.subagents.map((sa) =>
        sa.tools.includes(key) ? { ...sa, tools: sa.tools.filter((t) => t !== key) } : sa,
      ),
    }));

  const addSubagentTool = (index: number, key: string) =>
    setDraft((prev) => ({
      ...prev,
      subagents: prev.subagents.map((sa, i) =>
        i === index && !sa.tools.includes(key) ? { ...sa, tools: [...sa.tools, key] } : sa,
      ),
    }));

  const removeSubagentTool = (index: number, key: string) =>
    setDraft((prev) => ({
      ...prev,
      subagents: prev.subagents.map((sa, i) =>
        i === index ? { ...sa, tools: sa.tools.filter((t) => t !== key) } : sa,
      ),
    }));


  /**
   * Add reference files, rejecting each bad one with its own reason.
   *
   * Validation runs here rather than inside the `setDraft` updater so it happens
   * exactly once (an updater may be replayed, which would duplicate the error
   * messages). The updater itself only appends, and re-checks for collisions
   * against the state it actually sees, so two rapid drops can't clobber one
   * another.
   */
  const addFiles = useCallback(
    (incoming: AgentDraftFile[], errors: string[]) => {
      const taken = new Set<string>([
        ...draft.files.map((file) => file.path),
        PROMPT_FILE,
        MANIFEST_FILE,
        ...draft.subagents.filter((sa) => sa.name.trim()).map((sa) => subagentPromptPath(sa.name)),
      ]);
      const accepted: AgentDraftFile[] = [];
      for (const file of incoming) {
        const path = normalisePath(file.path);
        if (!path) {
          errors.push(`${file.path}: not a valid path inside the agent folder.`);
          continue;
        }
        if (!isAllowedExt(path)) {
          errors.push(`${path}: only ${FILE_EXTENSIONS.join(", ")} files are allowed.`);
          continue;
        }
        if (taken.has(path)) {
          errors.push(`${path}: already exists.`);
          continue;
        }
        if (generatedCount + draft.files.length + accepted.length >= MAX_FILES) {
          errors.push(`Reached the ${MAX_FILES}-file limit; some files were skipped.`);
          break;
        }
        taken.add(path);
        accepted.push({ path, content: file.content });
      }

      if (accepted.length) {
        setDraft((prev) => {
          const existing = new Set(prev.files.map((file) => file.path));
          return {
            ...prev,
            files: [...prev.files, ...accepted.filter((file) => !existing.has(file.path))],
          };
        });
        // Reveal the first addition so a newly created empty file is editable.
        setActiveFile(accepted[0].path);
      }
      setFileError(errors.join(" "));
      setServerErrors([]);
    },
    [draft.files, draft.subagents, generatedCount],
  );

  const ingest = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      const results = await Promise.all(Array.from(list).map(readTextFile));
      const errors: string[] = [];
      const ok: AgentDraftFile[] = [];
      results.forEach((result) => {
        if ("error" in result) errors.push(result.error);
        else ok.push(result);
      });
      addFiles(ok, errors);
    },
    [addFiles],
  );

  const handleUploadInput = (event: ChangeEvent<HTMLInputElement>) => {
    void ingest(event.target.files);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    void ingest(event.dataTransfer.files);
  };

  const addEmptyFile = () => {
    const raw = newFilePath.trim();
    if (!raw) return;
    addFiles([{ path: raw, content: "" }], []);
    setNewFilePath("");
  };

  const updateFileContent = (path: string, content: string) => {
    setDraft((prev) => ({
      ...prev,
      files: prev.files.map((file) => (file.path === path ? { ...file, content } : file)),
    }));
    setFileError("");
    setServerErrors([]);
  };

  const removeFile = (path: string) => {
    setDraft((prev) => ({ ...prev, files: prev.files.filter((file) => file.path !== path) }));
    setActiveFile((current) => (current === path ? null : current));
    setFileError("");
  };

  // Colour alone must never carry meaning, so the asterisk is a character with
  // an accessible name, not a red dot.
  const Required = () => (
    <>
      <span className="text-destructive" aria-hidden>
        *
      </span>
      <span className="sr-only">(required)</span>
    </>
  );

  const inputClass =
    "w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const labelClass = "flex flex-col gap-1.5";
  const captionClass = "text-xs font-medium text-muted-foreground";

  return (
    // Fills the height its page gives it (a flex column down from the route
    // container): the tabs stay at the top, the actions at the bottom, and only
    // the section body scrolls.
    <div className="flex h-full min-h-0 flex-col">
      {/* Section nav — horizontal, above the form, as it was in the settings
          panel; P3 replaces it with the builder's own section rail. */}
      <div className="shrink-0 border-b border-border/50">
        <SectionTabs
          tabs={sectionTabs}
          active={section}
          onSelect={setSection}
          idPrefix="agent-builder"
        />
      </div>

      {/* Live preview — the agent as it will appear, plus what it can do. */}
      <div className="shrink-0 pt-3">
        <AgentSummary draft={draft} modelLabel={modelLabel(draft.model)} />
      </div>

      <div className="scrollbar-muted min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-0.5 py-5">
        {/* Form */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="min-w-0"
          >
            {section === "identity" ? (
              <div className="flex flex-col gap-5">
                {/* Identity */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className={labelClass}>
                    <span className={captionClass}>
                      Name <Required />
                    </span>
                    <input
                      className={cn(
                        inputClass,
                        slugError && (nameTouched || attempted) && "border-destructive",
                      )}
                      value={draft.name}
                      onChange={(event) => onNameChange(event.target.value)}
                      onBlur={() => setNameTouched(true)}
                      placeholder="Research Bot"
                      aria-invalid={Boolean(slugError) && (nameTouched || attempted)}
                    />
                    {/* Shown once the name is non-empty, even when nothing could be
                    derived: an identifier that stays blank while the name is filled
                    is exactly the state the user needs to see to understand the error. */}
                    {draft.slug ? (
                      <span className="text-[0.7rem] text-muted-foreground">
                        <code className="font-mono">{draft.slug}</code>
                        {isEdit ? " · cannot change" : null}
                      </span>
                    ) : draft.name.trim() ? (
                      <span className="text-[0.7rem] text-destructive">
                        No identifier could be built from this name.
                      </span>
                    ) : null}
                  </label>

                  <label className={labelClass}>
                    <span className={captionClass}>Model</span>
                    {/* Radix Select, not a native <select>: the native one renders an
                    OS-drawn menu that ignores the app's tokens entirely — light
                    popup in dark mode, wrong type, wrong radius. This is the same
                    primitive the header's agent picker uses. */}
                    <Select value={draft.model} onValueChange={(value) => set("model", value)}>
                      <SelectTrigger className={inputClass} aria-label="Model">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent className="z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                        {MODEL_CHOICES.map((model) => (
                          <SelectItem key={model.id} value={model.id} className="rounded-lg">
                            <span className="flex items-baseline gap-2">
                              <span className="font-medium text-foreground">{model.label}</span>
                              <span className="text-xs text-muted-foreground">{model.hint}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>

                <label className={labelClass}>
                  <span className={captionClass}>Description</span>
                  <input
                    className={inputClass}
                    value={draft.description}
                    onChange={(event) => set("description", event.target.value)}
                    placeholder="What is this agent for?"
                  />
                </label>

                {/* Icon — a dropdown, not ten chips: it is the least consequential
                choice on the form and was taking the most vertical space. */}
                <label className={labelClass}>
                  <span className={captionClass}>Icon</span>
                  <Select value={draft.icon} onValueChange={(value) => set("icon", value)}>
                    <SelectTrigger className={inputClass} aria-label="Icon">
                      <SelectValue placeholder="Choose an icon" />
                    </SelectTrigger>
                    <SelectContent className="z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                      {ICON_CHOICES.map((name) => {
                        const Glyph = ICON_GLYPHS[name] ?? Bot;
                        return (
                          <SelectItem key={name} value={name} className="rounded-lg">
                            <span className="flex items-center gap-2">
                              <Glyph size={15} aria-hidden className="text-primary" />
                              <span>{name}</span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : null}
            {section === "instructions" ? (
              <div className="flex flex-col gap-5">
                {/* Instructions */}
                <label className={labelClass}>
                  <span className={captionClass}>
                    Instructions <Required />
                  </span>
                  <textarea
                    className={cn(
                      inputClass,
                      "min-h-[9rem] resize-y font-mono text-[0.8rem]",
                      promptError && "border-destructive",
                    )}
                    value={draft.prompt}
                    onChange={(event) => set("prompt", event.target.value)}
                    placeholder="You are Research Bot. You dig into topics and return sourced findings…"
                    aria-invalid={Boolean(promptError)}
                  />
                  <span className="text-[0.7rem] tabular-nums text-muted-foreground">
                    {draft.prompt.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()} ·
                    saved as {PROMPT_FILE}
                  </span>
                </label>

                {/* Memory */}
                <SoftPanel className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">Long-term memory</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Lets this agent remember durable facts between your conversations.
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={draft.memory}
                    onToggle={() => set("memory", !draft.memory)}
                    label={`${draft.memory ? "Disable" : "Enable"} long-term memory`}
                  />
                </SoftPanel>
              </div>
            ) : null}
            {section === "tools" ? (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className={captionClass}>MCP tools</span>
                    <VoiceSelector open={toolPickerOpen} onOpenChange={setToolPickerOpen}>
                      <VoiceSelectorTrigger asChild>
                        <button
                          type="button"
                          disabled={unaddedTools.length === 0}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60",
                            toolPickerOpen && "bg-background/80 text-foreground",
                          )}
                        >
                          <Search size={13} aria-hidden /> Add tool
                        </button>
                      </VoiceSelectorTrigger>
                      <VoiceSelectorContent
                        title="Add a tool"
                        className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                      >
                        <VoiceSelectorInput placeholder="Search the gateway..." />
                        <VoiceSelectorList className="max-h-[22rem]">
                          <VoiceSelectorEmpty>No matching tool.</VoiceSelectorEmpty>
                          <VoiceSelectorGroup heading="Available tools">
                            {unaddedTools.map((key) => {
                              const tool = catalogByKey.get(key);
                              return (
                                <VoiceSelectorItem
                                  key={key}
                                  value={`${key} ${tool?.description ?? ""}`}
                                  onSelect={() => {
                                    addTool(key);
                                    setToolPickerOpen(false);
                                  }}
                                  className="items-center gap-3 rounded-xl px-3 py-3"
                                >
                                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                                    <Wrench className="h-3.5 w-3.5" aria-hidden />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <VoiceSelectorName>{tool?.toolName ?? key}</VoiceSelectorName>
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                      {tool?.serverId ?? ""}
                                      {tool?.description ? ` · ${tool.description}` : ""}
                                    </span>
                                  </span>
                                </VoiceSelectorItem>
                              );
                            })}
                          </VoiceSelectorGroup>
                        </VoiceSelectorList>
                      </VoiceSelectorContent>
                    </VoiceSelector>
                  </div>

                  {toolCatalog.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No tools available. The MCP gateway is unreachable, or no servers are
                      connected — an agent saved now simply declares none, and you can add them
                      later by editing it.
                    </p>
                  ) : draft.tools.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No tools yet. An agent with none can still think, write and use its skills —
                      add tools to let it reach outside the conversation.
                    </p>
                  ) : null}

                  {draft.tools.length > 0 ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {live
                          ? "The switch turns a tool on or off for you and applies right away. The bin removes it from the agent — that is saved with Save changes."
                          : "On by default whenever this agent runs. Once it exists you can switch any of them off for yourself, and choose which ones ask before running."}
                      </p>
                      <ul className="flex flex-col gap-2">
                        {draft.tools.map((key) => {
                          const tool = catalogByKey.get(key);
                          return (
                            <li key={key}>
                              <SoftPanel className="flex items-center gap-3 px-3 py-2">
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 text-primary">
                                  <Wrench className="h-3.5 w-3.5" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-foreground">
                                    {tool?.toolName ?? key}
                                  </span>
                                  {tool ? (
                                    <span className="block truncate text-xs text-muted-foreground">
                                      {tool.serverId}
                                      {tool.description ? ` · ${tool.description}` : ""}
                                    </span>
                                  ) : (
                                    // Kept, not dropped: the gateway may simply be
                                    // down, and silently discarding a declared tool
                                    // on save would be a worse answer than saying so.
                                    <span className="block truncate text-xs text-destructive">
                                      {key} — not in the catalog right now.
                                    </span>
                                  )}
                                </span>
                                {live ? (
                                  liveByKey.get(key) ? (
                                    <ToggleSwitch
                                      size="sm"
                                      checked={Boolean(liveByKey.get(key)?.enabled)}
                                      disabled={togglingKey === key || !onToggleTool}
                                      onToggle={() => {
                                        const row = liveByKey.get(key);
                                        if (row) onToggleTool?.(row);
                                      }}
                                      label={`${liveByKey.get(key)?.enabled ? "Turn off" : "Turn on"} ${tool?.toolName ?? key} for you`}
                                    />
                                  ) : (
                                    // Added in this edit and not saved yet: there is
                                    // no per-account row to switch until it is.
                                    <span className="shrink-0 text-[0.7rem] text-muted-foreground">
                                      On after saving
                                    </span>
                                  )
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => removeTool(key)}
                                  aria-label={`Remove tool ${key}`}
                                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                                >
                                  <Trash2 size={15} aria-hidden />
                                </button>
                              </SoftPanel>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {section === "skills" ? (
              <div className="flex flex-col gap-5">
                {/* Skills — searched and added from the user's pool */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className={captionClass}>Skills</span>
                    <VoiceSelector open={skillPickerOpen} onOpenChange={setSkillPickerOpen}>
                      <VoiceSelectorTrigger asChild>
                        <button
                          type="button"
                          disabled={unaddedSkills.length === 0}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60",
                            skillPickerOpen && "bg-background/80 text-foreground",
                          )}
                        >
                          <Search size={13} aria-hidden /> Add skill
                        </button>
                      </VoiceSelectorTrigger>
                      <VoiceSelectorContent
                        title="Add a skill"
                        className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                      >
                        <VoiceSelectorInput placeholder="Search your skills..." />
                        <VoiceSelectorList className="max-h-[22rem]">
                          <VoiceSelectorEmpty>No matching skill in your pool.</VoiceSelectorEmpty>
                          <VoiceSelectorGroup heading="Your skills">
                            {unaddedSkills.map((skill) => (
                              <VoiceSelectorItem
                                key={skill.name}
                                value={`${skill.name} ${skill.description} ${skill.category}`}
                                onSelect={() => {
                                  addSkill(skill.name);
                                  setSkillPickerOpen(false);
                                }}
                                className="items-center gap-3 rounded-xl px-3 py-3"
                              >
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                                  <Wrench className="h-3.5 w-3.5" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <VoiceSelectorName>{skill.name}</VoiceSelectorName>
                                  {skill.description ? (
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                      {skill.description}
                                    </span>
                                  ) : null}
                                </span>
                                {skill.type === "custom" ? (
                                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
                                    custom
                                  </span>
                                ) : null}
                              </VoiceSelectorItem>
                            ))}
                          </VoiceSelectorGroup>
                        </VoiceSelectorList>
                      </VoiceSelectorContent>
                    </VoiceSelector>
                  </div>

                  {mySkills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Your skill pool is empty. Add skills under Settings → Skills, then assign them
                      here.
                    </p>
                  ) : draft.skills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No skills yet — search your pool to give this agent focused know-how.
                    </p>
                  ) : null}

                  {/* Caption AND chips, both under `length > 0`. These were previously the
                  two arms of one ternary, so the chip list only rendered when the list
                  was empty — i.e. never. An added skill vanished from the UI entirely
                  (the picker also filters out anything already added) and its Remove
                  button was unreachable, which made an attached skill permanent. */}
                  {draft.skills.length > 0 ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Copied from your pool when you save, and always available to this agent —
                        you can add more per agent later, but these can't be switched off.
                      </p>
                      <div className="flex flex-col gap-2">
                        {draft.skills.map((name) => {
                          const skill = mySkills.find((s) => s.name === name);
                          return (
                            <SoftPanel key={name} className="flex items-center gap-3 px-3 py-2">
                              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 text-primary">
                                <Wrench className="h-3.5 w-3.5" aria-hidden />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {name}
                                </span>
                                {skill?.description ? (
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {skill.description}
                                  </span>
                                ) : !skill ? (
                                  <span className="block truncate text-xs text-destructive">
                                    No longer in your pool — remove it or re-add the skill.
                                  </span>
                                ) : null}
                              </span>
                              <button
                                type="button"
                                onClick={() => removeSkill(name)}
                                aria-label={`Remove skill ${name}`}
                                className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                              >
                                <Trash2 size={15} aria-hidden />
                              </button>
                            </SoftPanel>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
            {section === "team" ? (
              <div className="flex flex-col gap-5">
                {/* Sub-agents — each with its own model and, optionally, a
                    narrower set of the agent's tools (plan 20 §5.3). */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className={captionClass}>Sub-agents</span>
                    <button
                      type="button"
                      onClick={addSubagent}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <Plus size={13} aria-hidden /> Add sub-agent
                    </button>
                  </div>
                  {draft.subagents.length === 0 ? (
                    // The empty state carries its own action rather than pointing
                    // at the button above.
                    <SoftPanel className="px-5 py-6 text-center">
                      <p className="text-sm font-semibold text-foreground">No sub-agents</p>
                      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                        Helpers this agent can hand work to, each with its own instructions, model
                        and tools.
                      </p>
                      <button
                        type="button"
                        onClick={addSubagent}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <Plus size={13} aria-hidden /> Add a sub-agent
                      </button>
                    </SoftPanel>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {draft.subagents.map((sa, index) => {
                        const label = sa.name.trim() || `sub-agent ${index + 1}`;
                        const pickable = draft.tools.filter((key) => !sa.tools.includes(key));
                        return (
                          <li key={index}>
                            <SoftPanel className="flex flex-col gap-3 px-4 py-3">
                              <div className="flex items-start gap-3">
                                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                                  <input
                                    className={inputClass}
                                    value={sa.name}
                                    onChange={(event) =>
                                      updateSubagent(index, { name: event.target.value })
                                    }
                                    placeholder="researcher"
                                    aria-label="Sub-agent name"
                                  />
                                  <input
                                    className={inputClass}
                                    value={sa.description}
                                    onChange={(event) =>
                                      updateSubagent(index, { description: event.target.value })
                                    }
                                    placeholder="Gathers and verifies sources"
                                    aria-label="Sub-agent description"
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeSubagent(index)}
                                  aria-label={`Remove ${label}`}
                                  className="mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-all hover:text-destructive active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
                                >
                                  <Trash2 size={15} aria-hidden />
                                </button>
                              </div>
                              <textarea
                                className={cn(
                                  inputClass,
                                  "min-h-[5rem] resize-y font-mono text-[0.78rem]",
                                )}
                                value={sa.prompt}
                                onChange={(event) =>
                                  updateSubagent(index, { prompt: event.target.value })
                                }
                                placeholder="You research topics thoroughly and return structured findings…"
                                aria-label="Sub-agent instructions"
                              />
                              {sa.subagents?.length ? (
                                // Nested sub-agents come from agent.yaml; the form
                                // keeps them as they are (editing them here is a
                                // follow-up).
                                <p className="text-xs text-muted-foreground">
                                  Delegates to its own sub-agent
                                  {sa.subagents.length === 1 ? "" : "s"}:{" "}
                                  {sa.subagents.map((child) => child.name).join(", ")} — kept as
                                  defined.
                                </p>
                              ) : null}

                              <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                                <label className={labelClass}>
                                  <span className={captionClass}>Model</span>
                                  <Select
                                    value={sa.model || INHERIT_MODEL}
                                    onValueChange={(value) =>
                                      updateSubagent(index, {
                                        model: value === INHERIT_MODEL ? "" : value,
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      className={inputClass}
                                      aria-label={`Model for ${label}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="z-[90] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                                      <SelectItem value={INHERIT_MODEL} className="rounded-lg">
                                        <span className="flex items-baseline gap-2">
                                          <span className="font-medium text-foreground">
                                            Inherit
                                          </span>
                                          <span className="text-xs text-muted-foreground">
                                            {modelLabel(draft.model)}
                                          </span>
                                        </span>
                                      </SelectItem>
                                      {MODEL_CHOICES.map((model) => (
                                        <SelectItem
                                          key={model.id}
                                          value={model.id}
                                          className="rounded-lg"
                                        >
                                          <span className="flex items-baseline gap-2">
                                            <span className="font-medium text-foreground">
                                              {model.label}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                              {model.hint}
                                            </span>
                                          </span>
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </label>

                                <div className={labelClass}>
                                  <span className={captionClass}>Tools</span>
                                  <div className="flex min-h-[2.375rem] flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
                                    {sa.tools.length === 0 ? (
                                      <span className="px-1 text-xs text-muted-foreground">
                                        All of this agent&rsquo;s tools
                                      </span>
                                    ) : (
                                      <ul className="contents" aria-label={`Tools for ${label}`}>
                                        {sa.tools.map((key) => (
                                          <li
                                            key={key}
                                            className="inline-flex items-center gap-1 rounded-md bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary"
                                          >
                                            {catalogByKey.get(key)?.toolName ?? key}
                                            <button
                                              type="button"
                                              onClick={() => removeSubagentTool(index, key)}
                                              aria-label={`Remove ${key} from ${label}`}
                                              className="rounded p-0.5 transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                            >
                                              <X size={11} aria-hidden />
                                            </button>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                    {pickable.length > 0 ? (
                                      <VoiceSelector
                                        open={subToolPicker === index}
                                        onOpenChange={(open) =>
                                          setSubToolPicker(open ? index : null)
                                        }
                                      >
                                        <VoiceSelectorTrigger asChild>
                                          <button
                                            type="button"
                                            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                          >
                                            <Plus size={12} aria-hidden />
                                            {sa.tools.length === 0 ? "Limit" : "Add"}
                                          </button>
                                        </VoiceSelectorTrigger>
                                        <VoiceSelectorContent
                                          title={`Tools for ${label}`}
                                          className="z-[90] max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-2xl"
                                        >
                                          <VoiceSelectorInput placeholder="Search this agent's tools..." />
                                          <VoiceSelectorList className="max-h-[22rem]">
                                            <VoiceSelectorEmpty>
                                              No matching tool.
                                            </VoiceSelectorEmpty>
                                            <VoiceSelectorGroup heading="This agent's tools">
                                              {pickable.map((key) => {
                                                const tool = catalogByKey.get(key);
                                                return (
                                                  <VoiceSelectorItem
                                                    key={key}
                                                    value={`${key} ${tool?.description ?? ""}`}
                                                    onSelect={() => {
                                                      addSubagentTool(index, key);
                                                      setSubToolPicker(null);
                                                    }}
                                                    className="items-center gap-3 rounded-xl px-3 py-3"
                                                  >
                                                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                                                      <Wrench className="h-3.5 w-3.5" aria-hidden />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                      <VoiceSelectorName>
                                                        {tool?.toolName ?? key}
                                                      </VoiceSelectorName>
                                                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                                        {tool?.serverId ?? key.split("/")[0]}
                                                        {tool?.description
                                                          ? ` · ${tool.description}`
                                                          : ""}
                                                      </span>
                                                    </span>
                                                  </VoiceSelectorItem>
                                                );
                                              })}
                                            </VoiceSelectorGroup>
                                          </VoiceSelectorList>
                                        </VoiceSelectorContent>
                                      </VoiceSelector>
                                    ) : null}
                                  </div>
                                  <span className="text-[0.7rem] text-muted-foreground">
                                    {draft.tools.length === 0
                                      ? "Uses the agent’s built-in tools. Add MCP tools under Tools to limit a sub-agent to some of them."
                                      : sa.tools.length === 0
                                        ? "Leave empty to use everything this agent has, or limit it to a few."
                                        : "Only these — never more than the agent itself has."}
                                  </span>
                                </div>
                              </div>
                            </SoftPanel>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
            {section === "files" ? (
              <div className="flex flex-col gap-5">
                {/* Reference files — extra material the prompts can point at */}
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={(event) => {
                    // Only clear when the pointer truly leaves the panel, not when it
                    // crosses onto a child row (which would flicker the highlight).
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setDragOver(false);
                  }}
                  onDrop={handleDrop}
                  className={cn(
                    "flex flex-col gap-2 rounded-[1.2rem] p-2 transition-shadow",
                    dragOver
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-card"
                      : "ring-1 ring-transparent",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={captionClass}>Reference files</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[0.7rem] text-muted-foreground">
                        {generatedCount + draft.files.length} / {MAX_FILES} ·{" "}
                        {formatBytes(totalBytes)}
                      </span>
                      <button
                        type="button"
                        onClick={() => uploadInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <Upload size={13} aria-hidden /> Upload
                      </button>
                      <input
                        ref={uploadInputRef}
                        type="file"
                        multiple
                        accept={FILE_EXTENSIONS.join(",")}
                        className="hidden"
                        onChange={handleUploadInput}
                        aria-hidden
                        tabIndex={-1}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Optional notes, checklists or examples the agent can read while it works — drop
                    files here or add a path like <code className="font-mono">notes/style.md</code>.
                    Text only ({FILE_EXTENSIONS.join(", ")}). Refer to them from your instructions
                    by their full path, shown next to each file.
                  </p>

                  {draft.files.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {draft.files.map((file) => {
                        const isActive = activeFile === file.path;
                        return (
                          <div key={file.path} className="flex flex-col gap-1.5">
                            <div
                              className={cn(
                                "group flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors",
                                isActive
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-border/60 bg-background/60 hover:bg-background/80",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => setActiveFile(isActive ? null : file.path)}
                                aria-expanded={isActive}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
                              >
                                <FileText
                                  size={14}
                                  className="shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
                                {/* The runtime path, not the stored one: this is the string
                                the instructions have to use for the agent to read it. */}
                                <span className="truncate font-mono text-xs text-foreground">
                                  <span className="text-muted-foreground">{REFERENCE_MOUNT}</span>
                                  {file.path}
                                </span>
                                <span className="shrink-0 text-[0.7rem] text-muted-foreground">
                                  {formatBytes(byteLength(file.content))}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => removeFile(file.path)}
                                aria-label={`Remove ${file.path}`}
                                className="shrink-0 rounded-lg p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50 group-hover:opacity-100"
                              >
                                <Trash2 size={14} aria-hidden />
                              </button>
                            </div>
                            {isActive ? (
                              <textarea
                                className={cn(
                                  inputClass,
                                  "min-h-[7rem] resize-y font-mono text-[0.78rem]",
                                )}
                                value={file.content}
                                onChange={(event) =>
                                  updateFileContent(file.path, event.target.value)
                                }
                                placeholder="File contents…"
                                aria-label={`Contents of ${file.path}`}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <input
                      className={cn(inputClass, "font-mono text-xs")}
                      value={newFilePath}
                      onChange={(event) => setNewFilePath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addEmptyFile();
                        }
                      }}
                      placeholder="references/style-guide.md"
                      aria-label="New reference file path"
                    />
                    <button
                      type="button"
                      onClick={addEmptyFile}
                      disabled={!newFilePath.trim()}
                      aria-label="Add reference file"
                      className="shrink-0 rounded-xl border border-border/60 bg-background/60 p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus size={15} aria-hidden />
                    </button>
                  </div>

                  {fileError ? (
                    <p className="text-xs text-destructive" role="alert">
                      {fileError}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            {section === "approvals" ? (
              <div className="flex flex-col gap-5">
                {/* The mandated approval gates — visible, not hidden */}
                <SoftPanel className="px-4 py-3">
                  <p className="text-sm font-semibold text-foreground">Always asks before</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Writing or editing files, running code, delegating work, and creating skills
                    always need your approval. This applies to every agent and cannot be turned off.
                  </p>
                </SoftPanel>
                {live ? (
                  <div className="flex flex-col gap-2">
                    {liveToolsError ? (
                      <SoftPanel className="flex items-start gap-3 px-4 py-3">
                        <AlertCircle
                          size={16}
                          className="mt-0.5 shrink-0 text-destructive"
                          aria-hidden
                        />
                        <p className="text-sm text-muted-foreground">{liveToolsError}</p>
                      </SoftPanel>
                    ) : null}
                    <ToolList
                      tools={live}
                      axis="approval"
                      loading={liveToolsLoading && live.length === 0}
                      togglingKey={togglingKey}
                      onToggle={onToggleApproval}
                      emptyHint="This agent has no tools to gate."
                    />
                    <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                      Applies right away, for your account — no need to press Save. A tool set to
                      ask pauses the run every time it is called; scheduled runs have nobody to ask
                      and will time out instead.
                    </p>
                  </div>
                ) : (
                  <SoftPanel className="px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">Anything else</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Which other tools ask before running is your choice, per account. As soon as
                      you create this agent you land on its Approvals to set them.
                    </p>
                  </SoftPanel>
                )}
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Errors */}
      {((attempted && localError) || serverErrors.length > 0) && (
        <SoftPanel className="flex items-start gap-3 px-4 py-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 text-sm text-muted-foreground" role="alert">
            {attempted && localError ? (
              <p>{localError}</p>
            ) : (
              <ul className="space-y-1">
                {serverErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </div>
        </SoftPanel>
      )}

      {/* Actions — pinned by the flex column above, so they stay reachable
          however long the section is. */}
      <div className="shrink-0 border-t border-border/50 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Only the blocking reason, and only once a save has been tried —
              a status line that is always populated becomes furniture nobody
              reads, which is worse than an empty slot. */}
          {attempted && localError ? (
            <p className="min-w-0 truncate text-xs text-destructive" role="alert">
              {localError}
            </p>
          ) : (
            <span aria-hidden />
          )}

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || checking}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground",
                "shadow-sm shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-md hover:shadow-primary/25",
                "active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                (submitting || checking) && "cursor-not-allowed opacity-60 active:scale-100",
              )}
            >
              {submitting || checking ? (
                <Loader2 size={15} className="animate-spin" aria-hidden />
              ) : (
                <Bot size={15} aria-hidden />
              )}
              {isEdit ? "Save changes" : "Create agent"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
