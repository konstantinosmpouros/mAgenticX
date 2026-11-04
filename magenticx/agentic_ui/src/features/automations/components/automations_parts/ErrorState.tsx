import { CircleAlert, RotateCw } from "lucide-react";

import { SECONDARY_BUTTON } from "@/features/automations/lib/styles";

/** The list could not load and there is nothing cached to show instead. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex min-h-[18rem] flex-col items-center justify-center gap-4 px-6 text-center"
      role="alert"
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-destructive/10 text-destructive">
        <CircleAlert className="h-5 w-5" aria-hidden />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-semibold text-foreground">{message}</p>
        <p className="text-sm text-muted-foreground">
          Check your connection — the list refreshes on its own.
        </p>
      </div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className={SECONDARY_BUTTON}>
          <RotateCw className="h-4 w-4" aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}
