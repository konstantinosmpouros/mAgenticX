# 1) Build stage
# Node 22 matches CI (pipeline.yml builds and tests on 22); Node 20 is past end of life.
FROM node:22-alpine AS builder

# Create app directory
WORKDIR /app

# Install dependencies first (leverages Docker layer caching)
COPY package*.json ./
RUN npm ci

# Copy the rest of the source and build
COPY . .
RUN npm run build -- --debug


# 2) Runtime stage
# nginx 1.28 is the supported stable line (1.25 sat on Alpine 3.19, past end of
# life, carrying fixable CRITICAL CVEs that CD's Trivy gate rejects). The
# `apk upgrade` picks up Alpine security fixes published after the base image
# was cut — without it even 1.28 fails the gate on OpenSSL.
FROM nginx:1.28-alpine

RUN apk upgrade --no-cache

ENV BFF_BASE_URL=http://dialogue_bridge:8002

# Copy the compiled static files from previous stage
COPY --from=builder /app/dist /usr/share/nginx/html

# The release tag, passed in by CD (`--build-arg APP_VERSION=v0.15.14`), served
# as /version.txt. The deploy job polls it to confirm the new UI is live. A
# static file rather than an nginx template variable: the Dennis TLS entrypoint
# renders the template, and an unsubstituted variable would stop nginx booting.
ARG APP_VERSION=dev
RUN printf '%s\n' "$APP_VERSION" > /usr/share/nginx/html/version.txt

# Shim that loads swarm secrets from /run/secrets/* into env vars before exec'ing
# the next command. Required because nginx envsubst can't read files directly.
COPY load-secrets-and-exec.sh /usr/local/bin/load-secrets-and-exec.sh
RUN chmod +x /usr/local/bin/load-secrets-and-exec.sh

# Remove default Nginx config; the base nginx entrypoint renders templates from env vars.
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
