FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY ./requirements.txt .

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# Shim that loads swarm secrets from /run/secrets/* into env vars before
# exec'ing the next command. Required because the openai SDK and LangChain
# read OPENAI_API_KEY directly from os.environ at import time.
COPY load-secrets-and-exec.sh /usr/local/bin/load-secrets-and-exec.sh
RUN chmod +x /usr/local/bin/load-secrets-and-exec.sh

EXPOSE 8003
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
