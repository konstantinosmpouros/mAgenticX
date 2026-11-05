"""The agents service's part of a data export (plan 27): the framed stream.

The bridge copies these frames straight into the user's zip, so what is pinned
here is exactly what ends up in the archive under ``agents/`` and ``skills/``:

* every definition, every kept version and every custom-skill file, once,
  across page boundaries;
* file contents sliced, with every base64 slice decodable on its own;
* remote skills exported as references with provenance — never their content;
* nothing from a deleted skill, nothing from another user;
* an ``end`` frame last, so a cut stream can never pass for a complete one.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone

import pytest

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)


class FakeDefinitions:
    def __init__(self, user_id, specs, files, versions=()):
        self.user_id, self.specs, self.files = user_id, specs, files
        self.versions = sorted(versions, key=lambda v: (v["agent_slug"], v["version_no"]))

    async def page_definitions(self, user_id, after_slug, limit):
        rows = [{"agent_slug": s, "spec": spec, "created_at": NOW, "updated_at": NOW}
                for s, spec in sorted(self.specs.items()) if user_id == self.user_id and s > after_slug]
        return rows[:limit]

    async def page_file_refs(self, user_id, after, limit):
        rows = [{"agent_slug": k[0], "path": k[1], "encoding": v[1]}
                for k, v in sorted(self.files.items()) if user_id == self.user_id and k > after]
        return rows[:limit]

    async def read_file_slice(self, user_id, slug, path, start, length):
        return self.files[(slug, path)][0][start - 1:start - 1 + length]

    async def page_versions(self, user_id, after, limit):
        rows = [v for v in self.versions
                if user_id == self.user_id and (v["agent_slug"], v["version_no"]) > after]
        return rows[:limit]


def _version(slug, number, kind, changes=(), restored_from=None, based_on=None):
    return {"agent_slug": slug, "version_no": number, "kind": kind, "changes": list(changes),
            "restored_from": restored_from, "based_on": based_on, "created_at": NOW,
            "spec": {"name": f"{slug} v{number}"},
            "files": {"AGENT.md": {"content": f"Prompt {number}.", "encoding": "utf-8"}}}


class FakeSkills:
    def __init__(self, user_id, pool, files, assignments):
        self.user_id, self.pool, self.files, self.assignments = user_id, pool, files, assignments

    async def page_pool_entries(self, user_id, after_name, limit):
        rows = [e for e in sorted(self.pool, key=lambda e: e["name"])
                if user_id == self.user_id and e["name"] > after_name]
        return rows[:limit]

    async def page_custom_file_refs(self, user_id, after, limit):
        custom = {e["name"] for e in self.pool if e["type"] == "custom"}
        rows = [{"skill_name": k[0], "path": k[1], "encoding": v[1]}
                for k, v in sorted(self.files.items())
                if user_id == self.user_id and k[0] in custom and k > after]
        return rows[:limit]

    async def read_custom_file_slice(self, user_id, name, path, start, length):
        return self.files[(name, path)][0][start - 1:start - 1 + length]

    async def page_assignments(self, user_id, after, limit):
        rows = [{"agent_slug": a, "skill_name": n, "assigned_at": NOW}
                for a, n in sorted(self.assignments) if (a, n) > after]
        return rows[:limit]


class FakeWorkflows:
    """``WorkflowStore``'s export pages over a list of workflows and versions."""

    def __init__(self, user_id, workflows, versions):
        self.user_id, self.workflows, self.versions = user_id, workflows, versions

    async def page_workflows(self, user_id, after_id, limit):
        rows = [w for w in self.workflows if user_id == self.user_id and w["id"] > after_id]
        return sorted(rows, key=lambda w: w["id"])[:limit]

    async def page_versions(self, user_id, after, limit):
        rows = [v for v in self.versions if user_id == self.user_id and (v["workflow_id"], v["version_no"]) > after]
        return sorted(rows, key=lambda v: (v["workflow_id"], v["version_no"]))[:limit]


PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(60))


def _pool_entry(name, type_, **extra):
    return {"name": name, "type": type_, "description": f"{name} skill", "category": "",
            "origin": "user", "created_by_agent": None, "added_at": NOW, **extra}


@pytest.fixture()
def export(agents_service, monkeypatch):
    mod = agents_service.data_export
    definitions = FakeDefinitions(
        "u1",
        {f"bot-{i}": {"name": f"Bot {i}"} for i in range(5)},
        {("bot-0", "AGENT.md"): ("You are bot zero. " * 10, "utf-8"),
         ("bot-1", "assets/logo.png"): (base64.b64encode(PNG).decode(), "base64")},
        [_version("bot-0", 1, "created"), _version("bot-0", 2, "saved", ["instructions"], based_on=1),
         # A row from before a restore stopped adding a version.
         _version("bot-0", 3, "restored", ["instructions"], restored_from=1),
         _version("bot-1", 1, "baseline"), _version("bot-1", 2, "saved", ["details"], based_on=1)],
    )
    skills = FakeSkills(
        "u1",
        [_pool_entry("notes", "custom"),
         _pool_entry("cudf", "remote", source_id="nvidia", source_commit="c" * 40, licence="Apache-2.0")],
        {("notes", "SKILL.md"): ("---\nname: notes\n---\nBody.", "utf-8"),
         ("cudf", "SKILL.md"): ("THIRD-PARTY CONTENT", "utf-8")},
        [("bot-0", "notes")],
    )
    monkeypatch.setattr(mod, "get_memory_pool", lambda: object())
    monkeypatch.setattr(mod, "AgentDefinitionStore", lambda pool: definitions)
    monkeypatch.setattr(mod, "SkillStore", lambda pool: skills)
    workflows = FakeWorkflows(
        "u1",
        [{"id": f"wf-{i}", "name": f"Flow {i}", "description": "", "latest_version_no": 1,
          "draft": {"name": f"Flow {i}"}, "created_at": NOW, "updated_at": NOW} for i in range(3)],
        [{"workflow_id": "wf-0", "version_no": n, "spec": {"name": "Flow 0"}, "created_at": NOW} for n in (1, 2, 3)],
    )
    monkeypatch.setattr(mod, "WorkflowStore", lambda pool: workflows)
    monkeypatch.setattr(mod, "PAGE_ROWS", 2)            # force real paging
    monkeypatch.setattr(mod, "SLICE_CHARS", 8)          # force real slicing (multiple of 4)
    return mod


async def _frames(mod, user_id="u1"):
    return [json.loads(line) async for chunk in mod.stream_user_export(user_id)
            for line in chunk.decode().splitlines()]


def _files(frames):
    """Reassemble the frames the way the bridge does: path -> bytes."""
    out, path, enc = {}, None, None
    for f in frames:
        if f["op"] == "open":
            path, enc = f["path"], f["encoding"]
            out[path] = b""
        elif f["op"] == "data":
            out[path] += base64.b64decode(f["text"], validate=True) if enc == "base64" else f["text"].encode()
        elif f["op"] == "close":
            path = None
    return out


@pytest.mark.asyncio
async def test_every_definition_and_file_arrives_once_across_pages(export):
    frames = await _frames(export)
    files = _files(frames)
    agents = [json.loads(l) for l in files["agents/agents.ndjson"].decode().splitlines()]
    assert [a["slug"] for a in agents] == [f"bot-{i}" for i in range(5)]
    assert files["agents/bot-0/AGENT.md"].decode() == "You are bot zero. " * 10
    assert files["agents/bot-1/assets/logo.png"] == PNG


@pytest.mark.asyncio
async def test_every_kept_version_arrives_whole_once_across_pages(export):
    """Version history goes out as one record per version — spec and files
    inline, so a restore point can be read back without the live agent."""
    files = _files(await _frames(export))
    versions = [json.loads(line) for line in files["agents/versions.ndjson"].decode().splitlines()]
    assert [(v["slug"], v["version"]) for v in versions] == [
        ("bot-0", 1), ("bot-0", 2), ("bot-0", 3), ("bot-1", 1), ("bot-1", 2),
    ]
    restored = versions[2]
    assert restored["kind"] == "restored" and restored["restored_from"] == 1
    assert restored["changes"] == ["instructions"]
    assert restored["spec"] == {"name": "bot-0 v3"}
    assert restored["files"] == {"AGENT.md": {"content": "Prompt 3.", "encoding": "utf-8"}}
    assert versions[3]["kind"] == "baseline"
    assert [v["based_on"] for v in versions] == [None, 1, None, None, 1]


@pytest.mark.asyncio
async def test_each_base64_slice_decodes_on_its_own(export):
    frames = await _frames(export)
    in_png = False
    for f in frames:
        if f["op"] == "open":
            in_png = f["path"].endswith("logo.png")
        elif f["op"] == "data" and in_png:
            base64.b64decode(f["text"], validate=True)        # never a split quantum
            assert len(f["text"]) <= export.SLICE_CHARS


@pytest.mark.asyncio
async def test_remote_skills_are_references_never_content(export):
    files = _files(await _frames(export))
    skills = {s["name"]: s for s in map(json.loads, files["skills/skills.ndjson"].decode().splitlines())}
    remote = skills["cudf"]
    assert remote["type"] == "remote" and remote["licence"] == "Apache-2.0"
    assert remote["upstream_url"].startswith("https://github.com/NVIDIA/skills/tree/" + "c" * 40)
    assert "skills/cudf/SKILL.md" not in files
    assert b"THIRD-PARTY CONTENT" not in b"".join(files.values())
    assert files["skills/notes/SKILL.md"].startswith(b"---\nname: notes")
    assert json.loads(files["skills/assignments.ndjson"]) ["skill_name"] == "notes"


@pytest.mark.asyncio
async def test_the_stream_ends_with_an_end_frame_and_counts(export):
    frames = await _frames(export)
    assert frames[-1]["op"] == "end"
    assert frames[-1]["counts"] == {
        "agents": 5, "agent_files": 2, "agent_versions": 5,
        "skills": 2, "skill_files": 1, "assignments": 1,
        "workflows": 3, "workflow_versions": 3,
    }
    # Every open is closed before the next opens.
    depth = 0
    for f in frames:
        depth += {"open": 1, "close": -1}.get(f["op"], 0)
        assert depth in (0, 1)
    assert depth == 0


@pytest.mark.asyncio
async def test_another_user_gets_an_empty_but_complete_stream(export):
    files = _files(await _frames(export, user_id="someone-else"))
    assert files["agents/agents.ndjson"] == b"" and files["skills/skills.ndjson"] == b""
    assert files["agents/versions.ndjson"] == b""
    assert files["workflows/definitions/workflows.ndjson"] == b""
    assert files["workflows/definitions/versions.ndjson"] == b""
    assert not [p for p in files if p.count("/") > 1 and not p.startswith("workflows/definitions/")]


@pytest.mark.asyncio
async def test_the_route_is_internal_only(client, export, internal_headers):
    assert (await client.get("/users/u1/export")).status_code == 403
    response = await client.get("/users/u1/export", headers=internal_headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert json.loads(response.text.splitlines()[-1])["op"] == "end"


@pytest.mark.asyncio
async def test_workflow_definitions_and_versions_are_exported(export):
    files = _files(await _frames(export))
    workflows = [json.loads(line) for line in files["workflows/definitions/workflows.ndjson"].decode().splitlines()]
    versions = [json.loads(line) for line in files["workflows/definitions/versions.ndjson"].decode().splitlines()]
    assert [w["id"] for w in workflows] == ["wf-0", "wf-1", "wf-2"]
    assert workflows[0]["draft"] == {"name": "Flow 0"}
    assert [(v["workflow_id"], v["version"]) for v in versions] == [("wf-0", 1), ("wf-0", 2), ("wf-0", 3)]
