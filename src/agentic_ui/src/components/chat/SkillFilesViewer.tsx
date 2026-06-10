import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
    File as FileIcon,
    FileCode,
    FileText,
    Folder,
    FolderOpen,
    Image as ImageIcon,
} from "lucide-react";

import { buildSkillFileTree, cn } from "@/lib/utils";
import type { SkillFile, SkillTreeNode } from "@/lib/types";

// Read-only counterpart to SkillBuilder — renders a skill's on-disk file tree
// in the "My skills" expand view. Text files show inline; binary assets show
// a metadata placeholder (their bytes aren't shipped on the detail read).

type SkillFilesViewerProps = {
    files: SkillFile[];
    fallbackContent: string;
    prefersReducedMotion: boolean | null;
};

const ENTRY_FILE = "SKILL.md";

const baseName = (path: string): string => path.split("/").pop() ?? path;
const extOf = (path: string): string => {
    const base = baseName(path);
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot).toLowerCase() : "";
};
const formatBytes = (n?: number): string => {
    if (!n || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
const iconForFile = (path: string) => {
    const ext = extOf(path);
    if (ext === ".md" || ext === ".txt") return FileText;
    if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".ico"].includes(ext)) return ImageIcon;
    if (ext) return FileCode;
    return FileIcon;
};

export default function SkillFilesViewer({
    files,
    fallbackContent,
    prefersReducedMotion,
}: SkillFilesViewerProps) {
    const sortedPaths = useMemo(() => files.map((f) => f.path), [files]);
    const tree = useMemo(() => buildSkillFileTree(sortedPaths), [sortedPaths]);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [activePath, setActivePath] = useState<string>(
        files.some((f) => f.path === ENTRY_FILE) ? ENTRY_FILE : files[0]?.path ?? ENTRY_FILE,
    );

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

    const editorMotion = prefersReducedMotion
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.1 } }
        : {
              initial: { opacity: 0, x: 8 },
              animate: { opacity: 1, x: 0 },
              exit: { opacity: 0, x: -8 },
              transition: { duration: 0.18, ease: "easeOut" as const },
          };

    // Single-file skills (just SKILL.md) skip the tree — the parsed body is the
    // whole story and matches the prior, simpler presentation.
    if (files.length <= 1) {
        return (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[0.78rem] leading-relaxed text-foreground/90">
                {fallbackContent || files[0]?.content || "No content."}
            </pre>
        );
    }

    const activeFile = files.find((f) => f.path === activePath) ?? files[0];
    const isText = activeFile?.encoding === "utf-8";

    return (
        <div className="grid gap-3 md:grid-cols-[minmax(0,13rem),1fr]">
            <div className="max-h-72 overflow-y-auto rounded-[1.1rem] bg-muted/40 p-2">
                {flatRows.map(({ node, depth }) => {
                    const indent = { paddingLeft: `${depth * 14 + 8}px` };
                    if (node.isDir) {
                        const isCollapsed = Boolean(collapsed[node.path]);
                        const FolderGlyph = isCollapsed ? Folder : FolderOpen;
                        return (
                            <button
                                key={node.path}
                                type="button"
                                onClick={() => setCollapsed((prev) => ({ ...prev, [node.path]: !prev[node.path] }))}
                                style={indent}
                                aria-expanded={!isCollapsed}
                                className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <FolderGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span className="truncate">{node.name}</span>
                            </button>
                        );
                    }
                    const FileGlyph = iconForFile(node.path);
                    const isActive = activePath === node.path;
                    return (
                        <button
                            key={node.path}
                            type="button"
                            onClick={() => setActivePath(node.path)}
                            style={indent}
                            className={cn(
                                "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors",
                                isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-[hsl(var(--hover-surface))]",
                            )}
                        >
                            <FileGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span className="truncate">{node.name}</span>
                        </button>
                    );
                })}
            </div>

            <div className="min-w-0">
                <AnimatePresence mode="wait" initial={false}>
                    <motion.div key={activeFile?.path ?? ENTRY_FILE} {...editorMotion}>
                        <p className="mb-1.5 truncate font-mono text-[11px] text-muted-foreground">
                            {activeFile?.path}
                        </p>
                        {isText ? (
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[0.78rem] leading-relaxed text-foreground/90">
                                {activeFile?.content || "Empty file."}
                            </pre>
                        ) : (
                            <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                                <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />
                                Binary asset · {formatBytes(activeFile?.size)}
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>
        </div>
    );
}
