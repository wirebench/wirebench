# Builds and packages the wirebench CLI as a container image. Build context is the repo root
# (see .dockerignore there); this file lives under packages/cli per docs/specs/2026-09-19-ci-recipes-design.md §2.2.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests + lockfile first so `pnpm install` layer-caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol-soap/package.json packages/protocol-soap/package.json
COPY packages/protocol-rest/package.json packages/protocol-rest/package.json
COPY packages/protocol-grpc/package.json packages/protocol-grpc/package.json
COPY packages/protocol-ws/package.json packages/protocol-ws/package.json
COPY packages/protocol-mcp/package.json packages/protocol-mcp/package.json
COPY packages/protocol-graphql/package.json packages/protocol-graphql/package.json
COPY packages/ssh/package.json packages/ssh/package.json
RUN pnpm install --frozen-lockfile --filter @wirebench/cli...

COPY . .
RUN pnpm --filter @wirebench/cli... build
RUN pnpm deploy --filter @wirebench/cli --prod /out
# `@wirebench/ssh` is private and a dev dependency: the image carries the CLI's own copy, as the npm package does.
RUN node packages/cli/scripts/vendor-ssh.mjs /out
# The engine's core and protocol packages are private dev dependencies of the engine: its deployed copy
# carries its own, as the npm package does.
RUN node packages/engine/scripts/vendor-packages.mjs /out/node_modules/@wirebench/engine

FROM node:24-bookworm-slim AS runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/wirebench/wirebench" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /out /app
# `wirebench mock` listens on loopback by default, which nothing outside the container can reach; here the
# container's own network is the boundary, and only a port published with -p is reachable (#61).
ENV WIREBENCH_MOCK_HOST=0.0.0.0
USER node
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["--help"]
