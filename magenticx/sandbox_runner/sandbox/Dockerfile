# The sandbox image: what every `execute` box runs. A fixed interpreter and
# library set (no `pip install` at run time, and no network in the box), a
# non-root user, nothing else. The libraries are the ones for making files:
# tables, spreadsheets, charts, documents, slides, PDFs and images.
#
# Used directly by the spike (spike/run_spike.sh) and as the boot-time fallback
# of the runner. The runner image itself builds the same box in its `box` stage
# (../Dockerfile) from the same requirements.txt and ships it flattened, so the
# runner needs no network at boot.
FROM python:3.12.11-slim-bookworm

# The base image's build-time values (the Python release's signing key id and
# checksum) are public, but the box's environment is an allowlist: clear them.
ENV GPG_KEY= \
    PYTHON_SHA256= \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib

COPY requirements.txt /tmp/box-requirements.txt
RUN pip install --no-cache-dir -r /tmp/box-requirements.txt && rm /tmp/box-requirements.txt

COPY workload.py probes.py /opt/

USER 65534:65534
WORKDIR /tmp
