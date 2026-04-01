# =============================================================================
# Integrated Agent - Production Dockerfile
# =============================================================================

FROM node:20-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npx tsc

# =============================================================================
# Production image
# =============================================================================
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    bash \
    docker-cli \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1000 agent && \
    adduser -u 1000 -G agent -s /bin/sh -D agent

WORKDIR /app

# Copy built artifacts
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package*.json ./

# Copy config
COPY config ./config

# Create directories
RUN mkdir -p /app/data/snapshots /app/data/audit /app/workspace && \
    chown -R agent:agent /app

# Switch to non-root user
USER agent

# Expose ports
EXPOSE 18789 18792

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:18792/health || exit 1

# Start
CMD ["node", "dist/index.js"]
