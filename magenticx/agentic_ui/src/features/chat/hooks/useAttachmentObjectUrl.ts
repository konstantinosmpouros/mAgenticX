import { useEffect, useState } from "react";

/**
 * An object URL for a stored attachment's bytes, fetched once `load` and the
 * attachment are known, and revoked when they change or the component goes.
 * `null` while loading, when there is nothing to load, or when it failed (the
 * caller shows its fallback).
 */
export function useAttachmentObjectUrl(
  load: (() => Promise<Blob>) | null,
  key: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!load || !key) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    load()
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
    // `load` is a fresh closure on every render; the key names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
