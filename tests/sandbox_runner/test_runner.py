"""The run/kill/cleanup loop against a scripted docker CLI (no daemon)."""
from __future__ import annotations

import asyncio

import pytest

from tests.sandbox_runner.conftest import BoxScript


@pytest.fixture
def ws(svc, tmp_path):
    return svc.utils_workspace.prepare_workspace(tmp_path / "calls", [])


@pytest.fixture
def cfg(svc):
    return svc.core_settings.settings.sandbox


async def _run(svc, cfg, ws, command="echo hi", timeout=5):
    return await svc.utils_runner.run_command(cfg, workspace=ws, workdir="output", command=command, timeout_seconds=timeout)


async def test_success_returns_output_and_removes_the_box(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(stdout=b"hi\n", exit_code=0)
    out = await _run(svc, cfg, ws)
    r = out.response
    assert (r.exit_code, r.stdout, r.stderr, r.truncated, r.killed_reason) == (0, "hi\n", "", False, None)
    run_name = next(a.split("=", 1)[1] for a in fake_docker.calls[0] if a.startswith("--name="))
    assert run_name in fake_docker.removed
    assert {f"{run_name}-in", f"{run_name}-out"} <= set(fake_docker.removed_volumes)
    assert "kill" not in fake_docker.subcommands()


async def test_nonzero_exit_is_a_result_not_an_error(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(stderr=b"boom\n", exit_code=3)
    r = (await _run(svc, cfg, ws)).response
    assert r.exit_code == 3 and r.stderr == "boom\n" and r.killed_reason is None


async def test_timeout_kills_and_removes(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(hang=True)
    r = (await _run(svc, cfg, ws, command="sleep 999", timeout=1)).response
    assert r.killed_reason == "timeout"
    assert r.exit_code is None
    assert 900 <= r.duration_ms < 5000
    assert fake_docker.killed and fake_docker.killed <= set(fake_docker.removed)


async def test_oom_is_reported_as_memory(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(exit_code=137, oom=True)
    r = (await _run(svc, cfg, ws)).response
    assert r.killed_reason == "memory" and r.exit_code == 137


async def test_endless_output_is_killed_with_output_limit(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(stream_forever=b"y\n" * 32768)
    r = (await _run(svc, cfg, ws, command="yes", timeout=30)).response
    assert r.killed_reason == "output_limit"
    assert r.truncated is True
    assert len(r.stdout.encode()) == cfg.max_output_bytes
    assert fake_docker.killed


async def test_large_output_is_truncated_without_a_kill(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(stdout=b"x" * (1024 * 1024), exit_code=0)
    r = (await _run(svc, cfg, ws)).response
    assert r.truncated is True and r.killed_reason is None and r.exit_code == 0
    assert len(r.stdout) == cfg.max_output_bytes


async def test_disk_budget_is_enforced_while_running(svc, cfg, ws, fake_docker):
    small = cfg.model_copy(update={"disk_budget_bytes": 1024 * 1024})

    def fill(_argv):
        (ws.output_dir / "big.bin").write_bytes(b"\0" * (2 * 1024 * 1024))

    fake_docker.script = BoxScript(hang=True, on_start=fill)
    out = await _run(svc, small, ws, timeout=10)
    assert out.response.killed_reason == "disk_limit"
    assert out.bytes_written == 2 * 1024 * 1024
    assert fake_docker.killed


async def test_disk_budget_checked_after_a_fast_exit(svc, cfg, ws, fake_docker):
    small = cfg.model_copy(update={"disk_budget_bytes": 1024 * 1024, "disk_poll_seconds": 30})
    fake_docker.script = BoxScript(exit_code=0, on_start=lambda _a: (ws.output_dir / "b").write_bytes(b"1" * (1536 * 1024)))
    r = (await _run(svc, small, ws)).response
    assert r.killed_reason == "disk_limit" and r.exit_code == 0


async def test_box_that_never_started_raises_daemon_unavailable(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(never_started=True)
    with pytest.raises(svc.utils_runner.DaemonUnavailable):
        await _run(svc, cfg, ws)
    assert fake_docker.removed  # cleaned up anyway


async def test_command_exiting_125_is_not_mistaken_for_a_daemon_error(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(exit_code=125)
    r = (await _run(svc, cfg, ws, command="exit 125")).response
    assert r.exit_code == 125 and r.killed_reason is None


async def test_cleanup_runs_when_spawning_fails(svc, cfg, ws, fake_docker):
    fake_docker.run_raises = OSError("docker binary missing")
    with pytest.raises(OSError):
        await _run(svc, cfg, ws)
    assert len(fake_docker.removed) == 1 and fake_docker.removed[0].startswith("sbx-")


async def test_cleanup_runs_when_the_call_is_cancelled(svc, cfg, ws, fake_docker):
    fake_docker.script = BoxScript(hang=True)
    task = asyncio.ensure_future(_run(svc, cfg, ws, timeout=30))
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_docker.removed and fake_docker.removed[0].startswith("sbx-")


async def test_docker_cli_gets_a_minimal_environment(svc, cfg, ws, fake_docker, monkeypatch):
    env = svc.utils_runner.docker_env(cfg)
    assert set(env) == {"PATH", "DOCKER_HOST", "HOME"}
    assert "sandbox-test-secret" not in " ".join(env.values())


@pytest.mark.parametrize(
    "kw,expected",
    [
        (dict(killed=None, returncode=0, state={"ExitCode": 0, "OOMKilled": False}, bytes_written=0), (0, None)),
        (dict(killed="timeout", returncode=137, state={"ExitCode": 137}, bytes_written=0), (None, "timeout")),
        (dict(killed="output_limit", returncode=137, state={"ExitCode": 137}, bytes_written=0), (None, "output_limit")),
        (dict(killed=None, returncode=137, state={"ExitCode": 137, "OOMKilled": True}, bytes_written=0), (137, "memory")),
        (dict(killed=None, returncode=137, state={"ExitCode": 137, "OOMKilled": False}, bytes_written=0), (137, "memory")),
        (dict(killed=None, returncode=0, state={"ExitCode": 0}, bytes_written=999), (0, "disk_limit")),
        (dict(killed="disk_limit", returncode=137, state={"ExitCode": 137}, bytes_written=999), (None, "disk_limit")),
        (dict(killed="timeout", returncode=137, state=None, bytes_written=0), (None, "timeout")),
        (dict(killed=None, returncode=0, state=None, bytes_written=0), (None, "error")),
        (dict(killed=None, returncode=2, state={"ExitCode": 2}, bytes_written=0), (2, None)),
    ],
)
def test_classify(svc, kw, expected):
    assert svc.utils_runner.classify(budget=100, **kw) == expected
