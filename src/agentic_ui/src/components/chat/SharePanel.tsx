import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CalendarDays, Check, Copy, Download, Link2, Loader2, LockKeyhole, X } from "lucide-react";
import type { ConversationShareMode, MessageOut } from "@/lib/types";
import { MessageContent } from "./message_parts/Content";

type ShareConversationDialogProps = {
  open: boolean;
  title?: string | null;
  message: MessageOut | null;
  creating?: boolean;
  exportingPdf?: boolean;
  linkCreated?: boolean;
  copied?: boolean;
  shareMode: ConversationShareMode;
  forceFullConversation?: boolean;
  expiresAt: Date | null;
  onShareModeChange: (mode: ConversationShareMode) => void;
  onExpiresAtChange: (value: Date | null) => void;
  onClose: () => void;
  onCreateLink: () => void;
  onDownloadPdf: () => void;
};

export default function ShareConversationDialog({
  open,
  title,
  message,
  creating = false,
  exportingPdf = false,
  linkCreated = false,
  copied = false,
  shareMode,
  forceFullConversation = false,
  expiresAt,
  onShareModeChange,
  onExpiresAtChange,
  onClose,
  onCreateLink,
  onDownloadPdf,
}: ShareConversationDialogProps) {
  if (!open || !message) return null;

  const buttonText = creating
    ? "Creating..."
    : copied
      ? "Copied"
      : linkCreated
      ? "Copy link"
      : "Create link";
  const modeOptions: Array<{ value: ConversationShareMode; label: string }> = [
    { value: "full", label: "Full conversation" },
    { value: "branch", label: "Up to response" },
    { value: "message", label: "This response only" },
  ];

  const toDateInputValue = (date: Date | null) => {
    if (!date || Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };
  const setExpiryInDays = (days: number) => {
    const next = new Date();
    next.setDate(next.getDate() + days);
    onExpiresAtChange(next);
  };

  return (
    <div className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 z-0 bg-black/80 backdrop-blur-md animate-in fade-in-0 duration-200"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[43rem] animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
        <Card className="relative overflow-hidden rounded-[1.6rem] border border-white/[0.14] bg-[#151515] text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/20" />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close share dialog"
            onClick={onClose}
            className="absolute right-5 top-5 z-20 h-9 w-9 rounded-full text-white/65 shadow-sm transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-0 focus-visible:outline-none"
          >
            <X size={18} />
          </Button>

          <div className="px-5 pt-6 md:px-7 md:pt-7">
            <div className="flex items-start gap-4 border-b border-white/10 pb-5 pr-12">
              <div className="mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.12] bg-white/[0.06] text-white/80 sm:flex">
                <Link2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45">
                  <LockKeyhole className="h-3.5 w-3.5" />
                  <span>Share link</span>
                </div>
                <h3 className="line-clamp-2 text-2xl font-semibold leading-tight tracking-tight md:text-[2rem]">
                {title || "Shared conversation"}
                </h3>
              </div>
            </div>
          </div>

          <div className="px-5 py-5 md:px-7">
            {!forceFullConversation && (
              <div className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/[0.12] bg-white/[0.045] p-1.5 text-xs font-semibold text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:text-sm">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={creating}
                    onClick={() => shareMode !== option.value && onShareModeChange(option.value)}
                    className={`h-10 rounded-xl px-2 transition disabled:pointer-events-none disabled:opacity-50 ${
                      shareMode === option.value
                        ? "bg-white text-black shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
                        : "hover:bg-white/[0.08] hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            <div className="mb-4 rounded-2xl border border-white/[0.12] bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/48">
                    <CalendarDays className="h-3.5 w-3.5" />
                    <span>Expiration</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/20 p-1 text-xs font-semibold text-white/62">
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => setExpiryInDays(30)}
                    className="h-9 rounded-lg px-3 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                  >
                    1 month
                  </button>
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => setExpiryInDays(7)}
                    className="h-9 rounded-lg px-3 transition hover:bg-white/[0.08] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                  >
                    7 days
                  </button>
                  </div>
                </div>
                <label className="block sm:w-[10rem]">
                  <span className="mb-2 block text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-white/40">
                    Date
                  </span>
                  <input
                    type="date"
                    value={toDateInputValue(expiresAt)}
                    min={toDateInputValue(new Date())}
                    disabled={creating}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (!value) return;
                      onExpiresAtChange(new Date(`${value}T23:59:59`));
                    }}
                    className="h-11 w-full rounded-xl border border-white/[0.13] bg-black/24 px-3 text-sm font-medium text-white outline-none transition [color-scheme:dark] hover:border-white/25 focus:border-white/40 disabled:opacity-50"
                    aria-label="Share expiration date"
                  />
                </label>
              </div>
            </div>

            <div className="relative min-h-[15.5rem] overflow-hidden rounded-2xl border border-white/[0.12] bg-[#252525] p-5 text-[1rem] leading-7 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] md:min-h-[17rem] md:p-6">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/15" />
              <div className="max-h-[12.5rem] overflow-hidden text-white/92 [mask-image:linear-gradient(to_bottom,black_78%,transparent_100%)] md:max-h-[14rem]">
                <MessageContent message={message} isEditing={false} />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 px-5 pb-6 md:px-7 md:pb-7">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={onCreateLink}
                disabled={creating || exportingPdf}
                className={`h-11 min-w-[8.75rem] rounded-full px-5 text-sm font-semibold shadow-lg transition-all duration-300 active:scale-95 ${
                  copied
                    ? "scale-[1.04] bg-emerald-500 text-white shadow-emerald-500/25 hover:bg-emerald-500"
                    : "bg-white text-black shadow-white/10 hover:scale-[1.03] hover:bg-white/90"
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
              <Button
                type="button"
                variant="outline"
                onClick={onDownloadPdf}
                disabled={creating || exportingPdf}
                className="h-11 rounded-full border-white/[0.14] bg-white/[0.06] px-5 text-sm font-semibold text-white shadow-lg transition hover:scale-[1.03] hover:bg-white/[0.1] hover:text-white active:scale-95"
              >
                {exportingPdf ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {exportingPdf ? "Exporting..." : "Download PDF"}
              </Button>
            </div>

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
