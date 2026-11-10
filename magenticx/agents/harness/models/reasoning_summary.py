"""Ask OpenAI's reasoning models for a summary of their reasoning.

OpenAI never returns a reasoning model's reasoning: through the Responses API
(deepagents' default for ``openai:*``) it comes back only as an encrypted item,
which the next turn sends back unread. Asked with ``reasoning={"summary": ...}``,
the model adds its own short summary of it, in parts — the normalizer turns each
part into a thought in the chat's CoT, beside the tool calls, and Langfuse shows
it instead of "Thinking (redacted)".

Only reasoning models get it: a non-reasoning model (gpt-4o) rejects the
parameter. Which is which: the model's ``reasoning`` in ``ALLOWED_AGENT_MODELS``,
else the pinned langchain-openai's model table (it knows the models older than it). The kwarg rides
deepagents' ``ProviderProfile``, the same registry the context windows ride
(``DeepAgent.register_model_windows``), so it applies wherever deepagents
resolves the spec — the agent, every sub-agent, its summarizer. Which specs
an agent uses is the caller's to say (``DeepAgent`` walks its sub-agent tree).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from deepagents import ProviderProfile, register_provider_profile

from core.logging import get_logger
from core.settings import settings

try:
    # Private, but it is the very table ``model.profile`` is filled from.
    from langchain_openai.chat_models.base import _get_default_model_profile as _openai_profile
except ImportError:  # without langchain-openai no model is known to reason
    _openai_profile = None

logger = get_logger(__name__)

_DATED_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")

#: Specs this process already asked for summaries (registration merges, so once is enough).
_registered: set[str] = set()


def is_reasoning_model(spec: str) -> bool:
    """True for an OpenAI reasoning model (gpt-5, o3, o4-mini, …), by exact ``provider:model`` spec."""
    info = settings.registry.allowed_agent_models.get(spec)
    if info is not None and info.reasoning is not None:
        return info.reasoning
    provider, _, name = spec.partition(":")
    if provider != "openai" or not name or _openai_profile is None:
        return False
    # A dated name (gpt-5-2025-08-07) is listed under its base name.
    for candidate in (name, _DATED_SUFFIX.sub("", name)):
        profile = _openai_profile(candidate) or {}
        if profile:
            return bool(profile.get("reasoning_output"))
    return False


def register_reasoning_summaries(specs: Iterable[str]) -> None:
    """Ask every reasoning model among ``specs`` (``provider:model``) for its reasoning summary.

    Runs before anything resolves those specs; ``REASONING_SUMMARY=off`` asks
    for none. The caller names the specs — an agent, its whole sub-agent tree.
    """
    mode = settings.model_profiles.reasoning_summary
    if mode == "off":
        return
    for spec in sorted(set(specs)):
        if spec in _registered or not is_reasoning_model(spec):
            continue
        register_provider_profile(spec, ProviderProfile(init_kwargs={"reasoning": {"summary": mode}}))
        _registered.add(spec)
        logger.info("reasoning_summary_registered", "Asked a reasoning model for its reasoning summary",
                    model=spec, summary=mode)
