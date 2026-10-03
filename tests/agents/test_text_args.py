"""Undoing a model's double-escaped line breaks in prose arguments.

A model sometimes sends a multi-line argument with its newlines escaped twice,
so the tool receives a literal backslash + ``n``. Saved as-is, a SKILL.md
becomes one line whose ``#`` title swallows the document. The fix must stay
narrow: text with any real line break is left alone, so genuine backslash
sequences in normal prose survive.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def undo(agents_service):
    return importlib.import_module("harness.tools.text_args").undo_double_escaping


def test_restores_escaped_line_breaks(undo):
    raw = "# Tool Demo\\n\\nUse this when\\n- step one\\n- step two"
    assert undo(raw) == "# Tool Demo\n\nUse this when\n- step one\n- step two"


def test_collapses_crlf_tabs_and_quotes(undo):
    assert undo('a\\r\\nb\\tc \\"d\\"') == 'a\nb\tc "d"'


def test_leaves_text_with_real_line_breaks_alone(undo):
    # Multi-line prose that *mentions* \n (e.g. explaining escapes) is genuine.
    text = 'Line one\nUse "\\n" to break a line in Python.'
    assert undo(text) == text


def test_leaves_single_line_text_without_escapes_alone(undo):
    assert undo("just one line") == "just one line"
