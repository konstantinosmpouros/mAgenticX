"""Delete account (plan 32): the request, its status, and cancelling it."""
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from schema.base import UTCDateTime


class AccountDeletionRequest(BaseModel):
    """The user's typed confirmation: the email (or, without one, the username)
    of the account. Compared on the server too, not only in the UI."""

    model_config = ConfigDict(extra="forbid")

    confirmEmail: str = Field(..., min_length=1, max_length=320)


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
