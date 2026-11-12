"""``GET /v1/favicons/{user_id}?host=…`` — a site's icon for the source chips (plan 42).

Thin: auth, rate limit, then :func:`utils.favicons.get_favicon`. Signed-in users
only, so the bridge is not an open icon proxy. The bytes are untrusted, so the
response forbids sniffing and sandboxes itself should anyone open it directly.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from core.auth.session import AuthUser
from core.security.rate_limit import favicon_rate_limit
from utils.favicons import get_favicon
from utils.validators import validate_userId

router = APIRouter()

#: Headers on every icon: cache in this browser only, never sniff, never run.
_ICON_HEADERS = {
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


@router.get("/{user_id}", response_class=Response)
async def getFavicon(
    user_id: str,
    host: str = Query(..., min_length=1, max_length=253),
    _user: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}.
    _rate_limited: None = Depends(favicon_rate_limit),
) -> Response:
    """The icon of ``host``'s pages, or 404 when it has none (the chip shows its initial)."""
    icon = await get_favicon(host)
    if icon is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No icon.")
    return Response(content=icon.data, media_type=icon.content_type, headers=_ICON_HEADERS)
