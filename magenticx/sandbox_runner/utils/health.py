"""Prove the runner can actually sandbox: a real runsc box must report gVisor.

"Healthy but silently running under runc" is the worst possible failure
(plan 11 §5), so health is never inferred from the API being up or the daemon
answering: the check starts a box with the exact exec flags and
``--runtime=runsc`` and requires it to print the gVisor marker, which only a
gVisor kernel produces. The verdict is cached briefly and computed under a
lock, so a probe storm cannot become a box storm.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from core.logging import get_logger
from core.settings import SandboxSettings, settings
from utils.docker_args import build_health_args, new_container_name
from utils.runner import docker_cli, remove_container

logger = get_logger("sandbox_runner.health")


@dataclass(frozen=True)
class HealthVerdict:
    """Outcome of one self-check."""

    ok: bool
    reason: str


async def run_self_check(cfg: SandboxSettings) -> HealthVerdict:
    """Run one runsc box and check its kernel; never raises."""
    name = new_container_name()
    try:
        code, out, _ = await docker_cli(cfg, "info", "--format={{json .Runtimes}}", timeout=10)
        if code != 0:
            return HealthVerdict(False, "daemon_unreachable")
        if f'"{cfg.runtime}"' not in out.decode(errors="replace"):
            return HealthVerdict(False, "runtime_not_registered")
        code, out, _ = await docker_cli(cfg, *build_health_args(cfg, name=name), timeout=cfg.health_timeout_seconds)
        if code != 0:
            return HealthVerdict(False, "box_failed")
        if out.decode(errors="replace").strip() != "GVISOR":
            return HealthVerdict(False, "not_gvisor")
        return HealthVerdict(True, "ok")
    except Exception:  # noqa: BLE001 — a check that crashes is unhealthy, never healthy
        logger.exception("sandbox_health_error", "The sandbox self-check crashed")
        return HealthVerdict(False, "check_crashed")
    finally:
        await remove_container(cfg, name)


class HealthMonitor:
    """Caches the last verdict for ``health_cache_seconds``; one check at a time."""

    def __init__(self, cfg: SandboxSettings) -> None:
        self._cfg = cfg
        self._lock = asyncio.Lock()
        self._verdict: HealthVerdict | None = None
        self._at = 0.0

    async def verdict(self) -> HealthVerdict:
        async with self._lock:
            cached = self._verdict
            if cached is not None and (time.monotonic() - self._at) < self._cfg.health_cache_seconds:
                return cached
            verdict = await run_self_check(self._cfg)
            self._verdict, self._at = verdict, time.monotonic()
            if not verdict.ok:
                logger.error("sandbox_unhealthy", "Sandbox self-check failed", reason=verdict.reason)
            elif cached is None or not cached.ok:
                logger.info("sandbox_healthy", "Sandbox self-check passed: runsc box reported gVisor")
            return verdict

    def invalidate(self) -> None:
        """Force the next ``verdict()`` to re-check (e.g. after a start failure)."""
        self._verdict = None


# The process-wide monitor used by /health and invalidated by exec on a start failure.
health_monitor = HealthMonitor(settings.sandbox)
