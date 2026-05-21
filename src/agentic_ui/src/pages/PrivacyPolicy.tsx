import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { StaticPageHeader } from "@/components/ui/static-page-header";
import { cn } from "@/lib/utils";

const sections = [
    {
        title: "Information We Collect",
        body: "We collect information you provide directly, such as your username and account credentials. We also collect conversation data, messages, and file attachments you submit through the platform, as well as usage data including session activity, feature interactions, and error logs. This data is necessary to provide, maintain, and improve the service.",
    },
    {
        title: "How We Use Your Information",
        body: "We use the information we collect to provide, maintain, and improve the platform; to authenticate your identity and manage your session; to process and respond to your messages and agent requests; to generate conversation titles and summaries; and to diagnose technical issues and monitor service health. We do not sell your personal data to third parties.",
    },
    {
        title: "Data Storage",
        body: "Conversation data, messages, and file attachments are stored in our PostgreSQL database. Vector embeddings used for retrieval are stored in a ChromaDB vector store. Authentication tokens are managed via HashiCorp Vault. All data is stored on secured infrastructure and is not shared with third parties except as described in this policy.",
    },
    {
        title: "AI Processing",
        body: "Your messages and attached files are sent to AI model providers (such as OpenAI) to generate responses. These providers process your data under their own terms of service and privacy policies. Please do not include sensitive personal information such as passwords, financial data, or government-issued ID numbers in your conversations.",
    },
    {
        title: "Data Retention",
        body: "Your conversations and attachments are retained as long as your account is active. You may delete individual conversations at any time through the platform interface. Archived conversations are retained until permanently deleted by you or by an administrator. Upon account deletion, your data is removed in accordance with our data deletion procedures.",
    },
    {
        title: "Cookies and Session Data",
        body: "We use session cookies to maintain your authenticated state across requests. These cookies are HTTP-only, secure, and scoped to this platform only. We do not use tracking cookies, third-party advertising cookies, or any form of cross-site tracking. Cookie preferences may be managed through your browser settings.",
    },
    {
        title: "Data Security",
        body: "We implement industry-standard security measures including encrypted connections (TLS), mutual TLS between internal services, token-based authentication via HashiCorp Vault, and CSRF protection on all state-mutating endpoints. Access to production data is restricted to authorized personnel. No method of transmission over the internet is 100% secure, and we cannot guarantee absolute security.",
    },
    {
        title: "Your Rights",
        body: "You have the right to access, correct, or delete your personal data at any time. You may request a copy of your data, ask us to correct inaccuracies, or request account deletion by contacting us through the Support section in your profile settings. We will respond to verified requests within a reasonable timeframe.",
    },
    {
        title: "Third-Party Services",
        body: "mAgenticX integrates with third-party services including OpenAI for AI inference and optionally MCP-compatible tools (such as Tavily for web search). These services operate under their own privacy policies and terms of service. We encourage you to review those policies before using features that depend on these integrations.",
    },
    {
        title: "Changes to This Policy",
        body: "We may update this Privacy Policy from time to time to reflect changes in our practices, technology, or applicable law. We will notify you of significant changes by updating the date at the top of this page. For material changes, we will provide more prominent notice where feasible. Continued use of the platform after changes are posted constitutes acceptance of the revised policy.",
    },
];

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

export default function PrivacyPolicy() {
    const shouldReduce = useReducedMotion();
    const [activeSection, setActiveSection] = useState(0);

    useEffect(() => {
        const observers = sections.map((_, i) => {
            const el = document.getElementById(`pp-section-${i}`);
            if (!el) return null;
            const observer = new IntersectionObserver(
                ([entry]) => { if (entry.isIntersecting) setActiveSection(i); },
                { rootMargin: "-20% 0px -65% 0px" }
            );
            observer.observe(el);
            return observer;
        });
        return () => observers.forEach((o) => o?.disconnect());
    }, []);

    const handleTocClick = (e: React.MouseEvent<HTMLAnchorElement>, i: number) => {
        e.preventDefault();
        document.getElementById(`pp-section-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    return (
        <div className="min-h-screen bg-background">
            <StaticPageHeader icon={<ShieldCheck size={18} />} title="Privacy Policy" />

            <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
                {/* Hero */}
                <motion.div
                    initial={shouldReduce ? false : { opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, ease }}
                    className="mb-10"
                >
                    <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-8">
                        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/8 blur-3xl" />
                        <div className="pointer-events-none absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-primary/5 blur-2xl" />
                        <div className="relative flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <p className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-primary">Legal</p>
                                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Your Privacy</h2>
                                <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                                    This Privacy Policy describes how mAgenticX collects, uses, and protects your
                                    personal information. We are committed to handling your data responsibly and
                                    transparently.
                                </p>
                            </div>
                            <div className="flex flex-col items-end gap-1 text-right">
                                <span className="text-xs text-muted-foreground">Last updated</span>
                                <span className="text-sm font-semibold text-foreground">May 2025</span>
                                <span className="mt-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-[0.65rem] font-semibold text-muted-foreground">
                                    v1.0
                                </span>
                            </div>
                        </div>
                    </div>
                </motion.div>

                {/* Body: TOC + Document */}
                <motion.div
                    initial={shouldReduce ? false : { opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.15, ease }}
                    className="lg:grid lg:grid-cols-[13rem,1fr] lg:gap-10"
                >
                    {/* Sticky TOC */}
                    <aside className="mb-8 lg:mb-0">
                        <div className="sticky top-24">
                            <p className="mb-3 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                                Contents
                            </p>
                            <nav className="space-y-0.5">
                                {sections.map((s, i) => (
                                    <a
                                        key={i}
                                        href={`#pp-section-${i}`}
                                        onClick={(e) => handleTocClick(e, i)}
                                        className={cn(
                                            "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                                            activeSection === i
                                                ? "bg-primary/8 font-semibold text-primary"
                                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.55rem] font-bold transition-colors",
                                                activeSection === i
                                                    ? "bg-primary/15 text-primary"
                                                    : "bg-muted-foreground/10 text-muted-foreground"
                                            )}
                                        >
                                            {i + 1}
                                        </span>
                                        <span className="leading-tight">{s.title}</span>
                                    </a>
                                ))}
                            </nav>
                        </div>
                    </aside>

                    {/* Document */}
                    <div className="min-w-0">
                        <div className="rounded-3xl border border-border bg-card">
                            {sections.map((section, i) => (
                                <section
                                    key={section.title}
                                    id={`pp-section-${i}`}
                                    className={cn(
                                        "scroll-mt-24 px-8 py-8",
                                        i < sections.length - 1 && "border-b border-border/60"
                                    )}
                                >
                                    <div className="flex items-start gap-5">
                                        <span className="mt-0.5 shrink-0 text-[0.6rem] font-bold uppercase tracking-[0.18em] text-primary/60">
                                            {String(i + 1).padStart(2, "0")}
                                        </span>
                                        <div className="min-w-0">
                                            <h2 className="text-base font-semibold text-foreground">{section.title}</h2>
                                            <p className="mt-3 text-sm leading-7 text-muted-foreground">{section.body}</p>
                                        </div>
                                    </div>
                                </section>
                            ))}
                        </div>

                        <div className="mt-6 rounded-2xl border border-border bg-muted/40 px-6 py-5">
                            <p className="text-xs leading-relaxed text-muted-foreground">
                                Privacy questions or data requests? Contact us through the{" "}
                                <span className="font-semibold text-foreground">Support</span> section in the Help tab
                                of your profile settings.
                            </p>
                        </div>
                    </div>
                </motion.div>
            </main>
        </div>
    );
}
