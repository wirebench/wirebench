# Builds and packages Wirebench Server as a container image. Build context is the repo root
# (see .dockerignore there); this file lives under packages/server, mirroring packages/cli/Dockerfile.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests + lockfile first so `pnpm install` layer-caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile --filter @wirebench/server...

COPY . .
RUN pnpm --filter @wirebench/server... build
RUN pnpm deploy --filter @wirebench/server --prod /out

FROM node:24-bookworm-slim AS runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/wirebench/wirebench" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

# The shared-workspace store shells out to git (argument arrays through GitCli).
RUN apt-get update && apt-get install -y --no-install-recommends git && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.WIREBENCH_SERVER_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["serve"]
