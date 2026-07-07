import { useState } from "react";

import { cn } from "@/shared/lib/utils";
import {
    SHORTCUTS,
    detectShortcutPlatform,
    getShortcutLabel,
    type ShortcutCategory,
    type ShortcutPlatform,
} from "@/shared/lib/shortcuts";
import { InfoCard, SoftPanel } from "./shared";

export default function ShortcutsTab() {
    const [shortcutPlatform, setShortcutPlatform] = useState<ShortcutPlatform>(() => detectShortcutPlatform());

    const shortcutSections = (["Workspace", "Chat", "Composer", "Dismiss"] as ShortcutCategory[]).map((category) => ({
        category,
        items: SHORTCUTS.filter((shortcut) => shortcut.category === category),
    }));

    return (
        <div className="space-y-6 animate-fade-in">
            <InfoCard
                eyebrow="Platform"
                title="Shortcut platform"
                description="Swap the visible key labels without changing the underlying shortcut registry."
            >
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <SoftPanel className="flex-1 p-4">
                        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                            Escape behavior
                        </p>
                        <p className="mt-2 text-sm text-foreground">
                            `Esc` dismisses the top active app surface first: image preview, profile panel, agent picker, conversation action menus, sidebar rename or action menus, then inline message editing. It never stops inference or voice dictation.
                        </p>
                    </SoftPanel>
                    <div className="inline-flex rounded-2xl bg-muted/30 p-1">
                        {[
                            { id: "mac" as const, label: "Mac" },
                            { id: "win" as const, label: "Windows/Linux" },
                        ].map((platform) => {
                            const isActive = shortcutPlatform === platform.id;
                            return (
                                <button
                                    key={platform.id}
                                    type="button"
                                    onClick={() => setShortcutPlatform(platform.id)}
                                    className={cn(
                                        "rounded-xl px-4 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] transition-colors",
                                        isActive
                                            ? "bg-primary/15 text-primary"
                                            : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                                    )}
                                >
                                    {platform.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </InfoCard>

            <div className="space-y-5">
                {shortcutSections.map(({ category, items }) => (
                    <section key={category} className="space-y-3">
                        <div className="space-y-1">
                            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                                {category}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {category === "Workspace" && "Global workspace navigation and panel actions."}
                                {category === "Chat" && "Conversation-level actions that affect the current chat shell."}
                                {category === "Composer" && "Composer-local keys handled directly inside the input."}
                                {category === "Dismiss" && "Context-aware closing and cancellation behavior."}
                            </p>
                        </div>
                        <div className="space-y-3">
                            {items.map((shortcut) => (
                                <SoftPanel
                                    key={shortcut.id}
                                    className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr),auto]"
                                >
                                    <div className="space-y-1.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-sm font-semibold text-foreground">
                                                {shortcut.title}
                                            </p>
                                            <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                {shortcut.scope}
                                            </span>
                                            <span className="inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-primary">
                                                {shortcut.implementation}
                                            </span>
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {shortcut.description}
                                        </p>
                                        {shortcut.availabilityNote ? (
                                            <p className="text-[0.68rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                                {shortcut.availabilityNote}
                                            </p>
                                        ) : null}
                                    </div>
                                    <div className="flex items-start md:items-center">
                                        <div className="inline-flex min-w-[9rem] justify-center rounded-xl bg-background/80 px-3 py-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-foreground">
                                            {getShortcutLabel(shortcut, shortcutPlatform)}
                                        </div>
                                    </div>
                                </SoftPanel>
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
