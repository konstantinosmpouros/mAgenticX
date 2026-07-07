import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowLeft, Home, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();
  const attemptedPath = location.pathname || "/";

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-white to-indigo-50 text-slate-900 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900 dark:text-slate-50">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-8rem] top-[-6rem] h-80 w-80 rounded-full bg-fuchsia-400/25 blur-[110px] dark:bg-fuchsia-500/20" />
        <div className="absolute bottom-[-10rem] right-[-5rem] h-80 w-80 rounded-full bg-cyan-400/25 blur-[120px] dark:bg-indigo-500/25" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_25%,rgba(255,255,255,0.6),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(109,40,217,0.18),transparent_38%)] dark:bg-[radial-gradient(circle_at_25%_25%,rgba(255,255,255,0.05),transparent_40%),radial-gradient(circle_at_80%_0%,rgba(99,102,241,0.22),transparent_45%)]" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
        <div className="w-full rounded-3xl border border-white/60 bg-white/70 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.65)] backdrop-blur-xl transition-slow dark:border-white/10 dark:bg-white/5 dark:shadow-[0_18px_80px_-36px_rgba(0,0,0,0.9)]">
          <div className="grid items-center gap-10 px-8 py-12 md:grid-cols-[1.05fr_0.95fr] md:px-12 md:py-14">
            <div className="space-y-6">
              <p className="text-xs uppercase tracking-[0.28em] text-slate-500 dark:text-slate-400">Off the map</p>

              <div className="space-y-4">
                <div className="inline-flex items-center gap-3 rounded-full border border-white/60 bg-white/70 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10 dark:text-slate-100">
                  <Sparkles className="h-4 w-4 text-fuchsia-500" />
                  mAgenticX can't find this route
                </div>
                <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                  <span className="bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-amber-400 bg-clip-text text-transparent">404</span>{" "}
                  Page not found
                </h1>
                <p className="text-base text-slate-600 dark:text-slate-300">
                  We looked for{" "}
                  <span className="rounded-full border border-white/60 bg-white/80 px-2 py-1 text-sm font-semibold text-slate-800 shadow-sm dark:border-white/15 dark:bg-white/10 dark:text-slate-100">
                    {attemptedPath}
                  </span>{" "}
                  but it isn't part of this workspace. Continue from the home screen or jump into the docs.
                </p>
                <div className="inline-flex items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-4 py-3 text-xs font-semibold text-slate-600 shadow-sm dark:border-white/10 dark:bg-white/10 dark:text-slate-200">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_6px_rgba(52,211,153,0.18)]" />
                  <span>Always-on session, just one tap away.</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button asChild className="shadow-[0_16px_40px_-24px_rgba(79,70,229,0.75)]">
                  <Link to="/">
                    <Home className="h-4 w-4" />
                    Return home
                  </Link>
                </Button>
              </div>
            </div>

            <div className="relative">
              <div
                className="absolute -inset-6 rounded-[28px] border border-white/60 bg-gradient-to-br from-indigo-500/15 via-fuchsia-500/10 to-cyan-400/15 opacity-70 blur-3xl dark:border-white/10"
                aria-hidden="true"
              />
              <div className="relative overflow-hidden rounded-[24px] border border-white/50 bg-gradient-to-br from-white/80 via-white/70 to-white/55 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-2xl dark:border-white/10 dark:from-white/5 dark:via-white/5 dark:to-white/0">
                <div className="mb-5 flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <span>Quick redirects</span>
                  <div className="flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-500/15 via-fuchsia-500/15 to-orange-400/20 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-indigo-600 dark:text-fuchsia-100">
                    <span className="mr-1 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_6px_rgba(52,211,153,0.15)]" />
                    Live
                  </div>
                </div>

                <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
                  <Link
                    to="/"
                    className="group flex items-center justify-between rounded-xl border border-white/60 bg-white/70 px-4 py-3 transition hover:-translate-y-0.5 hover:border-indigo-400/70 hover:shadow-lg hover:shadow-indigo-900/20 dark:border-white/10 dark:bg-white/5 dark:hover:border-indigo-300/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 via-fuchsia-500/15 to-cyan-400/20 text-indigo-500 dark:text-fuchsia-200">
                        <Home className="h-5 w-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold">Back to chat</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Rejoin your agents and messages.</p>
                      </div>
                    </div>
                    <ArrowLeft className="h-4 w-4 text-indigo-400 transition group-hover:-translate-x-1 group-hover:text-indigo-500 dark:text-indigo-200" />
                  </Link>

                  <Link
                    to="/login"
                    className="group flex items-center justify-between rounded-xl border border-white/60 bg-white/70 px-4 py-3 transition hover:-translate-y-0.5 hover:border-fuchsia-300/70 hover:shadow-lg hover:shadow-fuchsia-900/15 dark:border-white/10 dark:bg-white/5 dark:hover:border-fuchsia-200/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500/20 via-pink-500/15 to-orange-400/15 text-fuchsia-500 dark:text-fuchsia-200">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold">Switch account</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Sign in again to refresh your session.</p>
                      </div>
                    </div>
                    <ArrowLeft className="h-4 w-4 text-fuchsia-400 transition group-hover:-translate-x-1 group-hover:text-fuchsia-500 dark:text-fuchsia-200" />
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

export default NotFound;
