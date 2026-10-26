import { useEffect, useState } from "react";

import { getAgentModels, getBuiltinTools, getTools } from "@/shared/lib/api";
import type { AgentModelOption, BuiltinToolInfo, ToolMetadata } from "@/shared/lib/types";
import { MODEL_CHOICES } from "@/features/agents/lib/agentSpec";

export type AgentCatalogs = {
  /** The models an agent may run on; the fallback list until (or unless) the server's loads. */
  models: AgentModelOption[];
  /** The model a new agent starts on. */
  defaultModel: string;
  /** Every built-in tool with its approval rules; empty when the bridge predates the route. */
  builtins: BuiltinToolInfo[];
  /** The MCP gateway's tools; empty when it is down or has no servers. */
  tools: ToolMetadata[];
  /** False until all three answered (or failed). */
  loaded: boolean;
  /** False until the models answered (or failed) — what a new agent waits for. */
  modelsLoaded: boolean;
  /** True when the models could not be read and the list is the fallback. */
  modelsFallback: boolean;
};

const FALLBACK_MODELS: AgentModelOption[] = MODEL_CHOICES.map((m, index) => ({
  id: m.id,
  label: m.label,
  default: index === 1,
}));

/**
 * What the builder offers to pick from, read from the server rather than kept
 * in the UI (plan 44 §0, decision 3). Each read fails quietly: the builder
 * explains an empty list where it shows one, and the server re-checks every
 * save anyway.
 */
export function useAgentCatalogs(): AgentCatalogs {
  const [state, setState] = useState<AgentCatalogs>({
    models: FALLBACK_MODELS,
    defaultModel: FALLBACK_MODELS[1].id,
    builtins: [],
    tools: [],
    loaded: false,
    modelsLoaded: false,
    modelsFallback: true,
  });

  useEffect(() => {
    let cancelled = false;
    // The models come in on their own: a new agent waits for its default
    // model, not for the MCP gateway's (slower) tool list.
    const models = getAgentModels()
      .then((list) => {
        if (cancelled || !list.length) return;
        setState((prev) => ({
          ...prev,
          models: list,
          defaultModel: (list.find((m) => m.default) ?? list[0]).id,
          modelsLoaded: true,
          modelsFallback: false,
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setState((prev) => ({ ...prev, modelsLoaded: true }));
      });
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
  }, []);

  return state;
}
