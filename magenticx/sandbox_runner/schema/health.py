"""Response of ``GET /health``: only ever ``ok`` after a real runsc box proved it."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Healthy means a ``--runtime=runsc`` box just ran and reported a gVisor kernel."""

    status: Literal["ok", "unavailable"]
    runtime: str
    gvisor: bool
