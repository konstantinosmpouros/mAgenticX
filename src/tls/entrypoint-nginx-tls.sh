#!/bin/sh
#
# entrypoint-nginx-tls.sh
#
# Generates /etc/nginx/conf.d/tls.inc before the default nginx entrypoint
# processes env-var templates and starts nginx.
#
# If TLS certs exist at the conventional paths, the include file enables
# the HTTPS listener and upstream SSL verification. Otherwise it writes
# an empty file so Nginx starts in HTTP-only mode.
#
set -e

TLS_INC="/etc/nginx/conf.d/tls.inc"
TLS_KEY="/etc/nginx/tls/tls.key"
TLS_CERT="/etc/nginx/tls/tls.crt"
CA_CERT="/etc/nginx/tls/ca.crt"

if [ -f "$TLS_KEY" ] && [ -f "$TLS_CERT" ]; then
  echo "[entrypoint-nginx-tls] TLS certs found — enabling HTTPS listener"
  cat > "$TLS_INC" <<EOF
listen 443 ssl;
ssl_certificate     $TLS_CERT;
ssl_certificate_key $TLS_KEY;
ssl_protocols       TLSv1.2 TLSv1.3;
ssl_ciphers         HIGH:!aNULL:!MD5;
EOF

  # Add upstream SSL verification if the CA cert is also present
  if [ -f "$CA_CERT" ]; then
    cat >> "$TLS_INC" <<EOF
proxy_ssl_trusted_certificate $CA_CERT;
proxy_ssl_verify              on;
proxy_ssl_verify_depth        2;
proxy_ssl_server_name         on;
EOF
  fi
else
  echo "[entrypoint-nginx-tls] TLS certs not found — HTTP-only mode"
  : > "$TLS_INC"
fi

# Hand off to the default nginx entrypoint (env-var template processing + nginx start)
exec /docker-entrypoint.sh "$@"
