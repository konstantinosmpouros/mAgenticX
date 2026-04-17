#!/usr/bin/env bash
#
# generate-certs.sh
#
# Creates a self-signed internal CA and per-service TLS certificates for
# encrypting all inter-service communication inside the Docker Compose stack.
#
# Usage:
#   bash generate-certs.sh                              # all default services
#   bash generate-certs.sh agents dialogue_bridge       # only specific services
#
# Each service name becomes a subdirectory with its cert + key.
# SANs are auto-generated as DNS:<service_name>,DNS:localhost.
#
# Post-generation steps on the Linux VM:
#   chown 999:999 chat_postgres/server.key
#   chown 100:100 vault/tls.key
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CA_DIR="$SCRIPT_DIR/ca"
DAYS_CA=3650       # CA valid for 10 years
DAYS_CERT=825      # Service certs valid ~2.25 years
KEY_BITS=2048

# Default services when no arguments are provided
DEFAULT_SERVICES=(agentic_ui dialogue_bridge agents rag_service chat_postgres vault npm)

# Use arguments if provided, otherwise fall back to defaults
if [ $# -gt 0 ]; then
  SERVICES=("$@")
else
  SERVICES=("${DEFAULT_SERVICES[@]}")
fi

# -------------------------------------------------------------------
# Generate the internal CA (only if it doesn't already exist)
# -------------------------------------------------------------------
if [ -f "$CA_DIR/ca.key" ] && [ -f "$CA_DIR/ca.crt" ]; then
  echo "=== CA already exists, reusing ==="
else
  echo "=== Generating Internal CA ==="
  mkdir -p "$CA_DIR"
  openssl genrsa -out "$CA_DIR/ca.key" $KEY_BITS 2>/dev/null

  # Use a config file instead of -subj to avoid Git Bash path mangling
  CA_CNF=$(mktemp)
  cat > "$CA_CNF" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3_ca
prompt = no
[dn]
CN = mAgenticX Internal CA
O  = mAgenticX
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage         = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
  openssl req -new -x509 -key "$CA_DIR/ca.key" -out "$CA_DIR/ca.crt" \
    -days $DAYS_CA -config "$CA_CNF" 2>/dev/null
  rm -f "$CA_CNF"
fi
echo "  CA cert : $CA_DIR/ca.crt"
echo "  CA key  : $CA_DIR/ca.key  (keep secret)"

# -------------------------------------------------------------------
# Generate per-service certs signed by the CA
# -------------------------------------------------------------------
for SERVICE in "${SERVICES[@]}"; do
  echo ""
  echo "=== Generating cert for: $SERVICE ==="
  CERT_DIR="$SCRIPT_DIR/$SERVICE"
  mkdir -p "$CERT_DIR"

  # Postgres convention: server.key / server.crt
  if [ "$SERVICE" = "chat_postgres" ]; then
    KEY_FILE="server.key"
    CRT_FILE="server.crt"
  else
    KEY_FILE="tls.key"
    CRT_FILE="tls.crt"
  fi

  # Private key
  openssl genrsa -out "$CERT_DIR/$KEY_FILE" $KEY_BITS 2>/dev/null

  # CSR config file (avoids Git Bash -subj path mangling)
  CSR_CNF=$(mktemp)
  cat > "$CSR_CNF" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $SERVICE
O  = mAgenticX
EOF
  openssl req -new \
    -key "$CERT_DIR/$KEY_FILE" \
    -out "$CERT_DIR/$SERVICE.csr" \
    -config "$CSR_CNF" 2>/dev/null
  rm -f "$CSR_CNF"

  # Extension config with SANs (service DNS name + localhost)
  cat > "$CERT_DIR/$SERVICE.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:$SERVICE,DNS:localhost,IP:127.0.0.1
EOF

  # Sign with CA
  openssl x509 -req \
    -in "$CERT_DIR/$SERVICE.csr" \
    -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -CAcreateserial \
    -out "$CERT_DIR/$CRT_FILE" \
    -days $DAYS_CERT \
    -extfile "$CERT_DIR/$SERVICE.ext" 2>/dev/null

  # Cleanup intermediate files
  rm -f "$CERT_DIR/$SERVICE.csr" "$CERT_DIR/$SERVICE.ext"

  # Restrictive permissions on private keys
  chmod 600 "$CERT_DIR/$KEY_FILE"

  echo "  cert: $CERT_DIR/$CRT_FILE"
  echo "  key : $CERT_DIR/$KEY_FILE"
done

# Cleanup CA serial file
rm -f "$CA_DIR/ca.srl"

echo ""
echo "=== All certificates generated ==="
