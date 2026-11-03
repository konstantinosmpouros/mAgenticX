#!/bin/sh
# sandbox_runner entrypoint (plan 11). As root:
#   1. check TLS material — fail closed, like tls/entrypoint-tls.sh;
#   2. start the inner Docker daemon through `dind` (nested cgroup v2) on a unix
#      socket owned by group `runner`, and wait for it;
#   3. load the box image: import the pre-built rootfs shipped in the image, or
#      (fallback) build it from /opt/sandbox and flatten it the same way;
#   4. run the gVisor self-check — a real runsc box must report a gVisor
#      kernel, or the runner refuses to start;
#   5. start uvicorn as uid 1000 (TLS + mTLS unless explicitly disabled) and
#      supervise both processes: if either dies the container exits, so the
#      restart policy brings back a working pair instead of a half-alive one.
#
# Any argument replaces all of that (e.g. `/opt/spike/run_spike.sh`).
#
# Environment:
#   REQUIRE_TLS / REQUIRE_MTLS  default true. SANDBOX_REQUIRE_TLS /
#                               SANDBOX_REQUIRE_MTLS override them for this
#                               service only. false = local tests only.
#   SANDBOX_PORT                default 8090
#   SANDBOX_IMAGE               default magenticx-sandbox-box:local
#   SANDBOX_CALLS_ROOT          default /var/lib/sandbox-runner/calls
#   DOCKERD_WAIT_SECONDS        default 60
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

log() { echo "[sandbox-runner] $*"; }
die() { echo "[sandbox-runner] $*" >&2; exit 1; }

export DOCKER_HOST=unix:///var/run/docker.sock
TLS_KEY=/app/tls/tls.key
TLS_CERT=/app/tls/tls.crt
CA_CERT=/app/tls/ca.crt
REQUIRE_TLS="${SANDBOX_REQUIRE_TLS:-${REQUIRE_TLS:-true}}"
REQUIRE_MTLS="${SANDBOX_REQUIRE_MTLS:-${REQUIRE_MTLS:-true}}"
PORT="${SANDBOX_PORT:-8090}"
IMAGE="${SANDBOX_IMAGE:-magenticx-sandbox-box:local}"
CALLS_ROOT="${SANDBOX_CALLS_ROOT:-/var/lib/sandbox-runner/calls}"
WAIT="${DOCKERD_WAIT_SECONDS:-60}"

# ---- 1. TLS (checked first: no point booting a daemon we would not serve) ----
# The checks run as uid 1000, the user uvicorn will run as, so "readable" means
# readable by the server — not by root.
can_read() { su-exec runner test -r "$1"; }
UVICORN_TLS=""
if can_read "$TLS_KEY" && can_read "$TLS_CERT"; then
  UVICORN_TLS="--ssl-keyfile $TLS_KEY --ssl-certfile $TLS_CERT"
  if [ "$REQUIRE_MTLS" = "true" ]; then
    can_read "$CA_CERT" || die "REQUIRE_MTLS=true but $CA_CERT is missing or unreadable — refusing to start without client-cert verification"
    UVICORN_TLS="$UVICORN_TLS --ssl-ca-certs $CA_CERT --ssl-cert-reqs 2"
    log "TLS on, client certificates signed by the internal CA required"
  else
    log "TLS on, client certificates NOT required (REQUIRE_MTLS=false)"
  fi
elif [ "$REQUIRE_TLS" = "true" ]; then
  die "REQUIRE_TLS=true but $TLS_CERT / $TLS_KEY missing or unreadable — refusing to start in plaintext"
else
  log "WARNING: TLS disabled (REQUIRE_TLS=false) — plaintext, local tests only"
fi

# ---- 2. the inner daemon -----------------------------------------------------
rm -f /var/run/docker.pid /var/run/docker.sock
dind dockerd --host=unix:///var/run/docker.sock --group=runner >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!
i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt "$WAIT" ] || ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
    tail -30 /var/log/dockerd.log >&2 || true
    die "inner dockerd did not start"
  fi
  sleep 1
done
docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -qw runsc \
  || die "the inner daemon has no runsc runtime"
log "inner dockerd up (runtimes: $(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}'))"

# ---- 3. the box image --------------------------------------------------------
# `docker import` keeps only the --change settings: no ENV from the base image
# reaches a box. The default user is nobody; the runner always passes --user.
import_box() {
  docker import \
    --change 'USER 65534:65534' \
    --change 'WORKDIR /tmp' \
    --change 'CMD ["python3"]' \
    "$1" "$IMAGE" >/dev/null
}
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "box image $IMAGE already loaded"
elif [ -r /opt/box-rootfs.tar.gz ]; then
  log "importing the pre-built box image"
  import_box /opt/box-rootfs.tar.gz || die "box image import failed"
else
  log "no pre-built box — building it from /opt/sandbox (needs network)"
  docker build -q -t "$IMAGE-build" /opt/sandbox >/tmp/box-build.log 2>&1 || { tail -30 /tmp/box-build.log >&2; die "box image build failed"; }
  cid=$(docker create "$IMAGE-build")
  docker export "$cid" | import_box - || die "box image flatten failed"
  docker rm "$cid" >/dev/null
  docker rmi "$IMAGE-build" >/dev/null || true
fi

# ---- the per-call temp dirs --------------------------------------------------
# Each call stages its files in <calls root>/<uuid>/{in,out}; nothing survives a
# restart. 0700 and owned by 1000: the API (and the box, same uid) only.
case "$CALLS_ROOT" in
  /*/*/*) ;;  # at least three levels deep: never wipe / or a top-level dir
  *) die "SANDBOX_CALLS_ROOT=$CALLS_ROOT is too shallow to be wiped at boot" ;;
esac
rm -rf "$CALLS_ROOT"
mkdir -p "$CALLS_ROOT"
chown 1000:1000 "$CALLS_ROOT"
chmod 0700 "$CALLS_ROOT"

# ---- 4. gVisor self-check ----------------------------------------------------
su-exec runner:runner python /app/selfcheck.py || die "gVisor self-check failed — refusing to start"

# ---- 5. uvicorn, supervised --------------------------------------------------
cd /app
# shellcheck disable=SC2086  # UVICORN_TLS is a deliberate word list
su-exec runner:runner uvicorn main:app --host 0.0.0.0 --port "$PORT" --no-server-header $UVICORN_TLS &
API_PID=$!

stop() {
  kill -TERM "$API_PID" 2>/dev/null || true
  kill -TERM "$DOCKERD_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$DOCKERD_PID" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$DOCKERD_PID" 2>/dev/null; do
  sleep 2
done
log "a supervised process exited (api alive: $(kill -0 "$API_PID" 2>/dev/null && echo yes || echo no), dockerd alive: $(kill -0 "$DOCKERD_PID" 2>/dev/null && echo yes || echo no))"
tail -20 /var/log/dockerd.log >&2 || true
stop
exit 1
