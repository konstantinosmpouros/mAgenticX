import { useTheme } from "next-themes";
import { MoonStar, Sparkles } from "lucide-react";

import { cn, fmtBoolean } from "@/shared/lib/utils";
import type { UserPreferences } from "@/shared/lib/types";
import { InfoCard, PrefToggleRow, SoftPanel } from "./shared";
import { ComingSoonRow } from "./ComingSoon";

/**
 * GeneralTab — the workspace-wide basics, mirroring ChatGPT's "General"
 * section: appearance/theme first, then the chat-experience toggles, then the
 * fields we mirror from ChatGPT but have not built yet (stub rows).
 */
const themeOptions = [
  {
    name: "Light",
    value: "light",
    icon: Sparkles,
    previewClassName:
      "bg-[linear-gradient(135deg,hsl(0_0%_100%)_0%,hsl(240_4.8%_95.9%)_52%,hsl(216_50%_92%)_100%)]",
    cardClassName: "border-white/70 bg-white/80",
  },
  {
    name: "Dark",
    value: "dark",
    icon: MoonStar,
    previewClassName:
      "bg-[linear-gradient(135deg,hsl(240_6%_6%)_0%,hsl(240_8%_10%)_55%,hsl(216_100%_8%)_100%)]",
    cardClassName: "border-white/10 bg-black/20",
  },
] as const;

type GeneralTabProps = {
  userPreferences: UserPreferences;
  preferencesSaving?: boolean;
  onToggleSuggestionsEnabled?: () => void;
  onToggleMessageTokenUsage?: () => void;
};

export default function GeneralTab({
  userPreferences,
  preferencesSaving = false,
  onToggleSuggestionsEnabled,
  onToggleMessageTokenUsage,
}: GeneralTabProps) {
  const { theme, setTheme } = useTheme();
  const currentTheme = theme === "dark" ? "dark" : "light";

  const suggestionsEnabled = userPreferences?.suggestionsEnabled !== false;
  const showMessageTokenUsage = userPreferences?.showMessageTokenUsage === true;
  const prefersAgentic =
    typeof userPreferences?.prefersAgenticChat === "boolean"
      ? userPreferences.prefersAgenticChat
      : undefined;

  return (
    <div className="space-y-8">
      <InfoCard
        eyebrow="Appearance"
        title="Theme"
        description="Choose how the workspace looks. The setting applies immediately and persists on this device."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {themeOptions.map((themeOption) => {
            const Icon = themeOption.icon;
            const isActive = currentTheme === themeOption.value;

            return (
              <button
                key={themeOption.value}
                type="button"
                onClick={() => setTheme(themeOption.value)}
                className={cn(
                  "rounded-[1.5rem] p-4 text-left transition-colors",
                  isActive ? "bg-primary/10" : "bg-muted/30 hover:bg-muted/45",
                )}
              >
                <div className={cn("h-28 rounded-[1.2rem] p-4", themeOption.cardClassName)}>
                  <div
                    className={cn(
                      "flex h-full flex-col justify-between",
                      themeOption.previewClassName,
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-full bg-primary/70" />
                      <div className="h-2 w-16 rounded-full bg-black/10 dark:bg-white/10" />
                    </div>
                    <div className="grid gap-2">
                      <div className="h-3 rounded-full bg-black/10 dark:bg-white/10" />
                      <div className="h-3 w-4/5 rounded-full bg-black/10 dark:bg-white/10" />
                      <div className="h-8 w-28 rounded-2xl bg-primary/70" />
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{themeOption.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {isActive ? "Currently applied" : "Switch workspace theme"}
                    </p>
                  </div>
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-2xl bg-black/10 text-muted-foreground dark:bg-white/[0.04]",
                      isActive && "bg-primary/12 text-primary",
                    )}
                  >
                    <Icon size={18} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </InfoCard>

      <InfoCard
        eyebrow="Chat"
        title="Chat experience"
        description="Defaults that shape every conversation in the workspace."
      >
        <SoftPanel className="divide-y divide-border/40 overflow-hidden">
          <PrefToggleRow
            title="Follow-up suggestions"
            description="Show personalized starter prompts below the composer on new chats."
            checked={suggestionsEnabled}
            disabled={preferencesSaving}
            onToggle={onToggleSuggestionsEnabled}
          />
          <PrefToggleRow
            title="Per-message token usage"
            description="Show how many input and output tokens each assistant message used, in its action bar."
            checked={showMessageTokenUsage}
            disabled={preferencesSaving}
            onToggle={onToggleMessageTokenUsage}
          />
          <div className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Agentic chat</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Whether this profile prefers the agentic chat experience.
                </p>
              </div>
              <span className="inline-flex rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {fmtBoolean(prefersAgentic)}
              </span>
            </div>
          </div>
        </SoftPanel>
      </InfoCard>

      <InfoCard
        eyebrow="Planned"
        title="More general settings"
        description="Mirrored from the target settings layout — these land here once implemented."
      >
        <SoftPanel className="divide-y divide-border/40 overflow-hidden">
          <ComingSoonRow
            title="Accent color"
            description="Pick the accent color used across buttons and highlights."
          />
          <ComingSoonRow
            title="Language"
            description="Override the interface language instead of auto-detecting it."
          />
          <ComingSoonRow
            title="Dictation preference"
            description="Enable or disable the microphone dictation button in the composer."
          />
        </SoftPanel>
      </InfoCard>
    </div>
  );
}
