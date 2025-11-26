import { useMemo } from 'react';
import { updateUserPreferences } from '@/lib/api';
import type { ToolMetadata, ToolPreference, UserPreferences } from '@/lib/types';

type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type PreferencesHandlers = {
  toolsWithStatus: (ToolMetadata & { enabled: boolean })[];
  enabledToolsForRequest: ToolPreference[];
  resolvedPreferences: UserPreferences;
  handleToggleToolPreference: (tool: ToolMetadata) => Promise<void>;
};

type PreferencesCtx = {
  userId: string | null;
  availableTools: ToolMetadata[];
  userPreferences: UserPreferences | null;
  setUserPreferences: (v: UserPreferences | null) => void;
  isSavingPreferences: boolean;
  setIsSavingPreferences: (v: boolean) => void;
  toast: ToastFn;
};

export function createPreferencesHandlers(ctx: PreferencesCtx): PreferencesHandlers {
  const {
    userId,
    availableTools,
    userPreferences,
    setUserPreferences,
    isSavingPreferences,
    setIsSavingPreferences,
    toast,
  } = ctx;

  const defaultPreferences: UserPreferences = useMemo(() => ({ tools: { disabled: [] } }), []);
  const resolvedPreferences = userPreferences ?? defaultPreferences;

  const toolKey = (serverId: string | undefined, toolName: string) => `${serverId || 'default'}::${toolName}`;

  const disabledToolKeys = useMemo(() => {
    const entries = resolvedPreferences?.tools?.disabled ?? [];
    const keys = entries
      .map((item) => {
        const name = (item as any).toolName ?? (item as any).tool_name ?? '';
        const server = (item as any).serverId ?? (item as any).server_id ?? '';
        return toolKey(server, name);
      })
      .filter(Boolean);
    return new Set(keys);
  }, [resolvedPreferences]);

  const toolsWithStatus = useMemo(
    () =>
      availableTools.map((tool) => ({
        ...tool,
        enabled: !disabledToolKeys.has(toolKey(tool.serverId, tool.toolName)),
      })),
    [availableTools, disabledToolKeys]
  );

  const enabledToolsForRequest: ToolPreference[] = useMemo(
    () =>
      toolsWithStatus
        .filter((t) => t.enabled)
        .map((t) => ({
          serverId: t.serverId || '',
          toolName: t.toolName,
        })),
    [toolsWithStatus]
  );

  const handleToggleToolPreference = async (tool: ToolMetadata) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const key = toolKey(tool.serverId, tool.toolName);
    const prevPrefs = resolvedPreferences;
    const nextDisabled = new Set(disabledToolKeys);
    if (nextDisabled.has(key)) {
      nextDisabled.delete(key);
    } else {
      nextDisabled.add(key);
    }
    const nextPrefs: UserPreferences = {
      tools: {
        disabled: Array.from(nextDisabled).map((k) => {
          const [serverId, toolName] = k.split('::');
          return { serverId, toolName };
        }),
      },
    };
    setUserPreferences(nextPrefs);
    setIsSavingPreferences(true);
    try {
      const saved = await updateUserPreferences(userId, nextPrefs);
      setUserPreferences(saved);
    } catch (error) {
      setUserPreferences(prevPrefs);
      toast({
        title: 'Could not update preferences',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingPreferences(false);
    }
  };

  return {
    toolsWithStatus,
    enabledToolsForRequest,
    resolvedPreferences,
    handleToggleToolPreference,
  };
}
