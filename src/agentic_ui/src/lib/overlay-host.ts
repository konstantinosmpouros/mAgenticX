// Shared portal host for chat-scoped overlays (plan / subagent modals, etc.).
// The chat-area container in ChatPage stamps its DOM node with OVERLAY_HOST_ID
// so portaled modals can render *inside* it instead of at document.body. This
// keeps them visually scoped to the conversation pane — they no longer cover
// the sidebar or the page header.

export const OVERLAY_HOST_ID = "chat-overlay-host";

// Callers must gate the createPortal call on `typeof document !== "undefined"`.
// Inside the browser, the chat-area host is mounted by the time any overlay
// expands; fall back to `document.body` only if the host id is somehow absent.
export function resolveOverlayHost(): HTMLElement {
  return document.getElementById(OVERLAY_HOST_ID) ?? document.body;
}
