# Pin the Node.js patch release containing the Brotli decoder security fix.
# Debian slim rather than Alpine: onnxruntime-node (Silero VAD for audio sync)
# ships glibc binaries only.
FROM node:24.22.1-slim

# gosu for privilege dropping, tzdata for IANA timezone support, ffmpeg for audio sync
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu tzdata ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Install dependencies first (for better caching). Include project npm policy
# so production installs enforce the reviewed lifecycle-script allowlist.
COPY package*.json .npmrc ./
RUN npm ci --omit=dev \
    && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32

# Copy application code
COPY . .

# Create cache directories and keys directory for encryption key persistence
RUN mkdir -p .cache/translations \
    .cache/translations_bypass \
    .cache/translations_partial \
    .cache/sync_cache \
    data \
    logs \
    keys

# Keep application files and dependencies read-only at runtime. Only /app itself
# (for the default key file) and the runtime data directories need ownership.
# Avoiding a recursive chown of node_modules also makes image builds much faster.
RUN chown node:node /app && \
    chown -R node:node .cache data logs keys && \
    chmod 777 .cache data logs keys

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# NOTE: We intentionally do NOT set USER here.
# The entrypoint starts as root, fixes bind-mount directory ownership
# to PUID:PGID (default 1000:1000 = node), then drops privileges via
# gosu before starting the application. This is the standard Docker
# pattern (used by postgres, redis, etc.) and handles the common case
# where Docker creates bind-mount directories as root on the host.
#
# To run as a custom UID/GID, set PUID and PGID environment variables:
#   environment:
#     - PUID=1000
#     - PGID=1000

# Expose port (default 7001)
EXPOSE 7001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Entrypoint fixes permissions and drops privileges before starting the app
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
