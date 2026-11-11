"""Reasoning effort: how hard a reasoning model thinks before it answers.

The user picks a level per message in the composer; the bridge puts it in the
run context as ``effort`` (absent when they picked none). It is applied **per
model call**, by :class:`EffortMiddleware`, rather than when the model is built:
deepagents' ``ProviderProfile`` (where the reasoning summary is asked for) is one
registry for the whole process, so an effort set there would be every user's.
A middleware sees the call's model and only this run's choice.

Only a model that lists the level in its ``ModelInfo.efforts`` gets it; any
other model call in the run (a gpt-4o sub-agent, a model the platform does not
describe) is sent exactly what it would be without the feature. A level is
never "rounded" to a neighbour: the picker only offers what the agent's main
model accepts, so a mismatch means a sub-agent on another model, which keeps
its own default.

Provider wiring lives in one table, :data:`_PROVIDER_SETTINGS`. OpenAI takes
``reasoning={"effort": ...}``; that dict replaces the one the model was built
with, so the reasoning summary asked for at build time is carried over.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, get_args

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse

from core.settings import EFFORT_LEVELS, EffortLevel, settings


def parse_effort(value: Any) -> EffortLevel | None:
    """The run context's ``effort`` if it is a known level, else ``None`` (fail closed)."""
    if isinstance(value, str) and value in get_args(EffortLevel):
        return value  # type: ignore[return-value]
    return None


def model_spec_of(model: Any) -> str | None:
    """``provider:model`` of a LangChain chat model, as ``ALLOWED_AGENT_MODELS`` keys it."""
    try:
        params = model._get_ls_params()
    except (AttributeError, TypeError):
        return None
    provider, name = params.get("ls_provider"), params.get("ls_model_name")
    if not isinstance(provider, str) or not isinstance(name, str) or not provider or not name:
        return None
    return f"{provider}:{name}"


def supported_efforts(spec: str | None) -> tuple[EffortLevel, ...]:
    """The levels a model accepts, weakest first; empty when it takes none."""
    info = settings.registry.allowed_agent_models.get(spec or "")
    if info is None:
        return ()
    return tuple(level for level in EFFORT_LEVELS if level in info.efforts)


def default_effort(spec: str | None) -> EffortLevel | None:
    """The level the picker starts on for this model, if it takes any."""
    info = settings.registry.allowed_agent_models.get(spec or "")
    return info.default_effort if info is not None and info.efforts else None


def _openai_settings(model: Any, current: Mapping[str, Any], effort: EffortLevel) -> dict[str, Any]:
    """OpenAI: ``reasoning.effort``, keeping whatever else ``reasoning`` carried (the summary)."""
    built = getattr(model, "reasoning", None)
    reasoning = {**(built if isinstance(built, Mapping) else {}), **(current.get("reasoning") or {})}
    return {"reasoning": {**reasoning, "effort": effort}}


#: provider -> how to say "think this hard" in that provider's call settings.
_PROVIDER_SETTINGS: dict[str, Callable[[Any, Mapping[str, Any], EffortLevel], dict[str, Any]]] = {
    "openai": _openai_settings,
}


def effort_model_settings(model: Any, current: Mapping[str, Any], effort: EffortLevel) -> dict[str, Any] | None:
    """The call settings that apply ``effort`` to ``model``, or ``None`` to send nothing."""
    spec = model_spec_of(model)
    if effort not in supported_efforts(spec):
        return None
    provider = (spec or "").partition(":")[0]
    build = _PROVIDER_SETTINGS.get(provider)
    return build(model, current, effort) if build is not None else None


class EffortMiddleware(AgentMiddleware):
    """Sends this run's reasoning effort with every model call that accepts it.

    One instance per agent build, which is per request: it holds the run's
    level and nothing else. On the main agent and every sub-agent and task
    node, so a delegated sub-agent thinks as hard as the user asked.
    """

    def __init__(self, effort: EffortLevel) -> None:
        super().__init__()
        self.effort = effort

    def _apply(self, request: ModelRequest) -> ModelRequest:
        extra = effort_model_settings(request.model, request.model_settings, self.effort)
        if extra is None:
            return request
        return request.override(model_settings={**request.model_settings, **extra})

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        """Apply the effort, then call the model."""
        return handler(self._apply(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        """Apply the effort, then call the model."""
        return await handler(self._apply(request))
