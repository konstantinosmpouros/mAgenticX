# Base image
FROM python:3.12-slim

# Environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# System packages.
#  - fonts-dejavu-core: Unicode-capable TrueType font used by the conversation
#    PDF exporter (utils/share_export.py). The slim base image ships with no
#    fonts at all, so the exporter's _FontRegistry.load() raises
#    "No Unicode-capable TrueType font found for PDF export." without this.
#    DejaVu Sans covers Latin (incl. extended), Greek, and Cyrillic — enough
#    for the conversation export use case at ~3 MB on disk.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The release tag, passed in by CD (`--build-arg APP_VERSION=v2.17.17`). Read by
# settings.app.version: it stamps every log line and is reported by /health,
# which is how the deploy job confirms the new image is actually serving.
# Declared last so changing it never invalidates the dependency layers above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8002"]
