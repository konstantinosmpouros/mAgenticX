"""HTTP surface: auth, status mapping, health, audit records."""
from __future__ import annotations

import base64
import logging
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from tests.sandbox_runner.conftest import SECRET, BoxScript

BODY = {
    "user_id": "3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    "agent_slug": "data-analyst",
    "conversation_id": "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
    "command": "echo hi",
}
AUTH = {"X-Internal-Proxy-Secret": SECRET}
CSV = b"a,b\n1,2\n"


@pytest.fixture
async def client(svc):
    transport = ASGITransport(app=svc.main.app)
    async with AsyncClient(transport=transport, base_url="http://runner") as c:
        yield c


async def test_missing_secret_is_403(client, fake_docker):
    r = await client.post("/v1/exec", json=BODY)
    assert r.status_code == 403
    assert "run" not in fake_docker.subcommands()


async def test_wrong_secret_is_403(client, fake_docker):
    r = await client.post("/v1/exec", json=BODY, headers={"X-Internal-Proxy-Secret": "nope"})
    assert r.status_code == 403
    assert "run" not in fake_docker.subcommands()


async def test_auth_is_checked_before_validation(client):
    r = await client.post("/v1/exec", json={"command": ""})
    assert r.status_code == 403


async def test_happy_path(client, fake_docker):
    fake_docker.script = BoxScript(stdout=b"hi\n")
    r = await client.post("/v1/exec", json=BODY, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 0 and body["stdout"] == "hi\n" and body["killed_reason"] is None
    assert set(body) == {"exit_code", "stdout", "stderr", "truncated", "duration_ms", "killed_reason", "files", "files_truncated"}
    assert body["files"] == [] and body["files_truncated"] is False


async def test_failed_command_is_still_200(client, fake_docker):
    fake_docker.script = BoxScript(exit_code=1, stderr=b"nope\n")
    r = await client.post("/v1/exec", json=BODY, headers=AUTH)
    assert r.status_code == 200 and r.json()["exit_code"] == 1


async def test_timeout_route(client, fake_docker):
    fake_docker.script = BoxScript(hang=True)
    r = await client.post("/v1/exec", json={**BODY, "command": "sleep 999", "timeout_seconds": 1}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["killed_reason"] == "timeout" and r.json()["exit_code"] is None


async def test_timeout_above_server_max_is_422(client, fake_docker):
    r = await client.post("/v1/exec", json={**BODY, "timeout_seconds": 301}, headers=AUTH)
    assert r.status_code == 422
    assert "run" not in fake_docker.subcommands()


@pytest.mark.parametrize("over", [{"user_id": "../x"}, {"workdir": "/etc"}, {"command": "x" * 16001}, {"agent_slug": "A"}])
async def test_bad_bodies_are_422_and_spawn_nothing(client, fake_docker, over):
    r = await client.post("/v1/exec", json={**BODY, **over}, headers=AUTH)
    assert r.status_code == 422
    assert "run" not in fake_docker.subcommands()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


async def test_files_round_trip_and_call_dir_is_removed(client, fake_docker, calls_root):
    seen = {}

    def box(argv):
        # The box sees in/ and out/ through the two mounts; emulate its writes.
        mounts = [a for a in argv if a.startswith("--mount=")]
        src = {m.split("dst=")[1].split(",")[0]: m.split("volume-opt=device=")[1].split(",")[0] for m in mounts}
        inp, out = Path(src["/conversation/input"]), Path(src["/conversation/output"])
        seen["csv"] = (inp / "sales.csv").read_bytes()
        (out / "report.xlsx").write_bytes(b"XLSX")
        seen["call_dir"] = out.parent

    fake_docker.script = BoxScript(stdout=b"done\n", on_start=box)
    body = {**BODY, "files": [
        {"path": "input/sales.csv", "content_b64": _b64(CSV)},
        {"path": "output/keep.txt", "content_b64": _b64(b"unchanged")},
    ]}
    r = await client.post("/v1/exec", json=body, headers=AUTH)
    assert r.status_code == 200
    data = r.json()
    assert seen["csv"] == CSV
    assert data["files"] == [{"path": "output/report.xlsx", "content_b64": _b64(b"XLSX"), "size": 4}]
    assert data["files_truncated"] is False
    assert not seen["call_dir"].exists()
    assert list(calls_root.iterdir()) == []


async def test_call_dir_is_removed_after_a_timeout(client, fake_docker, calls_root):
    fake_docker.script = BoxScript(hang=True)
    r = await client.post("/v1/exec", json={**BODY, "timeout_seconds": 1}, headers=AUTH)
    assert r.json()["killed_reason"] == "timeout"
    assert list(calls_root.iterdir()) == []


async def test_call_dir_is_removed_after_an_error(client, fake_docker, calls_root):
    fake_docker.script = BoxScript(never_started=True)
    r = await client.post("/v1/exec", json=BODY, headers=AUTH)
    assert r.status_code == 503
    assert list(calls_root.iterdir()) == []


async def test_oversized_input_is_413(client, fake_docker, svc, monkeypatch):
    monkeypatch.setattr(svc.core_settings.settings.sandbox, "max_input_bytes", 1000)
    body = {**BODY, "files": [{"path": "input/big", "content_b64": _b64(b"x" * 2000)}]}
    r = await client.post("/v1/exec", json=body, headers=AUTH)
    assert r.status_code == 413
    assert "run" not in fake_docker.subcommands()


async def test_bad_base64_is_422(client, fake_docker):
    body = {**BODY, "files": [{"path": "input/a", "content_b64": "%%%"}]}
    r = await client.post("/v1/exec", json=body, headers=AUTH)
    assert r.status_code == 422
    assert "run" not in fake_docker.subcommands()


@pytest.mark.parametrize("path", ["input/../../etc/passwd", "/etc/passwd", "output/a\\b", "x/y"])
async def test_traversal_in_file_paths_is_422(client, fake_docker, path):
    body = {**BODY, "files": [{"path": path, "content_b64": ""}]}
    r = await client.post("/v1/exec", json=body, headers=AUTH)
    assert r.status_code == 422
    assert "run" not in fake_docker.subcommands()


async def test_workdir_input_runs_in_input(client, fake_docker):
    r = await client.post("/v1/exec", json={**BODY, "workdir": "input"}, headers=AUTH)
    assert r.status_code == 200
    run = next(c for c in fake_docker.calls if c[1] == "run")
    assert "--workdir=/conversation/input" in run


async def test_daemon_unavailable_is_503(client, fake_docker):
    fake_docker.script = BoxScript(never_started=True)
    r = await client.post("/v1/exec", json=BODY, headers=AUTH)
    assert r.status_code == 503


async def test_audit_record_has_hash_and_no_output(client, fake_docker, caplog):
    fake_docker.script = BoxScript(stdout=b"TOP-SECRET-OUTPUT\n")
    with caplog.at_level(logging.INFO):
        r = await client.post("/v1/exec", json={**BODY, "command": "cat secret.txt"}, headers=AUTH)
    assert r.status_code == 200
    rec = next(rec for rec in caplog.records if getattr(rec, "event", None) == "sandbox_exec")
    data = rec.event_data
    assert data["outcome"] == "completed"
    assert data["user_id"].startswith("h:") and BODY["user_id"] not in data["user_id"]
    assert len(data["command_sha256"]) == 64
    assert data["command_prefix"] == "cat secret.txt"
    assert data["exit_code"] == 0 and data["killed_reason"] is None
    assert "TOP-SECRET-OUTPUT" not in repr(data)


async def test_health_ok_only_when_a_runsc_box_reports_gvisor(client, fake_docker):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "runtime": "runsc", "gvisor": True}
    run = next(c for c in fake_docker.calls if c[1] == "run")
    assert "--runtime=runsc" in run


async def test_health_503_when_box_is_not_gvisor(client, fake_docker, svc):
    fake_docker.health_stdout = b"NOT-GVISOR\n"
    svc.utils_health.health_monitor.invalidate()
    r = await client.get("/health")
    assert r.status_code == 503 and r.json()["gvisor"] is False


async def test_health_503_when_runsc_is_not_registered(client, fake_docker, svc):
    fake_docker.info_runtimes = '{"runc":{}}'
    svc.utils_health.health_monitor.invalidate()
    r = await client.get("/health")
    assert r.status_code == 503
    assert "run" not in fake_docker.subcommands()


async def test_health_verdict_is_cached(client, fake_docker, svc):
    svc.utils_health.health_monitor.invalidate()
    await client.get("/health")
    await client.get("/health")
    assert fake_docker.subcommands().count("run") == 1


def test_runner_refuses_to_boot_without_secret(svc, monkeypatch):
    monkeypatch.delenv("TRUSTED_PROXY_SECRET")
    with pytest.raises(Exception, match="TRUSTED_PROXY_SECRET"):
        svc.core_settings.Settings()
