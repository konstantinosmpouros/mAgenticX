"""Data export DTOs (plan 27): status, token request, token response.

The export itself is a streamed zip, not JSON, so it has no response model.
"""
from typing import Optional

from pydantic import BaseModel


class ExportStatus(BaseModel):
    """Whether exports are on, and when this user may start the next one.

    ``availableAt`` is an ISO-8601 UTC instant while the cooldown runs, else
    ``None`` (an export can start now).
    """

    enabled: bool
    availableAt: Optional[str] = None
    cooldownMinutes: int


class ExportTokenRequest(BaseModel):
    """Which export to prepare. ``False`` is the fast text-only export."""

    includeAttachments: bool = True


class ExportTokenResponse(BaseModel):
    """A one-time download token, valid for ``expiresInSeconds``."""

    token: str
    expiresInSeconds: int
