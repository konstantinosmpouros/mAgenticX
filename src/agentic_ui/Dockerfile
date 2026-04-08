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

ENV BFF_HOST=dialogue_bridge
ENV BFF_PORT=8002
ENV TRUSTED_PROXY_SECRET=

# Copy the compiled static files from previous stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Remove default Nginx config; the base nginx entrypoint renders templates from env vars.
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
