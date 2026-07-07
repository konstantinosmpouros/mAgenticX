import { useCallback, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
    File as FileIcon,
    FileCode,
    FileSpreadsheet,
    FileText,
    Folder,
    FolderOpen,
    Image as ImageIcon,
    Loader2,
    Plus,
    Trash2,
    Upload,
} from "lucide-react";

import { Button } from "@/shared/ui/button";
import { buildSkillFileTree, cn } from "@/shared/lib/utils";
import type { CustomSkillCreatePayload, Skill, SkillTreeNode, UserSkill } from "@/shared/lib/types";

// The "create a custom skill" builder. A custom skill is a folder of files —
// this lets the user author SKILL.md plus extra scripts/reference files and
// drop binary assets (images) in from disk. The InfoCard chrome around it
// lives in the parent (ProfilePanel) so the builder only owns the body.

type DraftFile = {
    path: string;
    content: string; // UTF-8 text, or base64 for binary uploads
    encoding: "utf-8" | "base64";
    size?: number; // decoded byte length, for binary display
};

type SkillBuilderProps = {
    mySkills: UserSkill[];
    availableSkills: Skill[];
    initialName?: string;
    onCreate: (payload: CustomSkillCreatePayload) => Promise<UserSkill | null>;
    onClose: () => void;
    prefersReducedMotion: boolean | null;
};

const ENTRY_FILE = "SKILL.md";
const MAX_FILES = 30;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB — mirrors the agents-service cap
const MAX_DEPTH = 4;

const TEXT_EXT = new Set([
    ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".yaml", ".yml", ".csv", ".toml", ".sh", ".html", ".css",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);
const BINARY_EXT = new Set([...IMAGE_EXT, ".pdf", ".xlsx"]);
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
};
const SCAFFOLD_FOLDERS = ["references/", "scripts/", "assets/"] as const;

const baseName = (path: string): string => path.split("/").pop() ?? path;
const extOf = (path: string): string => {
    const base = baseName(path);
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot).toLowerCase() : "";
};
const isTextExt = (ext: string): boolean => TEXT_EXT.has(ext);
const isAllowedExt = (ext: string): boolean => TEXT_EXT.has(ext) || BINARY_EXT.has(ext);

const formatBytes = (n?: number): string => {
    if (!n || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
};

const iconForFile = (path: string) => {
    const ext = extOf(path);
    if (ext === ".md" || ext === ".txt") return FileText;
    if (IMAGE_EXT.has(ext)) return ImageIcon;
    if (ext === ".xlsx" || ext === ".csv") return FileSpreadsheet;
    if (isTextExt(ext)) return FileCode;
    return FileIcon;
};

const readFile = (file: File): Promise<DraftFile | { error: string }> =>
    new Promise((resolve) => {
        const ext = extOf(file.name);
        if (!isAllowedExt(ext)) {
            resolve({ error: `${file.name}: file type not allowed.` });
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            resolve({ error: `${file.name}: exceeds ${formatBytes(MAX_FILE_BYTES)}.` });
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => resolve({ error: `${file.name}: could not be read.` });
        if (isTextExt(ext)) {
            reader.onload = () =>
                resolve({ path: file.name, content: String(reader.result ?? ""), encoding: "utf-8" });
            reader.readAsText(file);
        } else {
            reader.onload = () =>
                resolve({
                    path: file.name,
                    content: arrayBufferToBase64(reader.result as ArrayBuffer),
                    encoding: "base64",
                    size: file.size,
                });
            reader.readAsArrayBuffer(file);
        }
    });

export default function SkillBuilder({
    mySkills,
    availableSkills,
    initialName,
    onCreate,
    onClose,
    prefersReducedMotion,
}: SkillBuilderProps) {
    const [name, setName] = useState(initialName ?? "");
    const [description, setDescription] = useState("");
    const [files, setFiles] = useState<DraftFile[]>([
        { path: ENTRY_FILE, content: "", encoding: "utf-8" },
    ]);
    // Explicit (possibly empty) folders the user created — these have no files
    // yet but exist as nodes so they can be drop targets. Empty folders aren't
    // persisted server-side; they only matter once a file lands inside.
    const [folders, setFolders] = useState<string[]>([]);
    const [activePath, setActivePath] = useState(ENTRY_FILE);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [newPath, setNewPath] = useState("");
    const [nameTouched, setNameTouched] = useState(false);
    // Active drag target: null = none, "" = root, otherwise a folder path.
    const [dragOverPath, setDragOverPath] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    const newFileInputRef = useRef<HTMLInputElement | null>(null);
    const uploadInputRef = useRef<HTMLInputElement | null>(null);

    const tree = useMemo(() => buildSkillFileTree(files.map((f) => f.path), folders), [files, folders]);
    const flatRows = useMemo(() => {
        const rows: { node: SkillTreeNode; depth: number }[] = [];
        const walk = (nodes: SkillTreeNode[], depth: number) => {
            for (const node of nodes) {
                rows.push({ node, depth });
                if (node.isDir && !collapsed[node.path]) walk(node.children, depth + 1);
            }
        };
        walk(tree, 0);
        return rows;
    }, [tree, collapsed]);

    const activeFile = useMemo(
        () => files.find((f) => f.path === activePath) ?? files[0],
        [files, activePath],
    );

    const nameError = useMemo(() => {
        const trimmed = name.trim();
        if (!trimmed) return "Name is required.";
        if (/[\\/]/.test(trimmed) || trimmed.includes("..") || trimmed.startsWith("."))
            return "No slashes, '..', or a leading dot.";
        if (mySkills.some((s) => s.name === trimmed)) return "You already have a skill with that name.";
        if (availableSkills.some((s) => s.name === trimmed))
            return "That name collides with a global skill.";
        return "";
    }, [name, mySkills, availableSkills]);

    const entryFile = files.find((f) => f.path === ENTRY_FILE);
    const skillMdEmpty = !entryFile || !entryFile.content.trim();
    const canSubmit = !nameError && !skillMdEmpty && !submitting;

    const updateContent = useCallback((path: string, content: string) => {
        setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
    }, []);

    const deleteFile = useCallback(
        (path: string) => {
            if (path === ENTRY_FILE) return;
            setFiles((prev) => prev.filter((f) => f.path !== path));
            setActivePath((current) => (current === path ? ENTRY_FILE : current));
        },
        [],
    );

    const deleteFolder = useCallback((folderPath: string) => {
        const prefix = `${folderPath}/`;
        // Drop the folder, any nested folders, and every file beneath it.
        setFiles((prev) => prev.filter((f) => f.path !== folderPath && !f.path.startsWith(prefix)));
        setFolders((prev) => prev.filter((p) => p !== folderPath && !p.startsWith(prefix)));
        setActivePath((current) =>
            current === folderPath || current.startsWith(prefix) ? ENTRY_FILE : current,
        );
    }, []);

    const addEntry = useCallback(() => {
        const raw = newPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
        const isFolder = raw.endsWith("/");
        const parts = raw.split("/").filter((seg) => seg && seg !== ".");
        if (parts.length === 0) {
            setError("Enter a path — references/ for a folder, references/api.md for a file.");
            return;
        }
        if (parts.length > MAX_DEPTH) {
            setError(`Max folder depth is ${MAX_DEPTH}.`);
            return;
        }
        if (parts.some((seg) => seg.includes("..") || seg.startsWith("."))) {
            setError("Path segments can't contain '..' or start with a dot.");
            return;
        }
        const path = parts.join("/");
        // Trailing slash → create an (empty) folder; no filename/extension needed.
        if (isFolder) {
            if (folders.includes(path) || files.some((f) => f.path === path || f.path.startsWith(`${path}/`))) {
                setError("That folder already exists.");
                return;
            }
            setFolders((prev) => [...prev, path]);
            setCollapsed((prev) => ({ ...prev, [path]: false }));
            setNewPath("");
            setError("");
            return;
        }
        const ext = extOf(path);
        if (!ext) {
            setError("Add a filename (e.g. references/api.md), or end with “/” to make a folder.");
            return;
        }
        if (BINARY_EXT.has(ext)) {
            setError("Use the upload button (or drag-drop) for images and other binary files.");
            return;
        }
        if (!isTextExt(ext)) {
            setError(`Files of type ${ext} aren't allowed.`);
            return;
        }
        if (files.some((f) => f.path === path)) {
            setError("That file already exists.");
            return;
        }
        if (files.length >= MAX_FILES) {
            setError(`A skill can have at most ${MAX_FILES} files.`);
            return;
        }
        setFiles((prev) => [...prev, { path, content: "", encoding: "utf-8" }]);
        setActivePath(path);
        setNewPath("");
        setError("");
    }, [newPath, files, folders]);

    const ingestFiles = useCallback(
        async (fileList: FileList | null, targetDir = "") => {
            if (!fileList || fileList.length === 0) return;
            const results = await Promise.all(Array.from(fileList).map(readFile));
            const errors: string[] = [];
            const dirDepth = targetDir ? targetDir.split("/").filter(Boolean).length : 0;
            setFiles((prev) => {
                const next = [...prev];
                const taken = new Set(next.map((f) => f.path));
                let firstAdded: string | null = null;
                for (const result of results) {
                    if ("error" in result) {
                        errors.push(result.error);
                        continue;
                    }
                    if (next.length >= MAX_FILES) {
                        errors.push(`Reached the ${MAX_FILES}-file limit; some files were skipped.`);
                        break;
                    }
                    const base = baseName(result.path);
                    if (dirDepth + 1 > MAX_DEPTH) {
                        errors.push(`${base}: ${targetDir}/ is too deeply nested.`);
                        continue;
                    }
                    let path = targetDir ? `${targetDir}/${base}` : base;
                    if (taken.has(path)) {
                        const ext = extOf(path);
                        const stem = ext ? path.slice(0, -ext.length) : path;
                        let i = 2;
                        while (taken.has(`${stem}-${i}${ext}`)) i += 1;
                        path = `${stem}-${i}${ext}`;
                    }
                    taken.add(path);
                    next.push({ ...result, path });
                    if (!firstAdded) firstAdded = path;
                }
                if (firstAdded) setActivePath(firstAdded);
                return next;
            });
            setError(errors.join(" "));
        },
        [],
    );

    const handleRootDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragOverPath(null);
            void ingestFiles(event.dataTransfer.files, "");
        },
        [ingestFiles],
    );

    const handleUploadInput = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => {
            void ingestFiles(event.target.files);
            event.target.value = "";
        },
        [ingestFiles],
    );

    const handleSubmit = useCallback(async () => {
        setNameTouched(true);
        if (nameError) return;
        if (skillMdEmpty) {
            setError("Add some content to SKILL.md before creating.");
            return;
        }
        setSubmitting(true);
        setError("");
        try {
            const created = await onCreate({
                name: name.trim(),
                description: description.trim(),
                files: files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })),
            });
            if (created) {
                onClose();
            } else {
                setError("The skill could not be created. See the notification for details.");
            }
        } finally {
            setSubmitting(false);
        }
    }, [nameError, skillMdEmpty, onCreate, name, description, files, onClose]);

    const rowMotion = prefersReducedMotion
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.1 } }
        : {
              initial: { opacity: 0, x: -6 },
              animate: { opacity: 1, x: 0 },
              exit: { opacity: 0, x: -6 },
              transition: { duration: 0.16, ease: "easeOut" as const },
          };
    const editorMotion = prefersReducedMotion
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.1 } }
        : {
              initial: { opacity: 0, x: 8 },
              animate: { opacity: 1, x: 0 },
              exit: { opacity: 0, x: -8 },
              transition: { duration: 0.2, ease: "easeOut" as const },
          };

    const inputClass =
        "w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

    const activeExt = activeFile ? extOf(activeFile.path) : "";
    const activeIsImage = activeFile?.encoding === "base64" && activeExt in IMAGE_MIME;
    const ActiveGlyph = activeFile ? iconForFile(activeFile.path) : FileIcon;

    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                        Name <span className="text-destructive">*</span>
                    </span>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() => setNameTouched(true)}
                        placeholder="my-blog-writer"
                        disabled={submitting}
                        aria-label="Skill name"
                        aria-invalid={nameTouched && Boolean(nameError)}
                        className={cn(inputClass, nameTouched && nameError && "border-destructive focus-visible:ring-destructive")}
                    />
                    {nameTouched && nameError ? (
                        <span role="alert" className="text-[11px] text-destructive">
                            {nameError}
                        </span>
                    ) : (
                        <span className="text-[11px] text-muted-foreground">Lowercase, no slashes, unique.</span>
                    )}
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">Description</span>
                    <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Short one-liner — shown on the card."
                        disabled={submitting}
                        aria-label="Skill description"
                        className={inputClass}
                    />
                </label>
            </div>

            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverPath("");
                }}
                onDragLeave={(e) => {
                    // Only clear when the pointer truly leaves the panel, not when
                    // it crosses into a child row (avoids highlight flicker).
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOverPath(null);
                }}
                onDrop={handleRootDrop}
                className={cn(
                    "grid gap-3 rounded-[1.4rem] p-2 transition-shadow md:grid-cols-[minmax(0,15rem),1fr]",
                    dragOverPath === ""
                        ? "ring-2 ring-primary ring-offset-2 ring-offset-card"
                        : "ring-1 ring-transparent",
                )}
            >
                {/* File tree */}
                <div className="flex max-h-[22rem] flex-col gap-2 rounded-[1.2rem] bg-muted/30 p-2">
                    <div className="flex items-center justify-between px-1.5 pt-0.5">
                        <span className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            Files
                        </span>
                        <Tooltipless
                            label="Upload files"
                            onClick={() => uploadInputRef.current?.click()}
                        />
                        <input
                            ref={uploadInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={handleUploadInput}
                            aria-hidden
                            tabIndex={-1}
                        />
                    </div>

                    <div className="scrollbar-muted min-h-0 flex-1 overflow-y-auto pr-0.5">
                        <AnimatePresence initial={false}>
                            {flatRows.map(({ node, depth }) => {
                                const indent = { paddingLeft: `${depth * 14 + 8}px` };
                                if (node.isDir) {
                                    const isCollapsed = Boolean(collapsed[node.path]);
                                    const FolderGlyph = isCollapsed ? Folder : FolderOpen;
                                    const isDropTarget = dragOverPath === node.path;
                                    return (
                                        <motion.div key={node.path} {...rowMotion}>
                                            <div
                                                onDragOver={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setDragOverPath(node.path);
                                                }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setDragOverPath(null);
                                                    setCollapsed((prev) => ({ ...prev, [node.path]: false }));
                                                    void ingestFiles(e.dataTransfer.files, node.path);
                                                }}
                                                style={indent}
                                                className={cn(
                                                    "group flex items-center gap-1.5 rounded-md py-1 pr-1.5 transition-colors",
                                                    isDropTarget
                                                        ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                                                        : "text-muted-foreground hover:bg-[hsl(var(--hover-surface))]",
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setCollapsed((prev) => ({ ...prev, [node.path]: !prev[node.path] }))
                                                    }
                                                    aria-expanded={!isCollapsed}
                                                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium transition-colors hover:text-foreground focus-visible:outline-none"
                                                >
                                                    <FolderGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                                    <span className="truncate">{node.name}</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => deleteFolder(node.path)}
                                                    aria-label={`Delete folder ${node.path} and its contents`}
                                                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                        </motion.div>
                                    );
                                }
                                const FileGlyph = iconForFile(node.path);
                                const isActive = activePath === node.path;
                                const isEntry = node.path === ENTRY_FILE;
                                return (
                                    <motion.div key={node.path} {...rowMotion}>
                                        <div
                                            style={indent}
                                            className={cn(
                                                "group flex items-center gap-1.5 rounded-md py-1 pr-1.5 transition-colors",
                                                isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-[hsl(var(--hover-surface))]",
                                            )}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => setActivePath(node.path)}
                                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs focus-visible:outline-none"
                                            >
                                                <FileGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                                <span className="truncate">{node.name}</span>
                                                {isEntry ? (
                                                    <span className="ml-1 shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                        entry
                                                    </span>
                                                ) : null}
                                            </button>
                                            {!isEntry ? (
                                                <button
                                                    type="button"
                                                    onClick={() => deleteFile(node.path)}
                                                    aria-label={`Delete ${node.path}`}
                                                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            ) : null}
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    </div>

                    <div className="flex flex-wrap gap-1 px-1">
                        {SCAFFOLD_FOLDERS.map((folder) => (
                            <motion.button
                                key={folder}
                                type="button"
                                whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
                                onClick={() => {
                                    setNewPath(folder);
                                    setError("");
                                    newFileInputRef.current?.focus();
                                }}
                                className="rounded-full border border-border/50 bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                                {folder}
                            </motion.button>
                        ))}
                    </div>

                    <div className="flex items-center gap-1.5 px-1 pb-0.5">
                        <input
                            ref={newFileInputRef}
                            type="text"
                            value={newPath}
                            onChange={(e) => setNewPath(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    addEntry();
                                }
                            }}
                            placeholder="references/api.md, or references/ for a folder"
                            aria-label="New file or folder path"
                            className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={addEntry}
                            disabled={!newPath.trim()}
                            aria-label="Add file or folder"
                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                {/* Editor */}
                <div className="flex max-h-[22rem] min-h-[16rem] flex-col rounded-[1.2rem] bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2 pb-2">
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {activeFile?.path ?? ENTRY_FILE}
                        </p>
                        {activeFile?.encoding === "utf-8" ? (
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {activeFile.content.split("\n").length} lines
                            </span>
                        ) : (
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                                {formatBytes(activeFile?.size)}
                            </span>
                        )}
                    </div>
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div key={activeFile?.path ?? ENTRY_FILE} className="h-full" {...editorMotion}>
                                {!activeFile ? null : activeFile.encoding === "utf-8" ? (
                                    <textarea
                                        value={activeFile.content}
                                        onChange={(e) => updateContent(activeFile.path, e.target.value)}
                                        disabled={submitting}
                                        aria-label={`Content of ${activeFile.path}`}
                                        placeholder={
                                            activeFile.path === ENTRY_FILE
                                                ? "# Title\n\nDescribe when and how the agent should use this skill."
                                                : "File content…"
                                        }
                                        className="scrollbar-muted h-full w-full resize-none rounded-md border border-border/60 bg-background/60 p-3 font-mono text-[0.78rem] leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    />
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 p-4 text-center">
                                        {activeIsImage ? (
                                            <img
                                                src={`data:${IMAGE_MIME[activeExt]};base64,${activeFile.content}`}
                                                alt={activeFile.path}
                                                className="max-h-32 max-w-full rounded-md object-contain"
                                            />
                                        ) : (
                                            <ActiveGlyph className="h-8 w-8 text-muted-foreground" aria-hidden />
                                        )}
                                        <p className="text-xs text-muted-foreground">
                                            Binary asset · {formatBytes(activeFile.size)}
                                        </p>
                                    </div>
                                )}
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>
            </div>

            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Drop files onto a folder (or anywhere for root), or use the upload button.
            </p>

            {error ? (
                <p role="alert" className="text-xs text-destructive">
                    {error}
                </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
                <Button
                    type="button"
                    variant="ghost"
                    onClick={onClose}
                    disabled={submitting}
                    className="inline-flex h-10 items-center justify-center rounded-xl px-3 text-sm text-foreground transition-smooth hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={!canSubmit}
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-medium transition-smooth disabled:pointer-events-none disabled:opacity-50"
                >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    {submitting ? "Creating…" : "Create skill"}
                </Button>
            </div>
        </div>
    );
}

// Tiny icon-button used in the tree header. Kept inline (not the shared Button
// with a Tooltip) so the file-tree header stays compact.
const Tooltipless = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
        <Upload className="h-3.5 w-3.5" />
    </button>
);
