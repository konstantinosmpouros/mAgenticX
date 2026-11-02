# The sandbox image: what every `execute` box runs. A fixed interpreter and
# library set (no `pip install` at run time, and no network in the box), a
# non-root user, nothing else. The libraries are the ones for making files:
# tables, spreadsheets, charts, documents, slides, PDFs and images.
FROM python:3.12.11-slim-bookworm

# The base image's build-time values (the Python release's signing key id and
# checksum) are public, but the box's environment is an allowlist: clear them.
ENV GPG_KEY= \
    PYTHON_SHA256= \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib

RUN pip install --no-cache-dir \
      pandas==2.2.3 \
      numpy==2.2.6 \
      openpyxl==3.1.5 \
      matplotlib==3.10.3 \
      python-docx==1.1.2 \
      python-pptx==1.0.2 \
      reportlab==4.4.1 \
      pillow==11.2.1

COPY workload.py probes.py /opt/

USER 65534:65534
WORKDIR /tmp
