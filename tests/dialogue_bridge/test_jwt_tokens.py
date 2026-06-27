"""Verify the stateless JWT mint/verify path against a locally-signing fake Vault.

The shared ``_mock_vault_transit`` autouse fixture (conftest) signs exactly as
Vault Transit does under the bridge's parameters (PKCS#1 v1.5 / SHA-256,
base64url-no-pad), so this exercises the real ``jwt_tokens`` construction and
``jose`` verification end to end — re-proving the Transit recipe without a live
Vault.
"""
from __future__ import annotations

import pytest

from core.auth.tokens import ACCESS_TYPE, REFRESH_TYPE, TokenError, mint_tokens, verify


async def test_mint_and_verify_roundtrip():
    issued = await mint_tokens("user-1")
    assert issued.session_id
    assert issued.access_ttl == 28800
    assert issued.access_token.count(".") == 2

    access = await verify(issued.access_token, ACCESS_TYPE)
    assert access["sub"] == "user-1"
    assert access["sid"] == issued.session_id
    assert access["typ"] == ACCESS_TYPE

    refresh = await verify(issued.refresh_token, REFRESH_TYPE)
    assert refresh["sid"] == issued.session_id
    assert refresh["typ"] == REFRESH_TYPE


async def test_token_type_confusion_rejected():
    issued = await mint_tokens("user-2")
    with pytest.raises(TokenError):
        await verify(issued.access_token, REFRESH_TYPE)
    with pytest.raises(TokenError):
        await verify(issued.refresh_token, ACCESS_TYPE)


async def test_tampered_signature_rejected():
    issued = await mint_tokens("user-3")
    head, payload, sig = issued.access_token.split(".")
    with pytest.raises(TokenError):
        await verify(f"{head}.{payload}.{sig[:-3]}AAA", ACCESS_TYPE)


async def test_rotation_preserves_sid_and_absolute_cap():
    issued = await mint_tokens("user-4")
    refresh = await verify(issued.refresh_token, REFRESH_TYPE)
    rotated = await mint_tokens("user-4", sid=issued.session_id, login_at=refresh["lat"])
    rotated_refresh = await verify(rotated.refresh_token, REFRESH_TYPE)
    assert rotated_refresh["sid"] == issued.session_id
    assert rotated_refresh["lat"] == refresh["lat"]
    assert rotated_refresh["exp"] == refresh["exp"]
