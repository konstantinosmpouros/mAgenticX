"""Delete account (plan 32): status, request, cancel.

Thin: the rules — recent sign-in, typed confirmation, one open request, what
a pending deletion freezes, and the purge itself — live in
``utils.account_deletion``.

Status and cancel stay reachable while the account awaits deletion (that is the
whole point of the grace period); requesting does not — a pending account has
nothing left to request.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthContext, AuthUser, clear_session_cookies, require_csrf_protection, require_session
from core.database import get_db
from core.logging import set_context
from core.security.rate_limit import account_deletion_rate_limit
from schema import AccountDeletionRequest, AccountDeletionStatus
from utils import validate_userId, validate_userId_even_if_pending
from utils.account_deletion import cancel_deletion, deletion_status, request_deletion

router = APIRouter()


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
