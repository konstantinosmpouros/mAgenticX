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
        schemas=schemas_module,
        prompts=prompts_module,
        title=title_module,
        mcp_tools=mcp_tools_module,
        agents_utils=agents_utils_module,
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
