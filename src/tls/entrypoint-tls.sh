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
# Mutual TLS: REQUIRE_MTLS also defaults to "true". When TLS is on and the CA is
# readable, uvicorn is told to require + verify a client certificate signed by
# the internal CA (--ssl-cert-reqs 2 = ssl.CERT_REQUIRED). Every caller of this
# service must then present its client cert (nginx via proxy_ssl_certificate,
# peer services via httpx cert=, the container healthcheck via load_cert_chain).
# A missing/unreadable CA under REQUIRE_MTLS=true is fatal — same fail-closed
# stance as REQUIRE_TLS. Set REQUIRE_MTLS=false to fall back to one-way TLS
# (server-auth only); this is the lever for the zero-downtime rollout (deploy
# all peers presenting certs first, then flip enforcement on).
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
CA_CERT="/app/tls/ca.crt"
REQUIRE_TLS="${REQUIRE_TLS:-true}"
REQUIRE_MTLS="${REQUIRE_MTLS:-true}"

if [ -r "$TLS_KEY" ] && [ -r "$TLS_CERT" ]; then
  MTLS_ARGS=""
  if [ "$REQUIRE_MTLS" = "true" ]; then
    if [ -r "$CA_CERT" ]; then
      echo "[entrypoint-tls] REQUIRE_MTLS=true — requiring client certificates signed by the internal CA"
      MTLS_ARGS="--ssl-ca-certs $CA_CERT --ssl-cert-reqs 2"
    else
      echo "[entrypoint-tls] REQUIRE_MTLS=true but CA cert missing or unreadable at $CA_CERT — refusing to start without client-cert verification" >&2
      exit 1
    fi
  fi
  echo "[entrypoint-tls] TLS certs found — starting uvicorn with SSL"
  exec uvicorn "$@" --ssl-keyfile "$TLS_KEY" --ssl-certfile "$TLS_CERT" $MTLS_ARGS
elif [ "$REQUIRE_TLS" = "true" ]; then
  echo "[entrypoint-tls] REQUIRE_TLS=true but TLS cert/key missing or unreadable at $TLS_CERT / $TLS_KEY — refusing to start in plaintext" >&2
  exit 1
else
  echo "[entrypoint-tls] TLS certs not found — starting uvicorn without SSL"
  exec uvicorn "$@"
fi
