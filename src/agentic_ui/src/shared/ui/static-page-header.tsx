import { ArrowLeft } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";

interface StaticPageHeaderProps {
  icon: ReactNode;
  title: string;
  eyebrow?: string;
}

export function StaticPageHeader({ icon, title, eyebrow = "mAgenticX" }: StaticPageHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            {icon}
          </div>
          <div>
            <p className="text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {eyebrow}
            </p>
            <h1 className="text-base font-semibold text-foreground">{title}</h1>
          </div>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>
      </div>
    </header>
  );
}
