# Builds and packages Wirebench Server as a container image. Build context is the repo root
# (see .dockerignore there); this file lives under packages/server, mirroring packages/cli/Dockerfile.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests + lockfile first so `pnpm install` layer-caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol-soap/package.json packages/protocol-soap/package.json
COPY packages/protocol-rest/package.json packages/protocol-rest/package.json
COPY packages/protocol-grpc/package.json packages/protocol-grpc/package.json
COPY packages/protocol-ws/package.json packages/protocol-ws/package.json
COPY packages/protocol-mcp/package.json packages/protocol-mcp/package.json
COPY packages/protocol-graphql/package.json packages/protocol-graphql/package.json
# The host and the wire code are bundled into dist/host/bundle.js at build time (hosted edition spec
# §17.3); as the server's dev dependencies they, and their own dependencies, are installed here only.
COPY packages/host/package.json packages/host/package.json
COPY packages/wire/package.json packages/wire/package.json
COPY packages/ssh/package.json packages/ssh/package.json
# The browser client is the desktop's renderer built by Vite (spec §17.6), so the build stage installs the
# desktop's dependencies too: its renderer's React, Monaco and Vite. Electron's binary is never fetched, and
# none of the desktop's packages reach the runtime stage, which takes only the server's deploy.
COPY apps/desktop/package.json apps/desktop/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --filter @wirebench/server... --filter @wirebench/desktop...

COPY . .
# The server's build first: it builds the engine's core and protocol packages, whose built files the
# renderer's `#core/*` imports resolve to. Its copy step finds no browser build yet and says so; the
# browser build is copied into dist/browser once it exists.
RUN pnpm --filter @wirebench/server... build
RUN pnpm --filter @wirebench/desktop build:browser && node packages/server/scripts/copy-browser.mjs
RUN pnpm deploy --filter @wirebench/server --prod /out
# The deploy carries the bundle and the browser build but none of the sources they were built from, and
# nothing of the desktop's.
RUN test -f /out/dist/host/bundle.js && test -f /out/dist/browser/index.html \
  && test ! -e /out/node_modules/@wirebench/host && test ! -e /out/node_modules/electron \
  && test -z "$(find /out/dist -name '*.ts' ! -name '*.d.ts')"
# The engine's core and protocol packages are private dev dependencies of the engine: its deployed copy
# carries its own, as the npm package does.
RUN node packages/engine/scripts/vendor-packages.mjs /out/node_modules/@wirebench/engine

FROM node:24-bookworm-slim AS runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/wirebench/wirebench" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Elastic-2.0"

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
