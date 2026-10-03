"""The daily remote-skill sync, over a fake network and an in-memory store.

Every outbound call goes through ``httpx.MockTransport``, so CI makes no
network request at all. What is pinned is the cost model and the fail-closed
behaviour the plan was built on (plan 30, §3.2):

* an unchanged source costs **zero** REST calls and zero file reads;
* a new commit that touched no skill costs one tree call and zero reads;
* a changed ``SKILL.md`` costs exactly one read;
* a truncated tree or a failed read keeps the previous catalogue — a sync
  never empties or half-updates a source;
* a skill that disappears upstream is withdrawn, not deleted.
"""
from __future__ import annotations

import hashlib
import json

import httpx
import pytest

SHA_A, SHA_B = "a" * 40, "b" * 40


def blob_sha(body: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(body) + body).hexdigest()


def skill_md(name: str, description: str = "Does a thing", licence: str | None = "MIT") -> bytes:
    lic = f"\nlicense: {licence}" if licence else ""
    return f"---\nname: {name}\ndescription: {description}{lic}\n---\nBody of {name}.".encode()


def refs_body(branch_sha: str, branch: str = "main") -> bytes:
    def pkt(text: bytes) -> bytes:
        return b"%04x" % (len(text) + 4) + text
    return (pkt(b"# service=git-upload-pack\n") + b"0000"
            + pkt(branch_sha.encode() + b" refs/heads/" + branch.encode() + b"\n") + b"0000")


class FakeGitHub:
    """One repo at a commit, served the way GitHub serves it.

    ``files`` maps repo paths to bytes; the tree is derived from them so blob
    SHAs are always right unless a test corrupts a body on purpose.
    """

    def __init__(self, repo: str, commit: str, files: dict[str, bytes]):
        self.repo, self.commit, self.files = repo, commit, dict(files)
        self.truncated = False
        self.served_override: dict[str, bytes] = {}
        self.fail_paths: set[str] = set()
        self.calls: list[str] = []

    def tree(self):
        return {
            "sha": "t", "truncated": self.truncated,
            "tree": [{"path": p, "type": "blob", "mode": "100644", "sha": blob_sha(b), "size": len(b)}
                     for p, b in sorted(self.files.items())],
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        if url.endswith(f"github.com/{self.repo}.git/info/refs?service=git-upload-pack"):
            return httpx.Response(200, content=refs_body(self.commit))
        if url.startswith(f"https://api.github.com/repos/{self.repo}/git/trees/{self.commit}"):
            return httpx.Response(200, json=self.tree())
        prefix = f"https://raw.githubusercontent.com/{self.repo}/{self.commit}/"
        if url.startswith(prefix):
            path = url[len(prefix):]
            if path in self.fail_paths:
                return httpx.Response(500)
            body = self.served_override.get(path, self.files.get(path))
            return httpx.Response(200, content=body) if body is not None else httpx.Response(404)
        return httpx.Response(404)

    def count(self, kind: str) -> int:
        marks = {"rest": "api.github.com", "raw": "raw.githubusercontent.com", "refs": "info/refs"}
        return sum(1 for url in self.calls if marks[kind] in url)


@pytest.fixture()
def env(agents_service, skill_store_memory):
    sync = agents_service.remote_sync
    client_mod = agents_service.remote_client
    sources = agents_service.remote_sources
    # The dict-backed store twin from conftest.
    store = skill_store_memory

    async def run(source_id: str, gh: FakeGitHub):
        source = sources.get_source(source_id)
        async with client_mod.RemoteSkillClient(httpx.MockTransport(gh.handler)) as client:
            return await sync.sync_source(store, client, source)

    return type("Env", (), {"run": staticmethod(run), "store": store, "sync": sync, "sources": sources})


def nvidia(files: dict[str, bytes], commit: str = SHA_A) -> FakeGitHub:
    return FakeGitHub("NVIDIA/skills", commit, files)


BASE = {
    "skills/cudf/SKILL.md": skill_md("cudf"),
    "skills/cudf/references/api.md": b"api notes",
    "skills/cudf/.env": b"SECRET=1",                    # hidden: never in the manifest
    "skills/plain/SKILL.md": skill_md("plain", licence=None),
    "skills/plain/LICENSE": b"Apache License\nVersion 2.0, January 2004",
    "skills/nolicence/SKILL.md": skill_md("nolicence", licence=None),
    "skills/Bad_Name/SKILL.md": skill_md("Bad_Name"),
    "README.md": b"not a skill",
}


# ---------------------------------------------------------------------------
# A first sync
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_first_sync_indexes_admits_and_refuses(env):
    gh = nvidia(BASE)
    outcome = await env.run("nvidia", gh)

    assert outcome.status == "synced"
    rows = {k[1]: v for k, v in env.store.catalogue.items()}
    assert rows["cudf"]["refusal"] is None and rows["cudf"]["licence"] == "MIT"
    assert rows["plain"]["refusal"] is None and rows["plain"]["licence"] == "Apache-2.0"
    assert rows["nolicence"]["refusal"] == "no licence"
    assert rows["Bad_Name"]["refusal"] == "invalid name"
    # One REST call (the tree), and the refs read costs none.
    assert gh.count("rest") == 1
    # The manifest is what an Add will fetch: visible files only, with SHAs.
    manifest = env.store.manifests[("nvidia", "cudf")]
    assert [path for path, _, _ in manifest] == ["SKILL.md", "references/api.md"]
    # Refused skills get no manifest: nothing could fetch them.
    assert ("nvidia", "nolicence") not in env.store.manifests


@pytest.mark.asyncio
async def test_an_unchanged_source_costs_nothing(env):
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    gh.calls.clear()

    outcome = await env.run("nvidia", gh)
    assert outcome.status == "unchanged"
    assert gh.count("rest") == 0 and gh.count("raw") == 0
    assert gh.count("refs") == 1


@pytest.mark.asyncio
async def test_a_new_commit_that_touched_no_skill_reads_nothing(env):
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    gh.commit = SHA_B
    gh.calls.clear()

    outcome = await env.run("nvidia", gh)
    assert outcome.status == "synced" and outcome.reads == 0
    assert gh.count("rest") == 1 and gh.count("raw") == 0
    # The rows now point at the new commit, metadata reused.
    assert env.store.catalogue[("nvidia", "cudf")]["source_ref"] == SHA_B
    assert env.store.catalogue[("nvidia", "cudf")]["licence"] == "MIT"


@pytest.mark.asyncio
async def test_a_changed_skill_md_is_the_only_file_read(env):
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    gh.files["skills/cudf/SKILL.md"] = skill_md("cudf", description="Now does more")
    gh.commit = SHA_B
    gh.calls.clear()

    outcome = await env.run("nvidia", gh)
    assert outcome.reads == 1
    assert env.store.catalogue[("nvidia", "cudf")]["description"] == "Now does more"


@pytest.mark.asyncio
async def test_a_skill_that_disappears_upstream_is_withdrawn_not_deleted(env):
    """Users who hold it keep their pinned copy; nobody new can add it."""
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    del gh.files["skills/cudf/SKILL.md"], gh.files["skills/cudf/references/api.md"]
    gh.commit = SHA_B
    await env.run("nvidia", gh)

    row = env.store.catalogue[("nvidia", "cudf")]
    assert row["withdrawn_at"] is not None


# ---------------------------------------------------------------------------
# Failing closed
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_truncated_tree_keeps_the_previous_catalogue(env):
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    before = {k: dict(v) for k, v in env.store.catalogue.items()}
    gh.truncated, gh.commit = True, SHA_B

    outcome = await env.run("nvidia", gh)
    assert outcome.status == "failed" and outcome.error == "tree truncated"
    assert env.store.catalogue == before
    assert env.store.sources["nvidia"]["last_error"] == "tree truncated"


@pytest.mark.asyncio
async def test_a_read_that_fails_after_its_retry_aborts_the_whole_source(env):
    """A partial pass would mislabel or withdraw skills that merely timed out."""
    gh = nvidia(BASE)
    await env.run("nvidia", gh)
    before = {k: dict(v) for k, v in env.store.catalogue.items()}
    gh.files["skills/cudf/SKILL.md"] = skill_md("cudf", description="changed")
    gh.fail_paths = {"skills/cudf/SKILL.md"}
    gh.commit = SHA_B
    gh.calls.clear()

    outcome = await env.run("nvidia", gh)
    assert outcome.status == "failed"
    assert env.store.catalogue == before
    # It was tried twice: one retry, then the abort.
    assert sum(1 for url in gh.calls if url.endswith("skills/cudf/SKILL.md")) == 2


@pytest.mark.asyncio
async def test_bytes_that_do_not_match_the_tree_abort_the_source(env):
    gh = nvidia(BASE)
    gh.served_override = {"skills/cudf/SKILL.md": skill_md("cudf", description="tampered")}
    outcome = await env.run("nvidia", gh)
    assert outcome.status == "failed" and outcome.error == "checksum mismatch"
    assert env.store.catalogue == {}


@pytest.mark.asyncio
async def test_a_failed_pass_is_retried_even_at_the_same_commit(env):
    gh = nvidia(BASE)
    gh.truncated = True
    await env.run("nvidia", gh)
    gh.truncated = False
    outcome = await env.run("nvidia", gh)
    assert outcome.status == "synced"


# ---------------------------------------------------------------------------
# A source with its own index (sickn33)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_publisher_risk_label_is_filtered_before_any_read(env):
    index = [
        {"id": "safe-one", "path": "skills/safe-one", "risk": "safe", "category": "dev"},
        {"id": "danger", "path": "skills/danger", "risk": "critical"},
        {"id": "elsewhere", "path": "plugins/elsewhere", "risk": "safe"},
    ]
    files = {
        "skills_index.json": json.dumps(index).encode(),
        "skills/safe-one/SKILL.md": skill_md("safe-one"),
        "skills/danger/SKILL.md": skill_md("danger"),
        "skills/unindexed/SKILL.md": skill_md("unindexed"),
    }
    gh = FakeGitHub("sickn33/agentic-awesome-skills", SHA_A, files)
    outcome = await env.run("sickn33", gh)

    rows = {k[1]: v for k, v in env.store.catalogue.items()}
    assert rows["safe-one"]["refusal"] is None and rows["safe-one"]["category"] == "dev"
    assert rows["danger"]["refusal"] == "risk=critical"
    assert "unindexed" not in rows and "elsewhere" not in rows
    # Only the safe skill's SKILL.md was read; the critical one never was.
    assert not any(url.endswith("skills/danger/SKILL.md") for url in gh.calls)
    assert outcome.refused["outside the skills folder"] == 1


# ---------------------------------------------------------------------------
# .well-known publishers
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_well_known_entries_need_a_digest_and_an_allowlisted_url(env, agents_service):
    digest = "sha256:" + "0" * 64
    index = {"skills": [
        {"name": "deploy", "type": "archive", "url": "https://github.com/vercel/x/releases/download/v1/deploy.tar.gz", "digest": digest, "description": "Deploy"},
        {"name": "relative", "type": "skill-md", "url": "/.well-known/agent-skills/relative/SKILL.md", "digest": digest},
        {"name": "nodigest", "type": "archive", "url": "https://github.com/x.tar.gz"},
        {"name": "offlist", "type": "archive", "url": "https://evil.example/x.tar.gz", "digest": digest},
        {"name": "weird", "type": "zip", "url": "https://github.com/x.zip", "digest": digest},
    ]}

    def handler(request):
        return httpx.Response(200, json=index)

    source = env.sources.get_source("vercel")
    async with agents_service.remote_client.RemoteSkillClient(httpx.MockTransport(handler)) as client:
        outcome = await env.sync.sync_source(env.store, client, source)

    rows = {k[1]: v for k, v in env.store.catalogue.items()}
    assert rows["deploy"]["refusal"] is None
    # Relative URLs resolve against the publisher's own origin.
    assert rows["relative"]["artifact_url"] == "https://vercel.com/.well-known/agent-skills/relative/SKILL.md"
    assert rows["nodigest"]["refusal"] == "no sha256 digest"
    assert rows["offlist"]["refusal"] == "host not allowed"
    assert rows["weird"]["refusal"] == "unsupported artifact"
    assert outcome.admitted == 2
