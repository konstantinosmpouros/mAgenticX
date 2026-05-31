# 1) Build stage
FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Install dependencies first (leverages Docker layer caching)
COPY package*.json ./
RUN npm ci

# Copy the rest of the source and build
COPY . .
RUN npm run build -- --debug


# 2) Runtime stage
FROM nginx:1.25-alpine

ENV BFF_BASE_URL=http://dialogue_bridge:8002

# Copy the compiled static files from previous stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Shim that loads swarm secrets from /run/secrets/* into env vars before exec'ing
# the next command. Required because nginx envsubst can't read files directly.
COPY load-secrets-and-exec.sh /usr/local/bin/load-secrets-and-exec.sh
RUN chmod +x /usr/local/bin/load-secrets-and-exec.sh

# Remove default Nginx config; the base nginx entrypoint renders templates from env vars.
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
