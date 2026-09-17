from __future__ import annotations

import copy
import importlib
import os
import sys
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "magenticx" / "agents"

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("TRUSTED_PROXY_SECRET", "agents-test-secret")
os.environ.setdefault("MCP_GATEWAY_URL", "http://mcp.test/sse")

#: Fixed timestamp for fake store rows — the shape matters, the value does not.
STORE_NOW = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)


def _purge_modules_under_paths(*roots: str | Path) -> None:
    resolved_roots = [Path(root).resolve() for root in roots]

    for name, module in list(sys.modules.items()):
        file_path = getattr(module, "__file__", None)
        if not file_path:
            continue

        try:
            resolved_file = Path(file_path).resolve()
        except OSError:
            continue

        if any(root == resolved_file or root in resolved_file.parents for root in resolved_roots):
            sys.modules.pop(name, None)


def _load_agents_service(monkeypatch):
    _purge_modules_under_paths(ROOT / "magenticx" / "dialogue_bridge", ROOT / "magenticx" / "rag_service", ROOT / "magenticx" / "agents")

    monkeypatch.syspath_prepend(str(SERVICE_ROOT))

    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("TRUSTED_PROXY_SECRET", "agents-test-secret")
    monkeypatch.setenv("MCP_GATEWAY_URL", "http://mcp.test/sse")

    main_module = importlib.import_module("main")
    schemas_module = importlib.import_module("schema")
    prompts_module = importlib.import_module("utils.prompts")
    title_module = importlib.import_module("utils.title")
    mcp_tools_module = importlib.import_module("utils.mcp_tools")
    agents_utils_module = importlib.import_module("utils.agents")

    return SimpleNamespace(
        main=main_module,
        # Route handlers live in router/*.py; endpoint deps (AGENT_REGISTRY,
        # generate_title, list_mcp_tools, httpx, …) are looked up in the router
        # module's namespace, so tests patch there, not on `main`.
        router_catalog=importlib.import_module("router.catalog"),
        router_generation=importlib.import_module("router.generation"),
        router_voice=importlib.import_module("router.voice"),
        router_inference=importlib.import_module("router.inference"),
        router_skills=importlib.import_module("router.skills"),
        schemas=schemas_module,
        prompts=prompts_module,
        title=title_module,
        mcp_tools=mcp_tools_module,
        agents_utils=agents_utils_module,
        # AG-UI transformation layer
        normalizer=importlib.import_module("harness.agui.normalizer"),
        emitter=importlib.import_module("harness.agui.emitter"),
        agui_events=importlib.import_module("harness.agui.events"),
        # core
        proxy=importlib.import_module("core.security.internal_trust"),
        error_handling=importlib.import_module("core.error_handling"),
        settings_module=importlib.import_module("core.settings"),
        # runtime
        filesystem_layout=importlib.import_module("harness.filesystem.layout"),
        base_agent=importlib.import_module("harness.abstractions.base_agent"),
        checkpointer_store=importlib.import_module("harness.checkpointer.store"),
        checkpointer_fork=importlib.import_module("harness.checkpointer.fork"),
        checkpointer_util=importlib.import_module("utils.checkpointer"),
        # skill registry + filesystem
        user_registry=importlib.import_module("harness.skill_registry.user_registry"),
        user_agents=importlib.import_module("harness.abstractions.user_agents"),
        global_manifest=importlib.import_module("harness.skill_registry.global_manifest"),
        skill_store=importlib.import_module("harness.skill_registry.store"),
        definition_store=importlib.import_module("harness.agent_registry.store"),
        provisioner=importlib.import_module("harness.filesystem.provisioner"),
        # other utils
        suggestions=importlib.import_module("utils.suggestions"),
        speech=importlib.import_module("utils.speech"),
        skills=importlib.import_module("utils.skills"),
    )


# ---------------------------------------------------------------------------
# Service loading — imported once, then restored between tests
# ---------------------------------------------------------------------------
# Importing this service is expensive: `main` pulls in langchain / langgraph /
# deepagents, and `utils.agents` runs the whole agent discovery at import time
# (`AGENT_REGISTRY = _build_registry()`). That is ~1s, and paying it per test
# made a suite of millisecond assertions take ~7 minutes. So the import happens
# once per session.
#
# The per-test reload was buying isolation, not just a namespace: tests and
# fixtures write straight into settings sub-models (`fs.workspaces_root = tmp`)
# and into module-level caches, and the reload wiped that. The helpers below
# give that isolation back explicitly, which is both far cheaper and states the
# shared state a reader would otherwise have to infer.


def _is_model(value: object) -> bool:
    """Whether `value` is a pydantic model — i.e. a settings sub-tree to recurse into."""
    return hasattr(value, "__pydantic_fields_set__")


def _snapshot_settings(root: object) -> list[tuple[object, dict, set]]:
    """Capture every field in a settings tree so it can be restored exactly.

    Returns `(model, field_values, fields_set)` triples, parents before children.
    Values are deep-copied so a test mutating a container in place cannot
    corrupt the snapshot; sub-models are stored by reference so a test that
    *rebinds* one (`settings.filesystem = other`) is also undone.
    """
    captured: list[tuple[object, dict, set]] = []

    def walk(model: object) -> None:
        fields: dict = {}
        children: list[object] = []
        for name, value in vars(model).items():
            if _is_model(value):
                # Keep identity: production modules hold direct references to
                # these sub-models, so restoring must put the same object back.
                fields[name] = value
                children.append(value)
            else:
                try:
                    fields[name] = copy.deepcopy(value)
                except (TypeError, ValueError, copy.Error):
                    # Not copyable (e.g. a client handle) — keep the reference.
                    fields[name] = value
        captured.append((model, fields, set(getattr(model, "__pydantic_fields_set__", ()))))
        for child in children:
            walk(child)

    walk(root)
    return captured


def _restore_settings(captured: list[tuple[object, dict, set]]) -> None:
    """Write a `_snapshot_settings` capture back in place.

    Writes into `__dict__` on the original objects rather than rebinding them:
    production code does `from core.settings import settings` and then holds
    `settings.filesystem`, so rebinding would leave those references stale.
    Parents are restored first, so a rebound sub-model is back to the original
    object before that object's own fields are written.
    """
    for model, fields, fields_set in captured:
        model.__dict__.update(fields)
        model.__pydantic_fields_set__ = set(fields_set)


# Process-global caches that a fresh import used to reset for us.
_DICT_CACHES = (
    ("utils.agents", "_USER_AGENT_CACHE"),
    ("utils.mcp_tools", "_MCP_TOOL_MANIFEST_CACHE"),
)
_SINGLETON_CACHES = (("harness.skill_registry.global_manifest", "_MANIFEST_CACHE"),)


def _reset_service_caches() -> None:
    """Drop every process-global cache in the service back to its import state.

    Covers the explicit module-level caches listed above plus every
    `functools.lru_cache` in the service (the OpenAI client, the mTLS context,
    the embeddings model). The lru_caches are found by sweeping the service's own
    modules for a `cache_clear` attribute, so a new one added to the service is
    handled without anyone remembering this function. The sweep compares raw
    `__file__` prefixes rather than resolving paths — `Path.resolve()` per module
    per test would cost more than the reload we are removing.
    """
    for module_name, attr in _DICT_CACHES:
        module = sys.modules.get(module_name)
        if module is not None:
            getattr(module, attr).clear()

    for module_name, attr in _SINGLETON_CACHES:
        module = sys.modules.get(module_name)
        if module is not None:
            setattr(module, attr, None)

    service_prefix = str(SERVICE_ROOT)
    for module in list(sys.modules.values()):
        file_path = getattr(module, "__file__", None)
        if not file_path or not file_path.startswith(service_prefix):
            continue
        for value in vars(module).values():
            cache_clear = getattr(value, "cache_clear", None)
            if callable(cache_clear):
                cache_clear()


def _service_is_live(service: SimpleNamespace) -> bool:
    """Whether the cached modules are still the ones an `import` would resolve to.

    `tests/rag_service/conftest.py` purges `magenticx/agents` out of `sys.modules` when
    it loads its own service, so a full-tree local run can evict what we cached.
    Anything imported lazily afterwards (e.g. the retention module in
    test_workspace_retention.py) would then bind a *second* copy of
    `core.settings`, leaving us to snapshot a settings object that the code under
    test no longer reads. Detect the eviction and reload rather than silently
    testing against a split-brain service.
    """
    return (
        sys.modules.get("main") is service.main
        and sys.modules.get("core.settings") is service.settings_module
    )


@pytest.fixture(scope="session")
def _agents_service_loader():
    """Owns the single expensive import, plus the env/syspath patches it needs.

    Session-scoped `MonkeyPatch` because the env vars must outlive the test that
    first triggered the import — `core.settings` reads them at class-instantiation
    time, so letting a function-scoped patch undo them would leave the singleton
    describing an environment that no longer exists.
    """
    monkeypatch = pytest.MonkeyPatch()
    cache: dict[str, SimpleNamespace] = {}

    def load() -> SimpleNamespace:
        service = cache.get("service")
        if service is None or not _service_is_live(service):
            service = _load_agents_service(monkeypatch)
            cache["service"] = service
        return service

    try:
        yield load
    finally:
        monkeypatch.undo()


@pytest.fixture
def agents_service(_agents_service_loader):
    """The loaded agents service, with per-test isolation of its global state.

    Restores the settings tree and clears the service's process-global caches
    around every test, which is what the old per-test module reload was really
    providing.
    """
    service = _agents_service_loader()
    snapshot = _snapshot_settings(service.settings_module.settings)
    _reset_service_caches()
    try:
        yield service
    finally:
        _restore_settings(snapshot)
        _reset_service_caches()


@pytest.fixture(autouse=True)
def _memory_pool(agents_service):
    """Wire a stub pool so building the workspace backend works offline.

    The ``/memories/`` route is a StoreBackend over ``agent_memories``, and it
    resolves the pool at mount time. Without one the mount raises — which is the
    correct production behaviour (a mount that silently lost memory would be
    worse than a loud failure), but it means every test that builds the composite
    backend needs a pool present. Nothing here executes SQL; the tests that do
    exercise the store drive it with their own fake.
    """
    pool_mod = importlib.import_module("harness.memory.pool")
    pool_mod.set_memory_pool(object())
    try:
        yield
    finally:
        pool_mod.set_memory_pool(None)


@pytest.fixture
def internal_headers(agents_service):
    return {
        agents_service.settings_module.settings.proxy.trusted_proxy_header_name: agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()
    }


@pytest_asyncio.fixture
async def client(agents_service):
    transport = ASGITransport(app=agents_service.main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        yield async_client


# ---------------------------------------------------------------------------
# The skill store, in memory
# ---------------------------------------------------------------------------
# Skills live in `agent_runtime`, and the registry reaches them through
# `user_registry._store()`. Tests get a dict-backed twin instead of a database:
# it keeps the suite about the rules the service enforces, and it is what lets
# the HTTP-level skill routes be exercised end to end with no Postgres.
class FakeSkillStore:
    """Mirrors ``SkillStore``'s semantics with dicts.

    The one behaviour deliberately kept real is the **global dispatch**: a
    ``type='global'`` entry reads the catalogue off disk, so it delegates to the
    store module's own reader. That is the branch least worth faking — a global
    pool entry carrying no files of its own is the sharp edge of the whole model.
    """

    def __init__(self, store_module):
        self._read_catalogue = store_module._read_catalogue_files
        self.pool: dict[tuple[str, str], dict] = {}
        self.files: dict[tuple[str, str], dict[str, tuple[str, str]]] = {}
        self.assignments: set[tuple[str, str, str]] = set()

    async def list_pool(self, user_id):
        return [v for (u, _n), v in sorted(self.pool.items()) if u == user_id]

    async def get_pool_entry(self, user_id, skill_name):
        return self.pool.get((user_id, skill_name))

    async def add_global(self, user_id, skill_name, *, category, description=""):
        self.pool[(user_id, skill_name)] = {
            "name": skill_name, "type": "global", "category": category,
            "description": description, "origin": "user",
            "created_by_agent": None, "added_at": STORE_NOW,
        }

    async def add_custom(self, user_id, skill_name, *, files, description="",
                         origin="user", created_by_agent=None):
        self.pool[(user_id, skill_name)] = {
            "name": skill_name, "type": "custom", "category": "",
            "description": description, "origin": origin,
            "created_by_agent": created_by_agent, "added_at": STORE_NOW,
        }
        # Replace, never merge — a save carries the whole folder.
        self.files[(user_id, skill_name)] = dict(files)

    async def remove(self, user_id, skill_name):
        held = self.pool.pop((user_id, skill_name), None) is not None
        self.files.pop((user_id, skill_name), None)
        self.assignments = {a for a in self.assignments
                            if not (a[0] == user_id and a[2] == skill_name)}
        return held

    async def list_agent_skills(self, user_id, agent_slug):
        return sorted(n for (u, a, n) in self.assignments
                      if u == user_id and a == agent_slug)

    async def assign(self, user_id, agent_slug, skill_name):
        self.assignments.add((user_id, agent_slug, skill_name))

    async def unassign(self, user_id, agent_slug, skill_name):
        self.assignments.discard((user_id, agent_slug, skill_name))

    async def read_files(self, user_id, skill_name):
        entry = self.pool.get((user_id, skill_name))
        if entry is None:
            return {}
        if entry["type"] == "global":
            return self._read_catalogue(entry["category"], skill_name)
        return dict(self.files.get((user_id, skill_name), {}))


@pytest.fixture()
def ur(skills_fs, monkeypatch):
    """The registry module with a dict-backed store behind it.

    ``.store`` is hung off the module so a test can assert on what was actually
    written — the point of several of these is that nothing was.
    """
    module = skills_fs.service.user_registry
    fake = FakeSkillStore(skills_fs.service.skill_store)
    monkeypatch.setattr(module, "_store", lambda: fake)
    monkeypatch.setattr(module, "store", fake, raising=False)
    return module



@pytest.fixture()
def skill_store_memory(agents_service, monkeypatch):
    """Install the in-memory store behind the registry for this test.

    Returned so a test can inspect what was written — several assert that
    *nothing* was.
    """
    fake = FakeSkillStore(agents_service.skill_store)
    monkeypatch.setattr(agents_service.user_registry, "_store", lambda: fake)
    return fake


class FakeAgentDefinitionStore:
    """Dict-backed twin of ``AgentDefinitionStore``.

    Same trade as :class:`FakeSkillStore`: definitions live in ``agent_runtime``,
    so without this every test that writes or reads one would need a live
    Postgres. What it must mirror exactly is the *replace, never merge* rule — a
    save carries the whole definition, so a file the user deleted must not
    survive as a row the agent goes on reading.
    """

    def __init__(self):
        self.specs: dict[tuple[str, str], dict] = {}
        self.files: dict[tuple[str, str], dict[str, tuple[str, str]]] = {}
        self.updated: dict[tuple[str, str], int] = {}
        self._clock = 0

    async def list_specs(self, user_id):
        return [{"slug": slug, "spec": spec}
                for (u, slug), spec in sorted(self.specs.items()) if u == user_id]

    async def get_spec(self, user_id, agent_slug):
        return self.specs.get((user_id, agent_slug))

    async def get_row(self, user_id, agent_slug):
        spec = self.specs.get((user_id, agent_slug))
        if spec is None:
            return None
        return {"spec": spec, "updated_at": self.updated[(user_id, agent_slug)]}

    async def get_definition(self, user_id, agent_slug):
        spec = self.specs.get((user_id, agent_slug))
        if spec is None:
            return None
        return spec, dict(self.files.get((user_id, agent_slug), {}))

    async def read_files(self, user_id, agent_slug):
        return dict(self.files.get((user_id, agent_slug), {}))

    async def save(self, user_id, agent_slug, *, spec, files):
        key = (user_id, agent_slug)
        replaced = key in self.specs
        self._clock += 1
        self.specs[key] = spec
        self.files[key] = dict(files)      # replace, never merge
        self.updated[key] = self._clock
        return replaced

    async def delete(self, user_id, agent_slug):
        key = (user_id, agent_slug)
        removed = self.specs.pop(key, None) is not None
        self.files.pop(key, None)
        self.updated.pop(key, None)
        return removed


@pytest.fixture()
def definition_store_memory(agents_service, monkeypatch):
    """Install the in-memory definition store behind the agent CRUD and loader."""
    fake = FakeAgentDefinitionStore()
    monkeypatch.setattr(agents_service.user_agents, "_store", lambda: fake)
    monkeypatch.setattr(agents_service.agents_utils, "_definition_store", lambda: fake)
    return fake


def _write_global_skill(global_root: Path, category: str, name: str, description: str, body: str) -> None:
    skill_dir = global_root / category / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}",
        encoding="utf-8",
    )


@pytest.fixture
def skills_fs(agents_service, tmp_path):
    """Point the agents filesystem at an isolated tmp tree.

    Redirects the two plane roots (``global_root`` / ``workspaces_root``) into
    tmp_path, seeds two global skills into the catalogue, and resets the
    in-memory global manifest cache so each test starts from a freshly indexed
    catalogue.

    Exposed attributes mirror the consolidated layout:

    * ``global_root`` — the *catalogue* dir (``<plane>/skills``), so
      ``global_root / <category> / <skill>`` addresses a skill folder.
    * ``workspace(user)`` / ``agent_dir(user, slug)`` — the per-user tree.

    There is deliberately no ``pool(user)`` any more: a user's skills are rows
    in ``agent_runtime``, not a directory, so nothing on this tmp tree backs
    them. Only the *catalogue* — build-time content — is still on disk.
    """
    fs = agents_service.settings_module.settings.filesystem
    layout = agents_service.filesystem_layout

    global_plane = tmp_path / "global"
    workspaces = tmp_path / "workspaces"
    fs.global_root = global_plane
    fs.workspaces_root = workspaces

    catalogue = layout.global_skills_root()
    catalogue.mkdir(parents=True, exist_ok=True)
    layout.users_root().mkdir(parents=True, exist_ok=True)

    _write_global_skill(catalogue, "research", "deep-research", "Run deep research", "Body for deep research.")
    _write_global_skill(catalogue, "frontend", "design-system", "Design system helper", "Body for design system.")

    agents_service.global_manifest._MANIFEST_CACHE = None
    agents_service.global_manifest.rebuild_global_manifest()

    return SimpleNamespace(
        global_root=catalogue,
        users_root=layout.users_root(),
        workspace=layout.user_workspace,
        agent_dir=layout.agent_root,
        service=agents_service,
    )
