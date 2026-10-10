import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Camera, Loader2 } from "lucide-react";

import { PremiumModalShell } from "@/shared/ui/premium-modal-shell";
import { safeText } from "@/shared/lib/utils";
import { NA } from "@/shared/lib/consts";
import type { UserProfile } from "@/shared/lib/types";
import {
  AVATAR_ACCEPT,
  MAX_PROFILE_NAME_LENGTH,
  useEditProfile,
} from "@/features/settings/hooks/useEditProfile";

/**
 * EditProfileDialog — the small "Edit profile" card opened from the sidebar
 * profile menu (mirroring ChatGPT's). The display name and the photo are the
 * user's to change: a later Microsoft sign-in never overwrites either, and
 * clearing the name goes back to Microsoft's. Username, email, department and
 * role come from Microsoft and stay read-only.
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
    <p className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-white/40">
      {label}
    </p>
    <p className="mt-1 truncate text-sm font-medium text-white/90">{value}</p>
  </div>
);

/** Whitespace runs collapse to one space — the same rule the bridge applies. */
const normalizeName = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

export default function EditProfileDialog({ open, onClose, user }: EditProfileDialogProps) {
  const reduceMotion = useReducedMotion();
  const nameInputId = useId();
  const { saving, saveName, savePhoto, removePhoto } = useEditProfile(user);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState("");

  const displayName =
    safeText(user?.displayName) !== NA
      ? safeText(user?.displayName)
      : safeText(user?.fullName) !== NA
        ? safeText(user?.fullName)
        : safeText(user?.username);
  // Start from the name on screen every time the card opens.
  useEffect(() => {
    if (open) setNameDraft(displayName === NA ? "" : displayName);
  }, [open, displayName]);

  const draft = normalizeName(nameDraft);
  const changed = draft !== (displayName === NA ? "" : displayName);
  const canSave = changed && !saving;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    // A blank name means "use Microsoft's", the same as the reset link.
    if (await saveName(draft || null)) onClose();
  };

  const handlePhotoPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const photo = event.target.files?.[0];
    // Reset first, so picking the same file again still fires a change.
    event.target.value = "";
    if (photo) await savePhoto(photo);
  };

  const handleUseMicrosoftName = async () => {
    if (await saveName(null)) onClose();
  };

  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <PremiumModalShell
      open={open}
      onClose={onClose}
      closeLabel="Close edit profile"
      className="max-w-md"
    >
      <form onSubmit={handleSubmit} className="px-6 pb-6 pt-6 md:px-7 md:pb-7">
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
                <img
                  src={user.avatarUrl}
                  alt={displayName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span aria-hidden>{initials}</span>
              )}
            </div>
            {saving ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45">
                <Loader2 size={22} className="animate-spin text-white" aria-hidden />
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={saving}
              aria-label="Change photo"
              title="Change photo"
              className="absolute -bottom-0.5 -right-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.14] bg-[#252525] text-white/70 shadow-lg transition hover:scale-105 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-60"
            >
              <Camera size={14} aria-hidden />
            </button>
            <input
              ref={photoInputRef}
              type="file"
              accept={AVATAR_ACCEPT}
              onChange={handlePhotoPicked}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
            />
          </motion.div>
        </div>

        {user?.hasOwnAvatar ? (
          <div className="mt-2 flex justify-center">
            <button
              type="button"
              onClick={() => void removePhoto()}
              disabled={saving}
              className="rounded text-xs font-medium text-white/55 underline-offset-2 transition hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-60"
            >
              Remove photo
            </button>
          </div>
        ) : null}

        <div className="mt-6 space-y-3">
          <div className={`${fieldBoxClass} transition focus-within:border-white/30`}>
            <label
              htmlFor={nameInputId}
              className="text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-white/40"
            >
              Display name
            </label>
            <input
              id={nameInputId}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={MAX_PROFILE_NAME_LENGTH}
              autoComplete="name"
              disabled={saving}
              className="mt-1 w-full bg-transparent text-sm font-medium text-white/90 placeholder:text-white/30 focus:outline-none disabled:opacity-60"
              placeholder="Your name"
            />
          </div>
          <Field label="Username" value={safeText(user?.username)} />
          <Field label="Email" value={safeText(user?.email)} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department" value={safeText(user?.department)} />
            <Field label="Role" value={safeText(user?.roleTitle)} />
          </div>
        </div>

        <p className="mt-4 text-center text-xs leading-5 text-white/45">
          Your name and photo are yours to change. The other details come from your Microsoft account.
          {user?.preferredName ? (
            <>
              {" "}
              <button
                type="button"
                onClick={handleUseMicrosoftName}
                disabled={saving}
                className="rounded font-medium text-white/70 underline-offset-2 transition hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:opacity-60"
              >
                Use my Microsoft name
              </button>
            </>
          ) : null}
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
            type="submit"
            disabled={!canSave}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-black shadow-lg transition hover:scale-[1.03] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 disabled:cursor-not-allowed disabled:bg-white/40 disabled:text-black/70 disabled:hover:scale-100"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
            Save
          </button>
        </div>
      </form>
    </PremiumModalShell>
  );
}
