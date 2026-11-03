"""Request validation, file staging/collection (traversal, symlinks, caps), output sanitizing."""
from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

GOOD = {
    "user_id": "3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    "agent_slug": "data-analyst",
    "conversation_id": "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
    "command": "echo hi",
}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _can_symlink(tmp_path: Path) -> bool:
    try:
        os.symlink(tmp_path, tmp_path / "probe-link", target_is_directory=True)
    except (OSError, NotImplementedError):
        return False
    os.unlink(tmp_path / "probe-link")
    return True


# ---------------------------------------------------------------------------
# Request validation
# ---------------------------------------------------------------------------
def test_valid_request_defaults(svc):
    req = svc.schema.ExecRequest(**GOOD)
    assert req.workdir == "output" and req.timeout_seconds is None and req.files == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("command", ""),
        ("command", "   "),
        ("command", "x" * 16001),
        ("command", "echo\x00hi"),
        ("timeout_seconds", 0),
        ("timeout_seconds", -5),
        ("workdir", "/etc"),
        ("workdir", "../output"),
        ("user_id", "../root"),
        ("user_id", "a/b"),
        ("user_id", ".hidden"),
        ("user_id", "abc\n"),
        ("user_id", ""),
        ("user_id", "x" * 129),
        ("conversation_id", ".."),
        ("conversation_id", "c:\\windows"),
        ("agent_slug", "Data-Analyst"),
        ("agent_slug", "a--b"),
        ("agent_slug", "../x"),
        ("agent_slug", "a" * 65),
    ],
)
def test_invalid_requests_are_rejected(svc, field, value):
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**{**GOOD, field: value})


def test_unknown_fields_are_rejected(svc):
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**GOOD, path="/etc")


def test_command_at_the_cap_is_accepted(svc):
    assert svc.schema.ExecRequest(**{**GOOD, "command": "x" * 16000}).command


@pytest.mark.parametrize(
    "path",
    [
        "input/data.csv",
        "output/report.xlsx",
        "input/a/b/c/d.txt",
        "input/Πωλήσεις 2026.csv",
        "output/.hidden",
    ],
)
def test_good_file_paths(svc, path):
    req = svc.schema.ExecRequest(**GOOD, files=[{"path": path, "content_b64": b64(b"x")}])
    assert req.files[0].path == path


@pytest.mark.parametrize(
    "path",
    [
        "data.csv",               # no area
        "tmp/data.csv",           # unknown area
        "input/",                 # empty rel
        "input",                  # no rel
        "input/../output/x",      # traversal
        "input/a/../../etc/passwd",
        "output/..",
        "output/./x",
        "/input/x",               # absolute
        "input//x",               # empty segment
        "input/a\\b",             # backslash
        "input/a/b/c/d/e.txt",    # depth 5
        "input/" + "x" * 200,     # too long
        "input/new\nline",        # control char
        "input/nul\x00",
        "../input/x",
    ],
)
def test_bad_file_paths_are_rejected(svc, path):
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**GOOD, files=[{"path": path, "content_b64": b64(b"x")}])


def test_duplicate_and_clashing_paths_are_rejected(svc):
    one = {"path": "input/a.csv", "content_b64": b64(b"1")}
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**GOOD, files=[one, one])
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**GOOD, files=[
            {"path": "input/a", "content_b64": b64(b"1")},
            {"path": "input/a/b", "content_b64": b64(b"2")},
        ])


def test_too_many_files_are_rejected(svc):
    files = [{"path": f"input/f{i}", "content_b64": ""} for i in range(101)]
    with pytest.raises(ValidationError):
        svc.schema.ExecRequest(**GOOD, files=files)


# ---------------------------------------------------------------------------
# Decoding + staging
# ---------------------------------------------------------------------------
def _req(svc, files):
    return svc.schema.ExecRequest(**GOOD, files=files).files


def test_decode_rejects_bad_base64(svc):
    with pytest.raises(svc.utils_workspace.InvalidFiles):
        svc.utils_workspace.decode_files(_req(svc, [{"path": "input/a", "content_b64": "not base64!"}]), 1024)


def test_decode_enforces_total_input_cap(svc):
    files = _req(svc, [{"path": "input/a", "content_b64": b64(b"x" * 600)},
                       {"path": "input/b", "content_b64": b64(b"y" * 600)}])
    with pytest.raises(svc.utils_workspace.InputTooLarge):
        svc.utils_workspace.decode_files(files, 1000)
    assert len(svc.utils_workspace.decode_files(files, 1200)) == 2


def test_prepare_places_files_and_remove_cleans_up(svc, calls_root):
    decoded = svc.utils_workspace.decode_files(_req(svc, [
        {"path": "input/data/sales.csv", "content_b64": b64(b"a,b\n1,2\n")},
        {"path": "output/old.txt", "content_b64": b64(b"old")},
    ]), 1 << 20)
    ws = svc.utils_workspace.prepare_workspace(calls_root, decoded)
    assert ws.call_dir.parent == calls_root
    assert (ws.input_dir / "data" / "sales.csv").read_bytes() == b"a,b\n1,2\n"
    assert (ws.output_dir / "old.txt").read_bytes() == b"old"
    assert set(ws.sent_outputs) == {"old.txt"}
    if os.name == "posix":
        assert (ws.call_dir.stat().st_mode & 0o777) == 0o700
    svc.utils_workspace.remove_workspace(ws)
    assert not ws.call_dir.exists()


def test_each_call_gets_its_own_dir(svc, calls_root):
    a = svc.utils_workspace.prepare_workspace(calls_root, [])
    b = svc.utils_workspace.prepare_workspace(calls_root, [])
    assert a.call_dir != b.call_dir
    assert a.input_dir.is_dir() and a.output_dir.is_dir()


def test_remove_survives_a_box_that_locked_its_dirs(svc, calls_root):
    ws = svc.utils_workspace.prepare_workspace(calls_root, [])
    locked = ws.output_dir / "locked"
    locked.mkdir()
    (locked / "f").write_text("x")
    os.chmod(locked, 0)
    svc.utils_workspace.remove_workspace(ws)
    assert not ws.call_dir.exists()


def test_sweep_removes_leftover_call_dirs(svc, calls_root):
    svc.utils_workspace.prepare_workspace(calls_root, [])
    svc.utils_workspace.prepare_workspace(calls_root, [])
    assert svc.utils_workspace.sweep_calls_root(calls_root) == 2
    assert list(calls_root.iterdir()) == []


# ---------------------------------------------------------------------------
# Collecting outputs
# ---------------------------------------------------------------------------
def _collect(svc, ws, max_file=1 << 20, max_total=1 << 20):
    return svc.utils_workspace.collect_outputs(ws, max_file=max_file, max_total=max_total)


def _staged(svc, calls_root, outputs: dict[str, bytes]):
    files = [{"path": f"output/{k}", "content_b64": b64(v)} for k, v in outputs.items()]
    return svc.utils_workspace.prepare_workspace(calls_root, svc.utils_workspace.decode_files(_req(svc, files), 1 << 20))


def test_only_new_or_changed_files_come_back(svc, calls_root):
    ws = _staged(svc, calls_root, {"same.txt": b"same", "changed.txt": b"v1"})
    (ws.output_dir / "changed.txt").write_bytes(b"v2")
    (ws.output_dir / "sub").mkdir()
    (ws.output_dir / "sub" / "new.png").write_bytes(b"\x89PNG")
    got = _collect(svc, ws)
    assert {f.path: base64.b64decode(f.content_b64) for f in got.files} == {
        "output/changed.txt": b"v2",
        "output/sub/new.png": b"\x89PNG",
    }
    assert all(f.size == len(base64.b64decode(f.content_b64)) for f in got.files)
    assert got.truncated is False


def test_symlinks_in_output_are_skipped_and_logged(svc, calls_root, tmp_path, caplog):
    if not _can_symlink(tmp_path):
        pytest.skip("this host cannot create symlinks")
    secret = tmp_path / "host-secret"
    secret.write_text("TOP SECRET")
    (tmp_path / "hostdir").mkdir()
    (tmp_path / "hostdir" / "f").write_text("TOP SECRET")
    ws = _staged(svc, calls_root, {})
    os.symlink(secret, ws.output_dir / "link.txt")
    os.symlink(tmp_path / "hostdir", ws.output_dir / "linkdir", target_is_directory=True)
    (ws.output_dir / "real.txt").write_text("ok")
    with caplog.at_level("WARNING"):
        got = _collect(svc, ws)
    assert [f.path for f in got.files] == ["output/real.txt"]
    events = [r for r in caplog.records if getattr(r, "event", None) == "sandbox_output_entry_skipped"]
    assert len(events) == 2


def test_fifo_is_never_opened(svc, calls_root):
    if not hasattr(os, "mkfifo"):
        pytest.skip("no FIFOs on this host")
    ws = _staged(svc, calls_root, {})
    os.mkfifo(ws.output_dir / "pipe")
    assert _collect(svc, ws).files == []


def test_per_file_and_total_caps(svc, calls_root):
    ws = _staged(svc, calls_root, {})
    (ws.output_dir / "a").write_bytes(b"1" * 400)
    (ws.output_dir / "b").write_bytes(b"2" * 400)
    (ws.output_dir / "c").write_bytes(b"3" * 2000)  # over the per-file cap
    got = _collect(svc, ws, max_file=1000, max_total=500)
    assert [f.path for f in got.files] == ["output/a"]
    assert got.truncated is True
    assert got.out_bytes == 2800


def test_unstorable_names_are_dropped_with_the_flag(svc, calls_root):
    ws = _staged(svc, calls_root, {})
    deep = ws.output_dir / "a" / "b" / "c" / "d"
    deep.mkdir(parents=True)
    (deep / "e.txt").write_text("too deep")
    got = _collect(svc, ws)
    assert got.files == [] and got.truncated is True


# ---------------------------------------------------------------------------
# Output decoding + capping
# ---------------------------------------------------------------------------
def test_invalid_utf8_is_replaced(svc):
    assert svc.utils_output.sanitize_output(b"ok \xff\xfe end") == "ok \ufffd\ufffd end"


def test_control_characters_are_stripped_but_newline_and_tab_kept(svc):
    raw = b"a\x1b[31mred\x1b[0m\tb\r\nc\x00d\x07\x7f" + "\u202eevil\u2066".encode()
    assert svc.utils_output.sanitize_output(raw) == "a[31mred[0m\tb\ncdevil"


def test_capped_buffer_keeps_head_and_flags_truncation(svc):
    buf = svc.utils_output.CappedBuffer(10)
    buf.feed(b"0123456")
    buf.feed(b"789abc")
    assert buf.data() == b"0123456789" and buf.truncated is True and buf.seen == 13


def test_capped_buffer_exactly_at_cap_is_not_truncated(svc):
    buf = svc.utils_output.CappedBuffer(4)
    buf.feed(b"abcd")
    assert not buf.truncated


def test_split_multibyte_at_cap_decodes_safely(svc):
    buf = svc.utils_output.CappedBuffer(4)
    buf.feed("abc€".encode())
    assert svc.utils_output.sanitize_output(buf.data()) == "abc\ufffd"


def test_safe_prefix_is_single_line(svc):
    assert svc.utils_output.safe_prefix("rm -rf /\nsecond\x1bline", 12) == "rm -rf / sec"
