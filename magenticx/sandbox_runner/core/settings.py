"""Every environment variable the sandbox runner consumes (plan 11 §3.2).

Each sandbox control is a field with a conservative default rather than a
literal at the call site, so a limit is changed in one place and visible in
one place. Bounds on the fields keep a typo in the environment from turning a
control off (e.g. a zero or negative memory limit).

The runner refuses to start without the internal-caller secret — the same
fail-closed stance as every other internal service. TLS / mTLS enforcement
lives in the image entrypoint (``entrypoint.sh``), which is what starts
uvicorn, mirroring ``tls/entrypoint-tls.sh``.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BASE_MODEL_CONFIG = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
    case_sensitive=False,
)

_MIB = 1024 * 1024


def _resolve_file_backed_secret(env_file_var: str, raw: Any) -> str:
    """Prefer ``<NAME>_FILE`` (a Swarm/compose secret) over the plain env var."""
    file_path = os.getenv(env_file_var)
    if file_path:
        try:
            return Path(file_path).read_text().strip()
        except OSError as exc:
            raise RuntimeError(f"Cannot read {env_file_var}={file_path!r}: {exc}") from exc
    if raw is None:
        return ""
    return str(raw).strip()


class AppSettings(BaseSettings):
    """Process-level knobs shared with the other services."""

    model_config = _BASE_MODEL_CONFIG

    environment: str = Field("development", validation_alias="ENVIRONMENT")
    log_level: str = Field("INFO", validation_alias="LOG_LEVEL")
    log_format: str = Field("console", validation_alias="LOG_FORMAT")


_DEFAULT_REDACTION_SECRET = "sandbox-runner-log-redaction"


class LoggingSettings(BaseSettings):
    """The shared HMAC key that pseudonymizes ids in logs (cross-service)."""

    model_config = _BASE_MODEL_CONFIG

    redaction_secret: SecretStr = Field(default_factory=lambda: SecretStr(""))
    # Length of the command prefix kept in the audit record (the full command
    # is represented by its SHA-256 only).
    audit_command_prefix_chars: int = Field(80, ge=0, le=256, validation_alias="SANDBOX_AUDIT_COMMAND_PREFIX_CHARS")

    @field_validator("redaction_secret", mode="before")
    @classmethod
    def _load_redaction_secret(cls, value: Any) -> Any:
        if isinstance(value, SecretStr) and value.get_secret_value():
            return value
        if isinstance(value, str) and value:
            return value
        resolved = _resolve_file_backed_secret("LOG_REDACTION_SECRET_FILE", os.getenv("LOG_REDACTION_SECRET"))
        return resolved or _DEFAULT_REDACTION_SECRET


class ProxySettings(BaseSettings):
    """The internal-caller shared secret (``X-Internal-Proxy-Secret``)."""

    model_config = _BASE_MODEL_CONFIG

    trusted_proxy_header_name: str = Field("X-Internal-Proxy-Secret", validation_alias="TRUSTED_PROXY_HEADER_NAME")
    trusted_proxy_secret: SecretStr = Field(default_factory=lambda: SecretStr(""), validation_alias="TRUSTED_PROXY_SECRET")

    @field_validator("trusted_proxy_secret", mode="before")
    @classmethod
    def _resolve_secret(cls, v: Any) -> Any:
        return _resolve_file_backed_secret("TRUSTED_PROXY_SECRET_FILE", v) or ""


class SandboxSettings(BaseSettings):
    """The box: where it reads/writes, and every limit it runs under (§3.2)."""

    model_config = _BASE_MODEL_CONFIG

    # --- Per-call files -----------------------------------------------------
    # Conversation files live in the database (plan 36), so they travel in the
    # request/response. Each call gets a fresh 0700 dir <calls_root>/<uuid>/
    # with in/ and out/, removed when the call ends. Never a shared volume.
    calls_root: Path = Field(Path("/var/lib/sandbox-runner/calls"), validation_alias="SANDBOX_CALLS_ROOT")
    # Total decoded bytes of the files sent with one request (413 above it).
    max_input_bytes: int = Field(20 * _MIB, ge=0, le=1024 * _MIB, validation_alias="SANDBOX_MAX_INPUT_BYTES")
    # Caps on the files returned: one file, and all of them together. Files
    # beyond either are left out and `files_truncated` is set.
    max_output_file_bytes: int = Field(25 * _MIB, ge=0, le=1024 * _MIB, validation_alias="SANDBOX_MAX_OUTPUT_FILE_BYTES")
    max_output_total_bytes: int = Field(50 * _MIB, ge=0, le=1024 * _MIB, validation_alias="SANDBOX_MAX_OUTPUT_TOTAL_BYTES")

    # --- Inner daemon / image ----------------------------------------------
    docker_bin: str = Field("docker", validation_alias="SANDBOX_DOCKER_BIN")
    docker_host: str = Field("unix:///var/run/docker.sock", validation_alias="SANDBOX_DOCKER_HOST")
    image: str = Field("magenticx-sandbox-box:local", validation_alias="SANDBOX_IMAGE")
    runtime: str = Field("runsc", validation_alias="SANDBOX_RUNTIME")
    # The box's uid:gid — 1000 so output/ stays writable by the agents service
    # (which owns the volume as 1000) and by the box (plan 11 §4).
    user: str = Field("1000:1000", pattern=r"^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$", validation_alias="SANDBOX_USER")

    # --- Wall clock ---------------------------------------------------------
    default_timeout_seconds: int = Field(60, ge=1, le=3600, validation_alias="SANDBOX_DEFAULT_TIMEOUT_SECONDS")
    max_wall_seconds: int = Field(300, ge=1, le=3600, validation_alias="SANDBOX_MAX_WALL_SECONDS")

    # --- Resources ----------------------------------------------------------
    memory: str = Field("1g", pattern=r"^[1-9][0-9]*[kmg]$", validation_alias="SANDBOX_MEMORY")
    cpus: float = Field(1.0, gt=0, le=64, validation_alias="SANDBOX_CPUS")
    pids_limit: int = Field(128, ge=8, le=4096, validation_alias="SANDBOX_PIDS_LIMIT")
    nofile: int = Field(256, ge=16, le=65536, validation_alias="SANDBOX_NOFILE")
    # RLIMIT_FSIZE in bytes: the largest single file the box may write.
    fsize_bytes: int = Field(100 * _MIB, ge=_MIB, validation_alias="SANDBOX_FSIZE_BYTES")
    tmp_size: str = Field("64m", pattern=r"^[1-9][0-9]*[kmg]$", validation_alias="SANDBOX_TMP_SIZE")

    # --- Output -------------------------------------------------------------
    # Returned per stream; anything beyond is dropped and `truncated` is set.
    max_output_bytes: int = Field(64 * 1024, ge=1024, le=16 * _MIB, validation_alias="SANDBOX_MAX_OUTPUT_BYTES")
    # Total bytes read across both streams before the box is killed with
    # killed_reason="output_limit" (draining an endless `yes` would otherwise
    # run until the wall clock).
    output_kill_bytes: int = Field(16 * _MIB, ge=64 * 1024, validation_alias="SANDBOX_OUTPUT_KILL_BYTES")

    # --- Disk ---------------------------------------------------------------
    # Per-call budget on the size of out/ (polled while the box runs and
    # measured after it); above it the call ends with killed_reason="disk_limit".
    disk_budget_bytes: int = Field(100 * _MIB, ge=_MIB, validation_alias="SANDBOX_DISK_BUDGET_BYTES")
    disk_poll_seconds: float = Field(1.0, gt=0, le=30, validation_alias="SANDBOX_DISK_POLL_SECONDS")

    # --- Admission ----------------------------------------------------------
    max_concurrent: int = Field(4, ge=1, le=64, validation_alias="SANDBOX_MAX_CONCURRENT")
    # How long a call waits for a free slot before it is refused with 429.
    queue_timeout_seconds: float = Field(10.0, ge=0, le=300, validation_alias="SANDBOX_QUEUE_TIMEOUT_SECONDS")

    # --- Health -------------------------------------------------------------
    # /health runs a real runsc box; its verdict is reused for this long so a
    # probe storm cannot turn into a box storm.
    health_cache_seconds: float = Field(30.0, ge=0, le=600, validation_alias="SANDBOX_HEALTH_CACHE_SECONDS")
    health_timeout_seconds: int = Field(30, ge=1, le=300, validation_alias="SANDBOX_HEALTH_TIMEOUT_SECONDS")
    # Grace after a `docker kill` for the CLI to return before it is killed too.
    kill_grace_seconds: float = Field(10.0, gt=0, le=60, validation_alias="SANDBOX_KILL_GRACE_SECONDS")

    @model_validator(mode="after")
    def _default_within_max(self) -> "SandboxSettings":
        if self.default_timeout_seconds > self.max_wall_seconds:
            raise ValueError("SANDBOX_DEFAULT_TIMEOUT_SECONDS must not exceed SANDBOX_MAX_WALL_SECONDS")
        return self


class Settings(BaseSettings):
    """Top-level settings object; ``settings`` below is the process singleton."""

    model_config = _BASE_MODEL_CONFIG

    app: AppSettings = Field(default_factory=AppSettings)
    proxy: ProxySettings = Field(default_factory=ProxySettings)
    logging: LoggingSettings = Field(default_factory=LoggingSettings)
    sandbox: SandboxSettings = Field(default_factory=SandboxSettings)

    @model_validator(mode="after")
    def _require_proxy_secret(self) -> "Settings":
        if not self.proxy.trusted_proxy_secret.get_secret_value():
            raise ValueError(
                "TRUSTED_PROXY_SECRET must be set. Refusing to start without an internal-caller shared secret."
            )
        return self

    @model_validator(mode="after")
    def _harden_redaction_secret(self) -> "Settings":
        # A missing (or sentinel) key falls back to a random per-process key so
        # pseudonymization stays one-way; provision LOG_REDACTION_SECRET_FILE in
        # prod so hashes correlate across services.
        if self.logging.redaction_secret.get_secret_value() in ("", _DEFAULT_REDACTION_SECRET):
            object.__setattr__(self.logging, "redaction_secret", SecretStr(secrets.token_hex(32)))
        return self


settings = Settings()
