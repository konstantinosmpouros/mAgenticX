import { fireEvent } from "@testing-library/react";

/**
 * Type into a workflow template field (a contenteditable chip editor, not an
 * input, so `fireEvent.change` can't set it): replace its text and fire the
 * `input` event the editor reads, as a keystroke would.
 */
export function typeTemplate(field: HTMLElement, value: string) {
  field.textContent = value;
  fireEvent.input(field);
}

/** The template a field shows, as it serializes: text plus each chip's `{{path}}`. */
export function templateText(field: HTMLElement): string {
  let text = "";
  field.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) text += (child.textContent ?? "").split(String.fromCharCode(0x200b)).join("");
    else if (child instanceof HTMLElement && child.dataset.raw !== undefined) text += child.dataset.raw;
  });
  return text;
}
