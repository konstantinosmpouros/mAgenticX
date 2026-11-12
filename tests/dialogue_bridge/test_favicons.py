"""Plan 42: site icons for the source chips, fetched safely by the bridge."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import utils.favicons as favicons
from core.auth.session import require_current_user
from utils.favicons import Favicon, get_favicon, normalise_host
from utils.validators import validate_userId


@pytest.mark.parametrize("raw, host", [
    ("www.BankOfGreece.gr", "www.bankofgreece.gr"),
    ("en.wikipedia.org.", "en.wikipedia.org"),
    ("ελλάδα.gr", "xn--hxakic4aa.gr"),
])
def test_a_plain_public_hostname_is_kept(raw, host):
    assert normalise_host(raw) == host


@pytest.mark.parametrize("raw", [
    "127.0.0.1", "10.0.0.5", "localhost", "metadata", "[::1]", "a.example:8080", "user@a.example",
    "a.example/path", "evil.example?x=1", "", "a" * 300 + ".com",
])
def test_anything_else_is_refused(raw):
    assert normalise_host(raw) is None


@pytest.fixture
def upstream(monkeypatch):
    """The icon service, faked: records each host asked for."""
    calls: list[str] = []
    answers: dict[str, Favicon | None] = {}

    async def fake_fetch(host: str):
        calls.append(host)
        return answers.get(host)

    monkeypatch.setattr(favicons, "_fetch", fake_fetch)
    return SimpleNamespace(calls=calls, answers=answers)


async def test_an_icon_is_fetched_once_then_served_from_the_cache(upstream):
    upstream.answers["imf.org"] = Favicon("image/png", b"\x89PNG")
    assert (await get_favicon("imf.org")).data == b"\x89PNG"
    assert (await get_favicon("IMF.org")).content_type == "image/png"
    assert upstream.calls == ["imf.org"]


async def test_the_www_twin_and_the_next_service_are_tried(monkeypatch):
    asked: list[str] = []

    async def one(url: str):
        asked.append(url)
        return Favicon("image/png", b"x") if url.startswith("https://second/www.") else None

    monkeypatch.setattr(favicons, "_fetch_one", one)
    monkeypatch.setattr(favicons.settings.favicons, "service_urls", "https://first/{host},https://second/{host}")
    assert (await get_favicon("twin.example")).data == b"x"
    assert asked == [
        "https://first/twin.example", "https://first/www.twin.example",
        "https://second/twin.example", "https://second/www.twin.example",
    ]


async def test_a_host_without_an_icon_is_remembered(upstream):
    assert await get_favicon("noicon.example") is None
    assert await get_favicon("noicon.example") is None
    assert upstream.calls == ["noicon.example"]


async def test_a_refused_host_never_reaches_the_service(upstream):
    assert await get_favicon("169.254.169.254") is None
    assert upstream.calls == []


async def test_the_route_serves_the_icon_untrusted(app, client, seeded_user, upstream):
    upstream.answers["ecb.europa.eu"] = Favicon("image/x-icon", b"ICO")
    resp = await client.get(f"/v1/favicons/{seeded_user.id}", params={"host": "ecb.europa.eu"})
    assert resp.status_code == 200 and resp.content == b"ICO"
    assert resp.headers["content-type"] == "image/x-icon"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in resp.headers["content-security-policy"]


async def test_no_icon_is_a_404(app, client, seeded_user, upstream):
    resp = await client.get(f"/v1/favicons/{seeded_user.id}", params={"host": "none.example"})
    assert resp.status_code == 404


async def test_signed_out_or_another_user_is_refused(app, client, seeded_user, upstream):
    app.dependency_overrides.pop(validate_userId)
    assert (await client.get(f"/v1/favicons/{seeded_user.id}", params={"host": "a.example"})).status_code == 401

    async def someone_else():
        return SimpleNamespace(id="someone-else")

    app.dependency_overrides[require_current_user] = someone_else
    assert (await client.get(f"/v1/favicons/{seeded_user.id}", params={"host": "a.example"})).status_code == 403
    assert upstream.calls == []
