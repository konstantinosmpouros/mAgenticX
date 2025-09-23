import type { FC } from "react";
import type { ThinkingState } from "@/lib/types";

type UIHandlersCtx = {
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
  setCopiedId: (id: string | null) => void;
  setSelectedImage?: (value: string | null) => void;
};

export function createUIHandlers(ctx: UIHandlersCtx) {
  const { toast, setCopiedId, setSelectedImage } = ctx;

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const handleImageClick = (imageUrl: string) => {
    setSelectedImage?.(imageUrl);
  };

  const handleCloseImagePreview = () => {
    setSelectedImage?.(null);
  };

  return { handleCopy, handleImageClick, handleCloseImagePreview };
}

type AiTransitionHandlersCtx = {
  showAiTransition: boolean;
  thinkingState: ThinkingState | null;
};

export function createAiTransitionHandlers(ctx: AiTransitionHandlersCtx) {
  const { showAiTransition, thinkingState } = ctx;

  const AiTransitionIndicator: FC = () => {
    if (!showAiTransition || thinkingState?.isActive) return null;

    return (
      <div className="flex justify-start pl-2">
        <div className="size-3 rounded-full bg-white/90 shadow-sm transform-gpu motion-safe:animate-pulse-scale" />
      </div>
    );
  };

  return { AiTransitionIndicator };
}
