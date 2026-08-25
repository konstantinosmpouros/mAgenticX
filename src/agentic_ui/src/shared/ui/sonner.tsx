import { useTheme } from "next-themes";
import { Toaster as SonnerToaster } from "sonner";

import { useIsMobile } from "@/shared/hooks/use-mobile";

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

/**
 * Toaster — the single toast portal for the app. Every toast is rendered as a
 * fully custom {@link ToastCard} via `toast.custom` (see shared/hooks/use-toast),
 * so this component only configures Sonner's *behaviour*: a collapsed stack that
 * folds and fans out on hover (`expand={false}` + `visibleToasts`), theme sync,
 * and placement — bottom-right on desktop, top-center on mobile so it never
 * covers the composer. Sonner handles stacking, swipe-to-dismiss, hover-pause of
 * the dismiss timer, and the ARIA live region.
 */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();
  const isMobile = useIsMobile();

  return (
    <SonnerToaster
      theme={theme as ToasterProps["theme"]}
      position={isMobile ? "top-center" : "bottom-right"}
      expand={false}
      visibleToasts={3}
      gap={12}
      offset={16}
      className="toaster group"
      {...props}
    />
  );
}
