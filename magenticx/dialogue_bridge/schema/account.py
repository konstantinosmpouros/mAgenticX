"""Delete account (plan 32): the request, its status, and cancelling it."""
from typing import Optional

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

from schema.base import UTCDateTime


class AccountDeletionRequest(BaseModel):
    """The user's typed confirmation: the email (or, without one, the username)
    of the account. Compared on the server too, not only in the UI."""

    model_config = ConfigDict(extra="forbid")

    confirmEmail: str = Field(..., min_length=1, max_length=320)


# Control and format characters (C*), incl. bidi overrides that could make a
# name render as something else next to other people's.
_UNPRINTABLE = re.compile(r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")


class ProfileUpdate(BaseModel):
    """Edit profile: the name the app shows.

    ``null`` or blank goes back to the name Microsoft sends. Whitespace runs
    collapse to one space; invisible and direction-changing characters are
    refused rather than stripped, so what is saved is exactly what was typed.
    """

    model_config = ConfigDict(extra="forbid")

    displayName: Optional[str] = Field(None, max_length=64)

    @field_validator("displayName")
    @classmethod
    def _clean(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if _UNPRINTABLE.search(value):
            raise ValueError("The name contains characters that cannot be shown.")
        cleaned = " ".join(value.split())
        return cleaned or None


class AccountDeletionStatus(BaseModel):
    """Everything the Delete account card and the pending-deletion screen need."""

    enabled: bool
    pending: bool
    requestedAt: Optional[UTCDateTime] = None
    scheduledFor: Optional[UTCDateTime] = None
    # The purge has started: it can no longer be cancelled.
    inProgress: bool = False
    graceDays: int
    # The session's sign-in is too old to request a deletion; sign in again first.
    reauthRequired: bool
    # What the user must type to confirm — their own email or username.
    confirmWith: str
