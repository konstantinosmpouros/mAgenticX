#!/bin/sh
#
# entrypoint-postgres-tls.sh
#
# Wrapper that conditionally adds SSL flags to the Postgres server command.
# If the cert and key files are readable, SSL is enabled. Otherwise behaviour
# depends on REQUIRE_TLS, which defaults to "true": Postgres refuses to start in
# plain mode (exit 1) — secure by default. Set REQUIRE_TLS=false to allow the
# no-SSL fallback (escape hatch for environments that run without certs).
#
set -e

TLS_KEY="/var/lib/postgresql/tls/server.key"
TLS_CERT="/var/lib/postgresql/tls/server.crt"
CA_CERT="/var/lib/postgresql/tls/ca.crt"
REQUIRE_TLS="${REQUIRE_TLS:-true}"

if [ -r "$TLS_KEY" ] && [ -r "$TLS_CERT" ]; then
  echo "[entrypoint-postgres-tls] TLS certs found — enabling SSL"
  # Hand off to the default postgres entrypoint with SSL flags appended
  exec /usr/local/bin/docker-entrypoint.sh "$@" \
    -c ssl=on \
    -c ssl_cert_file="$TLS_CERT" \
    -c ssl_key_file="$TLS_KEY" \
    -c ssl_ca_file="$CA_CERT"
elif [ "$REQUIRE_TLS" = "true" ]; then
  echo "[entrypoint-postgres-tls] REQUIRE_TLS=true but TLS cert/key missing or unreadable at $TLS_CERT / $TLS_KEY — refusing to start without SSL" >&2
  exit 1
else
  echo "[entrypoint-postgres-tls] TLS certs not found — starting without SSL"
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi
