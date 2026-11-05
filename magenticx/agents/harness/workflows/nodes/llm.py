"""``llm`` — send one prompt to a model; get text back, or JSON matching a schema.

The model is one of the same curated allowlist a user-authored agent may pick
(``settings.registry.allowed_agent_models``): an unbounded choice would be a
cost surface and a typo would only fail at run time. The catalogue injects the
allowlist as the ``model`` property's ``enum`` (and its default — the one the
agent builder preselects), the validator refuses a model outside it, and the
run re-checks it, because the allowlist is the authority, not the stored spec.

Two output modes:

* ``text`` — the reply is streamed token by token as AG-UI
  ``TEXT_MESSAGE_START`` / ``CONTENT`` / ``END`` inside the node's bracket (the
  run view joins them into the execution's text). Output:
  ``{"text": <full reply>, "model": <model id>}``.
* ``json`` — the model is held to ``json_schema`` (an object schema) through the
  provider's structured-output API, and the reply is validated against that
  schema here as well, since the provider is asked non-strictly (strict mode
  refuses most hand-written schemas). Output: ``{"data": <object>, "model": …}``.

Bounded by ``max_output_tokens`` and a ``timeout_seconds`` (≤ 120 s) around the
whole call. No temperature is sent: newer reasoning models reject it.

Content is off in the logs: the prompt, the system text and the reply are never
logged — only the model, the mode, the outcome code and the duration.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Mapping
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from jsonschema.exceptions import ValidationError as JsonSchemaValidationError
from langchain.chat_models import init_chat_model
from langchain_core.exceptions import OutputParserException
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import Field, ValidationInfo, field_validator

from core.logging import get_logger
from core.settings import settings
from harness.abstractions.user_agents import agent_model_options
from harness.workflows.errors import NodeExecutionError
from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)

logger = get_logger(__name__)

MAX_SYSTEM_CHARS = 8000
MAX_PROMPT_CHARS = 20000
MAX_OUTPUT_TOKENS = 16000
MAX_TIMEOUT_SECONDS = 120.0
MAX_SCHEMA_BYTES = 16 * 1024
#: The name the structured-output API gives the schema. Fixed, because a
#: user-written ``title`` need not be a valid provider function name.
SCHEMA_NAME = "workflow_output"


def default_model() -> str:
    """The model the builder preselects (as for a new agent), or ``""`` when no
    model is allowed at all — which the validator then reports."""
    return next((option["id"] for option in agent_model_options() if option["default"]), "")


class LlmConfig(NodeConfig):
    """One model call."""

    model: str = Field(
        default_factory=default_model,
        min_length=1,
        max_length=128,
        description="Model id, one of the allowed models.",
    )
    system: str = Field(
        default="",
        max_length=MAX_SYSTEM_CHARS,
        description="System instructions; templates allowed.",
    )
    prompt: str = Field(
        min_length=1,
        max_length=MAX_PROMPT_CHARS,
        description="The message sent to the model; templates allowed.",
    )
    output: Literal["text", "json"] = Field(
        default="text",
        description="text: the reply as text. json: an object matching json_schema.",
    )
    # Declared after ``output`` and validated even when left at its default,
    # so the "required for json" rule runs here and lands on this field (the
    # builder marks the field, not the whole node).
    json_schema: dict[str, Any] | None = Field(
        default=None,
        validate_default=True,
        description='JSON Schema of the reply when output is json; its "type" must be "object".',
        json_schema_extra={"x-widget": "json"},
    )
    max_output_tokens: int = Field(default=2000, ge=1, le=MAX_OUTPUT_TOKENS)
    timeout_seconds: float = Field(default=60.0, gt=0, le=MAX_TIMEOUT_SECONDS)

    @field_validator("json_schema", mode="after")
    @classmethod
    def _schema_fits_output(cls, value: dict[str, Any] | None, info: ValidationInfo) -> dict[str, Any] | None:
        if value is None:
            if info.data.get("output") == "json":
                raise ValueError("A JSON schema is required when the output is json.")
            return None
        if len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")) > MAX_SCHEMA_BYTES:
            raise ValueError(f"The JSON schema is larger than {MAX_SCHEMA_BYTES // 1024} KiB.")
        if value.get("type") != "object":
            raise ValueError('The JSON schema must describe an object ("type": "object").')
        try:
            Draft202012Validator.check_schema(value)
        except SchemaError as exc:
            raise ValueError(f"The JSON schema is invalid: {exc.message}") from exc
        return value


def make_chat_model(model: str, max_output_tokens: int) -> BaseChatModel:
    """The chat model of one ``llm`` execution. Module-level so tests can fake it.

    ``max_tokens`` is the provider-neutral name (``langchain-openai`` sends it as
    ``max_completion_tokens``, which reasoning models require). No temperature.
    """
    return init_chat_model(model, max_tokens=max_output_tokens)


def _messages(cfg: LlmConfig) -> list[SystemMessage | HumanMessage]:
    messages: list[SystemMessage | HumanMessage] = []
    if cfg.system.strip():
        messages.append(SystemMessage(content=cfg.system))
    messages.append(HumanMessage(content=cfg.prompt))
    return messages


class LlmNode(WorkflowNode):
    """One model call, streamed as text or held to a JSON schema."""

    kind = "llm"
    label = "LLM"
    group = "ai"
    description = "Send a prompt to a model; get text back, or JSON that matches your schema."
    Config = LlmConfig
    #: The schema is data, not a template: its descriptions may contain braces.
    literal_fields = frozenset({"json_schema"})

    @classmethod
    def availability(cls) -> tuple[bool, str | None]:
        if not settings.registry.allowed_agent_models:
            return False, "No models are allowed on this deployment, so LLM steps can't run."
        return True, None

    @classmethod
    def config_schema(cls) -> dict[str, Any]:
        """The form schema with the live model allowlist as ``model``'s choices."""
        schema = super().config_schema()
        options = agent_model_options()
        model = schema["properties"]["model"]
        if options:  # an empty enum is not valid JSON Schema; the kind is unavailable then
            model["enum"] = [option["id"] for option in options]
        default = next((option["id"] for option in options if option["default"]), None)
        if default is not None:
            model["default"] = default
        return schema

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        model = self.config.model
        if model not in settings.registry.allowed_agent_models:
            return [("model", f"Model '{model}' is not one of the allowed models.")]
        return []

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: LlmConfig = ctx.config
        if cfg.model not in settings.registry.allowed_agent_models:
            raise NodeExecutionError(f"Model '{cfg.model}' is not one of the allowed models.", code="llm_failed")
        started = time.monotonic()
        outcome = "ok"
        try:
            async with asyncio.timeout(cfg.timeout_seconds):
                if cfg.output == "json":
                    output = await self._call_json(cfg)
                else:
                    output = await self._call_text(cfg, ctx)
            return NodeResult(output=output)
        except TimeoutError as exc:
            outcome = "llm_timeout"
            raise NodeExecutionError(
                f"The model did not answer within {cfg.timeout_seconds:g} s.", code="llm_timeout"
            ) from exc
        except NodeExecutionError as exc:
            outcome = exc.code
            raise
        except OutputParserException as exc:
            outcome = "llm_schema"
            raise NodeExecutionError("The model's reply is not valid JSON.", code="llm_schema") from exc
        except Exception as exc:
            # Providers raise their own error types (auth, rate limit, bad
            # request…); the run gets one safe reason, never the provider text,
            # which can echo the prompt.
            outcome = "llm_failed"
            raise NodeExecutionError(f"The model call failed ({type(exc).__name__}).", code="llm_failed") from exc
        finally:
            logger.info(
                "workflow_llm_call",
                "Workflow LLM call finished",
                model=cfg.model,
                output_mode=cfg.output,
                outcome=outcome,
                duration_ms=int((time.monotonic() - started) * 1000),
            )

    async def _call_text(self, cfg: LlmConfig, ctx: NodeContext) -> dict[str, Any]:
        """Stream the reply as AG-UI text frames; return the joined text."""
        model = make_chat_model(cfg.model, cfg.max_output_tokens)
        message_id = f"{ctx.run.run_id}:{ctx.execution_id}"
        parts: list[str] = []
        ctx.emitter.response_start(message_id, ctx.writer)
        try:
            async for chunk in model.astream(_messages(cfg)):
                delta = chunk.text
                if delta:  # AG-UI refuses an empty content delta
                    parts.append(delta)
                    ctx.emitter.response_content(message_id, delta, ctx.writer)
        finally:
            # Closed on failure too, so the run view never shows a dangling message.
            ctx.emitter.response_end(message_id, ctx.writer)
        return {"text": "".join(parts), "model": cfg.model}

    async def _call_json(self, cfg: LlmConfig) -> dict[str, Any]:
        """One structured call; the reply must be an object matching the schema."""
        schema = cfg.json_schema or {}
        model = make_chat_model(cfg.model, cfg.max_output_tokens)
        structured = model.with_structured_output({**schema, "title": SCHEMA_NAME}, method="json_schema")
        data = await structured.ainvoke(_messages(cfg))
        if not isinstance(data, dict):
            raise NodeExecutionError("The model's reply is not a JSON object.", code="llm_schema")
        try:
            Draft202012Validator(schema).validate(data)
        except JsonSchemaValidationError as exc:
            where = "/".join(str(part) for part in exc.absolute_path) or "(root)"
            raise NodeExecutionError(
                f"The model's reply does not match the schema at '{where}'.", code="llm_schema"
            ) from exc
        return {"data": data, "model": cfg.model}


__all__ = ["LlmConfig", "LlmNode", "default_model", "make_chat_model"]
