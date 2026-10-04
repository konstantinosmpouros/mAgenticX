/**
 * Export my data (plan 27): status, a one-time download token, and the URL the
 * browser downloads from.
 *
 * The archive itself is never fetched through JavaScript — that would hold the
 * whole zip in browser memory. The browser is pointed at the download URL and
 * saves the stream straight to disk; the token (minted by a CSRF-protected
 * POST) is what stops another site from starting an export on your cookies.
 */
import type { ExportStatus, ExportToken } from "../types";
import { requestJson } from "../http";
import { ExportStatusSchema, ExportTokenSchema } from "../schemas";
import { EXPORT_BASE_PATH } from "./paths";

// Whether exports are on, and when this user may start the next one.
export async function getExportStatus(userId: string): Promise<ExportStatus> {
  return requestJson(`${EXPORT_BASE_PATH}/${encodeURIComponent(userId)}/status`, {
    schema: ExportStatusSchema,
    fallbackMessage: "Could not load export status",
  });
}

// Mint a one-time token for the download. 503 while exports are off; 429
// during the cooldown.
export async function requestExportToken(
  userId: string,
  includeAttachments: boolean,
): Promise<ExportToken> {
  return requestJson(`${EXPORT_BASE_PATH}/${encodeURIComponent(userId)}/token`, {
    method: "POST",
    csrf: true,
    body: { includeAttachments },
    schema: ExportTokenSchema,
    errorMessages: {
      429: "You exported your data recently. Please try again later.",
      503: "Data export is turned off right now.",
    },
    fallbackMessage: "Could not prepare the export",
  });
}

// The URL the browser downloads the archive from.
export function exportDownloadUrl(userId: string, token: string): string {
  return `${EXPORT_BASE_PATH}/${encodeURIComponent(userId)}/download?token=${encodeURIComponent(token)}`;
}
