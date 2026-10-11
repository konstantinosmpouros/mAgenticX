import { useCallback, useRef, type MouseEvent, type PointerEvent } from "react";

/**
 * Handlers for a Radix DropdownMenu trigger so a finger opens the menu on the
 * tap's click instead of on pointerdown.
 *
 * Why: Radix opens on pointerdown, before the tap is over. The modal menu then
 * switches pointer events off for everything outside it, so the click the tap
 * still owes lands on whatever beneath the finger takes events — through the
 * mobile sidebar sheet onto the composer, which re-enables them for itself.
 * One tap on the avatar also opened (or fired) the context ring. Opening on
 * the click means the tap is finished before the menu exists.
 *
 * The menus must stay modal: the mobile sheet's Radix Dialog and the menus
 * resolve different copies of Radix's focus-scope / dismissable-layer, so the
 * sheet's focus trap never pauses for a menu and pulls focus straight back
 * into the sheet. A modal menu ignores that focus change; a non-modal one
 * reads it as "focus left" and closes before it is seen.
 *
 * A mouse keeps Radix's own pointerdown behaviour, and the keyboard keeps its
 * Enter/Space handling.
 *
 * Returns a factory rather than the handlers so one hook serves every row of
 * a list (hooks cannot be called inside a map); the rows share one ref, which
 * is safe because only one tap is in flight at a time.
 */
export function useTouchMenuTrigger() {
  const fingerRef = useRef(false);

  return useCallback(
    (toggle: () => void) => ({
      onPointerDown: (event: PointerEvent) => {
        fingerRef.current = event.pointerType !== "mouse";
        // composeEventHandlers skips Radix's own handler once this is set.
        if (fingerRef.current) event.preventDefault();
      },
      onClick: (event: MouseEvent) => {
        const fromFinger = fingerRef.current;
        fingerRef.current = false;
        // detail 0 is a keyboard-generated click: Radix already opened on keydown.
        if (fromFinger && event.detail !== 0) toggle();
      },
    }),
    [],
  );
}
