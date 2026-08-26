import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { StaticPageHeader } from "@/shared/ui/static-page-header";
import { cn } from "@/shared/lib/utils";

/**
 * The shell every legal document renders in: header, hero, sticky table of
 * contents with scroll-spy, numbered sections, and a contact footer.
 *
 * Terms and Privacy were byte-identical here across 150 lines — only eight
 * values differed (title, icon, eyebrow, intro, date, version, the anchor-id
 * prefix, and the footer sentence). Duplicating a scroll-spy `IntersectionObserver`
 * is exactly the kind of thing that gets fixed in one copy and not the other, so
 * the layout lives here once and the pages supply only their content.
 */

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

export type LegalSection = {
  title: string;
  body: string;
};

type LegalPageProps = {
  /** Header icon, e.g. `<ScrollText size={18} />`. */
  icon: ReactNode;
  /** Browser-header title, e.g. "Terms & Conditions". */
  title: string;
  /** Large hero heading, e.g. "Terms of Service". */
  heading: string;
  /** One or two sentences under the heading. */
  intro: ReactNode;
  lastUpdated: string;
  version: string;
  /**
   * Anchor-id prefix (`tc`, `pp`, …). Distinct per page so two legal documents
   * open in the same session cannot collide on `#…-section-0`.
   */
  idPrefix: string;
  sections: LegalSection[];
  /** Closing contact note; the wording differs per document. */
  footer: ReactNode;
};

export function LegalPage({
  icon,
  title,
  heading,
  intro,
  lastUpdated,
  version,
  idPrefix,
  sections,
  footer,
}: LegalPageProps) {
  const shouldReduce = useReducedMotion();
  const [activeSection, setActiveSection] = useState(0);
  const sectionId = (index: number) => `${idPrefix}-section-${index}`;

  useEffect(() => {
    const observers = sections.map((_, i) => {
      const el = document.getElementById(`${idPrefix}-section-${i}`);
      if (!el) return null;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveSection(i);
        },
        { rootMargin: "-20% 0px -65% 0px" },
      );
      observer.observe(el);
      return observer;
    });
    return () => observers.forEach((o) => o?.disconnect());
  }, [sections, idPrefix]);

  const handleTocClick = (e: MouseEvent<HTMLAnchorElement>, i: number) => {
    e.preventDefault();
    document
      .getElementById(`${idPrefix}-section-${i}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background">
      <StaticPageHeader icon={icon} title={title} />

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
                <p className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-primary">
                  Legal
                </p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
                  {heading}
                </h2>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {intro}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <span className="text-xs text-muted-foreground">Last updated</span>
                <span className="text-sm font-semibold text-foreground">{lastUpdated}</span>
                <span className="mt-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-[0.65rem] font-semibold text-muted-foreground">
                  {version}
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
                    key={s.title}
                    href={`#${sectionId(i)}`}
                    onClick={(e) => handleTocClick(e, i)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                      activeSection === i
                        ? "bg-primary/8 font-semibold text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[0.55rem] font-bold transition-colors",
                        activeSection === i
                          ? "bg-primary/15 text-primary"
                          : "bg-muted-foreground/10 text-muted-foreground",
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
                  id={sectionId(i)}
                  className={cn(
                    "scroll-mt-24 px-8 py-8",
                    i < sections.length - 1 && "border-b border-border/60",
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
              <p className="text-xs leading-relaxed text-muted-foreground">{footer}</p>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
