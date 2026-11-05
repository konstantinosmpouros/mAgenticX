import * as React from "react";

import type { WorkflowTemplateTarget, WorkflowTemplateTargetRegistry } from "@/shared/lib/types";

/**
 * Where the inspector's data panel inserts: every template field of the
 * open step registers itself, the one focused last is the target (a click on
 * a field-less panel pill still lands in the first field). A context, so the
 * fields deep inside the schema form, maps and rule lists need no new props.
 */
export const TemplateTargetContext = React.createContext<WorkflowTemplateTargetRegistry | null>(null);

/** The registry the inspector provides: refs only, so focusing a field re-renders nothing. */
export function useTemplateTargetRegistry(): WorkflowTemplateTargetRegistry {
  const targets = React.useRef<WorkflowTemplateTarget[]>([]);
  const active = React.useRef<WorkflowTemplateTarget | null>(null);
  return React.useMemo<WorkflowTemplateTargetRegistry>(
    () => ({
      register: (target) => {
        targets.current.push(target);
        return () => {
          targets.current = targets.current.filter((entry) => entry !== target);
          if (active.current === target) active.current = null;
        };
      },
      activate: (target) => {
        active.current = target;
      },
      insertPath: (path) => {
        const target = active.current ?? targets.current[0] ?? null;
        if (!target) return false;
        target.insertPath(path);
        return true;
      },
    }),
    [],
  );
}

/**
 * Join the inspector's registry as a field that inserts with `insertPath`;
 * the returned handler goes on the field's focus. Outside an inspector it
 * does nothing.
 */
export function useTemplateTarget(insertPath: (path: string) => void): () => void {
  const registry = React.useContext(TemplateTargetContext);
  const latest = React.useRef(insertPath);
  latest.current = insertPath;
  const target = React.useMemo<WorkflowTemplateTarget>(() => ({ insertPath: (path) => latest.current(path) }), []);
  React.useEffect(() => registry?.register(target), [registry, target]);
  return React.useCallback(() => registry?.activate(target), [registry, target]);
}
