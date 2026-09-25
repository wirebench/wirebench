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

## Accounts

Accounts are invite-only. On a fresh server, create the first admin from the console:

    docker compose -f packages/server/compose.yaml exec server wirebench-server admin invite you@example.com

It prints a one-time link (`<public URL>/invite/<code>`), valid for `WIREBENCH_SERVER_INVITATION_DAYS`
(default 7). Open it, or paste the code into Wirebench's _Account: Sign in to a server…_ dialog under
_Have an invitation code?_, choose a password, and you are the first server admin. Every later
invitation is created the same way or from the app by a server admin; the link is copied and sent
however the team already talks — the server sends no email. `admin list-invitations` and
`admin revoke-invitation <id>` exist for an operator who cannot yet sign in.

Two sign-in methods, both on by default once configured: local accounts (email and password,
`WIREBENCH_SERVER_LOCAL_AUTH`) and OpenID Connect (`WIREBENCH_SERVER_OIDC_*`). With OIDC, register
the redirect URI `wirebench-server config check` prints (`<public URL>/api/v1/auth/oidc/callback`)
at the identity provider; a login is linked to an existing account, or to an open invitation, by
the provider's **verified** email, and never creates an account on its own. Sign-in and invitation
endpoints are rate-limited to ten attempts a minute per address and per email (one process, so
the counters reset on restart). Device tokens expire after `WIREBENCH_SERVER_TOKEN_IDLE_DAYS`
without use or `WIREBENCH_SERVER_TOKEN_MAX_DAYS` at most; a user sees and revokes their devices
in the app, and an admin who disables a user revokes them all.
