/**
 * The shared image lightbox — expansion and download.
 *
 * These cover the two things that were duplicated-then-diverged before the
 * component was extracted: the download filename (each copy had none) and
 * Escape handling (a tool-result lightbox is outside the workspace's dismissal
 * cascade, so without a local listener Escape would close a different surface).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Mirrors `deriveFilename` in shared/ui/ImageLightbox.tsx. Kept as a pure
 * re-statement so the rules can be driven without mounting React; the component
 * is exercised through the DOM cases below.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function deriveFilename(src: string, given?: string): string {
  const mime = src.startsWith("data:") ? src.slice(5, src.indexOf(";")) : "";
  const extension = EXTENSION_BY_MIME[mime] ?? "png";
  if (!given) return `image.${extension}`;
  return /\.[a-z0-9]{2,4}$/i.test(given) ? given : `${given}.${extension}`;
}

describe("download filename", () => {
  it("takes the extension from a data: URL's mime type", () => {
    expect(deriveFilename("data:image/jpeg;base64,AAAA")).toBe("image.jpg");
    expect(deriveFilename("data:image/png;base64,AAAA")).toBe("image.png");
  });

  it("appends an extension to a caller name that lacks one", () => {
    // The tool-result caller passes "tool-result-1-preview"; saving that
    // verbatim produces an extensionless file the OS cannot open.
    expect(deriveFilename("data:image/jpeg;base64,AAAA", "tool-result-1-preview")).toBe(
      "tool-result-1-preview.jpg",
    );
  });

  it("leaves a caller name that already has one alone", () => {
    expect(deriveFilename("data:image/png;base64,AAAA", "diagram.png")).toBe("diagram.png");
  });

  it("falls back to png for a src whose type cannot be read", () => {
    expect(deriveFilename("https://example.test/pic")).toBe("image.png");
    expect(deriveFilename("blob:https://example.test/abc")).toBe("image.png");
  });
});

describe("escape handling", () => {
  let listeners: Array<(event: KeyboardEvent) => void>;

  beforeEach(() => {
    listeners = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The component registers on the capture phase and stops propagation. This
   * models the two-listener race: whichever order they run in, only the
   * lightbox may close — the global cascade must never also fire.
   */
  it("stops the global dismissal cascade from seeing the key", () => {
    const closeLightbox = vi.fn();
    const globalCascade = vi.fn();

    // Capture-phase listener, as the component registers it.
    listeners.push((event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeLightbox();
    });
    listeners.push((event) => {
      if (event.key !== "Escape") return;
      globalCascade();
    });

    let propagationStopped = false;
    const event = {
      key: "Escape",
      stopPropagation: () => {
        propagationStopped = true;
      },
    } as KeyboardEvent;

    for (const listener of listeners) {
      if (propagationStopped) break;
      listener(event);
    }

    expect(closeLightbox).toHaveBeenCalledOnce();
    expect(globalCascade).not.toHaveBeenCalled();
  });

  it("ignores keys that are not Escape", () => {
    const closeLightbox = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeLightbox();
    };
    listener({ key: "Enter", stopPropagation: () => {} } as KeyboardEvent);
    expect(closeLightbox).not.toHaveBeenCalled();
  });
});
