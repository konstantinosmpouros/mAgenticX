"""Agent tool: render a chart inline in the assistant's reply.

The agent's way of showing data as a picture instead of an ASCII table or a
wall of numbers. Everything the chart displays — title, subtitle, category
axis, every series and every data point — comes from the tool call, so the
chart is a pure function of what the agent decided to show. Nothing is fetched,
inferred, or recomputed downstream.

Deliberately NOT a file. ``present_artifact`` promotes bytes out of the
workspace and the bridge persists them as an attachment; a chart has no bytes.
It is a *timeline block*: the ``RENDER_CHART`` event lands in the run's
``raw_events``, so the chart is rebuilt by the UI's timeline reducer at the log
position it fired and survives reload and reconnection for free — no table, no
blob, no migration.

Like ``present_artifact``, the tool itself does NOT emit the AG-UI event (deep
agents don't stream the custom channel — see ``runtime.agui.normalizer``). It
validates the spec and returns a confirmation the model can act on; the
``AGUIStreamNormalizer`` detects the ``render_chart`` call by name and
synthesizes the event from the tool-call ARGS.

Two data shapes live behind one tool. For every type except ``scatter`` the
``x_key`` field is a **category label** (a month, a region, a product) and each
series is a measure read across those categories. ``scatter`` alone reads
``x_key`` as a **number**, because a scatter plot asks how two numeric
variables relate rather than how one measure varies by category. The split is
handled in ``normalize_chart_payload`` so the UI receives one predictable shape.

Colors are deliberately absent from the schema. The palette is the viewer's
theme (``--chart-1``…``--chart-5``), assigned by series index in the UI, so a
chart reads correctly in light and dark mode and an agent cannot hardcode a hex
that fails contrast in one of them.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.logging import get_logger

logger = get_logger(__name__)

# Bounds. A chart is a summary, not a data dump: past a few dozen points a
# rendered chart is unreadable anyway, and the payload rides the SSE pipe and is
# replayed from raw_events on every reload — so the cap protects the transport,
# not just the picture.
_MAX_TITLE = 120
_MAX_SUBTITLE = 200
_MAX_SERIES = 6
_MAX_POINTS = 200
_MAX_LABEL = 60

ChartKind = Literal["bar", "line", "area", "pie", "radar", "radial", "scatter", "composed"]
SeriesKind = Literal["bar", "line", "area"]

# Types that show a single measure and would be meaningless with more: a pie
# and a radial both divide one whole, so a second series has nowhere to go.
_SINGLE_SERIES_TYPES = frozenset({"pie", "radial"})
# Types whose x axis is a number rather than a category label.
_NUMERIC_X_TYPES = frozenset({"scatter"})
# Where each modifier actually applies. Silently ignoring a modifier on a type
# that can't express it would leave the agent thinking it worked.
_STACKABLE_TYPES = frozenset({"bar", "area", "composed"})
_HORIZONTAL_TYPES = frozenset({"bar"})


class _ChartSeries(BaseModel):
    """One plotted measure, naming the row field it reads."""

    key: str = Field(
        description="The field name to read from each data row, e.g. 'revenue'."
    )
    label: str = Field(
        description="Human-friendly name shown in the legend and tooltip, "
        "e.g. 'Revenue (€M)'."
    )
    type: Optional[SeriesKind] = Field(
        default=None,
        description="Only for a 'composed' chart: how THIS series is drawn — "
        "'bar', 'line', or 'area'. Ignored by every other chart type, where the "
        "top-level 'type' decides. Defaults to 'bar'.",
    )
    axis: Literal["left", "right"] = Field(
        default="left",
        description="Only for a 'composed' chart: which y-axis this series is "
        "measured against. Put a series on 'right' when its unit or magnitude "
        "differs from the others (e.g. revenue in millions on the left, margin "
        "as a percentage on the right).",
    )


class _RenderChartArgs(BaseModel):
    type: ChartKind = Field(
        description="Chart type. 'bar' compares categories, 'line' shows change "
        "over an ordered axis, 'area' shows a total over one, 'pie' shows parts "
        "of a whole, 'radar' compares entities across several dimensions, "
        "'radial' shows a measure as concentric arcs, 'scatter' shows how two "
        "numbers relate, 'composed' mixes bars and lines on shared axes."
    )
    title: str = Field(description="Short title shown above the chart.")
    subtitle: str = Field(
        default="",
        description="Optional one-line caption under the title — the unit, "
        "period, or source, e.g. 'FY2025, in millions EUR'.",
    )
    x_key: str = Field(
        description="The field name in each data row holding the x value. For "
        "every type except 'scatter' this is a category or axis LABEL (e.g. "
        "'month', 'region'); for 'scatter' it must name a NUMERIC field, since "
        "a scatter plots two numbers against each other."
    )
    series: List[_ChartSeries] = Field(
        description="The measures to plot, in legend order. Each reads its own "
        f"field from every data row. At most {_MAX_SERIES}; 'pie' and 'radial' "
        "take exactly one."
    )
    data: List[Dict[str, Any]] = Field(
        description="The rows to plot. Every row is a flat object holding the "
        "x_key field plus one field per series key, e.g. "
        "[{'month': 'Jan', 'revenue': 12.4}, {'month': 'Feb', 'revenue': 15.1}]. "
        f"At most {_MAX_POINTS} rows."
    )
    stacked: bool = Field(
        default=False,
        description="Stack the series on top of each other instead of drawing "
        "them side by side. Use for composition ('revenue by region per "
        "quarter'), where the running total matters as much as the parts. "
        "Applies to 'bar', 'area', and 'composed'.",
    )
    horizontal: bool = Field(
        default=False,
        description="Draw a bar chart with the bars running left-to-right. Use "
        "when category names are long enough to be cramped on a vertical axis "
        "(country or product names). Applies to 'bar'.",
    )
    show_values: bool = Field(
        default=False,
        description="Print each value on the mark itself. Good for a small "
        "number of points where the exact figure matters; leave off for dense "
        "data, where the labels collide.",
    )


# Numeric string shapes, matched in order. A comma means different things in
# different locales, so each shape is recognised explicitly rather than by
# stripping separators — naive `.replace(",", "")` turns the European "12,4"
# into 124.0, a silently 10x-wrong data point that renders as a plausible bar.
_NUM_PLAIN = re.compile(r"^[+-]?\d+(?:\.\d+)?$")            # 12  |  12.4
_NUM_EN_GROUPED = re.compile(r"^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$")  # 1,234 | 1,234.56
_NUM_EU_GROUPED = re.compile(r"^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$")  # 1.234 | 1.234,56
_NUM_EU_DECIMAL = re.compile(r"^[+-]?\d+,\d+$")             # 12,4


def _coerce_number(value: Any) -> float | None:
    """Best-effort numeric coercion for one cell.

    Models routinely emit numbers as strings, sometimes with locale separators.
    Anything not confidently numeric becomes None, which the chart renders as a
    gap rather than a zero — a missing point and a zero point mean different
    things, and inventing a zero would be a lie the picture tells convincingly.

    One shape is genuinely ambiguous: a single comma before exactly three digits
    ("1,234") is 1234 to an English writer and 1.234 to a European one. Nothing
    in the payload disambiguates it, so it is read as English grouping — the
    convention the model was prompted in and the one JSON-ish output follows.
    """
    if isinstance(value, bool):  # bool is an int subclass — never a data point
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None

    text = value.strip().rstrip("%").strip()
    if not text:
        return None
    # Order matters: EN grouping is tested before the EU decimal so the
    # ambiguous "1,234" resolves to 1234 rather than 1.234.
    if _NUM_PLAIN.match(text):
        return float(text)
    if _NUM_EN_GROUPED.match(text):
        return float(text.replace(",", ""))
    if _NUM_EU_GROUPED.match(text):
        return float(text.replace(".", "").replace(",", "."))
    if _NUM_EU_DECIMAL.match(text):
        return float(text.replace(",", "."))
    return None


def _series_fields(entry: Any) -> Dict[str, str]:
    """Read one series' fields whether it arrived as a model or a plain dict.

    ``StructuredTool`` validates against ``args_schema`` and hands the function
    parsed ``_ChartSeries`` instances, but the same shape reaches us as raw
    dicts from the normalizer's tool-call args. Accept both rather than assuming
    one and failing with an AttributeError at the worst moment.
    """
    if isinstance(entry, _ChartSeries):
        return {
            "key": entry.key.strip(),
            "label": (entry.label or entry.key).strip(),
            "type": entry.type or "",
            "axis": entry.axis,
        }
    if isinstance(entry, dict):
        key = str(entry.get("key", "")).strip()
        raw_type = str(entry.get("type", "") or "").strip().lower()
        raw_axis = str(entry.get("axis", "") or "").strip().lower()
        return {
            "key": key,
            "label": str(entry.get("label", "") or key).strip(),
            "type": raw_type if raw_type in ("bar", "line", "area") else "",
            "axis": raw_axis if raw_axis in ("left", "right") else "left",
        }
    return {"key": "", "label": "", "type": "", "axis": "left"}


def build_render_chart_tool(*, agent_slug: str, conversation_id: str) -> StructuredTool:
    """Return a ``render_chart`` tool bound to this run, for logging context."""

    def _render_chart(
        type: str,
        title: str,
        x_key: str,
        series: List[Dict[str, Any]],
        data: List[Dict[str, Any]],
        subtitle: str = "",
        stacked: bool = False,
        horizontal: bool = False,
        show_values: bool = False,
    ) -> str:
        title = (title or "").strip()[:_MAX_TITLE]
        if not title:
            return "Could not render the chart: 'title' is required."

        x_key = (x_key or "").strip()
        if not x_key:
            return "Could not render the chart: 'x_key' is required."

        if not series:
            return "Could not render the chart: at least one entry in 'series' is required."
        if len(series) > _MAX_SERIES:
            return (
                f"Could not render the chart: {len(series)} series exceeds the "
                f"maximum of {_MAX_SERIES}. Plot fewer measures, or split them "
                "across separate charts."
            )
        if type in _SINGLE_SERIES_TYPES and len(series) != 1:
            return (
                f"Could not render the chart: a {type} chart divides one whole, "
                f"so it takes exactly one series (got {len(series)}). Use 'bar' "
                "to compare several measures."
            )

        if not data:
            return "Could not render the chart: 'data' has no rows."
        if len(data) > _MAX_POINTS:
            return (
                f"Could not render the chart: {len(data)} rows exceeds the "
                f"maximum of {_MAX_POINTS}. Aggregate the data first."
            )

        fields = [_series_fields(s) for s in series]
        if not all(f["key"] for f in fields):
            return "Could not render the chart: every series needs a non-empty 'key'."

        # Every series key must actually exist in the rows. Catching this here
        # turns a silently blank chart into a message the model can act on.
        missing = [f["key"] for f in fields if not any(f["key"] in row for row in data)]
        if missing:
            return (
                "Could not render the chart: no data row contains the series "
                f"key(s) {', '.join(repr(k) for k in missing)}. Every series key "
                "must match a field present in 'data'."
            )
        if not any(x_key in row for row in data):
            return (
                f"Could not render the chart: no data row contains the x_key "
                f"{x_key!r}. It must match the category field in 'data'."
            )
        # A scatter reads x as a number, so a category label there is not a
        # cosmetic mismatch — it is the wrong chart for the data.
        if type in _NUMERIC_X_TYPES and not any(
            _coerce_number(row.get(x_key)) is not None for row in data
        ):
            return (
                f"Could not render the chart: a scatter plot needs a numeric "
                f"x_key, but no data row has a number at {x_key!r}. Use 'line' "
                "or 'bar' if the x values are category labels."
            )

        # Modifiers are rejected rather than dropped: an agent that asked for a
        # stacked pie should learn that is not a thing, not receive a pie.
        if stacked and type not in _STACKABLE_TYPES:
            return (
                f"Could not render the chart: 'stacked' does not apply to a "
                f"{type} chart. It works on "
                f"{', '.join(sorted(_STACKABLE_TYPES))}."
            )
        if horizontal and type not in _HORIZONTAL_TYPES:
            return (
                f"Could not render the chart: 'horizontal' only applies to a "
                f"bar chart, not a {type} chart."
            )

        logger.info(
            "chart_rendered",
            "Agent rendered an inline chart",
            agent_slug=agent_slug,
            conversation_id=conversation_id,
            chart_type=type,
            series_count=len(series),
            point_count=len(data),
            stacked=stacked,
            horizontal=horizontal,
        )
        return (
            f"Rendered the {type} chart '{title}' in your reply. The user can "
            "see it — describe what it shows, but do not repeat every value as "
            "text."
        )

    return StructuredTool.from_function(
        func=_render_chart,
        name="render_chart",
        description=(
            "Show data to the user as a chart, inline in your reply. Use this "
            "whenever a comparison, trend, breakdown, or distribution would read "
            "better as a picture than as a table — instead of drawing ASCII bars "
            "or listing long columns of numbers.\n"
            "Pick the type that matches the question: 'bar' compares categories, "
            "'line' shows change over time, 'area' shows a total over time, "
            "'pie' shows parts of a whole, 'radar' compares entities across "
            "several dimensions, 'radial' shows a measure as concentric arcs, "
            "'scatter' shows how two numbers relate, and 'composed' mixes bars "
            "and lines on shared axes (put a differently-scaled series on the "
            "right axis).\n"
            "Modifiers: 'stacked' for composition on bar/area/composed, "
            "'horizontal' for bar charts with long category names, and "
            "'show_values' to print figures on the marks when there are few "
            "points.\n"
            "You supply everything: 'title', an optional 'subtitle' for the unit "
            "or period, the 'x_key' naming the x field, the 'series' to plot, "
            "and the 'data' rows. Colors follow the user's theme automatically — "
            "do not specify them. After rendering, summarize the insight in "
            "words; do not restate the raw numbers."
        ),
        args_schema=_RenderChartArgs,
    )


def normalize_chart_payload(args: Dict[str, Any]) -> Dict[str, Any] | None:
    """Turn raw ``render_chart`` tool-call args into a wire-ready payload.

    Shared by the normalizer so the event carries validated, bounded, and
    numerically-coerced data rather than whatever the model happened to emit —
    the UI then renders without defensive parsing of its own. Returns None when
    the args cannot produce a renderable chart, which the caller treats the same
    as any malformed tool call: no event, no card.

    Modifiers are normalized against the type here too: unlike the tool function
    (which reports the mismatch so the model can fix it) this path silently
    clears an inapplicable flag, because by the time an event is being emitted
    there is no one left to tell.
    """
    title = str(args.get("title", "")).strip()[:_MAX_TITLE]
    x_key = str(args.get("x_key", "")).strip()
    raw_series = args.get("series")
    raw_data = args.get("data")
    if not title or not x_key or not isinstance(raw_series, list) or not isinstance(raw_data, list):
        return None

    chart_type = str(args.get("type", "")).strip().lower()
    if chart_type not in (
        "bar", "line", "area", "pie", "radar", "radial", "scatter", "composed"
    ):
        chart_type = "bar"

    series: List[Dict[str, str]] = []
    for entry in raw_series[:_MAX_SERIES]:
        fields = _series_fields(entry)
        if not fields["key"]:
            continue
        item: Dict[str, str] = {
            "key": fields["key"],
            "label": (fields["label"] or fields["key"])[:_MAX_LABEL],
        }
        # Per-series type/axis only mean something on a composed chart; carrying
        # them elsewhere would invite the UI to honour a field the agent never
        # meaningfully set.
        if chart_type == "composed":
            item["type"] = fields["type"] or "bar"
            item["axis"] = fields["axis"]
        series.append(item)
    if not series:
        return None
    if chart_type in _SINGLE_SERIES_TYPES:
        series = series[:1]

    numeric_x = chart_type in _NUMERIC_X_TYPES

    # Project each row down to exactly the fields the chart plots. This is the
    # security-relevant step: whatever else the model put in a row (stray keys,
    # nested objects, a pasted secret) never reaches the wire or the DB.
    points: List[Dict[str, Any]] = []
    for row in raw_data[:_MAX_POINTS]:
        if not isinstance(row, dict):
            continue
        point: Dict[str, Any] = {}
        if numeric_x:
            x_value = _coerce_number(row.get(x_key))
            if x_value is None:
                continue  # a scatter point with no x is not a point
            point[x_key] = x_value
        else:
            label = row.get(x_key)
            point[x_key] = str(label).strip()[:_MAX_LABEL] if label is not None else ""
        for s in series:
            point[s["key"]] = _coerce_number(row.get(s["key"]))
        # A row with no usable measure at all is noise, not a gap.
        if all(point[s["key"]] is None for s in series):
            continue
        points.append(point)
    if not points:
        return None

    subtitle = str(args.get("subtitle", "") or "").strip()[:_MAX_SUBTITLE]
    return {
        "type": chart_type,
        "title": title,
        "subtitle": subtitle or None,
        "x_key": x_key,
        "series": series,
        "data": points,
        "stacked": bool(args.get("stacked")) and chart_type in _STACKABLE_TYPES,
        "horizontal": bool(args.get("horizontal")) and chart_type in _HORIZONTAL_TYPES,
        "show_values": bool(args.get("show_values")),
    }


__all__ = ["build_render_chart_tool", "normalize_chart_payload"]
