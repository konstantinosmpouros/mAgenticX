"""Containment probes, run INSIDE a sandbox box. Prints one line per check,
`PASS <name>` or `FAIL <name> — <detail>`, then `PROBES DONE`. The spike
counts a check as passed only when its PASS line is printed, so a box that
never started (or crashed) fails every check instead of passing them."""
import ctypes
import os
import socket
import subprocess

results: list[tuple[str, bool, str]] = []


def check(name):
    def wrap(fn):
        try:
            ok, detail = fn()
        except Exception as exc:  # a probe that crashes is a failure, never a pass
            ok, detail = False, f"probe error: {exc!r}"
        results.append((name, ok, detail))
        return fn
    return wrap


@check("gvisor-kernel")
def _gvisor():
    # gVisor answers the kernel log itself, with its own boot lines; the host
    # kernel refuses a non-root reader. /proc/version is gVisor's fixed fake.
    buf = ctypes.create_string_buffer(16384)
    n = ctypes.CDLL(None, use_errno=True).klogctl(3, buf, len(buf))
    log = buf.raw[: max(n, 0)].decode(errors="replace")
    version = open("/proc/version").read()
    return ("gVisor" in log or "gvisor" in log.lower()), f"klogctl={n}, /proc/version={version.strip()[:60]}"


@check("no-network")
def _network():
    for host, port in (("1.1.1.1", 53), ("8.8.8.8", 443), ("172.17.0.1", 2375)):
        try:
            socket.create_connection((host, port), timeout=3).close()
            return False, f"connected to {host}:{port}"
        except OSError:
            pass
    return True, "every connection refused or unreachable"


@check("loopback-only")
def _interfaces():
    names = sorted(os.listdir("/sys/class/net")) if os.path.isdir("/sys/class/net") else []
    return names in ([], ["lo"]), f"interfaces={names}"


@check("rootfs-read-only")
def _rootfs():
    try:
        open("/etc/escape", "w").close()
        return False, "wrote /etc/escape"
    except OSError as exc:
        return True, exc.strerror


@check("tmp-noexec")
def _noexec():
    with open("/bin/true", "rb") as src, open("/tmp/true", "wb") as dst:
        dst.write(src.read())
    os.chmod("/tmp/true", 0o755)
    try:
        subprocess.run(["/tmp/true"], check=True)
        return False, "ran a binary copied into /tmp"
    except (PermissionError, OSError, subprocess.CalledProcessError) as exc:
        return True, type(exc).__name__


@check("output-writable")
def _output():
    with open("/out/probe.txt", "w") as fh:
        fh.write("ok")
    return True, "wrote /out/probe.txt"


@check("non-root")
def _user():
    return os.getuid() != 0 and os.geteuid() != 0, f"uid={os.getuid()}"


@check("no-secrets")
def _env():
    # Docker can't remove an image's ENV, only blank it, so an empty value is clean.
    leaked = [
        k
        for k, v in os.environ.items()
        if v and any(w in k.lower() for w in ("key", "secret", "token", "password"))
    ]
    return not leaked, f"env keys={sorted(os.environ)}"


@check("no-docker-socket")
def _socket():
    return not os.path.exists("/var/run/docker.sock"), "docker socket absent"


@check("host-secrets-unreadable")
def _shadow():
    try:
        open("/etc/shadow").read()
        return False, "read /etc/shadow"
    except OSError as exc:
        return True, exc.strerror


for name, ok, detail in results:
    print(f"{'PASS' if ok else 'FAIL'} {name} — {detail}")
print("PROBES DONE")
