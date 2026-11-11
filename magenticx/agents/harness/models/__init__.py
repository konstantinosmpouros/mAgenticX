"""How the agents' chat models are built: provider settings applied when a model spec resolves."""

from harness.models.effort import (
    EffortMiddleware,
    default_effort,
    effort_model_settings,
    model_spec_of,
    parse_effort,
    supported_efforts,
)
from harness.models.reasoning_summary import (
    is_reasoning_model,
    register_reasoning_summaries,
)

__all__ = [
    "EffortMiddleware",
    "default_effort",
    "effort_model_settings",
    "is_reasoning_model",
    "model_spec_of",
    "parse_effort",
    "register_reasoning_summaries",
    "supported_efforts",
]
