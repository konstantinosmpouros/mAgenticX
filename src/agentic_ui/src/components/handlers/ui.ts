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
