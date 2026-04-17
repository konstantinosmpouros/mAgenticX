#!/bin/sh
#
# entrypoint-postgres-tls.sh
#
# Wrapper that conditionally adds SSL flags to the Postgres server command.
# If the cert and key files exist, SSL is enabled. Otherwise Postgres
# starts in plain mode.
#
set -e

TLS_KEY="/var/lib/postgresql/tls/server.key"
TLS_CERT="/var/lib/postgresql/tls/server.crt"
CA_CERT="/var/lib/postgresql/tls/ca.crt"

if [ -f "$TLS_KEY" ] && [ -f "$TLS_CERT" ]; then
  echo "[entrypoint-postgres-tls] TLS certs found — enabling SSL"
  # Hand off to the default postgres entrypoint with SSL flags appended
  exec /usr/local/bin/docker-entrypoint.sh "$@" \
    -c ssl=on \
    -c ssl_cert_file="$TLS_CERT" \
    -c ssl_key_file="$TLS_KEY" \
    -c ssl_ca_file="$CA_CERT"
else
  echo "[entrypoint-postgres-tls] TLS certs not found — starting without SSL"
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi
