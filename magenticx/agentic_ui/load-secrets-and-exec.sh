#!/bin/sh
# Loads docker swarm secrets from /run/secrets/* into env vars, then exec's the
# next command. nginx's envsubst template renderer needs env vars (not files),
# so this shim bridges Swarm's tmpfs-mounted secrets to the env var form.
set -e

if [ -r /run/secrets/trusted_proxy_secret ]; then
  TRUSTED_PROXY_SECRET="$(cat /run/secrets/trusted_proxy_secret)"
  export TRUSTED_PROXY_SECRET
fi

exec "$@"
