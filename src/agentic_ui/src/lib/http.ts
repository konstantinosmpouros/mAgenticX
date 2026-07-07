/**
 * Typed HTTP transport for the backend API.
 *
 * Every endpoint in `api.ts` shares the same envelope: attach credentials + a
 * CSRF token + a correlation id (`withSessionRequest`), fire the request, and on
 * a non-2xx response emit the global unauthorized event on 401, pull `detail`
 * out of the JSON error body, and throw an `Error` carrying the status. That
 * envelope used to be copy-pasted ~30 times, each copy a chance to forget the
 * 401 handling or mis-word a message. This module is that envelope, written once.
 *
 * On the success path, `requestJson` validates the body against a Zod schema
 * (see `schemas.ts`) — the network is the one boundary we do not control, so it
 * is the one boundary worth validating. Validation is strict in development
 * (a contract mismatch throws with the Zod issue list, so drift is caught the
 * moment it appears) and fail-open in production (a mismatch returns the raw body
 * rather than crashing the UI over an over-strict schema). Schemas default every
 * field, so in practice only a catastrophic shape error — an array where an
 * object was expected — ever fails the parse.
 *
 * This module is a transport primitive, not an endpoint layer: `api.ts` remains
 * the single place that declares the actual API calls (per the frontend house
 * rules); it just builds on `requestJson`/`requestVoid`/`requestBlob` instead of
 * hand-rolling `fetch`.
 */
import { z, type ZodTypeAny } from "zod";

import { emitUnauthorized } from "./consts";
import { withSessionRequest } from "./utils";


/**
 * Error thrown for any non-2xx response (except statuses the caller explicitly
 * ignores). `status` mirrors the HTTP status; `detail` is the backend's
 * `detail` field when present; `retryAfterSeconds` is parsed from the
 * `Retry-After` header when the caller asked for it (rate-limited login).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    init: { status: number; detail?: string; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = init.status;
    this.detail = init.detail;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}


export type ApiRequestOptions = {
  method?: string;
  /**
   * Request payload. A plain object/array is JSON-serialized (and a JSON
   * `Content-Type` set); a `FormData`/`Blob`/`string` is sent verbatim.
   */
  body?: unknown;
  /** Attach the double-submit CSRF token (required for state-mutating calls). */
  csrf?: boolean;
  /** `Accept` header. Pass `null` to omit it entirely (blob/preview endpoints). */
  accept?: string | null;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Emit the global `mx:unauthorized` event on a 401. Defaults to `true`. */
  emitOn401?: boolean;
  /** Parse the `Retry-After` header into `ApiError.retryAfterSeconds`. */
  captureRetryAfter?: boolean;
  /** Non-2xx statuses to treat as success (e.g. logout tolerates 401). */
  ignoreStatuses?: number[];
  /** Message when the body carries no `detail`. */
  fallbackMessage?: string;
  /** Per-status override messages (e.g. a friendly 413 payload-too-large note). */
  errorMessages?: Partial<Record<number, string>>;
  signal?: AbortSignal;
};


// Build the RequestInit from the options: serialize JSON bodies, set Accept
// unless suppressed, and let FormData set its own multipart boundary.
function buildInit(opts: ApiRequestOptions): RequestInit {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.accept !== null) {
    headers["Accept"] = opts.accept ?? "application/json";
  }

  let body = opts.body as BodyInit | undefined;
  const isFormData = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && opts.body instanceof Blob;
  if (opts.body != null && !isFormData && !isBlob && typeof opts.body === "object") {
    body = JSON.stringify(opts.body);
    if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  }

  return {
    method: opts.method ?? "GET",
    ...(body != null ? { body } : {}),
    headers,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}


// Pull the backend `detail` string out of a JSON error body, tolerating
// non-JSON payloads (nginx HTML, empty bodies) by returning undefined.
async function extractDetail(res: Response): Promise<string | undefined> {
  try {
    const data = await res.json();
    if (data && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string") {
      return (data as { detail: string }).detail;
    }
  } catch {
    // Non-JSON or empty error body — no detail to surface.
  }
  return undefined;
}


/**
 * Core request: returns the `Response` on success, throws `ApiError` otherwise.
 * Blob/streaming callers use this directly so they can read headers + body.
 */
export async function requestRaw(path: string, opts: ApiRequestOptions = {}): Promise<Response> {
  const res = await fetch(path, withSessionRequest(buildInit(opts), { csrf: opts.csrf }));

  if (res.ok || opts.ignoreStatuses?.includes(res.status)) {
    return res;
  }

  if (res.status === 401 && opts.emitOn401 !== false) {
    emitUnauthorized();
  }

  const detail = await extractDetail(res);

  let retryAfterSeconds: number | undefined;
  if (opts.captureRetryAfter) {
    const header = res.headers.get("Retry-After");
    const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
    if (Number.isFinite(parsed)) retryAfterSeconds = parsed;
  }

  const message =
    opts.errorMessages?.[res.status] ?? detail ?? opts.fallbackMessage ?? `Request failed: ${res.status}`;

  throw new ApiError(message, { status: res.status, detail, retryAfterSeconds });
}


/**
 * Request a JSON response. With a `schema`, the body is validated and the
 * validated (and, for transforming schemas, normalized) value is returned; the
 * return type is inferred from the schema. Without a `schema`, the parsed body
 * is returned as `unknown` for the caller to map.
 */
export function requestJson<S extends ZodTypeAny>(
  path: string,
  opts: ApiRequestOptions & { schema: S },
): Promise<z.output<S>>;
export function requestJson(
  path: string,
  opts?: ApiRequestOptions & { schema?: undefined },
): Promise<unknown>;
export async function requestJson(
  path: string,
  opts: ApiRequestOptions & { schema?: ZodTypeAny } = {},
): Promise<unknown> {
  const res = await requestRaw(path, opts);
  const data = await res.json();

  const schema = opts.schema;
  if (!schema) return data;

  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;

  if (import.meta.env.DEV) {
    // Loud in development/CI: a contract mismatch is a bug to fix now, not later.
    // eslint-disable-next-line no-console
    console.error(`[api] response validation failed: ${opts.method ?? "GET"} ${path}`, parsed.error.issues);
    throw parsed.error;
  }
  // Production: fail open. An over-strict schema must never crash the UI; return
  // the raw body and let the (already-defensive) consumers cope.
  return data;
}


/** Request an endpoint that returns no body (204) or whose body is ignored. */
export async function requestVoid(path: string, opts: ApiRequestOptions = {}): Promise<void> {
  await requestRaw(path, opts);
}


/** Request a binary response (audio, PDF, attachment blobs). */
export async function requestBlob(path: string, opts: ApiRequestOptions = {}): Promise<Blob> {
  const res = await requestRaw(path, opts);
  return res.blob();
}
