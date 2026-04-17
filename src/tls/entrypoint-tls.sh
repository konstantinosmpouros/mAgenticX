#!/bin/sh
#
# entrypoint-tls.sh
#
# Wrapper entrypoint for uvicorn-based services. If TLS cert and key exist
# at the conventional paths, uvicorn starts with SSL enabled. Otherwise it
# falls back to plain HTTP so the service still starts without certs.
#
# Usage in docker-compose command override:
#   entrypoint: ["/bin/sh", "/app/tls/entrypoint-tls.sh"]
#   command: ["main:app", "--host", "0.0.0.0", "--port", "8002"]
#
# The command args are passed through as uvicorn positional/flag arguments.
#
set -e

TLS_KEY="/app/tls/tls.key"
TLS_CERT="/app/tls/tls.crt"

if [ -f "$TLS_KEY" ] && [ -f "$TLS_CERT" ]; then
  echo "[entrypoint-tls] TLS certs found — starting uvicorn with SSL"
  exec uvicorn "$@" --ssl-keyfile "$TLS_KEY" --ssl-certfile "$TLS_CERT"
else
  echo "[entrypoint-tls] TLS certs not found — starting uvicorn without SSL"
  exec uvicorn "$@"
fi
