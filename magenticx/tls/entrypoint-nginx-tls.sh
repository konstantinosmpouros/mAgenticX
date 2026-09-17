#!/bin/sh
#
# entrypoint-nginx-tls.sh
#
# Generates /etc/nginx/conf.d/tls.inc before the default nginx entrypoint
# processes env-var templates and starts nginx.
#
# If TLS certs are readable at the conventional paths, the include file enables
# the HTTPS listener and upstream SSL verification. Otherwise behaviour depends
# on REQUIRE_TLS, which defaults to "true": nginx refuses to start in HTTP-only
# mode (exit 1) — secure by default. Set REQUIRE_TLS=false to write an empty
# include and serve HTTP only (escape hatch for environments without certs).
#
# When REQUIRE_TLS is true the CA cert is also mandatory: nginx proxies upstream
# over https and proxy_ssl_verify only engages with a CA, so a missing CA is the
# same class of silent downgrade and is treated as fatal.
#
set -e

TLS_INC="/etc/nginx/conf.d/tls.inc"
TLS_KEY="/etc/nginx/tls/tls.key"
TLS_CERT="/etc/nginx/tls/tls.crt"
CA_CERT="/etc/nginx/tls/ca.crt"
REQUIRE_TLS="${REQUIRE_TLS:-true}"

if [ -r "$TLS_KEY" ] && [ -r "$TLS_CERT" ]; then
  if [ "$REQUIRE_TLS" = "true" ] && [ ! -r "$CA_CERT" ]; then
    echo "[entrypoint-nginx-tls] REQUIRE_TLS=true but CA cert missing or unreadable at $CA_CERT — refusing to start without upstream verification" >&2
    exit 1
  fi

  echo "[entrypoint-nginx-tls] TLS certs found — enabling HTTPS listener"
  cat > "$TLS_INC" <<EOF
listen 443 ssl;
ssl_certificate     $TLS_CERT;
ssl_certificate_key $TLS_KEY;
ssl_protocols       TLSv1.2 TLSv1.3;
ssl_ciphers         HIGH:!aNULL:!MD5;
EOF

  # Add upstream SSL verification if the CA cert is also present. Also present
  # this service's own cert as a client certificate so the upstream
  # (dialogue_bridge) can mutually authenticate us (mTLS). proxy_ssl_certificate
  # is only sent when the upstream requests it, so it is harmless when the bridge
  # runs with REQUIRE_MTLS=false (one-way TLS).
  if [ -r "$CA_CERT" ]; then
    cat >> "$TLS_INC" <<EOF
proxy_ssl_trusted_certificate $CA_CERT;
proxy_ssl_verify              on;
proxy_ssl_verify_depth        2;
proxy_ssl_server_name         on;
proxy_ssl_certificate         $TLS_CERT;
proxy_ssl_certificate_key     $TLS_KEY;
EOF
  fi
elif [ "$REQUIRE_TLS" = "true" ]; then
  echo "[entrypoint-nginx-tls] REQUIRE_TLS=true but TLS cert/key missing or unreadable at $TLS_CERT / $TLS_KEY — refusing to start in HTTP-only mode" >&2
  exit 1
else
  echo "[entrypoint-nginx-tls] TLS certs not found — HTTP-only mode"
  : > "$TLS_INC"
fi

# Hand off to the default nginx entrypoint (env-var template processing + nginx start)
exec /docker-entrypoint.sh "$@"
