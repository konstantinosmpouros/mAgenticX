FROM python:3.12-slim

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

# Stash the in-repo skills registry catalog (runtime/skill_registry/registry) as
# the seed source for the global volume. At boot,
# runtime.skill_registry.seed_global_registry copies these into the mounted
# $SKILLS_REGISTRY_GLOBAL_ROOT volume with `cp -rn` semantics.
RUN cp -r /app/runtime/skill_registry/registry /opt/skills_registry_seed

# Stash the in-repo built-in declarative agents as the seed for the global
# volume. At boot, runtime.declarative.agent_seed.seed_global_agents copies these into
# $MAGENTICX_GLOBAL_ROOT/agents/ with `cp -rn` semantics.
RUN cp -r /app/agents_seed /opt/agents_seed

# Pre-create every persistent mount point with UID 1000 ownership so fresh
# Docker named volumes inherit permissions the non-root container user can
# write to. Without this, Docker creates the directory as root and the
# UID-1000 process can't write into the volume.
RUN mkdir -p /var/magenticx/global/agents /var/magenticx/global/skills /var/magenticx/workspaces/users \
    && chown -R 1000:1000 /var/magenticx

EXPOSE 8003
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
