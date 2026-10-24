"""``/conversation/input/`` — the uploads, read from the bridge (plan 43).

Nothing is copied to the agents service any more: the bridge lists every
upload of the conversation and serves the bytes on demand. Pinned: the list is
fetched once per run, bytes are checked against their hash and cached by it,
and a bridge that cannot answer makes the uploads *unavailable* rather than
absent — while a bridge without the endpoint (404) simply has none to offer.
"""
from __future__ import annotations

import hashlib

import httpx
import pytest

pytestmark = pytest.mark.asyncio

UPLOAD = b"col1,col2\n1,2\n"


@pytest.fixture
def bridge(agents_service, monkeypatch):
    """The bridge's two internal routes, counting calls."""
    module = agents_service.conversation_files.inputs
    state = {"calls": [], "status": 200, "bytes": UPLOAD}

    async def bridge_get(path, params):
        state["calls"].append(path)
        request = httpx.Request("GET", f"https://bridge.test{path}")
        if state["status"] != 200:
            return httpx.Response(state["status"], request=request)
        if path.endswith("/input-files"):
            return httpx.Response(200, request=request, json={"files": [{
                "name": "data.csv", "attachment_id": "att-1", "mime": "text/csv",
                "size": len(UPLOAD), "sha256": hashlib.sha256(UPLOAD).hexdigest(), "created_at": "2026-10-24T10:00:00",
            }]})
        return httpx.Response(200, request=request, content=state["bytes"])

    monkeypatch.setattr(module, "_bridge_get", bridge_get)
    return state


def _view(agents_service):
    return agents_service.conversation_files.inputs.InputView("u1", "c1")


async def test_the_list_is_fetched_once_per_run_and_bytes_once_per_hash(agents_service, bridge):
    first, second = _view(agents_service), _view(agents_service)

    assert list(await first.files()) == ["data.csv"]
    assert await first.read("data.csv") == UPLOAD
    assert await first.read("data.csv") == UPLOAD
    assert await second.read("data.csv") == UPLOAD  # another run: its own list, the cached bytes
    assert await first.read("nope.csv") is None

    assert bridge["calls"] == [
        "/c1/input-files", "/c1/input-files/att-1", "/c1/input-files",
    ]


async def test_bytes_that_do_not_match_their_hash_are_refused(agents_service, bridge):
    bridge["bytes"] = b"tampered"
    module = agents_service.conversation_files.inputs

    with pytest.raises(module.InputsUnavailable):
        await _view(agents_service).read("data.csv")


async def test_an_unreachable_bridge_is_unavailable_and_retried(agents_service, bridge):
    module = agents_service.conversation_files.inputs
    view = _view(agents_service)
    bridge["status"] = 503

    with pytest.raises(module.InputsUnavailable):
        await view.files()
    bridge["status"] = 200
    assert list(await view.files()) == ["data.csv"]  # a failure is not remembered


async def test_a_bridge_without_the_endpoint_has_no_uploads(agents_service, bridge):
    bridge["status"] = 404
    assert await _view(agents_service).files() == {}
