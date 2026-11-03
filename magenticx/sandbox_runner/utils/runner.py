"""Run one command in one box and report what happened (plan 11 §3.2, phase 2).

The call shape is: ``docker run`` the box over the call's own ``in/`` / ``out/``
→ drain both streams into capped buffers while three watchdogs run (wall
clock, total output, size of ``out/``) → inspect the stopped box → classify →
remove it. Collecting the output files and deleting the call dir is the
caller's job (``utils/exec_service.py``).
Whatever happens — a kill, an exception, the request being cancelled — the
``finally`` block force-removes the container by its unique name, so no box
outlives its call.

Kill reasons follow the contract: ``timeout`` (wall clock), ``output_limit``
(total stream bytes), ``disk_limit`` (``out/`` exceeds the per-call
budget), ``memory`` (the daemon reports the box OOM-killed, or it died of a
SIGKILL the runner did not send), ``error`` (the box ran but its state could
not be read back). A box that could not be *started* raises
``DaemonUnavailable`` — the router answers 503, since that means the inner
daemon or runsc is broken, not that the command failed.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from core.logging import get_logger
from core.settings import SandboxSettings
from schema import ExecResponse, KilledReason
from utils.docker_args import CONTAINER_LABEL, build_exec_args, new_container_name, volume_names
from utils.output import CappedBuffer, sanitize_output
from utils.workspace import Workspace, out_bytes

logger = get_logger("sandbox_runner.runner")

_READ_CHUNK = 64 * 1024
_SIGKILL_EXIT = 137
# Docker's zero time: the box was created but never started.
_NEVER_STARTED = "0001-01-01T00:00:00Z"


class DaemonUnavailable(Exception):
    """The inner daemon (or runsc) cannot run boxes — the router answers 503."""


@dataclass
class ExecOutcome:
    """The response (without files yet) plus the size of ``out/`` after the run."""

    response: ExecResponse
    bytes_written: int


def docker_env(cfg: SandboxSettings) -> dict[str, str]:
    """A minimal environment for the docker CLI — the runner's own env (and its
    secret) never reaches the CLI, let alone a box."""
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "DOCKER_HOST": cfg.docker_host,
        "HOME": "/tmp",
    }


async def docker_cli(cfg: SandboxSettings, *args: str, timeout: float = 30.0) -> tuple[int, bytes, bytes]:
    """Run a short docker CLI command (kill, rm, inspect, info) and return its result."""
    proc = await asyncio.create_subprocess_exec(
        cfg.docker_bin,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        env=docker_env(cfg),
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, b"", b"timeout"
    return (proc.returncode if proc.returncode is not None else -1), out, err


async def remove_container(cfg: SandboxSettings, name: str) -> None:
    """Kill and remove the box, then its two named mount volumes.

    Never raises: cleanup must not turn a result into a 500. "No such
    container" (the box was never created) is a normal answer.
    """
    try:
        code, _, err = await docker_cli(cfg, "rm", "--force", "--volumes", name, timeout=cfg.kill_grace_seconds + 20)
        if code != 0 and b"No such container" not in err:
            logger.error("sandbox_cleanup_failed", "Could not remove a sandbox container", container=name, exit=code)
        if name.startswith("sbx-"):
            # Unmounts the bind; never touches the source dir. -f: absent is fine.
            await docker_cli(cfg, "volume", "rm", "--force", *volume_names(name), timeout=20)
    except Exception:  # noqa: BLE001 — logged; the sweep at boot is the backstop
        logger.exception("sandbox_cleanup_failed", "Could not remove a sandbox container", container=name)


async def sweep_leftovers(cfg: SandboxSettings) -> int:
    """Remove every box a previous runner process left behind (crash mid-call)."""
    code, out, _ = await docker_cli(cfg, "ps", "--all", "--quiet", f"--filter=label={CONTAINER_LABEL}")
    if code != 0:
        return 0
    ids = [line for line in out.decode(errors="replace").split() if line]
    for cid in ids:
        await remove_container(cfg, cid)
    code, out, _ = await docker_cli(cfg, "volume", "ls", "--quiet", f"--filter=label={CONTAINER_LABEL}")
    if code == 0:
        vols = [line for line in out.decode(errors="replace").split() if line]
        if vols:
            await docker_cli(cfg, "volume", "rm", "--force", *vols)
    return len(ids)


async def inspect_state(cfg: SandboxSettings, name: str) -> dict[str, Any] | None:
    """The stopped box's ``State`` (ExitCode, OOMKilled, StartedAt, Error), or None."""
    code, out, _ = await docker_cli(cfg, "inspect", "--format={{json .State}}", name)
    if code != 0:
        return None
    try:
        state = json.loads(out.decode(errors="replace"))
    except ValueError:
        return None
    return state if isinstance(state, dict) else None


async def _drain(stream: asyncio.StreamReader | None, buf: CappedBuffer, on_chunk: Callable[[], None]) -> None:
    if stream is None:
        return
    while True:
        chunk = await stream.read(_READ_CHUNK)
        if not chunk:
            return
        buf.feed(chunk)
        on_chunk()


def classify(
    *, killed: KilledReason | None, returncode: int | None, state: dict[str, Any] | None, bytes_written: int, budget: int
) -> tuple[int | None, KilledReason | None]:
    """Map the raw facts of a finished box to the contract's ``(exit_code, killed_reason)``.

    Pure, so every branch is unit-tested without a daemon.
    """
    if state is None:
        # The box ran (or we would have raised) but its record is gone.
        return None, killed or "error"
    exit_code = state.get("ExitCode") if isinstance(state.get("ExitCode"), int) else returncode
    if killed is None and bytes_written > budget:
        # Finished between two polls but over budget: never reported as success.
        killed = "disk_limit"
    if killed in ("timeout", "output_limit"):
        return None, killed  # the runner ended it; there is no command exit code
    if killed == "disk_limit":
        return (None if exit_code == _SIGKILL_EXIT else exit_code), killed
    if state.get("OOMKilled") is True or exit_code == _SIGKILL_EXIT:
        # A SIGKILL the runner did not send: the memory cgroup's OOM killer.
        return exit_code, "memory"
    return exit_code, killed


def _start_failed(state: dict[str, Any] | None) -> bool:
    if state is None:
        return True
    return bool(state.get("Error")) or state.get("StartedAt") in (None, "", _NEVER_STARTED)


async def run_command(
    cfg: SandboxSettings, *, workspace: Workspace, workdir: str, command: str, timeout_seconds: int
) -> ExecOutcome:
    """Run ``command`` in a fresh box and return the contract response."""
    name = new_container_name()
    started = time.monotonic()

    stdout_buf = CappedBuffer(cfg.max_output_bytes)
    stderr_buf = CappedBuffer(cfg.max_output_bytes)
    killed: KilledReason | None = None
    kill_event = asyncio.Event()

    def kill(reason: KilledReason) -> None:
        nonlocal killed
        if killed is None:
            killed = reason
            kill_event.set()

    def on_chunk() -> None:
        if stdout_buf.seen + stderr_buf.seen > cfg.output_kill_bytes:
            kill("output_limit")

    async def watch_disk() -> None:
        while True:
            await asyncio.sleep(cfg.disk_poll_seconds)
            size = await asyncio.to_thread(out_bytes, workspace.output_dir)
            if size > cfg.disk_budget_bytes:
                kill("disk_limit")
                return

    proc: asyncio.subprocess.Process | None = None
    tasks: list[asyncio.Future] = []
    returncode: int | None = None
    state: dict[str, Any] | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            cfg.docker_bin,
            *build_exec_args(cfg, name=name, workspace=workspace, workdir=workdir, command=command),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            env=docker_env(cfg),
        )
        drains = asyncio.ensure_future(
            asyncio.gather(_drain(proc.stdout, stdout_buf, on_chunk), _drain(proc.stderr, stderr_buf, on_chunk))
        )
        waiter = asyncio.ensure_future(proc.wait())
        killer = asyncio.ensure_future(kill_event.wait())
        disk = asyncio.ensure_future(watch_disk())
        tasks = [drains, waiter, killer, disk]

        done, _ = await asyncio.wait({waiter, killer}, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            kill("timeout")
        if killed is not None and not waiter.done():
            # SIGKILL the box through the daemon; the attached CLI then returns.
            await docker_cli(cfg, "kill", name, timeout=cfg.kill_grace_seconds)
            try:
                await asyncio.wait_for(asyncio.shield(waiter), timeout=cfg.kill_grace_seconds)
            except asyncio.TimeoutError:
                proc.kill()
        returncode = await waiter
        try:
            await asyncio.wait_for(asyncio.shield(drains), timeout=cfg.kill_grace_seconds)
        except asyncio.TimeoutError:
            pass  # cancelled in finally; what was read is kept
        state = await inspect_state(cfg, name)
    finally:
        for task in tasks:
            task.cancel()
        if proc is not None and proc.returncode is None:
            proc.kill()
        await remove_container(cfg, name)

    if _start_failed(state) and killed is None:
        # The daemon could not create or start the box. Its message names
        # internal paths, so it goes to the log (truncated), not to the model.
        logger.error(
            "sandbox_start_failed",
            "The sandbox could not be started",
            container=name,
            docker_exit=returncode,
            docker_error=sanitize_output(stderr_buf.data()[:512]),
            state_error=sanitize_output(str((state or {}).get("Error", ""))[:512].encode()),
        )
        raise DaemonUnavailable("sandbox could not be started")

    bytes_written = await asyncio.to_thread(out_bytes, workspace.output_dir)
    exit_code, reason = classify(
        killed=killed, returncode=returncode, state=state, bytes_written=bytes_written, budget=cfg.disk_budget_bytes
    )
    response = ExecResponse(
        exit_code=exit_code,
        stdout=sanitize_output(stdout_buf.data()),
        stderr=sanitize_output(stderr_buf.data()),
        truncated=stdout_buf.truncated or stderr_buf.truncated,
        duration_ms=int((time.monotonic() - started) * 1000),
        killed_reason=reason,
    )
    return ExecOutcome(response=response, bytes_written=bytes_written)
