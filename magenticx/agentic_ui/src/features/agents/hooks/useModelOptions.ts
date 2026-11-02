import { useEffect, useState } from "react";

import { getAgentModels } from "@/shared/lib/api";
import type { AgentModelOption } from "@/shared/lib/types";

// One read per page load, shared by every view that labels a model (the
// gallery, an agent's page): a successful list is kept, a failure is forgotten
// so the next view asks again.
let cached: Promise<AgentModelOption[]> | null = null;

const readModels = (): Promise<AgentModelOption[]> => {
  if (!cached) {
    cached = getAgentModels().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
};

/**
 * The server's models, for labelling a model id ("GPT-5" rather than
 * `openai:gpt-5`). Empty until the list loads, or if it can't be read — then
 * `modelLabel` falls back to the id without its provider prefix.
 */
export function useModelOptions(): AgentModelOption[] {
  const [models, setModels] = useState<AgentModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    readModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}
