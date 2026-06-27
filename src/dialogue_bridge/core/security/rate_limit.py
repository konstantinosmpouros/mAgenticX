from fastapi import Request
from slowapi import Limiter

from core.settings import settings
from core.security.internal_trust import resolve_client_ip

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
    settings.rate_limit.auth_max_attempts,
    settings.rate_limit.auth_window_seconds,
)

INFERENCE_RATE_LIMIT = _build_limit_string(
    settings.rate_limit.inference_max_attempts,
    settings.rate_limit.inference_window_seconds,
)


def client_identifier(request: Request) -> str:
    resolved_ip = resolve_client_ip(request)
    return resolved_ip or "unknown"


def inference_user_key(request: Request) -> str:
    return request.path_params.get("user_id") or resolve_client_ip(request) or "unknown"


limiter = Limiter(key_func=client_identifier)
