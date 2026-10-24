"""The skill registry: the validation that guards a user's pool.

``user_registry`` owns no files. What it does own is the part that was never
about storage: path/size/type validation, strict base64, name conflicts and
canonical frontmatter assembly. Those run against an in-memory stand-in for the
store, so every rule is pinned with no database involved.

The bundled catalogue is gone (plan 30). What survives of it is the **legacy**
``global`` pool entry — a pointer into the copy an older image left on the
volume — which must keep reading until it is pruned, and which nothing can
create any more. Remote skills, the catalogue's replacement, are pinned in the
``test_remote_skills_*`` files.

The store's own behaviour is pinned in ``test_skill_store.py``; the SQL behind it
is exercised against real Postgres by the integration check in the same commit.
"""
from __future__ import annotations

import base64
import shutil

import pytest
import yaml


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
# The pool — legacy global entries
# ---------------------------------------------------------------------------
async def _hold_legacy_global(ur, user_id="user-1", name="deep-research", category="research"):
    """Seed a pre-plan-30 pool row. No code path can create one any more."""
    await ur.store.add_global(user_id, name, category=category, description="Run deep research")


def test_no_code_path_can_add_a_global_skill_any_more(ur):
    # The bundled catalogue was deleted; adding from it must not be possible.
    assert not hasattr(ur, "add_global_to_user")


@pytest.mark.asyncio
async def test_a_legacy_global_entry_is_a_pointer_not_a_copy(ur):
    await _hold_legacy_global(ur)
    [entry] = await ur.list_user_skills("user-1")
    assert entry.type == "global"
    assert entry.source_path == "global/research/deep-research"
    assert entry.provenance is None
    # The point of the model: no content was written for it anywhere.
    assert ur.store.files == {}


@pytest.mark.asyncio
async def test_a_legacy_global_entry_still_reads_from_the_volume(ur):
    """What an older image seeded is still on the volume, and a user who added
    it before plan 30 must keep a working skill until it is pruned."""
    await _hold_legacy_global(ur)
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
async def test_a_legacy_entry_whose_folder_vanished_still_lists(ur, skills_fs):
    # The volume copy can be pruned while a user still references it. The pool
    # row must survive with no files rather than raise.
    await _hold_legacy_global(ur)
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
async def test_only_the_pool_can_refuse_a_custom_name(ur, skills_fs):
    """There is no bundled catalogue to shadow any more, so a name is refused
    only when the user already holds it — even one a legacy folder still bears."""
    entry = await ur.add_custom_to_user("user-1", _payload(skills_fs.service, "deep-research"))
    assert entry.type == "custom"


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
async def test_removing_a_legacy_entry_never_touches_the_volume_copy(ur, skills_fs):
    await _hold_legacy_global(ur)
    await ur.remove_from_user("user-1", "deep-research")

    assert [s.name for s in await ur.list_user_skills("user-1")] == []
    assert (skills_fs.global_root / "research" / "deep-research" / "SKILL.md").is_file()


@pytest.mark.asyncio
async def test_removing_a_skill_the_user_never_held_is_not_an_error(ur):
    # Idempotent: the Skills tab can fire a delete the user already completed.
    await ur.remove_from_user("user-1", "ghost")


# ---------------------------------------------------------------------------
# Path segments
# ---------------------------------------------------------------------------
def test_safe_segment_rejects_traversal(skills_fs):
    layout = skills_fs.service.filesystem_layout
    for bad in ["", "a/b", "a\\b", "..", ".hidden"]:
        with pytest.raises(ValueError):
            layout.safe_segment(bad)
    assert layout.safe_segment("ok-id") == "ok-id"
