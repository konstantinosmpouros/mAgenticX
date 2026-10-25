import { memo, useEffect, useId, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  CalendarClock,
  CircleAlert,
  FileText,
  Loader2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AgentMapIcon } from "@/shared/ui/agent-map-icon";
import { Button } from "@/shared/ui/button";
import { BrandLogo } from "@/shared/ui/brand-logo";
import { PlanIcon } from "@/shared/ui/plan-icon";
import { cn } from "@/shared/lib/utils";
import { EASE_ENTER } from "@/shared/lib/motion/panels";
import { beginEntraLogin, restoreSessionWhenReachable } from "@/shared/lib/api";
import { loadSession, saveSession, updateSession } from "@/shared/lib/authStorage";
import { formatDeletionDate, readDeletionNotice } from "@/features/settings/lib/accountDeletion";
import { NightSky } from "@/features/auth/components/NightSky";

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

// What the product does, beside the card on wide screens. The plan and the
// agent map wear the same marks as their buttons in the app.
const HIGHLIGHTS: { icon: ComponentType<{ className?: string }>; title: string; body: string }[] = [
  {
    icon: PlanIcon,
    title: "Plans you can follow",
    body: "Hand over a goal and watch each step get ticked off as it runs.",
  },
  {
    icon: AgentMapIcon,
    title: "Agents and sub-agents",
    body: "Specialists take on the parts side by side, mapped live as they run.",
  },
  {
    icon: FileText,
    title: "Your files, in context",
    body: "Share documents and the agents read, search and build on them.",
  },
];

// The backdrop: a night sky in every theme (styles/login.css), its nebula
// and horizon tinted by the theme's orb hues, the stars and falling stars on
// one canvas (NightSky). Memoized so state changes never re-render it.
const LoginSky = memo(
  () => (
    <div className="login-sky" aria-hidden="true">
      <div className="login-nebula login-nebula-1" />
      <div className="login-nebula login-nebula-2" />
      <div className="login-nebula login-nebula-3" />
      <div className="login-horizon" />
      <NightSky className="login-stars" />
    </div>
  ),
  () => true,
);

/** An inline notice in the card: a sign-in that bounced, or what happens next. */
function LoginNotice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "error" | "info";
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-2xl border px-4 py-3 text-left",
        tone === "error"
          ? "border-destructive/25 bg-destructive/[0.07]"
          : "border-primary/20 bg-primary/[0.06]",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "error" ? "text-destructive" : "text-primary",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-[13px] leading-relaxed text-foreground/75">{children}</p>
      </div>
    </div>
  );
}

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
 *
 * It is always night here: the product's logo and a few lines on what it does
 * on one side (stacked above on narrow screens), light on the sky in every
 * theme, and the sign-in card, night-tinted glass rimmed and lit in the
 * active theme's hues, on the other (styles/login.css, NightSky).
 */
export default function Login({ decorative = false }: LoginProps = {}) {
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const headingId = useId();
  // "Add another account": the caller is already signed in and wants a second
  // session parked alongside the first, so the restore-and-redirect below must
  // be skipped and the sign-in must be started with park=true.
  const addAccountMode = new URLSearchParams(window.location.search).get("add") === "1";
  // Set once the browser is being handed to Microsoft, so a second click can't
  // start a second flow while the page unloads.
  const [redirecting, setRedirecting] = useState(false);
  // Why the OIDC callback bounced back (?sso=<reason>), read once on arrival and
  // shown in the card until the page is left. The effect below drops it from
  // the URL.
  const [ssoError] = useState<string | null>(() => {
    if (decorative) return null;
    const reason = new URLSearchParams(window.location.search).get("sso");
    return reason ? (SSO_ERROR_MESSAGES[reason] ?? "Sign-in could not be completed.") : null;
  });
  // Arriving straight after "Delete account" (plan 32): what happens next.
  const [deletionNotice] = useState(() =>
    decorative ? null : readDeletionNotice(window.location.search),
  );

  // Drop the ?sso=<reason> the OIDC callback bounced back with, once it is on screen.
  useEffect(() => {
    if (decorative) return;
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("sso");
    if (reason) {
      // Drop only `sso`, so a refresh doesn't show it again. `add` must survive:
      // a refused "add another account" comes back as ?add=1&sso=…, and losing
      // it would flip this page out of add mode — where it restores the
      // signed-in account and reloads into the app, hiding the reason it was refused.
      params.delete("sso");
      const rest = params.toString();
      window.history.replaceState(
        {},
        "",
        rest ? `${window.location.pathname}?${rest}` : window.location.pathname,
      );
    }
  }, [decorative]);

  // The deletion notice is on screen: drop its query too.
  useEffect(() => {
    if (decorative) return;
    const notice = readDeletionNotice(window.location.search);
    if (!notice) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("deletion");
    params.delete("on");
    const rest = params.toString();
    window.history.replaceState(
      {},
      "",
      rest ? `${window.location.pathname}?${rest}` : window.location.pathname,
    );
  }, [decorative]);

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
    const controller = new AbortController();
    const run = async () => {
      try {
        const existing = loadSession();
        // Retried until the bridge answers. This page is often reached straight
        // after waking from sleep, before the network is back; a single attempt
        // then failed and left a user with a valid session looking at the
        // sign-in button until they reloaded. Stops when the page unmounts.
        const restored = await restoreSessionWhenReachable({ signal: controller.signal });
        if (
          !controller.signal.aborted &&
          restored?.authenticated &&
          restored.user &&
          restored.user.id
        ) {
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
        // An abort is just the page unmounting mid-retry, not a failure.
        if (!controller.signal.aborted) console.error("Session restore failed:", error);
      }
    };
    void run();
    return () => controller.abort();
  }, [navigate, addAccountMode, decorative]);

  const handleMicrosoftSignIn = () => {
    if (redirecting) return;
    setRedirecting(true);
    beginEntraLogin({ park: addAccountMode });
  };

  const deletionDate = deletionNotice ? formatDeletionDate(deletionNotice.scheduledFor) : "";

  // Staggered entrance: the container reveals children one after another;
  // each child fades up. Reduced motion collapses offsets to a plain fade.
  const containerVariants: Variants = {
    hidden: {},
    show: {
      transition: reduceMotion
        ? { staggerChildren: 0 }
        : { staggerChildren: 0.07, delayChildren: 0.1 },
    },
  };
  const itemVariants: Variants = {
    hidden: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, ease: EASE_ENTER },
    },
  };

  return (
    <div className="relative isolate flex min-h-[100dvh] flex-col text-foreground">
      <LoginSky />

      <main
        aria-labelledby={headingId}
        className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8 lg:px-12"
      >
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="login-layout grid w-full max-w-[28rem] items-center gap-8 sm:gap-10 lg:max-w-[68rem] lg:grid-cols-[minmax(0,1fr)_28rem] lg:gap-20"
        >
          {/* The product: its logo, its name, what it is. This column sits
              on the night sky, so its text is light in every theme. */}
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <motion.div variants={itemVariants} className="login-logo">
              <span aria-hidden="true" className="login-logo-glow" />
              {/* Decorative: the product name is right below it. */}
              <BrandLogo on="dark" animated="lively" className="h-14 w-14 lg:h-20 lg:w-20" />
            </motion.div>
            <motion.p
              variants={itemVariants}
              className="mt-5 text-[2rem] font-semibold leading-none tracking-[-0.03em] text-white lg:mt-8 lg:text-[3.25rem]"
            >
              mAgenticX
            </motion.p>
            <motion.p
              variants={itemVariants}
              className="mt-3 max-w-[22rem] text-balance text-sm leading-relaxed text-white/70 lg:mt-4 lg:max-w-md lg:text-lg"
            >
              The workspace where AI agents plan, delegate and deliver.
            </motion.p>

            <ul className="mt-12 hidden max-w-[30rem] space-y-6 lg:block">
              {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
                <motion.li key={title} variants={itemVariants} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-[hsl(var(--primary-glow))] backdrop-blur-sm"
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-semibold text-white">{title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-white/65">{body}</p>
                  </div>
                </motion.li>
              ))}
            </ul>
          </div>

          {/* The sign-in card: night-tinted glass over the sky, rimmed and lit
              in the theme's hues (styles/login.css). Its glow quickens while
              the browser is handed to Microsoft. */}
          <motion.div
            variants={itemVariants}
            className="login-shell login-glass-night dark"
            data-busy={redirecting}
          >
            <div aria-hidden="true" className="login-card-glow" />
            <div className="login-card px-6 py-9 sm:px-10 sm:py-11">
              <div aria-hidden="true" className="login-card-sheen" />

              <div className="relative flex flex-col gap-6">
                <div className="space-y-2 text-center">
                  <p className="flex items-center justify-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-[hsl(var(--primary-glow))]">
                    <span
                      aria-hidden="true"
                      className="h-px w-6 bg-gradient-to-r from-transparent to-current opacity-60"
                    />
                    {addAccountMode ? "Accounts" : "Welcome"}
                    <span
                      aria-hidden="true"
                      className="h-px w-6 bg-gradient-to-l from-transparent to-current opacity-60"
                    />
                  </p>
                  <h1
                    id={headingId}
                    className="text-balance text-[1.625rem] font-semibold leading-tight tracking-[-0.02em] text-foreground"
                  >
                    {addAccountMode ? "Add another account" : "Sign in"}
                  </h1>
                  <p className="text-balance text-sm leading-relaxed text-muted-foreground">
                    {addAccountMode
                      ? "Choose the Microsoft account to add. You'll stay signed in to this one."
                      : "Use your organization's Microsoft account to continue."}
                  </p>
                </div>

                {ssoError ? (
                  <LoginNotice tone="error" icon={CircleAlert} title="Microsoft sign-in">
                    {ssoError}
                  </LoginNotice>
                ) : null}

                {deletionNotice ? (
                  <LoginNotice
                    tone="info"
                    icon={CalendarClock}
                    title="Your account is scheduled for deletion"
                  >
                    {deletionDate
                      ? `It will be permanently deleted on ${deletionDate}. Sign in before then to cancel.`
                      : "Sign in before the deletion date to cancel."}
                  </LoginNotice>
                ) : null}

                <div className="space-y-3">
                  {/* Microsoft's own sign-in button themes (their branding
                      guidelines define the approved styles, so this is not the
                      app accent): the light face on the night glass, the dark
                      face on a light card — whichever stands out. The lift and
                      press are CSS on the button itself: a framer-motion tap
                      wrapper would be a tab stop of its own. */}
                  <Button
                    type="button"
                    onClick={handleMicrosoftSignIn}
                    disabled={redirecting}
                    aria-busy={redirecting}
                    className={cn(
                      "h-12 w-full gap-3 rounded-xl text-[15px] font-semibold",
                      "transition-[background-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px active:translate-y-0 active:scale-[0.985] motion-reduce:transform-none",
                      "bg-[#2f2f2f] text-white shadow-[0_14px_32px_-18px_rgba(0,0,0,0.6)] hover:bg-[#1f1f1f]",
                      "dark:bg-white dark:text-[#2f2f2f] dark:shadow-[inset_0_-1px_0_rgba(0,0,0,0.08),0_16px_40px_-18px_rgba(255,255,255,0.45)] dark:hover:bg-neutral-100",
                      "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                      "disabled:cursor-wait disabled:opacity-90",
                    )}
                  >
                    {redirecting ? (
                      <Loader2 className="!h-[18px] !w-[18px] animate-spin" aria-hidden="true" />
                    ) : (
                      <MicrosoftLogo className="!h-[18px] !w-[18px]" />
                    )}
                    <span>
                      {redirecting ? "Redirecting to Microsoft…" : "Sign in with Microsoft"}
                    </span>
                  </Button>
                  <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Secure single sign-on with Microsoft Entra ID
                  </p>
                </div>

                {addAccountMode ? (
                  // The user is still signed in here — adding an account is optional,
                  // and a refused attempt must never leave them stranded on this page.
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => window.location.assign("/")}
                      className="rounded-md px-2 py-1 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                    >
                      Cancel — back to my workspace
                    </button>
                  </div>
                ) : null}

                <div
                  aria-hidden="true"
                  className="h-px bg-gradient-to-r from-transparent via-border to-transparent"
                />
                <p className="-mt-1 text-balance text-center text-xs leading-relaxed text-muted-foreground">
                  Don't have access yet? Ask your administrator to add you.
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </main>

      <footer className="px-4 pb-6 text-center text-xs text-white/60">
        <nav aria-label="Legal" className="inline-flex items-center gap-2">
          <Link
            to="/terms"
            className="rounded-sm underline-offset-4 transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Terms &amp; Conditions
          </Link>
          <span aria-hidden="true">·</span>
          <Link
            to="/privacy"
            className="rounded-sm underline-offset-4 transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Privacy Policy
          </Link>
        </nav>
      </footer>
    </div>
  );
}
