/**
 * Give focus back to a menu's trigger only when the menu was used from the
 * keyboard.
 *
 * Radix menus, popovers and selects move focus back to their trigger when they
 * close. That is right for a keyboard user — they continue from where they were
 * — but after a mouse or touch close it leaves the trigger focused: its focus
 * styling and its tooltip come back, and it looks stuck "hovered" until the
 * user clicks somewhere else that takes focus. Passing this as a content's
 * `onCloseAutoFocus` keeps the keyboard behaviour and skips the hand-back after
 * a pointer close.
 *
 * The last input kind is tracked once for the whole page, in the capture phase
 * so nothing that stops propagation can hide it from us.
 */

type InputKind = "keyboard" | "pointer";

let lastInput: InputKind = "pointer";

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
  window.addEventListener(
    "keydown",
    (event) => {
      // A modifier on its own (Cmd+click, Ctrl+click) is still a pointer action.
      if (
        event.key !== "Meta" &&
        event.key !== "Control" &&
        event.key !== "Shift" &&
        event.key !== "Alt"
      ) {
        lastInput = "keyboard";
      }
    },
    true,
  );
}

/** The kind of input the user last used. */
export function lastInputKind(): InputKind {
  return lastInput;
}

/** `onCloseAutoFocus` for Radix content: return focus only after keyboard use. */
export function returnFocusOnlyForKeyboard(event: Event): void {
  if (lastInput === "pointer") event.preventDefault();
}
