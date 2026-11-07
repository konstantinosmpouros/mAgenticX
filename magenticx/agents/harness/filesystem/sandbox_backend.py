"""The workspace default backend that can run commands — in the sandbox runner.

deepagents exposes its built-in ``execute`` tool exactly when the composite
**default** backend implements ``SandboxBackendProtocol``
(``deepagents.middleware.filesystem.supports_execution``). This class is that
backend, and the only one in the service: ``build_workspace_backend`` mints it
when ``settings.filesystem.sandbox_execution_active`` (the flag AND a runner
URL), and the plain ``BranchScratchBackend`` otherwise.

What it does, and what it deliberately does not:

* **File operations are the workspace default's.** It *is* a
  :class:`~harness.filesystem.scratch_backend.BranchScratchBackend` — the
  branch scratch store every deep agent's default route uses (plan 41 §3.7) —
  so ``ls``/``read_file``/``write_file`` on paths outside the mounted routes
  read and write the same shared rows whether execution is on or off, and the
  orchestrator and its async tasks see one another's files. Only
  ``execute`` / ``aexecute`` / ``id`` are new. The scratch files do not travel
  into the box: the runner's contract takes ``input/`` and ``output/`` only,
  so a command works on ``/conversation/`` (below), exactly as before.
* **``execute`` never runs anything here.** It is one ``POST /v1/exec`` to the
  runner over mTLS with the trusted-proxy header — the same two controls as
  every internal hop. The agents container still has no Docker socket and no
  capabilities.
* **The files travel with the call.** A conversation's files are rows
  (plan 36), not a directory, so there is nothing to mount. Before the call the
  conversation's ``/conversation/input/`` (the uploads) and
  ``/conversation/output/`` are read through the run's own ``/conversation/``
  mount and sent as ``input/<rel>`` / ``output/<rel>``; after it, every
  ``output/<rel>`` the runner returns (new or changed) is written back through
  that same mount — the path a binary ``upload_files`` takes — so it persists
  in ``conversation_files`` and ``present_artifact`` can find it. Caps
  (:data:`MAX_TRANSFER_FILES`, :data:`MAX_TRANSFER_BYTES`) hold both ways; what
  they leave out is named in the tool result.
* **Identity comes from the run.** The backend is bound at build time to this
  run's ``(user_id, agent_slug, conversation_id)``, the way
  ``build_remember_tool`` closes over identity, and those are the only
  addressing the request carries — never a host path.
* **Fail closed, never fall back.** An unreachable runner, a 5xx, a timeout or
  an unreadable answer comes back to the model as an error result, nothing is
  written, and the run continues; nothing is ever retried against another
  backend. A fallback would turn a runner outage into a lockdown bypass.

Whatever the runner returns is attacker-influenced (the command may have been
written by a prompt injection): text is decoded defensively, stripped of
control characters and length-capped before it reaches the model's context,
and a returned file is accepted only as a normalised path under
``/conversation/output/``.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import re
from typing import Any, Literal

import httpx
from deepagents.backends.protocol import ExecuteResponse, SandboxBackendProtocol
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from harness.conversation_files import ConversationFiles, ConversationFilesBackend, InputsUnavailable
from harness.conversation_files import paths as conv_paths
from harness.filesystem.layout import safe_segment
from harness.filesystem.scratch_backend import BranchScratchBackend
from harness.filesystem.scratch_store import BranchScratchStore

logger = get_logger(__name__)

EXEC_PATH = "/v1/exec"
#: The runner's own bound on a command (contract: 1..16000 chars). Checked here
#: too, so an oversized command is refused without a round trip.
MAX_COMMAND_CHARS = 16000
#: Ceiling on the streams one result may put into the model's context,
#: whatever the runner sends. The runner truncates first; this is the second line.
MAX_RESULT_CHARS = 100_000
#: The contract's transfer caps, each way: files per call and decoded bytes.
MAX_TRANSFER_FILES = 100
MAX_TRANSFER_BYTES = 20 * 1024 * 1024
#: Slack between a command's own timeout and the HTTP read timeout, so the
#: runner's kill (and its answer) always lands before the client gives up.
_READ_TIMEOUT_MARGIN_SECONDS = 15.0
#: How many skipped/refused file names a note lists before "and N more".
_NOTE_NAMES = 10

_CONVERSATION_PREFIX = f"{conv_paths.CONVERSATION_ROOT}/"

# Ids become path segments on the runner. It validates them strictly; refusing
# anything odd here as well keeps a malformed id from ever leaving the service.
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
# C0/C1 controls except tab and newline (carriage returns are folded below).
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")

KilledReason = Literal["timeout", "memory", "output_limit", "disk_limit", "error"]

_KILLED_WORDS: dict[str, str] = {
    "timeout": "it ran past its time limit and was stopped",
    "memory": "it ran out of memory and was stopped",
    "output_limit": "it printed more output than allowed and was stopped",
    "disk_limit": "it wrote more to /conversation/output than allowed, so its result is not trusted",
    "error": "the sandbox failed while running it",
}


class _ReturnedFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    path: str
    content_b64: str
    size: int = Field(0, ge=0)


class _ExecResult(BaseModel):
    """The runner's 200 body. Anything else is treated as a failed call."""

    model_config = ConfigDict(extra="ignore")

    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False
    duration_ms: int = Field(0, ge=0)
    killed_reason: KilledReason | None = None
    files: list[_ReturnedFile] = Field(default_factory=list)
    files_truncated: bool = False


def _clean(text: str) -> str:
    """Model-safe text: CRLF folded, control characters dropped."""
    return _CONTROL_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))


def _checked_id(kind: str, value: str) -> str:
    """Validate one identity part; raises so a bad id fails the build closed."""
    try:
        safe_segment(value)
    except ValueError as exc:
        raise ValueError(f"Invalid sandbox {kind}.") from exc
    if not _ID_RE.match(value):
        raise ValueError(f"Invalid sandbox {kind}.")
    return value


def _error(message: str) -> ExecuteResponse:
    """A failed call, worded for the model. No exit code: nothing ran (or we
    cannot say that it did), which deepagents renders without a status line."""
    return ExecuteResponse(output=f"Error: {message}", exit_code=None, truncated=False)


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def _names(items: list[str]) -> str:
    shown = ", ".join(items[:_NOTE_NAMES])
    extra = len(items) - _NOTE_NAMES
    return f"{shown} and {extra} more" if extra > 0 else shown


def format_result(result: _ExecResult, notes: list[str] | None = None) -> ExecuteResponse:
    """The runner's answer as one block of text for the model.

    deepagents appends ``[Command succeeded/failed with exit code N]`` and the
    truncation note itself, so the body carries the streams, — when the
    sandbox stopped the command — why, in plain words, and then the notes about
    files (what was written back, what the caps left out). Only the streams are
    capped; the notes are short and are what the agent acts on next.
    """
    stdout = _clean(result.stdout)
    stderr = _clean(result.stderr)
    parts: list[str] = []
    if stdout:
        parts.append(stdout.rstrip("\n"))
    if stderr:
        parts.append(f"[stderr]\n{stderr.rstrip(chr(10))}")
    if not parts:
        parts.append("(no output)")
    output = "\n".join(parts)
    truncated = result.truncated
    if len(output) > MAX_RESULT_CHARS:
        output, truncated = output[:MAX_RESULT_CHARS], True
    tail: list[str] = []
    if result.killed_reason is not None:
        tail.append(f"[The sandbox stopped this command: {_KILLED_WORDS[result.killed_reason]}.]")
    elif result.exit_code is None:
        tail.append("[The command did not report an exit code.]")
    tail.extend(f"[{note}]" for note in notes or [])
    if tail:
        output = "\n".join([output, *tail])
    return ExecuteResponse(output=output, exit_code=result.exit_code, truncated=truncated)


class RemoteSandboxBackend(BranchScratchBackend, SandboxBackendProtocol):
    """Branch-scratch file operations + ``execute`` in the sandbox runner.

    Bound to one run's identity; one instance is minted per agent build by
    the workspace factory, which is cheap — nothing here opens a connection or
    reads a file until ``execute`` is called.

    ``files`` + ``conversation_mount`` are the run's conversation files and its
    ``/conversation/`` mount: given together, the conversation's input/ and
    output/ travel with each call and returned outputs are written back. The
    workspace always passes both; leaving them out sends no files (and is what
    the sync path does when there is no service loop to bridge onto).

    ``scratch_store`` / ``branch_thread_id`` / ``loop`` are the default
    route's, passed through to :class:`BranchScratchBackend` — the workspace
    hands both backends the same store, so either sees the other's writes.

    ``transport`` / ``async_transport`` exist for tests (an ``httpx``
    ``MockTransport``); production passes neither and gets the internal TLS
    context.
    """

    def __init__(
        self,
        *,
        user_id: str,
        agent_slug: str,
        conversation_id: str,
        files: ConversationFiles | None = None,
        conversation_mount: ConversationFilesBackend | None = None,
        scratch_store: BranchScratchStore | None = None,
        branch_thread_id: str | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        runner_url: str | None = None,
        transport: httpx.BaseTransport | None = None,
        async_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # Identity first: a bad id fails the build before anything is bound.
        checked_user = _checked_id("user id", user_id)
        checked_agent = _checked_id("agent slug", agent_slug)
        checked_conversation = _checked_id("conversation id", conversation_id)
        super().__init__(
            store=scratch_store if scratch_store is not None else BranchScratchStore(),
            user_id=checked_user,
            conversation_id=checked_conversation,
            agent_slug=checked_agent,
            branch_thread_id=branch_thread_id,
            loop=loop,
        )
        self._user_id = checked_user
        self._agent_slug = checked_agent
        self._conversation_id = checked_conversation
        if (files is None) != (conversation_mount is None):
            raise ValueError("RemoteSandboxBackend needs both the conversation files and their mount, or neither.")
        if files is not None and (
            files.user_id, files.agent_slug, files.conversation_id
        ) != (user_id, agent_slug, conversation_id):
            # The files must be this run's: a mismatch would ship one
            # conversation's uploads into another's sandbox.
            raise ValueError("RemoteSandboxBackend files belong to a different run.")
        self._files = files
        self._mount = conversation_mount
        base = (runner_url if runner_url is not None else settings.filesystem.sandbox_runner_url).strip()
        if not base:
            # Built only when execution is active, so this is a wiring bug —
            # refuse rather than mint an execute path that points nowhere.
            raise RuntimeError("RemoteSandboxBackend needs SANDBOX_RUNNER_URL.")
        self._exec_url = f"{base.rstrip('/')}{EXEC_PATH}"
        self._transport = transport
        self._async_transport = async_transport

    # -- SandboxBackendProtocol ---------------------------------------------
    @property
    def id(self) -> str:
        """Stable per (user, agent, conversation), and not reversible to them —
        deepagents may surface it, and raw ids do not belong in a prompt."""
        digest = hashlib.sha256(
            f"{self._user_id}\x00{self._agent_slug}\x00{self._conversation_id}".encode()
        ).hexdigest()[:16]
        return f"magenticx-sandbox-{digest}"

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if self._mount is not None:
            # The files are async rows on the service loop; run the whole call
            # there, exactly as the mount's own sync methods do.
            return self._mount._sync(self.aexecute(command, timeout=timeout))
        prepared = self._prepare(command, timeout)
        if isinstance(prepared, ExecuteResponse):
            return prepared
        payload, http_timeout = prepared
        try:
            with httpx.Client(
                timeout=http_timeout,
                verify=get_httpx_verify(),
                cert=get_httpx_client_cert(),
                transport=self._transport,
            ) as client:
                response = client.post(self._exec_url, json=payload, headers=self._headers())
        except httpx.HTTPError as exc:
            return self._transport_error(exc, payload)
        parsed = self._parse(response, payload)
        return parsed if isinstance(parsed, ExecuteResponse) else format_result(parsed)

    async def aexecute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:  # noqa: ASYNC109
        prepared = self._prepare(command, timeout)
        if isinstance(prepared, ExecuteResponse):
            return prepared
        payload, http_timeout = prepared
        notes: list[str] = []
        if self._files is not None:
            payload["files"], notes = await self._collect_files()
        try:
            async with httpx.AsyncClient(
                timeout=http_timeout,
                verify=get_httpx_verify(),
                cert=get_httpx_client_cert(),
                transport=self._async_transport,
            ) as client:
                response = await client.post(self._exec_url, json=payload, headers=self._headers())
        except httpx.HTTPError as exc:
            return self._transport_error(exc, payload)
        parsed = self._parse(response, payload)
        if isinstance(parsed, ExecuteResponse):
            return parsed  # a failed call writes nothing back
        if self._files is not None:
            notes.extend(await self._store_outputs(parsed))
        return format_result(parsed, notes)

    # -- the files, both ways ----------------------------------------------------
    async def _collect_files(self) -> tuple[list[dict[str, str]], list[str]]:
        """The conversation's input/ and output/ as the request's ``files``,
        within the caps, plus notes on whatever was left out."""
        assert self._files is not None and self._mount is not None
        notes: list[str] = []
        entries = []
        try:
            entries.extend(await self._files.entries(conv_paths.INPUT_DIR))
        except InputsUnavailable:
            notes.append(
                "The user's uploads could not be fetched right now, so /conversation/input is empty "
                "in the sandbox."
            )
        entries.extend(await self._files.entries(conv_paths.OUTPUT_DIR))

        chosen, over_cap = [], []
        total = 0
        for entry in entries:
            if len(chosen) >= MAX_TRANSFER_FILES or total + entry.size > MAX_TRANSFER_BYTES:
                over_cap.append(entry.path[len(_CONVERSATION_PREFIX):])
                continue
            chosen.append(entry)
            total += entry.size

        downloads = await self._mount.adownload_files(
            [conv_paths.relative(conv_paths.CONVERSATION_ROOT, entry.path) for entry in chosen]
        )
        sent: list[dict[str, str]] = []
        unreadable: list[str] = []
        for entry, download in zip(chosen, downloads):
            rel = entry.path[len(_CONVERSATION_PREFIX):]
            if download.error is not None or download.content is None:
                unreadable.append(rel)
                continue
            sent.append({"path": rel, "content_b64": base64.b64encode(download.content).decode("ascii")})
        if over_cap:
            notes.append(
                f"Not copied into the sandbox (over the {MAX_TRANSFER_FILES}-file / "
                f"{MAX_TRANSFER_BYTES // (1024 * 1024)} MB limit): {_names(over_cap)}."
            )
        if unreadable:
            notes.append(f"Could not read, so not copied into the sandbox: {_names(unreadable)}.")
        return sent, notes

    async def _store_outputs(self, result: _ExecResult) -> list[str]:
        """Write the runner's returned output/ files back to
        ``/conversation/output/`` through the run's mount. Returns the notes."""
        assert self._mount is not None
        notes: list[str] = []
        if result.killed_reason == "disk_limit":
            if result.files:
                notes.append("Its output files were not saved, because it went over the disk limit.")
            return notes

        accepted: list[tuple[str, bytes]] = []
        refused: list[str] = []
        over_cap: list[str] = []
        total = 0
        for returned in result.files:
            target = self._output_target(returned.path)
            data = self._decode(returned.content_b64) if target is not None else None
            if target is None or data is None:
                refused.append(_clean(returned.path)[:200] or "(unnamed)")
                continue
            if len(accepted) >= MAX_TRANSFER_FILES or total + len(data) > MAX_TRANSFER_BYTES:
                over_cap.append(target[len(_CONVERSATION_PREFIX):])
                continue
            accepted.append((target, data))
            total += len(data)

        responses = await self._mount.aupload_files(
            [(conv_paths.relative(conv_paths.CONVERSATION_ROOT, target), data) for target, data in accepted]
        )
        written: list[str] = []
        failed: list[str] = []
        for (target, data), response in zip(accepted, responses):
            if response.error is None:
                written.append(f"{target} ({_human_size(len(data))})")
            else:
                failed.append(f"{target} ({response.error})")
        if written:
            notes.append(f"Wrote {_names(written)}.")
        if failed:
            notes.append(f"Could not save: {_names(failed)}.")
        if refused:
            self._log_files_refused(len(refused))
            notes.append(f"Ignored returned files outside output/ or not readable: {_names(refused)}.")
        if over_cap or result.files_truncated:
            notes.append(
                "Not every changed output file came back (over the "
                f"{MAX_TRANSFER_FILES}-file / {MAX_TRANSFER_BYTES // (1024 * 1024)} MB limit)"
                + (f": {_names(over_cap)}." if over_cap else ".")
            )
        return notes

    @staticmethod
    def _output_target(path: str) -> str | None:
        """``output/<rel>`` as its normalised ``/conversation/output/<rel>``,
        or ``None`` for anything else — including a traversal attempt."""
        if not isinstance(path, str) or not path.startswith("output/"):
            return None
        try:
            target = conv_paths.normalise(f"{_CONVERSATION_PREFIX}{path}")
        except conv_paths.InvalidPath:
            return None
        return target if target.startswith(conv_paths.OUTPUT_PREFIX) else None

    @staticmethod
    def _decode(content_b64: str) -> bytes | None:
        try:
            return base64.b64decode(content_b64, validate=True)
        except (binascii.Error, ValueError):
            return None

    # -- internals -------------------------------------------------------------
    def _headers(self) -> dict[str, str]:
        return internal_service_headers(user_id=self._user_id)

    def _prepare(
        self, command: str, timeout: int | None
    ) -> tuple[dict[str, Any], httpx.Timeout] | ExecuteResponse:
        """The request body and its HTTP timeout, or an error result when the
        call is refused before it leaves the service."""
        if not isinstance(command, str) or not command.strip():
            return _error("the command is empty.")
        if len(command) > MAX_COMMAND_CHARS:
            return _error(f"the command is longer than {MAX_COMMAND_CHARS} characters.")
        # deepagents documents 0 as "no timeout"; the sandbox always has one,
        # so 0 (or nothing) means the runner's default.
        command_timeout = timeout if isinstance(timeout, int) and timeout > 0 else None
        read_timeout = settings.filesystem.sandbox_runner_timeout_seconds
        if command_timeout is not None:
            read_timeout = max(read_timeout, command_timeout + _READ_TIMEOUT_MARGIN_SECONDS)
        payload: dict[str, Any] = {
            "user_id": self._user_id,
            "agent_slug": self._agent_slug,
            "conversation_id": self._conversation_id,
            "command": command,
            "timeout_seconds": command_timeout,
            "workdir": "output",
        }
        return payload, httpx.Timeout(
            read_timeout, connect=settings.filesystem.sandbox_runner_connect_timeout_seconds
        )

    def _log(self, event: str, message: str, payload: dict[str, Any], **fields: Any) -> None:
        # Never the command itself: a length and a hash correlate with the
        # runner's audit record without putting the text in our logs.
        logger.warning(
            event,
            message,
            agent_slug=self._agent_slug,
            conversation_id=self._conversation_id,
            command_sha256=hashlib.sha256(payload["command"].encode()).hexdigest(),
            command_length=len(payload["command"]),
            **fields,
        )

    def _log_files_refused(self, count: int) -> None:
        # A returned path outside output/ is the runner misbehaving or being
        # abused — a security-relevant event, logged without the names.
        logger.warning(
            "sandbox_exec_files_refused",
            "Refused files the sandbox runner returned outside output/",
            agent_slug=self._agent_slug,
            conversation_id=self._conversation_id,
            refused_count=count,
        )

    def _transport_error(self, exc: httpx.HTTPError, payload: dict[str, Any]) -> ExecuteResponse:
        self._log(
            "sandbox_exec_unreachable",
            "The sandbox runner could not be reached; execute returned an error",
            payload,
            failure_reason=type(exc).__name__,
        )
        if isinstance(exc, httpx.TimeoutException):
            return _error(
                "the sandbox did not answer in time, so it is unknown whether the command "
                "finished. Nothing ran outside the sandbox and no files were changed. "
                "Try a shorter command."
            )
        return _error(
            "the sandbox is unreachable right now, so the command did not run. Nothing ran "
            "outside the sandbox. Tell the user code execution is unavailable at the moment."
        )

    def _parse(self, response: httpx.Response, payload: dict[str, Any]) -> _ExecResult | ExecuteResponse:
        """The runner's result, or the error result for the model."""
        status = response.status_code
        if status != 200:
            self._log(
                "sandbox_exec_refused",
                "The sandbox runner refused or failed an exec call",
                payload,
                status_code=status,
            )
            if status == 503:
                return _error(
                    "the sandbox is unavailable right now (its isolation runtime is not "
                    "healthy), so the command did not run."
                )
            if status in (400, 413, 422):
                return _error(
                    "the sandbox rejected the request as invalid — for example a timeout above "
                    "its limit or too many files. Retry without a timeout or with a shorter one."
                )
            if 400 <= status < 500:
                return _error(f"the sandbox refused the request (HTTP {status}); the command did not run.")
            return _error(f"the sandbox failed (HTTP {status}); the command did not run.")
        try:
            return _ExecResult.model_validate(response.json())
        except (ValueError, ValidationError):
            self._log(
                "sandbox_exec_unreadable",
                "The sandbox runner answered with an unreadable body",
                payload,
            )
            return _error("the sandbox answered with something unreadable; treat the command as failed.")


__all__ = [
    "EXEC_PATH",
    "MAX_COMMAND_CHARS",
    "MAX_TRANSFER_BYTES",
    "MAX_TRANSFER_FILES",
    "RemoteSandboxBackend",
    "format_result",
]
