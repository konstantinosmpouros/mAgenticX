import { memo, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { Loader2 } from "lucide-react";
import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";
import ParticleNetwork from "@/shared/ui/react_bits/bg_particle_network";
import { beginEntraLogin, restoreSession } from "@/shared/lib/api";
import { loadSession, saveSession, updateSession } from "@/shared/lib/authStorage";
import { useToast } from "@/shared/hooks/use-toast";

// Microsoft's brand mark (the 4-colour squares). Justified custom component:
// Lucide carries no brand logos, and Microsoft's sign-in branding guidelines
// require their own mark — so this is an inline SVG rather than a Lucide icon.
const MicrosoftLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 21 21" aria-hidden="true" focusable="false">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);

// Human-readable reasons for a bounced SSO callback (?sso=<reason>).
const SSO_ERROR_MESSAGES: Record<string, string> = {
  failed: "Microsoft sign-in did not complete. Please try again.",
  denied:
    "This Microsoft account isn't authorized to access mAgenticX. Contact an administrator to request access.",
  // A first sign-in whose username or email already belongs to another account.
  // Accounts are matched by Microsoft's account id only, never by email, so this
  // needs an administrator rather than a retry.
  conflict:
    "This Microsoft account matches an existing account that hasn't been linked yet. Contact an administrator.",
  disabled: "Your account is disabled. Contact an administrator.",
};

// Animated backdrop: a constellation network over a layered charcoal→magenta
// vignette. Memoized so state changes never re-mount the canvas.
const ParticleBg = memo(
  () => (
    <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-[#060709]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,_rgba(208,176,255,0.08)_0%,_rgba(6,7,9,0)_55%)]" />
      <ParticleNetwork
        className="absolute inset-0 h-full w-full"
        density={0.9}
        maxDistance={140}
        speed={1}
        accentRatio={0.18}
      />
    </div>
  ),
  () => true,
);

type LoginProps = {
  /**
   * Render as inert wallpaper. The cookie-consent gate in App.tsx mounts this
   * page behind a blur purely for looks, but a live Login is not decoration:
   * its session-restore effect calls `window.location.assign("/")`, which —
   * once the user has a valid session cookie but no persisted consent — puts
   * the app in an infinite reload loop that makes signing in impossible.
   * Decorative instances therefore skip every effect with a side effect
   * (navigation, document.title, query-string rewriting).
   */
  decorative?: boolean;
};

/**
 * The sign-in page. Microsoft Entra ID is the only way in (plan 29 removed
 * username/password), so the page is one action: hand the browser to Microsoft.
 * The password, MFA and any conditional-access policy all happen there; the
 * bridge's callback mints the session and lands the user back in the app.
 */
export default function Login({ decorative = false }: LoginProps = {}) {
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  // "Add another account": the caller is already signed in and wants a second
  // session parked alongside the first, so the restore-and-redirect below must
  // be skipped and the sign-in must be started with park=true.
  const addAccountMode = new URLSearchParams(window.location.search).get("add") === "1";
  const { toast } = useToast();
  // Set once the browser is being handed to Microsoft, so a second click can't
  // start a second flow while the page unloads.
  const [redirecting, setRedirecting] = useState(false);

  // Surface any ?sso=<reason> the OIDC callback bounced back with.
  useEffect(() => {
    if (decorative) return;
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("sso");
    if (reason) {
      toast({
        title: "Microsoft sign-in",
        description: SSO_ERROR_MESSAGES[reason] ?? "Sign-in could not be completed.",
        variant: "destructive",
        duration: 6000,
      });
      // Drop only `sso`, so a refresh doesn't re-toast. `add` must survive: a
      // refused "add another account" comes back as ?add=1&sso=…, and losing it
      // would flip this page out of add mode — where it restores the signed-in
      // account and reloads into the app, hiding the reason it was refused.
      params.delete("sso");
      const rest = params.toString();
      window.history.replaceState({}, "", rest ? `${window.location.pathname}?${rest}` : window.location.pathname);
    }
  }, [toast, decorative]);

  useEffect(() => {
    if (decorative) return;
    const previous = document.title;
    document.title = "Sign in · mAgenticX";
    return () => {
      document.title = previous;
    };
  }, [decorative]);

  // Coming back from Microsoft with the browser's Back button restores this page
  // from the back-forward cache, frozen mid-redirect. Re-arm the button then,
  // or it stays disabled with a spinner that will never resolve.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (decorative) {
      // The consent-gate wallpaper instance: restoring here would redirect
      // to "/", which re-mounts the gate and reloads forever.
      return;
    }
    if (addAccountMode) {
      // A valid session exists on purpose here; restoring it would bounce
      // the user straight back to the app instead of letting them add one.
      return;
    }
    const run = async () => {
      try {
        const existing = loadSession();
        const restored = await restoreSession();
        if (!cancelled && restored?.authenticated && restored.user && restored.user.id) {
          const ttlSeconds =
            typeof restored.tokenTtl === "number" && restored.tokenTtl > 0
              ? restored.tokenTtl
              : 3600;
          saveSession(restored.user, ttlSeconds * 1000);
          if (existing) {
            updateSession({
              lastConversationId: existing.lastConversationId,
              selectedAgent: existing.selectedAgent,
              isPrivateMode: existing.isPrivateMode,
            });
          }
          // A HARD navigation, not a router push. The workspace store is
          // module-level, so a client-side navigate can arrive at "/" still
          // holding a previous account's userId, and every request keyed on it
          // is then rejected. Reloading starts from the session that exists.
          window.location.assign("/");
        }
      } catch (error) {
        console.error("Session restore failed:", error);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [navigate, addAccountMode, decorative]);

  const handleMicrosoftSignIn = () => {
    if (redirecting) return;
    setRedirecting(true);
    beginEntraLogin({ park: addAccountMode });
  };

  // Staggered entrance: the container reveals children one after another;
  // each child fades up. Reduced motion collapses offsets to a plain fade.
  const containerVariants: Variants = {
    hidden: {},
    show: {
      transition: reduceMotion
        ? { staggerChildren: 0 }
        : { staggerChildren: 0.08, delayChildren: 0.12 },
    },
  };
  const itemVariants: Variants = {
    hidden: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
    },
  };

  return (
    // Force dark styling for the login scene even when global theme is light
    <div className="dark flex min-h-[100dvh] items-center justify-center">
      <ParticleBg />
      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[min(92vw,30rem)]"
      >
        <Card className="relative w-full overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#0b0c10]/85 px-7 py-10 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.92)] backdrop-blur-2xl sm:px-11 sm:py-14">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_rgba(255,255,255,0.05)_0%,_rgba(11,12,16,0)_60%)]"
            aria-hidden="true"
          />

          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="relative z-10 flex flex-col gap-10 text-white"
          >
            <header className="flex flex-col items-center gap-5 text-center">
              <motion.div
                variants={itemVariants}
                animate={reduceMotion ? undefined : { y: [0, -6, 0] }}
                transition={
                  reduceMotion ? undefined : { duration: 4.5, repeat: Infinity, ease: "easeInOut" }
                }
                className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/25 bg-gradient-to-br from-white/25 via-white/12 to-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]"
              >
                <div
                  className="pointer-events-none absolute -inset-2 rounded-[1.75rem] bg-[radial-gradient(circle,_rgba(211,164,255,0.45)_0%,_rgba(211,164,255,0)_70%)] blur-md"
                  aria-hidden="true"
                />
                <img
                  src="/logo2.png"
                  alt="mAgenticX mark"
                  className="relative h-10 w-10 object-contain"
                />
              </motion.div>
              <div className="space-y-2">
                <motion.h1
                  variants={itemVariants}
                  className="text-xl font-semibold tracking-tight text-white sm:text-2xl"
                >
                  {addAccountMode ? "Add another account" : "Sign in to mAgenticX"}
                </motion.h1>
                <motion.p variants={itemVariants} className="text-sm text-white/55">
                  {addAccountMode
                    ? "Choose the Microsoft account to add. You'll stay signed in to this one."
                    : "Use your organization's Microsoft account to continue."}
                </motion.p>
                <motion.div
                  variants={itemVariants}
                  className="mx-auto h-px w-14 rounded-full bg-gradient-to-r from-transparent via-[#dba9ff]/70 to-transparent"
                />
              </div>
            </header>

            <div className="space-y-8 text-white">
              <motion.div variants={itemVariants}>
                <motion.div
                  whileHover={redirecting || reduceMotion ? undefined : { scale: 1.02 }}
                  whileTap={redirecting || reduceMotion ? undefined : { scale: 0.98 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  {/* Microsoft's "light" sign-in button theme: white face, neutral
                      text, the four-square mark. Their branding guidelines define
                      the approved button styles, so this is not the app accent. */}
                  <Button
                    type="button"
                    onClick={handleMicrosoftSignIn}
                    disabled={redirecting}
                    aria-busy={redirecting}
                    className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-white/80 bg-white text-neutral-900 shadow-[0_18px_44px_-22px_rgba(255,255,255,0.35)] transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-[#d0b0ff]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c10] disabled:cursor-wait disabled:opacity-80"
                  >
                    {redirecting ? (
                      <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
                    ) : (
                      <MicrosoftLogo className="h-[18px] w-[18px]" />
                    )}
                    <span className="text-sm font-semibold tracking-wide">
                      {redirecting ? "Redirecting to Microsoft…" : "Sign in with Microsoft"}
                    </span>
                  </Button>
                </motion.div>
              </motion.div>

              {addAccountMode ? (
                // The user is still signed in here — adding an account is optional,
                // and a refused attempt must never leave them stranded on this page.
                <motion.div variants={itemVariants} className="text-center">
                  <button
                    type="button"
                    onClick={() => window.location.assign("/")}
                    className="text-xs font-medium text-white/65 underline-offset-4 transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:underline"
                  >
                    Cancel — back to my workspace
                  </button>
                </motion.div>
              ) : null}

              <motion.div variants={itemVariants} className="text-center text-xs text-white/55">
                Don't have access yet?{" "}
                <button
                  type="button"
                  className="font-semibold text-[#d0b0ff] underline-offset-4 transition-colors hover:text-white"
                >
                  Request to sign up
                </button>
              </motion.div>
            </div>
          </motion.div>
        </Card>
      </motion.div>
    </div>
  );
}
