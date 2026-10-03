#!/usr/bin/env bash
# Build, scan and (in publish mode) push one service's image to GHCR.
#   bash .github/scripts/release_image.sh <service>
# Tag comes from docker-compose-denis.yaml; an already-published tag is skipped
# (tags are never overwritten). Pushes only when RELEASE_MODE=publish.
set -euo pipefail

service="${1:?usage: release_image.sh <service>}"
compose="${COMPOSE_FILE:-magenticx/docker-compose-denis.yaml}"
trivy="${TRIVY_IMAGE:?TRIVY_IMAGE must be set}"
mode="${RELEASE_MODE:-check}"
# Prefixed: OrthodoxAI shares the GHCR namespace and the service names.
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
# "denied" counts as absent (the push would be refused too); anything else
# fails rather than risk overwriting a published tag.
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

# Blocks fixable CRITICALs only.
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$trivy" \
  image --scanners vuln --severity CRITICAL --ignore-unfixed \
  --exit-code 1 --no-progress "$image"

if [ "$mode" != "publish" ]; then
  echo "::notice::$image builds and passes the scan — not pushed (RELEASE_MODE=$mode)."
  exit 0
fi
docker push "$image"
echo "::notice::Published $image"
