import { FormEvent, memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { VscEye, VscEyeClosed } from "react-icons/vsc";
import Galaxy from "@/components/ui/react_bits/bg_galaxy";
import { authenticate, restoreSession } from "@/lib/api";
import { loadSession, saveSession, updateSession } from "@/lib/authStorage";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { AuthApiError } from "@/lib/types";

const GalaxyBg = memo(
    () => (
        <div className="absolute inset-0 -z-10 pointer-events-none">
            <Galaxy
                mouseRepulsion={true}
                mouseInteraction={false}
                density={1.1}
                glowIntensity={0.18}
                saturation={0.08}
                hueShift={185}
                twinkleIntensity={0.22}
                rotationSpeed={0.05}
                autoCenterRepulsion={0}
                starSpeed={0.4}
                transparent={false}
            />
        </div>
    ),
    () => true
);

export default function Login() {
    const navigate = useNavigate();
    const { toast } = useToast();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [authStatus, setAuthStatus] = useState<"idle" | "rate_limited">("idle");
    const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
    const [cooldownSeconds, setCooldownSeconds] = useState(0);

    const isRateLimited = rateLimitedUntil !== null && cooldownSeconds > 0;

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

    const statusToneClasses =
        statusConfig?.tone === "warning" ? "text-amber-100/85" : "text-white/72";

    const dotToneClasses =
        statusConfig?.tone === "warning"
            ? "bg-amber-300/85 shadow-[0_0_18px_rgba(252,211,77,0.45)]"
            : "bg-white/70";

    const chipToneClasses =
        statusConfig?.tone === "warning"
            ? "border-amber-200/30 bg-amber-200/10 text-amber-50/90"
            : "border-rose-200/25 bg-rose-200/10 text-rose-50/85";

    useEffect(() => {
        let cancelled = false;
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
    }, [navigate]);

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (submitting || isRateLimited) return;
        setSubmitting(true);
        try {
            setAuthStatus("idle");
            const response = await authenticate({ username: username.trim(), password });
            if (response.authenticated && response.user && response.user.id) {
                const ttlSeconds =
                    typeof response.tokenTtl === "number" && response.tokenTtl > 0 ? response.tokenTtl : 3600;
                saveSession(response.user, ttlSeconds * 1000);
                setUsername("");
                setPassword("");
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
            <GalaxyBg />
            <Card className="relative w-full max-w-[min(92vw,30rem)] overflow-hidden rounded-[32px] border border-white/12 bg-gradient-to-br from-[#232b3d]/85 via-[#161c2b]/92 to-[#0f1422]/94 px-6 py-8 shadow-[0_28px_80px_-32px_rgba(7,9,14,0.85)] backdrop-blur-2xl sm:px-10 sm:py-12">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.22)_0%,_rgba(16,22,33,0)_68%)] opacity-75" aria-hidden="true" />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_bottom,_rgba(211,164,255,0.16)_0%,_rgba(12,18,28,0)_70%)] opacity-60 mix-blend-lighten" aria-hidden="true" />
                <div className="pointer-events-none absolute inset-x-14 bottom-[-4rem] h-44 rounded-full bg-white/12 blur-[110px]" aria-hidden="true" />

                <div className="relative z-10 flex flex-col gap-10 text-white">
                    <header className="flex flex-col items-center gap-5 text-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/25 bg-gradient-to-br from-white/25 via-white/12 to-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]">
                            <img src="/logo2.png" alt="mAgenticX mark" className="h-10 w-10 object-contain" />
                        </div>
                        <div className="space-y-2">
                            <h1 className="bg-gradient-to-r from-white via-white to-[#f1d6ff] bg-clip-text text-xl font-semibold tracking-tight text-transparent sm:text-2xl">
                                Sign in to mAgenticX
                            </h1>
                            <p className="text-sm text-white/72">
                                Enter your workspace credentials to continue.
                            </p>
                            {statusConfig && (
                                <div className="relative mx-auto w-fit">
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
                            )}
                            <div className="mx-auto h-px w-14 rounded-full bg-gradient-to-r from-transparent via-[#dba9ff]/70 to-transparent" />
                        </div>
                    </header>

                    <div className="space-y-8 text-white">
                        <form className="space-y-6" onSubmit={handleSubmit}>
                            <div className="space-y-2">
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
                                    className="h-12 rounded-xl !border-white/18 !bg-[#3b3b3b] text-sm text-white placeholder:text-white/45 focus:border-[#e1c6ff]/55 focus:ring-[#e1c6ff]/30"
                                />
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="login-password" className="text-xs font-semibold uppercase tracking-[0.2em] text-white/65">
                                    Password
                                </label>
                                <div className="relative">
                                    <Input
                                        id="login-password"
                                        type={showPassword ? "text" : "password"}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="Your password"
                                        autoComplete="current-password"
                                        className="h-12 rounded-xl !border-white/18 !bg-[#3b3b3b] pr-12 text-sm text-white placeholder:text-white/45 focus:border-[#e1c6ff]/55 focus:ring-[#e1c6ff]/30"
                                    />
                                    {password.trim() && (
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/65 transition-colors hover:text-white/85"
                                            aria-label={showPassword ? "Hide password" : "Show password"}
                                        >
                                            {showPassword ? <VscEyeClosed size={18} /> : <VscEye size={18} />}
                                        </button>
                                    )}
                                </div>
                            </div>

                            <Button
                                type="submit"
                                disabled={submitting || isRateLimited}
                                className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-white via-white/94 to-white/88 text-slate-900 shadow-[0_18px_40px_-28px_rgba(187, 31, 102,0.9)] transition hover:from-white/95 hover:via-white/92 hover:to-white/85 focus-visible:ring-[#dfb7ff]/35 disabled:cursor-not-allowed disabled:opacity-80"
                            >
                                <span className="text-sm font-semibold tracking-wide">
                                    {submitting ? "Signing In..." : isRateLimited ? `Try again in ${cooldownSeconds}s` : "Sign In"}
                                </span>
                            </Button>
                        </form>

                        <div className="text-center text-xs text-white/55">
                            Don't have access yet?{" "}
                            <button type="button" className="font-semibold text-[#d0b0ff] underline-offset-4 transition hover:text-white">
                                Request to sign up
                            </button>
                        </div>
                    </div>
                </div>
            </Card>
        </div>
    );
}
