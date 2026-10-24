# Wirebench Hosted Edition: the browser client, the local agent and a multi-tenant server — design

Date: 2026-10-24 · Status: **architecture only** — approved scope is the design, not a build plan (owner,
2026-10-24, popup); the 2026-10-15 ruling stands that the hosted edition starts after ten self-hosted paying
customers · Issue: none yet · Module ids: `host-seam`, `browser-client`, `local-agent`, `tenancy`,
`operations`, `domains`, `control-plane`, `custom-domains`

- Intent: `docs/intent/wirebench-server-teams.md` (roles and sign-in for people without git hosting) extended
  to people without an install: the same workspaces, teams and policies, reached from a browser tab.
- Builds on: `docs/specs/2026-09-24-wirebench-server-capability-map.md` (every server module this
  changes), `2026-09-24-wirebench-server-host-design.md` (one process, one instance, one PostgreSQL),
  `2026-09-24-wirebench-server-identity-design.md` (device tokens, OIDC and the desktop sign-in),
  `2026-09-24-wirebench-server-teams-access-design.md` (teams, workspaces, grants),
  `2026-09-24-wirebench-server-sync-design.md` (bare repositories, three-way merge on the client),
  `2026-09-26-wirebench-server-live-updates-design.md` (the socket and the in-process hub),
  `2026-10-01-wirebench-server-licensing-design.md` and `2026-10-05-wirebench-license-binding-design.md`
  (editions, one license per server), `2026-10-13-wirebench-server-scheduled-runs-design.md` (the server
  already sends: sealed secrets, empty system scope, no secret sources on the server), ADR-0004 (secrets
  never enter a file, a log or an IPC response), ADR-0016 (scripts are capability-free), ADR-0028 (the
  server is under the Elastic License 2.0; a hosted offering is reserved to the project), ADR-0030 (package
  boundaries are checked at the boundary).
- Decisions taken with the owner on 2026-10-24 (popup):
  1. **Architecture only.** This document fixes the shape; no slice is scheduled, no issue is opened, and
     nothing here moves the 2027 trigger for the hosted edition.
  2. **Tenancy is a shared schema with a tenant column** on every table, not one server process per
     customer. §5.4 records the trade-off and the guards that make it safe.
  3. **The browser client sends both ways from the first version**: through the server by default, through
     a local agent when one is paired. §3.4 fixes the rule that picks one so there is never a third path.
  4. **No domain is owned yet.** The design uses `<app-domain>` and `<site-domain>` as placeholders; §3.7
     lists what to register and why two names. `wirebench.com` is registered to someone else;
     `wirebench.io`, `.dev`, `.app` and `.cloud` are registered; `wirebench.co` answered "domain not found"
     to whois on 2026-10-24.
  5. **Team secrets are agent-only in the browser** (second popup, after the builder check). A send that
     needs a team secret is routed to the paired agent, which has its own approved machine key; the server
     host never holds a team-secret key. Without an agent the send fails with a reason.
  6. **The agent pairing supports Chrome, Edge and Firefox in the first version** (same popup). Safari
     blocks a plain loopback socket from an `https` page; Safari users use the desktop app. A locally
     trusted certificate on loopback is a later option; a relay through the server is not taken, because
     private-target traffic must never pass through the hosted server.

## Assumptions I'm making

1. **The renderer stays one codebase.** `apps/desktop/src/renderer` imports nothing from `electron`, `node:*`
   or `../main` today, and reaches main only through `window.wirebench`, which
   `apps/desktop/src/preload/build-api.ts` builds from the channel registry given an injected `invoke` and
   `on`. The browser client is that renderer built by Vite with a different pair injected. If a renderer
   import of Node or main ever appears, the import-graph gate of ADR-0030 refuses it.
2. **Main becomes a package, not a copy.** `apps/desktop/src/main` (about 65 000 lines, 37 of 269 files
   importing `electron`) moves to `packages/host` as `@wirebench/host`, with Electron reached through one
   injected interface (§5.1). The Electron app, the local agent and the server each embed that package. No
   handler is rewritten for a second host; this is the "without duplicating the code" of the request.
3. **The server keeps one process type.** Hosted and self-hosted run the same `wirebench-server` image. A
   self-hosted installation is one tenant, created by the first migration, whose slug nothing ever shows.
   `WIREBENCH_SERVER_MODE=hosted` loads the `control-plane` module; it is never loaded otherwise.
4. **PostgreSQL stays the only store and gets row-level security.** Every tenant-scoped query runs inside a
   transaction that has set the tenant, and the database refuses rows of another tenant even when a query
   forgets its `where`.
5. **Bare repositories stay on a volume**, now under a tenant directory. Object storage is an operations
   question for later, not part of this design.
6. **Prices, editions and who sells are settled**: Team and Enterprise seat prices as decided 2026-10-15,
   Verathic sells, Community stays free. The hosted edition adds a way to pay, not a new price list.
7. **No model runs in the hosted edition either.** The 2026-10-15 AI stance applies unchanged.
8. **The desktop app keeps working exactly as today** for people who never open a browser tab: same
   channels, same files, same `safeStorage`. The agent is the desktop app's main process without a window,
   not a different program.

→ Correct any of these and the design changes accordingly.

---

## 1. Objective

**What.** Wirebench reachable from a browser tab at `https://<team>.<app-domain>`: the full renderer, signed
in to a team on a Wirebench Server that serves many customers from one deployment. Requests go out either
from the server (nothing to install) or from a local agent (the desktop app, or a headless build of its main
process) when the request needs the machine: a private target, SSH, Kerberos, a keystore, a secret source.
Every customer is a tenant with its own slug, data, license, audit chain and rate limits, in one PostgreSQL
schema guarded by row-level security.

**Why.** Two of the three wedges of the 2026-10-15 strategy end at an install prompt: a team pushed off a
free plan wants a link, not an installer, and a security office that will not run a server wants someone
else to run it. ADR-0028 reserved the hosted offering to the project; this is the design of that offering.
It is written now so that every slice that also serves self-hosted teams (the host seam, the browser
client, the agent, team slugs) is built in a shape the hosted edition can use without a rewrite.

**Who.** A team member in a browser (most of the day), a workspace admin (settings, policies, billing), a
Verathic operator (tenants, licenses, incidents), and the three programs that embed the host package.

**Not.** A mobile app, offline use of the browser client, a public API marketplace, custom code running on
the server beyond the capability-free script sandbox, or a second renderer.

## 2. Concept model

| Term | Meaning |
| --- | --- |
| **Host** | A program that runs `@wirebench/host`: the channel handlers that were the Electron main process. Three exist: the **Electron host** (the desktop app), the **agent host** (the desktop app's main process without a window, or `wirebench agent`), the **server host** (one host instance per signed-in browser user inside `wirebench-server`). |
| **Caller** | What a handler sees instead of `WebContents`: an id, a `send(event, payload)` and a close signal. An Electron window, a paired browser tab over the agent socket, or a browser tab over the server socket. |
| **Capability** | A channel group the host can serve: `files`, `keychain`, `ssh`, `pty`, `kerberos`, `dialogs`, `send:private`, `send:public`, `secret-sources`, `updates`, `app-lock`. Each host declares its set; the renderer asks once per connection. |
| **Send route** | Which host sends one request: `server` or `agent`. Chosen per send by the rule in §3.4, shown on the response. |
| **Tenant** | One customer on the hosted server: a slug, an edition, a data directory, a license or subscription, an audit chain. Every team, user, workspace and row belongs to exactly one tenant. Self-hosted has exactly one. |
| **Tenant host name** | `https://<slug>.<app-domain>`. The slug is the tenant's; `app.<app-domain>` is the neutral entry that only redirects. |
| **Sealed secret** | A secret value written to the server once, encrypted under a per-tenant key, never readable back by any API, resolved only inside a server-side send. The scheduled-runs module already has this shape per schedule; the server host generalises it per workspace and per user. |
| **Pairing** | The one-time handshake that lets a browser tab at a tenant host name talk to the agent on the same machine. |
| **Control plane** | The `control-plane` server module: tenants, signup, slugs, subscriptions, suspension, export, deletion, the operator command line. Loaded only in hosted mode. |

## 3. Behaviour

### 3.1 One renderer, three hosts

- The Electron app behaves as today. Its preload builds `window.wirebench` over `ipcRenderer`.
- The browser client is the same renderer, built by Vite into static files served by the server at the
  tenant host name. Its `window.wirebench` is built over one WebSocket to the server host
  (`wss://<slug>.<app-domain>/api/v1/host`) and, when paired, a second WebSocket to the agent
  (`ws://127.0.0.1:<port>/host`). The two sockets carry the same wire: `{ id, channel, request }` in,
  `{ id, ok, value | error }` out, and `{ event, payload }` pushed. Channel names, request and response
  schemas and the `IpcResult` envelope do not change; `apps/desktop/src/shared/ipc.ts` is the contract for
  both sockets as it is for IPC today.
- `window.wirebench.env` grows `host: 'electron' | 'browser'` and `capabilities` (§2), read once at
  connection. The renderer hides what the connected hosts cannot do (no *Reveal in Finder* without `files`,
  no SSH area without `ssh`) with the same area and feature switches it uses today (`app.areas`,
  `app.features`), so no component checks the host directly.
- A channel the renderer calls that neither host serves answers `{ ok: false, error: { code:
  'host-capability-missing', details: { capability } } }`, and the renderer's existing error surface shows
  it. Nothing hangs.

### 3.2 Sign-in from a browser

- A person opens `https://<slug>.<app-domain>`. Without a session the server shows the sign-in page the
  identity module already renders for invitations, with the tenant's enabled methods: local password, OIDC,
  SAML. OIDC and SAML run as browser redirects with server-held state, the same rows as the desktop's
  flows (`oidc_flows`, `saml_flows`) minus the loopback port.
- A browser session is a cookie: `__Host-wb_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the
  tenant host name by the `__Host-` prefix, so a session on `acme.<app-domain>` is unreadable at
  `other.<app-domain>`. The cookie names a row in `device_tokens` with `kind = 'browser'`; the identity
  guard accepts a bearer token (desktop, CLI, agent) or the cookie. Idle and maximum ages follow
  `WIREBENCH_SERVER_TOKEN_IDLE_DAYS` and `_MAX_DAYS`.
- `app.<app-domain>` asks for an email, looks up which tenants the address belongs to, and redirects to the
  one tenant or shows the list. It never signs anyone in itself and sets no cookie.
- Signing out revokes the row, as the desktop's *Sign out* does. A server admin disabling a user ends the
  live socket and the host socket with the same close code the live-updates module uses (`4401`).

### 3.3 Workspaces in the browser

- Only **server-kind workspaces** open in the browser (my call): no git-kind workspace, no local folder,
  nothing that needs a git binary or credentials on the server host. A project a browser user creates
  lives inside a server workspace.
- The server host opens a workspace exactly as the desktop opens a server workspace: through the sync
  design's `ServerClient` (head, snapshot, changes, commits, log) with the working copy at
  `<dataDir>/tenants/<tenantId>/checkouts/<userId>/<workspaceId>/` and the snapshot and pending commits
  in the user's `state/`, where the desktop keeps them in app data. The one difference is the client: an
  in-process `ServerClient` that calls the sync module's service functions directly as the signed-in user,
  with the same role checks, instead of HTTP to itself. There is no git on the server host, as there is
  none on the desktop for a server workspace. The handlers that read and write project files run
  unchanged on that working copy.
- Per-machine state the desktop keeps under `userData` (preferences, layouts, history, cookie jars,
  current values, the HTTP log, the sync snapshot) lives under the user's checkout parent,
  `<dataDir>/tenants/<t>/checkouts/<user>/state/`, in the same files the desktop writes. The files the
  desktop keeps behind `safeStorage` (OAuth tokens, cookie jars with credentials, passphrases) go through
  the server platform's `secrets` (§3.5), which encrypts them under the tenant data key; the file layout
  is the desktop's, the cipher is the platform's. One person has one browser state per tenant, whichever
  machine they open the tab on. When a paired agent is present, history and cookie jars of sends the
  agent made stay on the agent, and the renderer shows both lists merged with a host column; nothing is
  copied between hosts.
- A host instance is created when a user's first host socket connects and evicted after an idle period
  (default 30 minutes, `WIREBENCH_SERVER_HOST_IDLE_MINUTES`); its checkouts stay on disk. A tenant's
  checkouts are deleted with the tenant (§3.6).
- Live updates reach the browser client through the existing live socket, unchanged; the host socket does
  not duplicate them.

### 3.4 Where a request is sent from

The rule, applied per send and shown as `sentFrom: 'server' | 'agent'` on the exchange:

1. If the request needs a capability only the agent has — a target that resolves to a loopback, link-local
   or private range, an `${#System#…}` reference, a secret source, a **team secret** (decision 5), a
   keystore on a machine path, Kerberos, NTLM with a machine credential, or a cookie jar held by the agent
   — and an agent is paired, the **agent** sends. If no agent is paired, the send fails with
   `send-needs-agent` naming the capability, and the renderer offers pairing.
2. Otherwise the **server** sends, unless the person pinned the workspace or the request to `agent` (a
   preference in the browser state, shown as a chip on the send button).
3. A server-side send never resolves `${#System#…}` (empty, as scheduled runs), never reads a secret
   source, and resolves secrets only from sealed values (§3.5). A secret with neither fails the request with
   `secret-missing`, as the runner does.

The engine's one send path (`2026-10-01-wirebench-one-send-path-design.md`) is what both hosts call; the
rule chooses the host, not a code path.

**What the agent receives** (my call). The workspace's files are on the server host, including edits the
browser has not committed. For an agent send, the server host materialises a *send bundle*: the request
item, every script in its folder chain, the project's and the active environment's non-secret values, the
cookie-jar policy, and secret references by name only. The bundle is the subset of project files the CLI
runner reads to send the same request from a folder, in the same shapes, so the agent runs the one send
path on it with nothing new: scripts, auth chains and assertions run on the agent; `${#System#…}`, secret
sources, team secrets, keystores and Kerberos resolve there; the exchange is recorded in the agent's
history. The response and the assertion results return to the browser over the agent socket. The agent
does not open the workspace, sync it, or keep a second working copy; there is one working copy, on the
server host.

### 3.5 Secrets in the browser

- ADR-0004's rule holds inside each host: a value lives in the host's secret store and is resolved at the
  moment of use, in the host. The renderer never reads one back.
- The **agent's** store is `safeStorage` as today.
- The **server host's** store has two parts, both under a per-tenant data key that is itself wrapped by
  the deployment's root key (`WIREBENCH_SERVER_SECRETS_KEY`, a KMS key in production), with the secret-box
  helper of webhook-signatures and scheduled runs as the cipher:
  - `HostPlatform.secrets` for the server platform encrypts and decrypts the blobs the desktop keeps
    behind `safeStorage` (`secrets.json`, OAuth tokens, cookie jars, passphrases), stored as files in the
    user's `state/` (§3.3). This is what makes the desktop's secret-resolver, OAuth and cookie code run
    unchanged on the server host.
  - **Sealed secrets** are the named, write-only values a server-side send may resolve:
    `tenant_secrets(tenant_id, scope, owner_id, name, sealed, created_at)` with
    `scope ∈ { user, workspace }`. A user writes `user` scope; a workspace admin writes `workspace` scope;
    `user` wins over `workspace` for the same name (my call). The desktop's `secrets.*` channels on the
    server host write sealed rows instead of `safeStorage` entries, so the renderer's Secrets UI is
    unchanged. Nothing held on a desktop is migrated; a value used in the browser is entered once there.
- A workspace's team secrets (`2026-09-26-team-secrets-design.md`) keep their design: encrypted in the
  repository to each **approved machine's** key, an admin approving every machine. A browser session is not
  a machine, so the server host never holds a team-secret key and never decrypts one (decision 5). A send
  that needs a team secret is routed to the paired agent (§3.4), whose machine key is approved as any
  desktop's; in the browser the Secrets page shows such values as "resolved on the agent".
- The Settings page states plainly which host holds which secret, and the audit log records every sealed
  write and every server-side resolution by name, never by value.

### 3.6 Tenants

- **Create.** Hosted signup (`https://<site-domain>/signup`, served by the control plane): email, team name,
  chosen slug, then email verification, then the tenant exists with one user who is server admin of that
  tenant, Community edition, five enabled accounts. An operator can create a tenant by command line for a
  sales-led deal.
- **Slug.** 3–40 characters, `[a-z0-9-]`, not starting or ending with `-`, unique, never reused after
  deletion, and not on the reserved list (`app`, `api`, `www`, `docs`, `status`, `admin`, `agent`, `mail`,
  `help`, `support`, `billing`, `login`, `signup`, every protocol and area name the app has). Changing a
  slug keeps the old one as a redirect for 30 days.
- **Edition.** `tenants.edition` is what `requireFeature(...)` reads in hosted mode. A subscription sets
  it; the license file route stays for self-hosted and is refused with `licensing-hosted` in hosted mode.
  Seat counting is the licensing module's, per tenant.
- **Suspend.** Unpaid past the grace period or at the operator's command: sign-in refused with a page that
  says why, schedules paused, catch URLs answer `503`, data kept. Nothing is disabled or deleted.
- **Export.** A tenant admin can request an export: every workspace as a git bundle, every non-secret
  table as newline-delimited JSON, delivered as a signed download link that expires. Sealed secrets are
  never exported.
- **Delete.** Requested by a tenant admin, held 14 days, then the tenant's rows, checkouts, repositories
  and sealed secrets are removed in one job, and the audit chain's last anchor is kept with the deletion
  event. The slug stays reserved.

### 3.7 Names on the wire

- `<site-domain>`: the marketing site, docs, signup, status. Public, cookie-free.
- `<app-domain>`: a second registrable domain for the product. `app.<app-domain>` is the neutral entry;
  `<slug>.<app-domain>` is each tenant; `api.<app-domain>` is reserved for the CLI and the MCP server
  talking to a tenant by `Host` header or by `/t/<slug>/` prefix.
- Two names because a cookie or a storage key set on the app domain must never be readable by a page on
  the site, and because the app domain is submitted to the public suffix list once stable, so that
  `acme.<app-domain>` and `other.<app-domain>` are separate sites to every browser, extension and
  password manager. The `__Host-` prefix protects the session before that listing exists.
- An Enterprise tenant may bring a custom name (`wirebench.example.com`) by CNAME and a TXT verification,
  reusing the domain-verification shape of the SAML and SCIM module; the certificate comes from the
  deployment's automatic issuance. Not in the first hosted slice.
- The agent is never on a public name. It listens on `127.0.0.1` only.

### 3.8 Pairing the agent

- The browser client offers *Pair this machine* when a send needs the agent (§3.4) or from Settings. The
  page shows a six-character code. The person opens the desktop app (or runs `wirebench agent pair`) and
  types the code; the agent connects to the tenant's server once, exchanges the code for a pairing
  record (`agent_pairings(tenant_id, user_id, agent_id, public_key, created_at, last_seen)`) and receives
  the tenant host name as its allowed origin.
- From then on the browser client opens `ws://127.0.0.1:<port>/host` with an `Origin` the agent checks
  against its allowed list, signs the first message with a session nonce the server issued, and the agent
  verifies the nonce against the server before serving a single channel. A page on any other origin gets
  the socket closed before the first reply. The agent answers the private-network preflight browsers send
  for loopback targets from a secure page.
- The pairing's public key is the agent's, generated at first pairing and kept in `safeStorage`. Unpairing
  from either side deletes the record; the agent refuses the next connection.
- **Browsers** (decision 6): Chrome, Edge and Firefox, which allow a secure page to open a plain socket to
  `127.0.0.1` as a potentially trustworthy origin; the agent answers Chrome's local-network preflight and
  the pairing page explains the permission prompt where a browser shows one. Safari refuses the socket, so
  the pairing page tells Safari users to use the desktop app. A locally trusted certificate on loopback,
  installed at pairing, is the later option that would admit Safari; it is not in the first version.
- The desktop app, with a window open, is the agent for its own machine without a second process: pairing
  is a menu item.

### 3.9 Team and workspace behaviour that does not change

Teams, workspaces, roles, invitations, policies (ADR-0029), SCIM, SAML, the audit log, catch URLs, schedules
and CI tokens keep their behaviour inside a tenant. What changes is only that every row has a tenant and
every uniqueness rule (team name, slug, catch URL secret, CI token) is per tenant.

### 3.10 What the server host serves

The server host runs the desktop's handlers on the project's machines, so the question is not which
handlers exist but which are registered there. The server platform's capability set decides, group by
group (my call; the builder keeps this table current as channels are added):

| Channel group | Server host | Why |
| --- | --- | --- |
| `project`, `workspace`, `request`, `sequence`, `runner`, `script`, `search`, `snapshot`, `globals`, `current-values`, `history`, `exchanges`, `cookies`, `preferences`, `theme`, every protocol kind's editors | served | Pure functions over the working copy and the user's `state/`. |
| `sync`, `account`, `team`, `team-secrets` (refs only), `license`, `audit`, `hooks`, `schedules`, `ci-tokens`, `issued-tokens`, `provisioning` | served, in-process | The server host calls the server's own services as the user; no HTTP to itself. |
| `secrets` | served as sealed secrets | §3.5. |
| `oauth2`, importers, `api` (definition fetch), `certificates` (expiry probe) | served under the egress rule | Every outbound connection the server host makes, not only a send, passes the §6 rule. |
| `fs`, `local-fs`, `dialogs`, `git`, `keystores` by path, `ssl` with machine files, `secret-sources`, `secret-scan` of local folders | not registered | Need a machine. The renderer hides them by capability; a request to one answers `host-capability-missing`. |
| `mock` (a listener), `plugins` (third-party code), MCP stdio servers, the local terminal, every SSH and serial channel, `app-lock`, updates | not registered | A port, a process or a device on the project's machine; never from a browser tab. |

Path arguments on every served channel are resolved by the server platform's `paths` against the user's
checkout root, and a path that escapes it (`..`, an absolute path, a symlink out) is refused with
`host-path-outside-workspace` before any file is touched. The platform exposes no other directory.

## 4. Data model and storage

### 4.1 The tenant column

Every one of the 33 existing tables except `schema_migrations` and `server_identity` gains
`tenant_id uuid not null references tenants(id)`, filled by the migration with the single self-hosted
tenant's id. Composite uniqueness replaces per-server uniqueness: `teams (tenant_id, lower(name))`,
`users (tenant_id, lower(email))`, `catch_urls (tenant_id, secret)`, and so on, one index per rule the
earlier specs state. `license` becomes one row per tenant. The audit chain anchor is per tenant, so a
tenant's export verifies on its own. Two identity columns change for the browser flows: `device_tokens`
gains `kind text not null default 'device'` (`device` | `browser`), and `oidc_flows.loopback_port`
becomes nullable, null for a browser redirect flow.

```sql
create table tenants (
  id          uuid primary key,
  slug        text not null unique,
  name        text not null,
  edition     text not null default 'community',   -- community | team | enterprise
  status      text not null default 'active',      -- active | suspended | deleting
  seats       integer,                              -- null = edition default
  data_key    bytea not null,                       -- wrapped per-tenant secrets key
  created_at  timestamptz not null default now(),
  deleting_at timestamptz
);
create table tenant_slugs_retired (slug text primary key, tenant_id uuid not null, retired_at timestamptz not null);
```

### 4.2 Row-level security

```sql
alter table teams enable row level security;
create policy tenant_isolation on teams
  using (tenant_id = current_setting('wirebench.tenant_id')::uuid);
```

The same two statements for every tenant-scoped table, generated by one migration from the table list.
The server's pool wrapper runs every request inside `begin; set local wirebench.tenant_id = $1; …` with
the tenant the request resolved (§5.3); a query outside a tenant transaction sees no rows. The control
plane connects as a second database role that bypasses the policies, used only by its own module.

### 4.3 Hosted-only tables

`tenant_secrets` (§3.5), `agent_pairings` (§3.8), `subscriptions(tenant_id, provider, provider_ref,
plan, seats, status, current_period_end)`, `tenant_exports(tenant_id, requested_by, status, url, expires_at)`,
`signups(email, token_hash, slug, name, expires_at)`. All carry `tenant_id` where one exists and live under
the same row-level security.

### 4.4 On disk

```
<dataDir>/tenants/<tenantId>/
  repos/<workspaceId>.git           # moved from <dataDir>/repos by the tenancy migration
  checkouts/<userId>/<workspaceId>/ # the server host's working trees (§3.3)
  checkouts/<userId>/state/         # the user's per-tenant browser state
  tmp/
```

The repo store's path function takes a tenant; nothing else about it changes. Self-hosted installations
are moved by the migration once, with a `tenants/<id>` directory whose id is the single tenant's.

## 5. Architecture

### 5.1 `@wirebench/host`: one package, three programs

```
packages/host/                      # today: apps/desktop/src/main
  src/platform.ts                   # the injected interface, below
  src/ipc/register.ts               # registerHandler(channel, (request, caller) => …)
  src/ipc/events.ts                 # emitEvent(caller, event, payload)
  src/… (every service, unchanged)
apps/desktop/src/main/index.ts      # Electron: platform = electron-platform.ts, callers = windows
packages/agent/                     # headless: platform = node-platform.ts, callers = paired sockets
packages/server/src/host/           # server host: platform = server-platform.ts, callers = browser sockets
```

The interface the 37 Electron-importing files are rewritten against, and nothing else is:

```ts
export interface HostPlatform {
  readonly paths: { userData(): string; temp(): string; logs(): string };
  readonly secrets: { encrypt(plain: Buffer): Buffer; decrypt(sealed: Buffer): Buffer; available(): boolean };
  readonly dialogs?: { openFile(opts): Promise<string[]>; saveFile(opts): Promise<string | undefined>; message(opts): Promise<number> };
  readonly shell?: { openExternal(url: string): Promise<void>; reveal(path: string): Promise<void>; trash(path: string): Promise<void> };
  readonly app: { version(): string; packaged(): boolean; quit(): void; osTheme(): 'dark' | 'light' };
  readonly capabilities: ReadonlySet<Capability>;
}
```

`dialogs` and `shell` are optional: the server platform omits them and the handlers that need them are
registered only when present (the capability set says so to the renderer). Every `app.getPath`, `dialog`,
`shell`, `safeStorage`, `nativeTheme` and `BrowserWindow` call in main becomes a call on this interface.
`window-scope.ts` keys per-caller services by `caller.id` instead of `webContents.id`.

### 5.2 Transports

- **Electron**: unchanged, `ipcMain.handle` bound by `register.ts` with the window as caller.
- **Agent**: `ws` server on `127.0.0.1`, one caller per paired socket, origin and nonce checked (§3.8),
  frames as in §3.1. `wirebench agent` in the CLI starts it headless; the desktop app starts it in-process.
- **Server**: `@fastify/websocket` route `/api/v1/host` next to `/api/v1/live`, authenticated by the cookie
  at upgrade, one caller per socket, routed to the user's host instance (§3.3) by `(tenantId, userId)`.

The envelope (`wrapHandler` in `ipc/envelope.ts`) already has no Electron import and validates both
directions; the three transports call it with a caller. The browser client's `buildApi` gets an `invoke`
that picks the socket by the channel's capability (the renderer never names a host) and an `on` that
subscribes on both.

### 5.3 Tenant resolution in the server

One `onRequest` hook before identity's guard: the `Host` header's first label, or the `/t/<slug>/` prefix
on `api.<app-domain>`, or the single tenant in self-hosted mode, looked up in a small in-memory map
refreshed on change, then `request.tenant` set and the request's transaction opened with the tenant
(§4.2). A slug that does not exist answers `404` with no body that names anything. Identity, teams, sync,
live, hooks, schedules, licensing and audit read `request.tenant` where they read `ctx` today; their
repositories take the tenant as the first argument so a call without one does not compile.

### 5.4 The tenancy trade-off, recorded

The owner chose a shared schema over one server process per tenant. What that buys: one deployment, one
database, cheap idle tenants, one upgrade. What it costs: every query is a place where a missing filter
leaks a row across customers, and every server module has a repository file full of them. The guards that
make the choice safe, all required, none optional:

1. Row-level security on every tenant-scoped table (§4.2), so a missing filter returns nothing rather
   than everything.
2. A repository signature that takes a `TenantScope` first, so a call site cannot forget it.
3. A migration test that fails when a table exists without `tenant_id` and a policy, unless it is on the
   two-name allowlist.
4. An integration test per module that creates two tenants, writes in one, reads as the other through
   every route, and expects nothing.
5. The live hub, rate limiters, schedule concurrency and the repo store keyed by tenant first.

The alternative, one process per tenant behind a router, is not taken; it would have left the existing code
untouched at the price of a process per idle customer and two deployment shapes. Recorded in ADR-0032.

### 5.5 Multiple instances

The live hub and the per-workspace lock are in-process by the host design. Hosted needs at least two
instances behind a load balancer. The hub gains PostgreSQL `LISTEN`/`NOTIFY` fan-out (one channel,
payload `tenantId:workspaceId:event`), the per-workspace lock becomes the advisory lock the host design
named as the upgrade path, and the host socket is sticky by `(tenantId, userId)` through a cookie the
balancer honours, because a host instance is an in-memory object on one node. The data directory,
checkouts and `state/` included, is **one volume shared read-write by every instance** (my call), so a
user bounced to another node finds the same working copy and state; what the advisory lock protects is
rows, never the filesystem, and the per-user host instance is the only writer of its own checkout while
it lives. Scheduled runs are already leased per run; the lease gains the tenant.

### 5.6 The control plane

A server module, `packages/server/src/control-plane/`, loaded only when `WIREBENCH_SERVER_MODE=hosted`:
signup pages and routes, slug rules, the subscription webhook from the payment provider (the provider is
left to the builder; the module speaks `subscription.created|updated|deleted` and nothing provider-specific
beyond the webhook verifier), edition changes, suspension, export and deletion jobs, and
`wirebench-server admin tenant …` on the box. It owns `tenants`, `subscriptions`, `signups`,
`tenant_exports` and the retired slugs. It uses the bypass database role (§4.2) and nothing else does.

## 6. Security

- **Isolation.** Row-level security, per-tenant data keys, per-tenant directories rooted by a path
  function that refuses `..` and symlinks (the path-safety rules of the sync design), per-tenant audit
  chains, per-tenant rate limits on sign-in, hooks and sends.
- **Egress from the server host.** A server-side send is a request from the hosting network. The server
  refuses targets that resolve to loopback, link-local, private ranges and cloud metadata addresses, after
  resolution, on every redirect, for every protocol (the SSRF rule). Enterprise tenants may allowlist
  private targets on a tenant policy; the default allows none. The agent exists for those targets.
- **Scripts on the server** run in the capability-free sandbox of ADR-0016 with a per-tenant CPU and
  memory budget and the same empty system scope as scheduled runs.
- **Sessions.** `__Host-` cookie, `SameSite=Lax`, an `Origin` check on every mutating route and on both
  WebSocket upgrades, no token in a URL ever.
- **The agent** listens on loopback only, serves one allowed origin per pairing, verifies a server-issued
  nonce before the first channel, and never exposes `ipcRenderer`, a shell or a file path outside what the
  channel contract already allows the renderer.
- **Secrets.** ADR-0004 per host; sealed values write-only; team-secret keys live in the browser session's
  memory only; exports carry no secret; deletion wipes sealed rows and the tenant data key.
- **No telemetry.** The hosted edition's own operations metrics (§8) name tenants by id, never request
  content, and the no-telemetry promise of the product is unchanged for self-hosted.
- **Compliance surface.** A data-processing agreement, a sub-processor list, EU hosting by default, the
  audit chain's export for a customer's auditor; the SOC 2 path the roadmap names.

## 7. Tech stack

Nothing new in kind: TypeScript, Fastify, `@fastify/websocket`, `ws`, PostgreSQL 16 with row-level
security, Vite for the browser build, the engine for every send. New runtime dependencies are confined to
the control plane (a payment provider SDK or a plain webhook verifier) and are listed in the licences test
before they are added. The agent is the existing CLI package with `@wirebench/host` as a dependency;
`node-pty` and the SSH binding ship per platform as the desktop ships them.

## 8. Commands

| Command | Does |
| --- | --- |
| `wirebench agent` | Starts the headless agent on `127.0.0.1`, prints the port, waits. |
| `wirebench agent pair <code>` | Pairs with the tenant the code names; stores the pairing. |
| `wirebench agent unpair [tenant]` | Removes a pairing. |
| `wirebench-server admin tenant create --slug --name --email` | Sales-led tenant creation. |
| `wirebench-server admin tenant set-edition <slug> <edition>` | Operator override, audited. |
| `wirebench-server admin tenant suspend\|resume\|export\|delete <slug>` | Lifecycle. |
| `wirebench-server admin tenant migrate-self-hosted` | Imports a self-hosted database and data directory as one new tenant. |

## 9. Project structure (new or changed)

```
packages/host/                              # from apps/desktop/src/main; HostPlatform
packages/agent/                             # ws host, pairing, CLI entry
apps/desktop/src/main/index.ts              # electron-platform, windows as callers
apps/desktop/src/preload/build-api.ts       # unchanged; a browser-bootstrap.ts sibling builds over sockets
apps/desktop/vite.browser.config.ts         # the static browser build the server serves
packages/server/src/tenancy/                # tenant resolution, RLS pool wrapper, migration
packages/server/src/host/                   # the server host: instances, checkouts, /api/v1/host
packages/server/src/control-plane/          # hosted mode only
packages/server/migrations/tenancy/         # tenants, tenant_id everywhere, policies, repo move
docs/adr/0032-…                             # the tenancy decision
docs/adr/0033-…                             # one host package, three programs
```

## 10. Slices

No slice is scheduled (owner, 2026-10-24). The order is the dependency order, and the first three serve
self-hosted teams on their own, which is why they would come first whenever the trigger fires.

| Slice | Module id | Delivers | Depends on | Serves self-hosted alone? |
| --- | --- | --- | --- | --- |
| 1 | `host-seam` | `@wirebench/host` with `HostPlatform` and `Caller`; the Electron app embeds it; the desktop serves its own renderer on loopback behind the socket transport as proof | — | yes (no user-visible change) |
| 2 | `browser-client` | The Vite browser build, `browser-bootstrap.ts`, capability discovery, cookie sign-in on the self-hosted server, the server host with checkouts and per-user state, server-side sends with sealed secrets and the egress rule | 1 | yes: a self-hosted team gets a browser tab |
| 3 | `local-agent` | `packages/agent`, pairing, the send-route rule, `wirebench agent` | 1, 2 | yes |
| 4 | `tenancy` | `tenants`, `tenant_id` on every table, row-level security, tenant resolution, per-tenant directories, the five guards of §5.4, the self-hosted migration | 2 | yes, invisibly (one tenant) |
| 5 | `operations` | `LISTEN`/`NOTIFY` hub fan-out, advisory locks, sticky host sockets, per-tenant budgets, metrics by tenant id | 4 | partly (multi-instance self-hosted) |
| 6 | `domains` | The two registrable names, wildcard certificates, `app.` redirect, reserved slugs, public suffix submission, `api.` routing | 4 | no |
| 7 | `control-plane` | Signup, subscriptions, edition from subscription, suspension, export, deletion, operator commands | 4, 5, 6 | no |
| 8 | `custom-domains` | CNAME plus TXT verification for Enterprise tenants | 6, 7 | no |

The 2026-10-15 trigger (ten self-hosted paying customers) gates slices 5 to 8. Slices 1 to 4 may be
scheduled earlier on their own merits, each with its own spec amendment and issue when that happens.

## 11. Testing strategy

- Host seam: the existing main-process unit tests run against a fake `HostPlatform`; a test builds
  `window.wirebench` over a fake socket and replays the vitest API mock's channels.
- Browser client: Playwright against the server's static build and a self-hosted server in Docker, the
  e2e rig the SSH slices already use; one spec per capability that must be hidden.
- Agent: pairing refused for a wrong origin, a replayed nonce, an unpaired agent; a send that needs the
  agent fails cleanly without one.
- Tenancy: the two-tenant integration test per module (§5.4 item 4); the migration test for missing
  columns and policies; a test that the RLS policy returns nothing outside a tenant transaction.
- Operations: two server instances against one database, a push on one seen by a live socket on the other.
- Control plane: signup to first sign-in, subscription webhook to edition, suspend to refused sign-in,
  delete to empty directories and rows, export verifies the audit chain.

## 12. Boundaries

- The renderer never imports from a host, never names a host, and never reads a secret value.
- `@wirebench/host` imports no `electron`; the import-graph gate of ADR-0030 enforces it.
- The control plane is the only module on the bypass database role, and it is never loaded outside
  hosted mode.
- The agent serves only paired origins on loopback; nothing on it is reachable from the network.
- A server-side send never reaches a private address without a tenant policy that names it.
- The hosted edition adds no price, no telemetry and no model.

## 13. Success criteria (done when all are true)

1. The desktop app runs unchanged on `@wirebench/host`, every existing test green.
2. A self-hosted team member signs in at a browser tab, opens a team workspace, sends a public request from
   the server, pairs the desktop app, and sends a localhost request through it, with `sentFrom` on both.
3. Two tenants on one hosted server cannot read, list, push to or be alerted about each other's anything,
   proven by the per-module two-tenant tests.
4. A self-hosted database and data directory import as one tenant and every workspace syncs after.
5. Signup to a working team takes under five minutes with no operator.
6. A tenant's export verifies its audit chain and restores into a self-hosted server.

## 14. Migration and compatibility

- The tenancy migration is one transaction for rows and one directory move for repositories, with the
  single tenant's id written to `server_identity` first so a crash between the two is resumable.
- Project files, `share.yaml`, the CLI, the MCP server and the desktop's channels do not change shape.
- A desktop or CLI older than the tenancy slice keeps working against a self-hosted server (single tenant,
  no slug on the wire); against a hosted tenant it needs the `api.<app-domain>` prefix, which the join
  dialog of that version does not know, so the minimum client version for hosted is the one that ships
  with slice 6.
- Licenses already issued keep working: hosted mode is never switched on for an existing self-hosted
  server by an upgrade.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| A query without a tenant filter leaks across customers | Row-level security plus the compile-time scope plus the two-tenant tests (§5.4) |
| Server-side sends make the hosting network a proxy | The egress rule in §6; private targets only by tenant policy; the agent for everything else |
| A host instance per browser user costs memory | Idle eviction, a per-tenant instance cap, measured in slice 2 before slice 4 |
| Sticky sessions and in-memory host instances complicate rolling deploys | Drain before stop; the working copy and state are on the shared volume, so the next node resumes them |
| A served channel reaches the server's disk or network beyond the workspace | The §3.10 allowlist, the checkout-rooted path guard, the egress rule on every outbound connection |
| The agent's loopback socket is reached by a hostile page | Origin allowlist per pairing, server-issued nonce, private-network preflight, loopback only |
| Sealed secrets put customer secrets on the project's servers | Per-tenant data keys under a KMS root, write-only API, audit on every resolution, said plainly in the docs and the DPA |
| The public suffix list submission is slow | `__Host-` cookies and per-origin storage protect sessions before listing |
| The Elastic License reserves hosting to the project, which is now also the host | ADR-0028 anticipated this; the control plane stays in the server package under the same license |

## 16. Open questions (bold = proposed default)

1. Which payment provider, and whether invoices for sales-led tenants are issued outside it. **Builder's
   choice behind the `subscription.*` events; invoices outside for Enterprise.**
2. Whether the server host keeps a per-user working tree or renders project files from the bare repository
   without one. **Working tree: it reuses every file handler unchanged; revisit if disk becomes the cost.**
3. The idle eviction period and the per-tenant instance cap. **30 minutes; cap at the tenant's seat count.**
4. Whether `api.<app-domain>` routes by `Host` or by prefix for the CLI. **Prefix `/t/<slug>/`, so one
   certificate and one DNS name serve every tenant for tools that do not set `Host` freely.**
5. EU-only hosting or a region per tenant. **EU only in the first hosted slice; a region column is added
   then so it never needs a migration.**
6. Whether the desktop app should pair automatically when it and the browser share a signed-in account.
   **Yes, with a confirmation in the desktop app; never silently.**
