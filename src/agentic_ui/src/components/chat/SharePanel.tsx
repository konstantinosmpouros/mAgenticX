import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Check, Copy, Link2, Loader2, X } from "lucide-react";
import type { MessageOut } from "@/lib/types";
import { MessageContent } from "./message_parts/MessageContent";

type ShareConversationDialogProps = {
  open: boolean;
  title?: string | null;
  message: MessageOut | null;
  creating?: boolean;
  linkCreated?: boolean;
  copied?: boolean;
  onClose: () => void;
  onCreateLink: () => void;
};

export default function ShareConversationDialog({
  open,
  title,
  message,
  creating = false,
  linkCreated = false,
  copied = false,
  onClose,
  onCreateLink,
}: ShareConversationDialogProps) {
  if (!open || !message) return null;

  const buttonText = creating
    ? "Creating..."
    : copied
      ? "Copied"
      : linkCreated
        ? "Copy link"
        : "Create link";

  return (
    <div className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 z-0 bg-black/75 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[44rem]">
        <Card className="relative overflow-hidden rounded-[1.75rem] border border-white/[0.12] bg-[#171717] text-white shadow-[0_24px_90px_rgba(0,0,0,0.6)] animate-scale-in">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close share dialog"
            onClick={onClose}
            className="absolute right-6 top-6 z-20 h-9 w-9 rounded-full text-white/75 shadow-sm transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0 focus-visible:outline-none"
          >
            <X size={20} />
          </Button>

          <div className="px-5 pt-6 md:px-7 md:pt-7">
            <div className="border-b border-white/10 pb-5 pr-14">
              <h3 className="line-clamp-2 text-2xl font-semibold leading-tight tracking-tight md:text-[2rem]">
                {title || "Shared conversation"}
              </h3>
            </div>
          </div>

          <div className="px-5 py-5 md:px-7">
            <div className="min-h-[15.5rem] rounded-[1.25rem] border border-white/[0.12] bg-[#353535] p-5 text-[1rem] leading-7 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] md:min-h-[17rem] md:p-6">
              <div className="max-h-[12.5rem] overflow-hidden text-white/95 [mask-image:linear-gradient(to_bottom,black_76%,transparent_100%)] md:max-h-[14rem]">
                <MessageContent message={message} isEditing={false} />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 px-5 pb-6 md:px-7 md:pb-7">
            <Button
              type="button"
              onClick={onCreateLink}
              disabled={creating}
              className={`h-11 min-w-[8.75rem] rounded-full px-5 text-sm font-semibold shadow-lg transition-all duration-300 active:scale-95 ${
                copied
                  ? "scale-[1.04] bg-emerald-500 text-white shadow-emerald-500/25 hover:bg-emerald-500"
                  : "bg-white text-black hover:scale-[1.03] hover:bg-white/90"
              }`}
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : copied ? (
                <Check className="h-4 w-4" />
              ) : linkCreated ? (
                <Copy className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {buttonText}
            </Button>

            <img
              src="/logo2_white_magentaX.png"
              alt="mAgenticX logo"
              className="h-9 w-9 object-contain opacity-95 md:h-10 md:w-10"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
