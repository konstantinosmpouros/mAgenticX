#!/bin/sh
# Phase 0 spike (plan 11): does a gVisor sandbox work on this host, and is it
# fast enough? Run inside the sandbox_runner image with --privileged:
#
#   docker run --rm --privileged -v "$PWD/results:/results" sandbox-runner /opt/spike/run_spike.sh
#
# It starts the image's own Docker daemon, builds the sandbox image, then runs
# containment checks under runsc and the same file-making workload under runc
# and runsc. Writes results/summary.md; exits non-zero if any check fails.
set -u
# The docker:dind base image points the CLI at tcp://docker:2375 (its sidecar
# setup); this script talks to the daemon it starts itself, on the socket.
export DOCKER_HOST=unix:///var/run/docker.sock

RESULTS=/results
mkdir -p "$RESULTS"
SUMMARY="$RESULTS/summary.md"
FAILED=0

say() { echo "$*" | tee -a "$SUMMARY"; }
check() {
  # check "<name>" <0|1>: 0 means the check passed.
  if [ "$2" -eq 0 ]; then say "| $1 | ✅ pass |"; else say "| $1 | ❌ FAIL |"; FAILED=1; fi
}

: > "$SUMMARY"
say "# Sandbox spike — $(uname -m)"
say ""
say "| Host fact | Value |"
say "| --- | --- |"
say "| Architecture | $(uname -m) |"
say "| Kernel | $(uname -r) |"
if [ -e /dev/kvm ]; then say "| /dev/kvm | present |"; else say "| /dev/kvm | **absent** (as on Dennis) |"; fi
say "| CPUs | $(nproc) |"
say "| runsc | $(runsc --version 2>/dev/null | head -1) |"

# ---- the inner daemon ------------------------------------------------------
# Through docker:dind's `dind` wrapper, which sets up nested cgroups (v2):
# without it no container can start inside.
dind dockerd --host=unix:///var/run/docker.sock >/tmp/dockerd.log 2>&1 &
i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then say ""; say "Inner dockerd did not start:"; tail -30 /tmp/dockerd.log; exit 1; fi
  sleep 1
done
runtimes=$(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}')
say "| Inner runtimes | $runtimes |"

say ""
say "Building the sandbox image…"
if ! docker build -q -t sandbox /opt/sandbox >/tmp/build.log 2>&1; then
  say "Sandbox image build failed:"; tail -30 /tmp/build.log; exit 1
fi

OUT=/tmp/out
# The sandbox writes as 65534 into the bind-mounted output directory.
prepare_out() { rm -rf "$OUT"; mkdir -p "$OUT"; chmod 0777 "$OUT"; }

# Every control from plan 11 §3.2, except the runtime, which each call picks.
box() {
  runtime="$1"; shift
  docker run --rm --runtime="$runtime" \
    --network none --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    -v "$OUT":/out:rw \
    --cap-drop ALL --security-opt no-new-privileges \
    --user 65534:65534 \
    --pids-limit 128 --memory 1g --memory-swap 1g --cpus 2 \
    --ulimit nofile=256:256 \
    --env PATH=/usr/local/bin:/usr/bin:/bin --env HOME=/tmp \
    sandbox "$@"
}

# ---- containment, under runsc ----------------------------------------------
# Every check needs the box to RUN and say so: a box that fails to start, or
# crashes, fails the check. (A "must fail" command alone would pass when the
# box never started, which is exactly the false confidence to avoid.)
say ""
say "## Containment (runsc)"
say ""
say "| Check | Result | Detail |"
say "| --- | --- | --- |"
prepare_out

probe_out=$(box runsc python /opt/probes.py 2>&1)
if ! echo "$probe_out" | grep -q "PROBES DONE"; then
  say "| The probe box ran | ❌ FAIL | $(echo "$probe_out" | tail -2 | tr '\n' ' ') |"
  FAILED=1
fi
for name in gvisor-kernel no-network loopback-only rootfs-read-only tmp-noexec output-writable \
            non-root no-secrets no-docker-socket host-secrets-unreadable; do
  line=$(echo "$probe_out" | grep -E "^(PASS|FAIL) $name " | head -1)
  detail=$(echo "$line" | sed 's/^[A-Z]* [a-z-]* — //' | tr '|' '/')
  case "$line" in
    PASS*) say "| $name | ✅ pass | $detail |" ;;
    *) say "| $name | ❌ FAIL | ${detail:-no verdict printed} |"; FAILED=1 ;;
  esac
done

# Fork bomb: the box must start (STARTED) and then end quickly, either with
# fork() refused at the cap (CAPPED, as under runc) or with the whole sandbox
# killed (gVisor: its own threads count against the cap, so the box dies and
# exits non-zero). Not a pass: hanging until the timeout, or a box left behind.
# Either way the daemon must still answer afterwards.
bomb_start=$(date +%s)
bomb=$(timeout 90 docker run --rm --runtime=runsc --pids-limit 64 --network none --user 65534:65534 sandbox \
  python -c '
import os, time
print("STARTED", flush=True)
n = 0
while True:
    try:
        if os.fork() == 0:
            time.sleep(30)
            os._exit(0)
        n += 1
    except OSError:
        print("CAPPED", n, flush=True)
        os._exit(0)
' 2>&1); bomb_status=$?
bomb_secs=$(( $(date +%s) - bomb_start ))
leftover=$(docker ps -aq | wc -l)
if echo "$bomb" | grep -q STARTED && [ "$bomb_status" -ne 124 ] && [ "$leftover" -eq 0 ] \
   && { echo "$bomb" | grep -q CAPPED || [ "$bomb_status" -ne 0 ]; } && docker info >/dev/null 2>&1; then
  how=$(echo "$bomb" | grep CAPPED || echo "sandbox killed, exit $bomb_status")
  say "| fork-bomb | ✅ pass | $how after ${bomb_secs}s; no box left; daemon alive |"
else
  say "| fork-bomb | ❌ FAIL | exit $bomb_status after ${bomb_secs}s, $leftover left: $(echo "$bomb" | tail -2 | tr '\n' ' ') |"; FAILED=1
fi

# Memory: the box must start, then fail to take 1 GiB under a 256 MiB limit.
mem=$(timeout 90 docker run --rm --runtime=runsc --memory 256m --memory-swap 256m --network none --user 65534:65534 sandbox \
  python -c '
print("STARTED", flush=True)
b = bytearray(1024 * 1024 * 1024)
b[::4096] = b"x" * len(b[::4096])
print("ALLOCATED", flush=True)
' 2>&1); mem_status=$?
if echo "$mem" | grep -q STARTED && ! echo "$mem" | grep -q ALLOCATED; then
  say "| memory-cap | ✅ pass | 1 GiB refused under 256 MiB (exit $mem_status) |"
else
  say "| memory-cap | ❌ FAIL | $(echo "$mem" | tail -2 | tr '\n' ' ') |"; FAILED=1
fi

# ---- the workload, runc vs runsc -------------------------------------------
say ""
say "## Workload: 100k-row CSV → pandas → xlsx, chart, docx, pptx, pdf"
say ""
for runtime in runc runsc; do
  prepare_out
  start=$(date +%s)
  result=$(box "$runtime" python /opt/workload.py /out 2>/tmp/workload.err)
  status=$?
  wall=$(( $(date +%s) - start ))
  if [ $status -ne 0 ]; then
    say "- **$runtime**: failed (exit $status): $(tail -3 /tmp/workload.err)"
    FAILED=1
  else
    say "- **$runtime**: ${wall}s wall clock, in-script \`$result\`"
  fi
done

say ""
if [ "$FAILED" -eq 0 ]; then say "**Result: every check passed.**"; else say "**Result: at least one check FAILED.**"; fi
exit "$FAILED"
