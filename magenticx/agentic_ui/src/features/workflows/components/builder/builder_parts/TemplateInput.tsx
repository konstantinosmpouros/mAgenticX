/**
 * A template field as a chip editor. Custom on purpose: neither shadcn nor
 * Radix has a rich-text input, and the field must show `{{path}}`
 * placeholders as friendly, atomic chips (`Fetch page › Body`) while its value
 * stays the plain template string the engine reads.
 *
 * A contenteditable, uncontrolled inside: the DOM is redrawn from the value
 * only when the value from outside differs from the last one this field
 * emitted (so typing keeps its caret). Plain typing is left to the browser;
 * every other edit — Enter, paste, drop, an insert from the picker, deleting a chip — is made on the string and redrawn
 * (`lib/builder/templateDom`).
 */
import * as React from "react";

import { cn } from "@/shared/lib/utils";
import type { WorkflowTemplatePath } from "@/shared/lib/types";
import { INPUT, INPUT_SM } from "@/features/workflows/lib/builder/consts";
import {
  domMatches,
  offsetFromPoint,
  refSpans,
  refreshChipLabels,
  renderTemplateInto,
  selectionOffsets,
  serializeTemplateDom,
  setCaretOffset,
} from "@/features/workflows/lib/builder/templateDom";
import { describeTemplateRef } from "@/features/workflows/lib/builder/templates";

export type TemplateInputHandle = {
  /** Insert `text` (a `{{path}}`, or anything) at the caret, or where it last was. */
  insertText: (text: string) => void;
  focus: () => void;
};

export const TemplateInput = React.forwardRef<
  TemplateInputHandle,
  {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    onFocus?: () => void;
    paths: readonly WorkflowTemplatePath[];
    multiline?: boolean;
    small?: boolean;
    placeholder?: string;
    invalid?: boolean;
    describedBy?: string;
    ariaLabel?: string;
    mono?: boolean;
    maxLength?: number;
    className?: string;
  }
>(function TemplateInput(
  {
    id,
    value,
    onChange,
    onBlur,
    onFocus,
    paths,
    multiline = false,
    small = false,
    placeholder,
    invalid,
    describedBy,
    ariaLabel,
    mono = true,
    maxLength,
    className,
  },
  ref,
) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  /** The value the DOM shows (the last one drawn or emitted). */
  const shown = React.useRef<string | null>(null);
  /** The selection as value offsets, kept while the field is blurred (the picker's insert lands there). */
  const selection = React.useRef({ start: value.length, end: value.length });
  const composing = React.useRef(false);
  const describe = React.useCallback((path: string) => describeTemplateRef(path, paths), [paths]);
  const describeRef = React.useRef(describe);
  describeRef.current = describe;

  const setEmpty = (root: HTMLElement, next: string) => {
    root.dataset.empty = String(next.length === 0);
  };

  const draw = React.useCallback(
    (next: string, caret?: number) => {
      const root = rootRef.current;
      if (!root) return;
      renderTemplateInto(root, next, describeRef.current, multiline);
      shown.current = next;
      setEmpty(root, next);
      if (caret !== undefined) {
        selection.current = { start: caret, end: caret };
        if (root.ownerDocument.activeElement === root) setCaretOffset(root, caret);
      }
    },
    [multiline],
  );

  // An outside value (a load, an undo, a rename) is drawn; our own echo is not.
  React.useLayoutEffect(() => {
    if (value !== shown.current) {
      draw(value);
      selection.current = { start: value.length, end: value.length };
    }
  }, [value, draw]);

  // What the field may read changed (a step renamed, an input added): relabel the chips.
  React.useLayoutEffect(() => {
    if (rootRef.current) refreshChipLabels(rootRef.current, describe);
  }, [describe]);

  const emit = (next: string) => {
    shown.current = next;
    onChange(next);
  };

  /** Replace value[start, end) with `text`, redraw, caret after it. */
  const edit = (start: number, end: number, text: string) => {
    const current = shown.current ?? "";
    let insert = text.replace(/\r\n?/g, "\n");
    if (!multiline) insert = insert.replace(/\n+/g, " ");
    if (maxLength !== undefined) {
      const room = maxLength - (current.length - (end - start));
      if (room <= 0 && insert) return;
      insert = insert.slice(0, Math.max(0, room));
    }
    const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
    if (next === current) return;
    draw(next, start + insert.length);
    emit(next);
  };

  const currentSelection = () => {
    const root = rootRef.current;
    const live = root ? selectionOffsets(root) : null;
    if (live) selection.current = live;
    return selection.current;
  };

  React.useImperativeHandle(
    ref,
    () => ({
      insertText: (text: string) => {
        const root = rootRef.current;
        if (!root) return;
        // Where the caret is if it is still in the field (a click on the picker's button keeps it), else where it was.
        const { start, end } = currentSelection();
        root.focus({ preventScroll: true });
        const length = (shown.current ?? "").length;
        edit(Math.min(start, length), Math.min(end, length), text);
        setCaretOffset(root, selection.current.start);
      },
      focus: () => rootRef.current?.focus({ preventScroll: true }),
    }),
    // `edit` reads refs and the latest props; a stable handle is not needed.
  );

  // Keep the selection as offsets while this field has it.
  React.useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const track = () => {
      const root = rootRef.current;
      if (!root || doc.activeElement !== root) return;
      const live = selectionOffsets(root);
      if (live) selection.current = live;
    };
    doc.addEventListener("selectionchange", track);
    return () => doc.removeEventListener("selectionchange", track);
  }, []);

  // A `<label for>` doesn't focus a contenteditable by itself.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!id || !root) return;
    const label = root.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`);
    if (!label) return;
    const focus = () => {
      root.focus({ preventScroll: true });
      setCaretOffset(root, (shown.current ?? "").length);
    };
    label.addEventListener("click", focus);
    return () => label.removeEventListener("click", focus);
  }, [id]);

  const onInput = () => {
    const root = rootRef.current;
    if (!root) return;
    const next = serializeTemplateDom(root);
    if (composing.current) {
      shown.current = next;
      setEmpty(root, next);
      onChange(next);
      return;
    }
    const caret = selectionOffsets(root)?.start ?? next.length;
    if (maxLength !== undefined && next.length > maxLength) {
      // Over the limit: put back what was there.
      const previous = shown.current ?? "";
      draw(previous, Math.min(selection.current.start, previous.length));
      return;
    }
    if (!domMatches(root, next, multiline)) draw(next, caret);
    else {
      shown.current = next;
      setEmpty(root, next);
      selection.current = { start: caret, end: caret };
    }
    emit(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (multiline) {
        const { start, end } = currentSelection();
        edit(start, end, "\n");
      }
      return;
    }
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    const { start, end } = currentSelection();
    if (start !== end) return;
    // A chip goes as one unit.
    const spans = refSpans(shown.current ?? "");
    const hit =
      event.key === "Backspace" ? spans.find((span) => span.end === start) : spans.find((span) => span.start === start);
    if (hit) {
      event.preventDefault();
      edit(hit.start, hit.end, "");
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    // Plain text only: no foreign markup ever lands in the field.
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const { start, end } = currentSelection();
    edit(start, end, text);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const text = event.dataTransfer.getData("text/plain");
    event.preventDefault();
    const root = rootRef.current;
    if (!text || !root) return;
    root.focus({ preventScroll: true });
    const at = offsetFromPoint(root, event.clientX, event.clientY) ?? (shown.current ?? "").length;
    edit(at, at, text);
  };

  return (
    <div
      ref={rootRef}
      id={id}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      spellCheck={false}
      aria-multiline={multiline || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel || !id ? undefined : `${id}-label`}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      data-empty={value.length === 0}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      // Dragging a selection out of the field would copy, not move: keep text where it is.
      onDragStart={(event) => event.preventDefault()}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        onInput();
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      className={cn(
        small ? INPUT_SM : INPUT,
        "block cursor-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
        "before:pointer-events-none before:text-muted-foreground/80 data-[empty=true]:before:content-[attr(data-placeholder)]",
        multiline
          ? "max-h-72 min-h-[5.25rem] overflow-y-auto leading-relaxed"
          : small
            ? "min-h-[2rem]"
            : "min-h-[2.375rem]",
        mono && "font-mono text-[12.5px]",
        className,
      )}
    />
  );
});
