"""The remote skill sources, and every rule a remote skill must pass.

This module is **policy, kept in code on purpose**. Which hosts the service may
reach, which publishers it indexes, and what a skill must look like to be shown
to a user are security decisions; putting them in env config would let a
deployment widen them without review, and an editable source URL is an SSRF
lever. Adding a source is a code change.

The rules here are pure functions with no I/O, so the sync and the Add path apply
exactly the same checks and a test can pin each one without a network.

Three kinds of source (plan 30, §3.1):

* ``github-tree`` — a repo whose skills are ``<root>/<name>/SKILL.md``.
* ``github-index`` — the same, plus a publisher-maintained JSON index that
  carries a ``risk`` field we filter on before reading anything.
* ``well-known`` — a publisher's ``/.well-known/agent-skills/index.json``
  (agentskills.io discovery v0.2): each entry points at an archive or a single
  ``SKILL.md`` with a mandatory sha256 digest.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Literal, Optional
from urllib.parse import urlsplit

import yaml

SourceKind = Literal["github-tree", "github-index", "well-known"]
LicenceRule = Literal["per-skill", "repo", "publisher"]

@dataclass(frozen=True)
class RemoteSource:
    """One allowlisted publisher.

    ``repo`` is ``owner/name`` for the GitHub kinds; ``index_url`` is the
    discovery document for ``well-known``. ``risk_allow`` is set only for a
    source whose index labels each skill's risk — anything outside it is
    refused before a single file is read.
    """

    source_id: str
    label: str
    kind: SourceKind
    licence_rule: LicenceRule
    homepage: str
    repo: Optional[str] = None
    branch: str = "main"
    skills_root: str = "skills"
    index_path: Optional[str] = None
    index_url: Optional[str] = None
    repo_licence: Optional[str] = None
    risk_allow: Optional[frozenset[str]] = None
    #: Extra hosts this source's artifacts may be served from (well-known only).
    artifact_hosts: frozenset[str] = field(default_factory=frozenset)


#: The allowlist. Order is the order the sync visits them in.
SOURCES: tuple[RemoteSource, ...] = (
    RemoteSource(
        source_id="nvidia",
        label="NVIDIA/skills",
        kind="github-tree",
        repo="NVIDIA/skills",
        licence_rule="per-skill",
        homepage="https://github.com/NVIDIA/skills",
    ),
    RemoteSource(
        source_id="anthropic",
        label="anthropics/skills",
        kind="github-tree",
        repo="anthropics/skills",
        licence_rule="per-skill",
        homepage="https://github.com/anthropics/skills",
    ),
    RemoteSource(
        source_id="ecc",
        label="affaan-m/ECC",
        kind="github-tree",
        repo="affaan-m/ECC",
        # The repo mirrors its own skills under docs/, .kiro/, .cursor/ and
        # others; only skills/ is the canonical copy.
        skills_root="skills",
        # ECC's skills read as first-party content under the repo's MIT
        # licence (plan 30, §12 decision 5). If it turns out to aggregate other
        # people's skills, switch this to "per-skill" like sickn33.
        licence_rule="repo",
        repo_licence="MIT",
        homepage="https://github.com/affaan-m/ECC",
    ),
    RemoteSource(
        source_id="sickn33",
        label="sickn33/agentic-awesome-skills",
        kind="github-index",
        repo="sickn33/agentic-awesome-skills",
        index_path="skills_index.json",
        # An aggregator of third-party skills: the repo's MIT licence does not
        # cover what it collected, so only a skill's own licence counts.
        licence_rule="per-skill",
        risk_allow=frozenset({"safe", "none"}),
        homepage="https://github.com/sickn33/agentic-awesome-skills",
    ),
    RemoteSource(
        source_id="vercel",
        label="vercel.com",
        kind="well-known",
        index_url="https://vercel.com/.well-known/agent-skills/index.json",
        licence_rule="publisher",
        homepage="https://vercel.com",
    ),
    RemoteSource(
        source_id="supabase",
        label="supabase.com",
        kind="well-known",
        index_url="https://supabase.com/.well-known/agent-skills/index.json",
        licence_rule="publisher",
        homepage="https://supabase.com",
    ),
    RemoteSource(
        source_id="cloudflare",
        label="developers.cloudflare.com",
        kind="well-known",
        index_url="https://developers.cloudflare.com/.well-known/agent-skills/index.json",
        licence_rule="publisher",
        homepage="https://developers.cloudflare.com",
    ),
    RemoteSource(
        source_id="agentskills",
        label="agentskills.io",
        kind="well-known",
        index_url="https://agentskills.io/.well-known/agent-skills/index.json",
        licence_rule="publisher",
        homepage="https://agentskills.io",
    ),
)

_BY_ID = {source.source_id: source for source in SOURCES}


def get_source(source_id: str) -> Optional[RemoteSource]:
    """The allowlisted source with this id, or ``None``."""
    return _BY_ID.get(source_id)


def source_label(source_id: str) -> str:
    """Human label for a source id; the id itself for one no longer allowlisted."""
    source = _BY_ID.get(source_id)
    return source.label if source else source_id


# ---------------------------------------------------------------------------
# Hosts
# ---------------------------------------------------------------------------
#: GitHub's own hosts. ``release-assets`` is where a release download redirects
#: (measured 2026-10-01); ``objects`` is the older redirect target, kept so a
#: change on GitHub's side back to it does not break every archive.
_GITHUB_HOSTS = frozenset({
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
})


def _well_known_hosts() -> frozenset[str]:
    hosts: set[str] = set()
    for source in SOURCES:
        if source.index_url:
            hosts.add(urlsplit(source.index_url).hostname or "")
        hosts.update(source.artifact_hosts)
    hosts.discard("")
    return frozenset(hosts)


#: Every host an outbound request may reach, redirects included.
ALLOWED_HOSTS: frozenset[str] = _GITHUB_HOSTS | _well_known_hosts()


def is_allowed_url(url: str) -> bool:
    """HTTPS to an allowlisted host, on the default port, with no credentials.

    Checked on the first request **and on every redirect hop**, so a redirect
    can never lead the service somewhere the allowlist does not name.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password:
        return False
    if parts.port not in (None, 443):
        return False
    return (parts.hostname or "") in ALLOWED_HOSTS


# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------
# Remote skills get their own caps, not the custom-skill ones: the spike found
# today's 30-file custom cap would refuse 64 skills in these sources, while
# median sizes are 8-66 KB and p99 is at most ~1 MB (plan 30, §2.2). These admit
# everything at p99 and refuse the outliers.
MAX_REMOTE_SKILL_FILES = 128
MAX_REMOTE_SKILL_DEPTH = 6
MAX_REMOTE_FILE_BYTES = 2 * 1024 * 1024
MAX_REMOTE_SKILL_BYTES = 8 * 1024 * 1024

# Ceilings on the documents a sync downloads. Generous against the measured
# sizes (largest tree 10.8 MB, largest index 1.9 MB) but finite, so a hostile
# or broken upstream cannot make the process buffer without bound.
MAX_TREE_BYTES = 32 * 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_REFS_BYTES = 4 * 1024 * 1024
MAX_WELL_KNOWN_INDEX_BYTES = 1 * 1024 * 1024
MAX_LICENCE_FILE_BYTES = 64 * 1024

# What deepagents' SkillsMiddleware will accept (it skips a skill silently
# otherwise), so a skill that would never load is refused up front.
MAX_SKILL_NAME_LENGTH = 64
MAX_SKILL_DESCRIPTION_LENGTH = 1024

# Binary executables have no business in a skill folder. Scripts are allowed —
# they are inert while `execute` is off and sandbox-only once it is not.
_EXECUTABLE_SUFFIXES = frozenset({
    ".exe", ".dll", ".so", ".dylib", ".bin", ".jar", ".class", ".pyc", ".pyo",
    ".apk", ".msi", ".dmg", ".deb", ".rpm", ".o", ".a", ".wasm",
})

_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def is_valid_skill_name(name: str) -> bool:
    """The Agent Skills name rule, restricted to ASCII.

    deepagents enforces lowercase alphanumerics with single hyphens and at most
    64 characters. ASCII-only on top keeps the name safe in a URL, a path and a
    log line without any escaping.
    """
    return bool(name) and len(name) <= MAX_SKILL_NAME_LENGTH and bool(_NAME_RE.match(name))


def is_hidden(rel_path: str) -> bool:
    """A path with any dot-segment (``.env``, ``.github/…``) — never stored."""
    return any(seg.startswith(".") for seg in rel_path.split("/"))


def check_rel_path(rel_path: str) -> Optional[str]:
    """Why a file path inside a skill is unsafe, or ``None`` when it is fine."""
    if not rel_path or rel_path.startswith("/") or "\\" in rel_path:
        return "unsafe path"
    if _CONTROL_RE.search(rel_path):
        return "unsafe path"
    segments = rel_path.split("/")
    if any(seg in ("", ".", "..") or len(seg) > 255 for seg in segments):
        return "unsafe path"
    if len(segments) > MAX_REMOTE_SKILL_DEPTH:
        return "path too deep"
    if PurePosixPath(segments[-1]).suffix.lower() in _EXECUTABLE_SUFFIXES:
        return "contains an executable"
    return None


def check_file_set(files: list[tuple[str, int]]) -> Optional[str]:
    """Why a skill's ``(path, size)`` list breaks the caps, or ``None``."""
    if len(files) > MAX_REMOTE_SKILL_FILES:
        return "too many files"
    total = 0
    for path, size in files:
        problem = check_rel_path(path)
        if problem:
            return problem
        if size > MAX_REMOTE_FILE_BYTES:
            return "file too large"
        total += size
    if total > MAX_REMOTE_SKILL_BYTES:
        return "skill too large"
    if "SKILL.md" not in {path for path, _ in files}:
        return "no SKILL.md"
    return None


# ---------------------------------------------------------------------------
# SKILL.md frontmatter
# ---------------------------------------------------------------------------
# The exact pattern deepagents uses. A frontmatter that does not match it is a
# skill the agent would skip, so it is refused here rather than shown.
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter_block(text: str) -> Optional[str]:
    """The raw YAML between the fences, or ``None`` when there is none."""
    match = _FRONTMATTER_RE.match(text)
    return match.group(1) if match else None


@dataclass(frozen=True)
class SkillMdCheck:
    """The outcome of reading one ``SKILL.md``.

    ``refusal`` is set when the file would not load as a skill, in which case
    the other fields are best-effort and must not be shown as authoritative.
    """

    refusal: Optional[str]
    name: str = ""
    description: str = ""
    declared_licence: Optional[str] = None


def check_skill_md(raw: bytes, skill_id: str) -> SkillMdCheck:
    """Whether ``SKILL.md`` is one the agent will actually load, and its metadata.

    Mirrors deepagents' own parse — same fence pattern, ``yaml.safe_load``, a
    non-empty ``name`` and ``description`` — because a skill that fails it is
    silently skipped at run time, which a user would read as "Add did nothing".
    Stricter in one way: the name must equal the folder. deepagents only warns,
    but a pool entry called one thing that the agent lists as another is a
    confusion this filter can simply refuse.
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return SkillMdCheck("SKILL.md is not UTF-8")
    block = parse_frontmatter_block(text)
    if block is None:
        return SkillMdCheck("no frontmatter")
    try:
        meta = yaml.safe_load(block)
    except yaml.YAMLError:
        return SkillMdCheck("invalid frontmatter")
    if not isinstance(meta, dict):
        return SkillMdCheck("invalid frontmatter")
    name = str(meta.get("name") or "").strip()
    description = " ".join(str(meta.get("description") or "").split())
    if not name or not description:
        return SkillMdCheck("frontmatter missing name or description", name, description)
    if name != skill_id:
        return SkillMdCheck("name does not match folder", name, description)
    declared = meta.get("license", meta.get("licence"))
    return SkillMdCheck(
        None,
        name,
        description[:MAX_SKILL_DESCRIPTION_LENGTH],
        declared.strip() if isinstance(declared, str) and declared.strip() else None,
    )


def upstream_url(source: RemoteSource, skill_id: str, commit: Optional[str]) -> str:
    """Where a user can read the skill upstream, at the exact version they hold.

    A GitHub skill links to its folder at the pinned commit — not the branch,
    which may have moved on. A ``.well-known`` skill links to the publisher's
    index, the only stable page it has.
    """
    if source.repo and commit:
        return f"https://github.com/{source.repo}/tree/{commit}/{source.skills_root}/{skill_id}"
    if source.repo:
        return f"https://github.com/{source.repo}/tree/{source.branch}/{source.skills_root}/{skill_id}"
    return source.index_url or source.homepage


# ---------------------------------------------------------------------------
# Licences
# ---------------------------------------------------------------------------
# A strict allowlist rather than a blocklist: an unrecognised licence is
# refused, because "probably fine" is not a property a filter can promise.
PERMITTED_LICENCES = frozenset({
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0",
    "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0", "Unlicense", "0BSD", "Zlib", "BSL-1.0",
})

_ALIASES = {
    "mit": "MIT",
    "mit license": "MIT",
    "the mit license": "MIT",
    "apache-2.0": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache license version 2.0": "Apache-2.0",
    "bsd-2-clause": "BSD-2-Clause",
    "bsd-3-clause": "BSD-3-Clause",
    "isc": "ISC",
    "mpl-2.0": "MPL-2.0",
    "cc-by-4.0": "CC-BY-4.0",
    "cc by 4.0": "CC-BY-4.0",
    "cc-by-sa-4.0": "CC-BY-SA-4.0",
    "cc0": "CC0-1.0",
    "cc0-1.0": "CC0-1.0",
    "unlicense": "Unlicense",
    "the unlicense": "Unlicense",
    "0bsd": "0BSD",
    "zlib": "Zlib",
    "bsl-1.0": "BSL-1.0",
}

# Wording that means the content may not be reused. Checked before anything is
# admitted — Anthropic's document skills say "Proprietary" in their frontmatter
# and "governed by your agreement with Anthropic" in their LICENSE.txt.
_FORBIDDING = (
    "proprietary",
    "all rights reserved",
    "governed by your agreement",
    "non-commercial",
    "noncommercial",
    "not for redistribution",
)

_EXPR_SPLIT = re.compile(r"\s+(?:and|or|with)\s+|[(),/]", re.IGNORECASE)

# Recognising a licence *file* by the text every copy of it carries.
_LICENCE_TEXT_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Apache-2.0", ("apache license", "version 2.0")),
    ("MIT", ("permission is hereby granted, free of charge",)),
    ("MPL-2.0", ("mozilla public license version 2.0",)),
    ("CC-BY-4.0", ("creative commons attribution 4.0",)),
    ("Unlicense", ("this is free and unencumbered software released into the public domain",)),
    ("ISC", ("permission to use, copy, modify, and/or distribute this software for any purpose",)),
)


@dataclass(frozen=True)
class LicenceVerdict:
    """The licence decision for one skill. ``licence`` is what the UI shows."""

    admitted: bool
    licence: Optional[str]
    reason: str


def normalise_licence_expression(declared: str) -> Optional[str]:
    """An SPDX-ish expression whose every term is permitted, normalised; else ``None``.

    ``"CC-BY-4.0 AND Apache-2.0"`` stays as written once both terms check out;
    ``"Apache 2.0"`` becomes ``"Apache-2.0"``. A single unknown term fails the
    whole expression — fail-closed.
    """
    terms = [t.strip() for t in _EXPR_SPLIT.split(declared) if t and t.strip()]
    if not terms:
        return None
    normalised: list[str] = []
    for term in terms:
        canonical = _ALIASES.get(term.lower())
        if canonical is None and term in PERMITTED_LICENCES:
            canonical = term
        if canonical is None:
            return None
        normalised.append(canonical)
    if len(normalised) == 1:
        return normalised[0]
    # Keep the publisher's operators but in canonical spelling.
    joiner = " OR " if re.search(r"\bor\b", declared, re.IGNORECASE) else " AND "
    return joiner.join(dict.fromkeys(normalised))


def forbids_reuse(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _FORBIDDING)


def detect_licence_text(text: str) -> Optional[str]:
    """Identify a LICENSE file by its standard wording, or ``None``."""
    lowered = " ".join(text.lower().split())
    for licence, markers in _LICENCE_TEXT_MARKERS:
        if all(marker in lowered for marker in markers):
            return licence
    if "redistribution and use in source and binary forms" in lowered:
        return "BSD-3-Clause" if "neither the name" in lowered else "BSD-2-Clause"
    return None


def needs_licence_file(declared: Optional[str]) -> bool:
    """Whether the frontmatter alone cannot settle the licence.

    True when nothing usable is declared, or the declaration points at a file
    ("Complete terms in LICENSE.txt") rather than naming a licence.
    """
    if not declared:
        return True
    if forbids_reuse(declared):
        return False
    return normalise_licence_expression(declared) is None


def evaluate_licence(
    source: RemoteSource,
    declared: Optional[str],
    licence_file_text: Optional[str],
) -> LicenceVerdict:
    """Decide whether a skill may be offered, and under which licence.

    Order matters: an explicit forbidding word wins over everything; then a
    permitted declaration; then the skill's own LICENSE file; then — only for a
    source whose repo licence covers its skills — that licence. Nothing else
    gets through.
    """
    if source.licence_rule == "publisher":
        # A publisher serving its own skills from its own domain for agents to
        # use: the discovery protocol is the grant. Shown as such in the UI.
        return LicenceVerdict(True, None, "ok")

    declared = (declared or "").strip()[:200] or None
    if declared and forbids_reuse(declared):
        return LicenceVerdict(False, declared, "licence forbids reuse")
    if declared:
        expression = normalise_licence_expression(declared)
        if expression:
            return LicenceVerdict(True, expression, "ok")
    if licence_file_text:
        detected = detect_licence_text(licence_file_text)
        if detected:
            return LicenceVerdict(True, detected, "ok")
        if forbids_reuse(licence_file_text):
            return LicenceVerdict(False, declared, "licence forbids reuse")
        return LicenceVerdict(False, declared, "licence not recognised")
    if source.licence_rule == "repo" and source.repo_licence:
        return LicenceVerdict(True, source.repo_licence, "ok")
    if declared:
        return LicenceVerdict(False, declared, "licence not recognised")
    return LicenceVerdict(False, None, "no licence")


def risk_refusal(source: RemoteSource, risk: Optional[str]) -> Optional[str]:
    """Why the publisher's own risk label excludes this skill, or ``None``."""
    if source.risk_allow is None:
        return None
    label = (risk or "unknown").strip().lower()
    return None if label in source.risk_allow else f"risk={label}"


__all__ = [
    "ALLOWED_HOSTS",
    "LicenceVerdict",
    "MAX_INDEX_BYTES",
    "MAX_LICENCE_FILE_BYTES",
    "MAX_REFS_BYTES",
    "MAX_REMOTE_FILE_BYTES",
    "MAX_REMOTE_SKILL_BYTES",
    "MAX_REMOTE_SKILL_DEPTH",
    "MAX_REMOTE_SKILL_FILES",
    "MAX_SKILL_DESCRIPTION_LENGTH",
    "MAX_TREE_BYTES",
    "MAX_WELL_KNOWN_INDEX_BYTES",
    "PERMITTED_LICENCES",
    "RemoteSource",
    "SOURCES",
    "SkillMdCheck",
    "check_file_set",
    "check_rel_path",
    "check_skill_md",
    "detect_licence_text",
    "evaluate_licence",
    "forbids_reuse",
    "get_source",
    "is_allowed_url",
    "is_hidden",
    "is_valid_skill_name",
    "needs_licence_file",
    "normalise_licence_expression",
    "parse_frontmatter_block",
    "risk_refusal",
    "source_label",
    "upstream_url",
]
