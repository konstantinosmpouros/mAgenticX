"""What a model call cost (plan 41): per-model prices and the per-call formula.

The agents service reports every model call's tokens (``TOKEN_USAGE``); the
bridge prices them here when the answer finishes, so a price change never
needs a release of the agents and the cost of an answer is fixed at the moment
it was spent (it is stored, never re-priced on read).

Prices are USD per 1M tokens — ``input``, ``cached_input``, ``output`` — and,
for a model that charges more for long prompts, a ``long_context`` tier that
replaces all three for a call whose input exceeds ``above_input_tokens``.
Money is kept as integer micro-USD (1 USD = 1,000,000): tokens x USD per 1M
tokens is exactly micro-USD, so no float ever reaches the database.

Operators override or extend the defaults with a JSON object from
``MODEL_PRICES_JSON`` (or ``MODEL_PRICES_JSON_FILE``) — same shape as
``DEFAULT_PRICES`` below; ``null`` for a model removes its default price.
It is validated when this module is imported, at startup: a malformed value
stops the bridge instead of pricing every answer wrong.

A model with no price is "unpriced": ``call_cost_micros`` returns ``None`` and
the caller counts the call in ``unpriced_calls`` rather than pretending it was
free.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from core.settings import settings


@dataclass(frozen=True)
class PriceTier:
    """USD per 1M tokens for one tier of a model's price."""
    input: float
    cached_input: float
    output: float


@dataclass(frozen=True)
class ModelPrice:
    """A model's price: the base tier and, optionally, a long-context tier that
    applies to a call whose input tokens exceed ``long_context_above``."""
    base: PriceTier
    long_context_above: int | None = None
    long_context: PriceTier | None = None

    def tier_for(self, input_tokens: int) -> PriceTier:
        above = self.long_context_above
        if self.long_context is not None and above is not None and input_tokens > above:
            return self.long_context
        return self.base


# Defaults, USD per 1M tokens, as of 2026-10. To be verified by the owner
# against https://openai.com/api/pricing before relying on any figure:
# - o4-mini and gpt-4.1-mini: from OpenAI's own model pages.
# - every other model: from third-party price tables, not from OpenAI.
# - gpt-6-luna: one source lists $0.20 input / $1.20 output instead of the
#   $0.10 / $0.50 used here — the two conflict; verify before trusting it.
# Override any of them without a release through MODEL_PRICES_JSON.
DEFAULT_PRICES: dict[str, dict[str, Any]] = {
    "gpt-6-luna": {
        "input": 0.10, "cached_input": 0.01, "output": 0.50,
        "long_context": {"above_input_tokens": 272_000, "input": 0.20, "cached_input": 0.02, "output": 0.75},
    },
    "gpt-5": {"input": 1.25, "cached_input": 0.125, "output": 10.00},
    "gpt-4.1": {"input": 2.00, "cached_input": 0.50, "output": 8.00},
    "gpt-4.1-mini": {"input": 0.40, "cached_input": 0.10, "output": 1.60},
    "gpt-4o": {"input": 2.50, "cached_input": 1.25, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "cached_input": 0.075, "output": 0.60},
    "o4-mini": {"input": 1.10, "cached_input": 0.275, "output": 4.40},
    "o3-mini": {"input": 1.10, "cached_input": 0.55, "output": 4.40},
}

_PRICE_KEYS = {"input", "cached_input", "output", "long_context"}
_TIER_KEYS = {"above_input_tokens", "input", "cached_input", "output"}
# A dated snapshot ("gpt-4.1-2025-04-14") is priced as its model.
_DATE_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")


def _usd(model: str, field: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{model}: {field} must be a non-negative number of USD per 1M tokens, got {value!r}")
    return float(value)


def _tier(model: str, raw: Mapping[str, Any], prefix: str = "") -> PriceTier:
    if "input" not in raw or "output" not in raw:
        raise ValueError(f"{model}: {prefix}input and {prefix}output are required")
    price_in = _usd(model, f"{prefix}input", raw["input"])
    # A model with no cache discount may leave cached_input out: cached tokens
    # then cost what any input token costs.
    cached = _usd(model, f"{prefix}cached_input", raw["cached_input"]) if "cached_input" in raw else price_in
    return PriceTier(input=price_in, cached_input=cached, output=_usd(model, f"{prefix}output", raw["output"]))


def _model_price(model: str, raw: Any) -> ModelPrice:
    """One model's entry, validated: unknown keys are rejected so a typo
    (``"ouput"``) fails at startup instead of silently pricing at zero."""
    if not isinstance(raw, Mapping):
        raise ValueError(f"{model}: expected an object of prices, got {type(raw).__name__}")
    unknown = set(raw) - _PRICE_KEYS
    if unknown:
        raise ValueError(f"{model}: unknown price fields {sorted(unknown)}")
    base = _tier(model, raw)
    long_raw = raw.get("long_context")
    if long_raw is None:
        return ModelPrice(base=base)
    if not isinstance(long_raw, Mapping):
        raise ValueError(f"{model}: long_context must be an object")
    unknown = set(long_raw) - _TIER_KEYS
    if unknown:
        raise ValueError(f"{model}: unknown long_context fields {sorted(unknown)}")
    above = long_raw.get("above_input_tokens")
    if isinstance(above, bool) or not isinstance(above, int) or above <= 0:
        raise ValueError(f"{model}: long_context.above_input_tokens must be a positive integer, got {above!r}")
    return ModelPrice(base=base, long_context_above=above, long_context=_tier(model, long_raw, "long_context."))


def parse_price_table(raw_json: str, defaults: Mapping[str, Any] = DEFAULT_PRICES) -> dict[str, ModelPrice]:
    """The defaults merged with an operator's JSON override; raises ``ValueError``.

    An override replaces a model's whole entry (prices are never mixed field by
    field across sources), adds a model the defaults do not know, or — with
    ``null`` — removes a default price, making that model unpriced.
    """
    merged: dict[str, Any] = dict(defaults)
    if raw_json and raw_json.strip():
        try:
            overrides = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"not valid JSON: {exc}") from exc
        if not isinstance(overrides, dict):
            raise ValueError("must be a JSON object of {model: prices}")
        for model, entry in overrides.items():
            if not isinstance(model, str) or not model.strip():
                raise ValueError("model names must be non-empty strings")
            if entry is None:
                merged.pop(model.strip(), None)
            else:
                merged[model.strip()] = entry
    return {model: _model_price(model, entry) for model, entry in merged.items()}


def _load_configured_prices() -> dict[str, ModelPrice]:
    try:
        return parse_price_table(settings.pricing.prices_json)
    except ValueError as exc:
        raise RuntimeError(f"MODEL_PRICES_JSON is invalid: {exc}") from exc


# Built once, at import (i.e. at startup): a bad override fails fast.
PRICES: dict[str, ModelPrice] = _load_configured_prices()


def lookup_price(model: str | None, prices: Mapping[str, ModelPrice] | None = None) -> ModelPrice | None:
    """A model's price: by its exact name, then without a ``provider:`` prefix
    (``openai:gpt-4.1``), then without a ``-YYYY-MM-DD`` snapshot suffix."""
    if not model:
        return None
    table = PRICES if prices is None else prices
    name = str(model).strip()
    candidates = [name]
    if ":" in name:
        name = name.split(":", 1)[1].strip()
        candidates.append(name)
    candidates.append(_DATE_SUFFIX.sub("", name))
    for candidate in candidates:
        if candidate in table:
            return table[candidate]
    return None


def call_cost_micros(
    model: str | None,
    input_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    *,
    prices: Mapping[str, ModelPrice] | None = None,
) -> int | None:
    """One model call's cost in micro-USD, or ``None`` when the model is unpriced.

    ``(input - cached) * input price + cached * cached price + output * output
    price``, with token counts x USD per 1M tokens = micro-USD. Reasoning tokens
    are already inside ``output_tokens`` (that is how providers bill and report
    them), so they are never added again. The long-context tier is chosen by
    this call's own input tokens. Pure: no I/O, the same inputs give the same
    cost.
    """
    price = lookup_price(model, prices)
    if price is None:
        return None
    input_tokens = max(int(input_tokens or 0), 0)
    output_tokens = max(int(output_tokens or 0), 0)
    cached_tokens = min(max(int(cached_tokens or 0), 0), input_tokens)
    tier = price.tier_for(input_tokens)
    cost = (
        (input_tokens - cached_tokens) * tier.input
        + cached_tokens * tier.cached_input
        + output_tokens * tier.output
    )
    return round(cost)
