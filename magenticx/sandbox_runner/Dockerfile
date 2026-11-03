# sandbox_runner — runs one untrusted command per call in a throwaway gVisor box
# (plan 11). The image is the runner: its own Docker daemon (docker-in-docker,
# like the MCP gateway) with gVisor's `runsc` registered as a runtime, the
# FastAPI app that drives it, and the box image it runs, pre-built and
# flattened so the runner needs no network at boot.
#
# Run with `privileged: true` (the inner daemon needs it). The spike still
# works: `docker run --rm --privileged <image> /opt/spike/run_spike.sh`.

# ---- the box: what every `execute` call runs ---------------------------------
# Same base and the same requirements.txt as sandbox/Dockerfile.
FROM python:3.12.11-slim-bookworm AS box
COPY sandbox/requirements.txt /tmp/box-requirements.txt
RUN pip install --no-cache-dir -r /tmp/box-requirements.txt && rm /tmp/box-requirements.txt
COPY sandbox/workload.py sandbox/probes.py /opt/

# Flattened to a rootfs tarball: the runner `docker import`s it at boot, which
# drops every ENV the base image set — a box's environment is exactly the
# runner's allowlist (PATH, HOME, LANG), nothing inherited.
FROM alpine:3.22 AS boxtar
COPY --from=box / /rootfs/
RUN tar -C /rootfs --numeric-owner -czf /box-rootfs.tar.gz .

# ---- the runner ----------------------------------------------------------------
FROM docker:28.3.3-dind

# gVisor, pinned to a dated release and checked against its published SHA-512.
ARG GVISOR_RELEASE=20261012.0
ARG TARGETARCH
RUN set -eux; \
    apk add --no-cache bzip2; \
    case "${TARGETARCH:-$(uname -m)}" in \
      arm64|aarch64) arch=aarch64; sum=2fe7425abd16ad6ca649ab9bc3d7e8e76756834d86ffcc08dbe97c82c3b7262a7d6401f23632f2b296649cc1408b560416b2ab65a4043aa123fc7b90f3a1b2e2 ;; \
      amd64|x86_64) arch=x86_64; sum=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e ;; \
      *) echo "unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    wget -q -O /tmp/gvisor.tar.bz2 "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}/gvisor.tar.bz2"; \
    echo "${sum}  /tmp/gvisor.tar.bz2" | sha512sum -c -; \
    # runsc looks for its helpers (gvisor_sentry, the gofer, …) in gvisor-bin/
    # beside itself, so the whole tree is unpacked, not just the binary.
    tar -xjf /tmp/gvisor.tar.bz2 -C /usr/local/bin runsc containerd-shim-runsc-v1 gvisor-bin; \
    rm /tmp/gvisor.tar.bz2; \
    chmod -R 0755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1 /usr/local/bin/gvisor-bin; \
    runsc --version

# Python for the app, and su-exec to drop root for uvicorn. The API process runs
# as 1000:1000 — the owner of the shared workspace volume — and reaches the
# inner daemon through its socket, whose group is `runner`.
RUN set -eux; \
    apk add --no-cache python3 su-exec; \
    addgroup -g 1000 runner; \
    adduser -D -H -u 1000 -G runner -s /sbin/nologin runner; \
    python3 -m venv /opt/venv

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /app/requirements.txt

# The inner daemon knows runsc; the platform is systrap (no KVM on Dennis).
COPY daemon.json /etc/docker/daemon.json

# The box: pre-built rootfs (normal boot) and its source (fallback build, spike).
COPY --from=boxtar /box-rootfs.tar.gz /opt/box-rootfs.tar.gz
COPY sandbox/ /opt/sandbox/
COPY spike/ /opt/spike/

COPY main.py selfcheck.py healthcheck.py /app/
COPY core/ /app/core/
COPY router/ /app/router/
COPY schema/ /app/schema/
COPY utils/ /app/utils/
COPY entrypoint.sh /usr/local/bin/sandbox-runner-entrypoint.sh
RUN chmod 0755 /usr/local/bin/sandbox-runner-entrypoint.sh /opt/spike/run_spike.sh

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOCKER_HOST=unix:///var/run/docker.sock

# The release tag, passed in by CD, declared last so it never busts the layers above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/sandbox-runner-entrypoint.sh"]
CMD []
