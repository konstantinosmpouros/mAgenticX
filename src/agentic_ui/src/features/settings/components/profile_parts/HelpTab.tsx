import { useTheme } from "next-themes";
import { AppWindow, Archive, ExternalLink, MoonStar, Sparkles } from "lucide-react";

import type { ConversationSummary, HelpCard, ToolWithStatus } from "@/shared/lib/types";
import { InfoCard, SoftPanel } from "./shared";

const HELP_CARDS: HelpCard[] = [
    {
        title: "Support",
        desc: "Reach the team for operational or product help when something blocks your workflow.",
    },
    {
        title: "Terms & Conditions",
        desc: "Read the terms governing your use of mAgenticX and its services.",
        href: "/terms",
        external: true,
    },
    {
        title: "Privacy Policy",
        desc: "Learn how we collect, use, and protect your personal data.",
        href: "/privacy",
        external: true,
    },
];

type HelpTabProps = {
    archivedConversations: ConversationSummary[];
    availableTools: ToolWithStatus[];
};

export default function HelpTab({ archivedConversations, availableTools }: HelpTabProps) {
    const { theme } = useTheme();
    const currentTheme = theme === "dark" ? "dark" : "light";
    // Tools are no longer globally enabled/disabled — this is the size of the
    // available MCP catalog (per-agent enablement lives in Settings → Agents).
    const toolCount = availableTools.length;

    const handleHelpCardClick = (card: HelpCard) => {
        if (!card.href) return;
        const target = card.external ? "_blank" : "_self";
        const features = card.external ? "noopener,noreferrer" : undefined;
        window.open(card.href, target, features ?? undefined);
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr),minmax(18rem,0.8fr)]">
                <InfoCard
                    eyebrow="Resources"
                    title="Documentation"
                    description="Docs, support, and legal resources for mAgenticX."
                >
                    <div className="grid gap-4 md:grid-cols-2">
                        {HELP_CARDS.map((card) =>
                            card.href ? (
                                <button
                                    key={card.title}
                                    type="button"
                                    onClick={() => handleHelpCardClick(card)}
                                    className="relative rounded-[1.4rem] bg-muted/30 p-5 text-left transition hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                    aria-label={`${card.title}${card.external ? " (opens in new tab)" : ""}`}
                                >
                                    <h3 className="text-sm font-semibold text-foreground">
                                        {card.title}
                                    </h3>
                                    <p className="mt-2 text-sm text-muted-foreground">{card.desc}</p>
                                    {card.external ? (
                                        <span className="absolute right-4 top-4 text-muted-foreground">
                                            <ExternalLink size={16} />
                                        </span>
                                    ) : null}
                                </button>
                            ) : (
                                <div
                                    key={card.title}
                                    className="rounded-[1.4rem] bg-muted/30 p-5"
                                >
                                    <h3 className="text-sm font-semibold text-foreground">
                                        {card.title}
                                    </h3>
                                    <p className="mt-2 text-sm text-muted-foreground">{card.desc}</p>
                                </div>
                            )
                        )}
                    </div>
                </InfoCard>

                <InfoCard
                    eyebrow="At a glance"
                    title="Workspace health"
                    description="A compact status summary for the most visible settings surfaces."
                >
                    <SoftPanel className="divide-y divide-border/35 overflow-hidden">
                        <div className="flex items-center gap-3 px-4 py-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                <AppWindow size={18} />
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-foreground">
                                    {toolCount} tool{toolCount === 1 ? "" : "s"}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    MCP tools currently available in chat.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                <Archive size={18} />
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-foreground">
                                    {archivedConversations.length} archived conversation{archivedConversations.length === 1 ? "" : "s"}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    History kept out of the main sidebar.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-4">
                            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                {currentTheme === "dark" ? <MoonStar size={18} /> : <Sparkles size={18} />}
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-foreground">
                                    Theme: {currentTheme}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    Active shell appearance for the workspace.
                                </p>
                            </div>
                        </div>
                    </SoftPanel>
                </InfoCard>
            </div>
        </div>
    );
}
