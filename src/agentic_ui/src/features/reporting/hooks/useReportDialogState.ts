import { useState } from "react";

/**
 * State for the report-conversation dialog.
 *
 * State-only, for the same reason as the share dialog: `createReportHandlers`
 * needs the conversation lists and the user id to actually file a report, so the
 * behaviour stays there and this hook just holds what the dialog renders from.
 *
 * The target is carried as three separate fields rather than one object because
 * a report can be raised against a whole conversation (from the sidebar or the
 * header) or against a single AI message — the message fields are simply null in
 * the first case.
 */
export function useReportDialogState() {
  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
  const [reportTargetConversationId, setReportTargetConversationId] = useState<string | null>(null);
  const [reportTargetMessageId, setReportTargetMessageId] = useState<string | null>(null);
  const [reportTargetMessagePreview, setReportTargetMessagePreview] = useState<string | null>(null);
  const [reportConversationTitle, setReportConversationTitle] = useState<string | null>(null);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);

  return {
    isReportDialogOpen,
    setIsReportDialogOpen,
    reportTargetConversationId,
    setReportTargetConversationId,
    reportTargetMessageId,
    setReportTargetMessageId,
    reportTargetMessagePreview,
    setReportTargetMessagePreview,
    reportConversationTitle,
    setReportConversationTitle,
    isSubmittingReport,
    setIsSubmittingReport,
  };
}
