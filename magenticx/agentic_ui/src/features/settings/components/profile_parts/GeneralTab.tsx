import { useTheme } from "next-themes";
import { Check } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { UserPreferences } from "@/shared/lib/types";
import { THEMES, themeFor } from "@/styles/theme/themes";
import { BrandLogo } from "@/shared/ui/brand-logo";
import { InfoCard, PrefToggleRow, SoftPanel } from "./shared";
import { ComingSoonRow } from "./ComingSoon";

/**
 * GeneralTab — the workspace-wide basics, mirroring ChatGPT's "General"
 * section: appearance/theme first, then the chat-experience toggles, then the
 * fields we mirror from ChatGPT but have not built yet (stub rows). The theme
 * cards come from the theme registry (src/styles/theme/themes.ts).
 */

type ThemeChoice = {
  id: string;
  label: string;
  description: string;
  dark: boolean;
  /** The card's preview: the theme's background lit by two of its swatches. */
  background: string;
  swatches: string[];
};

const swatch = (id: string, n: number, alpha?: number) =>
  `hsl(var(--${id}-${n})${alpha === undefined ? "" : ` / ${alpha}`})`;

const THEME_CHOICES: ThemeChoice[] = THEMES.map((theme) => ({
  id: theme.id,
  label: theme.label,
  description: theme.description,
  dark: theme.mode === "dark",
  background: [
    `radial-gradient(circle at 78% 22%, ${swatch(theme.id, 3, 0.35)}, transparent 55%)`,
    `radial-gradient(circle at 18% 88%, ${swatch(theme.id, 1, 0.28)}, transparent 50%)`,
    theme.preview.background,
  ].join(", "),
  swatches: [1, 2, 3, 4].map((n) => swatch(theme.id, n)),
}));

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
  // A legacy "light"/"dark" marks the theme it maps to.
  const { theme, setTheme } = useTheme();
  const selected = themeFor(theme).id;

  const suggestionsEnabled = userPreferences?.suggestionsEnabled !== false;
  const showMessageTokenUsage = userPreferences?.showMessageTokenUsage === true;

  return (
    <div className="space-y-8">
      <InfoCard
        eyebrow="Appearance"
        title="Theme"
        description="Choose the workspace theme. It applies immediately and is remembered on this device."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {THEME_CHOICES.map((choice) => {
            const isActive = selected === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                onClick={() => setTheme(choice.id)}
                aria-pressed={isActive}
                className={cn(
                  // A column, so the preview sits at the top whatever the tagline's length.
                  "group flex flex-col rounded-[1.6rem] border p-2 text-left transition-[transform,box-shadow,border-color,background-color] duration-200",
                  "motion-safe:supports-[hover:hover]:hover:-translate-y-0.5",
                  isActive
                    ? "border-primary/50 bg-primary/[0.06] shadow-lg shadow-primary/10"
                    : "border-border/60 bg-card supports-[hover:hover]:hover:border-border supports-[hover:hover]:hover:shadow-md",
                )}
              >
                {/* The theme's own background, lit by its palette, with the logo it gets. */}
                <div
                  className="relative flex h-36 items-center justify-center overflow-hidden rounded-[1.2rem]"
                  style={{ background: choice.background }}
                >
                  <BrandLogo
                    theme={choice.id}
                    className="h-14 w-auto max-w-[60%] transition-transform duration-300 motion-safe:supports-[hover:hover]:group-hover:scale-105"
                  />
                  <div
                    className={cn(
                      "absolute bottom-3 right-3 flex gap-1 rounded-full p-1 shadow-sm backdrop-blur-sm",
                      choice.dark ? "bg-white/10" : "bg-white/70",
                    )}
                  >
                    {choice.swatches.map((color) => (
                      <span
                        key={color}
                        className="size-3 rounded-full ring-1 ring-black/5"
                        style={{ background: color }}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-start justify-between gap-3 px-2 pb-1.5 pt-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{choice.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{choice.description}</p>
                  </div>
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full transition-all duration-200",
                      isActive ? "scale-100 bg-primary text-primary-foreground" : "scale-75 opacity-0",
                    )}
                    aria-hidden
                  >
                    <Check size={14} />
                  </span>
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
        </SoftPanel>
      </InfoCard>

      <InfoCard
        eyebrow="Planned"
        title="More general settings"
        description="Mirrored from the target settings layout — these land here once implemented."
      >
        <SoftPanel className="divide-y divide-border/40 overflow-hidden">
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
