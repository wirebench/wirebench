# Builds and packages the wirebench CLI as a container image. Build context is the repo root
# (see .dockerignore there); this file lives under packages/cli per docs/specs/2026-09-19-ci-recipes-design.md §2.2.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests + lockfile first so `pnpm install` layer-caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile --filter @wirebench/cli...

COPY . .
RUN pnpm --filter @wirebench/cli... build
RUN pnpm deploy --filter @wirebench/cli --prod /out

FROM node:24-bookworm-slim AS runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/wirebench/wirebench" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /out /app
USER node
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["--help"]
