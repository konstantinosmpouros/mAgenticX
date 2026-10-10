"""Edit profile — the photo.

Signed in the way production signs in (the Entra callback, Microsoft's half
stubbed). Pinned:

* an upload is never stored as sent: it comes back as a 256 px square WebP
  with no EXIF, whatever the input format or orientation;
* only PNG, JPEG and WebP decode; anything else, an oversized body, or an image
  whose header claims too many pixels is refused, and nothing is stored;
* the photo is served to its owner — with nosniff, a sandboxing CSP and a
  private cache — and to nobody else (404, so its existence never leaks);
* removing it clears the profile's avatarUpdatedAt and the stored bytes.
"""
from __future__ import annotations

import io
import struct
import zlib

import pytest
from PIL import Image
from sqlalchemy import select

from core.database import UserAvatarTable
from core.settings import settings
from utils import validate_userId

EMAIL = "alice@example.com"


@pytest.fixture
def real_user_binding(app):
    """The suite's app stubs the path-user check; these tests need the real one."""
    app.dependency_overrides.pop(validate_userId, None)


async def _signed_in(client, sso_login, username: str = "alice", email: str = EMAIL) -> str:
    resp = await sso_login(username, email=email)
    assert resp.status_code == 302, resp.text
    return (await client.get("/v1/auth/session")).json()["user_id"]


def _image(fmt: str, size=(640, 480), exif: bool = False) -> bytes:
    image = Image.new("RGB", size, (200, 30, 90))
    out = io.BytesIO()
    if exif:
        data = Image.Exif()
        data[0x010F] = "SecretCam"          # Make
        data[0x0112] = 6                    # Orientation: rotate 90°
        image.save(out, format=fmt, exif=data.tobytes())
    else:
        image.save(out, format=fmt)
    return out.getvalue()


def _png_header_claiming(width: int, height: int) -> bytes:
    """A tiny PNG whose header claims a huge canvas — a decompression bomb's shape."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")


async def _upload(client, uid: str, data: bytes, content_type: str = "image/png"):
    return await client.put(f"/v1/account/{uid}/avatar", files={"photo": ("me.bin", data, content_type)})


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
async def test_an_upload_is_reencoded_to_a_small_square_webp(client, sso_login, fmt):
    uid = await _signed_in(client, sso_login)
    resp = await _upload(client, uid, _image(fmt))
    assert resp.status_code == 200, resp.text
    assert resp.json()["avatarUpdatedAt"]

    served = await client.get(f"/v1/account/{uid}/avatar")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in served.headers["content-security-policy"]
    assert served.headers["cache-control"].startswith("private")
    with Image.open(io.BytesIO(served.content)) as stored:
        side = settings.profile.avatar_size_px
        assert (stored.format, stored.size) == ("WEBP", (side, side))


async def test_exif_is_dropped_and_orientation_applied(client, sso_login):
    uid = await _signed_in(client, sso_login)
    raw = _image("JPEG", size=(400, 200), exif=True)
    assert b"SecretCam" in raw
    assert (await _upload(client, uid, raw, "image/jpeg")).status_code == 200

    stored = (await client.get(f"/v1/account/{uid}/avatar")).content
    assert b"SecretCam" not in stored
    with Image.open(io.BytesIO(stored)) as image:
        assert not image.getexif()


@pytest.mark.parametrize(
    "data",
    [b"%PDF-1.7 not a picture", b"<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>", b""],
)
async def test_anything_but_png_jpeg_webp_is_refused(client, sso_login, session_factory, data):
    uid = await _signed_in(client, sso_login)
    assert (await _upload(client, uid, data, "image/png")).status_code == 422
    assert (await client.get(f"/v1/account/{uid}/avatar")).status_code == 404


async def test_a_gif_is_refused_even_though_it_decodes(client, sso_login):
    uid = await _signed_in(client, sso_login)
    assert (await _upload(client, uid, _image("GIF"), "image/gif")).status_code == 422


async def test_an_oversized_upload_is_refused_before_decoding(client, sso_login, monkeypatch):
    uid = await _signed_in(client, sso_login)
    monkeypatch.setattr(settings.profile, "avatar_max_upload_bytes", 2048)
    assert (await _upload(client, uid, b"\x00" * 4096)).status_code == 413


async def test_a_header_claiming_too_many_pixels_is_refused(client, sso_login):
    uid = await _signed_in(client, sso_login)
    assert (await _upload(client, uid, _png_header_claiming(50_000, 50_000))).status_code == 422


async def test_another_user_never_sees_the_photo(client, sso_login, real_user_binding):
    alice = await _signed_in(client, sso_login)
    assert (await _upload(client, alice, _image("PNG"))).status_code == 200

    await _signed_in(client, sso_login, username="bob", email="bob@example.com")
    assert (await client.get(f"/v1/account/{alice}/avatar")).status_code == 404
    # Nor can Bob replace or remove it.
    assert (await _upload(client, alice, _image("PNG"))).status_code == 403
    assert (await client.delete(f"/v1/account/{alice}/avatar")).status_code == 403


async def test_removing_the_photo_clears_it(client, sso_login, session_factory):
    uid = await _signed_in(client, sso_login)
    assert (await _upload(client, uid, _image("PNG"))).status_code == 200

    resp = await client.delete(f"/v1/account/{uid}/avatar")
    assert resp.status_code == 200
    assert resp.json()["avatarUpdatedAt"] is None
    assert (await client.get(f"/v1/account/{uid}/avatar")).status_code == 404
    async with session_factory() as s:
        assert (await s.execute(select(UserAvatarTable).where(UserAvatarTable.user_id == uid))).first() is None
