import { useEffect } from "react";

/**
 * Escape leaves the page for `onEscape` — but not while something on top of it
 * owns the key: a menu, a dialog, a select's list. Those close themselves on
 * the same keypress, so acting on it here too would close two things at once.
 */
export function useEscapeTo(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]')) {
        return;
      }
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape, enabled]);
}

/**
 * The browser tab's title while a page is open. Not restored on unmount: the
 * route container (AgentsView) restores the chat's title when the section is
 * left, which a page cannot do reliably — moving between two Agents pages
 * mounts the next before the last has gone.
 */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · mAgenticX`;
  }, [title]);
}
