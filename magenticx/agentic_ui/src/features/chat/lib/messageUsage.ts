/**
 * How long the model itself worked on a reply — the summed model-call time the
 * bridge records, not wall-clock (tools and queueing are excluded).
 *
 * Sub-second calls read in milliseconds, anything over a minute in minutes, so
 * the number stays short enough for a tooltip row.
 */
export function formatModelTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}
