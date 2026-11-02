import { useCallback, useEffect, useState } from "react";

import { getAgentModels, getBuiltinTools, getTools } from "@/shared/lib/api";
import type { AgentModelOption, BuiltinToolInfo, ToolMetadata } from "@/shared/lib/types";

export type AgentCatalogs = {
  /** The models an agent may run on, as the server lists them; empty until (or unless) it answers. */
  models: AgentModelOption[];
  /** The model a new agent starts on: the server's default, or "" when the list could not be read. */
  defaultModel: string;
  /** Every built-in tool with its approval rules; empty when the bridge predates the route. */
  builtins: BuiltinToolInfo[];
  /** The MCP gateway's tools; empty when it is down or has no servers. */
  tools: ToolMetadata[];
  /** False until all three answered (or failed). */
  loaded: boolean;
  /** False until the models answered (or failed) — what a new agent waits for. */
  modelsLoaded: boolean;
  /** True when the models could not be read (or came back empty). */
  modelsFailed: boolean;
  /** Read the models again, after a failure. */
  retryModels: () => void;
};

type CatalogState = Omit<AgentCatalogs, "retryModels">;

/**
 * What the builder offers to pick from, read from the server rather than kept
 * in the UI (plan 37 §0, decision 3). The models come only from the server: if
 * they can't be read the Model field says so and offers to try again, rather
 * than guessing a list that may have drifted from the allowlist. The tool
 * lists fail quietly: the builder explains an empty list where it shows one,
 * and the server re-checks every save anyway.
 */
export function useAgentCatalogs(): AgentCatalogs {
  const [state, setState] = useState<CatalogState>({
    models: [],
    defaultModel: "",
    builtins: [],
    tools: [],
    loaded: false,
    modelsLoaded: false,
    modelsFailed: false,
  });

  const loadModels = useCallback(async (isCancelled: () => boolean) => {
    try {
      const list = await getAgentModels();
      if (isCancelled()) return;
      setState((prev) =>
        list.length
          ? {
              ...prev,
              models: list,
              defaultModel: (list.find((m) => m.default) ?? list[0]).id,
              modelsLoaded: true,
              modelsFailed: false,
            }
          : { ...prev, modelsLoaded: true, modelsFailed: true },
      );
    } catch {
      if (!isCancelled()) setState((prev) => ({ ...prev, modelsLoaded: true, modelsFailed: true }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    // The models come in on their own: a new agent waits for its default
    // model, not for the MCP gateway's (slower) tool list.
    const models = loadModels(isCancelled);
    void Promise.allSettled([models, getBuiltinTools(), getTools()]).then(([, builtins, tools]) => {
      if (cancelled) return;
      setState((prev) => ({
        ...prev,
        builtins: builtins.status === "fulfilled" ? builtins.value : [],
        tools: tools.status === "fulfilled" ? tools.value : [],
        loaded: true,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  const retryModels = useCallback(() => {
    void loadModels(() => false);
  }, [loadModels]);

  return { ...state, retryModels };
}
