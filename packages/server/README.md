# Wirebench Server

Sign-in, teams and shared workspaces for Wirebench, self-hosted. One process, one PostgreSQL
database, one data directory; run it behind TLS. Design: `docs/specs/2026-09-24-wirebench-server-host-design.md`.

## Configuration

<!-- Generated from CONFIG_VARIABLES by `pnpm docs:server-config`; edit src/config.ts, not this table. -->
<!-- prettier-ignore-start -->
<!-- config:start -->
| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WIREBENCH_SERVER_DATABASE_URL` | yes | — | PostgreSQL connection string. Never logged. |
| `WIREBENCH_SERVER_PUBLIC_URL` | yes | — | The `https://…` origin clients use; no path, query or trailing slash. |
| `WIREBENCH_SERVER_DATA_DIR` | no | `/data` | Repositories and temporary files. |
| `WIREBENCH_SERVER_HOST` | no | `0.0.0.0` | Listen address. |
| `WIREBENCH_SERVER_PORT` | no | `8080` | Listen port. |
| `WIREBENCH_SERVER_LOG_LEVEL` | no | `info` | Log level: fatal, error, warn, info, debug or trace. |
| `WIREBENCH_SERVER_TRUST_PROXY` | no | `false` | Honour `X-Forwarded-*` headers and incoming request ids. |
| `WIREBENCH_SERVER_GIT_PATH` | no | — | Explicit git binary; otherwise `PATH` is searched. |
| `WIREBENCH_SERVER_BODY_LIMIT_MB` | no | `32` | Maximum request body in MiB. |
| `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL` | no | `false` | Permit an `http://` public URL (development only). |
| `WIREBENCH_SERVER_LOCAL_AUTH` | no | `true` | Offer local accounts (email and password). |
| `WIREBENCH_SERVER_OIDC_ISSUER` | no | — | OIDC issuer URL; setting it turns OIDC sign-in on. Discovery runs at start-up. |
| `WIREBENCH_SERVER_OIDC_CLIENT_ID` | no | — | Client id registered at the issuer. Required with the issuer. |
| `WIREBENCH_SERVER_OIDC_CLIENT_SECRET` | no | — | Client secret registered at the issuer. Required with the issuer. Never logged. |
| `WIREBENCH_SERVER_OIDC_SCOPES` | no | `openid email profile` | Scopes requested from the issuer, space-separated. |
| `WIREBENCH_SERVER_OIDC_DISPLAY_NAME` | no | `OIDC` | The label of the *Continue with …* button in the app. |
| `WIREBENCH_SERVER_TOKEN_IDLE_DAYS` | no | `30` | A device token unused for this long expires. |
| `WIREBENCH_SERVER_TOKEN_MAX_DAYS` | no | `180` | A device token older than this expires whatever its use. |
| `WIREBENCH_SERVER_INVITATION_DAYS` | no | `7` | How long an invitation or password-reset link stays valid. |
<!-- config:end -->
<!-- prettier-ignore-end -->

## Running

    docker compose -f packages/server/compose.yaml up

Runs `ghcr.io/wirebench/wirebench-server` beside PostgreSQL 16 with a named volume each. Both ports
are published on `127.0.0.1` only: the server on `WIREBENCH_HTTP_PORT` (default `8080`) and the
database on `WIREBENCH_DB_PORT` (default `5432`); set either when the default is taken. Outside
development put it behind a TLS-terminating proxy and set `WIREBENCH_SERVER_PUBLIC_URL` to the
`https://` origin users will reach. Run **one** replica: the per-workspace lock is in-process
(ADR-0009). `wirebench-server migrate` applies schema migrations ahead of a restart;
`wirebench-server migrate --check` exits 1 while any are pending; `wirebench-server config check`
lists each variable as set, defaulted or missing without printing values. `/healthz` reports
pass/fail per check (database, data directory, git) and nothing else.
