import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flag, X } from "lucide-react";

export const REPORT_REASONS = [
  "Harmful / unsafe response",
  "Incorrect / misleading",
  "Policy violation",
  "Bug / broken behavior",
  "Spam / irrelevant",
  "Other",
] as const;

type ReportConversationDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { reason: string; details?: string; messageId?: string | null }) => Promise<void> | void;
  submitting?: boolean;
  messageId?: string | null;
  conversationTitle?: string | null;
};

export default function ReportConversationDialog({
  open,
  onClose,
  onSubmit,
  submitting = false,
  messageId = null,
  conversationTitle = null,
}: ReportConversationDialogProps) {
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");

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

  return (
    <div className="fixed inset-0 z-[60] flex min-h-[100dvh] items-center justify-center px-4 py-8">
      <div
        className="absolute inset-0 z-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={submitting ? undefined : onClose}
      />
      <div className="relative z-10 w-full max-w-lg">
        <Card className="relative overflow-hidden rounded-[20px] border border-border/60 bg-card text-foreground shadow-2xl animate-scale-in">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close report dialog"
            onClick={onClose}
            disabled={submitting}
            className="absolute right-4 top-4 z-20 h-9 w-9 rounded-full text-muted-foreground shadow-sm transition hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-0 focus-visible:outline-none"
          >
            <X size={18} />
          </Button>

          <div className="space-y-6 p-6">
            <div className="space-y-2 border-b border-border/60 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-primary/10 text-primary">
                  <Flag size={18} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                    Report
                  </p>
                  <h3 className="text-lg font-semibold">Report conversation</h3>
                </div>
              </div>
              <p className="text-[0.78rem] text-muted-foreground">
                {messageId
                  ? "This report will be linked to a specific assistant message."
                  : "This report will be linked to the conversation as a whole."}
              </p>
              {conversationTitle ? (
                <p className="text-[0.72rem] font-medium text-foreground/80">
                  Conversation: {conversationTitle}
                </p>
              ) : null}
            </div>

            <div className="space-y-5">
              <div className="space-y-2">
                <label className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Reason
                </label>
                <Select value={reason} onValueChange={setReason} disabled={submitting}>
                  <SelectTrigger className="h-11 rounded-xl border-border/60 bg-background/70">
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent className="z-[70] rounded-xl border border-border/60 bg-background text-foreground shadow-lg">
                    {REPORT_REASONS.map((option) => (
                      <SelectItem key={option} value={option} className="text-sm">
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Details
                </label>
                <Textarea
                  value={details}
                  onChange={(event) => setDetails(event.target.value)}
                  placeholder="Optional notes to help explain the issue."
                  disabled={submitting}
                  className="min-h-[8rem] rounded-xl border-border/60 bg-background/70"
                  maxLength={2000}
                />
                <p className="text-right text-[0.68rem] text-muted-foreground">
                  {details.length}/2000
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border/60 pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={submitting}
                className="rounded-xl"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!reason || submitting}
                className="rounded-xl"
              >
                {submitting ? "Submitting..." : "Submit report"}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
