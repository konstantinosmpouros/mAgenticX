import { motion, useReducedMotion } from "framer-motion";
import { Camera } from "lucide-react";

import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import { safeText } from "@/shared/lib/utils";
import { NA } from "@/shared/lib/consts";
import type { UserProfile } from "@/shared/lib/types";

/**
 * EditProfileDialog — the small "Edit profile" card opened from the sidebar
 * profile menu (mirroring ChatGPT's). Identity fields come from the identity
 * provider (Vault / Entra) and are not editable in-app yet, so the inputs
 * render read-only with a "coming soon" save affordance rather than a fake
 * mutable form.
 */
type EditProfileDialogProps = {
    open: boolean;
    onClose: () => void;
    user: UserProfile | null;
};

const fieldBoxClass =
    "rounded-2xl border border-white/[0.12] bg-white/[0.045] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";

const Field = ({ label, value }: { label: string; value: string }) => (
    <div className={fieldBoxClass}>
        <p className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-white/40">{label}</p>
        <p className="mt-1 truncate text-sm font-medium text-white/90">{value}</p>
    </div>
);

export default function EditProfileDialog({ open, onClose, user }: EditProfileDialogProps) {
    const reduceMotion = useReducedMotion();

    const displayName =
        safeText(user?.displayName) !== NA
            ? safeText(user?.displayName)
            : safeText(user?.fullName) !== NA
              ? safeText(user?.fullName)
              : safeText(user?.username);
    const initials =
        displayName
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || "?";

    return (
        <PremiumModalShell open={open} onClose={onClose} closeLabel="Close edit profile" className="max-w-md">
            <div className="px-6 pb-6 pt-6 md:px-7 md:pb-7">
                <h3 className="pr-12 text-xl font-semibold leading-tight tracking-tight text-white">
                    Edit profile
                </h3>

                <div className="mt-6 flex justify-center">
                    <motion.div
                        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        className="relative"
                    >
                        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-gradient-to-br from-primary/80 to-primary/40 text-3xl font-semibold text-white shadow-[0_18px_50px_-20px_rgba(255,0,123,0.55)]">
                            {user?.avatarUrl ? (
                                <img src={user.avatarUrl} alt={displayName} className="h-full w-full object-cover" />
                            ) : (
                                <span aria-hidden>{initials}</span>
                            )}
                        </div>
                        <span
                            title="Avatar upload coming soon"
                            className="absolute -bottom-0.5 -right-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.14] bg-[#252525] text-white/60 shadow-lg"
                        >
                            <Camera size={14} aria-hidden />
                        </span>
                    </motion.div>
                </div>

                <div className="mt-6 space-y-3">
                    <Field label="Display name" value={displayName} />
                    <Field label="Username" value={safeText(user?.username)} />
                    <Field label="Email" value={safeText(user?.email)} />
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Department" value={safeText(user?.department)} />
                        <Field label="Role" value={safeText(user?.roleTitle)} />
                    </div>
                </div>

                <p className="mt-4 text-center text-xs leading-5 text-white/45">
                    Profile details come from your sign-in identity. In-app editing is coming soon.
                </p>

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-11 rounded-full border border-white/[0.14] bg-white/[0.06] px-5 text-sm font-semibold text-white shadow-lg transition hover:scale-[1.03] hover:bg-white/[0.1] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        disabled
                        title="Profile editing coming soon"
                        className="h-11 cursor-not-allowed rounded-full bg-white/40 px-6 text-sm font-semibold text-black/70 shadow-lg"
                    >
                        Save
                    </button>
                </div>
            </div>
        </PremiumModalShell>
    );
}
