import { useEffect, useState } from "react";

/**
 * The current time, re-read every second while `live` — what an async task's
 * card counts its elapsed time against (plan 41). Idle (no interval at all)
 * when nothing it shows is working, so a settled tree costs no renders.
 */
export function useTaskClock(live: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, live]);
  return now;
}
