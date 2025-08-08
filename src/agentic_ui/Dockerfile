# 1) Build stage
FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Install dependencies first (leverages Docker layer caching)
COPY package*.json ./
RUN npm ci

# Copy the rest of the source and build
COPY . .
RUN npm run build


# 2) Runtime stage
FROM nginx:1.25-alpine

# Copy the compiled static files from previous stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Remove default Nginx config & add a tiny one that supports react-router
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
