import { useState } from "react";
import { LogOut, MonitorSmartphone, ShieldCheck } from "lucide-react";

import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { revokeAllSessions } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import { useToast } from "@/shared/hooks/use-toast";

import { DangerButton, InfoCard, SoftPanel } from "./shared";

/**
 * SecurityTab — "Security and login": per-device sign-out, revoke-everywhere,
 * and the session-lifetime facts of the stateless-JWT auth (silent refresh keeps
 * a session alive up to 20 days, 12 idle days sign you out), with the
 * not-yet-built controls mirrored as stubs.
 */
type SecurityTabProps = {
  onLogout: () => void;
};

export default function SecurityTab({ onLogout }: SecurityTabProps) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Revoking ends THIS session too, so there is no success state to render —
  // the only correct next screen is the login page. Rethrowing on failure keeps
  // `ConfirmDialog` open so the user can retry instead of losing the dialog and
  // being left unsure whether anything happened.
  const handleRevokeAll = async () => {
    try {
      await revokeAllSessions();
    } catch (error) {
      toastError(toast, "Could not sign out everywhere", error, {
        description: "Your sessions were not changed. Please try again.",
      });
      throw error;
    }
    onLogout();
  };

  return (
    <div className="space-y-8">
      <InfoCard
        eyebrow="Session"
        title="Signed-in session"
        description="How long this session stays valid and how to end it now."
      >
        <SoftPanel className="divide-y divide-border/40 overflow-hidden">
          <div className="px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck size={16} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Session lifetime</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Sessions refresh silently in the background and stay signed in for up to 20 days.
                  After 12 days without any activity you are signed out automatically.
                </p>
              </div>
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Log out of this device</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ends the current session immediately and returns you to the login screen.
                </p>
              </div>
              <DangerButton onClick={onLogout}>
                <LogOut size={15} aria-hidden />
                Log out
              </DangerButton>
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Log out of all devices</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ends every session for this account, on every browser and device — including this
                  one. Use this if you think someone else has access.
                </p>
              </div>
              <DangerButton onClick={() => setConfirmOpen(true)}>
                <MonitorSmartphone size={15} aria-hidden />
                Log out everywhere
              </DangerButton>
            </div>
          </div>
        </SoftPanel>
      </InfoCard>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Log out of all devices?"
        description="Every browser and device signed in to this account will be signed out, including this one. You will need to sign in again."
        confirmLabel="Log out everywhere"
        onConfirm={handleRevokeAll}
      />
    </div>
  );
}
