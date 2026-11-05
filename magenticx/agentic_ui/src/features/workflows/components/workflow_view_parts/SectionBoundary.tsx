import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

/**
 * An error boundary around one section of the workflow view (graph,
 * timeline, details), so a crash in one — or the graph's lazy chunk failing
 * to load — leaves the others standing. A class component because React has
 * no hook for boundaries; "Try again" re-mounts the section.
 */
type Props = { label: string; children: ReactNode; className?: string };
type State = { error: Error | null };

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV)
      console.error(`Workflow view: ${this.props.label} crashed`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className={
          this.props.className ??
          "flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground"
        }
      >
        <CircleAlert className="h-5 w-5 text-destructive" aria-hidden />
        <p>The {this.props.label} could not be shown.</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="inline-flex min-h-[2.25rem] items-center gap-1.5 rounded-full px-3 text-xs font-medium text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 supports-[hover:hover]:hover:bg-primary/10"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Try again
        </button>
      </div>
    );
  }
}
