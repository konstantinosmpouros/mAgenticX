"""The user's own account: Edit profile, and Delete account (plan 32).

Thin: the rules — recent sign-in, typed confirmation, one open request, what
a pending deletion freezes, and the purge itself — live in
``utils.account_deletion``.

Status and cancel stay reachable while the account awaits deletion (that is the
whole point of the grace period); requesting does not — a pending account has
nothing left to request.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import (
    AuthContext,
    AuthUser,
    clear_session_cookies,
    get_device_id,
    require_csrf_protection,
    require_current_user,
    require_session,
)
from core.database import get_db
from core.logging import set_context
from core.security.rate_limit import account_deletion_rate_limit, profile_update_rate_limit
from schema import AccountDeletionRequest, AccountDeletionStatus, ProfileUpdate, UserProfile
from utils import validate_userId, validate_userId_even_if_pending
from utils.account_deletion import cancel_deletion, deletion_status, request_deletion
from utils.profile import (
    load_avatar,
    may_view_avatar,
    read_capped_upload,
    remove_avatar,
    save_avatar,
    update_preferred_name,
)

router = APIRouter()


@router.patch("/{user_id}/profile", response_model=UserProfile, status_code=status.HTTP_200_OK)
async def update_profile(
    user_id: str,
    payload: ProfileUpdate,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id}.
    ___: None = Depends(profile_update_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    """Change the name the app shows; ``null`` goes back to Microsoft's."""
    return UserProfile.model_validate(await update_preferred_name(db, user_id, payload.displayName))


@router.put("/{user_id}/avatar", response_model=UserProfile, status_code=status.HTTP_200_OK)
async def upload_avatar(
    user_id: str,
    photo: UploadFile = File(...),
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    ___: None = Depends(profile_update_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    """Set the user's photo. Re-encoded server-side; never stored as sent."""
    return UserProfile.model_validate(await save_avatar(db, user_id, await read_capped_upload(photo)))


@router.delete("/{user_id}/avatar", response_model=UserProfile, status_code=status.HTTP_200_OK)
async def delete_avatar(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    ___: None = Depends(profile_update_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    """Remove the user's photo; the app goes back to initials."""
    return UserProfile.model_validate(await remove_avatar(db, user_id))


@router.get("/{user_id}/avatar", status_code=status.HTTP_200_OK)
async def get_avatar(
    user_id: str,
    request: Request,
    viewer: AuthUser = Depends(require_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The photo, for its owner and the accounts signed in on the same browser.

    404 — not 403 — when the viewer may not see it, so the endpoint never says
    whether someone else has a photo. The URL is versioned (``?v=``), so the
    browser may keep it; ``private`` keeps shared caches out.
    """
    if not await may_view_avatar(viewer.id, user_id, get_device_id(request)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No photo.")
    avatar = await load_avatar(db, user_id)
    if avatar is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No photo.")
    return Response(
        content=avatar.data,
        media_type=avatar.mime,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            # Opened directly, the response can never run anything.
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.get("/{user_id}/deletion", response_model=AccountDeletionStatus, status_code=status.HTTP_200_OK)
async def get_deletion_status(
    user_id: str,
    _: AuthUser = Depends(validate_userId_even_if_pending),
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AccountDeletionStatus:
    """Whether a deletion is pending, and whether this session may request one."""
    set_context(user_id=user_id)
    return AccountDeletionStatus.model_validate(await deletion_status(db, user_id, ctx.login_at))


@router.post("/{user_id}/deletion", response_model=AccountDeletionStatus, status_code=status.HTTP_202_ACCEPTED)
async def request_account_deletion(
    user_id: str,
    payload: AccountDeletionRequest,
    response: Response,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id}.
    ___: None = Depends(account_deletion_rate_limit),
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AccountDeletionStatus:
    """Schedule the account for deletion. Every session ends, this one included."""
    set_context(user_id=user_id)
    result = await request_deletion(db, user_id, payload.confirmEmail, ctx.login_at)
    clear_session_cookies(response)
    return AccountDeletionStatus.model_validate(result)


@router.delete("/{user_id}/deletion", response_model=AccountDeletionStatus, status_code=status.HTTP_200_OK)
async def cancel_account_deletion(
    user_id: str,
    _: AuthUser = Depends(validate_userId_even_if_pending),
    __: None = Depends(require_csrf_protection),
    ___: None = Depends(account_deletion_rate_limit),
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AccountDeletionStatus:
    """Cancel a pending deletion while the purge has not started."""
    set_context(user_id=user_id)
    return AccountDeletionStatus.model_validate(await cancel_deletion(db, user_id, ctx.login_at))
