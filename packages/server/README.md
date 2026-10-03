# Wirebench Server

Sign-in, teams, shared workspaces and live updates for Wirebench, self-hosted. One process, one PostgreSQL
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
| `WIREBENCH_SERVER_HOOKS_ENABLED` | no | `true` | Serve catch URLs: the public `/hooks/…` route and the webhook management API. |
| `WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB` | no | `1` | How much of a caught request body is stored, in MiB (1–32). A longer body is cut and marked truncated. |
| `WIREBENCH_SERVER_HOOKS_KEEP` | no | `500` | Captures kept per catch URL (1–10000); the oldest go first. |
| `WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS` | no | `7` | Captures older than this many days are deleted (1–365). |
| `WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND` | no | `10` | Requests per second a catch URL accepts once its burst is spent (1–1000); past it, `429`. |
| `WIREBENCH_SERVER_HOOKS_BURST` | no | `50` | Requests a catch URL accepts at once before the rate applies (1–10000). |
| `WIREBENCH_SERVER_HOOKS_PER_WORKSPACE` | no | `50` | Catch URLs a workspace may hold (1–1000). |
| `WIREBENCH_SERVER_HOOKS_SECRET_KEY` | no | — | Encrypts catch URL signature secrets at rest: 32 random bytes, base64-encoded (`openssl rand -base64 32`). Unset, signature settings are refused. Never logged. |
| `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` | no | `365` | Audit events older than this many days are deleted (30–3650). |
| `WIREBENCH_SERVER_AUDIT_FORWARD_URL` | no | — | Forward every audit event (Enterprise): `syslog+tcp://host:port`, `syslog+tls://host:port` or `https://…` (`http://` only on a loopback host). Unset, nothing is forwarded. |
| `WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN` | no | — | Sent as `Authorization: Bearer …` with each HTTPS batch. Refused with a syslog URL. Never logged. |
| `WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE` | no | — | A PEM bundle added to the system roots for `syslog+tls` and `https` forwarding. Certificates are always verified. |
| `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` | no | — | Seals audit events into a keyed hash chain that `admin audit verify` checks: at least 32 bytes, kept outside the database and never changed. Unset, nothing is sealed. Never logged. |
<!-- config:end -->
<!-- prettier-ignore-end -->

## Running

    docker compose -f packages/server/compose.yaml up

Runs `ghcr.io/wirebench/wirebench-server` beside PostgreSQL 16 with a named volume each. Both ports
are published on `127.0.0.1` only: the server on `WIREBENCH_HTTP_PORT` (default `8080`) and the
database on `WIREBENCH_DB_PORT` (default `5432`); set either when the default is taken. Outside
development put it behind a TLS-terminating proxy that forwards WebSocket upgrades (see
[Live updates](#live-updates)) and set `WIREBENCH_SERVER_PUBLIC_URL` to the `https://` origin users will
reach. Run **one** replica: the per-workspace lock (ADR-0009) and the live-updates hub (ADR-0013) are
in-process. `wirebench-server migrate` applies schema migrations ahead of a restart;
`wirebench-server migrate --check` exits 1 while any are pending; `wirebench-server config check`
lists each variable as set, defaulted or missing without printing values. `/healthz` reports
pass/fail per check (database, data directory, git) and nothing else.

## Accounts

Accounts are invite-only. On a fresh server, create the first admin from the console:

    docker compose -f packages/server/compose.yaml exec server node /app/dist/bin.js admin invite you@example.com

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

## License

A server with no license is the Community edition: everything it does today, for up to five enabled
accounts. A license file sets the Team or Enterprise edition. It is checked offline against a public key
built into the server; nothing is sent anywhere. Install it from the app's License tab, or here:

    docker compose -f packages/server/compose.yaml exec server node /app/dist/bin.js admin license install /path/in/container/team.lic

`admin license show` prints the edition, seats and expiry; `admin license remove` returns the server to
Community. An expired license keeps its edition for 30 days, then the server is Community again, with
nobody signed out and nothing locked. See the docs site's _Editions and licenses_ guide.

## Audit log

The server records who did what: sign-ins and failed sign-ins, users, teams, workspace roles, pushes,
team-secret changes, catch URLs, CI tokens and license changes. Recording is on for every edition. Server
admins read it in the app's Audit tab, and team admins read their own team's events there, which needs an
Enterprise license; the console export works on any edition:

    docker compose -f packages/server/compose.yaml exec -T server node /app/dist/bin.js admin audit export --from 2026-10-01T00:00:00Z > audit.ndjson

A workspace admin can turn on **Record desktop activity** for a workspace: the app then reports each
request sent and each test-suite run (`POST /api/v1/workspaces/:id/audit/desktop-events`), URL masked, no
headers or bodies.

With `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` set (at least 32 bytes, kept outside the database, never rotated,
and the same on every instance that shares the database), a background sealer links events into a keyed
hash chain and logs `audit chain sealed to <seq>:<hex>` after each pass. `wirebench-server admin audit
verify [--head <seq>:<hex>] [--json]` finds edited, missing or reordered events (exit 0 intact, 1 broken, 2
no or wrong key). Retention stops at a tampered row or a gap and logs an error. See the guide's _Tamper
evidence_ section for what it does not detect.

On an Enterprise server, `WIREBENCH_SERVER_AUDIT_FORWARD_URL` forwards every audit event to one collector as
RFC 5424 syslog over TCP or TLS (`syslog+tcp://`, `syslog+tls://`) or as JSON batches over HTTPS, with an
optional bearer token and CA bundle. Delivery is at least once (for syslog, a batch counts as delivered once it is in the OS socket buffer; see the guide): de-duplicate on the event `id`.

Events older than `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` (default 365) are deleted. See the docs site's
_Audit log_ guide for what each event carries and how to handle personal data.

## Teams

A server admin creates teams (`POST /api/v1/teams`) and becomes the first admin of each. Team admins do
the rest, from the app's **Account: Manage teams…** dialog or the API:

- Add people who already have an account, invite new ones, and change or remove roles. A team keeps at
  least one admin.
- Workspaces belong to a team. Any member can create one and is its admin. Each workspace has a default
  role for the team's members (`none`, `viewer` or `editor`; new workspaces default to `viewer`), and a
  workspace admin can grant any member a different role.

| Role   | Open and pull | Send requests | Push | Manage access | Delete |
| ------ | ------------- | ------------- | ---- | ------------- | ------ |
| viewer | yes           | yes           | no   | no            | no     |
| editor | yes           | yes           | yes  | no            | no     |
| admin  | yes           | yes           | yes  | yes           | yes    |

Team admins and server admins are admins of every workspace of their teams. To anyone without a role,
a workspace (or a team) does not exist: the API answers `404`, never `403`. Deleting a workspace moves
its repository under `<data dir>/tmp/`; nothing is deleted from disk.

## Sync

The app's _Share this workspace… → Wirebench Server_ and _Open a team workspace…_ talk to five endpoints
under `/api/v1/workspaces/:workspaceId/sync`: `head`, `snapshot`, `changes` and `log` (viewers and up)
and `POST commits` (editors and admins). `/api/v1/meta` lists `sync` among its capabilities.

- The app merges. The server stores each push as ordinary git commits on `main` in the workspace's bare
  repository, authored by the signed-in user. Nothing in a request can name the author.
- A push whose parent is not the current head is refused with `409 sync-push-rejected`. The app pulls,
  merges and pushes again. Two pushes to one workspace never interleave.
- Paths are checked before git runs. `.git`, `share.yaml`, `local.yaml`, `unsaved/` and anything outside
  the workspace's own files are refused, and a file is at most 8 MiB.
- `WIREBENCH_SERVER_BODY_LIMIT_MB` bounds both a push (`413 request-too-large`) and a snapshot or change
  set (`413 sync-too-large`). Raise it for workspaces with large attachments.
- Repository hooks never run. A push builds its commits in a private index file under
  `<data dir>/tmp/`. Leftovers from a crash are removed at start-up.
- On shutdown the server finishes the repository work already queued before it closes the database.
  Run **one** replica: the per-workspace lock is in-process.

## Live updates

`GET /api/v1/live` is a WebSocket, and `/api/v1/meta` lists `live` among its capabilities. The app opens one
per signed-in account while a workspace from this server is open, sends its device token as the first message
(never in the URL or a header), and subscribes to the open workspaces. The server then tells it when someone
pushes, when a role or access changes, and when its session ends, and who else has each workspace open
(display names and user ids, never emails). The app answers every event with an ordinary fetch, so the HTTP
API stays the source of truth; while connected, it polls only every five minutes as a safety net.

- The hub lives in the server process and stores nothing. Run **one** replica: a second would miss the
  first's events. Clients still converge through the safety-net poll.
- A reverse proxy must forward `Upgrade` and `Connection` for `/api/v1/live`. With nginx:

  ```nginx
  location /api/v1/live {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  ```

  A proxy that strips them leaves the app polling at the user's interval with a _Reconnecting…_ dot on the
  Sync badge. The server pings every socket every 30 s and drops one that does not answer, which also keeps
  an idle connection inside a proxy's read timeout (nginx's `proxy_read_timeout` defaults to 60 s).

- Limits: a client message is at most 4 KiB, one session subscribes to at most 200 workspaces, one user holds
  at most 32 sockets, and a socket that does not authenticate within 10 s is closed. An upgrade whose
  `Origin` is not `WIREBENCH_SERVER_PUBLIC_URL` is refused with `403 live-origin-refused`; the app sends
  none.
- On shutdown every socket closes with `1001` before in-flight requests drain, and the app reconnects when
  the server is back.

## Webhook capture

A workspace's editors create **catch URLs**. Each one is a public address,
`<WIREBENCH_SERVER_PUBLIC_URL>/hooks/<secret>[/<anything>]`, that stores every request sent to it for
the workspace's members to read in the app. `/api/v1/meta` reports `hooks` with `enabled` and the
limits below. The management routes live under `/api/v1/workspaces/:workspaceId/hooks`: viewers read,
editors and admins create, change, rotate, clear and delete.

- **The public route takes any method and any content type.** It answers with the catch URL's configured
  response, `404` for an unknown or disabled secret, `413` past the body limit, `415` for a
  syntactically invalid `Content-Type` header (nothing is stored), `429` with `Retry-After: 1`
  past the rate limit, or `503` with `Retry-After: 30` when the capture could not be stored. Senders
  read that as "retry later". A `GET` or `HEAD` request's body is never parsed, so its capture stores
  an empty body.
- **A reverse proxy must forward `/hooks/`** with every method, the request body and the client's
  address, as it forwards `/api/v1/`. With nginx:

  ```nginx
  location /hooks/ {
      proxy_pass http://127.0.0.1:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      client_max_body_size 32m;
  }
  ```

- **Storage is bounded.**
  - Each catch URL keeps its newest `WIREBENCH_SERVER_HOOKS_KEEP` captures.
  - A sweep every ten minutes deletes captures older than `WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS`.
  - A body is stored up to `WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB`; the rest is counted but not kept.
  - A workspace holds at most `WIREBENCH_SERVER_HOOKS_PER_WORKSPACE` catch URLs.
- **The rate limit is per catch URL and per process**: `WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND` tokens a
  second, up to `WIREBENCH_SERVER_HOOKS_BURST`. Run **one** replica, as for live updates.
- **The secret stays out of logs.** Request logs show `/hooks/[redacted]`.
- **Behind a proxy with `WIREBENCH_SERVER_TRUST_PROXY`**, the server's usual `x-request-id` handling
  applies on catch URLs too: a proxy-supplied id may be echoed back. Nothing from the request body or
  headers is ever echoed.
- **Turning it off:** `WIREBENCH_SERVER_HOOKS_ENABLED=false` registers neither the public route nor the
  management routes, and the app hides its Webhooks node. The age sweep keeps running, so captures
  already stored still expire.
