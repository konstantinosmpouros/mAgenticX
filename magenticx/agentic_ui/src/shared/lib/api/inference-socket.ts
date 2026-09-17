/**
 * Inference run WebSocket client — the live event stream for an in-flight run,
 * with resume-from-last-seq reconnects and a single silent session refresh on a
 * 4401 (expired access token) close.
 *
 * Everything except `connectInferenceWebSocket` is module-private: the backoff
 * schedule, the per-run last-seen sequence map, the two error classes, and the
 * single-connection driver are implementation details of that one loop.
 */
import type { InferenceRunEvent } from "../types";
import { emitUnauthorized } from "../consts";
import { ensureFreshSession } from "../sessionRefresh";
import { transformInferenceRunEvent } from "./inference";
import { INFERENCE_BASE_PATH } from "./paths";

// Reconnect backoff schedule for the inference WebSocket client. After this
// many consecutive failures (without any successful frame in between), the
// outer promise rejects and the caller surfaces a toast. Successful frames
// reset the counter — long-running streams that briefly disconnect should
// recover seamlessly.
// Reconnect backoff, capped rather than exhausted.
//
// This used to be five steps totalling ~9 seconds, after which the client gave
// up permanently. That is fine for a run streaming tokens, but wrong for a run
// PAUSED at a human approval: the user may sit on that prompt for minutes while
// the server holds the run open, and any transient drop in that window (laptop
// sleep, wifi blip, a backgrounded tab) burned all five attempts in nine seconds
// and left the UI permanently blind to a run that was still executing. Approving
// then failed with a stale interrupt and the answer only appeared on refresh.
//
// The run is server-owned and durable, so there is no reason to stop trying:
// back off to 30s and keep going. `waitUntilOnline` below means an offline tab
// costs nothing while it waits.
const INFERENCE_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000];

// Tracks the last delivered Redis-stream entry ID per active run so reconnects
// can resume with ``since=lastSeenSeq``. Cleared when the terminal frame is
// received (or when an explicit abort completes the run).
const lastSeenInferenceSeq = new Map<string, string>();

class PermanentInferenceWebSocketError extends Error {
  readonly permanent = true;
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "PermanentInferenceWebSocketError";
    this.code = code;
  }
}

// The server closed the socket with 4401 (access token expired/invalid). Unlike a
// permanent error this is recoverable: the reconnect loop refreshes the session
// once and reconnects with the fresh cookie, matching the REST 401 behavior. Only
// if that refresh fails is the session genuinely over.
class AuthExpiredWebSocketError extends Error {
  readonly authExpired = true;
  constructor(message: string) {
    super(message);
    this.name = "AuthExpiredWebSocketError";
  }
}

function getInferenceWebSocketUrl(userId: string, runId: string): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const segments = [encodeURIComponent(userId), encodeURIComponent(runId)].join("/");
  return `${wsProtocol}//${window.location.host}${INFERENCE_BASE_PATH}/runs/${segments}/ws`;
}

function inferenceSleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function runOneInferenceWebSocketConnection(
  url: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finalize = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      action();
    };
    const onAbort = () => {
      try {
        socket.close(1000, "Aborted");
      } catch {
        /* ignore */
      }
      finalize(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    socket.onopen = () => {
      const since = lastSeenInferenceSeq.get(runId) ?? null;
      try {
        socket.send(JSON.stringify({ type: "subscribe", since }));
      } catch {
        // Server-side close handler will trigger the reconnect path.
      }
    };

    socket.onmessage = (msg) => {
      onProgress();
      let frame: any;
      try {
        frame = JSON.parse(typeof msg.data === "string" ? msg.data : "");
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "event" && frame.payload) {
        try {
          onEvent(transformInferenceRunEvent(frame.payload));
        } catch {
          // ignore malformed event payload
        }
        if (typeof frame.seq === "string" && frame.seq) {
          lastSeenInferenceSeq.set(runId, frame.seq);
        }
        return;
      }
      if (frame.type === "snapshot" && frame.payload) {
        try {
          onEvent(transformInferenceRunEvent(frame.payload));
        } catch {
          // ignore malformed snapshot payload
        }
        return;
      }
      if (frame.type === "terminal") {
        // The payload is the DB-built final state — apply it so the run
        // flips to its real status even when the terminal stream entry was
        // lost on this socket (send raced the close, reconnect gap).
        if (frame.payload) {
          try {
            onEvent(transformInferenceRunEvent(frame.payload));
          } catch {
            // ignore malformed terminal payload
          }
        }
        finalize(() => {
          try {
            socket.close(1000, "Done");
          } catch {
            /* ignore */
          }
          lastSeenInferenceSeq.delete(runId);
          resolve();
        });
      }
    };

    socket.onerror = () => {
      // The close handler runs immediately after and surfaces the rejection.
    };

    socket.onclose = (event) => {
      if (event.code === 4401) {
        // Recoverable — the reconnect loop refreshes once and retries. Do NOT
        // emit unauthorized here; that only happens if the refresh itself fails.
        finalize(() =>
          reject(new AuthExpiredWebSocketError(event.reason || "Authentication required")),
        );
        return;
      }
      if (event.code === 4403 || event.code === 4404) {
        finalize(() =>
          reject(
            new PermanentInferenceWebSocketError(
              event.reason || `WebSocket closed with code ${event.code}`,
              event.code,
            ),
          ),
        );
        return;
      }
      finalize(() => reject(new Error(`WebSocket closed (code ${event.code})`)));
    };
  });
}

export /**
 * Resolve immediately when online, otherwise wait for the browser's `online`
 * event. Prevents a sleeping/offline tab from spinning through reconnect
 * attempts that cannot possibly succeed.
 */
function waitUntilOnline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    window.addEventListener("online", onOnline);
    signal?.addEventListener("abort", onAbort);
  });
}

export async function connectInferenceWebSocket(
  userId: string,
  runId: string,
  onEvent: (event: InferenceRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = getInferenceWebSocketUrl(userId, runId);
  let consecutiveFailures = 0;
  let authRefreshAttempted = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await runOneInferenceWebSocketConnection(url, runId, onEvent, signal, () => {
        consecutiveFailures = 0;
      });
      return;
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (err?.authExpired) {
        // Mirror the REST 401 flow: refresh the session once, then reconnect with
        // the fresh cookie. A second auth expiry (or a failed refresh) means the
        // session is really over — surface it as unauthorized and stop.
        if (!authRefreshAttempted) {
          authRefreshAttempted = true;
          const outcome = await ensureFreshSession({ force: true });
          if (outcome.status !== "failed") {
            continue;
          }
        }
        emitUnauthorized();
        throw new PermanentInferenceWebSocketError(err.message || "Authentication required", 4401);
      }
      if (err?.permanent) {
        throw err;
      }
      consecutiveFailures += 1;
      // Hold at the longest step instead of giving up — see the note on the
      // backoff table. `runOneInferenceWebSocketConnection` resets this counter
      // as soon as a connection succeeds, so a flaky link recovers to fast
      // retries rather than staying pinned at 30s.
      const delay =
        INFERENCE_RECONNECT_BACKOFF_MS[
          Math.min(consecutiveFailures - 1, INFERENCE_RECONNECT_BACKOFF_MS.length - 1)
        ];
      await inferenceSleepWithAbort(delay, signal);
      // Don't burn a retry against a known-offline network; resume the moment
      // the browser reports connectivity again.
      await waitUntilOnline(signal);
    }
  }
}
