"""Authentication + multi-account switcher DTOs."""
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from schema.base import UTCDateTime


class AuthRequest(BaseModel):
    """Schema for user authentication request."""
    username: str
    password: str


class UserProfile(BaseModel):
    """Public user profile returned to the client after authentication."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    username: str
    email: Optional[str] = None
    displayName: Optional[str] = Field(None, validation_alias="display_name")
    fullName: Optional[str] = Field(None, validation_alias="full_name")
    avatarUrl: Optional[str] = Field(None, validation_alias="avatar_url")
    department: Optional[str] = None
    roleTitle: Optional[str] = Field(None, validation_alias="role_title")
    lastLoginAt: Optional[UTCDateTime] = Field(None, validation_alias="last_login_at")
    isActive: bool = Field(..., validation_alias="is_active")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    updatedAt: UTCDateTime = Field(..., validation_alias="updated_at")


class AuthResponse(BaseModel):
    """Schema for user authentication response."""
    authenticated: bool = False
    user_id: str | None = None
    user: UserProfile | None = None
    tokenTtl: Optional[int] = None


class AccountSummary(BaseModel):
    """One account the browser is signed in to, for the switcher.

    Never carries a token — the parked credential stays server-side. ``expired``
    marks a parked session whose refresh token has aged out: it is still listed
    (silently vanishing looks like a bug) but selecting it re-authenticates.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    username: str
    email: Optional[str] = None
    displayName: Optional[str] = Field(None, validation_alias="display_name")
    avatarUrl: Optional[str] = Field(None, validation_alias="avatar_url")
    isActive: bool = Field(True, validation_alias="is_active")
    current: bool = False
    expired: bool = False


class AccountListResponse(BaseModel):
    """The switcher's contents plus whether more accounts may be added."""
    accounts: list[AccountSummary] = Field(default_factory=list)
    canAddAccount: bool = True
    maxAccounts: int = 0


class SwitchAccountRequest(BaseModel):
    """Promote a parked account to the active session."""
    user_id: str
