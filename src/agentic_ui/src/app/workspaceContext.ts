import { createContext, useContext } from "react";

import type { ChatWorkspace } from "@/app/useChatWorkspace";

/**
 * The route views' accessor for the workspace bundle.
 *
 * This is a React context, not a store slice, and that is deliberate. The
 * bundle is a per-render snapshot, so publishing it into the store meant
 * writing to an external store *during render* — zustand notifies listeners
 * synchronously, so ChatView/TasksView were force-updated from inside
 * WorkspaceShell's render pass. React answered that with a "Cannot update a
 * component while rendering a different component" warning and, because the
 * render-phase branch defers the forced update, every keystroke in the composer
 * cost two render+commit passes instead of one. The store slot also never
 * cleared on unmount, so this accessor returned a stale bundle instead of
 * throwing its guard.
 *
 * Context has none of those problems: it delivers the current render's value in
 * the same pass, and — importantly for this layout — a context update still
 * reaches consumers even though `<Outlet/>`'s element identity is owned by
 * `<Routes>` and would otherwise let React bail out of the subtree.
 *
 * It lives in `app/` rather than `shared/stores/` because it is typed by the
 * workspace bundle. Keeping it in `shared/` forced a `shared → pages` type
 * import, which inverts the one-way `pages → features → shared` rule; the
 * store itself is now free of any reference to the bundle.
 */
const ChatWorkspaceContext = createContext<ChatWorkspace | null>(null);

export const ChatWorkspaceProvider = ChatWorkspaceContext.Provider;

export function useChatWorkspaceContext(): ChatWorkspace {
  const workspace = useContext(ChatWorkspaceContext);
  if (!workspace) {
    throw new Error("useChatWorkspaceContext must be used within a WorkspaceShell.");
  }
  return workspace;
}
