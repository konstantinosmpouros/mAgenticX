import { useMemo } from 'react';
import { updateUserPreferences } from '@/lib/api';
import type { ToolMetadata, ToolPreference, UserPreferences } from '@/lib/types';
import { DEFAULT_READ_ALOUD_VOICE, type ReadAloudVoice } from '@/lib/consts';
import { normalizeReadAloudVoice } from '@/lib/utils';

// Preferences handlers derive the tool toggle model shown in settings and persist changes optimistically.
type ToastFn = (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

export type PreferencesHandlers = {
  toolsWithStatus: (ToolMetadata & { enabled: boolean })[];
  enabledToolsForRequest: ToolPreference[];
  resolvedPreferences: UserPreferences;
  handleToggleToolPreference: (tool: ToolMetadata) => Promise<void>;
  handleToggleSuggestionsEnabled: () => Promise<void>;
  handleSelectReadAloudVoice: (voice: ReadAloudVoice) => Promise<void>;
};

type PreferencesCtx = {
  userId: string | null;
  availableTools: ToolMetadata[];
  userPreferences: UserPreferences | null;
  setUserPreferences: (v: UserPreferences | null) => void;
  isSavingPreferences: boolean;
  setIsSavingPreferences: (v: boolean) => void;
  toast: ToastFn;
  persistUIState: () => void;
};

export function usePreferencesHandlers(ctx: PreferencesCtx): PreferencesHandlers {
  const {
    userId,
    availableTools,
    userPreferences,
    setUserPreferences,
    setIsSavingPreferences,
    toast,
    persistUIState,
  } = ctx;

  const defaultPreferences: UserPreferences = useMemo(
    // Keep downstream code simple by always resolving a complete preference object.
    () => ({ tools: { disabled: [] }, prefersAgenticChat: false, suggestionsEnabled: true, readAloudVoice: DEFAULT_READ_ALOUD_VOICE }),
    []
  );
  const resolvedPreferences = {
    ...defaultPreferences,
    ...(userPreferences ?? {}),
    tools: userPreferences?.tools ?? defaultPreferences.tools,
    readAloudVoice: normalizeReadAloudVoice(userPreferences?.readAloudVoice),
  };

  const toolKey = (serverId: string | undefined, toolName: string) => `${serverId || 'default'}::${toolName}`;

  const disabledToolKeys = useMemo(() => {
    // Normalize old and new field names so stored preferences remain backward compatible.
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
    // Combine tool metadata with preference state so the UI can render a single enriched list.
    () =>
      availableTools.map((tool) => ({
        ...tool,
        enabled: !disabledToolKeys.has(toolKey(tool.serverId, tool.toolName)),
      })),
    [availableTools, disabledToolKeys]
  );

  const enabledToolsForRequest: ToolPreference[] = useMemo(
    // Outbound inference requests only need the enabled subset.
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
    // Flip the local set first so the toggle feels instant; revert on persistence failure.
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
      prefersAgenticChat: resolvedPreferences.prefersAgenticChat,
      suggestionsEnabled: resolvedPreferences.suggestionsEnabled !== false,
      readAloudVoice: normalizeReadAloudVoice(resolvedPreferences.readAloudVoice),
    };
    setUserPreferences(nextPrefs);
    setIsSavingPreferences(true);
    try {
      const saved = await updateUserPreferences(userId, nextPrefs);
      // Replace the optimistic snapshot with the canonical payload returned by the backend.
      setUserPreferences(saved);
      persistUIState();
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

  const handleToggleSuggestionsEnabled = async () => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const prevPrefs = resolvedPreferences;
    const nextPrefs: UserPreferences = {
      tools: resolvedPreferences.tools ?? { disabled: [] },
      prefersAgenticChat: resolvedPreferences.prefersAgenticChat,
      suggestionsEnabled: !(resolvedPreferences.suggestionsEnabled !== false),
      readAloudVoice: normalizeReadAloudVoice(resolvedPreferences.readAloudVoice),
    };
    setUserPreferences(nextPrefs);
    setIsSavingPreferences(true);
    try {
      const saved = await updateUserPreferences(userId, nextPrefs);
      setUserPreferences(saved);
      persistUIState();
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

  const handleSelectReadAloudVoice = async (voice: ReadAloudVoice) => {
    if (!userId) {
      toast({ title: 'Authentication required', description: 'Please sign in again.', variant: 'destructive' });
      return;
    }
    const nextVoice = normalizeReadAloudVoice(voice);
    if (nextVoice === normalizeReadAloudVoice(resolvedPreferences.readAloudVoice)) return;

    const prevPrefs = resolvedPreferences;
    const nextPrefs: UserPreferences = {
      tools: resolvedPreferences.tools ?? { disabled: [] },
      prefersAgenticChat: resolvedPreferences.prefersAgenticChat,
      suggestionsEnabled: resolvedPreferences.suggestionsEnabled !== false,
      readAloudVoice: nextVoice,
    };
    setUserPreferences(nextPrefs);
    setIsSavingPreferences(true);
    try {
      const saved = await updateUserPreferences(userId, nextPrefs);
      setUserPreferences(saved);
      persistUIState();
    } catch (error) {
      setUserPreferences(prevPrefs);
      toast({
        title: 'Could not update voice',
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
    handleToggleSuggestionsEnabled,
    handleSelectReadAloudVoice,
  };
}
