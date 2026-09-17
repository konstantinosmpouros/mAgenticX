import { LogOut, ShieldCheck } from "lucide-react";

import { InfoCard, SoftPanel } from "./shared";
import { ComingSoonRow } from "./ComingSoon";

/**
 * SecurityTab — "Security and login": the real per-device sign-out plus the
 * session-lifetime facts of the stateless-JWT auth (silent refresh keeps a
 * session alive up to 20 days, 12 idle days sign you out), with the
 * not-yet-built controls mirrored as stubs.
 */
type SecurityTabProps = {
  onLogout: () => void;
};

export default function SecurityTab({ onLogout }: SecurityTabProps) {
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
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-4 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
              >
                <LogOut size={15} aria-hidden />
                Log out
              </button>
            </div>
          </div>
        </SoftPanel>
      </InfoCard>

      <InfoCard
        eyebrow="Planned"
        title="More security controls"
        description="Mirrored from the target settings layout — these land here once implemented."
      >
        <SoftPanel className="divide-y divide-border/40 overflow-hidden">
          <ComingSoonRow
            title="Multi-factor authentication"
            description="Require a second factor when signing in with username and password."
          />
          <ComingSoonRow
            title="Log out of all devices"
            description="Revoke every active session for this account across all browsers and devices."
          />
        </SoftPanel>
      </InfoCard>
    </div>
  );
}
