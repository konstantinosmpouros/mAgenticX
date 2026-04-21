from __future__ import annotations

import ipaddress
import os
import secrets
from dataclasses import dataclass


ProxyNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def _as_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: str | None, default: int) -> int:
    if value in (None, ""):
        return default
    return int(value)


def _as_float(value: str | None, default: float) -> float:
    if value in (None, ""):
        return default
    return float(value)


def _optional_str(value: str | None) -> str | None:
    if value is None:
        return None
    resolved = value.strip()
    return resolved or None


def _read_secret(name: str, default: str = "") -> str:
    from pathlib import Path
    file_path = os.getenv(f"{name}_FILE")
    if file_path:
        try:
            return Path(file_path).read_text().strip()
        except OSError:
            pass
    return (os.getenv(name) or default).strip()


def _required_str(name: str) -> str:
    value = _optional_str(os.getenv(name))
    if value is None:
        raise RuntimeError(f"{name} is not configured.")
    return value


def _load_trusted_proxy_networks(raw: str | None) -> tuple[ProxyNetwork, ...]:
    networks: list[ProxyNetwork] = []
    for item in (raw or "").split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            networks.append(ipaddress.ip_network(candidate, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def _load_csv_items(raw: str | None) -> tuple[str, ...]:
    items: list[str] = []
    for item in (raw or "").split(","):
        candidate = item.strip()
        if candidate:
            items.append(candidate)
    return tuple(items)


def _load_csv_items_or_default(raw: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    items = _load_csv_items(raw)
    return items or default


def _default_agentic_ui_origins() -> tuple[str, ...]:
    return (
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:8050",
        "http://127.0.0.1:8050",
    )


def _default_cors_headers(cors_csrf_header_name: str | None = None) -> tuple[str, ...]:
    return (
        "Accept",
        "Content-Type",
        "Authorization",
        "Range",
        "If-Range",
        cors_csrf_header_name,
    )


def _default_cors_methods() -> tuple[str, ...]:
    return ("GET", "POST", "PUT", "PATCH", "DELETE")


def _default_cors_expose_headers() -> tuple[str, ...]:
    return (
        "Content-Disposition",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
    )


@dataclass(frozen=True, slots=True)
class AppSettings:
    env: str
    version: str
    service_name: str


@dataclass(frozen=True, slots=True)
class DatabaseSettings:
    url: str
    echo: bool
    pool_pre_ping: bool
    pool_recycle: int
    pool_size: int
    max_overflow: int


@dataclass(frozen=True, slots=True)
class SessionSettings:
    secure: bool
    samesite: str
    domain: str | None
    access_cookie_name: str
    refresh_cookie_name: str
    csrf_cookie_name: str
    csrf_header_name: str
    access_ttl_seconds: int
    refresh_ttl_seconds: int
    max_per_user: int
    token_secret: str


@dataclass(frozen=True, slots=True)
class VaultSettings:
    addr: str | None
    userpass_mount: str
    oidc_role: str
    oidc_path: str
    namespace: str | None
    timeout: float


@dataclass(frozen=True, slots=True)
class TlsSettings:
    ca_cert_path: str | None


@dataclass(frozen=True, slots=True)
class UpstreamSettings:
    agents_service_url: str


@dataclass(frozen=True, slots=True)
class ProxySettings:
    header_name: str
    secret: str
    cidrs: str
    trusted_networks: tuple[ProxyNetwork, ...]


@dataclass(frozen=True, slots=True)
class RateLimitSettings:
    auth_max_attempts: int
    auth_window_seconds: int


@dataclass(frozen=True, slots=True)
class LoggingSettings:
    level: str
    format: str
    timezone: str
    redaction_secret: str


@dataclass(frozen=True, slots=True)
class CorsSettings:
    allowed_origins: tuple[str, ...]
    allow_credentials: bool
    allow_methods: tuple[str, ...]
    allow_headers: tuple[str, ...]
    expose_headers: tuple[str, ...]
    max_age_seconds: int


@dataclass(frozen=True, slots=True)
class Settings:
    app: AppSettings
    database: DatabaseSettings
    session: SessionSettings
    vault: VaultSettings
    upstream: UpstreamSettings
    tls: TlsSettings
    proxy: ProxySettings
    rate_limit: RateLimitSettings
    logging: LoggingSettings
    cors: CorsSettings


def load_settings() -> Settings:
    # Determine secure cookie defaults based on environment variables
    session_secure = _as_bool(os.getenv("SESSION_COOKIE_SECURE"), default=True)
    session_domain = _optional_str(os.getenv("SESSION_COOKIE_DOMAIN"))
    default_access_cookie = "__Host-mx_session" if session_secure and session_domain is None else "mx_session"
    default_refresh_cookie = "__Host-mx_refresh" if session_secure and session_domain is None else "mx_refresh"
    default_csrf_cookie = "__Host-mx_csrf" if session_secure and session_domain is None else "mx_csrf"
    session_token_secret = _optional_str(os.getenv("SESSION_TOKEN_SECRET")) or secrets.token_hex(32)

    # Load trusted proxy CIDRs and networks
    proxy_cidrs = os.getenv("TRUSTED_PROXY_CIDRS", "")

    # Validate CORS settings
    cors_allowed_origins = _load_csv_items_or_default(os.getenv("CORS_ALLOWED_ORIGINS"), _default_agentic_ui_origins())
    cors_allow_credentials = _as_bool(os.getenv("CORS_ALLOW_CREDENTIALS"), default=True)
    cors_csrf_header_name = os.getenv("SESSION_CSRF_HEADER_NAME", "X-CSRF-Token")
    cors_allow_methods = _load_csv_items_or_default(
        os.getenv("CORS_ALLOW_METHODS"),
        _default_cors_methods(),
    )
    cors_allow_headers = _load_csv_items_or_default(
        os.getenv("CORS_ALLOW_HEADERS"),
        _default_cors_headers(cors_csrf_header_name),
    )
    cors_expose_headers = _load_csv_items_or_default(
        os.getenv("CORS_EXPOSE_HEADERS"),
        _default_cors_expose_headers(),
    )
    if cors_allow_credentials and "*" in cors_allowed_origins:
        raise RuntimeError("CORS_ALLOWED_ORIGINS cannot contain '*' when CORS_ALLOW_CREDENTIALS is enabled.")

    return Settings(
        app=AppSettings(
            env=(_optional_str(os.getenv("APP_ENV")) or _optional_str(os.getenv("ENV")) or "development"),
            version=(_optional_str(os.getenv("APP_VERSION")) or _optional_str(os.getenv("IMAGE_TAG")) or "unknown"),
            service_name=_optional_str(os.getenv("LOG_SERVICE_NAME")) or "dialogue_bridge",
        ),
        database=DatabaseSettings(
            url=_required_str("DATABASE_URL"),
            echo=_as_bool(os.getenv("DATABASE_ECHO"), default=False),
            pool_pre_ping=_as_bool(os.getenv("DATABASE_POOL_PRE_PING"), default=True),
            pool_recycle=_as_int(os.getenv("DATABASE_POOL_RECYCLE"), default=1800),
            pool_size=_as_int(os.getenv("DATABASE_POOL_SIZE"), default=5),
            max_overflow=_as_int(os.getenv("DATABASE_MAX_OVERFLOW"), default=20),
        ),
        session=SessionSettings(
            secure=session_secure,
            samesite=os.getenv("SESSION_COOKIE_SAMESITE", "lax"),
            domain=session_domain,
            access_cookie_name=os.getenv("SESSION_COOKIE_NAME", default_access_cookie),
            refresh_cookie_name=os.getenv("SESSION_REFRESH_COOKIE_NAME", default_refresh_cookie),
            csrf_cookie_name=os.getenv("SESSION_CSRF_COOKIE_NAME", default_csrf_cookie),
            csrf_header_name=os.getenv("SESSION_CSRF_HEADER_NAME", "X-CSRF-Token"),
            access_ttl_seconds=_as_int(os.getenv("SESSION_ACCESS_TTL_SECONDS"), 900),
            refresh_ttl_seconds=_as_int(os.getenv("SESSION_REFRESH_TTL_SECONDS"), 604800),
            max_per_user=_as_int(os.getenv("SESSION_MAX_PER_USER"), 3),
            token_secret=session_token_secret,
        ),
        vault=VaultSettings(
            addr=_optional_str(os.getenv("VAULT_URL")),
            userpass_mount=os.getenv("VAULT_USERPASS_MOUNT", "userpass"),
            oidc_role=os.getenv("VAULT_OIDC_ROLE", "agenticx"),
            oidc_path=os.getenv("VAULT_OIDC_PATH", "identity/oidc/token"),
            namespace=_optional_str(os.getenv("VAULT_NAMESPACE")),
            timeout=_as_float(os.getenv("VAULT_HTTP_TIMEOUT"), 10.0),
        ),
        upstream=UpstreamSettings(
            agents_service_url=os.getenv("AGENTS_SERVICE_URL", "https://agents:8003"),
        ),
        tls=TlsSettings(
            ca_cert_path=_optional_str(os.getenv("INTERNAL_CA_CERT_PATH")),
        ),
        proxy=ProxySettings(
            header_name=os.getenv("TRUSTED_PROXY_HEADER_NAME", "X-Internal-Proxy-Secret"),
            secret=_read_secret("TRUSTED_PROXY_SECRET"),
            cidrs=proxy_cidrs,
            trusted_networks=_load_trusted_proxy_networks(proxy_cidrs),
        ),
        rate_limit=RateLimitSettings(
            auth_max_attempts=_as_int(os.getenv("AUTH_RATE_LIMIT_MAX_ATTEMPTS"), 4),
            auth_window_seconds=_as_int(os.getenv("AUTH_RATE_LIMIT_WINDOW_SECONDS"), 60),
        ),
        logging=LoggingSettings(
            level=os.getenv("LOG_LEVEL", "INFO").upper(),
            format=os.getenv("LOG_FORMAT", "console").strip().lower(),
            timezone=(_optional_str(os.getenv("LOG_TIMEZONE")) or _optional_str(os.getenv("TZ")) or "Europe/Athens"),
            redaction_secret=(
                _optional_str(os.getenv("LOG_REDACTION_SECRET"))
                or session_token_secret
                or "dialogue-bridge-log-redaction"
            ),
        ),
        cors=CorsSettings(
            allowed_origins=cors_allowed_origins,
            allow_credentials=cors_allow_credentials,
            allow_methods=cors_allow_methods,
            allow_headers=cors_allow_headers,
            expose_headers=cors_expose_headers,
            max_age_seconds=_as_int(os.getenv("CORS_MAX_AGE_SECONDS"), 600),
        ),
    )


settings = load_settings()
