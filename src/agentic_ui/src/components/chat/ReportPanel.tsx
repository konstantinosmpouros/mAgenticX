import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Flag, Loader2, MessageSquareQuote, ShieldCheck, X } from "lucide-react";

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
  onSubmit: (payload: { reason: string; details?: string; messageId?: string | null }) => Promise<void> | void;
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

  return (
    <div className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-6">
      <div
        className="absolute inset-0 z-0 bg-black/65 backdrop-blur-sm transition-opacity"
        onClick={submitting ? undefined : onClose}
      />
      <div className="relative z-10 w-full max-w-xl">
        <Card className="relative overflow-hidden rounded-lg border border-border/70 bg-card text-foreground shadow-[0_24px_80px_rgba(0,0,0,0.35)] animate-scale-in">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close report dialog"
            onClick={onClose}
            disabled={submitting}
            className="absolute right-4 top-4 z-20 h-9 w-9 rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-0 focus-visible:outline-none"
          >
            <X size={18} />
          </Button>

          <div className="border-b border-border/70 bg-gradient-to-br from-muted/55 via-card to-primary/10 px-5 pb-5 pt-6 md:px-6">
            <div className="pr-12">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary shadow-[inset_0_1px_0_hsl(var(--background)/0.35)]">
                  <Flag size={20} />
                </div>
                <div className="min-w-0">
                  <div className="mb-1 inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/65 px-2 py-1 text-[0.7rem] font-medium text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                    <span>{contextLabel}</span>
                  </div>
                  <h3 className="text-xl font-semibold tracking-tight">{dialogTitle}</h3>
                </div>
              </div>

              <p className="text-[0.78rem] text-muted-foreground">
                {isMessageReport
                  ? "This report will be attached to the selected assistant response."
                  : "This report will be attached to the conversation as a whole."}
              </p>
              {conversationTitle ? (
                <div className="mt-3 rounded-lg border border-border/70 bg-background/55 px-3 py-2 text-sm">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Conversation
                  </p>
                  <p className="mt-1 truncate font-medium text-foreground/90">{conversationTitle}</p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-5 p-5 md:p-6">
            {previewText ? (
              <div className="rounded-lg border border-border/70 bg-muted/35 p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <MessageSquareQuote className="h-4 w-4" />
                  <span>Selected response</span>
                </div>
                <p className="line-clamp-4 text-sm leading-6 text-foreground/85">
                  {previewText}
                </p>
              </div>
            ) : null}

            <div className="grid gap-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Reason
                  </label>
                  {!reason ? (
                    <span className="inline-flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Required
                    </span>
                  ) : null}
                </div>
                <Select value={reason} onValueChange={setReason} disabled={submitting}>
                  <SelectTrigger className="h-11 rounded-lg border-border/70 bg-background/80 shadow-sm transition-colors hover:bg-background focus:ring-1 focus:ring-primary/35">
                    <SelectValue placeholder="Choose a reason" />
                  </SelectTrigger>
                  <SelectContent className="z-[70] rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-lg">
                    {REPORT_REASONS.map((option) => (
                      <SelectItem key={option} value={option} className="text-sm">
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Details
                </label>
                <Textarea
                  value={details}
                  onChange={(event) => setDetails(event.target.value)}
                  placeholder="Add any context that would help us review this faster."
                  disabled={submitting}
                  className="min-h-[8.5rem] resize-none rounded-lg border-border/70 bg-background/80 leading-6 shadow-sm transition-colors placeholder:text-muted-foreground/70 hover:bg-background focus-visible:ring-1 focus-visible:ring-primary/35"
                  maxLength={2000}
                />
                <p className="text-right text-[0.68rem] tabular-nums text-muted-foreground">
                  {details.length}/2000
                </p>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-muted-foreground">
                Reports are reviewed with conversation context.
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={submitting}
                  className="h-10 rounded-md px-4 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!reason || submitting}
                  className="h-10 rounded-md px-4 font-semibold shadow-[0_8px_24px_hsl(var(--primary)/0.18)]"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Flag className="h-4 w-4" />
                  )}
                  {submitting ? "Submitting..." : "Submit report"}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
