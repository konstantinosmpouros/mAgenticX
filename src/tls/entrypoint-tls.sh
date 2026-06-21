#!/bin/sh
#
# entrypoint-tls.sh
#
# Wrapper entrypoint for uvicorn-based services. If TLS cert and key are
# readable at the conventional paths, uvicorn starts with SSL enabled.
# Otherwise behaviour depends on REQUIRE_TLS, which defaults to "true": the
# service refuses to start in plaintext (exit 1) — secure by default. Set
# REQUIRE_TLS=false to allow the plain-HTTP fallback (escape hatch for
# environments that intentionally run without certs).
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
REQUIRE_TLS="${REQUIRE_TLS:-true}"

if [ -r "$TLS_KEY" ] && [ -r "$TLS_CERT" ]; then
  echo "[entrypoint-tls] TLS certs found — starting uvicorn with SSL"
  exec uvicorn "$@" --ssl-keyfile "$TLS_KEY" --ssl-certfile "$TLS_CERT"
elif [ "$REQUIRE_TLS" = "true" ]; then
  echo "[entrypoint-tls] REQUIRE_TLS=true but TLS cert/key missing or unreadable at $TLS_CERT / $TLS_KEY — refusing to start in plaintext" >&2
  exit 1
else
  echo "[entrypoint-tls] TLS certs not found — starting uvicorn without SSL"
  exec uvicorn "$@"
fi
