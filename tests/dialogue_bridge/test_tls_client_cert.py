from __future__ import annotations

from pydantic import SecretStr

from core.settings import settings
from core.security.tls import get_httpx_client_cert, get_httpx_verify


def test_client_cert_none_when_unset(monkeypatch):
    monkeypatch.setattr(settings.tls, "client_cert_path", None)
    monkeypatch.setattr(settings.tls, "client_key_path", None)
    assert get_httpx_client_cert() is None


def test_client_cert_pair_when_both_set(monkeypatch):
    monkeypatch.setattr(settings.tls, "client_cert_path", SecretStr("/app/tls/tls.crt"))
    monkeypatch.setattr(settings.tls, "client_key_path", SecretStr("/app/tls/tls.key"))
    assert get_httpx_client_cert() == ("/app/tls/tls.crt", "/app/tls/tls.key")


def test_client_cert_none_when_only_cert_set(monkeypatch):
    monkeypatch.setattr(settings.tls, "client_cert_path", SecretStr("/app/tls/tls.crt"))
    monkeypatch.setattr(settings.tls, "client_key_path", None)
    assert get_httpx_client_cert() is None


def test_client_cert_none_when_empty_secret(monkeypatch):
    monkeypatch.setattr(settings.tls, "client_cert_path", SecretStr(""))
    monkeypatch.setattr(settings.tls, "client_key_path", SecretStr(""))
    assert get_httpx_client_cert() is None


def test_verify_falls_back_to_true_without_ca(monkeypatch):
    monkeypatch.setattr(settings.tls, "ca_cert_path", None)
    assert get_httpx_verify() is True


def test_verify_returns_ca_path_when_set(monkeypatch):
    monkeypatch.setattr(settings.tls, "ca_cert_path", "/app/tls/ca.crt")
    assert get_httpx_verify() == "/app/tls/ca.crt"
