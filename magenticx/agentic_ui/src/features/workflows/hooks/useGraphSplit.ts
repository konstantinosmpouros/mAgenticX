import * as React from "react";

import { GRAPH_SPLIT } from "@/features/workflows/lib/consts";

const STORAGE_KEY = "magenticx:workflow-view:graph-split";

const clamp = (value: number) => Math.min(GRAPH_SPLIT.max, Math.max(GRAPH_SPLIT.min, value));

function storedSplit(): number {
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : GRAPH_SPLIT.initial;
  } catch {
    return GRAPH_SPLIT.initial;
  }
}

/**
 * The run view's graph / timeline split: the graph's share of the area's
 * height, dragged by the handle between them (pointer, or arrow keys when it
 * has focus; double-click resets), clamped so neither side vanishes, and
 * remembered on this device. Returns the area ref, the share, whether a drag
 * is under way, and the handle's props.
 */
export function useGraphSplit() {
  const areaRef = React.useRef<HTMLDivElement>(null);
  const [split, setSplit] = React.useState(storedSplit);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ startY: number; startSplit: number; height: number } | null>(null);

  const commit = React.useCallback((value: number) => {
    const next = clamp(value);
    setSplit(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next.toFixed(3));
    } catch {
      // Not remembered: the split still holds for this visit.
    }
  }, []);

  // While dragging, the whole page shows the resize cursor and nothing gets text-selected.
  React.useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const at = (start: { startY: number; startSplit: number; height: number }, clientY: number) =>
    start.startSplit + (clientY - start.startY) / start.height;

  const separatorProps = {
    role: "separator",
    tabIndex: 0,
    "aria-orientation": "horizontal",
    "aria-label": "Resize the graph",
    "aria-valuemin": Math.round(GRAPH_SPLIT.min * 100),
    "aria-valuemax": Math.round(GRAPH_SPLIT.max * 100),
    "aria-valuenow": Math.round(split * 100),
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      const height = areaRef.current?.clientHeight ?? 0;
      if (event.button !== 0 || height <= 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { startY: event.clientY, startSplit: split, height };
      setDragging(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (start) setSplit(clamp(at(start, event.clientY)));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      drag.current = null;
      setDragging(false);
      commit(at(start, event.clientY));
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(false);
    },
    onDoubleClick: () => commit(GRAPH_SPLIT.initial),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? GRAPH_SPLIT.step * 3 : GRAPH_SPLIT.step;
      const moves: Record<string, number> = {
        ArrowUp: split - step,
        ArrowDown: split + step,
        Home: GRAPH_SPLIT.min,
        End: GRAPH_SPLIT.max,
      };
      if (!(event.key in moves)) return;
      event.preventDefault();
      commit(moves[event.key]);
    },
  } as const;

  return { areaRef, split, dragging, separatorProps };
}
