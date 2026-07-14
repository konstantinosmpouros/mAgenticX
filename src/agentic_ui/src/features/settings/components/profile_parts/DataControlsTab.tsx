import { useMemo, useState, type UIEvent } from "react";
import { Ban, Check, Copy, Link2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn, fmtDate } from "@/shared/lib/utils";
import type { ConversationShareListItem, ConversationSummary } from "@/shared/lib/types";
import { InfoCard, MetricCard, SoftPanel } from "./shared";
import { ComingSoonRow } from "./ComingSoon";

type DataControlsTabProps = {
    archivedConversations: ConversationSummary[];
    archivedConversationsLoading?: boolean;
    archivedConversationsHasMore?: boolean;
    onLoadMoreArchivedConversations?: () => void;
    onSelectArchivedConversation?: (conversation: ConversationSummary) => void;
    onUnarchiveConversation?: (conversation: ConversationSummary) => void;
    sharedConversations?: ConversationShareListItem[];
    sharedConversationsLoading?: boolean;
    sharedConversationsHasMore?: boolean;
    onLoadMoreSharedConversations?: () => void;
    onSelectSharedConversation?: (share: ConversationShareListItem) => void;
    onRevokeSharedConversation?: (share: ConversationShareListItem) => void;
};

const sharedActionButtonClass = `
    h-8 w-8 text-muted-foreground
    hover:bg-[hsl(var(--hover-surface))] hover:text-muted-foreground
    active:bg-[hsl(var(--hover-surface-strong))] active:text-muted-foreground
    focus:bg-[hsl(var(--hover-surface-strong))] focus:text-muted-foreground focus:outline-none
    focus:ring-0 focus-visible:ring-0 transition-colors
    disabled:pointer-events-none disabled:opacity-45
`;

const sharedTooltipClass = "!opacity-100 bg-background text-foreground border border-border shadow-card px-2 py-1 rounded-md";

const dataControlListClass = cn(
    "max-h-[22rem] overflow-y-auto rounded-[1.35rem]",
    "[scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)_/_0.25)_transparent]",
    "[&::-webkit-scrollbar]:w-3 [&::-webkit-scrollbar-track]:bg-transparent",
    "[&::-webkit-scrollbar-button]:h-0 [&::-webkit-scrollbar-button]:w-0",
    "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2",
    "[&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-[hsl(var(--muted-foreground)/0.25)]",
    "[&::-webkit-scrollbar-thumb:hover]:bg-[hsl(var(--muted-foreground)/0.35)]"
);

export default function DataControlsTab({
    archivedConversations,
    archivedConversationsLoading = false,
    archivedConversationsHasMore = false,
    onLoadMoreArchivedConversations,
    onSelectArchivedConversation,
    onUnarchiveConversation,
    sharedConversations = [],
    sharedConversationsLoading = false,
    sharedConversationsHasMore = false,
    onLoadMoreSharedConversations,
    onSelectSharedConversation,
    onRevokeSharedConversation,
}: DataControlsTabProps) {
    const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

    const latestArchivedConversation = useMemo(() => {
        if (archivedConversations.length === 0) return null;

        return archivedConversations.reduce<ConversationSummary | null>((latest, conversation) => {
            const latestStamp = latest
                ? new Date(latest.archivedAt ?? latest.updated_at).getTime()
                : Number.NEGATIVE_INFINITY;
            const currentStamp = new Date(conversation.archivedAt ?? conversation.updated_at).getTime();
            return currentStamp > latestStamp ? conversation : latest;
        }, null);
    }, [archivedConversations]);

    const activeSharedCount = useMemo(
        () => sharedConversations.filter((share) => share.status === "active").length,
        [sharedConversations]
    );

    const handleArchivedScroll = (event: UIEvent<HTMLDivElement>) => {
        if (!archivedConversationsHasMore || archivedConversationsLoading) {
            return;
        }

        const node = event.currentTarget;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) {
            onLoadMoreArchivedConversations?.();
        }
    };

    const handleSharedScroll = (event: UIEvent<HTMLDivElement>) => {
        if (!sharedConversationsHasMore || sharedConversationsLoading) {
            return;
        }

        const node = event.currentTarget;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) {
            onLoadMoreSharedConversations?.();
        }
    };

    const handleCopyShareLink = (share: ConversationShareListItem) => {
        const url =
            typeof window !== "undefined"
                ? new URL(share.shareUrl, window.location.origin).toString()
                : share.shareUrl;
        void navigator.clipboard?.writeText(url);
        setCopiedShareId(share.id);
        window.setTimeout(() => setCopiedShareId(null), 1200);
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="grid gap-4 lg:grid-cols-3">
                <MetricCard
                    label="Archived Chats"
                    value={String(archivedConversations.length)}
                    hint="Hidden from the sidebar, still restorable"
                />
                <MetricCard
                    label="Latest Archive"
                    value={fmtDate(latestArchivedConversation?.archivedAt ?? latestArchivedConversation?.updated_at)}
                    hint="Most recent archived conversation date"
                />
                <MetricCard
                    label="Shared Links"
                    value={String(activeSharedCount)}
                    hint="Active links visible to people with the URL"
                />
            </div>

            <InfoCard
                eyebrow="History"
                title="Archived conversations"
                description="Archive is a reversible history action. It removes clutter from the main sidebar without deleting the underlying conversation."
            >
                <div className={dataControlListClass} onScroll={handleArchivedScroll}>
                    <div className="space-y-3 p-4">
                        {archivedConversations.length === 0 && !archivedConversationsLoading ? (
                            <SoftPanel className="px-4 py-10 text-center">
                                <p className="text-sm text-muted-foreground">
                                    No archived conversations yet.
                                </p>
                            </SoftPanel>
                        ) : (
                            archivedConversations.map((conversation) => (
                                <SoftPanel key={conversation.id} className="p-4 transition hover:bg-muted/40">
                                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                        <button
                                            type="button"
                                            onClick={() => onSelectArchivedConversation?.(conversation)}
                                            className="min-w-0 flex-1 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                        >
                                            <div className="space-y-1.5">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <p className="truncate text-sm font-semibold text-foreground">
                                                        {conversation.title?.trim() || "Untitled conversation"}
                                                    </p>
                                                    <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                        {conversation.agent.name}
                                                    </span>
                                                </div>
                                                {conversation.lastMessage ? (
                                                    <p className="line-clamp-2 text-sm text-muted-foreground">
                                                        {conversation.lastMessage}
                                                    </p>
                                                ) : null}
                                            </div>
                                        </button>

                                        <div className="flex items-center gap-3 md:flex-col md:items-end">
                                            <div className="text-left md:text-right">
                                                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                                                    Archived
                                                </p>
                                                <p className="mt-1 text-sm text-muted-foreground">
                                                    {fmtDate(conversation.archivedAt ?? conversation.updated_at)}
                                                </p>
                                            </div>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() => onUnarchiveConversation?.(conversation)}
                                                className="h-9 rounded-xl border-0 bg-background/80 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.18em]"
                                            >
                                                Unarchive
                                            </Button>
                                        </div>
                                    </div>
                                </SoftPanel>
                            ))
                        )}

                        {archivedConversationsLoading ? (
                            <SoftPanel className="px-4 py-4 text-center">
                                <p className="text-sm text-muted-foreground">
                                    Loading archived conversations...
                                </p>
                            </SoftPanel>
                        ) : null}
                    </div>
                </div>
            </InfoCard>

            <InfoCard
                eyebrow="Sharing"
                title="Shared conversations"
                description="Review links created from your conversations. Revoking a link immediately blocks public access to that shared snapshot."
            >
                <div className={dataControlListClass} onScroll={handleSharedScroll}>
                    <div className="space-y-3 p-4">
                        {sharedConversations.length === 0 && !sharedConversationsLoading ? (
                            <SoftPanel className="px-4 py-10 text-center">
                                <p className="text-sm text-muted-foreground">
                                    No shared conversations yet.
                                </p>
                            </SoftPanel>
                        ) : (
                            sharedConversations.map((share) => {
                                const statusClass =
                                    share.status === "active"
                                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                        : share.status === "expired"
                                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                            : "bg-muted text-muted-foreground";
                                const modeLabel =
                                    share.shareMode === "message"
                                        ? "Response"
                                        : share.shareMode === "branch"
                                            ? "Thread"
                                            : "Full";

                                return (
                                    <SoftPanel key={share.id} className="p-4 transition hover:bg-muted/40">
                                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                            <button
                                                type="button"
                                                onClick={() => onSelectSharedConversation?.(share)}
                                                className="min-w-0 flex-1 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                            >
                                                <div className="space-y-1.5">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <p className="truncate text-sm font-semibold text-foreground">
                                                            {share.title?.trim() || "Untitled conversation"}
                                                        </p>
                                                        <span className="inline-flex rounded-full bg-muted/70 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                                            {modeLabel}
                                                        </span>
                                                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.18em]", statusClass)}>
                                                            {share.status}
                                                        </span>
                                                    </div>
                                                    <p className="text-sm text-muted-foreground">
                                                        Created {fmtDate(share.createdAt)} · Expires {fmtDate(share.expiresAt)}
                                                    </p>
                                                </div>
                                            </button>

                                            <div className="flex flex-wrap items-center gap-0.5 md:justify-end">
                                                <Tooltip delayDuration={0}>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                handleCopyShareLink(share);
                                                            }}
                                                            className={sharedActionButtonClass}
                                                            aria-label={copiedShareId === share.id ? "Copied" : "Copy share link"}
                                                        >
                                                            <span className="relative inline-block h-4 w-4">
                                                                <Copy
                                                                    className={cn(
                                                                        "absolute inset-0 h-4 w-4 transition-all duration-200",
                                                                        copiedShareId === share.id ? "scale-75 opacity-0" : "scale-100 opacity-100"
                                                                    )}
                                                                />
                                                                <Check
                                                                    className={cn(
                                                                        "absolute inset-0 h-4 w-4 transition-all duration-200",
                                                                        copiedShareId === share.id ? "scale-100 opacity-100" : "scale-75 opacity-0"
                                                                    )}
                                                                />
                                                            </span>
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                        <p>{copiedShareId === share.id ? "Copied" : "Copy"}</p>
                                                    </TooltipContent>
                                                </Tooltip>

                                                <Tooltip delayDuration={0}>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                window.open(new URL(share.shareUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer");
                                                            }}
                                                            className={sharedActionButtonClass}
                                                            aria-label="Open share link"
                                                        >
                                                            <Link2 size={16} />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                        <p>Open link</p>
                                                    </TooltipContent>
                                                </Tooltip>

                                                <Tooltip delayDuration={0}>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            disabled={share.status !== "active"}
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                onRevokeSharedConversation?.(share);
                                                            }}
                                                            className={sharedActionButtonClass}
                                                            aria-label="Revoke share link"
                                                        >
                                                            <Ban size={16} />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="bottom" align="center" className={sharedTooltipClass}>
                                                        <p>Revoke</p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>
                                    </SoftPanel>
                                );
                            })
                        )}

                        {sharedConversationsLoading ? (
                            <SoftPanel className="px-4 py-4 text-center">
                                <p className="text-sm text-muted-foreground">
                                    Loading shared conversations...
                                </p>
                            </SoftPanel>
                        ) : null}
                    </div>
                </div>
            </InfoCard>

            <InfoCard
                eyebrow="Planned"
                title="More data controls"
                description="Mirrored from the target settings layout — these land here once implemented."
            >
                <SoftPanel className="divide-y divide-border/40 overflow-hidden">
                    <ComingSoonRow
                        title="Improve the model for everyone"
                        description="Choose whether your conversations may be used to improve future models."
                    />
                    <ComingSoonRow
                        title="Export data"
                        description="Download a copy of your conversations and account data."
                    />
                    <ComingSoonRow
                        title="Delete account"
                        description="Permanently remove this account and all of its data."
                    />
                </SoftPanel>
            </InfoCard>
        </div>
    );
}
