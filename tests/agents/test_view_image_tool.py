"""The ``view_image`` tool — putting a picture in front of the model.

The load-bearing detail is the return type: a ``ToolMessage`` carrying an image
**content block**. A JSON string of base64 would reach the model as text and be
worth nothing, so these tests assert on the block, not on a string.

Zooming is the second half: a region is in pixels of the full image, so every
result states the dimensions the model needs to aim one. A tight crop is scaled
up (there is no point returning eighty pixels of text), an overshooting one is
clamped rather than refused, and one that misses entirely is an error.

Everything else here is about not failing the user's run: a missing file, an
unsupported type, an oversized file and a path outside the mounts all come back
as readable error results.
"""
from __future__ import annotations

import base64
import importlib
import io

import pytest
from PIL import Image


@pytest.fixture
def view_image(agents_service):
    return importlib.import_module("harness.tools.view_image")


# A 1x1 PNG — small, real, and decodable.
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def make_png(width: int, height: int) -> bytes:
    """A real image of known size, so crops can be asserted on."""
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


def image_block(message):
    blocks = message.content if isinstance(message.content, list) else []
    return next(b for b in blocks if b.get("type") == "image")


def text_note(message):
    blocks = message.content if isinstance(message.content, list) else []
    return " ".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def decoded_size(message):
    raw = base64.b64decode(image_block(message)["base64"])
    with Image.open(io.BytesIO(raw)) as img:
        return img.size


@pytest.fixture
def conversation(tmp_path, view_image, monkeypatch):
    """Point the resolver at a real temp tree with an input/ and output/ dir."""
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    def fake_resolve(*, user_id, agent_slug, conversation_id, virtual_path):
        if virtual_path.startswith("/conversation/input/"):
            return input_dir / virtual_path[len("/conversation/input/") :]
        if virtual_path.startswith("/conversation/output/"):
            return output_dir / virtual_path[len("/conversation/output/") :]
        raise ValueError(f"Path must be under a conversation mount: {virtual_path!r}")

    monkeypatch.setattr(view_image, "resolve_conversation_file", fake_resolve)
    return input_dir, output_dir


@pytest.fixture
def tool(view_image, conversation):
    return view_image.build_view_image_tool(
        user_id="u1", agent_slug="omni", conversation_id="c1"
    )


def view_image_module():
    return importlib.import_module("harness.tools.view_image")


def _invoke_region(tool, path, x, y, width, height, call_id="call-1"):
    return tool.invoke(
        {
            "name": "view_image",
            "args": {"path": path, "region": {"x": x, "y": y, "width": width, "height": height}},
            "id": call_id,
            "type": "tool_call",
        }
    )


def _invoke(tool, path, call_id="call-1"):
    """Drive the tool the way LangChain does, so injection is exercised."""
    return tool.invoke(
        {"name": "view_image", "args": {"path": path}, "id": call_id, "type": "tool_call"}
    )


# ---------------------------------------------------------------------------
# The image reaches the model
# ---------------------------------------------------------------------------
def test_it_returns_the_image_as_a_content_block(tool, conversation):
    input_dir, _ = conversation
    (input_dir / "shot.png").write_bytes(PNG_BYTES)

    message = _invoke(tool, "/conversation/input/shot.png")

    assert message.status == "success"
    block = image_block(message)
    assert block["mime_type"] == "image/png"
    # The model's copy is the whole file, not a thumbnail — shrinking happens
    # later and only on the stream.
    assert base64.b64decode(block["base64"]) == PNG_BYTES


def test_the_tool_call_id_is_injected_not_asked_of_the_model(tool, conversation):
    # The model must never be prompted for tool_call_id; LangChain supplies it.
    assert "tool_call_id" not in tool.tool_call_schema.model_fields
    assert "path" in tool.tool_call_schema.model_fields

    input_dir, _ = conversation
    (input_dir / "shot.png").write_bytes(PNG_BYTES)
    message = _invoke(tool, "/conversation/input/shot.png", call_id="abc-123")
    assert message.tool_call_id == "abc-123"


def test_it_reads_from_the_output_mount_too(tool, conversation):
    _, output_dir = conversation
    (output_dir / "chart.png").write_bytes(PNG_BYTES)

    message = _invoke(tool, "/conversation/output/chart.png")
    assert message.status == "success"


# ---------------------------------------------------------------------------
# Failures are results, never exceptions
# ---------------------------------------------------------------------------
def test_a_missing_file_says_it_does_not_exist(tool):
    message = _invoke(tool, "/conversation/input/nope.png")

    assert message.status == "error"
    assert "does not exist in this filesystem" in message.content


def test_a_path_outside_the_mounts_is_refused(tool):
    message = _invoke(tool, "/skills/secret.png")

    assert message.status == "error"
    assert "conversation mount" in message.content


def test_a_non_image_is_refused_before_it_is_read(tool, conversation):
    input_dir, _ = conversation
    (input_dir / "notes.txt").write_bytes(b"hello")

    message = _invoke(tool, "/conversation/input/notes.txt")

    assert message.status == "error"
    assert "not a viewable image" in message.content


def test_an_oversized_image_is_refused(tool, conversation, view_image, monkeypatch):
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(PNG_BYTES)
    monkeypatch.setattr(
        view_image.settings.filesystem, "view_image_max_bytes", 1, raising=False
    )

    message = _invoke(tool, "/conversation/input/big.png")

    assert message.status == "error"
    assert "too large to view" in message.content


@pytest.mark.parametrize("suffix", [".png", ".jpg", ".jpeg", ".gif", ".webp"])
def test_the_supported_formats_are_accepted(tool, conversation, suffix):
    input_dir, _ = conversation
    (input_dir / f"pic{suffix}").write_bytes(PNG_BYTES)

    message = _invoke(tool, f"/conversation/input/pic{suffix}")
    assert message.status == "success"


# ---------------------------------------------------------------------------
# How it is offered
# ---------------------------------------------------------------------------
def test_it_is_an_ungated_builtin_that_needs_a_conversation(agents_service):
    builtins_mod = importlib.import_module("harness.tools.builtins")
    registry = importlib.import_module("harness.tools.registry")

    assert "view_image" in registry.NATIVE_TOOLS
    entry = builtins_mod.BUILTIN_BY_NAME["view_image"]
    # Reading a picture changes nothing — no approval by default.
    assert entry.hitl_default is False
    assert entry.locked is False
    assert entry.availability is builtins_mod.Availability.CONVERSATION

    ctx = registry.NativeToolContext(
        user_id="u1", agent_slug="omni", conversation_id="", use_memory=False
    )
    assert registry.NATIVE_TOOLS["view_image"].builder(ctx) is None


# ---------------------------------------------------------------------------
# Zooming
# ---------------------------------------------------------------------------
def test_a_full_view_reports_the_dimensions_a_zoom_needs(tool, conversation):
    # Without this the model has no coordinate space to aim a region at.
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke(tool, "/conversation/input/big.png")

    assert "1600x900" in text_note(message)


def test_a_region_crops_to_that_rectangle(tool, conversation):
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke_region(tool, "/conversation/input/big.png", 100, 50, 800, 400)

    assert message.status == "success"
    note = text_note(message)
    assert "x=100" in note and "y=50" in note and "w=800" in note and "h=400" in note
    # 800x400 already clears the detail floor, so it is not rescaled.
    assert decoded_size(message) == (800, 400)


def test_a_tight_crop_is_enlarged_so_the_detail_is_legible(tool, conversation):
    # The point of zooming is to read small things; handing back the native
    # 80x40 slice would waste the round trip.
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke_region(tool, "/conversation/input/big.png", 10, 10, 80, 40)

    module = view_image_module()
    width, height = decoded_size(message)
    assert width > 80 and height > 40
    # Scaled towards the detail floor, but never past the upscale cap — beyond
    # roughly 6x there is no information left to recover, only bytes. An 80px
    # crop therefore lands on the cap (480px), not on the 768px floor.
    assert max(width, height) == min(
        module.MIN_DETAIL_EDGE, round(80 * module.MAX_UPSCALE)
    )
    assert width / height == pytest.approx(2.0, rel=0.02)  # aspect preserved
    assert "shown at" in text_note(message)


def test_a_mid_sized_crop_reaches_the_detail_floor_exactly(tool, conversation):
    # 200px is within 6x of the floor, so this one is not cap-limited.
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke_region(tool, "/conversation/input/big.png", 0, 0, 200, 100)

    assert max(decoded_size(message)) == view_image_module().MIN_DETAIL_EDGE


def test_an_enormous_region_is_capped_rather_than_sent_whole(tool, conversation):
    input_dir, _ = conversation
    (input_dir / "huge.png").write_bytes(make_png(4000, 3000))

    message = _invoke_region(tool, "/conversation/input/huge.png", 0, 0, 4000, 3000)

    assert max(decoded_size(message)) == view_image_module().MAX_DETAIL_EDGE


def test_a_region_overshooting_an_edge_is_clamped_not_refused(tool, conversation):
    # A model estimating coordinates off a previous look routinely overshoots;
    # failing that costs a round trip to learn nothing.
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke_region(tool, "/conversation/input/big.png", 1500, 800, 500, 500)

    assert message.status == "success"
    note = text_note(message)
    assert "clamped" in note
    assert "w=100" in note and "h=100" in note


def test_a_region_entirely_off_the_image_is_an_error(tool, conversation):
    input_dir, _ = conversation
    (input_dir / "big.png").write_bytes(make_png(1600, 900))

    message = _invoke_region(tool, "/conversation/input/big.png", 5000, 5000, 100, 100)

    assert message.status == "error"
    assert "outside the image" in message.content
    assert "1600x900" in message.content


def test_a_transparent_crop_stays_png(tool, conversation):
    input_dir, _ = conversation
    buffer = io.BytesIO()
    Image.new("RGBA", (600, 600), (10, 120, 200, 128)).save(buffer, format="PNG")
    (input_dir / "alpha.png").write_bytes(buffer.getvalue())

    message = _invoke_region(tool, "/conversation/input/alpha.png", 0, 0, 300, 300)

    assert image_block(message)["mime_type"] == "image/png"


def test_the_region_is_optional_in_the_model_facing_schema(tool):
    schema = tool.tool_call_schema.model_json_schema()
    assert "path" in schema["required"]
    assert "region" not in schema.get("required", [])


class TestClampRegion:
    """The clamp rule on its own, away from file IO."""

    def test_a_contained_region_is_untouched(self, view_image):
        region = view_image._Region(x=10, y=20, width=30, height=40)
        assert view_image.clamp_region(region, 100, 100) == (10, 20, 40, 60)

    def test_it_trims_to_the_edges(self, view_image):
        region = view_image._Region(x=90, y=90, width=50, height=50)
        assert view_image.clamp_region(region, 100, 100) == (90, 90, 100, 100)

    def test_a_region_starting_past_the_edge_misses(self, view_image):
        region = view_image._Region(x=100, y=0, width=10, height=10)
        assert view_image.clamp_region(region, 100, 100) is None
