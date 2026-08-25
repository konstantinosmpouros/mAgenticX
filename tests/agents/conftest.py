from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "src" / "agents"


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
    _purge_modules_under_paths(ROOT / "src" / "dialogue_bridge", ROOT / "src" / "rag_service", ROOT / "src" / "agents")

    monkeypatch.syspath_prepend(str(SERVICE_ROOT))

    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("TRUSTED_PROXY_SECRET", "agents-test-secret")
    monkeypatch.setenv("MCP_GATEWAY_URL", "http://mcp.test/sse")

    main_module = importlib.import_module("main")
    schemas_module = importlib.import_module("schemas")
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
        normalizer=importlib.import_module("runtime.agui.normalizer"),
        emitter=importlib.import_module("runtime.agui.emitter"),
        agui_events=importlib.import_module("runtime.agui.events"),
        # core
        proxy=importlib.import_module("core.security.internal_trust"),
        error_handling=importlib.import_module("core.error_handling"),
        settings_module=importlib.import_module("core.settings"),
        # runtime
        filesystem_layout=importlib.import_module("runtime.filesystem.layout"),
        base_agent=importlib.import_module("runtime.abstractions.base_agent"),
        checkpointer_store=importlib.import_module("runtime.checkpointer.store"),
        checkpointer_fork=importlib.import_module("runtime.checkpointer.fork"),
        checkpointer_util=importlib.import_module("utils.checkpointer"),
        # skill registry + filesystem
        user_registry=importlib.import_module("runtime.skill_registry.user_registry"),
        global_manifest=importlib.import_module("runtime.skill_registry.global_manifest"),
        provisioner=importlib.import_module("runtime.filesystem.provisioner"),
        # other utils
        suggestions=importlib.import_module("utils.suggestions"),
        speech=importlib.import_module("utils.speech"),
        skills=importlib.import_module("utils.skills"),
    )


@pytest.fixture
def agents_service(monkeypatch):
    return _load_agents_service(monkeypatch)


@pytest.fixture
def internal_headers(agents_service):
    return {
        agents_service.main.settings.proxy.trusted_proxy_header_name: agents_service.main.settings.proxy.trusted_proxy_secret.get_secret_value()
    }


@pytest_asyncio.fixture
async def client(agents_service):
    transport = ASGITransport(app=agents_service.main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        yield async_client


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
    * ``pool(user)`` — that user's skill pool (``manifest.json`` + ``custom/``).
    * ``workspace(user)`` / ``agent_dir(user, slug)`` — the per-user tree.
    """
    fs = agents_service.main.settings.filesystem
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
        pool=layout.user_skills_pool_root,
        workspace=layout.user_workspace,
        agent_dir=layout.agent_root,
        service=agents_service,
    )
