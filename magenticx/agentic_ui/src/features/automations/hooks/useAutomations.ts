import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from "@/shared/lib/api";
import type {
  AutomationItem,
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "@/shared/lib/types";
import { isRunningTask } from "@/features/automations/lib/schedule";

// While the Automations page is active we poll fast for snappy live status;
// while the user is elsewhere we poll slowly just to keep the sidebar "running"
// badge fresh (there is no push channel for work the client hasn't subscribed
// to — discovery is by poll).
const ACTIVE_POLL_MS = 8000;
const BACKGROUND_POLL_MS = 60000;

// `active` is the "/automations" route flag (the page is URL-driven, not
// state-driven), and only controls poll cadence — the route decides what renders.
type UseAutomationsArgs = { userId: string | null | undefined; active: boolean };

/**
 * The user's automations: the list (polled), its CRUD, and the running count
 * for the sidebar badge. The wire is still scheduled tasks in Phase 1; the list
 * is handed out as `AutomationItem`s so the page is already kind-agnostic.
 */
export function useAutomations({ userId, active }: UseAutomationsArgs) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // `loading` is the first load only: a background poll must not swap the page
  // for skeletons (that remounted the empty state's animated mark every 8s).
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    if (!loadedRef.current) setLoading(true);
    try {
      const next = await listScheduledTasks(userId);
      setTasks(next);
      setError(null);
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load automations:", err);
      setError("Could not load your automations.");
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, [userId]);

  const create = useCallback(
    async (payload: ScheduledTaskCreatePayload) => {
      if (!userId) throw new Error("Not signed in.");
      const task = await createScheduledTask(userId, payload);
      setTasks((prev) => [task, ...prev]);
      return task;
    },
    [userId],
  );

  const update = useCallback(
    async (taskId: string, payload: ScheduledTaskUpdatePayload) => {
      if (!userId) throw new Error("Not signed in.");
      const task = await updateScheduledTask(userId, taskId, payload);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? task : t)));
      return task;
    },
    [userId],
  );

  const remove = useCallback(
    async (taskId: string) => {
      if (!userId) throw new Error("Not signed in.");
      let rolledBack: ScheduledTask[] = [];
      setTasks((cur) => {
        rolledBack = cur;
        return cur.filter((t) => t.id !== taskId);
      });
      try {
        await deleteScheduledTask(userId, taskId);
      } catch (err) {
        setTasks(rolledBack);
        throw err;
      }
    },
    [userId],
  );

  // Initial load + cadence-switching poll (fast on /automations, slow off it).
  useEffect(() => {
    if (!userId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const timer = window.setInterval(tick, active ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [userId, active, refresh]);

  const items = useMemo<AutomationItem[]>(
    () => tasks.map((task) => ({ kind: "schedule", task })),
    [tasks],
  );
  const runningCount = useMemo(() => tasks.filter(isRunningTask).length, [tasks]);

  return { items, loading, error, refresh, create, update, remove, runningCount };
}
