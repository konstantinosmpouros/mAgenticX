"""The deep agents' summarizer: when the conversation is compacted, and how that is reported.

deepagents keeps a compaction as one private key in the branch's checkpoint,
``_summarization_event`` = ``{cutoff_index, summary_message, file_path}``; every
later model call sees ``summary + messages[cutoff:]``. This module tunes when it
fires on its own, where every compaction cuts (the latest question, plan 34),
and stamps an automatic compaction on the reply that follows it, so the AG-UI
normalizer can show it in the conversation.
"""
from typing import Any, Awaitable, Callable, Optional

from deepagents import HarnessProfile, register_harness_profile
from deepagents._models import resolve_model
from deepagents.middleware.summarization import SummarizationMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage

from core.settings import settings
from core.logging import get_logger

logger = get_logger(__name__)


# deepagents' auto-added summarizer reports this public ``.name`` alias; our
# subclass below reports its own class name instead, which is what lets the
# HarnessProfile exclusion drop ONLY the stock instance.
_STOCK_SUMMARIZATION_NAME = "SummarizationMiddleware"

#: The private state key deepagents stores a compaction under.
EVENT_KEY = "_summarization_event"

#: Key on ``AIMessage.response_metadata`` the normalizer reads: set on the reply
#: of the model call an automatic compaction ran in front of.
COMPACTION_KEY = "mx_compaction"

# Profile keys we have already registered the exclusion for this process. The
# registry is global and merge-idempotent, but guarding avoids re-merging (and
# the INFO log) on every agent rebuild.
_excluded_keys: set[str] = set()


def summarized_slice(effective: list[AnyMessage], previous: Any, event: dict[str, Any]) -> int:
    """How many leading messages of ``effective`` a compaction replaced.

    ``effective`` is the list the model saw before it (``summary +
    messages[old cutoff:]``, or every message when there was none). The event
    stores an absolute state index; deepagents derives it as ``old cutoff +
    effective cutoff - 1`` when an older summary sat at the front, so this
    inverts that.
    """
    cutoff = event.get("cutoff_index")
    if not isinstance(cutoff, int):
        return 0
    prior = previous.get("cutoff_index") if isinstance(previous, dict) else None
    count = cutoff - prior + 1 if isinstance(prior, int) else cutoff
    return max(0, min(count, len(effective)))


def is_summary(message: Any) -> bool:
    """The summary message a compaction put at the front (deepagents tags it)."""
    return isinstance(message, HumanMessage) and (message.additional_kwargs or {}).get("lc_source") == "summarization"


def summary_cutoff(messages: list[AnyMessage]) -> int:
    """Where a compaction cuts the list the model sees: at the newest question.

    Everything before it — the previous summary, if any, and every exchange
    since — is folded into the new summary; the latest exchange (the question,
    its tool calls and the answer) stays whole. 0 means nothing to fold: no
    earlier exchange, or only the previous summary itself.
    """
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], HumanMessage) and not is_summary(messages[index]):
            return 0 if index == 1 and is_summary(messages[0]) else index
    return 0


def visible_messages(messages: list[AnyMessage], start: int, end: int) -> int:
    """How many of ``messages[start:end]`` the person sees in the chat.

    Their questions, and the agent's answer that closes each turn — never a
    tool call, a tool result, or an earlier summary — so the count matches the
    bubbles on screen.
    """
    count = 0
    for index in range(max(start, 0), min(end, len(messages))):
        message = messages[index]
        if isinstance(message, HumanMessage):
            count += 0 if is_summary(message) else 1
        elif isinstance(message, AIMessage):
            following = messages[index + 1] if index + 1 < len(messages) else None
            count += 1 if following is None or isinstance(following, HumanMessage) else 0
    return count


def tokens_freed(token_counter: Callable[..., int], summarized: list[AnyMessage], summary_message: Any) -> int:
    """Estimated tokens a compaction took out of the prompt.

    Both sides use the summarizer's own (approximate) counter, so the figure is
    consistent with itself; the provider's count on the next call is the truth.
    """
    try:
        return max(0, int(token_counter(summarized)) - int(token_counter([summary_message])))
    except (TypeError, ValueError):
        return 0


class ConfigurableSummarizationMiddleware(SummarizationMiddleware):
    """deepagents summarization with mAgenticX-tuned, env-driven thresholds.

    A thin subclass exists because ``create_deep_agent`` always auto-injects its
    own stock ``SummarizationMiddleware`` and offers no way to configure its
    trigger. We drop the stock one via
    ``HarnessProfile(excluded_middleware={"SummarizationMiddleware"})`` and add
    this in its place. The subclass has a distinct type AND ``.name``
    (``"ConfigurableSummarizationMiddleware"``), so the exclusion — which matches
    the stock instance by exact type / ``.name`` — leaves this one untouched.
    All useful behaviour (history offload to ``/conversation_history/``,
    ContextOverflowError fallback, tool-arg truncation) is inherited unchanged.

    Additions (plan 34): it cuts at the latest question (:func:`summary_cutoff`)
    instead of keeping a share of the window, its summary reads ALL of what it
    folds (deepagents trims that to the newest 4000 tokens, which left a long
    answer unsummarizable), and it stamps an automatic compaction on the reply
    it ran in front of
    (``response_metadata["mx_compaction"]``) — deep agents stream no custom
    channel, so like the usage metrics the stamp rides the settled message.
    """

    def __init__(self, model: Any, *, backend: Any, trigger: Any, keep: Any) -> None:
        super().__init__(model, backend=backend, trigger=trigger, keep=keep, trim_tokens_to_summarize=None)
        self.trigger_spec = trigger
        self.keep_spec = keep

    def _determine_cutoff_index(self, messages: list[AnyMessage]) -> int:
        return summary_cutoff(messages)

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        state = request.state or {}
        previous = state.get(EVENT_KEY)
        effective = self._apply_event_to_messages(list(state.get("messages") or []), previous)
        response = await super().awrap_model_call(request, handler)
        self._stamp_compaction(response, effective, previous)
        return response

    def _stamp_compaction(self, response: Any, effective: list[AnyMessage], previous: Any) -> None:
        """Mark the reply when this call compacted the conversation first.

        Never fails the call: a reply without the stamp is still a reply, so an
        unexpected response shape is logged and skipped.
        """
        if not isinstance(response, ExtendedModelResponse):
            return
        update = getattr(response.command, "update", None)
        event = update.get(EVENT_KEY) if isinstance(update, dict) else None
        if not isinstance(event, dict) or event is previous:
            return
        try:
            count = summarized_slice(effective, previous, event)
            stamp = {
                "freed": tokens_freed(self.token_counter, effective[:count], event.get("summary_message")),
                "summarized_messages": visible_messages(effective, 0, count),
                "kept_messages": visible_messages(effective, count, len(effective)),
            }
            for message in getattr(response.model_response, "result", None) or []:
                if isinstance(message, AIMessage):
                    message.response_metadata = {**(message.response_metadata or {}), COMPACTION_KEY: stamp}
        except (AttributeError, TypeError, ValueError) as exc:
            logger.warning(
                "compaction_stamp_skipped",
                "Could not mark a reply as following an automatic compaction",
                error_type=type(exc).__name__,
            )


def find_summarizer(stack: Optional[list[Any]]) -> Optional[ConfigurableSummarizationMiddleware]:
    """The stack's own summarizer, or ``None`` when the agent runs without one."""
    return next((m for m in stack or [] if isinstance(m, ConfigurableSummarizationMiddleware)), None)


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
