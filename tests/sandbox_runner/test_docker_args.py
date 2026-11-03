"""The docker-run argument builder: every plan 11 §3.2 control on every call."""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def cfg(svc):
    return svc.core_settings.settings.sandbox


def _ws(svc, tmp_path):
    (tmp_path / "in").mkdir()
    (tmp_path / "out").mkdir()
    return svc.utils_workspace.Workspace(call_dir=tmp_path, input_dir=tmp_path / "in", output_dir=tmp_path / "out")


def _exec_args(svc, cfg, tmp_path, *, workdir="output", command="echo hi"):
    ws = _ws(svc, tmp_path)
    return svc.utils_docker_args.build_exec_args(cfg, name="sbx-test", workspace=ws, workdir=workdir, command=command), ws


def test_every_security_flag_is_present(svc, cfg, tmp_path):
    args, _ = _exec_args(svc, cfg, tmp_path)
    required = {
        "--runtime=runsc",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=1000:1000",
        "--pids-limit=128",
        "--memory=1g",
        "--memory-swap=1g",
        "--cpus=1",
        "--ulimit=nofile=256:256",
        f"--ulimit=fsize={100 * 1024 * 1024}:{100 * 1024 * 1024}",
        "--name=sbx-test",
        "--label=magenticx.sandbox=1",
        "--hostname=sandbox",
    }
    assert required <= set(args)


def test_environment_is_exactly_the_allowlist(svc, cfg, tmp_path):
    args, _ = _exec_args(svc, cfg, tmp_path)
    envs = [a for a in args if a.startswith(("--env", "-e"))]
    assert envs == ["--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=HOME=/tmp", "--env=LANG=C.UTF-8"]
    assert not any(a.startswith("--env-file") for a in args)


def test_no_dangerous_flags(svc, cfg, tmp_path):
    args, _ = _exec_args(svc, cfg, tmp_path)
    joined = " ".join(args)
    for bad in ("--privileged", "--cap-add", "docker.sock", "--network=host", "--pid=host", "--ipc=host",
                "--userns=host", "--device", "seccomp=unconfined", "apparmor=unconfined", "-v ", "--volume"):
        assert bad not in joined


def test_mounts_carry_nosuid_nodev_noexec_and_input_is_read_only(svc, cfg, tmp_path):
    args, ws = _exec_args(svc, cfg, tmp_path)
    mounts = [a[len("--mount="):] for a in args if a.startswith("--mount=")]
    assert len(mounts) == 2
    inp = next(m for m in mounts if "dst=/conversation/input" in m)
    out = next(m for m in mounts if "dst=/conversation/output" in m)
    assert f"volume-opt=device={ws.input_dir}" in inp
    assert '"volume-opt=o=bind,nosuid,nodev,noexec,ro"' in inp
    assert inp.endswith(",readonly")
    assert "src=sbx-test-in," in inp and "src=sbx-test-out," in out
    assert "volume-label=magenticx.sandbox=1" in inp and "volume-label=magenticx.sandbox=1" in out
    assert "volume-nocopy" in inp and "volume-nocopy" in out
    assert f"volume-opt=device={ws.output_dir}" in out
    assert '"volume-opt=o=bind,nosuid,nodev,noexec"' in out
    assert "readonly" not in out


def test_command_is_one_argv_element_after_sh_c(svc, cfg, tmp_path):
    nasty = "echo $HOME; rm -rf / --no-preserve-root && `id` | tee \"x\" '--privileged'"
    args, _ = _exec_args(svc, cfg, tmp_path, command=nasty, workdir="input")
    assert args[-3:] == ["sh", "-c", nasty]
    assert args[-4] == cfg.image
    assert "--workdir=/conversation/input" in args
    # Every flag precedes the image: nothing in the command can be read as a flag.
    assert args.index(cfg.image) == len(args) - 4


def test_limits_follow_settings(svc, cfg, tmp_path):
    custom = cfg.model_copy(update={"memory": "256m", "cpus": 0.5, "pids_limit": 64, "nofile": 128, "tmp_size": "16m"})
    args, _ = _exec_args(svc, custom, tmp_path)
    for flag in ("--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--pids-limit=64",
                 "--ulimit=nofile=128:128", "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m"):
        assert flag in args


def test_health_box_uses_the_same_flags(svc, cfg):
    exec_flags = set(svc.utils_docker_args.box_security_flags(cfg))
    health = svc.utils_docker_args.build_health_args(cfg, name="sbx-h")
    assert exec_flags <= set(health)
    assert not any(a.startswith("--mount") for a in health)


def test_container_names_are_unique(svc):
    names = {svc.utils_docker_args.new_container_name() for _ in range(200)}
    assert len(names) == 200 and all(n.startswith("sbx-") for n in names)


def test_invalid_limit_settings_are_refused(svc, monkeypatch):
    with pytest.raises(Exception):
        svc.core_settings.SandboxSettings(SANDBOX_MEMORY="0")
    with pytest.raises(Exception):
        svc.core_settings.SandboxSettings(SANDBOX_PIDS_LIMIT=0)
    with pytest.raises(Exception):
        svc.core_settings.SandboxSettings(SANDBOX_DEFAULT_TIMEOUT_SECONDS=600, SANDBOX_MAX_WALL_SECONDS=300)
    with pytest.raises(Exception):
        svc.core_settings.SandboxSettings(SANDBOX_USER="0:0")


def test_settings_defaults_are_conservative(svc, cfg):
    assert cfg.default_timeout_seconds == 60
    assert cfg.max_wall_seconds == 300
    assert cfg.memory == "1g" and cfg.cpus == 1.0 and cfg.pids_limit == 128
    assert cfg.max_output_bytes == 64 * 1024
    assert cfg.disk_budget_bytes == 100 * 1024 * 1024
    assert cfg.max_input_bytes == 20 * 1024 * 1024
    assert cfg.max_output_file_bytes == 25 * 1024 * 1024
    assert cfg.max_output_total_bytes == 50 * 1024 * 1024
    assert cfg.calls_root == Path(cfg.calls_root)
