import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { beginReauthentication } from "@/shared/lib/api";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { useAccountDeletion } from "@/features/settings/hooks/useAccountDeletion";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { DangerButton, InfoCard, SoftPanel } from "./shared";

// Data controls → "Delete account" (plan 32): the danger zone row and its dialog.
//
// Coming back from "Sign in again" lands on the app root; the reauth-return
// hook reopens Settings here and leaves the outcome in the store, which this
// card turns back into an open dialog.

export function DeleteAccountCard({ userId }: { userId: string | null }) {
  const deletion = useAccountDeletion(userId);
  const reauthOutcome = useWorkspaceStore((s) => s.accountDeletionReauth);
  const setReauthOutcome = useWorkspaceStore((s) => s.setAccountDeletionReauth);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (reauthOutcome) setOpen(true);
  }, [reauthOutcome]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setReauthOutcome(null);
  };

  const enabled = deletion.status?.enabled ?? false;
  const graceDays = deletion.status?.graceDays ?? 14;

  return (
    <InfoCard
      eyebrow="Danger zone"
      title="Delete account"
      description="Permanently delete your account and everything in it."
    >
      <SoftPanel className="px-5 py-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground sm:max-w-[26rem]">
            {deletion.loading
              ? "Checking…"
              : enabled
                ? `You have ${graceDays} days to change your mind — just sign in to cancel.`
                : "Account deletion is turned off right now."}
          </p>
          <DangerButton onClick={() => handleOpenChange(true)} disabled={!enabled}>
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete account
          </DangerButton>
        </div>
      </SoftPanel>
      <DeleteAccountDialog
        open={open}
        onOpenChange={handleOpenChange}
        status={deletion.status}
        reauthFailed={reauthOutcome === "failed"}
        submitting={deletion.submitting}
        error={deletion.error}
        onReauthenticate={beginReauthentication}
        onConfirm={(typed) => void deletion.request(typed)}
      />
    </InfoCard>
  );
}
