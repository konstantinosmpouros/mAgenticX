"""The rules a remote skill must pass before anyone can see it (plan 30).

Everything in ``remote/sources.py`` is a pure function, so each gate is pinned
here with no network and no database. These are the checks that fail *silently*
when they break — a skill that should have been refused is simply offered —
which is why each one gets its own case rather than one happy path.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def src(agents_service):
    return agents_service.remote_sources


# ---------------------------------------------------------------------------
# Hosts
# ---------------------------------------------------------------------------
def test_only_https_to_an_allowlisted_host_on_the_default_port(src):
    assert src.is_allowed_url("https://raw.githubusercontent.com/NVIDIA/skills/abc/skills/x/SKILL.md")
    assert src.is_allowed_url("https://release-assets.githubusercontent.com/x")
    assert src.is_allowed_url("https://developers.cloudflare.com/.well-known/agent-skills/a.tar.gz")
    for bad in (
        "http://raw.githubusercontent.com/x",          # plaintext
        "https://evil.example.com/x",                  # not on the list
        "https://raw.githubusercontent.com:8443/x",    # odd port
        "https://user:pw@github.com/x",                # credentials in the URL
        "https://github.com.evil.example/x",           # suffix trick
        "file:///etc/passwd",
        "javascript:alert(1)",
    ):
        assert not src.is_allowed_url(bad), bad


def test_the_allowlist_is_github_plus_each_publisher_and_nothing_else(src):
    assert src.ALLOWED_HOSTS == {
        "github.com", "api.github.com", "raw.githubusercontent.com",
        "release-assets.githubusercontent.com", "objects.githubusercontent.com",
        "vercel.com", "supabase.com", "developers.cloudflare.com", "agentskills.io",
    }


# ---------------------------------------------------------------------------
# Names and paths
# ---------------------------------------------------------------------------
def test_skill_names_follow_the_agent_skills_rule_in_ascii(src):
    for good in ("pdf", "react-performance", "a1-b2"):
        assert src.is_valid_skill_name(good)
    for bad in ("", "-lead", "trail-", "double--hyphen", "Caps", "under_score", "dot.name",
                "café", "x" * 65, "../escape"):
        assert not src.is_valid_skill_name(bad), bad


def test_paths_inside_a_skill_must_stay_inside_it(src):
    assert src.check_rel_path("references/api.md") is None
    for bad in ("/abs.md", "../up.md", "a/../b.md", "a//b.md", "a\\b.md", "./x.md", "x\x00.md"):
        assert src.check_rel_path(bad) == "unsafe path", bad
    assert src.check_rel_path("/".join(["d"] * 6) + "/f.md") == "path too deep"
    assert src.check_rel_path("bin/tool.exe") == "contains an executable"
    assert src.check_rel_path("scripts/run.sh") is None   # scripts are allowed, inert


def test_hidden_files_are_never_stored(src):
    assert src.is_hidden(".env")
    assert src.is_hidden(".github/workflows/x.yml")
    assert src.is_hidden("scripts/.secret")
    assert not src.is_hidden("references/api.md")


def test_file_set_caps(src):
    ok = [("SKILL.md", 100), ("a.md", 100)]
    assert src.check_file_set(ok) is None
    assert src.check_file_set([("a.md", 1)]) == "no SKILL.md"
    assert src.check_file_set([("SKILL.md", 1)] + [(f"f{i}.md", 1) for i in range(128)]) == "too many files"
    assert src.check_file_set([("SKILL.md", src.MAX_REMOTE_FILE_BYTES + 1)]) == "file too large"
    big = src.MAX_REMOTE_FILE_BYTES
    assert src.check_file_set([("SKILL.md", 1)] + [(f"f{i}.bin.md", big) for i in range(5)]) == "skill too large"


# ---------------------------------------------------------------------------
# SKILL.md
# ---------------------------------------------------------------------------
def _md(front: str, body: str = "Body.") -> bytes:
    return f"---\n{front}\n---\n{body}".encode("utf-8")


def test_a_skill_md_the_agent_would_load_is_admitted(src):
    check = src.check_skill_md(_md("name: pdf\ndescription: Read PDFs\nlicense: MIT"), "pdf")
    assert check.refusal is None
    assert (check.name, check.description, check.declared_licence) == ("pdf", "Read PDFs", "MIT")


@pytest.mark.parametrize("raw, reason", [
    (b"no frontmatter at all", "no frontmatter"),
    (b"---\nname: [unclosed\n---\nx", "invalid frontmatter"),
    (b"---\n- a list\n---\nx", "invalid frontmatter"),
    (b"---\nname: pdf\n---\nx", "frontmatter missing name or description"),
    (b"---\nname: other\ndescription: d\n---\nx", "name does not match folder"),
    (b"\xff\xfe not utf-8", "SKILL.md is not UTF-8"),
])
def test_a_skill_md_the_agent_would_skip_is_refused(src, raw, reason):
    """deepagents silently skips these at run time; a user would read that as
    "Add did nothing", so they are refused before they are ever shown."""
    assert src.check_skill_md(raw, "pdf").refusal == reason


def test_a_long_description_is_cut_to_what_the_middleware_keeps(src):
    check = src.check_skill_md(_md("name: pdf\ndescription: " + "x" * 2000), "pdf")
    assert len(check.description) == src.MAX_SKILL_DESCRIPTION_LENGTH


# ---------------------------------------------------------------------------
# Licences
# ---------------------------------------------------------------------------
APACHE_TEXT = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/"
MIT_TEXT = "MIT License\n\nCopyright (c) 2025 X. All rights reserved.\n\nPermission is hereby granted, free of charge, to any person"
PROPRIETARY_TEXT = "© 2025 Anthropic, PBC. All rights reserved.\nLICENSE: governed by your agreement with Anthropic"


def test_licence_expressions_are_normalised_and_every_term_must_be_permitted(src):
    assert src.normalise_licence_expression("MIT") == "MIT"
    assert src.normalise_licence_expression("Apache 2.0") == "Apache-2.0"
    assert src.normalise_licence_expression("CC-BY-4.0 AND Apache-2.0") == "CC-BY-4.0 AND Apache-2.0"
    assert src.normalise_licence_expression("MIT OR Apache-2.0") == "MIT OR Apache-2.0"
    assert src.normalise_licence_expression("MIT AND SomethingElse") is None   # one unknown term fails all
    assert src.normalise_licence_expression("Complete terms in LICENSE.txt") is None


def test_licence_decisions_per_skill(src):
    per_skill = src.get_source("nvidia")
    cases = [
        ("MIT", None, (True, "MIT", "ok")),
        ("Complete terms in LICENSE.txt", APACHE_TEXT, (True, "Apache-2.0", "ok")),
        (None, MIT_TEXT, (True, "MIT", "ok")),                    # "All rights reserved" in an MIT file is fine
        ("Proprietary. LICENSE.txt has complete terms", APACHE_TEXT, (False, None, "licence forbids reuse")),
        ("Complete terms in LICENSE.txt", PROPRIETARY_TEXT, (False, None, "licence forbids reuse")),
        ("Complete terms in LICENSE.txt", "Some bespoke wording", (False, None, "licence not recognised")),
        ("Weird-Custom-1.0", None, (False, None, "licence not recognised")),
        (None, None, (False, None, "no licence")),
    ]
    for declared, text, (admitted, licence, reason) in cases:
        verdict = src.evaluate_licence(per_skill, declared, text)
        assert (verdict.admitted, verdict.reason) == (admitted, reason), (declared, text)
        if admitted:
            assert verdict.licence == licence


def test_only_a_repo_rule_source_falls_back_to_its_repo_licence(src):
    assert src.evaluate_licence(src.get_source("ecc"), None, None).licence == "MIT"
    # sickn33 aggregates third-party skills: its repo licence covers none of them.
    assert src.evaluate_licence(src.get_source("sickn33"), None, None).reason == "no licence"
    # An explicit forbidding declaration beats the repo fallback.
    assert not src.evaluate_licence(src.get_source("ecc"), "Proprietary", None).admitted


def test_a_publisher_hosted_skill_is_admitted_without_a_licence_of_its_own(src):
    verdict = src.evaluate_licence(src.get_source("vercel"), None, None)
    assert verdict.admitted and verdict.licence is None


def test_needs_licence_file_only_when_the_frontmatter_cannot_settle_it(src):
    assert src.needs_licence_file(None)
    assert src.needs_licence_file("Complete terms in LICENSE.txt")
    assert not src.needs_licence_file("MIT")
    assert not src.needs_licence_file("Proprietary")     # already decided: refused


# ---------------------------------------------------------------------------
# Risk, upstream links, the ref advertisement
# ---------------------------------------------------------------------------
def test_the_publisher_risk_label_excludes_before_anything_is_read(src):
    sickn33 = src.get_source("sickn33")
    assert src.risk_refusal(sickn33, "safe") is None
    assert src.risk_refusal(sickn33, "none") is None
    assert src.risk_refusal(sickn33, "critical") == "risk=critical"
    assert src.risk_refusal(sickn33, None) == "risk=unknown"
    # A source with no risk labels is not filtered on one.
    assert src.risk_refusal(src.get_source("nvidia"), None) is None


def test_upstream_links_pin_the_commit_not_the_branch(src):
    url = src.upstream_url(src.get_source("nvidia"), "cudf", "a" * 40)
    assert url == f"https://github.com/NVIDIA/skills/tree/{'a' * 40}/skills/cudf"
    assert src.upstream_url(src.get_source("vercel"), "x", "sha256:abc").endswith("/agent-skills/index.json")


def test_the_branch_commit_is_read_from_the_git_ref_advertisement(agents_service):
    parse = agents_service.remote_client.parse_ref_advertisement
    sha_main, sha_dev = "a" * 40, "b" * 40

    def pkt(text: bytes) -> bytes:
        return b"%04x" % (len(text) + 4) + text

    body = (
        pkt(b"# service=git-upload-pack\n") + b"0000"
        + pkt(sha_dev.encode() + b" HEAD\x00multi_ack symref=HEAD:refs/heads/dev\n")
        + pkt(sha_main.encode() + b" refs/heads/main\n")
        + pkt(sha_dev.encode() + b" refs/heads/dev\n")
        + b"0000"
    )
    assert parse(body, "main") == sha_main
    assert parse(body, "dev") == sha_dev
    assert parse(body, "missing") is None
    assert parse(b"zzzz garbage", "main") is None
