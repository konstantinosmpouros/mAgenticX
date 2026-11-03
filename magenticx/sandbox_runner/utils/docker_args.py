"""Build the ``docker run`` argv for one box — every flag a deliberate control.

The table in plan 11 §3.2 is implemented here and only here, so a test can
assert each control is present on every call. Limits come from settings, never
literals. The command itself is passed as a single argv element to ``sh -c``:
there is no host shell anywhere on the path, so nothing in it is interpreted
before it reaches the box.

Mounts use a ``local`` volume of ``type=none,o=bind`` rather than ``-v``,
because ``-v`` / ``--mount type=bind`` cannot carry ``nosuid,nodev,noexec``;
the volume form applies them to the bind mount itself. Each volume is named
after its box (``<box>-in`` / ``<box>-out``; docker refuses a read-only
*anonymous* volume) and labelled, and is removed with the box — removing it
unmounts, it never deletes the source directory.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from core.settings import SandboxSettings
from utils.workspace import Workspace

CONTAINER_LABEL = "magenticx.sandbox=1"
CONTAINER_PREFIX = "sbx-"
# The only environment a box gets. Docker itself adds HOSTNAME; it is set to a
# fixed, non-identifying name below.
BOX_PATH = "/usr/local/bin:/usr/bin:/bin"
BOX_HOME = "/tmp"
BOX_LANG = "C.UTF-8"
BOX_HOSTNAME = "sandbox"


def new_container_name() -> str:
    """A unique, unguessable name per call, so cleanup can target exactly this box."""
    return f"{CONTAINER_PREFIX}{uuid.uuid4().hex}"


def volume_names(name: str) -> tuple[str, str]:
    """The two per-box volume names (input, output)."""
    return f"{name}-in", f"{name}-out"


def _bind_volume(source: Path, target: str, *, read_only: bool, volume: str) -> str:
    """``--mount`` spec for a bind mount carrying nosuid,nodev,noexec.

    The value is CSV-parsed by the docker CLI, so the ``o=`` option (which
    itself contains commas) is double-quoted as one field. Paths reaching here
    are the runner's own call dirs (<calls_root>/<uuid hex>/in|out), so they
    hold no commas or quotes.
    """
    host_opts = "bind,nosuid,nodev,noexec" + (",ro" if read_only else "")
    fields = [
        "type=volume",
        f"src={volume}",
        f"dst={target}",
        f"volume-label={CONTAINER_LABEL}",
        # Without nocopy, docker "populates" an empty volume from the image and
        # re-owns its root to the image's root:root 755 — out/ would become
        # unwritable for the box's uid 1000.
        "volume-nocopy",
        "volume-driver=local",
        "volume-opt=type=none",
        f"volume-opt=device={source}",
        f'"volume-opt=o={host_opts}"',
    ]
    if read_only:
        fields.append("readonly")
    return ",".join(fields)


def box_security_flags(cfg: SandboxSettings) -> list[str]:
    """The isolation and limit flags shared by every box (exec and health)."""
    return [
        f"--runtime={cfg.runtime}",
        "--network=none",
        "--read-only",
        f"--tmpfs=/tmp:rw,nosuid,nodev,noexec,size={cfg.tmp_size}",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        f"--user={cfg.user}",
        f"--pids-limit={cfg.pids_limit}",
        f"--memory={cfg.memory}",
        f"--memory-swap={cfg.memory}",
        f"--cpus={cfg.cpus:g}",
        f"--ulimit=nofile={cfg.nofile}:{cfg.nofile}",
        f"--ulimit=fsize={cfg.fsize_bytes}:{cfg.fsize_bytes}",
        f"--hostname={BOX_HOSTNAME}",
        f"--label={CONTAINER_LABEL}",
        # No --rm: the runner inspects the stopped box (exit code, OOMKilled,
        # start error) and then removes it itself in a `finally`. --rm would
        # race that inspect. Boxes orphaned by a runner crash are swept at boot.
        # A clean environment: only the allowlist, nothing inherited.
        f"--env=PATH={BOX_PATH}",
        f"--env=HOME={BOX_HOME}",
        f"--env=LANG={BOX_LANG}",
    ]


def build_exec_args(
    cfg: SandboxSettings, *, name: str, workspace: Workspace, workdir: str, command: str
) -> list[str]:
    """The full argv (after the ``docker`` binary) to run ``command`` for one call."""
    args = ["run", f"--name={name}", *box_security_flags(cfg)]
    vol_in, vol_out = volume_names(name)
    args.append("--mount=" + _bind_volume(workspace.input_dir, "/conversation/input", read_only=True, volume=vol_in))
    args.append("--mount=" + _bind_volume(workspace.output_dir, "/conversation/output", read_only=False, volume=vol_out))
    args += [f"--workdir=/conversation/{workdir}", cfg.image, "sh", "-c", command]
    return args


# Run inside a health box: gVisor answers the kernel log itself with its own
# boot lines, while a host kernel refuses a non-root reader (phase 0 probes.py).
HEALTH_PROBE = (
    "import ctypes;b=ctypes.create_string_buffer(16384);"
    "n=ctypes.CDLL(None).klogctl(3,b,16384);"
    "print('GVISOR' if b'gvisor' in b.raw[:max(n,0)].lower() else 'NOT-GVISOR')"
)


def build_health_args(cfg: SandboxSettings, *, name: str) -> list[str]:
    """A box with the same flags and no mounts, printing whether its kernel is gVisor."""
    return ["run", f"--name={name}", *box_security_flags(cfg), cfg.image, "python3", "-I", "-c", HEALTH_PROBE]
