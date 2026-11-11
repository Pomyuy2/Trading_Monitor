FROM caddy:2-alpine AS caddy-bin

FROM node:22-bookworm-slim

# Install OpenSSL for Prisma, ca-certificates, and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Caddy binary from official caddy image
COPY --from=caddy-bin /usr/bin/caddy /usr/bin/caddy

# Install pnpm matching packageManager version
RUN npm install -g pnpm@10.34.9

WORKDIR /app

# Copy dependency definition files first for efficient Docker caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY server/prisma ./server/prisma/

# Install all dependencies including devDependencies (needed for build and tsx/prisma runtime)
RUN pnpm install --frozen-lockfile

# Copy application source code
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY Caddyfile ./Caddyfile
COPY entrypoint.sh ./entrypoint.sh

RUN chmod +x ./entrypoint.sh

# Generate Prisma client
RUN pnpm --filter server exec prisma generate

# Build Next.js frontend
ENV NODE_ENV=production
RUN pnpm --filter web build

EXPOSE 80

CMD ["/app/entrypoint.sh"]
