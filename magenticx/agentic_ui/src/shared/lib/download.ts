/**
 * Browser-download helpers.
 *
 * Saving a Blob to disk has no direct browser API — it requires building a
 * temporary object URL, synthesising an anchor, clicking it, and cleaning both
 * up. That dance was written out three times (PDF export, attachment download,
 * shared-conversation attachment download) and the copies had already started
 * to differ in incidental ways, which is exactly how one of them ends up
 * leaking an object URL. One implementation, used everywhere.
 */

/**
 * Resolve the download filename from a Content-Disposition header, preferring
 * the RFC 5987 `filename*` (UTF-8, percent-encoded) form over the ASCII
 * `filename`, and falling back to a caller-supplied default.
 */
export const getFilenameFromDisposition = (
  disposition: string | null,
  fallback: string,
): string => {
  if (!disposition) return fallback;
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].replace(/"/g, ""));
    } catch {
      return utfMatch[1].replace(/"/g, "");
    }
  }
  const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
  return asciiMatch?.[1] || fallback;
};

/**
 * Save a Blob to the user's disk.
 *
 * The object URL is revoked immediately after the synchronous `click()`: the
 * browser has already taken its own reference to the resource by then, so the
 * download completes while the URL itself is released rather than being held
 * for the lifetime of the document.
 *
 * Omit `filename` to let the server's Content-Disposition name the file.
 */
export const triggerBrowserDownload = (blob: Blob, filename?: string): void => {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  if (filename) {
    anchor.download = filename;
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
};
