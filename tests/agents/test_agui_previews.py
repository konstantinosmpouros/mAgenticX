"""Shrinking image tool results before they reach the event stream.

Two properties carry the weight.

**The model's input is untouched.** The shrink happens in the emitter, which
only observes the run. A regression that reached the tool result itself would
silently blind the agent to images it can read today, and nothing in the UI
would look wrong — so the emitter test asserts the output object it was handed
is unchanged.

**It never raises.** This runs in the streaming path; an exception would abort a
run mid-answer. Every failure degrades to ``omitted`` instead.
"""
from __future__ import annotations

import base64
import importlib
import io
import json

import pytest

PIL = pytest.importorskip("PIL.Image", reason="Pillow is required for image previews")


@pytest.fixture
def previews(agents_service):
    return importlib.import_module("harness.agui.previews")


def _png(width: int = 1600, height: int = 1200, mode: str = "RGB") -> bytes:
    """A hard-to-compress image, so shrinking it is a real shrink."""
    img = PIL.new(mode, (width, height))
    for x in range(0, width, 7):
        for y in range(0, height, 11):
            value = (x % 256, y % 256, (x * y) % 256)
            img.putpixel((x, y), value + (255,) if mode == "RGBA" else value)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _flat_png(mode: str = "RGBA") -> bytes:
    """A screenshot-like image: large flat areas, so PNG stays small.

    The noisy `_png` above is pathological — a 512px RGBA thumbnail of pure
    noise genuinely exceeds the byte ceiling, which is the ceiling doing its
    job, not a bug. Transparency behaviour needs an image that fits.
    """
    img = PIL.new(mode, (1600, 1200), (240, 240, 240, 255)[: len(mode)])
    for x in range(400, 1200):
        for y in range(300, 900):
            img.putpixel((x, y), (20, 90, 200, 255)[: len(mode)])
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _payload(raw: bytes, mime: str = "image/png") -> str:
    return json.dumps(
        [{"type": "image", "base64": base64.b64encode(raw).decode(), "mime_type": mime}]
    )


def _block(result: str) -> dict:
    return json.loads(result)[0]


# ---------------------------------------------------------------------------
# The shrink
# ---------------------------------------------------------------------------
def test_an_image_is_replaced_by_a_bounded_thumbnail(previews):
    raw = _png()
    out = _block(previews.shrink_image_blocks(_payload(raw)))

    assert out["omitted"] is False
    assert out["bytes"] == len(raw)
    preview = base64.b64decode(out["preview_base64"])
    assert len(preview) < len(raw)
    assert max(PIL.open(io.BytesIO(preview)).size) <= 512


def test_the_original_base64_is_dropped_entirely(previews):
    # Renamed would be ambiguous; absent cannot be misread. Nothing downstream
    # should ever see the full image.
    out = _block(previews.shrink_image_blocks(_payload(_png())))
    assert "base64" not in out


def test_the_payload_shrinks_by_an_order_of_magnitude(previews):
    payload = _payload(_png())
    assert len(previews.shrink_image_blocks(payload)) * 5 < len(payload)


def test_transparency_survives_as_png(previews):
    out = _block(previews.shrink_image_blocks(_payload(_flat_png(), "image/png")))
    assert out["mime_type"] == "image/png"
    assert PIL.open(io.BytesIO(base64.b64decode(out["preview_base64"]))).mode in ("RGBA", "LA", "P")


def test_an_opaque_image_becomes_jpeg(previews):
    # JPEG is the smaller encoding and the alpha channel buys nothing here.
    out = _block(previews.shrink_image_blocks(_payload(_png(), "image/jpeg")))
    assert out["mime_type"] == "image/jpeg"


# ---------------------------------------------------------------------------
# Failure degrades, never raises
# ---------------------------------------------------------------------------
def test_undecodable_base64_is_marked_omitted(previews):
    payload = json.dumps([{"type": "image", "base64": "not base64!!", "mime_type": "image/png"}])
    out = _block(previews.shrink_image_blocks(payload))
    assert out["omitted"] is True
    assert "preview_base64" not in out


def test_bytes_that_are_not_an_image_are_marked_omitted(previews):
    payload = _payload(b"this is not a picture")
    out = _block(previews.shrink_image_blocks(payload))
    assert out["omitted"] is True


def test_a_thumbnail_over_the_ceiling_is_omitted(previews, agents_service):
    # The ceiling is what makes storage predictable; one pathological file must
    # not be allowed through just because it decoded.
    agents_service.settings_module.settings.agui.image_preview_max_bytes = 1
    out = _block(previews.shrink_image_blocks(_payload(_png())))
    assert out["omitted"] is True


# ---------------------------------------------------------------------------
# Everything else passes through untouched
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "content",
    [
        "",
        "plain text result",
        "{}",
        "[]",
        '[{"type": "text", "text": "hello"}]',
        "[not json at all",
        '{"type": "image", "base64": "abc"}',  # an object, not a block list
    ],
)
def test_non_image_results_are_returned_identically(previews, content):
    assert previews.shrink_image_blocks(content) is content


def test_text_alongside_an_image_is_preserved(previews):
    payload = json.dumps(
        [
            {"type": "text", "text": "here it is"},
            {"type": "image", "base64": base64.b64encode(_png()).decode(), "mime_type": "image/png"},
        ]
    )
    blocks = json.loads(previews.shrink_image_blocks(payload))
    assert blocks[0] == {"type": "text", "text": "here it is"}
    assert blocks[1]["omitted"] is False


# ---------------------------------------------------------------------------
# The emitter does not touch the model's copy
# ---------------------------------------------------------------------------
def test_the_emitter_leaves_the_tool_output_object_alone(agents_service):
    emitter_mod = importlib.import_module("harness.agui.emitter")
    emitter = emitter_mod.AGUIEmitter()
    output = _payload(_png())
    before = output

    emitter.tool_call_result("call-1", output, writer=None)

    # The string handed in is what the model already received; shrinking it in
    # place would remove the image from the agent's own context.
    assert output == before
