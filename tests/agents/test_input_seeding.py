"""Seeding user attachments into a conversation's read-only ``input/``.

Browsers name every pasted image ``image.png``. Writing by filename therefore
destroyed data silently: attach two images to one message and the second
overwrote the first, so the agent saw one file and the user had no way to tell.
The same held across turns, since ``input/`` persists for the conversation.

The fix suffixes a colliding name rather than overwriting it — but only when
the bytes actually differ, so re-sending an attachment stays a no-op.
"""
from __future__ import annotations

import base64
import importlib
from pathlib import Path

import pytest


class Upload:
    """The shape the bridge posts: filename + base64 payload."""

    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self.base64 = base64.b64encode(content).decode()
        self.mime = "image/png"
        self.size = len(content)


@pytest.fixture
def seed(agents_service, tmp_path):
    """Seed into a temp workspace root and return (written paths, input dir)."""
    fs = agents_service.settings_module.settings.filesystem
    fs.workspaces_root = tmp_path
    provisioner = importlib.import_module("harness.filesystem.provisioner")

    def _seed(*files: Upload) -> tuple[list[str], Path]:
        written = provisioner.seed_input_files(
            user_id="u1",
            agent_slug="omni-agent-v1",
            conversation_id="c1",
            files=list(files),
        )
        in_dir = provisioner.conversation_input_root("u1", "omni-agent-v1", "c1")
        return written, in_dir

    return _seed


def _names(in_dir: Path) -> list[str]:
    return sorted(p.name for p in in_dir.iterdir() if p.is_file())


def test_two_images_in_one_message_both_survive(seed):
    # The reported bug: both arrive as "image.png" and one used to vanish.
    written, in_dir = seed(Upload("image.png", b"first"), Upload("image.png", b"second"))

    assert _names(in_dir) == ["image.png", "image_1.png"]
    assert (in_dir / "image.png").read_bytes() == b"first"
    assert (in_dir / "image_1.png").read_bytes() == b"second"
    assert written == ["/conversation/input/image.png", "/conversation/input/image_1.png"]


def test_a_later_turn_does_not_overwrite_an_earlier_one(seed):
    # input/ persists for the conversation, so collisions cross turns too.
    seed(Upload("image.png", b"turn one"))
    _, in_dir = seed(Upload("image.png", b"turn two"))

    assert (in_dir / "image.png").read_bytes() == b"turn one"
    assert (in_dir / "image_1.png").read_bytes() == b"turn two"


def test_suffixes_keep_climbing(seed):
    written, in_dir = seed(
        Upload("image.png", b"a"), Upload("image.png", b"b"), Upload("image.png", b"c")
    )
    assert _names(in_dir) == ["image.png", "image_1.png", "image_2.png"]
    assert len(set(written)) == 3


def test_resending_identical_bytes_is_still_a_no_op(seed):
    # Idempotency is the property the old overwrite was protecting; keep it.
    # A retried request must not litter the directory with copies.
    seed(Upload("report.pdf", b"same"))
    written, in_dir = seed(Upload("report.pdf", b"same"))

    assert _names(in_dir) == ["report.pdf"]
    assert written == ["/conversation/input/report.pdf"]


def test_an_identical_resend_reuses_the_suffixed_name(seed):
    # Once "image_1.png" exists, re-sending those same bytes must land on it
    # rather than creating "image_2.png".
    seed(Upload("image.png", b"first"), Upload("image.png", b"second"))
    written, in_dir = seed(Upload("image.png", b"second"))

    assert _names(in_dir) == ["image.png", "image_1.png"]
    assert written == ["/conversation/input/image_1.png"]


def test_distinct_names_are_untouched(seed):
    written, in_dir = seed(Upload("a.png", b"a"), Upload("b.png", b"b"))
    assert _names(in_dir) == ["a.png", "b.png"]
    assert written == ["/conversation/input/a.png", "/conversation/input/b.png"]


def test_a_name_without_an_extension_still_suffixes(seed):
    _, in_dir = seed(Upload("notes", b"one"), Upload("notes", b"two"))
    assert _names(in_dir) == ["notes", "notes_1"]


def test_a_dotted_name_suffixes_before_the_last_extension(seed):
    _, in_dir = seed(Upload("archive.tar.gz", b"one"), Upload("archive.tar.gz", b"two"))
    assert _names(in_dir) == ["archive.tar.gz", "archive.tar_1.gz"]
