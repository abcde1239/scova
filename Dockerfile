# Linux-native dependencies are installed and generated inside the build, never copied from the host.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM oven/bun:1.3.4-debian@sha256:9d9504d425a8b85c5cf162c1c354f9403e15583e0f3e1de3750ce3723d3e89ac AS build
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
RUN VP_GIT_HOOKS=0 vp install --frozen-lockfile
COPY . .
RUN vp run -r build

FROM oven/bun:1.3.4-debian@sha256:9d9504d425a8b85c5cf162c1c354f9403e15583e0f3e1de3750ce3723d3e89ac AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The pinned Bun Debian image uses Trixie, which ships the required PostgreSQL 17 client.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-client-17 && \
    rm -rf /var/lib/apt/lists/* && mkdir -p /backups && chown bun:bun /backups
COPY --from=build --chown=bun:bun /app /app
ENV NODE_ENV=production AGENT_CHECKPOINT_MIGRATION=external
USER bun
WORKDIR /app/apps/server
CMD ["bun", "run", "src/main.ts"]
