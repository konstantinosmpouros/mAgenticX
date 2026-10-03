"""Undo a model's double-escaped line breaks in long prose arguments.

Some models occasionally write a multi-line string argument with its line
breaks escaped twice — the tool-call JSON carries ``\\n`` — so the tool
receives the two characters backslash + ``n`` instead of a line break. Saved
as-is, a Markdown body becomes one enormous line: a SKILL.md whose ``#`` title
swallows the whole document.

Applied only to prose fields — a skill's instructions, a memory's text — never
to file contents: a one-line script may legitimately contain ``\\n``. The
frontend mirrors this rule (``undoDoubleEscaping`` in
``features/chat/lib/toolPresentation.ts``) so an approval preview shows exactly
what will be saved.
"""
from __future__ import annotations

# Order matters: the CRLF pair must be collapsed before its `\n` half.
_ESCAPES: tuple[tuple[str, str], ...] = (
    ("\\r\\n", "\n"),
    ("\\n", "\n"),
    ("\\t", "\t"),
    ('\\"', '"'),
)


def undo_double_escaping(text: str) -> str:
    """Restore escaped line breaks in ``text`` when it has no real ones.

    The signal is deliberately narrow: prose that already contains a real line
    break is returned untouched, so genuine backslash sequences in normal
    multi-line text are never rewritten. Only text that is one line *and*
    carries a literal ``\\n`` is treated as double-escaped.
    """
    if "\n" in text or "\\n" not in text:
        return text
    for escaped, real in _ESCAPES:
        text = text.replace(escaped, real)
    return text


__all__ = ["undo_double_escaping"]
