"""Fixtures for the sandbox_runner unit tests.

The service is imported from ``magenticx/sandbox_runner`` with a throwaway
calls root and secret. Its top-level packages (``core``, ``schema``,
``utils``…) share names with the other services', so modules loaded from any
service are purged first — the same isolation the rag_service tests use.

``fake_docker`` replaces ``asyncio.create_subprocess_exec`` for the docker CLI
with a scripted fake, so the run/kill/cleanup loop is tested without a daemon.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ROOT / "magenticx"
SERVICE_ROOT = SERVICES / "sandbox_runner"
SECRET = "sandbox-test-secret"


def _purge_service_modules() -> None:
    roots = [(SERVICES / name).resolve() for name in ("dialogue_bridge", "rag_service", "agents", "sandbox_runner")]
    for name, module in list(sys.modules.items()):
        file_path = getattr(module, "__file__", None)
        if not file_path:
            continue
        try:
            resolved = Path(file_path).resolve()
        except OSError:
            continue
        if any(root in resolved.parents for root in roots):
            sys.modules.pop(name, None)


@pytest.fixture
def calls_root(tmp_path: Path) -> Path:
    return tmp_path / "calls"


@pytest.fixture
def svc(monkeypatch, tmp_path, calls_root):
    """Import the runner fresh against a temp calls root; returns a namespace of modules."""
    _purge_service_modules()
    monkeypatch.syspath_prepend(str(SERVICE_ROOT))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TRUSTED_PROXY_SECRET", SECRET)
    monkeypatch.setenv("SANDBOX_CALLS_ROOT", str(calls_root))
    monkeypatch.setenv("SANDBOX_DISK_POLL_SECONDS", "0.05")
    monkeypatch.setenv("SANDBOX_KILL_GRACE_SECONDS", "2")
    monkeypatch.setenv("SANDBOX_QUEUE_TIMEOUT_SECONDS", "0.2")

    modules = {
        name: importlib.import_module(name)
        for name in (
            "core.settings",
            "schema",
            "utils.workspace",
            "utils.output",
            "utils.docker_args",
            "utils.runner",
            "utils.health",
            "utils.exec_service",
            "main",
        )
    }
    yield type("Svc", (), {k.replace(".", "_"): v for k, v in modules.items()})
    _purge_service_modules()


# ---------------------------------------------------------------------------
# A scripted docker CLI
# ---------------------------------------------------------------------------
@dataclass
class BoxScript:
    """How the fake `docker run` behaves."""

    stdout: bytes = b""
    stderr: bytes = b""
    exit_code: int = 0
    hang: bool = False            # never exits until `docker kill`
    oom: bool = False
    never_started: bool = False   # inspect reports a box that did not start
    stream_forever: bytes | None = None  # emit this chunk until killed
    on_start: Any = None          # callable(args) run when the box starts


@dataclass
class FakeDocker:
    script: BoxScript = field(default_factory=BoxScript)
    calls: list[list[str]] = field(default_factory=list)
    killed: set[str] = field(default_factory=set)
    removed: list[str] = field(default_factory=list)
    removed_volumes: list[str] = field(default_factory=list)
    run_raises: BaseException | None = None
    info_runtimes: str = '{"runc":{},"runsc":{}}'
    health_stdout: bytes = b"GVISOR\n"
    _kill_events: dict[str, asyncio.Event] = field(default_factory=dict)

    def subcommands(self) -> list[str]:
        return [c[1] for c in self.calls]


class _FakeProc:
    def __init__(self) -> None:
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.returncode: int | None = None
        self._done = asyncio.Event()
        self.pid = 4242

    def finish(self, code: int) -> None:
        if self.returncode is None:
            self.returncode = code
            if not self.stdout.at_eof():
                self.stdout.feed_eof()
            if not self.stderr.at_eof():
                self.stderr.feed_eof()
            self._done.set()

    async def wait(self) -> int:
        await self._done.wait()
        assert self.returncode is not None
        return self.returncode

    async def communicate(self) -> tuple[bytes, bytes]:
        out = await self.stdout.read()
        err = await self.stderr.read()
        await self.wait()
        return out, err

    def kill(self) -> None:
        self.finish(-9)


def _name_of(args: list[str]) -> str | None:
    for a in args:
        if a.startswith("--name="):
            return a.split("=", 1)[1]
    return None


@pytest.fixture
def fake_docker(monkeypatch, svc) -> FakeDocker:
    fake = FakeDocker()
    states: dict[str, dict[str, Any]] = {}

    async def create_subprocess_exec(binary, *args, **kwargs):
        argv = list(args)
        fake.calls.append([binary, *argv])
        proc = _FakeProc()
        sub = argv[0]
        if sub == "run":
            if fake.run_raises is not None:
                raise fake.run_raises
            name = _name_of(argv) or "?"
            is_health = "python3" in argv and "-I" in argv
            if is_health:
                proc.stdout.feed_data(fake.health_stdout)
                states[name] = {"ExitCode": 0, "OOMKilled": False, "StartedAt": "2026-11-03T00:00:00Z", "Error": ""}
                proc.finish(0)
                return proc
            s = fake.script
            if s.on_start:
                s.on_start(argv)
            started = "0001-01-01T00:00:00Z" if s.never_started else "2026-11-03T00:00:00Z"
            event = asyncio.Event()
            fake._kill_events[name] = event

            async def life():
                if s.stdout:
                    proc.stdout.feed_data(s.stdout)
                if s.stderr:
                    proc.stderr.feed_data(s.stderr)
                if s.stream_forever is not None:
                    while not event.is_set():
                        proc.stdout.feed_data(s.stream_forever)
                        await asyncio.sleep(0)
                elif s.hang:
                    await event.wait()
                if event.is_set():
                    states[name] = {"ExitCode": 137, "OOMKilled": False, "StartedAt": started, "Error": ""}
                    proc.finish(137)
                    return
                code = 125 if s.never_started else s.exit_code
                states[name] = {"ExitCode": code, "OOMKilled": s.oom, "StartedAt": started,
                                "Error": "runsc failed" if s.never_started else ""}
                proc.finish(code)

            asyncio.get_running_loop().create_task(life())
            return proc
        if sub == "kill":
            name = argv[1]
            fake.killed.add(name)
            if name in fake._kill_events:
                fake._kill_events[name].set()
            proc.finish(0)
            return proc
        if sub == "rm":
            fake.removed.append(argv[-1])
            proc.finish(0)
            return proc
        if sub == "inspect":
            name = argv[-1]
            if name in states:
                proc.stdout.feed_data(json.dumps(states[name]).encode())
                proc.finish(0)
            else:
                proc.stderr.feed_data(b"No such object")
                proc.finish(1)
            return proc
        if sub == "info":
            proc.stdout.feed_data(fake.info_runtimes.encode())
            proc.finish(0)
            return proc
        if sub == "volume":
            fake.removed_volumes.extend(a for a in argv[2:] if not a.startswith("-"))
            proc.finish(0)
            return proc
        if sub == "ps":
            proc.finish(0)
            return proc
        proc.finish(1)
        return proc

    monkeypatch.setattr(svc.utils_runner.asyncio, "create_subprocess_exec", create_subprocess_exec)
    return fake
