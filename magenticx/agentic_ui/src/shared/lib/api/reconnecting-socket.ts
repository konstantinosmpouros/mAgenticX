/**
 * A reconnecting JSON WebSocket driver for the bridge's subscription sockets —
 * the conversation channel and a task's own socket (plan 41).
 *
 * It holds the same policy as the run socket (`inference-socket.ts`): the
 * thing being watched is server-owned and durable, so a dropped socket is
 * retried forever with a capped backoff (never given up on), an offline tab
 * waits for `online` instead of spinning, a 4401 close refreshes the session
 * once and reconnects, and 4403/4404 are permanent. Kept apart from the run
 * socket rather than folded into it so that hot path is not touched by this
 * plan; both follow the same table.
 */
import { emitUnauthorized } from "../consts";
import { ensureFreshSession } from "../sessionRefresh";
import { waitUntilOnline } from "./inference-socket";

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000];

class PermanentSocketError extends Error {
  readonly permanent = true;
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "PermanentSocketError";
    this.code = code;
  }
}

class AuthExpiredSocketError extends Error {
  readonly authExpired = true;
  constructor(message: string) {
    super(message);
    this.name = "AuthExpiredSocketError";
  }
}

export type ReconnectingSocketHandlers = {
  /** The first message after every (re)connect: the subscribe frame. */
  subscribe: () => unknown;
  /** Called after each successful open — a caller re-syncs what a gap may have hidden. */
  onOpen?: () => void;
  /** One parsed frame. Returning `"done"` closes the socket and resolves. */
  onFrame: (frame: unknown) => "done" | void;
};

/** `ws(s)://<host><path>` for a bridge socket path. */
export function bridgeSocketUrl(path: string): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${window.location.host}${path}`;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function runOneConnection(
  url: string,
  handlers: ReconnectingSocketHandlers,
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
        /* already closing */
      }
      finalize(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(handlers.subscribe()));
      } catch {
        // The close handler that follows takes the reconnect path.
      }
      handlers.onOpen?.();
    };

    socket.onmessage = (msg) => {
      onProgress();
      let frame: unknown;
      try {
        frame = JSON.parse(typeof msg.data === "string" ? msg.data : "");
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      let outcome: "done" | void;
      try {
        outcome = handlers.onFrame(frame);
      } catch {
        // A frame the caller could not apply must not take the socket down.
        return;
      }
      if (outcome === "done") {
        finalize(() => {
          try {
            socket.close(1000, "Done");
          } catch {
            /* already closing */
          }
          resolve();
        });
      }
    };

    socket.onerror = () => {
      // The close handler runs right after and surfaces the rejection.
    };

    socket.onclose = (event) => {
      if (event.code === 4401) {
        finalize(() =>
          reject(new AuthExpiredSocketError(event.reason || "Authentication required")),
        );
        return;
      }
      if (event.code === 4403 || event.code === 4404) {
        finalize(() =>
          reject(
            new PermanentSocketError(
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

/**
 * Follow a bridge socket until a frame says it is done (`onFrame` returns
 * `"done"`), the caller aborts, or the socket is refused for good (4403/4404,
 * or a session that could not be refreshed). Everything else reconnects.
 */
export async function runReconnectingSocket(
  url: string,
  handlers: ReconnectingSocketHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let consecutiveFailures = 0;
  let authRefreshAttempted = false;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await runOneConnection(url, handlers, signal, () => {
        consecutiveFailures = 0;
      });
      return;
    } catch (err: unknown) {
      const error = err as {
        name?: string;
        authExpired?: boolean;
        permanent?: boolean;
        message?: string;
      };
      if (signal?.aborted || error?.name === "AbortError") {
        throw new DOMException("Aborted", "AbortError");
      }
      if (error?.authExpired) {
        // Same as a REST 401: refresh once and reconnect with the fresh cookie;
        // a refused refresh (or a second 4401) means the session is over.
        const outcome = authRefreshAttempted ? null : await ensureFreshSession({ force: true });
        if (outcome?.status === "refreshed" || outcome?.status === "already-fresh") {
          authRefreshAttempted = true;
          continue;
        }
        if (outcome?.status !== "unavailable") {
          emitUnauthorized();
          throw new PermanentSocketError(error.message || "Authentication required", 4401);
        }
      }
      if (error?.permanent) throw err;
      consecutiveFailures += 1;
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(consecutiveFailures - 1, RECONNECT_BACKOFF_MS.length - 1)];
      await sleepWithAbort(delay, signal);
      await waitUntilOnline(signal);
    }
  }
}
