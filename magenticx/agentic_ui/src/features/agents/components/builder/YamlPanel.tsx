import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Loader2, RotateCw } from "lucide-react";

import { renderMyAgentYaml } from "@/shared/lib/api";
import type { AgentModelOption, BuiltinToolInfo, CustomAgentWritePayload } from "@/shared/lib/types";
import { SidePanel } from "./SidePanel";
import { YamlCode } from "./YamlCode";
import { YamlHelp, YamlHelpButton } from "./YamlHelp";
import { CopyButton } from "./CopyButton";
import { SMALL_BUTTON } from "./inspector/fields";

const RENDER_DELAY_MS = 400;

/**
 * The builder's YAML view: the draft as `agent.yaml`, read-only, re-rendered
 * by the server as the draft changes (it stays open beside the canvas), with
 * Copy and — for a saved agent — Download .zip, the saved version's export.
 * "How to write an agent.yaml" swaps the panel to the help and back.
 */
export function YamlPanel({
  open,
  onOpenChange,
  userId,
  payload,
  models,
  builtins,
  onDownloadZip,
  downloading,
  dirty,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string | null;
  payload: CustomAgentWritePayload;
  models: AgentModelOption[];
  builtins: BuiltinToolInfo[];
  /** Only for a saved agent; null on a new one. */
  onDownloadZip: (() => void) | null;
  downloading: boolean;
  /** Unsaved changes: the .zip is the saved version, not this one. */
  dirty: boolean;
}) {
  const [view, setView] = useState<"yaml" | "help">("yaml");
  const [yaml, setYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    if (!open || !userId) return;
    const mine = ++sequence.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      renderMyAgentYaml(userId, payload)
        .then((text) => {
          if (mine !== sequence.current) return;
          setYaml(text);
          setError(null);
        })
        .catch((err: unknown) => {
          if (mine !== sequence.current) return;
          setError(err instanceof Error ? err.message : "The YAML could not be shown.");
        })
        .finally(() => {
          if (mine === sequence.current) setLoading(false);
        });
    }, yaml === null ? 0 : RENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `yaml` only decides the first render's delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId, payload, attempt]);

  useEffect(() => {
    if (!open) setView("yaml");
  }, [open]);

  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      wide={view === "help"}
      title={view === "yaml" ? "agent.yaml" : "How to write an agent.yaml"}
      description={
        view === "yaml"
          ? "This agent as YAML, kept up to date as you build. Read-only: to change it, edit on the canvas, or import a YAML."
          : "Fields, rules and an example to start from."
      }
      actions={
        view === "yaml" ? (
          <>
            {loading && yaml !== null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Updating" />
            ) : null}
          </>
        ) : null
      }
    >
      {view === "help" ? (
        <div className="flex flex-col gap-4">
          <button type="button" className={`${SMALL_BUTTON} w-fit`} onClick={() => setView("yaml")}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to agent.yaml
          </button>
          <YamlHelp models={models} builtins={builtins} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={yaml ?? ""} disabled={!yaml} />
            {onDownloadZip ? (
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={onDownloadZip}
                disabled={downloading}
                title={dirty ? "The saved version, without your unsaved changes" : undefined}
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden />
                )}
                {dirty ? "Download saved .zip" : "Download .zip"}
              </button>
            ) : null}
            <YamlHelpButton onClick={() => setView("help")} className="ml-auto" />
          </div>
          {error && yaml === null ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
              <p className="text-xs text-muted-foreground">{error}</p>
              <button type="button" className={SMALL_BUTTON} onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again
              </button>
            </div>
          ) : yaml === null ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground" aria-busy="true">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            </div>
          ) : (
            <YamlCode text={yaml} />
          )}
          {onDownloadZip ? null : (
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Its prompts are saved beside it as AGENT.md and subagents/*.md. Once the agent is
              created you can download it all as a .zip that imports back unchanged.
            </p>
          )}
        </div>
      )}
    </SidePanel>
  );
}
