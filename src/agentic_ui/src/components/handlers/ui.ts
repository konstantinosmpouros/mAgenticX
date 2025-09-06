import { useEffect, useRef } from 'react';

type UIHandlersCtx = {
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  setCopiedId: (id: string | null) => void;
};

export function createUIHandlers(ctx: UIHandlersCtx) {
  const { toast, setCopiedId } = ctx;

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  return { handleCopy };
}

// Sticky user action bar that stays visible for a short period
export function createStickyUserBarHandlers(ctx: { setStickyUserBarId: (id: string | null) => void }) {
  const { setStickyUserBarId } = ctx;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const flashUserActionBar = (id: string, ms = 3000) => {
    setStickyUserBarId(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStickyUserBarId(null), ms);
  };

  return { flashUserActionBar };
}
