import * as React from "react";

import { useSidebar } from "@/shared/ui/sidebar";

/**
 * Focus mode for a canvas page (the workflow builder): while the page is
 * mounted the app sidebar starts collapsed, so the canvas gets the width. It
 * stays toggleable from the rail; on leave it opens again if the user had it
 * open when they came in (and has not reopened it since). Desktop only — on
 * a phone the sidebar is a sheet that is shut anyway.
 */
export function useSidebarFocusMode() {
  const { open, setOpen, isMobile } = useSidebar();
  const latest = React.useRef({ open, setOpen });
  latest.current = { open, setOpen };

  React.useEffect(() => {
    if (isMobile) return;
    const box = latest;
    if (!box.current.open) return;
    box.current.setOpen(false);
    return () => {
      if (!box.current.open) box.current.setOpen(true);
    };
  }, [isMobile]);
}
