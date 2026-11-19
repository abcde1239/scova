# Linux-native dependencies are installed and generated inside the build, never copied from the host.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM oven/bun:1.3.4-debian@sha256:9d9504d425a8b85c5cf162c1c354f9403e15583e0f3e1de3750ce3723d3e89ac AS dependencies
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bash unzip && rm -rf /var/lib/apt/lists/*
ENV VP_HOME=/opt/vite-plus VP_VERSION=1.4.0 VP_SETUP_NODE_VERSION=24.22.1
RUN curl -fsSL https://vite.plus -o /tmp/vp-install.sh && bash /tmp/vp-install.sh && rm /tmp/vp-install.sh
ENV PATH=/opt/vite-plus/bin:/opt/vite-plus/current/bin:$PATH
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/object-storage/package.json packages/object-storage/package.json
RUN VP_GIT_HOOKS=0 vp install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN vp run -r build

FROM nginxinc/nginx-unprivileged:1.28-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY ops/proxy/default.conf /etc/nginx/conf.d/default.conf

FROM oven/bun:1.3.4-debian@sha256:9d9504d425a8b85c5cf162c1c354f9403e15583e0f3e1de3750ce3723d3e89ac AS runtime-base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The pinned Bun Debian image uses Trixie, which ships the required PostgreSQL 17 client.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-client-17 && \
    rm -rf /var/lib/apt/lists/* && mkdir -p /backups && chown bun:bun /backups
ENV NODE_ENV=production

FROM runtime-base AS runtime
COPY --from=build --chown=bun:bun /app /app
USER bun
WORKDIR /app/apps/server
CMD ["bun", "run", "src/main.ts"]

# Only the Worker needs Chromium; keep the API and migration image browser-free.
FROM runtime-base AS worker-browser
# Install browsers from dependency manifests, before copying source, so code-only
# updates reuse Chromium and its system packages without repeating downloads.
COPY --from=dependencies --chown=bun:bun /app /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/scova-browsers READER_NODE_EXECUTABLE=/usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends procps && \
    cd /app/packages/connectors && node node_modules/playwright/cli.js install --with-deps chromium && \
    chmod -R a+rX /opt/scova-browsers && rm -rf /var/lib/apt/lists/*

FROM worker-browser AS worker-runtime
COPY --from=build --chown=bun:bun /app /app
USER bun
WORKDIR /app/apps/worker
CMD ["bun", "run", "src/main.ts"]
