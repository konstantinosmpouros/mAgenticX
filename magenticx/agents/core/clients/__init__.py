"""Outbound API client factories (OpenAI and the like).

One module per external provider so credentials/config wiring lives in one
place per client. Re-exported so callers keep the stable
``from core.clients import ...`` import surface regardless of how the package
is split internally.
"""
from core.clients.openai import get_openai_client

__all__ = ["get_openai_client"]
