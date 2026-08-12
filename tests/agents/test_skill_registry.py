from __future__ import annotations

import base64

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _custom_payload(service, name: str, description: str = "A custom skill", extra_files=None):
    schemas = service.schemas
    files = [schemas.SkillFile(path="SKILL.md", content="custom body", encoding="utf-8")]
    for path, content, encoding in extra_files or []:
        files.append(schemas.SkillFile(path=path, content=content, encoding=encoding))
    return schemas.CustomSkillCreate(name=name, description=description, files=files)


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
    skills_fs.service.main.settings.filesystem.global_root = skills_fs.global_root / "does-not-exist"
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
# user_registry — add global / list / detail
# ---------------------------------------------------------------------------
def test_add_global_to_user_appends_reference(skills_fs):
    ur = skills_fs.service.user_registry
    entry = ur.add_global_to_user("user-1", "deep-research")
    assert entry.type == "global"
    assert entry.source_path == "global/research/deep-research"

    names = [s.name for s in ur.list_user_skills("user-1")]
    assert names == ["deep-research"]
    assert list(ur.list_user_skill_names("user-1")) == ["deep-research"]


def test_add_global_to_user_unknown_skill_raises(skills_fs):
    ur = skills_fs.service.user_registry
    with pytest.raises(FileNotFoundError):
        ur.add_global_to_user("user-1", "no-such-skill")


def test_add_global_to_user_duplicate_raises(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_global_to_user("user-1", "deep-research")
    with pytest.raises(ValueError):
        ur.add_global_to_user("user-1", "deep-research")


def test_get_user_skill_detail_for_global(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_global_to_user("user-1", "deep-research")
    detail = ur.get_user_skill_detail("user-1", "deep-research")
    assert detail.type == "global"
    assert detail.category == "research"
    assert "deep research" in detail.content
    assert any(f.path == "SKILL.md" for f in detail.files)


def test_get_user_skill_detail_missing_raises(skills_fs):
    ur = skills_fs.service.user_registry
    ur.ensure_user_registry("user-1")
    with pytest.raises(FileNotFoundError):
        ur.get_user_skill_detail("user-1", "deep-research")


def test_resolve_skill_path_global_folder_missing(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_global_to_user("user-1", "deep-research")
    # Remove the backing global folder on disk.
    import shutil

    shutil.rmtree(skills_fs.global_root / "research" / "deep-research")
    with pytest.raises(FileNotFoundError):
        ur.resolve_skill_path("user-1", "deep-research")


# ---------------------------------------------------------------------------
# user_registry — custom skills
# ---------------------------------------------------------------------------
def test_add_custom_to_user_creates_folder_and_entry(skills_fs):
    ur = skills_fs.service.user_registry
    png_b64 = base64.b64encode(b"\x89PNG fake").decode("ascii")
    payload = _custom_payload(
        skills_fs.service,
        "my-skill",
        extra_files=[
            ("references/notes.md", "some notes", "utf-8"),
            ("assets/logo.png", png_b64, "base64"),
        ],
    )
    entry = ur.add_custom_to_user("user-1", payload)
    assert entry.type == "custom"
    assert entry.source_path == "users/user-1/custom/my-skill"

    skill_dir = skills_fs.pool("user-1") / "custom" / "my-skill"
    assert (skill_dir / "SKILL.md").read_text(encoding="utf-8").startswith("---\nname: my-skill")
    assert (skill_dir / "references" / "notes.md").is_file()
    assert (skill_dir / "assets" / "logo.png").read_bytes() == b"\x89PNG fake"

    detail = ur.get_user_skill_detail("user-1", "my-skill")
    assert "custom body" in detail.content
    paths = {f.path for f in detail.files}
    assert {"SKILL.md", "references/notes.md", "assets/logo.png"} <= paths


def test_add_custom_to_user_name_conflict_with_existing_pool(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "dup"))
    with pytest.raises(ur.SkillNameConflict):
        ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "dup"))


def test_add_custom_to_user_name_conflict_with_global(skills_fs):
    ur = skills_fs.service.user_registry
    with pytest.raises(ur.SkillNameConflict):
        ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "deep-research"))


def test_add_custom_to_user_folder_already_exists(skills_fs):
    ur = skills_fs.service.user_registry
    ur.ensure_user_registry("user-1")
    (skills_fs.pool("user-1") / "custom" / "ghost").mkdir(parents=True, exist_ok=True)
    with pytest.raises(ur.SkillNameConflict):
        ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "ghost"))


def test_add_custom_to_user_requires_files(skills_fs):
    ur = skills_fs.service.user_registry
    schemas = skills_fs.service.schemas
    with pytest.raises(ur.SkillValidationError):
        ur.add_custom_to_user("user-1", schemas.CustomSkillCreate(name="empty", files=[]))


def test_add_custom_to_user_requires_skill_md(skills_fs):
    ur = skills_fs.service.user_registry
    schemas = skills_fs.service.schemas
    payload = schemas.CustomSkillCreate(
        name="no-entry",
        files=[schemas.SkillFile(path="notes.md", content="x", encoding="utf-8")],
    )
    with pytest.raises(ur.SkillValidationError):
        ur.add_custom_to_user("user-1", payload)


def test_add_custom_to_user_too_many_files(skills_fs):
    ur = skills_fs.service.user_registry
    schemas = skills_fs.service.schemas
    files = [schemas.SkillFile(path="SKILL.md", content="body", encoding="utf-8")]
    files += [schemas.SkillFile(path=f"f{i}.md", content="x", encoding="utf-8") for i in range(ur._MAX_SKILL_FILES)]
    payload = schemas.CustomSkillCreate(name="too-many", files=files)
    with pytest.raises(ur.SkillValidationError):
        ur.add_custom_to_user("user-1", payload)


def test_add_custom_to_user_duplicate_path(skills_fs):
    ur = skills_fs.service.user_registry
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
        ur.add_custom_to_user("user-1", payload)


def test_add_custom_to_user_invalid_base64(skills_fs):
    ur = skills_fs.service.user_registry
    payload = _custom_payload(
        skills_fs.service,
        "bad-b64",
        extra_files=[("img.png", "!!!not base64!!!", "base64")],
    )
    with pytest.raises(ur.SkillValidationError):
        ur.add_custom_to_user("user-1", payload)


def test_validate_skill_relpath_rejections(skills_fs):
    ur = skills_fs.service.user_registry
    for bad in ["", "../escape.md", "a/b/c/d/e/f.md", "script.exe", "../../etc/passwd"]:
        with pytest.raises(ur.SkillValidationError):
            ur._validate_skill_relpath(bad)
    # Backslashes normalize and a valid nested path is accepted.
    ok = ur._validate_skill_relpath("references\\api.md")
    assert ok.as_posix() == "references/api.md"


def test_add_custom_to_user_bad_name(skills_fs):
    ur = skills_fs.service.user_registry
    with pytest.raises(ur.SkillValidationError):
        ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "../escape"))


# ---------------------------------------------------------------------------
# user_registry — removal + cascade
# ---------------------------------------------------------------------------
def test_remove_custom_skill_deletes_folder_and_cascades(skills_fs):
    ur = skills_fs.service.user_registry
    prov = skills_fs.service.provisioner
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "my-skill"))
    ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="my-skill")

    assigned = prov.agent_root("user-1", "omni") / "skills" / "my-skill"
    assert assigned.is_dir()

    ur.remove_from_user("user-1", "my-skill")

    assert [s.name for s in ur.list_user_skills("user-1")] == []
    assert not (skills_fs.pool("user-1") / "custom" / "my-skill").exists()
    assert not assigned.exists()


def test_remove_global_skill_keeps_global_folder(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_global_to_user("user-1", "deep-research")
    ur.remove_from_user("user-1", "deep-research")
    assert [s.name for s in ur.list_user_skills("user-1")] == []
    # The shared global folder is never deleted by a per-user removal.
    assert (skills_fs.global_root / "research" / "deep-research").is_dir()


def test_remove_missing_skill_is_idempotent(skills_fs):
    ur = skills_fs.service.user_registry
    ur.ensure_user_registry("user-1")
    ur.remove_from_user("user-1", "never-existed")  # no raise
    assert [s.name for s in ur.list_user_skills("user-1")] == []


# ---------------------------------------------------------------------------
# user_registry — manifest persistence + reconciliation
# ---------------------------------------------------------------------------
def test_read_user_manifest_missing_returns_empty(skills_fs):
    ur = skills_fs.service.user_registry
    manifest = ur.read_user_manifest("never-seen")
    assert manifest.skills == []


def test_read_user_manifest_corrupt_returns_empty(skills_fs):
    ur = skills_fs.service.user_registry
    ur.ensure_user_registry("user-1")
    (skills_fs.pool("user-1") / "manifest.json").write_text("{ not json", encoding="utf-8")
    manifest = ur.read_user_manifest("user-1")
    assert manifest.skills == []


def test_reconcile_adopts_orphan_and_drops_missing(skills_fs):
    ur = skills_fs.service.user_registry
    # Custom entry in the pool whose folder we then delete (should be dropped).
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "vanishing"))
    import shutil

    shutil.rmtree(skills_fs.pool("user-1") / "custom" / "vanishing")

    # Orphan folder on disk not present in the manifest (should be adopted).
    orphan = skills_fs.pool("user-1") / "custom" / "orphan"
    orphan.mkdir(parents=True, exist_ok=True)
    (orphan / "SKILL.md").write_text("---\nname: orphan\ndescription: found\n---\nbody", encoding="utf-8")

    healed = ur.reconcile_user_manifest("user-1")
    names = {s.name for s in healed.skills}
    assert names == {"orphan"}


def test_reconcile_all_user_manifests_walks_users(skills_fs):
    ur = skills_fs.service.user_registry
    ur.add_global_to_user("user-1", "deep-research")
    ur.add_custom_to_user("user-2", _custom_payload(skills_fs.service, "k2"))
    # A stray file at the users-root level must be ignored (not a user dir).
    (skills_fs.users_root / "stray.txt").write_text("x", encoding="utf-8")

    ur.reconcile_all_user_manifests()  # no raise

    assert [s.name for s in ur.list_user_skills("user-1")] == ["deep-research"]
    assert [s.name for s in ur.list_user_skills("user-2")] == ["k2"]


def test_reconcile_all_user_manifests_creates_root_when_missing(skills_fs):
    ur = skills_fs.service.user_registry
    # A fresh workspaces plane: its `users/` root must be created on demand.
    fresh_plane = skills_fs.users_root.parent.parent / "fresh-workspaces"
    skills_fs.service.main.settings.filesystem.workspaces_root = fresh_plane
    fresh = fresh_plane / "users"
    assert not fresh.exists()
    ur.reconcile_all_user_manifests()
    assert fresh.is_dir()


# ---------------------------------------------------------------------------
# provisioner
# ---------------------------------------------------------------------------
def test_safe_segment_rejects_traversal(skills_fs):
    prov = skills_fs.service.provisioner
    for bad in ["", "a/b", "a\\b", "..", ".hidden"]:
        with pytest.raises(ValueError):
            prov._safe_segment(bad)
    assert prov._safe_segment("ok-id") == "ok-id"


def test_ensure_user_agent_filesystem_seeds_agents_md(skills_fs):
    prov = skills_fs.service.provisioner
    prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="omni")
    agents_md = prov.memory_index_path("user-1", "omni")
    assert agents_md.is_file()
    original = agents_md.read_text(encoding="utf-8")

    # A second call must never overwrite an edited AGENTS.md.
    agents_md.write_text("user edits", encoding="utf-8")
    prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="omni")
    assert agents_md.read_text(encoding="utf-8") == "user edits"
    assert original  # template was non-empty

    assert prov.skills_root("user-1", "omni").is_dir()
    assert prov.memory_entries_root("user-1", "omni").is_dir()


def test_ensure_user_agent_filesystem_with_conversation(skills_fs):
    prov = skills_fs.service.provisioner
    prov.ensure_user_agent_filesystem(user_id="user-1", agent_slug="omni", conversation_id="conv-1")
    assert prov.conversation_root("user-1", "omni", "conv-1").is_dir()


def test_list_enabled_skills_reflects_assignments(skills_fs):
    ur = skills_fs.service.user_registry
    prov = skills_fs.service.provisioner

    # No skills assigned yet → empty (directory does not exist).
    assert prov.list_enabled_skills("user-1", "omni") == []

    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "alpha"))
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "beta"))
    ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="beta")
    ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="alpha")

    assert prov.list_enabled_skills("user-1", "omni") == ["alpha", "beta"]

    # Idempotent re-assign is a no-op.
    ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="alpha")
    assert prov.list_enabled_skills("user-1", "omni") == ["alpha", "beta"]


def test_disable_skill_removes_and_is_idempotent(skills_fs):
    ur = skills_fs.service.user_registry
    prov = skills_fs.service.provisioner
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "alpha"))
    ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="alpha")

    prov.disable_skill(user_id="user-1", agent_slug="omni", skill_name="alpha")
    assert prov.list_enabled_skills("user-1", "omni") == []

    # Removing again is a no-op.
    prov.disable_skill(user_id="user-1", agent_slug="omni", skill_name="alpha")


def test_assign_unknown_skill_raises_file_not_found(skills_fs):
    ur = skills_fs.service.user_registry
    ur.ensure_user_registry("user-1")
    with pytest.raises(FileNotFoundError):
        ur.assign_user_skill_to_agent(user_id="user-1", agent_slug="omni", skill_name="not-in-pool")


# ---------------------------------------------------------------------------
# sync_agent_default_skills — tier ① for a user-authored agent
# ---------------------------------------------------------------------------
def test_sync_default_skills_copies_from_the_pool(skills_fs):
    ur = skills_fs.service.user_registry
    layout = skills_fs.service.filesystem_layout
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "alpha"))

    resolved = ur.sync_agent_default_skills(
        user_id="user-1", agent_slug="styler", skill_names=["alpha"]
    )

    assert resolved == ["alpha"]
    root = layout.agent_default_skills_root("user-1", "styler")
    assert (root / "alpha" / "SKILL.md").is_file()


def test_sync_default_skills_is_separate_from_the_enabled_tier(skills_fs):
    """The two tiers must not share a directory — that separation is what makes a
    default skill impossible to remove via the per-agent disable endpoint."""
    ur = skills_fs.service.user_registry
    prov = skills_fs.service.provisioner
    layout = skills_fs.service.filesystem_layout
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "alpha"))
    ur.sync_agent_default_skills(user_id="user-1", agent_slug="styler", skill_names=["alpha"])

    # The default is not an "enabled" skill, and disabling it cannot touch it.
    assert prov.list_enabled_skills("user-1", "styler") == []
    prov.disable_skill(user_id="user-1", agent_slug="styler", skill_name="alpha")
    assert (layout.agent_default_skills_root("user-1", "styler") / "alpha").is_dir()


def test_sync_default_skills_prunes_undeclared_and_skips_missing(skills_fs):
    ur = skills_fs.service.user_registry
    layout = skills_fs.service.filesystem_layout
    ur.add_custom_to_user("user-1", _custom_payload(skills_fs.service, "alpha"))
    ur.sync_agent_default_skills(user_id="user-1", agent_slug="styler", skill_names=["alpha"])

    # Re-saving with a different list prunes the old copy; a name that is not in
    # the pool is skipped rather than failing the save.
    resolved = ur.sync_agent_default_skills(
        user_id="user-1", agent_slug="styler", skill_names=["not-in-pool"]
    )

    assert resolved == []
    root = layout.agent_default_skills_root("user-1", "styler")
    assert sorted(p.name for p in root.iterdir()) == []
