import { Download, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The full-bleed image viewer, shared by every surface that expands an image:
 * message attachments, the shared-conversation page, and tool results.
 *
 * It exists as one component because the three used to be separate copies of
 * the same markup, and a fix to one (the download button, Escape handling)
 * silently missed the others.
 *
 * Escape is handled here rather than left to the workspace's dismissal cascade,
 * because a lightbox opened from a tool result is not part of that cascade —
 * without this, Escape would close some unrelated surface instead.
 */
export type ImageLightboxProps = {
  src: string;
  /** Suggested download name. Extension is derived from the data when absent. */
  filename?: string;
  alt?: string;
  onClose: () => void;
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Best-effort filename. A caller-supplied name is kept but still gets an
 * extension appended when it lacks one, or the browser saves an extensionless
 * file the OS cannot open.
 */
function deriveFilename(src: string, given?: string): string {
  const mime = src.startsWith("data:") ? src.slice(5, src.indexOf(";")) : "";
  const extension = EXTENSION_BY_MIME[mime] ?? "png";
  if (!given) return `image.${extension}`;
  return /\.[a-z0-9]{2,4}$/i.test(given) ? given : `${given}.${extension}`;
}

export function ImageLightbox({ src, filename, alt = "Full preview", onClose }: ImageLightboxProps) {
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Capture phase + stopPropagation so the global dismissal cascade does
      // not also fire and close a second surface behind this one.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleDownload = useCallback(async () => {
    setIsSaving(true);
    // Route every src kind (data:, blob:, same-origin API URL) through a blob
    // so the filename is honoured — a bare `download` attribute is ignored on
    // a cross-origin href and would open the image instead of saving it.
    let objectUrl: string | null = null;
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`status ${response.status}`);
      objectUrl = URL.createObjectURL(await response.blob());
    } catch {
      objectUrl = null;
    }

    const anchor = document.createElement("a");
    anchor.href = objectUrl ?? src;
    anchor.download = deriveFilename(src, filename);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setIsSaving(false);
  }, [src, filename]);

  // Rendered into document.body rather than in place. `position: fixed` is
  // resolved against the nearest ancestor that establishes a containing block
  // (any transform, filter, backdrop-filter or contain in the message tree),
  // which scoped the overlay to the chat column instead of the viewport when a
  // tool result opened it. A portal has no ancestors to be trapped by.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="absolute right-4 top-4 z-10 flex items-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          onClick={handleDownload}
          disabled={isSaving}
          className="rounded-full bg-black/50 p-2 text-white transition-colors hover:text-gray-300 disabled:opacity-50"
          aria-label="Download image"
        >
          <Download size={24} />
        </button>
        <button
          onClick={onClose}
          className="rounded-full bg-black/50 p-2 text-white transition-colors hover:text-gray-300"
          aria-label="Close image preview"
        >
          <X size={24} />
        </button>
      </div>
      {/*
        Sized to the viewport rather than `w-auto`, so a small source (a tool
        result carries a 512px thumbnail, not the original) scales up to fill
        the screen the way a full-size attachment does. `object-contain` keeps
        the aspect ratio and letterboxes the remainder.
      */}
      <img
        src={src}
        alt={alt}
        className="h-[95vh] w-[95vw] rounded-lg object-contain shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
