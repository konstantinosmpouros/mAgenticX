import { Link } from "react-router-dom";
import { AlertTriangle, Home, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

type ErrorPageProps = {
  error?: Error;
  onRetry?: () => void;
};

const ErrorPage = ({ error, onRetry }: ErrorPageProps) => {
  const handleRetry = () => {
    if (onRetry) {
      onRetry();
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-white to-indigo-50 text-slate-900 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 dark:text-slate-50">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-8rem] top-[-6rem] h-80 w-80 rounded-full bg-amber-400/25 blur-[110px] dark:bg-amber-500/20" />
        <div className="absolute bottom-[-10rem] right-[-5rem] h-80 w-80 rounded-full bg-indigo-400/25 blur-[120px] dark:bg-indigo-500/25" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_30%,rgba(255,255,255,0.6),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(99,102,241,0.22),transparent_38%)] dark:bg-[radial-gradient(circle_at_20%_30%,rgba(255,255,255,0.05),transparent_40%),radial-gradient(circle_at_80%_0%,rgba(59,130,246,0.25),transparent_45%)]" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
        <div className="w-full rounded-3xl border border-white/60 bg-white/70 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.65)] backdrop-blur-xl transition-slow dark:border-white/10 dark:bg-white/5 dark:shadow-[0_18px_80px_-36px_rgba(0,0,0,0.9)]">
          <div className="grid items-center gap-10 px-8 py-12 md:grid-cols-[1.05fr_0.95fr] md:px-12 md:py-14">
            <div className="space-y-6">
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Something went wrong</p>

              <div className="space-y-4">
                <div className="inline-flex items-center gap-3 rounded-full border border-white/60 bg-white/70 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10 dark:text-slate-100">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  mAgenticX hit an unexpected error
                </div>
                <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                  <span className="bg-gradient-to-r from-amber-500 via-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">
                    Crash detected
                  </span>{" "}
                  but your session is safe
                </h1>
                <p className="text-base text-slate-600 dark:text-slate-300">
                  The UI encountered a problem. You can retry to reload the session, or head back home while we keep the agents ready.
                </p>
                {error?.message && (
                  <div className="rounded-2xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 shadow-sm dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
                    <p className="font-semibold">Details</p>
                    <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">{error.message}</p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={handleRetry} className="shadow-[0_16px_40px_-24px_rgba(59,130,246,0.75)]">
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </Button>
                <Button
                  variant="secondary"
                  asChild
                  className="border border-slate-200/80 bg-white/80 text-slate-800 hover:bg-white dark:border-white/15 dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                >
                  <Link to="/">
                    <Home className="h-4 w-4" />
                    Go home
                  </Link>
                </Button>
              </div>
            </div>

            <div className="relative">
              <div
                className="absolute -inset-6 rounded-[28px] border border-white/60 bg-gradient-to-br from-amber-500/15 via-indigo-500/10 to-fuchsia-400/15 opacity-70 blur-3xl dark:border-white/10"
                aria-hidden="true"
              />
              <div className="relative overflow-hidden rounded-[24px] border border-white/50 bg-gradient-to-br from-white/80 via-white/70 to-white/55 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-2xl dark:border-white/10 dark:from-white/5 dark:via-white/5 dark:to-white/0">
                <div className="mb-5 flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <span>Recovery options</span>
                  <div className="flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500/15 via-indigo-500/15 to-fuchsia-400/20 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-amber-600 dark:text-amber-100">
                    <span className="mr-1 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_6px_rgba(52,211,153,0.15)]" />
                    Live
                  </div>
                </div>

                <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
                  <div className="flex items-center justify-between rounded-xl border border-white/60 bg-white/70 px-4 py-3 shadow-sm dark:border-white/10 dark:bg-white/5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 via-amber-400/15 to-rose-400/20 text-amber-600 dark:text-amber-200">
                        <RefreshCw className="h-5 w-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold">Restart the UI</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Reload the session and reconnect your agents.</p>
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={handleRetry} className="text-amber-600 hover:text-amber-700 dark:text-amber-200 dark:hover:text-amber-100">
                      Retry
                    </Button>
                  </div>

                  <Link
                    to="/architecture"
                    className="group flex items-center justify-between rounded-xl border border-white/60 bg-white/70 px-4 py-3 transition hover:-translate-y-0.5 hover:border-indigo-400/70 hover:shadow-lg hover:shadow-indigo-900/20 dark:border-white/10 dark:bg-white/5 dark:hover:border-indigo-300/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 via-fuchsia-500/15 to-cyan-400/20 text-indigo-500 dark:text-indigo-200">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold">Check the architecture</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Review system state before diving back in.</p>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-indigo-400 transition group-hover:translate-x-1 group-hover:text-indigo-500 dark:text-indigo-200">Open</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ErrorPage;
