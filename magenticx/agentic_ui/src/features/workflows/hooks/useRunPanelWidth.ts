import * as React from "react";

import {
  RUN_PANEL_MAX_SHARE,
  RUN_PANEL_WIDTH,
  RUN_PANEL_WIDTH_STORAGE_KEY,
} from "@/features/workflows/lib/consts";

const maxWidth = () =>
  Math.max(
    RUN_PANEL_WIDTH.min,
    Math.min(
      RUN_PANEL_WIDTH.max,
      Math.round((typeof window === "undefined" ? 1600 : window.innerWidth) * RUN_PANEL_MAX_SHARE),
    ),
  );

const clamp = (value: number) => Math.min(maxWidth(), Math.max(RUN_PANEL_WIDTH.min, Math.round(value)));

function readStored(): number {
  try {
    const raw = Number(window.localStorage.getItem(RUN_PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : RUN_PANEL_WIDTH.initial;
  } catch {
    return RUN_PANEL_WIDTH.initial;
  }
}

function store(width: number) {
  try {
    window.localStorage.setItem(RUN_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Private mode / blocked storage: the width just isn't remembered.
  }
}

/**
 * The run view's side panel width: dragged from its left edge, stepped with
 * the arrow keys (Home / End to the bounds), reset with a double-click,
 * clamped so the graph keeps its share, and remembered per device.
 * `panelRef` goes on the panel (the drag measures from its right edge);
 * `separatorProps` on the handle.
 */
export function useRunPanelWidth() {
  const [width, setWidth] = React.useState(readStored);
  const [dragging, setDragging] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null);

  const commit = React.useCallback((next: number) => {
    const value = clamp(next);
    setWidth(value);
    store(value);
  }, []);

  // A narrower window can leave a remembered width too wide.
  React.useEffect(() => {
    const onResize = () => setWidth((current) => clamp(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    setDragging(true);
    const move = (moveEvent: PointerEvent) => setWidth(clamp(right - moveEvent.clientX));
    const up = (upEvent: PointerEvent) => {
      target.releasePointerCapture?.(upEvent.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDragging(false);
      commit(right - upEvent.clientX);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? RUN_PANEL_WIDTH.step * 3 : RUN_PANEL_WIDTH.step;
    const moves: Record<string, number> = {
      ArrowLeft: width + step,
      ArrowRight: width - step,
      Home: maxWidth(),
      End: RUN_PANEL_WIDTH.min,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    commit(moves[event.key]);
  };

  return {
    width,
    dragging,
    panelRef,
    separatorProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-label": "Resize the run panel",
      "aria-valuemin": RUN_PANEL_WIDTH.min,
      "aria-valuemax": maxWidth(),
      "aria-valuenow": width,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => commit(RUN_PANEL_WIDTH.initial),
    },
  };
}
