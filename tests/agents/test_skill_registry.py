"""The skill registry: the catalogue index, and the validation that guards a pool.

Two halves, split by what each still owns now that storage moved into
``agent_runtime``:

* **``global_manifest``** still walks a real directory. The catalogue is
  build-time content, seeded from the image and shared by every user, so it
  stays on the volume — these tests keep using the ``skills_fs`` tmp tree.
* **``user_registry``** owns no files any more. What is left is the part that was
  never about storage: path/size/type validation, strict base64, name conflicts
  and canonical frontmatter assembly. Those run against an in-memory stand-in
  for the store, so every rule is pinned with no database involved.

The store's own behaviour is pinned in ``test_skill_store.py``; the SQL behind it
is exercised against real Postgres by the integration check in the same commit.
"""
from __future__ import annotations

import base64
import shutil

import pytest
import yaml


# ---------------------------------------------------------------------------
# global_manifest
# ---------------------------------------------------------------------------
def test_rebuild_global_manifest_indexes_two_level_layout(skills_fs):
    gm = skills_fs.service.global_manifest
    manifest = gm.rebuild_global_manifest()

    names = sorted(e.name for e in manifest.skills)
    assert names == ["deep-research", "design-system"]
    entry = next(e for e in manifest.skills if e.name == "deep-research")
    assert entry.type == "global"
    assert entry.category == "research"
    assert entry.source_path == "global/research/deep-research"
    assert gm.is_global_skill("deep-research") is True
    assert gm.is_global_skill("not-a-skill") is False


def test_get_global_manifest_rebuilds_when_cache_empty(skills_fs):
    gm = skills_fs.service.global_manifest
    gm._MANIFEST_CACHE = None
    manifest = gm.get_global_manifest()
    assert {e.name for e in manifest.skills} == {"deep-research", "design-system"}
    assert gm._MANIFEST_CACHE is manifest
    # Second call returns the cached object without rescanning.
    assert gm.get_global_manifest() is manifest


def test_scan_global_registry_skips_stray_and_missing_skill_md(skills_fs):
    gm = skills_fs.service.global_manifest
    # Stray SKILL.md directly under a category dir — logged, ignored.
    (skills_fs.global_root / "research" / "SKILL.md").write_text("---\nname: stray\n---\nx", encoding="utf-8")
    # Skill dir with no SKILL.md — skipped.
    (skills_fs.global_root / "research" / "empty-skill").mkdir(parents=True, exist_ok=True)
    # A plain file at the global root — not a category dir, skipped.
    (skills_fs.global_root / "loose.txt").write_text("ignore me", encoding="utf-8")

    entries = gm._scan_global_registry()
    names = sorted(e.name for e in entries)
    assert names == ["deep-research", "design-system"]


def test_scan_global_registry_missing_root_returns_empty(skills_fs):
    gm = skills_fs.service.global_manifest
    # Repoint the whole global plane at a path that doesn't exist, so the
    # derived catalogue root (<plane>/skills) is missing too.
    skills_fs.service.settings_module.settings.filesystem.global_root = skills_fs.global_root / "does-not-exist"
    assert gm._scan_global_registry() == []


def test_parse_frontmatter_variants(skills_fs):
    gm = skills_fs.service.global_manifest
    skill_dir = skills_fs.global_root / "misc" / "frontmatter-skill"
    skill_dir.mkdir(parents=True, exist_ok=True)
    md = skill_dir / "SKILL.md"

    # No frontmatter → falls back to directory name.
    md.write_text("just a body, no frontmatter", encoding="utf-8")
    name, desc = gm._parse_frontmatter(md)
    assert name == "frontmatter-skill"
    assert desc == ""

    # Unterminated frontmatter → falls back to directory name.
    md.write_text("---\nname: x\n", encoding="utf-8")
    name, desc = gm._parse_frontmatter(md)
    assert name == "frontmatter-skill"

    # Full frontmatter → overrides.
    md.write_text("---\nname: real-name\ndescription: a desc\nother: ignored\n---\nbody", encoding="utf-8")
    name, desc = gm._parse_frontmatter(md)
    assert name == "real-name"
    assert desc == "a desc"


def test_parse_frontmatter_read_failure_returns_dir_name(skills_fs):
    gm = skills_fs.service.global_manifest
    # Point at a directory (not a file) so read_text raises OSError.
    missing = skills_fs.global_root / "ghost" / "SKILL.md"
    name, desc = gm._parse_frontmatter(missing)
    assert name == "ghost"
    assert desc == ""


# ---------------------------------------------------------------------------
# The registry, over the in-memory store from conftest
# ---------------------------------------------------------------------------
def _payload(service, name, description="A custom skill", extra_files=None):
    schemas = service.schemas
    files = [schemas.SkillFile(path="SKILL.md", content="custom body", encoding="utf-8")]
    for path, content, encoding in extra_files or []:
        files.append(schemas.SkillFile(path=path, content=content, encoding=encoding))
    return schemas.CustomSkillCreate(name=name, description=description, files=files)


# ---------------------------------------------------------------------------
# The pool — global entries
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_adding_a_global_skill_stores_a_pointer_not_a_copy(ur):
    entry = await ur.add_global_to_user("user-1", "deep-research")
    assert entry.type == "global"
    assert entry.source_path == "global/research/deep-research"

    # The point of the model: no content was written for it anywhere.
    assert ur.store.files == {}
    assert [s.name for s in await ur.list_user_skills("user-1")] == ["deep-research"]
    assert await ur.list_user_skill_names("user-1") == ["deep-research"]


@pytest.mark.asyncio
async def test_a_catalogue_skill_that_does_not_exist_is_a_miss_not_a_conflict(ur):
    """The route maps ``FileNotFoundError`` to 404 and every other ``ValueError``
    to 409 — and ``SkillNameConflict`` is a ``ValueError``. Raising one here
    answered "already in your pool" for a name the catalogue never had."""
    with pytest.raises(FileNotFoundError):
        await ur.add_global_to_user("user-1", "no-such-skill")


@pytest.mark.asyncio
async def test_adding_the_same_global_twice_is_a_conflict(ur):
    await ur.add_global_to_user("user-1", "deep-research")
    with pytest.raises(ur.SkillNameConflict):
        await ur.add_global_to_user("user-1", "deep-research")


@pytest.mark.asyncio
async def test_a_global_entry_reads_its_body_from_the_catalogue(ur):
    await ur.add_global_to_user("user-1", "deep-research")
    detail = await ur.get_user_skill_detail("user-1", "deep-research")
    assert detail.type == "global"
    assert detail.category == "research"
    assert "deep research" in detail.content
    assert any(f.path == "SKILL.md" for f in detail.files)


@pytest.mark.asyncio
async def test_opening_a_skill_the_user_does_not_hold_is_a_404_not_a_500(ur):
    """Returning ``None`` fails response validation against a non-Optional
    ``response_model``, so a missing skill surfaced as a 500."""
    with pytest.raises(FileNotFoundError):
        await ur.get_user_skill_detail("user-1", "deep-research")


@pytest.mark.asyncio
async def test_a_global_entry_whose_catalogue_folder_vanished_still_lists(ur, skills_fs):
    # A catalogue entry can disappear between image builds while a user still
    # references it. The pool row must survive with no files rather than raise.
    await ur.add_global_to_user("user-1", "deep-research")
    shutil.rmtree(skills_fs.global_root / "research" / "deep-research")

    detail = await ur.get_user_skill_detail("user-1", "deep-research")
    assert detail.files == []


# ---------------------------------------------------------------------------
# The pool — custom skills
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_creating_a_custom_skill_stores_every_file_with_its_encoding(ur, skills_fs):
    png_b64 = base64.b64encode(b"\x89PNG fake").decode("ascii")
    payload = _payload(skills_fs.service, "my-skill", extra_files=[
        ("references/notes.md", "some notes", "utf-8"),
        ("assets/logo.png", png_b64, "base64"),
    ])
    entry = await ur.add_custom_to_user("user-1", payload)
    assert entry.type == "custom"
    assert entry.source_path == "users/user-1/custom/my-skill"

    detail = await ur.get_user_skill_detail("user-1", "my-skill")
    assert "custom body" in detail.content
    assert {"SKILL.md", "references/notes.md", "assets/logo.png"} <= {f.path for f in detail.files}
    # The binary asset keeps its encoding rather than being decoded as text.
    logo = next(f for f in detail.files if f.path == "assets/logo.png")
    assert logo.encoding == "base64"
    assert base64.b64decode(logo.content) == b"\x89PNG fake"


@pytest.mark.asyncio
async def test_frontmatter_is_rebuilt_from_the_name_and_description(ur, skills_fs):
    """Assembled with ``yaml.safe_dump``, not interpolated: a description holding
    a colon or a quote would otherwise change how the whole block parses — and
    ``create_skill`` lets an *agent* supply both values."""
    schemas = skills_fs.service.schemas
    payload = schemas.CustomSkillCreate(
        name="tricky",
        description='Reads: "notes" and more',
        files=[schemas.SkillFile(
            path="SKILL.md",
            content="---\nname: lies\ndescription: lies\n---\n\nReal body.",
            encoding="utf-8",
        )],
    )
    await ur.add_custom_to_user("user-1", payload)

    raw = ur.store.files[("user-1", "tricky")]["SKILL.md"][0]
    front = yaml.safe_load(raw.split("---")[1])
    assert front == {"name": "tricky", "description": 'Reads: "notes" and more'}
    # The author's body survives; only the frontmatter is replaced.
    assert "Real body." in raw


@pytest.mark.asyncio
async def test_a_name_already_in_the_pool_is_refused(ur, skills_fs):
    await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "dup"))
    with pytest.raises(ur.SkillNameConflict):
        await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "dup"))


@pytest.mark.asyncio
async def test_a_name_that_shadows_a_catalogue_skill_is_refused(ur, skills_fs):
    # Shadowing would make the same name resolve differently per user.
    with pytest.raises(ur.SkillNameConflict):
        await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "deep-research"))


@pytest.mark.asyncio
async def test_a_skill_with_no_files_is_refused(ur, skills_fs):
    schemas = skills_fs.service.schemas
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", schemas.CustomSkillCreate(name="empty", files=[]))


@pytest.mark.asyncio
async def test_a_skill_without_a_skill_md_is_refused(ur, skills_fs):
    # SKILL.md is the only file discovery reads; without it the skill is a folder
    # the agent can see and can never act on.
    schemas = skills_fs.service.schemas
    payload = schemas.CustomSkillCreate(
        name="no-entry",
        files=[schemas.SkillFile(path="notes.md", content="x", encoding="utf-8")],
    )
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", payload)


@pytest.mark.asyncio
async def test_too_many_files_is_refused(ur, skills_fs):
    schemas = skills_fs.service.schemas
    files = [schemas.SkillFile(path="SKILL.md", content="body", encoding="utf-8")]
    files += [schemas.SkillFile(path=f"f{i}.md", content="x", encoding="utf-8")
              for i in range(ur._MAX_SKILL_FILES)]
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", schemas.CustomSkillCreate(name="too-many", files=files))


@pytest.mark.asyncio
async def test_a_duplicate_path_in_one_payload_is_refused(ur, skills_fs):
    schemas = skills_fs.service.schemas
    payload = schemas.CustomSkillCreate(
        name="dup-path",
        files=[
            schemas.SkillFile(path="SKILL.md", content="body", encoding="utf-8"),
            schemas.SkillFile(path="notes.md", content="a", encoding="utf-8"),
            schemas.SkillFile(path="notes.md", content="b", encoding="utf-8"),
        ],
    )
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", payload)


@pytest.mark.asyncio
async def test_malformed_base64_is_refused_rather_than_silently_truncated(ur, skills_fs):
    payload = _payload(skills_fs.service, "bad-b64",
                       extra_files=[("img.png", "!!!not base64!!!", "base64")])
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", payload)


@pytest.mark.asyncio
async def test_a_bad_skill_name_is_refused(ur, skills_fs):
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "../escape"))


@pytest.mark.asyncio
async def test_nothing_is_written_when_one_file_in_the_payload_is_bad(ur, skills_fs):
    """Validation runs over the whole payload before the first write, so a bad
    file cannot leave a half-created skill in the pool."""
    payload = _payload(skills_fs.service, "partial",
                       extra_files=[("ok.md", "fine", "utf-8"), ("bad.png", "@@@", "base64")])
    with pytest.raises(ur.SkillValidationError):
        await ur.add_custom_to_user("user-1", payload)
    assert ur.store.pool == {}
    assert ur.store.files == {}


def test_relative_paths_are_validated_before_they_become_keys(ur):
    for bad in ["", "../escape.md", "a/b/c/d/e/f.md", "script.exe", "../../etc/passwd"]:
        with pytest.raises(ur.SkillValidationError):
            ur._validate_skill_relpath(bad)
    # Backslashes normalise, and a valid nested path is accepted.
    assert ur._validate_skill_relpath("references\\api.md").as_posix() == "references/api.md"


# ---------------------------------------------------------------------------
# Assignment (tier ②) and removal
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_assigning_a_skill_the_user_does_not_hold_is_a_miss(ur):
    """A 404, not a 400: the route maps ``ValueError`` to 400, and "you do not
    have this skill" is the same answer as "there is no such skill"."""
    with pytest.raises(FileNotFoundError):
        await ur.assign_user_skill_to_agent("user-1", "omni", "never-added")


@pytest.mark.asyncio
async def test_assignment_is_per_agent(ur, skills_fs):
    await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "my-skill"))
    await ur.assign_user_skill_to_agent("user-1", "omni", "my-skill")

    assert await ur.list_user_agent_skills("user-1", "omni") == ["my-skill"]
    assert await ur.list_user_agent_skills("user-1", "other") == []


@pytest.mark.asyncio
async def test_unassigning_leaves_the_pool_entry_alone(ur, skills_fs):
    # Switching a skill off for one agent must not remove it from the pool — the
    # user still holds it and can switch it on elsewhere.
    await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "my-skill"))
    await ur.assign_user_skill_to_agent("user-1", "omni", "my-skill")
    await ur.unassign_user_skill_from_agent("user-1", "omni", "my-skill")

    assert await ur.list_user_agent_skills("user-1", "omni") == []
    assert [s.name for s in await ur.list_user_skills("user-1")] == ["my-skill"]


@pytest.mark.asyncio
async def test_removing_from_the_pool_cascades_to_every_assignment(ur, skills_fs):
    """An assignment outliving its pool entry would mount a skill folder that
    resolves to no files — visible to the agent, unreadable."""
    await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "my-skill"))
    await ur.assign_user_skill_to_agent("user-1", "omni", "my-skill")
    await ur.assign_user_skill_to_agent("user-1", "other", "my-skill")

    await ur.remove_from_user("user-1", "my-skill")

    assert [s.name for s in await ur.list_user_skills("user-1")] == []
    assert await ur.list_user_agent_skills("user-1", "omni") == []
    assert await ur.list_user_agent_skills("user-1", "other") == []


@pytest.mark.asyncio
async def test_removing_a_global_entry_never_touches_the_shared_catalogue(ur, skills_fs):
    await ur.add_global_to_user("user-1", "deep-research")
    await ur.remove_from_user("user-1", "deep-research")

    assert [s.name for s in await ur.list_user_skills("user-1")] == []
    assert (skills_fs.global_root / "research" / "deep-research" / "SKILL.md").is_file()


@pytest.mark.asyncio
async def test_removing_a_skill_the_user_never_held_is_not_an_error(ur):
    # Idempotent: the Skills tab can fire a delete the user already completed.
    await ur.remove_from_user("user-1", "ghost")


# ---------------------------------------------------------------------------
# The provisioner, now that skills are not directories
# ---------------------------------------------------------------------------
def test_safe_segment_rejects_traversal(skills_fs):
    prov = skills_fs.service.provisioner
    for bad in ["", "a/b", "a\\b", "..", ".hidden"]:
        with pytest.raises(ValueError):
            prov._safe_segment(bad)
    assert prov._safe_segment("ok-id") == "ok-id"


def test_first_contact_creates_no_memory_or_skill_tree(skills_fs):
    """Both moved into ``agent_runtime``. The provisioner used to mint an empty
    ``skills/`` here and seed ``memory/entries/``; a directory it still created
    would be re-created after every prune and read by nothing."""
    prov = skills_fs.service.provisioner
    prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="omni")

    agent_dir = prov.agent_root("user-1", "omni")
    assert not (agent_dir / "skills").exists()
    assert not (agent_dir / "default_skills").exists()
    assert not (agent_dir / "memory").exists()


def test_a_bad_agent_slug_is_rejected_even_though_no_directory_bears_it(skills_fs):
    # The slug stopped being a path component on this call; validating it anyway
    # keeps the failure here rather than deeper in, where it becomes a DB key.
    prov = skills_fs.service.provisioner
    with pytest.raises(ValueError):
        prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="../escape")


def test_first_contact_with_a_conversation_creates_its_working_dir(skills_fs):
    prov = skills_fs.service.provisioner
    prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="omni", conversation_id="conv-1")
    assert prov.conversation_root("user-1", "omni", "conv-1").is_dir()
