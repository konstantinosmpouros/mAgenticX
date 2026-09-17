#!/bin/sh
# Loads Docker Swarm secrets from /run/secrets/* into env vars matching the
# uppercase form of each filename, then exec's the next command.
#
# Required because some libraries (openai SDK, LangChain's init_chat_model)
# read OPENAI_API_KEY directly from the environment at import time and bypass
# Pydantic settings — so the *_FILE indirection alone is not enough.
set -e

if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -r "$f" ] || continue
    name=$(basename "$f" | tr '[:lower:]' '[:upper:]')
    val=$(cat "$f")
    export "$name=$val"
  done
fi

exec "$@"
