import { FormEvent, KeyboardEvent, memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Check, Loader2 } from "lucide-react";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Button } from "@/shared/ui/button";
import { VscEye, VscEyeClosed } from "react-icons/vsc";
import ParticleNetwork from "@/shared/ui/react_bits/bg_particle_network";
import { authenticate, beginEntraLogin, getAuthConfig, restoreSession } from "@/shared/lib/api";
import { loadSession, saveSession, updateSession } from "@/shared/lib/authStorage";
import { useToast } from "@/shared/hooks/use-toast";
import { cn } from "@/shared/lib/utils";
import type { AuthApiError } from "@/shared/lib/types";

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
    denied: "This Microsoft account isn't authorized to access mAgenticX. Contact an administrator to request access.",
    conflict: "This Microsoft account's email is already linked to another sign-in method.",
    disabled: "Your account is disabled. Contact an administrator.",
};

// Animated backdrop: a constellation network over a layered charcoal→magenta
// vignette. Memoized so form state changes never re-mount the canvas.
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

export default function Login() {
    const reduceMotion = useReducedMotion();
    const navigate = useNavigate();
    // "Add another account": the caller is already signed in and wants a second
    // session parked alongside the first, so the restore-and-redirect below must
    // be skipped and the login must be sent with park=true.
    const addAccountMode = new URLSearchParams(window.location.search).get("add") === "1";
    const { toast } = useToast();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [authStatus, setAuthStatus] = useState<"idle" | "rate_limited">("idle");
    const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
    const [cooldownSeconds, setCooldownSeconds] = useState(0);
    const [capsLock, setCapsLock] = useState(false);
    const [success, setSuccess] = useState(false);
    const [oidcEnabled, setOidcEnabled] = useState(false);

    const isRateLimited = rateLimitedUntil !== null && cooldownSeconds > 0;

    // Ask the backend whether Microsoft SSO is configured (button hidden if not),
    // and surface any ?sso=<reason> the OIDC callback bounced back with.
    useEffect(() => {
        let cancelled = false;
        void getAuthConfig()
            .then((config) => {
                if (!cancelled) setOidcEnabled(config.oidcEnabled);
            })
            .catch(() => {
                if (!cancelled) setOidcEnabled(false);
            });

        const reason = new URLSearchParams(window.location.search).get("sso");
        if (reason) {
            toast({
                title: "Microsoft sign-in",
                description: SSO_ERROR_MESSAGES[reason] ?? "Sign-in could not be completed.",
                variant: "destructive",
                duration: 3200,
            });
            // Strip the query so a refresh doesn't re-toast.
            window.history.replaceState({}, "", window.location.pathname);
        }
        return () => {
            cancelled = true;
        };
    }, [toast]);

    useEffect(() => {
        const previous = document.title;
        document.title = "Sign in · mAgenticX";
        return () => {
            document.title = previous;
        };
    }, []);

    const handleCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
        if (typeof event.getModifierState === "function") {
            setCapsLock(event.getModifierState("CapsLock"));
        }
    };

    useEffect(() => {
        if (rateLimitedUntil === null) {
            setCooldownSeconds(0);
            return;
        }

        const tick = () => {
            const remainingMs = rateLimitedUntil - Date.now();
            if (remainingMs <= 0) {
                setRateLimitedUntil(null);
                setCooldownSeconds(0);
                setAuthStatus((current) => (current === "rate_limited" ? "idle" : current));
                return;
            }
            setCooldownSeconds(Math.max(1, Math.ceil(remainingMs / 1000)));
        };

        tick();
        const timer = window.setInterval(tick, 1000);
        return () => {
            window.clearInterval(timer);
        };
    }, [rateLimitedUntil]);

    const statusConfig = useMemo(() => {
        if (authStatus === "rate_limited" && isRateLimited) {
            return {
                text: "Sign-in paused",
                tooltip: "Too many sign-in attempts. Please wait for the timer to end.",
                tone: "warning" as const,
                chip: `${cooldownSeconds}s`,
            };
        }

        return null;
    }, [authStatus, cooldownSeconds, isRateLimited]);

    // Single accent palette (black/white/magenta): the rate-limit "paused"
    // state reads as a restrained magenta chip rather than amber/rose.
    const statusToneClasses = "text-white/65";

    const dotToneClasses = "bg-[#d0b0ff] shadow-[0_0_16px_rgba(208,176,255,0.5)] animate-pulse";

    const chipToneClasses = "border-[#d0b0ff]/30 bg-[#d0b0ff]/12 text-[#ecdcff]";

    useEffect(() => {
        let cancelled = false;
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
                        typeof restored.tokenTtl === "number" && restored.tokenTtl > 0 ? restored.tokenTtl : 3600;
                    saveSession(restored.user, ttlSeconds * 1000);
                    if (existing) {
                        updateSession({
                            lastConversationId: existing.lastConversationId,
                            selectedAgent: existing.selectedAgent,
                            isPrivateMode: existing.isPrivateMode,
                        });
                    }
                    navigate("/", { replace: true });
                }
            } catch (error) {
                console.error("Session restore failed:", error);
            }
        };
        void run();
        return () => {
            cancelled = true;
        };
    }, [navigate, addAccountMode]);

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

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (submitting || isRateLimited) return;
        setSubmitting(true);
        try {
            setAuthStatus("idle");
            const response = await authenticate(
                { username: username.trim(), password },
                { park: addAccountMode },
            );
            if (response.authenticated && response.user && response.user.id) {
                const ttlSeconds =
                    typeof response.tokenTtl === "number" && response.tokenTtl > 0 ? response.tokenTtl : 3600;
                saveSession(response.user, ttlSeconds * 1000);
                setUsername("");
                setPassword("");
                // Brief success beat so the hand-off feels intentional, not abrupt.
                setSuccess(true);
                if (!reduceMotion) {
                    await new Promise((resolve) => setTimeout(resolve, 450));
                }
                if (addAccountMode) {
                    // A HARD navigation, not a router push. The workspace store is
                    // module-level, so a client-side navigate would arrive at "/"
                    // still holding the PREVIOUS account's userId, agents and
                    // conversations — and every request keyed on that stale id is
                    // then rejected as "Token does not grant access to this user",
                    // because the cookies now belong to the account just added.
                    // Reloading restarts the app from the new session instead.
                    window.location.assign("/");
                    return;
                }
                navigate("/", { replace: true });
            } else {
                toast({
                    title: "Authentication failed",
                    description: "Please check your credentials and try again.",
                    variant: "destructive",
                    duration: 2200,
                });
            }
        } catch (error) {
            console.error("Authentication error:", error);
            const authError = error as AuthApiError;
            if (authError?.status === 429) {
                const retryAfterSeconds =
                    typeof authError.retryAfterSeconds === "number" && authError.retryAfterSeconds > 0
                        ? authError.retryAfterSeconds
                        : 60;
                setRateLimitedUntil(Date.now() + retryAfterSeconds * 1000);
                setCooldownSeconds(retryAfterSeconds);
                setAuthStatus("rate_limited");
                toast({
                    title: "Too many requests",
                    description: "Too many sign-in attempts. Please wait a moment and try again.",
                    variant: "destructive",
                    duration: 2600,
                });
                return;
            }
            if (authError?.status === 401) {
                toast({
                    title: "Authentication failed",
                    description: "Please check your credentials and try again.",
                    variant: "destructive",
                    duration: 2200,
                });
                return;
            }
            toast({
                title: "Login failed",
                description: "Unable to connect to authentication service",
                variant: "destructive",
            });
        } finally {
            setSubmitting(false);
        }
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
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" aria-hidden="true" />
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_rgba(255,255,255,0.05)_0%,_rgba(11,12,16,0)_60%)]" aria-hidden="true" />

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
                                transition={reduceMotion ? undefined : { duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                                className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/25 bg-gradient-to-br from-white/25 via-white/12 to-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]"
                            >
                                <div className="pointer-events-none absolute -inset-2 rounded-[1.75rem] bg-[radial-gradient(circle,_rgba(211,164,255,0.45)_0%,_rgba(211,164,255,0)_70%)] blur-md" aria-hidden="true" />
                                <img src="/logo2.png" alt="mAgenticX mark" className="relative h-10 w-10 object-contain" />
                            </motion.div>
                            <div className="space-y-2">
                                <motion.h1
                                    variants={itemVariants}
                                    className="text-xl font-semibold tracking-tight text-white sm:text-2xl"
                                >
                                    Sign in to mAgenticX
                                </motion.h1>
                                <motion.p variants={itemVariants} className="text-sm text-white/55">
                                    Enter your workspace credentials to continue.
                                </motion.p>
                                {/* Stable live region: the chip animates its height in/out so the
                                    divider below slides instead of jumping, and SR announces the pause. */}
                                <div role="status" aria-live="polite">
                                    <AnimatePresence>
                                        {statusConfig && (
                                            <motion.div
                                                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: "auto" }}
                                                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                                                transition={{ duration: 0.24, ease: "easeOut" }}
                                                className="overflow-hidden"
                                            >
                                                <div className="relative mx-auto w-fit pt-1">
                                            <button
                                                type="button"
                                                aria-label={statusConfig.tooltip}
                                                className="group/status relative block"
                                            >
                                                <span
                                                    className={cn(
                                                        "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-[0.16em] uppercase transition-colors",
                                                        statusToneClasses,
                                                    )}
                                                >
                                                    <span className={cn("h-1.5 w-1.5 rounded-full", dotToneClasses)} aria-hidden="true" />
                                                    <span>{statusConfig.text}</span>
                                                    {statusConfig.chip ? (
                                                        <span
                                                            className={cn(
                                                                "rounded-full border px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal",
                                                                chipToneClasses,
                                                            )}
                                                        >
                                                            {statusConfig.chip}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </button>
                                            <div
                                                className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-60 -translate-x-1/2 rounded-xl border border-white/10 bg-[#111827]/88 px-3 py-2 text-xs leading-relaxed text-white/82 opacity-0 shadow-[0_14px_34px_-18px_rgba(5,8,18,0.85)] backdrop-blur-xl transition-all duration-200 group-hover/status:translate-y-0 group-hover/status:opacity-100 group-focus-visible/status:translate-y-0 group-focus-visible/status:opacity-100"
                                                role="tooltip"
                                            >
                                                {statusConfig.tooltip}
                                            </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                                <motion.div
                                    variants={itemVariants}
                                    className="mx-auto h-px w-14 rounded-full bg-gradient-to-r from-transparent via-[#dba9ff]/70 to-transparent"
                                />
                            </div>
                        </header>

                        <div className="space-y-8 text-white">
                            <form className="space-y-6" onSubmit={handleSubmit}>
                                <motion.div variants={itemVariants} className="space-y-2">
                                    <label htmlFor="login-username" className="text-xs font-semibold uppercase tracking-[0.2em] text-white/65">
                                        Username
                                    </label>
                                    <Input
                                        id="login-username"
                                        type="text"
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value)}
                                        placeholder="Your username"
                                        autoComplete="username"
                                        className="h-12 rounded-xl !border-white/10 !bg-white/[0.04] text-sm text-white placeholder:text-white/45 transition-[border-color,box-shadow] duration-200 focus:border-[#e1c6ff]/55 focus:ring-[#e1c6ff]/30"
                                    />
                                </motion.div>

                                <motion.div variants={itemVariants} className="space-y-2">
                                    <label htmlFor="login-password" className="text-xs font-semibold uppercase tracking-[0.2em] text-white/65">
                                        Password
                                    </label>
                                    <div className="relative">
                                        <Input
                                            id="login-password"
                                            type={showPassword ? "text" : "password"}
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            onKeyDown={handleCapsLock}
                                            onKeyUp={handleCapsLock}
                                            onBlur={() => setCapsLock(false)}
                                            placeholder="Your password"
                                            autoComplete="current-password"
                                            className="h-12 rounded-xl !border-white/10 !bg-white/[0.04] pr-12 text-sm text-white placeholder:text-white/45 transition-[border-color,box-shadow] duration-200 focus:border-[#e1c6ff]/55 focus:ring-[#e1c6ff]/30"
                                        />
                                        <AnimatePresence>
                                            {password.trim() && (
                                                <motion.button
                                                    type="button"
                                                    initial={{ opacity: 0, scale: 0.8 }}
                                                    animate={{ opacity: 1, scale: 1 }}
                                                    exit={{ opacity: 0, scale: 0.8 }}
                                                    transition={{ duration: 0.15 }}
                                                    onClick={() => setShowPassword(!showPassword)}
                                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-white/65 transition-colors hover:text-white/85"
                                                    aria-label={showPassword ? "Hide password" : "Show password"}
                                                >
                                                    {showPassword ? <VscEyeClosed size={18} /> : <VscEye size={18} />}
                                                </motion.button>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                    <AnimatePresence>
                                        {capsLock && (
                                            <motion.p
                                                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                                                transition={{ duration: 0.16, ease: "easeOut" }}
                                                role="status"
                                                aria-live="polite"
                                                className="text-[11px] font-medium text-[#d0b0ff]"
                                            >
                                                Caps Lock is on
                                            </motion.p>
                                        )}
                                    </AnimatePresence>
                                </motion.div>

                                <motion.div variants={itemVariants}>
                                    <motion.div
                                        whileHover={submitting || isRateLimited || success || reduceMotion ? undefined : { scale: 1.02 }}
                                        whileTap={submitting || isRateLimited || success || reduceMotion ? undefined : { scale: 0.98 }}
                                        transition={{ duration: 0.18, ease: "easeOut" }}
                                    >
                                        <Button
                                            type="submit"
                                            disabled={submitting || isRateLimited || success}
                                            className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#e0c2ff] via-[#d0b0ff] to-[#c79bff] text-[#0a0b0f] shadow-[0_18px_44px_-22px_rgba(208,176,255,0.75)] transition-colors hover:from-[#e7cdff] hover:via-[#d9bdff] hover:to-[#cda6ff] focus-visible:ring-2 focus-visible:ring-[#d0b0ff]/45 disabled:cursor-not-allowed disabled:opacity-70"
                                        >
                                            {success ? (
                                                <Check className="h-4 w-4" aria-hidden="true" />
                                            ) : submitting ? (
                                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                            ) : null}
                                            <span className="text-sm font-semibold tracking-wide">
                                                {success
                                                    ? "Welcome back"
                                                    : submitting
                                                      ? "Signing In..."
                                                      : isRateLimited
                                                        ? `Try again in ${cooldownSeconds}s`
                                                        : "Sign In"}
                                            </span>
                                        </Button>
                                    </motion.div>
                                </motion.div>
                            </form>

                            {oidcEnabled && (
                                // Decoupled from the container's stagger on purpose: oidcEnabled
                                // resolves asynchronously (after the /auth/config fetch), so this
                                // block mounts AFTER the form. Given its own initial/animate + a
                                // delay, it fades in as the last element to settle instead of
                                // popping in ahead of the still-animating form fields above it.
                                <motion.div
                                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.32, delay: reduceMotion ? 0 : 0.7, ease: [0.22, 1, 0.36, 1] }}
                                    className="space-y-6"
                                >
                                    <div className="flex items-center gap-3" aria-hidden="true">
                                        <span className="h-px flex-1 bg-white/10" />
                                        <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">or</span>
                                        <span className="h-px flex-1 bg-white/10" />
                                    </div>

                                    <motion.div
                                        whileHover={reduceMotion ? undefined : { scale: 1.02 }}
                                        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                                        transition={{ duration: 0.18, ease: "easeOut" }}
                                    >
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => beginEntraLogin({ park: addAccountMode })}
                                            className="flex h-12 w-full items-center justify-center gap-3 rounded-xl !border-white/12 !bg-white/[0.04] text-white transition-colors hover:!bg-white/[0.08] hover:!text-white focus-visible:ring-2 focus-visible:ring-[#d0b0ff]/40"
                                        >
                                            <MicrosoftLogo className="h-[18px] w-[18px]" />
                                            <span className="text-sm font-semibold tracking-wide">Sign in with Microsoft</span>
                                        </Button>
                                    </motion.div>
                                </motion.div>
                            )}

                            <motion.div variants={itemVariants} className="text-center text-xs text-white/55">
                                Don't have access yet?{" "}
                                <button type="button" className="font-semibold text-[#d0b0ff] underline-offset-4 transition-colors hover:text-white">
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
