import os

from fastapi import Request
from slowapi import Limiter


AUTH_RATE_LIMIT_MAX_ATTEMPTS = int(os.getenv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", "4"))
AUTH_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", "60"))


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
    # Prefer the real client IP passed by Cloudflare / reverse proxies.
    cf_connecting_ip = request.headers.get("cf-connecting-ip")
    if cf_connecting_ip:
        return cf_connecting_ip.strip()

    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()

    x_real_ip = request.headers.get("x-real-ip")
    if x_real_ip:
        return x_real_ip.strip()

    if request.client and request.client.host:
        return request.client.host.strip()

    return "unknown"


limiter = Limiter(key_func=client_identifier)
