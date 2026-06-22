from typing import Any

from deepagents import HarnessProfile, register_harness_profile
from deepagents._models import resolve_model
from deepagents.middleware.summarization import SummarizationMiddleware

from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)


# deepagents' auto-added summarizer reports this public ``.name`` alias; our
# subclass below reports its own class name instead, which is what lets the
# HarnessProfile exclusion drop ONLY the stock instance.
_STOCK_SUMMARIZATION_NAME = "SummarizationMiddleware"

# Profile keys we have already registered the exclusion for this process. The
# registry is global and merge-idempotent, but guarding avoids re-merging (and
# the INFO log) on every agent rebuild.
_excluded_keys: set[str] = set()


class ConfigurableSummarizationMiddleware(SummarizationMiddleware):
    """deepagents summarization with mAgenticX-tuned, env-driven thresholds.

    A thin subclass exists for one reason: ``create_deep_agent`` always
    auto-injects its own stock ``SummarizationMiddleware`` and offers no way to
    configure its trigger. We drop the stock one via
    ``HarnessProfile(excluded_middleware={"SummarizationMiddleware"})`` and add
    this in its place. The subclass has a distinct type AND ``.name``
    (``"ConfigurableSummarizationMiddleware"``), so the exclusion — which matches
    the stock instance by exact type / ``.name`` — leaves this one untouched.
    All useful behaviour (history offload to ``/conversation_history/``,
    ContextOverflowError fallback, tool-arg truncation) is inherited unchanged.
    """


def build_summarization_middleware(
    model: str | Any,
    backend: Any,
) -> ConfigurableSummarizationMiddleware:
    """Construct the tuned summarizer for ``model`` over the agent's ``backend``.

    Thresholds come from ``settings.summarization`` and fire LATER than
    deepagents' stock defaults (0.85 of the window / 170k tokens). Fraction
    thresholds require a model that exposes a token-window profile (e.g.
    ``openai:gpt-5`` → ``max_input_tokens``); for profile-less models the
    fraction form raises at construction, so we fall back to an absolute token
    trigger + message keep instead.

    ``backend`` is the same CompositeBackend factory the deep agent passes to
    ``create_deep_agent``, so summary offloads land on the same per-conversation
    disk as the agent's filesystem tools.
    """
    s = settings.summarization
    resolved = resolve_model(model) if isinstance(model, str) else model
    profile = getattr(resolved, "profile", None)
    has_window = isinstance(profile, dict) and isinstance(profile.get("max_input_tokens"), int)

    if has_window:
        trigger: tuple[str, Any] = ("fraction", s.trigger_fraction)
        keep: tuple[str, Any] = ("fraction", s.keep_fraction)
    else:
        trigger = ("tokens", s.trigger_tokens)
        keep = ("messages", s.keep_messages)

    logger.info(
        "summarization_middleware_built",
        "Built configurable summarization middleware",
        trigger=trigger,
        keep=keep,
        has_window=has_window,
    )
    return ConfigurableSummarizationMiddleware(resolved, backend=backend, trigger=trigger, keep=keep)


def exclude_stock_summarization(model_spec: str) -> None:
    """Drop deepagents' auto-added stock ``SummarizationMiddleware`` for ``model_spec``.

    ``create_deep_agent`` has no exclusion kwarg; the only override surface is
    the model's ``HarnessProfile``. Registration is additive and idempotent (the
    excluded-middleware sets union), and we key it to the exact model spec the
    agent passes to ``create_deep_agent`` so sibling models (e.g. sub-agent
    models) keep their own stock summarizer. Without this, the stock summarizer
    coexists with ours and — because triggers are OR-combined — its lower
    threshold would always win.
    """
    if not isinstance(model_spec, str) or not model_spec:
        logger.warning(
            "summarization_exclusion_skipped",
            "Cannot exclude stock summarization without a string model spec",
        )
        return
    if model_spec in _excluded_keys:
        return
    register_harness_profile(
        model_spec,
        HarnessProfile(excluded_middleware={_STOCK_SUMMARIZATION_NAME}),
    )
    _excluded_keys.add(model_spec)
