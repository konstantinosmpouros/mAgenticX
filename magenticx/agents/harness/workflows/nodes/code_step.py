"""``code`` — run a Python script in the sandbox runner; read inputs, return JSON.

The script never runs in this service. It is one ``POST /v1/exec`` to the
sandbox runner (the ``../sandbox`` project) — the same runner, the same mTLS
context and trusted-proxy header as the agents' ``execute``
(``harness/filesystem/sandbox_backend.py``): a fresh gVisor box, image
``python:3.12-slim``, ``--network=none``, its own wall-clock and memory limits.

What the box sees:

* ``/conversation/input/main.py`` — the script, exactly as written. ``code`` is a
  :attr:`~WorkflowNode.literal_fields` key: never template-rendered (``{{`` is
  legitimate Python) and never checked as a reference.
* ``/conversation/input/input.json`` — ``inputs``, template-rendered like any
  config (≤ 64 KiB), plus ``"steps"``: the data from earlier steps chosen by
  ``context`` (``context.py``; ``[]`` with mode ``none``, ≤ 64 KiB). ``steps``
  is therefore reserved as an ``inputs`` key while a context is on. Both input
  files are read-only.
* The working directory ``/conversation/output/``: a ``result.json`` written
  there comes back as the step's ``result``.

``result`` is the parsed ``output/result.json`` when the script wrote one (it
must then be valid JSON), else stdout parsed as JSON when it is, else ``null``.
Output: ``{"result", "stdout", "stderr", "exitCode", "durationMs"}`` with the
streams control-character-stripped and capped.

Failures (never retried — a script may have side effects in its own box, and
a retry would hide a flaky one): a non-zero exit (``code_failed``, with the
tail of stderr), a runner kill (``code_killed``), and an unreachable,
refusing or unconfigured runner (``code_unavailable``). The kind is only
available when ``settings.filesystem.sandbox_execution_active``; the validator
refuses a spec using it otherwise, and the step fails closed at run time too.

Nothing about the script or its streams is logged: only a hash and length of
the script, the outcome code and the duration.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_verify
from core.settings import settings
from harness.workflows import nodes as node_catalog
from harness.workflows.context import StepContext, context_issues, context_reads, gather_context
from harness.workflows.errors import NodeExecutionError
from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)

logger = get_logger(__name__)

EXEC_PATH = "/v1/exec"
MAX_CODE_CHARS = 16000
MAX_INPUT_KEYS = 32
MAX_INPUT_BYTES = 64 * 1024
MAX_TIMEOUT_SECONDS = 120
#: Ceiling on each stream kept in the output (it is checkpointed and streamed).
MAX_STREAM_CHARS = 64 * 1024
#: Ceiling on the result read back from ``result.json`` or stdout.
MAX_RESULT_BYTES = 1024 * 1024
#: How much of stderr a failure message quotes.
STDERR_TAIL_CHARS = 500
#: Slack between the script's timeout and the HTTP read timeout, so the
#: runner's kill (and its answer) always lands before the client gives up.
READ_TIMEOUT_MARGIN_SECONDS = 15.0
#: The runner's identity rules (``sandbox/runner/schema/exec.py``). Checked here
#: so a malformed id is refused without a round trip.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
#: The runner's ``agent_slug`` is an audit label; every workflow step uses this one.
AGENT_SLUG = "workflow"
COMMAND = "python3 /conversation/input/main.py"
RESULT_PATH = "output/result.json"
UNAVAILABLE_REASON = "The sandbox runner is not configured, so code steps can't run."
#: The ``input.json`` key that carries the context entries.
STEPS_KEY = "steps"
# C0/C1 controls except tab and newline (carriage returns are folded first).
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")

_KILLED_WORDS: dict[str, str] = {
    "timeout": "it ran past its time limit",
    "memory": "it ran out of memory",
    "output_limit": "it printed more output than allowed",
    "disk_limit": "it wrote more to /conversation/output than allowed",
    "error": "the sandbox failed while running it",
}


class CodeConfig(NodeConfig):
    """The script, its inputs and its time limit."""

    code: str = Field(
        min_length=1,
        max_length=MAX_CODE_CHARS,
        description="Python 3.12 script. Read /conversation/input/input.json; write result.json "
        "(or print JSON). Not templated.",
        json_schema_extra={"x-widget": "code"},
    )
    inputs: dict[str, Any] = Field(
        default_factory=dict,
        max_length=MAX_INPUT_KEYS,
        description="Values passed to the script as input.json; templates allowed.",
    )
    context: StepContext = Field(
        default_factory=StepContext,
        description='Data from earlier steps, passed to the script as "steps" in input.json.',
        json_schema_extra={"x-widget": "context"},
    )
    timeout_seconds: int = Field(default=30, ge=1, le=MAX_TIMEOUT_SECONDS)


class _ReturnedFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    path: str
    content_b64: str


class _ExecResult(BaseModel):
    """The runner's 200 body (``ExecResponse``). Anything else is a failed call."""

    model_config = ConfigDict(extra="ignore")

    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = Field(0, ge=0)
    killed_reason: Literal["timeout", "memory", "output_limit", "disk_limit", "error"] | None = None
    files: list[_ReturnedFile] = Field(default_factory=list)


def make_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    """The HTTP client of one exec call. Module-level so tests can mount a transport.

    ``verify`` carries the internal CA and this service's client certificate in
    production (mTLS), ``True`` locally — the same as ``execute``.
    """
    return httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify())


def _clean(text: str) -> str:
    """Display-safe text: CRLF folded, control characters dropped, capped."""
    return _CONTROL_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))[:MAX_STREAM_CHARS]


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _parse_json_text(text: str) -> tuple[bool, Any]:
    """``(True, value)`` when ``text`` is one JSON document, else ``(False, None)``."""
    stripped = text.strip()
    if not stripped or len(stripped.encode("utf-8")) > MAX_RESULT_BYTES:
        return False, None
    try:
        return True, json.loads(stripped)
    except ValueError:
        return False, None


def _result_file(result: _ExecResult) -> tuple[bool, Any]:
    """``(True, parsed output/result.json)``, or ``(False, None)`` when the script wrote none.

    Written but unreadable is a failure, not ``null``: the script meant to
    return something and did not manage to.
    """
    returned = next((f for f in result.files if f.path == RESULT_PATH), None)
    if returned is None:
        return False, None
    # Base64 is 4/3 of the data: refuse an oversized one before decoding it.
    if len(returned.content_b64) > (MAX_RESULT_BYTES * 4) // 3 + 4:
        raise NodeExecutionError("result.json is larger than 1 MiB.", code="code_failed")
    try:
        raw = base64.b64decode(returned.content_b64, validate=True)
        return True, json.loads(raw.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise NodeExecutionError("result.json is not valid JSON.", code="code_failed") from exc


class CodeNode(WorkflowNode):
    """One Python script in a fresh sandbox box."""

    kind = "code"
    label = "Code"
    group = "developer"
    description = "Run a Python script in the sandbox (no network); read inputs, return JSON."
    Config = CodeConfig
    #: ``context`` is a setting, never templated.
    literal_fields = frozenset({"code", "context"})

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        issues = context_issues(self.config.context, self.spec, self.id)
        if self.config.context.mode != "none" and STEPS_KEY in self.config.inputs:
            issues.append((f"inputs.{STEPS_KEY}", "'steps' is reserved for the data from earlier steps."))
        return issues

    def extra_reads(self) -> list[str]:
        return context_reads(self.config.context)

    @classmethod
    def availability(cls) -> tuple[bool, str | None]:
        if settings.filesystem.sandbox_execution_active:
            return True, None
        return False, UNAVAILABLE_REASON

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: CodeConfig = ctx.config
        fs = settings.filesystem
        # Re-checked here: the validator ran at run start, but a half-configured
        # deployment must never reach the network.
        if not fs.sandbox_execution_active:
            raise NodeExecutionError(UNAVAILABLE_REASON, code="code_unavailable")
        user_id, run_id = ctx.run.owner_user_id, ctx.run.run_id
        if not _ID_RE.match(user_id) or not _ID_RE.match(run_id):
            raise NodeExecutionError("This run's identity cannot be sent to the sandbox.", code="code_unavailable")
        rendered_json = json.dumps(cfg.inputs, ensure_ascii=False, default=str).encode("utf-8")
        if len(rendered_json) > MAX_INPUT_BYTES:
            raise NodeExecutionError(
                f"The inputs are larger than {MAX_INPUT_BYTES // 1024} KiB.", code="code_input_too_large"
            )
        # Capped on its own (64 KiB) by gather_context; always present, [] when none.
        entries = gather_context(cfg.context, state, self.spec, self.id, kinds=node_catalog.NODE_KINDS)
        inputs_json = json.dumps(
            {**cfg.inputs, STEPS_KEY: entries}, ensure_ascii=False, default=str
        ).encode("utf-8")
        payload = {
            "user_id": user_id,
            "agent_slug": AGENT_SLUG,
            "conversation_id": run_id,
            "command": COMMAND,
            "timeout_seconds": cfg.timeout_seconds,
            "workdir": "output",
            "files": [
                {"path": "input/main.py", "content_b64": _b64(cfg.code.encode("utf-8"))},
                {"path": "input/input.json", "content_b64": _b64(inputs_json)},
            ],
        }
        timeout = httpx.Timeout(
            cfg.timeout_seconds + READ_TIMEOUT_MARGIN_SECONDS, connect=fs.sandbox_runner_connect_timeout_seconds
        )
        url = f"{fs.sandbox_runner_url.rstrip('/')}{EXEC_PATH}"
        outcome = "ok"
        duration_ms = 0
        try:
            result = await self._exec(url, payload, timeout, user_id)
            duration_ms = result.duration_ms
            output = self._output(result)
            return NodeResult(output=output)
        except NodeExecutionError as exc:
            outcome = exc.code
            raise
        finally:
            logger.info(
                "workflow_code_run",
                "Workflow code step finished",
                code_sha256=hashlib.sha256(cfg.code.encode("utf-8")).hexdigest(),
                code_length=len(cfg.code),
                outcome=outcome,
                duration_ms=duration_ms,
            )

    @staticmethod
    async def _exec(url: str, payload: dict[str, Any], timeout: httpx.Timeout, user_id: str) -> _ExecResult:
        """One call to the runner. Every way it can fail is a ``NodeExecutionError``."""
        try:
            async with make_client(timeout) as client:
                response = await client.post(url, json=payload, headers=internal_service_headers(user_id=user_id))
        except httpx.TimeoutException as exc:
            raise NodeExecutionError(
                "The sandbox did not answer in time; the script's outcome is unknown.", code="code_unavailable"
            ) from exc
        except httpx.HTTPError as exc:
            raise NodeExecutionError(
                f"The sandbox is unreachable ({type(exc).__name__}); the script did not run.", code="code_unavailable"
            ) from exc
        status = response.status_code
        if status != 200:
            if status >= 500:
                raise NodeExecutionError(
                    f"The sandbox is unavailable (HTTP {status}); the script did not run.", code="code_unavailable"
                )
            raise NodeExecutionError(
                f"The sandbox refused the request (HTTP {status}); the script did not run.", code="code_failed"
            )
        try:
            return _ExecResult.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            raise NodeExecutionError("The sandbox answered with an unreadable result.", code="code_failed") from exc

    @staticmethod
    def _output(result: _ExecResult) -> dict[str, Any]:
        """The step's output, or the failure the result describes."""
        stdout, stderr = _clean(result.stdout), _clean(result.stderr)
        if result.killed_reason is not None:
            words = _KILLED_WORDS[result.killed_reason]
            raise NodeExecutionError(f"The sandbox stopped the script: {words}.", code="code_killed")
        if result.exit_code is None:
            raise NodeExecutionError("The sandbox stopped the script without an exit code.", code="code_killed")
        if result.exit_code != 0:
            tail = stderr.strip()[-STDERR_TAIL_CHARS:]
            message = f"The script exited with code {result.exit_code}."
            raise NodeExecutionError(f"{message}\n{tail}" if tail else message, code="code_failed")
        found, value = _result_file(result)
        if not found:
            _, value = _parse_json_text(result.stdout)
        return {
            "result": value,
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": result.exit_code,
            "durationMs": result.duration_ms,
        }


__all__ = ["CodeConfig", "CodeNode", "make_client"]
