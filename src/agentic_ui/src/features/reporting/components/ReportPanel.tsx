import { useEffect, useState } from "react";
import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import {
  AlertTriangle,
  Check,
  Flag,
  Loader2,
  MessageSquareQuote,
  ShieldCheck,
  X,
} from "lucide-react";

export const REPORT_REASONS = [
  "Unsafe",
  "Wrong",
  "Policy",
  "Bug",
  "Spam",
  "Abuse",
  "Privacy",
  "Other",
] as const;

type ReportConversationDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    reason: string;
    details?: string;
    messageId?: string | null;
  }) => Promise<void> | void;
  submitting?: boolean;
  messageId?: string | null;
  messagePreview?: string | null;
  conversationTitle?: string | null;
};

export default function ReportConversationDialog({
  open,
  onClose,
  onSubmit,
  submitting = false,
  messageId = null,
  messagePreview = null,
  conversationTitle = null,
}: ReportConversationDialogProps) {
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");
  const isMessageReport = Boolean(messageId);

  useEffect(() => {
    if (!open) {
      setReason("");
      setDetails("");
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!reason || submitting) return;
    await onSubmit({
      reason,
      details: details.trim() || undefined,
      messageId: messageId ?? null,
    });
  };

  const dialogTitle = isMessageReport ? "Report response" : "Report conversation";
  const contextLabel = isMessageReport ? "Assistant response" : "Full conversation";
  const previewText = messagePreview?.trim();

  // The panel is capped to the viewport and only its *body* scrolls, so on a short
  // screen the title and the Submit button stay put instead of the whole dialog
  // running off the bottom. Nothing here changes how it looks when it already fits:
  // the cap is a max-height, and the body only becomes scrollable once it must.
  return (
    <div className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 z-0 bg-black/80 backdrop-blur-md animate-in fade-in-0 duration-200"
        onClick={submitting ? undefined : onClose}
      />
      <div className="relative z-10 flex max-h-[calc(100dvh-3rem)] w-full max-w-[40rem] animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
        <Card className="relative flex min-h-0 w-full flex-col overflow-hidden rounded-[1.6rem] border border-white/[0.14] bg-[#151515] text-white shadow-[0_28px_100px_rgba(0,0,0,0.72)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/20" />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close report dialog"
            onClick={onClose}
            disabled={submitting}
            className="absolute right-5 top-5 z-20 h-9 w-9 rounded-full text-white/65 shadow-sm transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:ring-offset-0 focus-visible:outline-none"
          >
            <X size={18} />
          </Button>

          <div className="shrink-0 px-5 pt-6 md:px-7 md:pt-7">
            <div className="flex items-start gap-4 border-b border-white/10 pb-5 pr-12">
              <div className="mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.12] bg-white/[0.06] text-white/80 sm:flex">
                <Flag className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/90" />
                  <span>{contextLabel}</span>
                </div>
                <h3 className="text-2xl font-semibold leading-tight tracking-tight md:text-[2rem]">
                  {dialogTitle}
                </h3>
                <p className="mt-2 text-sm leading-6 text-white/55">
                  {isMessageReport
                    ? "This report will be attached to the selected assistant response."
                    : "This report will be attached to the conversation as a whole."}
                </p>
              </div>
            </div>
          </div>

          {/* The only scroll area — `min-h-0` so it can shrink inside the flex
              column instead of forcing the card past its max-height. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-7">
            {conversationTitle ? (
              <div className="mb-4 rounded-2xl border border-white/[0.12] bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div className="mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45">
                  Conversation
                </div>
                <p className="truncate font-medium text-white/90">{conversationTitle}</p>
              </div>
            ) : null}

            {previewText ? (
              <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/[0.12] bg-[#252525] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/15" />
                <div className="mb-2 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/48">
                  <MessageSquareQuote className="h-3.5 w-3.5" />
                  <span>Selected response</span>
                </div>
                <p className="line-clamp-4 text-sm leading-6 text-white/85">{previewText}</p>
              </div>
            ) : null}

            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/45">
                Reason
              </span>
              {!reason ? (
                <span className="inline-flex items-center gap-1.5 text-[0.72rem] text-white/45">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Required
                </span>
              ) : null}
            </div>
            <div
              role="radiogroup"
              aria-label="Report reason"
              className="mb-4 grid grid-cols-2 gap-1 rounded-2xl border border-white/[0.12] bg-white/[0.045] p-1.5 text-xs font-semibold text-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:grid-cols-4"
            >
              {REPORT_REASONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={reason === option}
                  disabled={submitting}
                  onClick={() => setReason(option)}
                  className={`h-10 rounded-xl px-2 transition disabled:pointer-events-none disabled:opacity-50 ${
                    reason === option
                      ? "bg-white text-black shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
                      : "hover:bg-white/[0.08] hover:text-white"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="rounded-2xl border border-white/[0.12] bg-white/[0.045] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <label
                htmlFor="report-details"
                className="mb-2 block text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-white/48"
              >
                Details
              </label>
              <Textarea
                id="report-details"
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="Add any context that would help us review this faster."
                disabled={submitting}
                maxLength={2000}
                className="min-h-[8.5rem] resize-none rounded-xl border-white/[0.13] bg-black/24 leading-6 text-white shadow-none transition placeholder:text-white/40 hover:border-white/25 focus-visible:border-white/40 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:ring-offset-0 disabled:opacity-50"
              />
              <p className="mt-2 text-right text-[0.68rem] tabular-nums text-white/40">
                {details.length}/2000
              </p>
            </div>
          </div>

          <div className="relative shrink-0 flex items-center justify-between gap-4 px-5 pb-6 md:px-7 md:pb-7">
            {/* Softens the hard line where the scrolling body is clipped by the
                footer: a short scrim just above it, fading the card colour up into
                transparency so the last line of content dissolves instead of being
                cut. `bottom-full` puts it outside the footer box, over the body. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-full h-6 bg-gradient-to-t from-[#151515] to-transparent"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!reason || submitting}
                className="h-11 min-w-[8.75rem] rounded-full bg-white px-5 text-sm font-semibold text-black shadow-lg shadow-white/10 transition-all duration-300 hover:scale-[1.03] hover:bg-white/90 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : reason ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Flag className="h-4 w-4" />
                )}
                {submitting ? "Submitting..." : "Submit report"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
                className="h-11 rounded-full border-white/[0.14] bg-white/[0.06] px-5 text-sm font-semibold text-white shadow-lg transition hover:scale-[1.03] hover:bg-white/[0.1] hover:text-white active:scale-95"
              >
                Cancel
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
