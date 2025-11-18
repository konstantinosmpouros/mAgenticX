import { FormEvent, memo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { VscEye, VscEyeClosed } from "react-icons/vsc";
import Galaxy from "@/components/ui/react_bits/bg_galaxy";

type LoginPanelProps = {
    username: string;
    password: string;
    onUsernameChange: (v: string) => void;
    onPasswordChange: (v: string) => void;
    onSubmit: () => void;
};

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

export default function LoginPanel({
    username,
    password,
    onUsernameChange,
    onPasswordChange,
    onSubmit,
}: LoginPanelProps) {
    const [showPassword, setShowPassword] = useState(false);
    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
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
                                    onChange={(e) => onUsernameChange(e.target.value)}
                                    placeholder="Your username"
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
                                        onChange={(e) => onPasswordChange(e.target.value)}
                                        placeholder="Your password"
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
                                className="group flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-white via-white/94 to-white/88 text-slate-900 shadow-[0_18px_40px_-28px_rgba(187, 31, 102,0.9)] transition hover:from-white/95 hover:via-white/92 hover:to-white/85 focus-visible:ring-[#dfb7ff]/35"
                            >
                                <span className="text-sm font-semibold tracking-wide">Sign In</span>
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
