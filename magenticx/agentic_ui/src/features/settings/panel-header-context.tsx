import { createContext, useContext, useEffect } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Lets a settings tab replace the panel's header while it is on an inner page.
 *
 * Several tabs are not one screen but a small stack — Skills has *Your skills*,
 * *Add from catalog*, *New custom skill*; Agents has a detail page and a
 * builder; Memories has a per-agent view. Each of those used to render its own
 * title and description card, directly beneath the panel's header, which said
 * the same kind of thing about a different level. Two headers, one screen.
 *
 * Instead a tab publishes what it is currently showing, and the panel's single
 * header follows it. Going into *Your skills* retitles the top of the panel
 * rather than adding a second title under it.
 *
 * The override is cleared on unmount, so a tab that stops publishing (or is
 * switched away from) falls back to its static section metadata with no
 * bookkeeping at the call site.
 */
export type PanelHeader = {
  /** Small uppercase label above the title; omit to keep the section's own. */
  eyebrow?: string;
  title: string;
  description?: string;
  /** Renders a back affordance in the header when the page has a parent. */
  onBack?: () => void;
  /** Label for that affordance — the place it returns to, not "Back". */
  backLabel?: string;
  /**
   * A single page-level action, rendered in the header beside the close button.
   *
   * Described rather than passed as a node on purpose: the header is held in
   * state, and a ReactNode would be a new value on every render, so the effect
   * below would republish forever. A plain object of primitives (plus a
   * module-level icon) has stable identity, and the panel owns the styling so
   * every tab's action looks the same.
   */
  action?: {
    icon: LucideIcon;
    /** Accessible name and tooltip — describe the effect, e.g. "Refresh skills". */
    label: string;
    onClick: () => void;
    /** Disables the control and spins the icon while the work is in flight. */
    busy?: boolean;
  };
};

export type PanelHeaderStore = {
  setHeader: (header: PanelHeader | null) => void;
};

/**
 * The panel owns the state and provides only the setter: it renders the header
 * from its own state, so exposing the value here would be a second source of
 * truth for the same thing.
 */
export const PanelHeaderContext = createContext<PanelHeaderStore | null>(null);

/**
 * Publish a header for as long as this component is mounted.
 *
 * Pass `null` to fall back to the section default — useful for a tab whose root
 * page wants the static metadata but whose inner pages do not.
 *
 * `onBack` is intentionally excluded from the dependency list: callers almost
 * always pass an inline arrow, so including it would re-publish on every render
 * and loop. The identity of the *page* is what matters, and that is captured by
 * the title and description.
 */
export function usePanelHeader(header: PanelHeader | null): void {
  const store = useContext(PanelHeaderContext);
  const setHeader = store?.setHeader;
  const { eyebrow, title, description, backLabel, onBack, action } = header ?? {};
  const actionLabel = action?.label;
  const actionBusy = action?.busy;
  const ActionIcon = action?.icon;

  useEffect(() => {
    if (!setHeader) return;
    setHeader(title ? { eyebrow, title, description, backLabel, onBack, action } : null);
    return () => setHeader(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the docstring
  }, [setHeader, eyebrow, title, description, backLabel, actionLabel, actionBusy, ActionIcon]);
}
