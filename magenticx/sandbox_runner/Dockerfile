# sandbox_runner — runs one untrusted command per call in a throwaway gVisor box
# (plan 11). This image is the runner: its own Docker daemon (docker-in-docker,
# like the MCP gateway) with gVisor's `runsc` registered as a runtime. Each
# sandbox the runner starts uses `--runtime=runsc`, so code in it never talks
# to the host kernel directly.
#
# Phase 0 (the spike): the image carries the sandbox image's source and a test
# script that proves runsc works on ARM64 without KVM (Dennis is an Ampere A1
# with no /dev/kvm, so gVisor runs on its `systrap` platform), and measures a
# realistic file-generating workload under it.
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

# The inner daemon knows runsc; the platform is systrap (no KVM on Dennis).
COPY daemon.json /etc/docker/daemon.json

# The image each sandbox runs, built by the inner daemon at start.
COPY sandbox/ /opt/sandbox/
COPY spike/ /opt/spike/
RUN chmod 0755 /opt/spike/run_spike.sh
