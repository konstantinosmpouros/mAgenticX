#!/usr/bin/env bash
# Publish one service's release image to GHCR — the build/scan/push half of CD.
#
#   bash .github/scripts/release_image.sh <service>
#
# Reads the service's tag from magenticx/docker-compose-denis.yaml (the tags
# there ARE the release). If GHCR already has that tag, it does nothing: tags
# are immutable, so a published tag is never rebuilt or overwritten — a re-run
# is harmless and an old tag is always there to roll back to. Otherwise it
# builds linux/arm64 with the tag baked in as APP_VERSION, refuses an image with
# a fixable CRITICAL vulnerability (Trivy), and pushes it.
#
# Runs inside the `cd` job of .github/workflows/pipeline.yml, already logged in
# to ghcr.io. Expects TRIVY_IMAGE plus the standard GITHUB_* variables.
set -euo pipefail

service="${1:?usage: release_image.sh <service>}"
compose="${COMPOSE_FILE:-magenticx/docker-compose-denis.yaml}"
trivy="${TRIVY_IMAGE:?TRIVY_IMAGE must be set}"
# Prefixed like the OrthodoxAI images (orthodoxai_<service>): GHCR packages
# share one account-wide namespace, and both projects have the same services.
repo="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/magenticx_$service"

# --- the release tag ---------------------------------------------------------
lines=$(grep -E "^[[:space:]]+image:[[:space:]]+${repo}:" "$compose" || true)
count=$(printf '%s\n' "$lines" | grep -c . || true)
if [ "$count" != "1" ]; then
  echo "::error::$compose must name exactly one '$repo:vX.Y.Z' image for $service (found $count)"
  exit 1
fi
tag=$(printf '%s' "${lines##*:}" | tr -d '[:space:]')
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::'$tag' is not a vX.Y.Z release tag ($service)"
  exit 1
fi
image="$repo:$tag"

# --- already published? ------------------------------------------------------
if out=$(docker manifest inspect "$image" 2>&1); then
  echo "::notice::$image is already published — nothing to build (tags are never overwritten)."
  exit 0
fi
# "denied" is safe to read as absent: if the package exists but this token can't
# see it, the push below is refused too, so nothing is overwritten by mistake.
# Anything else is network or registry trouble — fail rather than guess, because
# a wrong guess would rebuild and overwrite a published tag.
if ! printf '%s' "$out" | grep -qiE "manifest unknown|no such manifest|not found|name unknown|denied"; then
  echo "::error::Could not tell whether $image exists: $out"
  exit 1
fi

# --- build, scan, push -------------------------------------------------------
echo "Building $image"
docker build --pull --platform linux/arm64 \
  --build-arg APP_VERSION="$tag" \
  --label org.opencontainers.image.source="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \
  --label org.opencontainers.image.revision="$GITHUB_SHA" \
  --label org.opencontainers.image.version="$tag" \
  -t "$image" "magenticx/$service"

# Unfixed CRITICALs are not blocked: there is nothing to upgrade to yet.
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$trivy" \
  image --scanners vuln --severity CRITICAL --ignore-unfixed \
  --exit-code 1 --no-progress "$image"

docker push "$image"
echo "::notice::Published $image"
