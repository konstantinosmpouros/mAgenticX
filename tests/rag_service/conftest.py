from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "src" / "rag_service"


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


def _load_rag_service(monkeypatch, tmp_path):
    _purge_modules_under_paths(ROOT / "src" / "dialogue_bridge", ROOT / "src" / "rag_service", ROOT / "src" / "agents")

    if str(SERVICE_ROOT) not in sys.path:
        sys.path.insert(0, str(SERVICE_ROOT))

    monkeypatch.setenv("TRUSTED_PROXY_SECRET", "rag-test-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.chdir(tmp_path)

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    workbook = data_dir / "Financial Sample.xlsx"
    workbook.write_bytes(b"placeholder workbook")

    import langchain_openai

    class DummyEmbeddings:
        def __init__(self, *args, **kwargs):
            self.model = kwargs.get("model")

    monkeypatch.setattr(langchain_openai, "OpenAIEmbeddings", DummyEmbeddings)
    monkeypatch.setattr(
        pd,
        "read_excel",
        lambda *_args, **_kwargs: pd.DataFrame(
            [{"region": "North", "sales": 100}, {"region": "South", "sales": 150}]
        ),
    )

    config_module = importlib.import_module("config")
    main_module = importlib.import_module("main")
    proxy_module = importlib.import_module("core.proxy")
    return SimpleNamespace(config=config_module, main=main_module, proxy=proxy_module)


@pytest.fixture
def rag_service(monkeypatch, tmp_path):
    return _load_rag_service(monkeypatch, tmp_path)


@pytest.fixture
def internal_headers(rag_service):
    return {rag_service.proxy.TRUSTED_PROXY_HEADER_NAME: rag_service.proxy.TRUSTED_PROXY_SECRET}


@pytest_asyncio.fixture
async def client(rag_service):
    transport = ASGITransport(app=rag_service.main.app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        yield async_client
