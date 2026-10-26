"""Import and export of a custom agent (plan 44, the builder's YAML path).

**Import** takes an ``agent.yaml`` as text or as a file (with its prompt files),
or one ``.zip``; the bridge unpacks it in memory under fixed limits and forwards
``{yaml, files}`` to the agents service, which parses and validates it. Nothing
is saved. What is pinned here is the bridge's half: the shapes it accepts, the
manifest it picks, the folder it strips, and everything it refuses *before*
anything reaches upstream — oversized or lying archives, paths that leave the
folder, links, non-text files.

**Export** proxies the agents service's zip for an agent the caller owns.
"""
from __future__ import annotations

import io
import json
import stat
import zipfile

import httpx
import pytest

from core.database import AgentTable
from utils import agent_import

IMPORT_RESULT = {
    "valid": True,
    "errors": [],
    "issues": [{"path": "description", "message": "is empty", "severity": "warning"}],
    "spec": {"slug": "research-bot", "name": "Research Bot", "prompt": "./AGENT.md"},
    "files": [{"path": "AGENT.md", "content": "You are Research Bot.", "encoding": "utf-8"}],
}
MANIFEST = "slug: research-bot\nname: Research Bot\nprompt: ./AGENT.md\n"


def _import_path(user_id: str) -> str:
    return f"/users/{user_id}/custom-agents/import"


def _zip(entries: dict[str, bytes], *, symlinks: tuple[str, ...] = ()) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if name in symlinks:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, data)
    return buffer.getvalue()


def _lie_about_size(archive: bytes, name: str, size: int) -> bytes:
    """Rewrite ``name``'s declared uncompressed size, in its local header and its
    central-directory record, leaving the compressed data as it is."""
    data = bytearray(archive)
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        local = zf.getinfo(name).header_offset
    data[local + 22:local + 26] = size.to_bytes(4, "little")
    central = data.find(b"PK\x01\x02")
    while central != -1:
        name_len = int.from_bytes(data[central + 28:central + 30], "little")
        if bytes(data[central + 46:central + 46 + name_len]) == name.encode():
            data[central + 24:central + 28] = size.to_bytes(4, "little")
        central = data.find(b"PK\x01\x02", central + 4)
    return bytes(data)


@pytest.fixture
def upstream_import(agents_service, seeded_user):
    agents_service.on("POST", _import_path(seeded_user.id), httpx.Response(200, json=IMPORT_RESULT))
    return agents_service


def _sent(agents_service, user_id: str) -> dict:
    [request] = agents_service.called("POST", _import_path(user_id))
    return json.loads(request.content)


async def _import(client, user_id: str, *, data=None, files=None):
    return await client.post(f"/v1/agents/{user_id}/custom/import", data=data or {}, files=files or [])


# ---------------------------------------------------------------------------
# Accepted shapes
# ---------------------------------------------------------------------------
async def test_yaml_field_with_files_is_forwarded(client, upstream_import, seeded_user):
    response = await _import(
        client, seeded_user.id,
        data={"yaml": MANIFEST},
        files=[
            ("files", ("AGENT.md", b"You are Research Bot.", "text/markdown")),
            ("files", ("notes.txt", "café".encode(), "text/plain")),
        ],
    )

    assert response.status_code == 200
    # Upstream's answer, issues and all (``size`` is the schema's optional field).
    assert response.json() == {
        **IMPORT_RESULT,
        "files": [{**f, "size": None} for f in IMPORT_RESULT["files"]],
    }
    assert _sent(upstream_import, seeded_user.id) == {
        "yaml": MANIFEST,
        "files": [
            {"path": "AGENT.md", "content": "You are Research Bot.", "encoding": "utf-8"},
            {"path": "notes.txt", "content": "café", "encoding": "utf-8"},
        ],
    }


async def test_yaml_field_alone_is_enough(client, upstream_import, seeded_user):
    response = await _import(client, seeded_user.id, data={"yaml": MANIFEST})
    assert response.status_code == 200
    assert _sent(upstream_import, seeded_user.id) == {"yaml": MANIFEST, "files": []}


async def test_agent_yaml_among_the_files_is_the_manifest(client, upstream_import, seeded_user):
    response = await _import(
        client, seeded_user.id,
        files=[
            ("files", ("AGENT.md", b"prompt", "text/markdown")),
            ("files", ("agent.yaml", MANIFEST.encode(), "application/yaml")),
            ("files", ("extra.yml", b"k: v\n", "application/yaml")),
        ],
    )

    assert response.status_code == 200
    sent = _sent(upstream_import, seeded_user.id)
    assert sent["yaml"] == MANIFEST
    assert [f["path"] for f in sent["files"]] == ["AGENT.md", "extra.yml"]


async def test_a_single_yaml_file_is_the_manifest_whatever_its_name(client, upstream_import, seeded_user):
    response = await _import(
        client, seeded_user.id,
        files=[("files", ("my-agent.yml", MANIFEST.encode(), "application/yaml"))],
    )
    assert response.status_code == 200
    assert _sent(upstream_import, seeded_user.id)["yaml"] == MANIFEST


async def test_a_zip_with_one_top_folder_is_stripped(client, upstream_import, seeded_user):
    archive = _zip({
        "research-bot/agent.yaml": MANIFEST.encode(),
        "research-bot/AGENT.md": b"prompt",
        "research-bot/subagents/helper.md": b"helper prompt",
        "research-bot/.DS_Store": b"\x00\x01",
        "__MACOSX/research-bot/._AGENT.md": b"\x00\x01",
    })

    response = await _import(
        client, seeded_user.id, files=[("files", ("research-bot.zip", archive, "application/zip"))]
    )

    assert response.status_code == 200
    sent = _sent(upstream_import, seeded_user.id)
    assert sent["yaml"] == MANIFEST
    assert sorted(f["path"] for f in sent["files"]) == ["AGENT.md", "subagents/helper.md"]


async def test_a_zip_at_the_root_keeps_its_paths(client, upstream_import, seeded_user):
    archive = _zip({"agent.yml": MANIFEST.encode(), "prompts/main.md": b"prompt"})
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    assert response.status_code == 200
    assert [f["path"] for f in _sent(upstream_import, seeded_user.id)["files"]] == ["prompts/main.md"]


async def test_an_invalid_yaml_comes_back_as_upstreams_issues(client, agents_service, seeded_user):
    """Parse errors are upstream's to report (with line and column); the bridge
    forwards the text untouched and returns the answer as a 200."""
    report = {
        "valid": False, "errors": ["YAML parse error"], "spec": None, "files": [],
        "issues": [{"path": "", "message": "line 2, column 5: mapping values are not allowed", "severity": "error"}],
    }
    agents_service.on("POST", _import_path(seeded_user.id), httpx.Response(200, json=report))

    response = await _import(client, seeded_user.id, data={"yaml": "a: b: c\n"})

    assert response.status_code == 200
    assert response.json() == report


# ---------------------------------------------------------------------------
# Refused before anything reaches upstream
# ---------------------------------------------------------------------------
async def _assert_refused(response, agents_service, status_codes=(422,)):
    assert response.status_code in status_codes, response.text
    assert isinstance(response.json()["detail"], str)
    assert agents_service.calls == []


async def test_nothing_to_import_is_refused(client, agents_service, seeded_user):
    await _assert_refused(await _import(client, seeded_user.id), agents_service)


async def test_a_zip_and_a_yaml_field_together_are_refused(client, agents_service, seeded_user):
    archive = _zip({"agent.yaml": MANIFEST.encode()})
    response = await _import(
        client, seeded_user.id, data={"yaml": MANIFEST},
        files=[("files", ("a.zip", archive, "application/zip"))],
    )
    await _assert_refused(response, agents_service)


async def test_a_file_that_is_not_utf8_is_refused_clearly(client, agents_service, seeded_user):
    response = await _import(
        client, seeded_user.id, data={"yaml": MANIFEST},
        files=[("files", ("AGENT.md", b"\xff\xfe\x00bad", "text/markdown"))],
    )
    await _assert_refused(response, agents_service)
    assert "UTF-8" in response.json()["detail"]


async def test_an_unsupported_extension_is_refused(client, agents_service, seeded_user):
    response = await _import(
        client, seeded_user.id, data={"yaml": MANIFEST},
        files=[("files", ("run.py", b"print('x')", "text/x-python"))],
    )
    await _assert_refused(response, agents_service)


async def test_several_yaml_files_without_agent_yaml_are_refused(client, agents_service, seeded_user):
    response = await _import(
        client, seeded_user.id,
        files=[
            ("files", ("one.yaml", b"a: 1", "application/yaml")),
            ("files", ("two.yaml", b"b: 2", "application/yaml")),
        ],
    )
    await _assert_refused(response, agents_service)


@pytest.mark.parametrize(
    "name",
    # (A backslash name is not listed: zipfile itself rewrites it to "/" on
    # Windows, so what the bridge sees differs by platform.)
    ["../escape.md", "/etc/agent.md", "a/../../escape.md", "C:/agent.md", "./../escape.md"],
)
async def test_zip_paths_outside_the_folder_are_refused(client, agents_service, seeded_user, name):
    archive = _zip({"agent.yaml": MANIFEST.encode(), name: b"x"})
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service)


async def test_a_symlink_in_the_zip_is_refused(client, agents_service, seeded_user):
    archive = _zip({"agent.yaml": MANIFEST.encode(), "AGENT.md": b"/etc/passwd"}, symlinks=("AGENT.md",))
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service)


async def test_a_path_deeper_than_the_limit_is_refused(client, agents_service, seeded_user):
    archive = _zip({"agent.yaml": MANIFEST.encode(), "a/b/c/d/e.md": b"x"})
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service)


async def test_too_many_entries_are_refused(client, agents_service, seeded_user):
    entries = {"agent.yaml": MANIFEST.encode()}
    entries.update({f"p{i}.md": b"x" for i in range(agent_import.MAX_FILES + 1)})
    archive = _zip(entries)
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service)


async def test_an_oversized_file_is_refused(client, agents_service, seeded_user):
    big = b"a" * (agent_import.MAX_FILE_BYTES + 1)
    archive = _zip({"agent.yaml": MANIFEST.encode(), "AGENT.md": big})
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service, (413,))


async def test_a_zip_bomb_is_refused_on_its_declared_total(client, agents_service, seeded_user):
    # Six highly compressible files just under the per-file limit: a few KiB
    # compressed, past the 1.25 MiB total once unpacked.
    entries = {"agent.yaml": MANIFEST.encode()}
    entries.update({f"p{i}.md": b"a" * (agent_import.MAX_FILE_BYTES - 1) for i in range(6)})
    archive = _zip(entries)
    assert len(archive) < 64 * 1024
    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])
    await _assert_refused(response, agents_service, (413,))


async def test_a_zip_that_lies_about_its_sizes_is_stopped_while_reading(client, agents_service, seeded_user):
    """An archive whose headers declare a tiny size but whose data inflates to
    far more: the declared-size check passes, the read must not."""
    real = b"a" * (agent_import.MAX_FILE_BYTES * 2)
    archive = _lie_about_size(_zip({"agent.yaml": MANIFEST.encode(), "AGENT.md": real}), "AGENT.md", 10)

    response = await _import(client, seeded_user.id, files=[("files", ("a.zip", archive, "application/zip"))])

    await _assert_refused(response, agents_service, (413, 422))


async def test_a_corrupt_zip_is_refused(client, agents_service, seeded_user):
    response = await _import(
        client, seeded_user.id, files=[("files", ("a.zip", b"PK\x03\x04 not really", "application/zip"))]
    )
    await _assert_refused(response, agents_service)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
async def _owned_agent(session_factory, owner_id: str, slug: str = "research-bot") -> str:
    async with session_factory() as session:
        row = AgentTable(
            owner_user_id=owner_id, slug=slug, name="Research Bot", description="",
            icon="Bot", type="deep agent", is_active=True,
        )
        session.add(row)
        await session.commit()
        return row.id


async def test_export_streams_the_upstream_zip(client, agents_service, seeded_user, session_factory):
    agent_id = await _owned_agent(session_factory, seeded_user.id)
    archive = _zip({"agent.yaml": MANIFEST.encode(), "AGENT.md": b"prompt"})
    agents_service.on(
        "GET", f"/users/{seeded_user.id}/custom-agents/research-bot/export",
        httpx.Response(
            200, content=archive,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="research-bot.zip"',
            },
        ),
    )

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/export")

    assert response.status_code == 200
    assert response.content == archive
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="research-bot.zip"'


async def test_export_names_the_file_when_upstream_does_not(client, agents_service, seeded_user, session_factory):
    agent_id = await _owned_agent(session_factory, seeded_user.id)
    agents_service.on(
        "GET", f"/users/{seeded_user.id}/custom-agents/research-bot/export",
        httpx.Response(200, content=b"PK", headers={"Content-Type": "application/zip"}),
    )
    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/export")
    assert response.headers["content-disposition"] == 'attachment; filename="research-bot.zip"'


async def test_export_of_another_users_agent_is_404_without_calling_upstream(
    client, agents_service, session_factory
):
    from core.database import UserTable

    async with session_factory() as session:
        other = UserTable(username="other-exporter", oidc_subject="oid-other-exporter", is_active=True)
        session.add(other)
        await session.commit()
        other_id = other.id
    agent_id = await _owned_agent(session_factory, other_id)

    # The path names the caller; the agent belongs to someone else.
    response = await client.get(f"/v1/agents/not-the-owner/custom/{agent_id}/export")

    assert response.status_code == 404
    assert agents_service.calls == []


async def test_export_of_an_agent_unknown_upstream_is_404(client, agents_service, seeded_user, session_factory):
    agent_id = await _owned_agent(session_factory, seeded_user.id)
    agents_service.on(
        "GET", f"/users/{seeded_user.id}/custom-agents/research-bot/export",
        httpx.Response(404, json={"detail": "Agent not found."}),
    )
    response = await client.get(f"/v1/agents/{seeded_user.id}/custom/{agent_id}/export")
    assert response.status_code == 404
