import * as React from "react";

/** Below this builder width the inspector stops docking and slides over the canvas. */
const DOCK_MIN_AREA = 880;
/** The canvas keeps at least this much room beside a docked inspector. */
const CANVAS_MIN = 420;
const PANEL_MIN = 340;
const PANEL_MAX = 760;
const PANEL_DEFAULT = 420;
const KEY_STEP = 16;
const STORAGE_KEY = "magenticx:agent-builder:inspector-width";

export type InspectorLayout = "docked" | "drawer";

function storedWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

/**
 * The builder's inspector sizing: watches the canvas + inspector area and
 * says whether the inspector docks beside the canvas (wide enough) or slides
 * over it as a drawer (too narrow to share). Docked, it owns the width the
 * user drags its edge to, clamped so the canvas keeps room, and remembers it
 * on this device. Returns the area ref, the layout, the width and the
 * separator's props (pointer drag, arrow keys, double-click to reset).
 */
export function useInspectorPanel() {
  const areaRef = React.useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = React.useState<number | null>(null);
  const [preferred, setPreferred] = React.useState(storedWidth);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ startX: number; startWidth: number } | null>(null);

  React.useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = areaWidth === null ? PANEL_MAX : Math.max(PANEL_MIN, Math.min(PANEL_MAX, areaWidth - CANVAS_MIN));
  const clamp = React.useCallback((value: number) => Math.round(Math.min(max, Math.max(PANEL_MIN, value))), [max]);
  const width = clamp(preferred);
  const layout: InspectorLayout = areaWidth !== null && areaWidth < DOCK_MIN_AREA ? "drawer" : "docked";

  const commit = React.useCallback(
    (value: number) => {
      const next = clamp(value);
      setPreferred(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Storage off (private mode, quota): the width just isn't remembered.
      }
    },
    [clamp],
  );

  // While dragging, the whole page shows the resize cursor and nothing gets text-selected.
  React.useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const separatorProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-label": "Resize the inspector",
    "aria-valuemin": PANEL_MIN,
    "aria-valuemax": max,
    "aria-valuenow": width,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { startX: event.clientX, startWidth: width };
      setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      // The panel sits on the right: dragging its edge left widens it.
      if (start) setPreferred(clamp(start.startWidth + start.startX - event.clientX));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      drag.current = null;
      setDragging(false);
      commit(start.startWidth + start.startX - event.clientX);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
    },
    onDoubleClick: () => commit(PANEL_DEFAULT),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
      const moves: Record<string, number> = {
        ArrowLeft: width + step,
        ArrowRight: width - step,
        Home: PANEL_MAX,
        End: PANEL_MIN,
      };
      if (!(event.key in moves)) return;
      event.preventDefault();
      commit(moves[event.key]);
    },
  } as const;

  return { areaRef, layout, width, dragging, separatorProps };
}
