from fastapi import Request
from slowapi import Limiter

from core.config import settings
from utils.proxy import resolve_client_ip


AUTH_RATE_LIMIT_MAX_ATTEMPTS = settings.rate_limit.auth_max_attempts
AUTH_RATE_LIMIT_WINDOW_SECONDS = settings.rate_limit.auth_window_seconds


def _build_limit_string(max_attempts: int, window_seconds: int) -> str:
    if window_seconds <= 0:
        raise ValueError("AUTH_RATE_LIMIT_WINDOW_SECONDS must be greater than zero.")

    if window_seconds % 3600 == 0:
        hours = window_seconds // 3600
        if hours == 1:
            return f"{max_attempts}/hour"
        return f"{max_attempts}/{hours} hour"

    if window_seconds % 60 == 0:
        minutes = window_seconds // 60
        if minutes == 1:
            return f"{max_attempts}/minute"
        return f"{max_attempts}/{minutes} minute"

    return f"{max_attempts}/{window_seconds} second"


AUTHENTICATE_LIMIT = _build_limit_string(
    AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    AUTH_RATE_LIMIT_WINDOW_SECONDS,
)


def client_identifier(request: Request) -> str:
    resolved_ip = resolve_client_ip(request)
    return resolved_ip or "unknown"


limiter = Limiter(key_func=client_identifier)
