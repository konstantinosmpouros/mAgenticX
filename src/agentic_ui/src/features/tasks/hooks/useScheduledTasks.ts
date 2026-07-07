import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from "@/shared/lib/api";
import type {
  ScheduledTask,
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
} from "@/shared/lib/types";

// A scheduled run is "live" while its latest fire message is still streaming.
const RUNNING_STATUSES = new Set(["queued", "running", "cancelling"]);

export const isTaskRunning = (task: ScheduledTask): boolean =>
  RUNNING_STATUSES.has(String(task.liveStatus ?? ""));

// While the tasks page is active we poll fast for snappy live status; while the
// user is elsewhere we poll slowly just to keep the sidebar "running" badge
// fresh (there is no push channel for work the client hasn't subscribed to —
// discovery is by poll).
const ACTIVE_POLL_MS = 8000;
const BACKGROUND_POLL_MS = 60000;

// `active` is the "/tasks" route flag (the page is URL-driven, not state-driven),
// and only controls poll cadence — the route itself decides what renders.
type UseScheduledTasksArgs = { userId: string | null | undefined; active: boolean };

export function useScheduledTasks({ userId, active }: UseScheduledTasksArgs) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const next = await listScheduledTasks(userId);
      setTasks(next);
      setError(null);
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load scheduled tasks:", err);
      setError("Could not load scheduled tasks.");
    } finally {
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

  // Initial load + cadence-switching poll (fast on the /tasks route, slow off it).
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

  const runningCount = useMemo(() => tasks.filter(isTaskRunning).length, [tasks]);

  return { tasks, loading, error, refresh, create, update, remove, runningCount };
}
