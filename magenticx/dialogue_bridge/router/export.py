"""Export my data (plan 27): status, a one-time token, and the streamed download.

Thin: every rule — cooldown, concurrency, the token, what is exported and how
it is streamed — lives in ``utils.data_export``.

Why a token at all: the download is a plain GET, so the browser can save the
archive straight to disk instead of buffering it in JavaScript. A bare GET could
be started by any other site the user visits, on their cookies; the token can
only be minted by the CSRF-protected POST, so it cannot.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse

from core.auth.session import AuthUser, require_csrf_protection
from core.logging import set_context
from core.security.rate_limit import export_token_rate_limit
from schema import ExportStatus, ExportTokenRequest, ExportTokenResponse
from utils import validate_userId
from utils.data_export import export_status, issue_export_token, start_export_download

router = APIRouter()


@router.get("/{user_id}/status", response_model=ExportStatus, status_code=status.HTTP_200_OK)
async def get_export_status(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
) -> ExportStatus:
    """Whether exports are on, and when this user may start the next one."""
    set_context(user_id=user_id)
    return ExportStatus.model_validate(await export_status(user_id))


@router.post("/{user_id}/token", response_model=ExportTokenResponse, status_code=status.HTTP_200_OK)
async def create_export_token(
    user_id: str,
    payload: ExportTokenRequest,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    ___: None = Depends(export_token_rate_limit),
) -> ExportTokenResponse:
    """Mint a one-time, short-lived token for the download."""
    set_context(user_id=user_id)
    return ExportTokenResponse.model_validate(
        await issue_export_token(user_id, payload.includeAttachments)
    )


@router.get("/{user_id}/download", status_code=status.HTTP_200_OK)
async def download_export(
    user_id: str,
    token: str = Query(..., min_length=16, max_length=512),
    _: AuthUser = Depends(validate_userId),
) -> StreamingResponse:
    """The archive, streamed as it is built."""
    set_context(user_id=user_id)
    return await start_export_download(user_id, token)
