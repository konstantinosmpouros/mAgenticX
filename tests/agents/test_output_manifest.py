"""The run-end manifest of a conversation's ``output/`` (plan 35 phase 0).

The bridge stores every file the agent wrote, not only presented ones, and
asks for this listing to know which are new or changed. Pinned:

* every regular file under ``output/`` is listed — nested ones too — with its
  virtual path, size and SHA-256, and never its bytes;
* a symlink is skipped, never followed out of the mount;
* an absent ``output/`` is an empty listing; a listing past the cap is cut;
* the endpoint is internal-only.
"""
from __future__ import annotations

import hashlib
import importlib
import os

import pytest

USER, SLUG, CONV = "u1", "omni-agent-v1", "c1"


@pytest.fixture
def output_dir(agents_service, tmp_path):
    agents_service.settings_module.settings.filesystem.workspaces_root = tmp_path
    layout = importlib.import_module("harness.filesystem.layout")
    root = layout.conversation_output_root(USER, SLUG, CONV)
    root.mkdir(parents=True)
    return root


def _manifest():
    provisioner = importlib.import_module("harness.filesystem.provisioner")
    return provisioner.list_output_manifest(user_id=USER, agent_slug=SLUG, conversation_id=CONV)


def test_every_file_is_listed_with_its_hash_and_no_bytes(output_dir):
    (output_dir / "report.md").write_bytes(b"# report")
    (output_dir / "charts").mkdir()
    (output_dir / "charts" / "q3.csv").write_bytes(b"a,b\n1,2\n")

    listing = {entry["path"]: entry for entry in _manifest()}

    assert set(listing) == {"/conversation/output/report.md", "/conversation/output/charts/q3.csv"}
    nested = listing["/conversation/output/charts/q3.csv"]
    assert nested["filename"] == "q3.csv"
    assert nested["size"] == 8
    assert nested["sha256"] == hashlib.sha256(b"a,b\n1,2\n").hexdigest()
    assert all("base64" not in entry for entry in listing.values())


def test_a_symlink_is_never_followed(output_dir, tmp_path):
    secret = tmp_path / "outside.txt"
    secret.write_text("not yours")
    try:
        os.symlink(secret, output_dir / "link.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available on this platform")
    (output_dir / "real.txt").write_text("ok")

    assert [entry["filename"] for entry in _manifest()] == ["real.txt"]


def test_no_output_dir_is_an_empty_listing(agents_service, tmp_path):
    agents_service.settings_module.settings.filesystem.workspaces_root = tmp_path
    assert _manifest() == []


def test_a_listing_past_the_cap_is_cut(output_dir, agents_service, monkeypatch):
    monkeypatch.setattr(agents_service.settings_module.settings.filesystem, "output_manifest_max_files", 2)
    for name in ("a", "b", "c"):
        (output_dir / f"{name}.txt").write_text(name)
    assert len(_manifest()) == 2


async def test_the_endpoint_is_internal_only(client, internal_headers, output_dir):
    (output_dir / "x.txt").write_text("x")
    url = f"/agents/{SLUG}/users/{USER}/conversations/{CONV}/output-files/manifest"

    assert (await client.get(url)).status_code in (401, 403)
    resp = await client.get(url, headers=internal_headers)
    assert resp.status_code == 200
    assert [f["filename"] for f in resp.json()["files"]] == ["x.txt"]
