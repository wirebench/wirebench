# Wirebench Hosted Edition: the browser client, the local agent and a multi-tenant server — design

Date: 2026-10-24 · Status: **architecture only** — approved scope is the design, not a build plan (owner,
2026-10-24, popup); the 2026-10-15 ruling stands that the hosted edition starts after ten self-hosted paying
customers · Amended 2026-10-26 after an independent review: its four high findings are folded into §4.2
(row-level security must be forced), §3.8 and §3.10 (the agent serves a browser a declared subset), §5.4
guard 6 (background jobs have a tenant scope) and §5.1 (the host package is a factory with no module-level
state); the rest are folded in where they apply · Amended 2026-10-27 for slice 2 (§17, decision 12,
ADR-0034) · Amended 2026-10-29 for slice 3 (§18, ADR-0035) · Amended 2026-10-29 for slice 4 (§19, ADR-0036) ·
Amended 2026-11-03 for slice 5 (§20, ADR-0037) · Amended 2026-11-03 for slice 6 (§21, ADR-0038) · Amended 2026-11-04 for slice 7 (§22, ADR-0039) ·
Amended 2026-11-04 for slice 8 (§23, ADR-0040) ·
Issue: #776 (slice 1 is #777, slice 2 is #783, slice 3 is #790, slice 4 is #798, slice 5 is #821, slice 6 is #822, slice 7 is #829, slice 8 is #830) ·
Module ids: `host-seam`,
`browser-client`, `local-agent`, `tenancy`, `operations`, `domains`, `control-plane`, `custom-domains`

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
  7. **No free hosted tier** (popup, 2026-10-26). Signup requires a subscription from day one; Community
     stays free self-hosted only. A hosted tenant is never free server-side sends, catch URLs or schedules
     for an email address.
  8. **EU only in the first hosted slice**, with a `region` column on `tenants` from day one so a second
     region later needs no migration (popup, 2026-10-26).
  9. **Pairing is always the code** (popup, 2026-10-26). The desktop app never pairs itself, even when it
     and the browser share a signed-in account on the same machine.
  10. **Team seats are paid by card through one payment provider's subscription webhooks; Enterprise
      tenants are invoiced by Verathic outside it** and set by the operator command (popup, 2026-10-26).
      **The provider is Paddle** (owner, 2026-10-26), as merchant of record: Paddle is the seller on the
      customer's invoice, collects and remits EU VAT and sales tax, and pays out to Verathic, which is
      what makes card payments workable for an Algerian company (Algeria is not a supported business
      country for a direct Stripe account). The control plane still speaks only
      `subscription.created|updated|deleted`, fed by Paddle's `subscription.*` webhooks through its
      signature verifier; Paddle's checkout overlay is the only Paddle code on the signup page.
  11. **A server host instance is evicted 30 minutes after its last socket closes, and a tenant holds at
      most as many live instances as it has seats** (popup, 2026-10-26).
  12. **Private ranges stay open on a self-hosted server** (popup, 2026-10-27). The egress rule of §6
      always refuses loopback, link-local and cloud-metadata addresses, on every server; private ranges
      are refused only when the operator sets `WIREBENCH_SERVER_EGRESS_DENY_PRIVATE`, and always in
      hosted mode. Scheduled runs against internal hosts keep working after the upgrade. ADR-0034.

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
| **Capability** | A channel group the host can serve: `files`, `keychain`, `ssh`, `pty`, `kerberos`, `dialogs`, `send:private`, `send:public`, `secret-sources`, `team-secrets`, `updates`, `app-lock`. Each host declares its set; the renderer asks once per connection. |
| **Browser subset** | What the agent host serves a *browser* caller, as opposed to its own Electron window: `send:private`, `secret-sources`, `team-secrets`, `keystores`, `kerberos`, the cookie jars it holds, and `ssh` only when the person opted in at pairing. Never files, SFTP, dialogs, git, the terminal, the secret store's writes or `app.*` (§3.8, §3.10). |
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
- `window.wirebench.env` grows `host: 'electron' | 'browser'` and `capabilities` (§2). On the desktop
  `env` is baked at preload time; in the browser `host` and `capabilities` arrive with the socket
  handshake, so the browser bootstrap mounts the renderer only after it, and `pathForFile`, which has no
  browser equivalent, returns `''` while the Files tab's drop uploads the file's bytes instead of copying
  by path. The renderer hides what the connected hosts cannot do (no *Reveal in Finder* without `files`,
  no SSH area without `ssh`) with the same area and feature switches it uses today (`app.areas`,
  `app.features`), so no component checks the host directly.
- A channel the renderer calls that neither host serves answers `{ ok: false, error: { code:
  'host-capability-missing', details: { capability } } }`, and the renderer's existing error surface shows
  it. Nothing hangs.

### 3.2 Sign-in from a browser

- A person opens `https://<slug>.<app-domain>`. Without a session the server shows a sign-in page with
  the tenant's enabled methods: local password, OIDC, SAML. That page is new in slice 2: the invitation
  page the identity module renders today is a static instruction to open the desktop app, and local
  sign-in is a JSON route for the desktop. OIDC and SAML run as browser redirects whose state lives in a
  `browser_flows` row (§4.1), not in the desktop's flow tables, which require a PKCE challenge, a loopback
  port, a device name and a grant hash that a redirect flow does not have. The callback sets the cookie.
- A browser session is a cookie: `__Host-wb_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the
  tenant host name by the `__Host-` prefix, so a session on `acme.<app-domain>` is unreadable at
  `other.<app-domain>`. The cookie names a row in `device_tokens` with `kind = 'browser'`; the identity
  guard accepts a bearer token (desktop, CLI, agent) or the cookie. Idle and maximum ages follow
  `WIREBENCH_SERVER_TOKEN_IDLE_DAYS` and `_MAX_DAYS`.
- `app.<app-domain>` asks for an email and **emails** that address the links of the tenants it belongs to;
  the page itself always answers "if that address has a team, a message is on its way", so it is not an
  oracle for which customers an address belongs to. It never signs anyone in itself and sets no cookie.
- Signing out revokes the row, as the desktop's *Sign out* does. A server admin disabling a user ends the
  live socket and the host socket with the same close code the live-updates module uses (`4401`).

### 3.3 Workspaces in the browser

- Only **server-kind workspaces** open in the browser (my call): no git-kind workspace, no local folder,
  nothing that needs a git binary or credentials on the server host. A project a browser user creates
  lives inside a server workspace.
- The server host opens a workspace exactly as the desktop opens a server workspace: through the sync
  design's `ServerClient` (head, snapshot, changes, commits, log) with the working copy at
  `<dataDir>/tenants/<tenantId>/checkouts/<userId>/<workspaceId>/` and the snapshot and pending commits
  in the user's `state/`, where the desktop keeps them in app data. The one difference is the client's
  transport: a `ServerClient` that calls Fastify's `inject` with the session's credential, so every route
  runs its full pipeline (role checks, feature gates, audit fire sites, rate limits) with no network hop
  and no service-layer refactor, since those checks live in route handlers today. A direct service call
  is reserved for later, if `inject` measurably costs. There is no git on the server host, as there is
  none on the desktop for a server workspace. The handlers that read and write project files run
  unchanged on that working copy.
- Per-machine state the desktop keeps under `userData` (preferences, layouts, history, cookie jars,
  current values, the HTTP log, the sync snapshot) lives under the user's checkout parent,
  `<dataDir>/tenants/<t>/checkouts/<user>/state/`, in the same files the desktop writes. The files the
  desktop keeps behind `safeStorage` (OAuth tokens, cookie jars with credentials, passphrases) go through
  the server platform's `secrets` (§3.5), which encrypts them under the tenant data key; the file layout
  is the desktop's, the cipher is the platform's. One person has one browser state per tenant, whichever
  machine they open the tab on. When a paired agent sends, the agent keeps the cookie jar it used, and the
  browser client records the redacted exchange on the server host through the existing exchanges channel,
  so History is one list with a `sentFrom` column and one socket serves it; nothing else is copied
  between hosts. Once the agent holds a jar for a domain, later sends to that domain route to the agent
  (§3.4 rule 1), and the chip on the send button says so, so sends do not drift to the agent unnoticed.
- A host instance is created when a user's first host socket connects and evicted after an idle period
  (default 30 minutes, `WIREBENCH_SERVER_HOST_IDLE_MINUTES`); its checkouts stay on disk. A tenant's
  checkouts are deleted with the tenant (§3.6).
- Live events reach a browser caller over the host socket: the server host subscribes the user to the
  live hub and forwards `head`, `access`, `session-ended`, `capture`, `hooks` and `schedule-run` as pushed
  events. The live route itself stays as it is for the desktop and the CLI; it authenticates by a bearer
  token in its first frame and checks `Origin` against the configured public URL, and a cookie session on
  a tenant host name can satisfy neither, so the browser never opens it.

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
4. A send whose needs span both hosts (a sealed server secret plus an agent capability, or a value held
   only in the agent's store for a public target) is **not split** across hosts (my call): it fails with
   `secret-missing` naming the host that lacks the value, and the Secrets page shows, per name, which host
   holds a value, so the person knows where to enter it.

The engine's one send path (`2026-10-01-wirebench-one-send-path-design.md`) is what both hosts call; the
rule chooses the host, not a code path.

**What the agent receives** (my call). The workspace's files are on the server host, including edits the
browser has not committed. For an agent send, the server host materialises a *send bundle*: the request
item, every script in its folder chain, the project's and the active environment's non-secret values, the
cookie-jar policy, and secret references by name only. The bundle is the subset of project files the CLI
runner reads to send the same request from a folder, in the same shapes, so the agent runs the one send
path on it with nothing new: scripts, auth chains and assertions run on the agent; `${#System#…}`, secret
sources, team secrets, keystores and Kerberos resolve there. For a team secret the bundle also carries
the workspace's team-secrets subtree (vault, access and key files, as synced), and the agent decrypts
with its approved machine key for that workspace, which it holds only if the desktop app on that machine
has joined the workspace and been approved (team-secrets design §3.2); otherwise the send fails with
`team-secret-needs-approval` and the renderer says which machine to approve. The response and the
assertion results return to the browser over the agent socket, and the browser client records the
redacted exchange on the server host (§3.3). The agent does not open the workspace, sync it, or keep a
second working copy; there is one working copy, on the server host.

### 3.5 Secrets in the browser

- ADR-0004's rule holds inside each host: a value lives in the host's secret store and is resolved at the
  moment of use, in the host. The renderer never reads one back.
- The **agent's** store is `safeStorage` as today.
- The **server host's** store has two parts, with the secret-box helper of webhook-signatures and
  scheduled runs as the cipher. In slice 2 both are under one new server-wide root,
  `WIREBENCH_SERVER_SECRETS_KEY` (a KMS key in production), beside the existing hooks and schedules keys,
  which stay server-wide; slice 4 adds the per-tenant data key under that root and re-wraps every sealed
  value once in the tenancy migration (my call):
  - `HostPlatform.secrets` for the server platform encrypts and decrypts the blobs the desktop keeps
    behind `safeStorage` (`secrets.json`, OAuth tokens, cookie jars, passphrases), stored as files in the
    user's `state/` (§3.3). This is what makes the desktop's secret-resolver, OAuth and cookie code run
    unchanged on the server host.
  - **Sealed secrets** are the named values a server-side send may resolve:
    `tenant_secrets(tenant_id, scope, owner_id, name, sealed, created_at)`. The first version has
    `scope = 'user'` only (my call, on review): a workspace scope that any editor's send or script can
    read is not write-only in any sense that a data-processing agreement could state, so it waits until
    the trust boundary is written down (a workspace secret is readable by every editor, by design) and
    the per-resolution audit line carries the request's target host. The desktop's `secrets.*` channels
    on the server host write sealed rows instead of `safeStorage` entries, so the renderer's Secrets UI is
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
  chosen slug, email verification, then a Team subscription by card (decision 7: there is no free hosted
  tier), then the tenant exists with one user who is server admin of that tenant. An operator creates an
  Enterprise tenant by command line for an invoiced deal (decision 10).
- **Slug.** 3–40 characters, `[a-z0-9-]`, not starting or ending with `-`, unique, never reused after
  deletion, and not on the reserved list (`app`, `api`, `www`, `docs`, `status`, `admin`, `agent`, `mail`,
  `help`, `support`, `billing`, `login`, `signup`, every protocol and area name the app has). Changing a
  slug keeps the old one as a redirect for 30 days, after which it is retired like a deleted tenant's. A
  signup reserves its slug in `signups` for the life of the verification token, under the same unique
  index as `tenants.slug`, so two concurrent signups cannot both win a name.
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
  `<slug>.<app-domain>` is each tenant, for browsers, the desktop, the CLI and the MCP server alike. Every
  HTTP client sets `Host` from the URL and the wildcard certificate covers every slug, so there is no
  separate API name and no slug prefix; a client joins `https://<slug>.<app-domain>` as it joins a
  self-hosted server today.
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
  page shows a six-character code that lives ten minutes (my call). Guessing is bounded per address and
  server-wide, since a guess carries only the code (§18.2 has the limits).
  The person opens the desktop app (or runs `wirebench agent pair`) and types the code; the agent
  connects to the tenant's server once, exchanges the code for a pairing record
  (`agent_pairings(tenant_id, user_id, agent_id, public_key, port, subset, created_at, last_seen)`) and
  receives the tenant host name as its allowed origin. The record carries the agent's loopback port,
  which the browser client reads from the server, so there is no port scan; the agent takes a fixed
  default and falls back to the next free one, updating the record.
- **What a browser caller may reach is the browser subset of §2, never the whole registry** (review
  finding, high). The agent is the desktop main process, and the channel contract allows an Electron
  window nearly everything because that window is inside a signed app; a page on a tenant host name is
  not. Origin and nonce authenticate the page, not the server behind it, so a compromised hosted server
  or one renderer XSS must not become file access or a shell on every paired machine. The subset is
  fixed in the pairing record, shown on the pairing screen, and `ssh` joins it only when the person ticks
  it there. A browser caller's request to any other channel answers `host-capability-missing`.
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

The **agent host** has two caller kinds and two registrations: its own Electron window gets the full
registry as today; a browser caller gets the browser subset of §2 (`send:private`, `secret-sources`,
`team-secrets`, `keystores`, `kerberos`, its cookie jars, and `ssh` only by opt-in at pairing). The agent
never serves a browser caller `fs`, `local-fs`, SFTP, `dialogs`, `git`, the local terminal, `secrets.*`
writes, `plugins`, `mock`, `app.*` or updates.

## 4. Data model and storage

### 4.1 The tenant column

Every one of the 33 existing tables except `schema_migrations` and `server_identity` gains
`tenant_id uuid not null references tenants(id)`, filled by the migration with the single self-hosted
tenant's id. Composite uniqueness replaces per-server uniqueness: `teams (tenant_id, lower(name))`,
`users (tenant_id, lower(email))`, `catch_urls (tenant_id, secret)`, and so on, one index per rule the
earlier specs state. `license` becomes one row per tenant. The audit chain anchor is per tenant, so a
tenant's export verifies on its own. For the browser flows, `device_tokens` gains
`kind text not null default 'device'` (`device` | `browser`), and browser OIDC and SAML redirects get
their own `browser_flows(id, tenant_id, provider, state_hash, nonce, redirect_to, expires_at)` row rather
than nullable columns on the desktop's PKCE flow tables.

```sql
create table tenants (
  id          uuid primary key,
  slug        text not null unique,
  name        text not null,
  edition     text not null default 'community',   -- community (self-hosted only) | team | enterprise
  status      text not null default 'active',      -- active | suspended | deleting
  region      text not null default 'eu',          -- decision 8: one value today, no migration later
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
alter table teams force row level security;
create policy tenant_isolation on teams
  using (tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid);
```

The same three statements for every tenant-scoped table, generated by one migration from the table list.
**`force` is not optional** (review finding, high): PostgreSQL applies no policy to a table's owner unless
it is forced, and one role runs both the migrations and the queries on every installation, so without
`force` the guard would be absent in production while every test passed. The migration test asserts
`relforcerowsecurity` on every scoped table, and the two-tenant tests run as the owner role on purpose.
The policy reads the setting with `missing_ok` and `nullif`, so a query outside a tenant transaction sees
no rows rather than raising.

The setting is scoped **per unit of work, not per HTTP request** (review finding): a repository call
runs inside `withTenant(scope, fn)`, which opens a short transaction, sets `wirebench.tenant_id` locally
and commits; the request hook only resolves `request.tenant` (§5.3). Holding one transaction for the life
of a snapshot download, a push or a host socket would pin a pool connection each. The control plane
connects as a second database role with `BYPASSRLS`, used only by its own module; the default role has
no bypass.

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
  readonly proxy: { resolve(target: URL): Promise<string | undefined> };
  readonly capabilities: ReadonlySet<Capability>;
}

export function createHost(platform: HostPlatform): Host; // the package's only export
```

`dialogs` and `shell` are optional: the server platform omits them and the handlers that need them are
registered only when present (the capability set says so to the renderer). Every `app.getPath`, `dialog`,
`shell`, `safeStorage`, `nativeTheme`, `session.resolveProxy`, `powerMonitor` and `BrowserWindow` call in
main becomes a call on this interface; `proxy.resolve` is what the "System proxy" setting reads, the
server platform answers the hosting proxy or none, and the egress rule of §6 checks the proxy address as
it checks the target. `window-scope.ts` keys per-caller services by `caller.id` instead of
`webContents.id`.

**The seam is a factory, not 37 file edits** (review finding, high). The desktop's composition root
constructs its services at module scope (37 of them in `main/index.ts` alone, plus module-level maps
and sets across main), so the package cannot be instantiated once per browser user as §3.3 needs.
`createHost` is that composition root rewritten as a function; `@wirebench/host` has a rule of **no
module-level mutable state**, checked by a grep gate in `pnpm check` beside the import-graph gate, so N
hosts coexist in one process. This is the larger half of slice 1.

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

One `onRequest` hook before identity's guard: the `Host` header's first label (behind the trusted proxy
of `WIREBENCH_SERVER_TRUST_PROXY`), or the single tenant in self-hosted mode, looked up in a small
in-memory map refreshed on change, then `request.tenant` set. Nothing else is opened here; transactions
are per unit of work (§4.2). A slug that does not exist answers `404` with no body that names anything.
Identity, teams, sync, live, hooks, schedules, licensing and audit read `request.tenant` where they read
`ctx` today; their repositories take the tenant as the first argument so a call without one does not
compile.

### 5.4 The tenancy trade-off, recorded

The owner chose a shared schema over one server process per tenant. What that buys: one deployment, one
database, cheap idle tenants, one upgrade. What it costs: every query is a place where a missing filter
leaks a row across customers, and every server module has a repository file full of them. The guards that
make the choice safe, all required, none optional:

1. Row-level security, **forced**, on every tenant-scoped table (§4.2), so a missing filter returns
   nothing rather than everything, for the owner role too.
2. A repository signature that takes a `TenantScope` first, so a call site cannot forget it.
3. A migration test that fails when a table exists without `tenant_id`, a policy and `force`, unless it
   is on the named allowlist: `schema_migrations`, `server_identity`, and the control plane's own
   tables (`tenants`, `tenant_slugs_retired`, `signups`).
4. An integration test per module that creates two tenants, writes in one, reads as the other through
   every route, and expects nothing; it runs as the owner role.
5. The live hub, rate limiters, schedule concurrency and the repo store keyed by tenant first.
6. **A job scope for everything that runs outside a request** (review finding, high): the scheduler's
   pass, audit retention and forwarding, hook and session-log retention, token idle sweeps, the live
   hub's role queries and the tenant map. Each job enumerates tenants through a narrow reader that sees
   only `tenants`, then runs one `withTenant` transaction per tenant; under the policy as written they
   would otherwise see nothing and silently stop for every customer. The few truly global steps (the
   scheduler's lease pick-up) run on a named, allowlisted bypass that writes an audit line.

The alternative, one process per tenant behind a router, is not taken; it would have left the existing code
untouched at the price of a process per idle customer and two deployment shapes. Recorded in ADR-0032.

### 5.5 Multiple instances

The live hub and the per-workspace lock are in-process by the host design. Hosted needs at least two
instances behind a load balancer. The hub gains PostgreSQL `LISTEN`/`NOTIFY` fan-out (one channel,
payload `tenantId:workspaceId:event`), the per-workspace lock becomes the advisory lock the host design
named as the upgrade path, and the host socket is sticky by `(tenantId, userId)` through a cookie the
balancer honours, because a host instance is an in-memory object on one node. The data directory,
checkouts and `state/` included, is **one volume shared read-write by every instance** (my call), so a
user bounced to another node finds the same working copy and state. A host instance takes a **lease per
`(tenantId, userId)`** in PostgreSQL (an advisory lock held by a heartbeat row; amended by §19.9 to a row lease with an expiry) before it touches
`checkouts/<user>/`, and the node that loses the lease refuses the socket with a retry hint; that closes
the two-writer window a failover or a drain would otherwise open on the shared volume. Scheduled runs
are already leased per run; the lease gains the tenant.

### 5.6 The control plane

A server module, `packages/server/src/control-plane/`, loaded only when `WIREBENCH_SERVER_MODE=hosted`:
signup pages and routes, slug rules, the subscription webhook from Paddle (decision 10; the module speaks
`subscription.created|updated|deleted` and nothing provider-specific beyond the webhook signature
verifier and the checkout overlay, so a second provider is one adapter), edition changes, suspension,
export and deletion jobs, and
`wirebench-server admin tenant …` on the box. It owns `tenants`, `subscriptions`, `signups`,
`tenant_exports` and the retired slugs. It uses the bypass database role (§4.2) and nothing else does.

## 6. Security

- **Isolation.** Row-level security, per-tenant data keys, per-tenant directories rooted by a path
  function that refuses `..` and symlinks (the path-safety rules of the sync design), per-tenant audit
  chains, per-tenant rate limits on sign-in, hooks and sends.
- **Egress from the server host.** A server-side connection is a connection from the hosting network.
  The server refuses targets that resolve to loopback, link-local, private ranges and cloud metadata
  addresses, after resolution, connecting to the checked address rather than resolving again, on every
  redirect, for the proxy hop as for the target, for every protocol (the SSRF rule). The rule covers
  every outbound connection, not only a send: importers, definition fetch (with its custom CA path),
  OAuth token calls, the scheduled-runs executor (today only its alert hosts are guarded) and webhook
  deliveries. In hosted mode no tenant policy can open private ranges, since those are the project's own
  network; the Enterprise allowlist for private targets exists for self-hosted servers only. The agent
  exists for those targets.
- **Scripts on the server** run in the capability-free sandbox of ADR-0016 with a per-tenant CPU and
  memory budget and the same empty system scope as scheduled runs.
- **Sessions.** `__Host-` cookie, `SameSite=Lax`, an `Origin` check on every mutating route and on both
  WebSocket upgrades, no token in a URL ever.
- **The agent** listens on loopback only, serves one allowed origin per pairing, verifies a server-issued
  nonce before the first channel, and serves a browser caller only the browser subset of §2, fixed in the
  pairing record: never files, SFTP, a shell, the secret store's writes or `app.*` (§3.8, §3.10).
- **Secrets.** ADR-0004 per host; sealed values are written through an API that cannot read them back,
  and are readable by the sends of whoever owns the scope, by design; team-secret keys exist only on
  paired agents (decision 5), and the server host and the browser hold none; exports carry no secret;
  deletion wipes sealed rows and the tenant data key.
- **No telemetry.** The hosted edition's own operations metrics (§8) name tenants by id, never request
  content, and the no-telemetry promise of the product is unchanged for self-hosted.
- **Compliance surface.** A data-processing agreement, a sub-processor list, EU hosting by default, the
  audit chain's export for a customer's auditor; the SOC 2 path the roadmap names.

## 7. Tech stack

Nothing new in kind: TypeScript, Fastify, `@fastify/websocket`, `ws`, PostgreSQL 16 with row-level
security, Vite for the browser build, the engine for every send. New runtime dependencies are confined to
the control plane (Paddle's webhook verification, or a plain HMAC check of its signature header without
the SDK) and are listed in the licences test
before they are added. `packages/agent` is a library: the CLI's `wirebench agent` command and the
desktop app both embed it. Shipping `@wirebench/host` in the CLI tarball drags the Kerberos binding,
`node-pty`, the device-key helper and the vendored SSH binding along, each with its own packaging
history (ADR-0019, ADR-0026, ADR-0027, the prepack copy of `@wirebench/ssh`), so the agent's packaging
is its own task in slice 3, not a side effect.

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
| `wirebench-server admin tenant import <export>` | Restores a tenant export (§3.6) into this server, as a new tenant in hosted mode or as the single tenant of a self-hosted server. |

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
| 1 | `host-seam` | **Built** (#779 and #780, 2026-10-27; ADR-0033 accepted). `@wirebench/host` as `createHost(platform)` with `HostPlatform` and `Caller`, no module-level state and its gate; the Electron app embeds it; proven by the existing tests on a fake platform and a fake-socket test of `buildApi` (the loopback server moves to slice 3) | — | yes (no user-visible change) |
| 2 | `browser-client` | **Built** (#785, #787 and #789, 2026-10-29, for #783; §17 records what changed from this row). The Vite browser build, `browser-bootstrap.ts`, capability discovery, the sign-in page and `browser_flows`, the cookie session, the server host with checkouts and per-user state via `inject`, live events over the host socket, user-scoped sealed secrets under one server-wide root, the §3.10 allowlist and path guard, the egress rule on every outbound connection | 1 | yes: a self-hosted team gets a browser tab |
| 3 | `local-agent` | **Built** (#793, #795 and, for the agent hosts, #790, 2026-10-29; ADR-0035; §18 records what changed from this row). `packages/agent` as a library, the loopback socket transport, pairing with the browser subset, the send-route rule and the send bundle, `wirebench agent`, the agent's packaging | 1, 2 | yes |
| 4 | `tenancy` | **Built** (#800, #805, #807, #811 and #812, 2026-11-02, for #798; §19 records what changed from this row). `tenants`, `tenant_id` on every table, forced row-level security, tenant resolution by `Host`, per-tenant directories and data keys with the one-time re-wrap, the six guards of §5.4 including the job scope, the host-instance lease, the self-hosted migration | 2 | yes, invisibly (one tenant) |
| 5 | `operations` | **Built** (#828, #833 and #836, 2026-11-04, for #821; ADR-0037 accepted; §20 records what changed from this row). `LISTEN`/`NOTIFY` hub fan-out, advisory locks, sticky host sockets, per-tenant budgets, metrics by tenant id | 4 | partly (multi-instance self-hosted) |
| 6 | `domains` | **Built** (#825, #826 and #827, 2026-11-03, for #822; ADR-0038; §21 records what changed from this row). The two names as settings, the wildcard certificate in a Traefik recipe by DNS-01, the `app.` entry with emailed links, reserved slugs; the public suffix submission is an operator step for when a domain is registered | 4 | no |
| 7 | `control-plane` | Signup, subscriptions, edition from subscription, suspension, export, deletion, operator commands; per-tenant settings (OIDC, SAML, SCIM, audit forwarding, SMTP sender, retention), today's environment variables becoming the default tenant's (§19.1, §19.12) | 4, 5, 6 | no |
| 8 | `custom-domains` | CNAME plus TXT verification for Enterprise tenants; §23 records the design (#830, ADR-0040): a second full name that becomes the primary, a CNAME to `custom.<app-domain>`, one per tenant, an HTTP-01 certificate per name through Traefik's HTTP provider | 6, 7 | no |

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
6. A tenant's export verifies its audit chain and restores into a self-hosted server through
   `admin tenant import`.

## 14. Migration and compatibility

- The tenancy migration is one transaction for rows and one directory move for repositories, with the
  single tenant's id written to `server_identity` first so a crash between the two is resumable (amended by
  §19.10: two migrations for rows, each one transaction, then a resumable file step and key step, and a way back).
- Project files, `share.yaml`, the CLI, the MCP server and the desktop's channels do not change shape.
- A desktop or CLI of any version joins a hosted tenant at `https://<slug>.<app-domain>` exactly as it
  joins a self-hosted server, since tenants resolve by `Host` alone (§3.7); there is no minimum client
  version for hosted beyond what the server's API version already demands.
- Licenses already issued keep working: hosted mode is never switched on for an existing self-hosted
  server by an upgrade.

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| A query without a tenant filter leaks across customers | Forced row-level security plus the compile-time scope plus the two-tenant tests run as the owner role (§5.4) |
| A background job sees no rows under the policy and silently stops for every tenant | The job scope, guard 6 of §5.4, with a test per job that two tenants are each served |
| A paired agent gives a page on the tenant host name the whole machine | The browser subset in the pairing record (§3.8), `ssh` only by opt-in, everything else refused |
| The host package cannot run twice in one process | `createHost` with no module-level state and a gate for it (§5.1) |
| Server-side sends make the hosting network a proxy | The egress rule in §6; private targets only by tenant policy; the agent for everything else |
| A host instance per browser user costs memory | Idle eviction, a per-tenant instance cap, measured in slice 2 before slice 4 |
| Sticky sessions and in-memory host instances complicate rolling deploys | Drain before stop; the working copy and state are on the shared volume, so the next node resumes them |
| A served channel reaches the server's disk or network beyond the workspace | The §3.10 allowlist, the checkout-rooted path guard, the egress rule on every outbound connection |
| The agent's loopback socket is reached by a hostile page | Origin allowlist per pairing, server-issued nonce, private-network preflight, loopback only |
| Sealed secrets put customer secrets on the project's servers | Per-tenant data keys under a KMS root, write-only API, audit on every resolution, said plainly in the docs and the DPA |
| The public suffix list submission is slow | `__Host-` cookies and per-origin storage protect sessions before listing |
| The Elastic License reserves hosting to the project, which is now also the host | ADR-0028 anticipated this; the control plane stays in the server package under the same license |

## 16. Open questions

None. The five questions this section held on 2026-10-24 (payment, eviction and the instance cap, region,
auto-pairing, a free hosted tier) were put to the owner on 2026-10-26 and are decisions 7 to 11 above.
The payment provider is Paddle, as merchant of record (decision 10).

## 17. Slice 2 amendment: the browser client (2026-10-27)

Slice 2 (#783) was scheduled on its merits, before the trigger, because a self-hosted team gets a browser
tab from it, and is built: #785 the server side, #787 the server host, and #789 the tab. It builds
§3.1–§3.5, §3.10, §5.2 (the server transport) and §6 with one tenant implied, so no `tenant_id` appears
yet. Where the build differs from the sections above, this section wins until slice 4 folds it back.
Plan: `docs/plans/2026-10-27-browser-client.md`.

### 17.1 Switching it on

- The browser client is off unless `WIREBENCH_SERVER_BROWSER_CLIENT=true` (my call). An upgrade must not
  open a new sign-in surface and a server-side send path on a server whose operator did not ask for them.
  The switch requires `WIREBENCH_SERVER_SECRETS_KEY` (a 32-byte base64 key, the same form as the hooks and
  schedules keys); `config check` refuses the one without the other.
- With the switch off, `/` answers `404` as today, `/api/v1/host` is not registered, and nothing below runs.

### 17.2 Sign-in and the cookie

- `GET /` with a valid session serves the renderer's `index.html`; without one it redirects to
  `/sign-in`. `/sign-in` is a server-rendered page (the invite page's style and its `default-src 'none'`
  CSP plus `form-action 'self'`) listing the enabled methods. Local sign-in is a plain form `POST` to
  `/sign-in/local`, with the desktop route's rate limits and decoy. OIDC and SAML start at
  `/sign-in/oidc` and `/sign-in/saml`, keep their state in `browser_flows`, and their callbacks
  (`/api/v1/auth/oidc/browser-callback`, `/api/v1/auth/saml/browser-acs`) set the cookie and redirect
  to `/`. The desktop's loopback flows are untouched. The SP metadata keeps naming the desktop's ACS URL
  only, so an operator adds the browser one at the IdP by hand; `serve` logs both.
- A flow's start also sets `__Host-wb_flow` (`wb_flow` on an `http://` URL), holding the flow's state for
  its ten minutes; a callback whose state the cookie does not match is refused. Without it, a callback URL
  someone started and handed on would sign another person into their account (login CSRF through the
  redirect flow). The cookie is cleared only on a matching state. For SAML it is `SameSite=None`, because
  the IdP posts the response from its own site, and browsers keep that only when `Secure`: **browser SAML
  needs an `https://` public URL**. OIDC returns by a top-level `GET`, which `Lax` allows.
- The cookie is `__Host-wb_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`). On an
  `http://` public URL, which the server accepts only with `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`,
  it is `wb_session` without `Secure`, because browsers drop a `__Host-` cookie that is not `Secure`.
  Its value is a device token; the row has `kind = 'browser'` and the same idle and maximum ages.
- The identity guard reads `Authorization` first, then the cookie. A request authenticated by the cookie
  whose method is not `GET` or `HEAD` must carry `Origin` equal to the public URL, or it is refused with
  `identity-origin-refused` (`403`); the sign-in form is checked the same way, against login CSRF.
- `POST /sign-out` at the root, a same-origin form post checked against `Origin` like the sign-in form,
  revokes the row, clears the cookie (a stale one too), announces `sessionEnded`, which closes the
  user's host sockets that used that token with `4401`, and redirects to `/sign-in`. The tab's account
  menu offers **Sign out** when the bootstrap passes a sign-out action in `env` (17.6), which posts that
  form. A new browser sign-in also revokes the session token the browser presented, if any.

### 17.3 The server host

- One host instance per user, in the server process, created by `createHost(serverPlatform, options)` on
  the user's first host socket and evicted `WIREBENCH_SERVER_HOST_IDLE_MINUTES` (default 30) after the
  last one closes. On a self-hosted server a user has at most one instance and seats already bound users,
  so decision 11's cap holds without a counter; slice 4 adds the per-tenant counter.
- **Layout (amends §3.3 and §4.4).** The host's `userData` is `<dataDir>/checkouts/<userId>/`, so its
  state files sit where the desktop's do inside `userData`, and the working copies are the host's own
  `workspaces/<workspaceId>/` beneath it. Slice 4 prefixes `tenants/<tenantId>/`. Nothing else in the
  data directory is reachable from a host.
- **Embedding.** The server builds with `tsc -b` and `@wirebench/host` is source-only (ADR-0033), so the
  server bundles the host with esbuild into `dist/host/` at build time, and loads that bundle only when the
  switch is on. Native modules the host loads lazily (`node-pty`, serial, `node-hid`, Kerberos) stay
  external and are never loaded, since their channels are not registered. The server's build stays
  `tsc -b` plus that bundle; the browser build and its copy into `dist/browser/` are separate steps
  (`build:browser`, then `copy-browser`), and with the switch on the server refuses to start without them.
- **Transport to the server's own routes.** `HostOptions.server` gives the host a `send` for its
  `ServerClient` built on Fastify `inject` with the user's token as a bearer, and a `connectLive` that
  opens an in-process socket on the live module's handler, so every call runs the full route pipeline and
  live events reach the host's existing live client. The host's account for the server's public URL is
  the server's to hold: `HostOptions.server.credential()` returns the token of the newest socket, and the
  host's `AccountService` treats `server.url` as signed in with it, writing nothing to `accounts.yaml` or
  the secret store.
- **Sockets.** One user holds at most 8 host sockets (`HOST_LIMITS.maxSocketsPerUser`), every tab and
  window together; the ninth closes `4429` before any frame. A frame either way is at most 32 MiB
  (`HOST_LIMITS.maxFrameBytes`, `1009` past it), the largest sync transfer; calls queued while the host is
  built are bounded to 64 MiB. A user disabled by the time the socket upgrades gets the guard's HTTP `403`
  rather than a close code, so the bootstrap, on a failed upgrade, asks `GET /api/v1/me` and goes to
  `/sign-in` on `401` or `403`.
- **What it serves** is §3.10's table, as one allowlist of channel groups in `packages/server/src/host/`.
  A channel outside it answers `host-capability-missing`. The server platform has no `dialogs`, `shell`
  or `power`, and its capabilities are `send:public` only, so the SSH, terminal and Kerberos areas are
  off through `app.areas`. Every kind is in `app.kinds`: gRPC's transport takes the egress check too
  (17.5), so no kind is left out. The save-time secret scan (`secretScan.*`) is served, over the open
  project's model, so a team workspace gets the same review before a save; only folder scans of local
  paths stay refused, as §3.10 says.
- **Five more capabilities** in the wire list, which the Electron platform declares and the server
  platform does not: `processes` (MCP servers over stdio), `listen` (a mock listener on the machine's
  network), `windows` (more than one window), `accounts` (signing in to and managing server accounts in
  the window) and `reveal-secrets` (showing secret values in the window). The renderer gates mock
  services, Start and Record, the stub check, the explorer's mock entries and New Window and the native
  menu on them; Settings → Accounts without `accounts` shows only the tab's own server with Sign out (no
  Add server, Remove or Sign in), and Show secrets (the HTTP log's lock and the palette command) needs
  `reveal-secrets`. Attachments, keystores, plugin imports and the project's folder path gate on
  `files`, so no refused channel is offered.
- **Server-kind workspaces only.** A host without the `files` capability refuses to create or open a
  git or local workspace (`host-capability-missing`), and the renderer offers only server workspaces.
  Slice 2 opens existing server workspaces only: creating a team workspace from a browser tab (create and
  share as one server-targeted operation, with its own UI) is follow-up #786, so a browser-only team needs
  one desktop user to create a workspace. §13 criterion 2 asks only that a tab open one.
- **Path guard.** The server platform names a root, the checkout parent; every renderer-supplied path is
  resolved and `realpath`ed against it before any file is touched, and one outside answers
  `host-path-outside-workspace`.
- **No machine values.** `${#System#…}` resolves to nothing on the server host, as in scheduled runs; the
  host reads no `process.env` override (the platform says it is packaged, which switches the
  e2e-only environment overrides off); there are no secret sources.

### 17.4 Secrets (amends §3.5)

- The server platform's `secrets.encrypt` and `decrypt` seal each value with the secret box
  (AES-256-GCM) under a per-user key derived by HKDF from `WIREBENCH_SERVER_SECRETS_KEY` and the user id.
  The host's own `SecretStore` keeps them in `secrets.json` in the user's directory, exactly as the
  desktop keeps its `safeStorage` blobs, and the host's `secrets.*` channels already never read a value
  back, so the renderer's Secrets page is unchanged. `secrets.setShowSecrets` is refused and previews and
  copied commands are masked, so no value enters a socket frame: a browser user sets a value and never
  reads it back.
- The `tenant_secrets` table waits for slice 4 (my call). A second store beside the host's own would
  be a second resolver for one name; slice 4 introduces per-tenant keys and re-wraps every user's
  `secrets.json` once, which is the moment a table can replace the file if it still earns its place.
- Every secret write and every server-side resolution is audited by name (`secret.written`,
  `secret.resolved` with the request's target host), never by value, through a hook the server passes
  in `HostOptions`.

### 17.5 The egress rule (amends §6; ADR-0034)

- One function, `checkEgress(address, family)`, in `@wirebench/core`, used as the DNS `lookup` of every
  connector the server builds: the engine's undici dispatchers (so every redirect and the proxy hop are
  checked, because they connect through the same lookup), the WebSocket connector, gRPC's `node:http2`
  connect (which takes a `lookup` as well), and the server's own alert and webhook clients. The
  connection goes to the address the check passed; nothing resolves twice.
- Always refused, on every server: loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0/8`, `::`),
  link-local (`169.254.0.0/16`, `fe80::/10`), which covers the IPv4 cloud-metadata address, the IPv6
  metadata address `fd00:ec2::254`, the metadata address `100.100.100.200` (inside `100.64.0.0/10`),
  multicast and broadcast. IPv4-mapped IPv6 is unwrapped first.
- Refused only when `WIREBENCH_SERVER_EGRESS_DENY_PRIVATE=true` (and always in hosted mode, slice 4):
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`.
- Covered: server-host sends of every served kind, gRPC included, scheduled runs, schedule alerts, OAuth
  token calls, URL imports and definition fetches made by a server host (gRPC reflection and the MCP
  catalogue fetch among them). Behind a proxy a user names in a request, the hop to the proxy is checked,
  and a literal or `localhost` target is refused before it reaches the proxy. Not covered: destinations
  only the operator configures (the OIDC issuer, SMTP, audit forwarding), which are the operator's own
  network.
- A refusal is `egress-refused` naming the host and the class of address, never the resolved address of
  a private target, so the message is not a probe of the server's network.

### 17.6 The browser build

- `apps/desktop/vite.browser.config.ts` builds `src/renderer` with the desktop's aliases and plugins,
  plus `src/browser/browser-bootstrap.ts` as the entry that runs first. The engine subpaths the renderer
  imports resolve to their sources (the `development` condition), as in the desktop build.
- The bootstrap opens `/api/v1/host`, reads a `hello` frame (`{ type: 'hello', host: 'browser',
  capabilities, osTheme }`), builds `window.wirebench` with `buildApi` over the socket, then imports the
  renderer. `env` gains `host` and `capabilities` on both builds; the renderer reads them through one
  helper, `hasCapability`, and never compares `host`. `pathForFile` is `() => ''`.
- A dropped socket shows a reconnect bar and reopens with backoff; a `4401` close sends the tab to
  `/sign-in`, and so does a `401` or `403` from `GET /api/v1/me`, which the bootstrap asks after an
  upgrade fails (a disabled user's upgrade is refused with HTTP `403`, which a socket cannot read). Calls
  pending at a drop resolve to `{ ok: false, error: { code: 'host-disconnected' } }`. `env` also carries
  the sign-out action (17.2). A `4503` close (the server's key does not open the tenant's data key, §19.7) says the
  server cannot open the user's saved data, and keeps retrying with backoff, without a session check. A `1013` close
  (the upgrade's keys step is not done, §19.10) is a dropped socket like any other.
- The server serves the build from `dist/browser/` with `@fastify/static`, hashed assets cached as
  immutable, and the CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
  blob:; connect-src 'self' ws://127.0.0.1:47615 … ws://127.0.0.1:47634; object-src 'none'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'` (`blob:` for image previews; the twenty agent ports, each
  spelled out, for the paired agent, §18.3) as a header. The page's meta tag carries the same policy less
  `frame-ancestors`, which only a header can. The container image builds it in its build stage.

### 17.7 Testing

- Unit and integration tests per task, two-host-instances-in-one-process tests on the server, and the
  egress rule as a table test over every range above.
- One Playwright suite (`e2e/browser/`) against the server image in Docker with PostgreSQL, run in CI:
  sign in with a local password, open a server workspace, send a request to an echo service on the compose network (a private address, open by default), see
  a request to `127.0.0.1` stop with `send-needs-agent` and *Pair this machine* (§18.4: the person's localhost
  is never the server's; before slice 3 the egress rule refused it), and see
  that the SSH area and the file dialogs are absent. No local Electron windows are involved.

## 18. Slice 3 amendment: the local agent (2026-10-29)

Slice 3 (#790) is scheduled on its merits, after slice 2. With it, a self-hosted team's browser tab can send to
`localhost`, to private hosts the server cannot reach, and to anything that needs the person's machine. It builds
§3.4, §3.8, the agent rows of §3.10 and §5.2's agent transport. Where the build differs from the sections above, this
section wins. Plan: `docs/plans/2026-10-29-local-agent.md`.

### 18.1 What the agent serves (amends §2's browser subset and §3.10)

- A browser caller on the agent reaches one channel group, `agent.*`. It reaches nothing of the registry the
  desktop's own window gets (my call, ADR-0035).
  - The browser subset of §2 (`send:private`, `secret-sources`, `team-secrets`, `keystores`, `kerberos`, the agent's
    cookie jars) is what `agent.send` can use while it runs a send bundle (§18.4). None of them is a channel the page
    can call by itself.
  - This is narrower than "serve the subset's channels". The desktop's request channels address an open project in
    the caller's window scope, and the agent opens no workspace (§3.4), so serving them would mean a second working
    copy.
- The `agent.*` channels:
  - `agent.hello`: capabilities, the agent's version and `sshOptIn`. The capabilities leave out `secret-sources`
    and `team-secrets` until a bundle send has them (#792, and the desktop's team-secrets hook).
  - `agent.send`: one send bundle in, the kind's ordinary send result out, with `sentFrom: 'agent'`.
  - `agent.cancel`.
  - `agent.cookies.clear`: clears the jar the agent holds for this pairing.
- `ssh` is not served, and no opt-in is recorded yet (owner's ruling, on the final review): the pairing request
  keeps its `sshOptIn` field, but both agents always send `false`, and `wirebench agent pair` has no `--ssh`. The
  browser's SSH area needs the hosts and snippets files the agent does not hold, so it stays off in slice 3. SSH in
  the browser is a follow-up, and that version asks for the opt-in then: it must not trust a slice-3 pairing as
  consent.
- Everything else answers `host-capability-missing`. The agent's allowlist is the gate, and a test classifies every
  registry channel as refused for a browser caller.

### 18.2 Pairing (amends §3.8)

- **Tables.** Migration `0019` adds three tables, all without `tenant_id` until slice 4 adds it everywhere:
  - `agent_pairings(id, user_id, agent_id, public_key, port, ssh_opt_in, created_at, last_seen_at)`, one per
    user and agent install;
  - `agent_pairing_codes(code_hash, user_id, expires_at)`, where `code_hash` is an HMAC-SHA256 of the code
    under a key HKDF derives from `WIREBENCH_SERVER_SECRETS_KEY` (`info = 'wirebench-agent-pairing-codes'`);
  - `agent_nonces(nonce_hash, pairing_id, user_id, expires_at)`, a tab's nonce bound to its pairing and user.
- **Routes:**
  - `POST /api/v1/agent/pairing-codes` (cookie, Origin-checked): a new six-character code from an alphabet without
    look-alikes. It lives ten minutes, and a user has one live code at a time (at most ten new codes in ten
    minutes).
  - `POST /api/v1/agent/pairings` (no session; rate-limited per address): `{ code, agentId, publicKey, port,
    sshOptIn }` → creates the pairing row and answers `{ pairingId, origin, email }`, where `origin` is the
    server's public URL and `email` the account's, so the agent can show who it paired with. A wrong code
    cannot be tied to a user or a code (it matches no row), so guessing is bounded by two limits: 20
    attempts per address in ten minutes (an office pairs many machines from one NAT address), and 50 failed
    attempts server-wide in ten minutes, after which pairing answers `429` for everyone until the window
    refills.
  - The agent keeps the pairing only when `origin` is the origin of the address it was given (the agent pairs
    with that origin, and drops any path typed after it), and it refuses `http://` except for a server on its
    own loopback. A pairing id it already holds for another server is not replaced.
  - `GET /api/v1/agent/pairings` (cookie): the user's pairings, with port and last seen.
  - `POST /api/v1/agent/nonces` (cookie, Origin-checked): `{ pairingId }` → a single-use nonce that lives 60 seconds.
  - `POST /api/v1/agent/nonces/redeem`: signed by the agent's key over `nonce‖pairingId‖timestamp`. It answers
    `{ userId, email, displayName }` and consumes the nonce. A replayed or expired nonce or a bad signature answers
    `401`; an unknown pairing answers `404 agent-pairing-unknown`, as a signed `DELETE` or `PATCH` does (pairing ids
    are random, and those routes already say it). It is limited to 300 a minute per address before the signature is checked,
    loosely for an office behind one address, and to 30 a minute per pairing once the signature holds.
  - `DELETE /api/v1/agent/pairings/:id` (cookie or agent signature): unpairs, from either side.
  - `PATCH /api/v1/agent/pairings/:id` (agent signature): the agent's port, told for every pairing at each start;
    only a move is audited (`agent.port_changed`).
  - **Unpaired from the tab.** A cookie `DELETE` removes only the server's row. The agent removes its own copy when
    a signed call (the port report at its next start, or a tab's redeem) gets `404 agent-pairing-unknown`, and the
    desktop stops listening when that was its last pairing. Only that answer removes it: no answer, a `5xx`, a
    refused signature or a bare `404` keeps the pairing. A forged answer costs a pairing, as `unpair --local` does.
  - An agent-signed `DELETE` or `PATCH` is limited to 60 a minute per address: a refusal on a known pairing
    writes an audit row. One whose signature held for another pairing than `:id` is audited as that pairing's
    user.
  - These limits count by client address. Behind a reverse proxy, `WIREBENCH_SERVER_TRUST_PROXY` must be set,
    or every request counts as the proxy's one address. The agent routes exist only when
    `WIREBENCH_SERVER_BROWSER_CLIENT` is on.
  - An agent-signed `DELETE` or `PATCH` signs `METHOD‖path‖pairingId‖timestamp‖sha256(body)`, the hash over
    the exact body bytes (of an empty body for a `DELETE`). Every signed request sends the pairing id, an
    ISO-8601 timestamp no more than 60 s from the server's clock, and the signature in
    `x-wirebench-agent-*` headers.
- **Agent key.** Ed25519, generated at the first pairing, one per agent install. The desktop keeps it behind
  `safeStorage` like any secret; the headless agent keeps it in its own key file (§18.6).
- **Where to pair.** The desktop pairs from *Pair this machine…* in the app menu and from Settings → Paired browsers.
  The headless agent pairs with `wirebench agent pair <code> --server <url>`. Pairing is always the code
  (decision 9).

### 18.3 The loopback socket (amends §5.2)

- **Address.** `ws://127.0.0.1:<port>/host`, never another interface. The upgrade's `Host` must be exactly
  `127.0.0.1:<port>` or `localhost:<port>`, which a page cannot rebind; anything else is refused before the handshake. The port is `47615` by default, and the next
  free one up to `47634`.
- **Shared code.** The frame codec, the hello and the in-flight cap are the server host socket's, moved into
  `@wirebench/host` as `host-socket` so the server and the agent share one implementation.
- **Origin.** The upgrade must carry an `Origin` equal to a pairing's origin, or the agent closes `4403` before any
  frame.
- **Auth.** The first client frame is `{ type: 'auth', pairingId, nonce }`. The agent redeems the nonce at that
  pairing's server and serves nothing until that succeeds (`4401` otherwise). One redemption per socket; the agent
  never trusts a nonce it has not redeemed itself.
- **Preflight.** For paired origins only, the agent answers the HTTP `OPTIONS` preflight that browsers send for
  private-network requests, with `Access-Control-Allow-Private-Network: true`.
- **CSP.** The browser build's CSP gains the agent's twenty ports in `connect-src`, beside `'self'`, each
  spelled out (`ws://127.0.0.1:47615` through `ws://127.0.0.1:47634`), in both the header and the build's
  meta tag (§17.6): the agent may move within its range, and nowhere else on loopback. The tab refuses a
  pairing whose port is not an integer in that range.
- **The tab's side.** The bootstrap reads `GET /api/v1/agent/pairings` once after the server's hello, and
  again when *This machine* pairs or unpairs. It tries the user's pairings in turn, the one that last
  connected from this browser first (kept in `localStorage`). For a pairing it mints a nonce
  (`POST /api/v1/agent/nonces`) and opens a second socket to `ws://127.0.0.1:<port>/host`, sending the auth
  frame before it waits for the hello; every reconnect mints a fresh nonce, one per attempt, with backoff up
  to 30 s. An agent that refuses the pairing (`4401`, `4403`: it belongs to another machine, or was unpaired
  there) moves the tab on to the next pairing; a pairing refused three times in a row shows *Refused by
  this machine's agent* and is retried only every five minutes. With no pairing there is no second socket.
  Its status (none, connecting, connected with the agent's version, refused) shows in Settings → *This
  machine*; it has no reconnect bar. The renderer's `agent.*` calls go to this socket, and answer
  `host-disconnected` without it; every other call goes to the server's. With more than one pairing, a send picks
  the agent whose hello covers its needs (§18.6). A pairing whose agent stops answering is read again every third
  failed open, so an agent that moved port is found.

### 18.4 The send route rule and the send bundle (amends §3.4)

- **The rule** runs on the server host, which has the project: `request.route { projectId, itemId, environment? }` →
  `{ route: 'server' } | { route: 'agent', needs: Capability[] }`. These need the agent:
  - A target whose host the egress classifier resolves to loopback, link-local or a metadata address, or a host the
    server cannot resolve: always. In the browser, §3.4 rule 1 wins over decision 12: the person's `localhost` is
    never the server's.
  - A target in a private range only when the server's egress policy denies private ranges (`denyPrivate`). A
    server that may reach them sends there itself, as decision 12 has it (corrected on review: the earlier text
    sent every private target to the agent, which would take a team's own network away from a server that can
    reach it). The host reads the rule from its platform (`network.egress`).
  - A `${#System#…}` reference, a secret source, a team secret, a keystore on a machine path, Kerberos, NTLM with a
    machine credential, or a cookie jar the agent holds for the target's domain. A `${#System#…}` name reads
    only what the agent's own allowlist lets it (§18.5).

  A pin to `agent` in the browser state, on the workspace or on the request, also forces the agent.
- **The renderer** asks `request.route` before every REST and SOAP send in a browser tab, paired or not (the
  desktop never asks):
  - `route: 'server'`: the send goes as today.
  - `route: 'agent'` with an agent connected: `request.bundle` on the server host, then `agent.send` on the agent,
    then `exchanges.recordAgentSend` on the server host with the redacted exchange, so History stays one list.
  - `route: 'agent'` with no agent connected (none paired, or the paired one not answering): the send fails with
    `send-needs-agent` naming the needs, and the error offers *Pair this machine*. A host the server cannot
    resolve (`detail.reason: 'unresolved'`) is named as such: it may be a name only the person's network knows.
  - A protected environment (the workspace's, or its linked project environment) is asked about in the tab: the
    bundle answers `needs-confirmation` with the environment's name, the tab asks with its protected-send prompt,
    and asks again with `confirmed: true`. A "no" sends nothing. The bundle's environment is never protected, so
    the agent does not ask again. A send the server host makes itself is asked the same way: a host with no
    dialogs answers `needs-confirmation` instead of declining unasked, and the tab sends `request.sendRest` or
    `request.send` again with `confirmed: true`. The desktop asks with its native dialog, as before.
  - What is recorded: the tab trims the agent's exchange as History trims a body (256 Ki characters, with its
    marker) before `exchanges.recordAgentSend`, so a large response never crosses the server socket whole; the
    response's own size goes with it. The send is audited as a send of the server host's own
    (`desktop.request_sent`). A send that fails on the agent carries the HTTP Log's failure row on the error
    (`details.failure`); the tab hands it to `exchanges.recordAgentFailure`, which leaves the same History entry
    and Log row a failed server send leaves (the row alone when it failed while prepared). Both carry the tab's
    `sendId`.
- **No split sends.** A send whose needs span both hosts is not split (§3.4 rule 4). It fails with `secret-missing`
  naming the host that lacks the value.
- **The bundle** holds:
  - the request item and every script in its folder chain;
  - the project's and the active environment's non-secret values; inside a workspace, the environment is written
    as a project one holding the send's env scope, with an address for the container only when that environment
    (or its linked project environment) overrides it, as written, so the container's own address ladder (a SOAP
    endpoint's `trustInvalid`) applies otherwise;
  - the cookie-jar policy;
  - secret references, by name only;
  - the `${#System#…}` names the request reads (`systemNames`), by name only;
  - the project files the request reads, by relative path (a body file, attachments, a proto set), capped at 32 MiB;
  - for a team secret, the workspace's `team-secrets/` subtree.

  The agent writes the bundle to a fresh directory under its temp dir, loads it with the engine's `loadProject`,
  runs the one send path on that one item, and deletes the directory.
- **`sentFrom`.** `sentFrom: 'server' | 'agent'` is an optional field on History entries and the exchange summaries.
  The desktop leaves it out, and the renderer shows a chip only when it is present. The send button shows *Server* or
  *Agent* for the route the next send takes, and the pin.

### 18.5 Secrets on the agent

- **What a bundle send may read.** A bundle send never reads the desktop's own project secrets, and never a
  desktop window's team secrets or secret sources (my call, on review: the bundle names the project, so a server
  that could pick a project id could otherwise have that project's stored secrets sent to a URL it chose). It
  resolves a `${secret:…}` only when the bundle declares that name, and then only from the agent's own namespace,
  `agent:<pairing id>:<workspace id>:<name>` in the host's secret store, or from team secrets below. Everything
  else answers `secret-missing`. Nothing fills the agent namespace in slice 3; a later screen may. The namespace is
  keyed by pairing, not origin: two accounts on one server that pair one machine are two pairings.
- **`${#System#…}` on the agent** (owner's ruling, on review: the agent's whole process environment must not be
  readable by a paired server). A bundle send resolves `${#System#NAME}` only when the bundle declares the name in
  `systemNames` and the name is on this machine's agent allowlist, `allowedSystemNames`, which is empty by default.
  Every other name resolves to nothing, as on the server host, so a request that reads it is refused as
  unresolved. The allowlist is the agent's own setting, kept in its pairings file (version 2) under the same lock,
  and each agent reads and changes its own (`wirebench agent allow-env` the headless agent's, Settings → Paired
  browsers the desktop's; §18.6). The host is handed the cut map
  itself and never falls back to the process environment for a bundle send.
- **Team secrets on a desktop agent.** It resolves a team secret from the values its own approved machine has
  already imported for that workspace, by the bundle's workspace id and the name, exactly as a desktop send does.
  The bundle's `team-secrets/` subtree is used only to check that the value is current (my call: one trust pipeline,
  the desktop's). If the machine is not approved for that workspace, the send fails with
  `team-secret-needs-approval`. The workspace id comes from the bundle, so the hook is asked with the pairing id and
  its server's origin as well, and must confirm the workspace belongs to that server before it answers: a server
  must never name another server's workspace and read its team secrets.
  When the bundle's vault entry for the name is newer than what this machine imported, the send fails with
  `team-secret-stale`: open or sync the workspace on this machine, then send again.
- **Headless agent.** It has no team secrets in slice 3: it has no approved machine key and no UI to request one. A
  team-secret send routed to it fails with `team-secret-needs-approval`, saying to use the desktop app.
- **Secret sources** on the agent wait for #792. A source runs a command on the person's machine, so a mapping that
  arrives in a bundle must not run until this machine approves it (ADR-0020). Until then a source-backed name
  answers `secret-missing` on the agent.
- **Per-pairing state.** Cookie jars, OAuth2 tokens and issued tokens are kept per pairing, in memory, and never
  shared with a desktop window or another pairing, even one of the same origin. A tab cancels only its own
  pairing's sends. At most four sends run per origin.

### 18.6 `wirebench agent` (headless)

- **Bundle.** The CLI bundles `@wirebench/host` and `packages/agent` with esbuild into `dist/agent/bundle.js`, as the
  server bundles its host (§17.3), and loads it only for `wirebench agent`. `kerberos` stays an optional native
  dependency (ADR-0019); `node-pty`, serial and `node-hid` are never loaded.
- **Platform:**
  - `userData` is `~/.wirebench/agent/` (or `$WIREBENCH_AGENT_HOME`), mode `0700`.
  - `secrets` are sealed with AES-256-GCM under a 32-byte key in `agent.key`, mode `0600`, created on first run. The
    CLI has no OS keychain binding, so the file mode is the protection, and the docs say so plainly.
  - Capabilities: `send:private`, `send:public`, `secret-sources`, and `kerberos` when the binding loads. No dialogs,
    shell, power, files, team secrets or listeners.
- **Two agents, separate stores.** The desktop's agent keeps its pairings file, identity and allowlist in its own
  `userData`; the headless agent keeps its own in `~/.wirebench/agent`. Neither reads or changes the other's, and
  both may be paired with one server at once. They share only the port range (each takes the next free port and
  tells its servers) and the `agent-sends/` temp root (one folder per process). A tab with more than one pairing
  picks, for each send, the agent whose hello names what the send's needs ask for (`team-secret` asks
  `team-secrets`, the desktop's; `kerberos` asks `kerberos`), in its usual order otherwise; with none that does, a
  team-secret send answers `team-secret-needs-approval` in the tab, saying to use the desktop app.
- **Commands:**
  - `wirebench agent`: start, print the port, wait.
  - `wirebench agent pair <code> --server <url>`: prints the trust sentence of §3.8 once paired. No `--ssh`
    (§18.1).
  - `wirebench agent unpair [--server <url>] [--local]`: every pairing by default, or that server's, at the
    server and here. A server that cannot be reached is dropped here with a warning that it still lists the
    machine; one that refuses keeps its pairing (exit 3). `--local` forgets it here without asking.
  - `wirebench agent status`: the pairings, the allowlist and whether the agent runs.
  - `wirebench agent allow-env <NAME…>`, `disallow-env <NAME…>`, `allowed-env`: this agent's `${#System#…}`
    allowlist (§18.5), which needs a pairing first.

### 18.7 Testing

- Unit and integration tests per task.
- The agent's allowlist classification test.
- Pairing refused for a wrong origin, a replayed nonce, an expired code, an address past its 20 attempts, the
  server past its 50 failed attempts, and an unpaired agent.
- A send that needs the agent fails cleanly without one.
- The browser e2e of §17.7 gains a headless `wirebench agent` beside the browser, in CI on the runner, outside
  Docker. It pairs through the UI, sends to an echo server on the runner's `127.0.0.1`, and sees `sentFrom: 'agent'`
  on that exchange and `sentFrom: 'server'` on the echo-service send. That is §13 criterion 2 in full.

## 19. Slice 4 amendment: tenancy (2026-10-29)

Slice 4 (#798) makes the server multi-tenant. A self-hosted installation is unchanged to everyone who uses it: one
tenant, created by the migration, whose slug nothing shows and whose `Host` nothing matches. It builds §4.1, §4.2,
§4.4, §5.3, §5.4 and §5.5's lease, the per-tenant data key of §3.5, and the migration of §14. It builds nothing of
slices 5 to 8, which stay gated (§10): no signup, no payment provider, no wildcard names, no `LISTEN`/`NOTIFY`, no
bypass role. §19.12 lists the hooks it leaves for them. Where the build differs from the sections above, this section
wins, and ADR-0032 carries a note of what changed (§19.15). Plan: `docs/plans/2026-10-29-tenancy.md`.

### 19.1 What a reader of the server sees

- Hosted mode exists in the code, and the tests run it with two tenants, but no operator can switch it on yet
  (my call). `WIREBENCH_SERVER_MODE` accepts `self-hosted`, its default. `loadConfig` refuses `hosted` with "hosted
  mode arrives with the control plane", so `serve`, `migrate` and `config check` all refuse it. Tests build a hosted
  `ServerConfig` directly. A half-hosted server, with tenants but no way to create, bill, suspend or delete one, is
  not something to hand an operator.
- **Per-tenant settings are slice 7's** (owner ruling, 2026-10-29). Slice 4 adds no settings table.
  - What the environment configures today stays server-wide: OIDC, SAML, SCIM, audit forwarding, the SMTP sender and
    retention. In slice 7 it becomes the default tenant's settings, and slice 7 moves those into per-tenant rows, so
    that each hosted tenant has its own identity provider (§19.12).
  - **In hosted mode the federated routes answer `404` for every tenant until then:** the OIDC and SAML sign-in
    starts, callbacks and ACS, the SCIM base, and the desktop's OIDC and SAML flows. Otherwise the operator's one
    identity provider, with OIDC's link-by-verified-email rule (`identity/linking.ts`), would sign people into any
    tenant whose admin had created a matching email. A tenant other than the default one, which exists only in
    tests, signs in by local password.
- In hosted mode the egress rule always denies private ranges, whatever `WIREBENCH_SERVER_EGRESS_DENY_PRIVATE` says
  (§17.5, decision 12).
- **The server needs PostgreSQL 15 or later**, for `on delete set null (column)` on composite foreign keys (§19.3).
  Start-up refuses an older server with `server-postgres-too-old`, and the README gains a "Requires PostgreSQL 15 or
  later" line. Until now it only named 16 as the compose image's version.

### 19.2 The `tenants` table (amends §4.1)

```sql
create table tenants (
  id          uuid primary key,
  slug        text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$'),
  name        text not null,
  edition     text not null default 'community' check (edition in ('community', 'team', 'enterprise')),
  status      text not null default 'active' check (status in ('active', 'suspended', 'deleting')),
  region      text not null default 'eu' check (region in ('eu')),
  seats       integer check (seats > 0),
  data_key    bytea,
  created_at  timestamptz not null default now(),
  deleting_at timestamptz
);
create unique index tenants_slug on tenants (slug);
```

- `region` has one allowed value (decision 8). A second region is a new value in the check, not a migration of rows.
- `data_key` is **nullable** (amends §4.1's `not null`): it is the tenant's data key sealed under the server root
  (§19.7), and the root, `WIREBENCH_SERVER_SECRETS_KEY`, is optional on a self-hosted server without the browser
  client (§17.1). A tenant gets its key the first time the root exists.
- `edition`, `seats`, `status` and `deleting_at` are written by slice 7 and read by nothing in self-hosted mode,
  where the license row still decides the edition (§19.8, guard 5). In slice 4 every tenant is `active`.
- The migration creates the **default tenant** on every installation, fresh or upgraded: slug `default`, name
  `Default`, edition `community`, region `eu`, with its id in `server_identity.default_tenant_id`. In hosted mode the
  default tenant holds nothing and is never resolved by `Host` (§19.5).
- `tenants`, `schema_migrations` and `server_identity` are the only tables without `tenant_id`. `server_identity`
  gains `default_tenant_id uuid references tenants` and `tenancy_step text` (§19.10). The control plane's own tables
  (`subscriptions`, `signups`, `tenant_exports`, `tenant_slugs_retired`) are slice 7's, and join the allowlist then.

### 19.3 `tenant_id` on every table (amends §4.1 and §3.9)

The server has 37 tables at migration `0019`, not the 33 §4.1 counted: slices 2 and 3 added `browser_flows` and the
three agent tables. Every one except `schema_migrations` and `server_identity` gains the column, and slice 4 adds one
more scoped table, `host_leases` (§19.9). That makes 36 scoped tables. The rules are mechanical, so the migration
test can check them (§19.8, guard 3):

1. **The column.** At the end of slice 4 it is `tenant_id uuid not null default nullif(current_setting(
   'wirebench.tenant_id', true), '')::uuid references tenants (id)`. Because the default reads the setting, an
   insert inside `withTenant` names no tenant. The repositories' insert statements do not change, except their
   `on conflict` targets: those gain `tenant_id` first (rule 2), and the `license` and `audit_chain_anchor` upserts
   become `on conflict (tenant_id)`, their new primary key (rule 5). Outside a tenant transaction the default is null,
   and the insert fails. Until `0021` the default is the default tenant's id as a constant (§19.10).
2. **Uniqueness.** Every unique index leads with `tenant_id`, and so does every primary key other than a lone `id`
   column **that the server mints**. `users (tenant_id, email_lower)`, `teams (tenant_id, lower(name))` and
   `catch_urls (tenant_id, secret)` follow from that, as do the token, code and state hashes.
   - A minted id (a ULID from `newId()`, or a random token id) is unique on every server, so its primary key stays
     as it is.
   - **`workspaces.id` is not minted.** The desktop sends its local workspace manifest's ULID when it shares a
     workspace (`teams/routes/workspaces.ts`: `body.id ?? newId()`), so one person may share one workspace into two
     tenants. Its primary key is `(tenant_id, id)`. A clash answers `409 workspace-exists` only inside one tenant,
     and a unique check in B can never confirm that an id exists in A.
   - Every other id was checked and is minted by the server.
3. **Composite foreign keys** (my call). Every table referenced by another has a key on `(tenant_id, id)`: the
   `workspaces` primary key, and `unique (tenant_id, id)` on the rest. Every foreign key between scoped tables
   becomes `(tenant_id, x) references parent (tenant_id, id)`.
   - PostgreSQL checks a foreign key without row-level security, so a single-column key would accept a row in
     tenant A that names tenant B's row when a caller passes a foreign id. The composite key makes that row
     impossible to write.
   - `on delete set null` becomes `on delete set null (x)`, so the tenant column is never nulled with it.
   - **Every route that takes a workspace id resolves it inside the request's tenant**, through the policy and the
     composite keys. The live hub, the repo store and the host's checkouts key a workspace by `tenantId:workspaceId`
     (§19.6, §19.8 guard 5).
4. **Listing indexes.** A non-unique index led by a parent id (`workspace_id`, `actor_user_id`, `team_id`, `log_id`
   and the like) stays as it is: the policy adds the tenant filter on top, and the parent id already selects a
   handful of rows. Every other non-unique index leads with `tenant_id`, because every list and every sweep now
   runs inside one tenant.
5. **Singletons.** `license` and `audit_chain_anchor` take `tenant_id` as their primary key: one license and one
   chain anchor per tenant. Their old one-row key columns, `singleton` and `only_row`, **stay**: only their primary
   key is dropped, and their `check` and default are kept, so a revert restores a constraint rather than a column
   (§19.10).
6. **Names are kept.** Every rebuilt key, index and foreign key keeps its `0019` name, written out with `constraint
   <name>` and `create unique index <name>`. Routes map violations by constraint name (`db/errors.ts`), so a new
   default name would turn a `409` or `404` into a `500`. That covers `users_email_lower_key`, `workspaces_pkey`,
   `workspaces_team_id_fkey`, `team_members_team_id_fkey`, `catch_urls_workspace_id_fkey`,
   `captures_catch_url_id_fkey`, `teams_name_lower`, `invitations_one_open_per_email`, the `*_workspace_name_lower`
   indexes and the `scim_*_lower` indexes. A revert needs the same names.

Per table, beyond rule 1 (`+t` means the key or index gains `tenant_id` first):

| Module | Table | Keys and indexes after slice 4 |
| --- | --- | --- |
| host | `workspaces` | primary key `(tenant_id, id)` (rule 2: a client-supplied id); `(team_id, lower(name))` +t |
| identity | `users` | `unique (tenant_id, id)`; `email_lower` +t |
| | `local_credentials` | primary key `user_id` +t |
| | `oidc_identities` | primary key `(issuer, subject)` +t: two tenants may trust one issuer |
| | `invitations` | `unique (tenant_id, id)`; `secret_hash` +t; one open invite per email +t |
| | `device_tokens` | `token_hash` +t; `kind` unchanged |
| | `oidc_flows`, `browser_flows` | `state`, `grant_hash`, `state_hash` +t |
| teams-access | `teams` | `unique (tenant_id, id)`; `lower(name)` +t |
| | `team_members` | primary key `(team_id, user_id)` +t, the target of `provisioned_memberships`' key |
| | `team_invitations`, `workspace_grants` | primary keys +t |
| licensing | `license` | primary key `tenant_id`; `singleton` kept (rule 5) |
| ci-tokens | `ci_tokens` | `token_hash` +t; live `(workspace_id, lower(name))` +t |
| webhook-capture | `catch_urls` | `unique (tenant_id, id)`; `secret` +t; `(workspace_id, lower(name))` +t |
| | `captures` | `captures_received_at` +t (retention) |
| scheduled-runs | `schedules`, `schedule_runs` | `unique (tenant_id, id)`; `schedules_due`, `schedule_runs_open`, `schedule_runs_queued_at` +t |
| | `schedule_results` | primary key `(run_id, ordinal)` +t |
| | `schedule_alert_outbox` | both partial indexes +t |
| audit-log | `audit_events` | `unique (tenant_id, id)`; `chain_seq` +t: one chain per tenant; `audit_events_at`, `audit_events_action_at`, `audit_events_unsealed` +t; `_workspace_at`, `_actor_at`, `_team_at` stay (rule 4) |
| | `audit_forward_queue` | primary key `event_id` +t |
| | `audit_chain_anchor` | primary key `tenant_id`; `only_row` kept (rule 5) |
| sso | `saml_identities` | primary key `(entity_id, name_id)` +t |
| | `saml_flows` | `request_id`, `relay_state`, `grant_hash` +t |
| | `scim_tokens` | `token_hash` +t; live `lower(name)` +t |
| | `scim_users`, `scim_group_members`, `provisioned_memberships` | primary keys +t |
| | `scim_groups` | `unique (tenant_id, id)`; `lower(display_name)` +t |
| session-logs | `session_logs` | `unique (tenant_id, id)`; `(workspace_id, user_id, client_log_id)` +t; `last_write_at` +t |
| | `session_log_chunks` | primary key `(log_id, offset_bytes)` +t |
| agent | `agent_pairings` | `unique (tenant_id, id)`; `(user_id, agent_id)` +t |
| | `agent_pairing_codes` | primary key `code_hash` +t, so two tenants may hold one code; `user_id` +t |
| | `agent_nonces` | primary key `nonce_hash` +t; `expires_at` +t |
| tenancy | `host_leases` | primary key `(tenant_id, user_id)` (§19.9) |

Everything per user (credentials, identities, device tokens, pairings, codes, nonces, session logs, leases) is per
tenant through its own column, not only through `users`. The same email in two tenants is two users.

### 19.4 Row-level security and the database roles (amends §4.2)

- **The policy.** Migration `0020` creates `tenant_scope(t regclass)`. The function runs `enable row level security`
  and `force row level security`, then creates one permissive policy for every command and every role:
  `create policy tenant_isolation on t for all to public using (tenant_id = nullif(current_setting(
  'wirebench.tenant_id', true), '')::uuid) with check (` the same `)`.
  - `0021` calls it for the 36 tables, named one by one (my call: an explicit list, not every table in the schema,
    so a table someone forgot is caught by the test rather than scoped by accident).
  - Every later migration that creates a table calls it in the same file.
  - The setting is `wirebench.tenant_id`, as §4.2 names it. **Forced** row-level security is an owner ruling, and
    stays.
- **Per unit of work.**
  - `withTenant(scope, fn)` takes a pool client, runs `begin`, then `select set_config('wirebench.tenant_id', $1,
    true)`, then `fn`, and commits or rolls back. The third argument makes the setting transaction-local, so a
    connection goes back to the pool with no tenant on it. `set local` is not used, because it takes no bind
    parameter (amends ADR-0032, §19.15).
  - **A client in doubt is destroyed, never reused.** When `rollback` throws, or the client is not idle once the unit
    ends, `withTenant` calls `client.release(error)`, which ends the connection, instead of returning it to the pool
    still inside a transaction. Today's `db/pool.ts` swallows a failed `rollback` and releases the client normally.
  - **The querier handed to `fn` is revoked** at commit or rollback. A later `query` on it, from an un-awaited call,
    throws `tenancy-scope-ended` rather than running on whatever transaction that pooled client is in next.
- **Unset means deny.** Outside a tenant transaction the setting is empty, the policy compares with null, and every
  scoped table reads as empty. An insert fails twice over: the column default is null, and `with check` refuses.
  An insert that names another tenant's `tenant_id` explicitly fails `with check` (SQLSTATE `42501`). Nothing raises
  from the policy itself (`missing_ok`).
- **Two roles** (my call). The owner of the schema runs migrations; the app role runs every query.
  - **The owner role** owns the schema, the tables and `tenant_scope()`. It is the role in the new
    `WIREBENCH_SERVER_MIGRATION_DATABASE_URL`, and in `WIREBENCH_SERVER_DATABASE_URL` when that variable is unset.
    Migrations, `admin tenancy role` and `admin tenancy revert` connect as it.
  - **The app role** is the role in `WIREBENCH_SERVER_DATABASE_URL`. It is neither superuser, nor `BYPASSRLS`, nor
    owner. Being no owner, it is under every policy whether forced or not. It holds:
    - `usage` on the schema;
    - `select, insert, update, delete` on every scoped table and on `tenants`;
    - `select` only on `schema_migrations`;
    - on `server_identity`, `select`, and `update` of the columns the server writes (`tenancy_step`);
    - default privileges for scoped tables the owner creates later.

    It has no `execute` on `tenant_scope()` or `for_each_tenant()`.
  - **`force`** is what puts the owner under the policy too, so a one-role installation still isolates tenants. It
    is also why the owner is not the role to back up as or to run a data migration as (below).
  - **Data migrations.** From `0022` on, a migration that updates or inserts rows in a scoped table either runs per
    tenant through the `for_each_tenant(sql)` helper that `0021` ships, or brackets its statements with `alter table
    … no force row level security` and `… force row level security` inside its own transaction.
    - Other sessions never see the unforced state: the `alter table` holds `ACCESS EXCLUSIVE` until commit.
    - Without either, a back-fill like `0010`'s would touch no row and still succeed on a non-superuser owner. It
      would work on compose, where the owner is a superuser, which is why the check is textual as well as
      catalogued.
    - The migration test therefore checks two things. Every scoped table has `relforcerowsecurity` on after the last
      migration. And, as a lint, every migration from `0022` on that holds an `insert`, `update` or `delete` on a
      scoped table also holds `for_each_tenant(` or the bracket.
    - **The statement filters on the setting itself.** A migration role that bypasses the policy (a superuser,
      as the compose owner is, or `BYPASSRLS`) sees every tenant's rows on each pass, so a statement run
      through `for_each_tenant` names `tenant_id = nullif(current_setting('wirebench.tenant_id', true),
      '')::uuid` in each table it reads or writes. The lint refuses a call without it.
    - `0021` revokes `execute` on `for_each_tenant(text)` and `tenant_scope(regclass)` from `public`, so only the
      owner can call them. `check:tenant-scope` refuses `for_each_tenant` anywhere in `src/`: it is a loop across
      every tenant, which no request may hold.
  - **Backups.** `pg_dump` as the app role, or as a non-superuser owner, refuses a scoped table (`row_security` is
    off by default in `pg_dump`) or, with `--enable-row-security`, dumps it empty. Back up as a superuser or a
    dedicated `BYPASSRLS` backup role. The README says so, and `admin tenancy check` and `admin tenancy status`
    print it. On the default compose installation the owner, `wirebench`, is a superuser, so existing backup
    scripts keep working.
- **When the server's role bypasses** (owner ruling, 2026-10-29). PostgreSQL applies no policy, forced or not, to a
  superuser or a role with `BYPASSRLS`. At start-up the server reads `rolsuper`, `rolbypassrls` and table ownership
  for the app role:
  - In hosted mode, a superuser, `BYPASSRLS` or owning app role refuses start-up with `tenancy-role-bypasses`. The
    owning case is my call: an owner can switch the policy off with one statement.
  - In self-hosted mode it is a warning in the start-up log and in `admin tenancy check`, because one tenant has
    nobody to leak to and an upgrade must not stop a working server. `config check` does not connect to the
    database today, so it does not gain the warning.
  - New compose installations get a non-superuser app role (below).
- **Existing installations keep upgrading** (owner ruling). The old URL keeps working and nothing has to move:
  - **An existing installation that keeps its environment** (one URL, often the compose image's bootstrap
    superuser) upgrades as before, with the warning. The one role is both owner and app role.
  - **The new `compose.yaml`** sets two URLs: the migration URL on `wirebench`, the owner every existing compose
    volume already has, and the app URL on `wirebench_app`. At start-up, before connecting as the app role, the
    server connects as the owner and runs `admin tenancy role` whenever the two URLs differ. The command is
    idempotent: it creates the app role when it is missing and the owner may create roles, and it re-applies the
    grants every time. An old volume with the new compose file therefore starts, and so does a new one. The
    `docker-entrypoint-initdb.d` route was not taken, because it runs only on an empty volume.
  - **`admin tenancy role`** runs as the owner.
    - It creates the app role if it is missing (`login nosuperuser nobypassrls noinherit`).
    - It names the role with `format('%I')`. It sets the password as a SCRAM-SHA-256 verifier computed in Node from
      the app URL's password, never as plaintext in `create role … password`, which `log_statement = ddl` would
      write to the database's log.
    - It grants the privileges above, and sets the default privileges.
    - With `--print-sql` it prints the statements instead, for an operator whose owner may not create roles.
  - **No ownership moves.** The app role is a grantee, not the
    owner, so the tables stay with the owner they have. PostgreSQL refuses `reassign owned by` the bootstrap
    superuser, which is the reason a design that made the app role the owner would have had to move every object
    by hand.
  - **The operator's switch**, outside compose:
    1. Run `wirebench-server admin tenancy role` (or apply its `--print-sql`) as the owner.
    2. Set `WIREBENCH_SERVER_MIGRATION_DATABASE_URL` to the owner and `WIREBENCH_SERVER_DATABASE_URL` to the app
       role.
    3. Restart.

    `admin tenancy check` then reports the app role as isolating. Going back is pointing
    `WIREBENCH_SERVER_DATABASE_URL` at the owner again and unsetting the migration URL. Unsetting the migration URL
    alone would leave migrations running as the app role, which owns nothing, so the next migration would fail.
- **Two role names in tests.** CI and the test helper use a non-superuser owner, `wirebench_owner`, which stands for
  a managed database's owner role and owns each test file's schema (`create schema … authorization
  wirebench_owner`), and `wirebench_app` for queries. Production compose has `wirebench`, the superuser owner, and
  `wirebench_app`. A test asserts both test roles' attributes (§19.13), so no test passes against a policy that does
  not apply.

### 19.5 Tenant resolution (amends §5.3)

- **One hook, first.** A root-level `onRequest` hook, registered before every module, sets `request.tenant` to a
  `TenantScope` (`{ tenantId, slug }`, branded, built only by the resolver, the job loop and the admin command line).
  It covers `/api/v1`, the public routes (`/sign-in`, `/invite/…`, `/hooks/…`, `/scim/v2`) and every WebSocket
  upgrade, which pass through the same hooks. `/health` reads no tenant row and takes none.
- **Self-hosted.** The scope is always the default tenant. The `Host` header is not read, so an installation reached
  by any name, or by several, keeps working.
- **Hosted.** `request.hostname` (which honours `WIREBENCH_SERVER_TRUST_PROXY`), lower-cased, port stripped, must be
  exactly one label followed by `.<appDomain>`. The label is looked up in an in-memory map of active tenants by slug,
  leaving out the default tenant. Anything else answers `404` with an empty body and `cache-control: no-store`, so
  the answer names nothing. A `suspended` or `deleting` tenant also answers `404` in slice 4; slice 7 gives each its
  page.
- **The map** is loaded at start-up and reloaded after any write through the tenant directory in this process, and
  every 60 s (my call). Slice 5 replaces the poll with a notification. It is keyed by full host name, so a custom
  name (slice 8) is one more entry.
- **`appDomain`** is a `ServerConfig` field that only tests set in slice 4. Slice 6 gives it its environment
  variable.
- **The tenant's own URL.** `tenantUrl(scope)` is the self-hosted `WIREBENCH_SERVER_PUBLIC_URL`, or
  `https://<slug>.<appDomain>` in hosted mode. Every place that compares with or prints the public URL for a tenant
  reads it:
  - the cookie session's `Origin` check (§17.2), the host socket's and the terminal-share socket's `Origin` checks;
  - the cookie's `Secure` choice, and the flow cookie's (§17.2);
  - `safeRedirectPath` in the browser flows;
  - the OIDC redirect URI, the OIDC and SAML callback and ACS URLs, the SAML entity id and the SCIM base;
  - invitation links, alert links (`schedules/settings.ts`, `alerts/outbox.ts`), and a catch URL's `url` field;
  - the agent's pairing `origin` (§18.2);
  - the host's in-process transport, which sends each `inject` with the tenant's `Host` so that it resolves to the
    same tenant.
- **Values computed at registration** (`settings.publicUrl`, `ssoUrls(…)`, identity's `redirectUri`) become functions
  of the request's scope.
- **The compiler is the guard.** `config.publicUrl` is gone from the config type that modules see, and only
  `src/tenancy/urls.ts` holds it (§19.8, guard 2). The start-up and `migrate` output in `main.ts` and `serve.ts` is
  the operator's and keeps printing the configured URL, through `operatorPublicUrl()`, which `urls.ts` exports for
  those two files only.
- **Outside a request.** A job takes its scope from the job loop (§19.8, guard 6). An admin command takes it from
  `--tenant <slug>` in hosted mode, or the default tenant in self-hosted mode (§19.11).

### 19.6 Per-tenant directories (amends §3.3, §4.4 and §17.3)

```
<dataDir>/
  no-hooks/                        # stays here: every repository's core.hooksPath names this absolute path
  tenants/<tenantId>/
    repos/<workspaceId>.git        # was <dataDir>/repos
    checkouts/<userId>/            # the user's host userData (§17.3), its workspaces/ beneath; was <dataDir>/checkouts
    tmp/                           # staging, moved-away repositories, sync's index files, the schedules' commit store
    tmp/schedules/                 # scheduled runs' working copies; was <dataDir>/tmp/schedules
    tmp/hosts/<userId>/            # one host's scratch directory, removed at eviction; was <dataDir>/tmp/<userId>
```

- **`tenantRoot(dataDir, scope)`** is the one function that builds `tenants/<id>`. It accepts only a canonical
  lower-case UUID, and refuses a root that is a symlink or that resolves outside `<dataDir>/tenants`.
  - The repo store's `path`, `create`, `remove` and `withLock` take the scope first, and the lock is keyed
    `tenantId:workspaceId`. Two tenants with one workspace id (§19.3) get two repositories.
  - `hostDirectories(dataDir, scope, userId)` builds on it.
  - The scheduled-runs module's `CommitStore` and run copies (`schedules/module.ts`) take the tenant's `tmp/`.
  - The server platform's path guard (§17.3) is unchanged, so a host still cannot leave its checkout, and so cannot
    reach another tenant's.
- `no-hooks/` stays at the data directory's root, because each bare repository's config holds its absolute path.
  Moving it would mean rewriting every repository's config.
- `RepoStore.prepare` makes `tenants/` and `no-hooks/` only, and the start-up writability check moves from `repos/`
  and `tmp/` to `tenants/`.
- The move itself is §19.10's file step.

### 19.7 Data keys (amends §3.5 and §17.4; ADR-0036)

- **The hierarchy.** The server root `WIREBENCH_SERVER_SECRETS_KEY` wraps one data key per tenant. The data key is
  32 random bytes, sealed with the secret box (AES-256-GCM) under a wrapping key that HKDF derives from the root with
  the tenant id as `info` (`salt = 'wirebench-tenant-data-key'`). A wrapped key copied onto another tenant's row
  therefore does not open. The result is `tenants.data_key`.
- **The user key** that seals a host's `secrets.json` entries and its cookie jars becomes
  `HKDF(dataKey, 'wirebench-host-secrets', userId)`: §17.4's derivation, with the tenant's data key in place of the
  root. One user's files do not open under another user's key, nor under another tenant's.
- **The cache.** Unwrapped data keys are kept in memory per tenant for the life of the process, and are dropped when
  the tenant's row changes. Until slice 5's notification, only a change made in this process drops one.
- **When the key is made.**
  - With the root configured, a tenant's key is created with the tenant, and for the default tenant by the tenancy
    migration's key step (§19.10).
  - Without the root, `data_key` stays null and nothing is sealed, since the browser client cannot be on without the
    root (§17.1). The key is created the first time the root exists.
  - A lazy creation is a compare-and-set: `update tenants set data_key = $1 where id = $2 and data_key is null
    returning id`. A process that loses re-reads the row and uses the winner's key.
- **A root that no longer opens the key.** A stored data key that does not open under the configured root (the
  key was changed) refuses every host of that tenant with `4503` until the old root is restored. The server logs the
  code and the tenant id, never a key; `admin tenancy status` reports whether the key opens.
- **The one-time re-wrap.** Every blob the server platform sealed before slice 4 is under the old per-user key,
  `HKDF(root, …, userId)`. The key step re-seals each one under the new user key. The step must finish before any
  host opens, because a blob the cookie store cannot open is set aside as `.corrupt` (`cookie-store.ts`): a
  half-done re-wrap would lose cookie jars quietly rather than fail (§19.10). Each file is written durably before the
  step records `done`, after which the old key opens nothing. At `done` the same idempotent re-wrap runs again at
  every start-up and `migrate`, so a user's directory restored from a backup made before the upgrade is re-sealed
  before a host opens it.
- **No `tenant_secrets` table** (my call; amends §3.5 and §4.3, settles §17.4's deferral). The host's own
  `SecretStore` is the one resolver of a sealed name, and its file is already per user inside the tenant's
  directory, under the tenant's key. A table would be a second store beside it, and would not change who can read a
  value. The table is for the workspace scope §3.5 deferred, which needs a value shared across users that a per-user
  file cannot hold. It arrives with that scope.
- **What stays server-wide** (my call):
  - The hooks and schedules keys, as §3.5 says. Their sealed values are rows under row-level security, and slice 7's
    deletion removes the rows.
  - The agent pairing-code HMAC key (§18.2). Codes live ten minutes, and their rows are scoped.
- **The audit chain key** (my call).
  - **Self-hosted:** the default tenant's chain keeps `WIREBENCH_SERVER_AUDIT_CHAIN_KEY`, under which its rows are
    already sealed, and no migration may update a sealed row (`0012`).
  - **Every other tenant** has its chain keyed by `HKDF(chainKey, 'wirebench-audit-chain', tenantId)`, recorded by
    its fingerprint in the tenant's anchor `key_id`.
  - **In hosted mode** every tenant's key is derived, the default tenant's included. The default tenant holds no
    rows there, since a hosted server starts fresh (§14). The configured key itself then seals nothing and is never
    exported.
  - A tenant's export can then be verified with its own key, without handing out the key of any other chain (§13
    criterion 6, slice 7).
- **Shredding and rotation.**
  - Deleting a tenant (slice 7) clears `data_key`. Every file of the tenant is unreadable **once every database
    backup older than the deletion has expired**: such a backup still holds the wrapped key, and the root still
    opens it. Keeping backup retention short is an operations duty of slice 7, where deletion is held 14 days
    (§3.6).
  - Rotating the root re-wraps one column, not every blob.

### 19.8 The six guards, made concrete (amends §5.4)

1. **Forced row-level security** on the 36 scoped tables (§19.4), queried by an app role that cannot bypass it:
   refused at start-up in hosted mode, warned about in self-hosted mode, and asserted in CI.
2. **The scope in the signature.**
   - `ServerContext.db` goes away. Modules get `ctx.tenancy`, whose `db(scope)` returns a `TenantDb` bound to that
     tenant.
   - Its `query` runs one statement in its own short tenant transaction, and its `transaction(fn)` runs a unit of
     work as one. Both are branded types (`TenantQuerier`), constructible only in `src/tenancy/`. A `TenantQuerier`
     carries its `TenantScope`, which is how ADR-0032's "repositories take a `TenantScope` first" is met (§19.15).
   - Every repository function takes a `TenantQuerier` first, where it took a `Querier`. A call with the raw pool, or
     with no scope, does not compile.
   - `ServerConfig.publicUrl` is not in the config type modules see (§19.5).
   - A script gate in `pnpm check`, `check:tenant-scope`, is the backstop. Outside `src/tenancy/` it refuses:
     - an import of `db/pool.ts` or of the raw `Querier` type (`src/db/` excepted);
     - any `publicUrl` read or destructuring of the config, and `operatorPublicUrl(` outside `main.ts` and
       `serve.ts`;
     - `set_config`, `wirebench.tenant_id`, and SQL that names `from tenants` or `join tenants`;
     - `for_each_tenant` (§19.4);
     - `defaultScope(`, except in the admin command line's self-hosted default (§19.11). A route or a module that
       reached for the default tenant would pass every one-tenant test, so the call itself is refused.
   - A single statement in its own transaction costs three extra round trips. `pnpm test:perf` measures a typical
     route's query count before and after, and a route that regresses groups its statements into one `transaction`.
3. **The migration test.** It reads the catalog after every migration has run, and fails when a table outside the
   allowlist (`schema_migrations`, `server_identity`, `tenants`) lacks any of these:
   - `tenant_id uuid not null` with the setting default;
   - `relrowsecurity` and `relforcerowsecurity`;
   - exactly one policy, `tenant_isolation`: permissive, `polcmd = '*'`, `polroles = {0}` (public), and with `using`
     and `with check` both the expression above;
   - `tenant_id` first in every unique index and in every primary key that is not a lone minted `id`;
   - composite foreign keys only, between scoped tables;
   - the `0019` names of every rebuilt key, index and foreign key (§19.3, rule 6).
4. **Two tenants per module, and a sweep.** Each module gains a two-tenant case once `0021` forces the policy
   (§19.13), run as the app role. Above those, one isolation suite tries every scoped table and every registered
   route, with positive controls so that it fails when the policy is off (§19.13).
5. **Keyed by tenant first:**
   - The live hub: subscriptions are keyed `tenantId:workspaceId`, and every announcement (`headMoved`,
     `accessChanged`, `sessionEnded`, `captureReceived`, `hooksChanged`, `scheduleRunFinished`, `agentUnpaired`,
     `licenseChanged`) carries `tenantId`.
   - The terminal-share registry.
   - The host instances, keyed `tenantId:userId`.
   - The repo store's paths and locks (§19.6).
   - Every rate limiter: sign-in per address and per email, hooks per workspace, pairing per address, nonce
     redemption. Pairing's server-wide budget of 50 failed attempts in ten minutes (§18.2) becomes **per tenant**
     (amends §18.2): server-wide, one tenant's attacker would shut pairing for every customer.
   - **Advisory locks** take the two-int form with the schema and the tenant hashed together, so test schemas and
     tenants never share one:
     - the seat lock: `pg_advisory_xact_lock(SEAT_LOCK_KEY, hashtext(current_schema() || ':' || tenant_id::text))`;
     - the audit chain lock: `pg_try_advisory_xact_lock(AUDIT_CHAIN_LOCK_CLASS, hashtext(current_schema() || ':' ||
       tenant_id::text))`;
     - the host-lease lock of §19.9, likewise.

     In code, `current_schema()` here is the server's schema, `SERVER_SCHEMA` (the schema `server_identity` lives
     in, else `current_schema()`), and the tenant is the unit's own tenant id. The two give the same key in every
     real deployment, and the seat, chain and host-lease locks all use that one form.
   - Seats are counted per tenant by the policy itself. The licensing service's `state(scope)` takes the tenant; in
     self-hosted mode it reads that tenant's license row, and in hosted mode, from slice 7, `tenants.edition`.
   - Scheduled runs:
     - the per-server concurrency cap is unchanged;
     - queued runs start round-robin across tenants (my call), whether a pass starts them or a finished run's
       `launch().finally` does, so one tenant's backlog cannot starve another's schedules;
     - the in-flight map and `cancel(runId)` are keyed `tenantId:runId`.
6. **The job scope.** `forEachTenant(job, fn)` reads tenant ids through the tenant directory, the one unscoped read
   (`select id, slug from tenants where status <> 'deleting'`), then runs `fn` in one `withTenant` per tenant. A
   suspended tenant's data is kept and still ages out. One tenant's failure is logged with the job name and the
   tenant id, and does not stop the others. The jobs:
   - the scheduler's pass, which fires due schedules, starts queued runs and ends interrupted ones. Its license
     check (`license().state()`, read once per pass today) moves inside the loop, so a tenant without
     `scheduled-runs` skips only its own schedules;
   - the alert outbox;
   - the audit sealer, retention and forwarder;
   - the audit module's license listener (`audit-log/license-listener.ts`), which writes an event after commit,
     outside any request: it takes the announcement's `tenantId` and writes in that tenant's `withTenant`;
   - capture retention;
   - session-log retention;
   - the identity sweep (expired tokens, invitations and flows), the SSO sweep and the agent sweep.

   The live hub's two queries (`effectiveRole`, `workspaceIdsOfTeam`) take the scope from the socket's session. No
   bypass is built (my call; amends ADR-0032, §19.15): §5.4's "named, allowlisted bypass" was for the scheduler's
   pick-up, and a pick-up per tenant needs none. A job that measurably does need one waits for slice 5's per-tenant
   budgets, with its own audited role.

### 19.9 The host-instance lease and the instance cap (amends §5.5 and §17.3)

- **The table.** `host_leases(tenant_id, user_id, holder text, acquired_at, renewed_at, expires_at)`, primary key
  `(tenant_id, user_id)`, scoped like every other table. Its user key is composite and cascades on delete. `holder`
  is the server process's id: random at start-up, and logged. A row with an expiry replaces §5.5's "advisory lock
  held by a heartbeat row" (§19.15): a session-level advisory lock would pin one pool connection per live host.
- **Taking it.** Before `createHost`, the first socket of a user takes the lease in one tenant transaction:
  - take the tenant's lease lock (`pg_advisory_xact_lock(HOST_LEASE_CLASS, hashtext(current_schema() || ':' ||
    tenant_id::text))`);
  - delete the tenant's expired leases;
  - check the cap (below);
  - then `insert … on conflict (tenant_id, user_id) do update … where host_leases.holder = $holder or
    host_leases.expires_at < now() returning user_id`.

  No row back means another process holds the user. The socket closes `4409` with reason `host-lease-held` and a
  `retryAfterMs` of the lease's remaining time. The bootstrap's reconnect backoff (§17.6) waits at least that long.
- **Keeping it.**
  - Leases last 60 s. Every 15 s the process renews them with one statement for each tenant **that has an instance
    in this process** (`update … where holder = $holder and user_id = any($held) returning user_id`), not for every
    tenant. Naming the held users means a row whose release failed is not renewed for the life of the process.
  - A lease missing from that answer was lost: its instance closes its sockets `4409 host-lease-lost` and is
    disposed.
  - A process that has not renewed for 30 s by its own monotonic clock stops its instances on its own, half a lease
    before anyone else could take them, so two processes never write one checkout (§5.5). Database time sets the
    expiry; local time only decides when to stop early. Those sockets close `4409 host-lease-expired`: no other
    process has the user, so the tab says only that the connection was lost.
  - A renew that has had no answer for half a renew interval (a half-open connection can take minutes to fail)
    no longer holds back the tenant's next one, so the leases taken after the database answers again are renewed.
- **Giving it back.** Eviction deletes the lease after the host's quit path has run. Shutdown releases every lease
  after `closeAll`. Either waits at most 5 s for the delete; a lease left behind expires on its own. The delete
  names the take's `acquired_at` (`… where user_id = $user and holder = $holder and acquired_at = $acquired`), so a
  delete that gave up and arrives after this process took the user again leaves the new lease alone.
- **After a crash.** A self-hosted server is one process (ADR-0013), so in self-hosted mode start-up deletes every
  lease it finds, through `forEachTenant`, since the app role outside a tenant sees no row. A crash and restart then
  do not keep users out for a minute (my call). A start-before-stop restart lets both processes serve a user until
  the old process's next renew (at most 15 s, plus its hosts' quit path); a self-hosted restart stops the old
  process first. A hosted process leaves leases to expire. A multi-instance
  self-hosted server (slice 5) must drop the start-up delete (§19.12).
- **The cap** (decision 11).
  - A tenant holds at most its seat limit of live leases (`LicenseService.state(scope)`; none when the limit is
    null), counted across processes in the same transaction.
  - At the cap, this process first evicts its own idle instances of that tenant (no sockets, idle timer running),
    oldest first, and counts again.
  - Still at the cap, the socket closes `4429` with reason `host-instance-cap`, and the tab says that every seat of
    the team has a browser host open (my call).
  - `4429` then has two reasons, this one and §17.3's ninth socket of one user (`too many host sockets`), so the
    bootstrap branches on the reason for its message.
  - At the cap, a user whose own lease another process holds gets `4409 host-lease-held` with its remaining time,
    as below the cap, and nothing is evicted for them: their host is open elsewhere, and a seat freed here would
    not let them in. The user's own row is never counted against them.
  - An eviction whose lease release fails or goes unanswered frees no seat (the row stays until it expires), so the
    open stops there with `4429` rather than evict the tenant's other idle instances in turn. While the database is
    slow, a capped open therefore evicts at most one idle instance. A release whose delete answered (even with no
    row left to match), or that had nothing to delete, has freed its seat.
  - With seats binding users, a self-hosted server reaches the cap only after a license downgrade below its enabled
    users.
- **Unchanged.** Idle eviction after `WIREBENCH_SERVER_HOST_IDLE_MINUTES` (default 30), and eight sockets per user.

### 19.10 The self-hosted migration (amends §14)

Two forward steps, each resumable; a way back, also resumable; and a stated cost.

- **Before the upgrade.** `wirebench-server admin tenancy check` runs from the new image against the old database,
  read-only. It reports:
  - the PostgreSQL version, whether the app role isolates (§19.4), and the backup-role advice;
  - whether `tenants/` can be created on the same filesystem as `repos/`, since the move is a rename, never a copy;
  - each table's row count, read from `pg_class.reltuples` so that it is right before and after the upgrade and
    under any role, its `pg_relation_size` and `pg_total_relation_size`, and an estimated duration (below);
  - any path the move would not know.

  The upgrade notes say to stop every server process and to back up the database (as the backup role, §19.4) and the
  data directory first.
- **How long the server is down.** Only the column add is catalog-only. In one transaction under `ACCESS
  EXCLUSIVE`, `0020` then validates a new foreign key to `tenants` on every scoped table, rebuilds every primary key
  and unique index plus the listing indexes of rule 4, and validates every composite foreign key. Each of those is
  one pass over a table's rows. So the cost is about:

  `T ≈ Σ over tables of passes × (rows ÷ R + pg_relation_size ÷ B)`, where `passes = 1 + rebuilt indexes +
  composite foreign keys`

  - **The basis for `R`** is reasoned, to be measured. A B-tree build sorts a `uuid` and a short text key from the
    heap, and a key validation is one anti-join per key, which the formula overcounts as a pass. Both run at about
    0.5 to 1 million rows a second, single threaded, on a two-vCPU SSD machine with `maintenance_work_mem` at
    256 MB, which `0020` sets with `set local`.
  - **The heap term.** Every pass also reads the heap, at a sequential scan rate `B` of about 200 to 500 MB a second
    from SSD (less from cache-cold disk). Values over about 2 KB in `captures.body` and `session_log_chunks.data` sit
    in TOAST, which no pass reads, but smaller ones stay in the heap, so `pg_relation_size`, not the row count, is
    what that term reads.
  - **`analyze`.** `0020` ends with `analyze` on every scoped table. Its new leading `tenant_id` columns have no
    statistics until autovacuum reaches them, and the planner would choose badly until then. That costs one sampled
    pass per table, a few seconds in all.
  - **For `audit_events`** (about seven passes: the tenant key, `unique (tenant_id, id)`, `chain_seq`, three listing
    indexes, plus the heap), 5 million rows in about 1 GB of heap take about `7 × (5 to 10 s + 2 to 5 s)`, so 50 to
    105 seconds.
  - **A typical installation** with under a million rows in all is down for under a minute.
  - **The measurement.** A perf test (plan Task 4) migrates a scaled fixture (1 million `audit_events`, 1 million
    `captures`, 2 GB of `session_log_chunks`) and records `R`. The upgrade notes give the measured minutes per
    million rows, and `admin tenancy check` uses it.
- **Step 1: rows, in SQL.** Migrations `0020` and `0021`, each one transaction (the migration runner's rule), run as
  the owner role:
  - `0020` creates `tenants` and the default tenant, sets `server_identity.default_tenant_id` and
    `tenancy_step = 'files'`, and creates `tenant_scope()` and `host_leases`.
  - For each table, `0020` adds `tenant_id` with the default tenant's id as a **constant** default, which is a
    catalog-only change: no row is rewritten, so sealed audit rows keep their bytes (`0012`'s rule). It then rebuilds
    the keys, indexes and foreign keys of §19.3, under their `0019` names.
  - `0021`, two pull requests later (amends §14's "one transaction for rows"; §19.15), switches each column's default
    to the setting expression, calls `tenant_scope()` on the 36 tables, and creates `for_each_tenant()`.
  - A crash rolls back the migration it was in, and the next start-up runs it again.
- **Step 2: files, at start-up.** It also runs from `wirebench-server migrate`. **The start-up order** is: the
  left-behind check (below), the migrations, then this step, then `RepoStore.prepare` (now making only `tenants/` and
  `no-hooks/`) and the writability check of `tenants/`, then `buildServer`. `prepare` can therefore never make an
  empty `repos/` beside a half-moved one.
  - **One unit.** The step runs in one transaction on the migration URL's connection, under
    `pg_advisory_xact_lock(FILE_STEP_CLASS, hashtext(current_schema()))`, so two processes never move the same
    directory. A kill or a refusal rolls `tenancy_step` back to where the unit found it, and the next start resumes:
    every part is due or done by what is on disk.
  - **`tenancy_step`** takes `files`, `keys`, `done`, and the revert's `reverting-keys`, `reverting-files` and
    `reverting-rows`. A `reverting-*` step refuses the forward step (`tenancy-reverting`) **first**, before the
    re-arm and before the check at `done`: a revert's renames back to the root look exactly like what the re-arm
    reacts to, and its `back` re-wrap is what the check would undo. A database before `0020` has no step.
  - **`files`:**
    - Rename `repos/` and `checkouts/` into `tenants/<defaultId>/`. A rename is done when the source is gone and the
      destination is there, and is due when the reverse holds.
    - From the old `tmp/`, move the `removed-…` repositories, which are deleted workspaces kept on purpose, into the
      tenant's `tmp/`, and delete the rest. The rest is scratch that is rebuilt as needed: `creating-…` staging,
      sync's index files, `tmp/schedules/` run copies, and the hosts' `tmp/<userId>/` directories.
    - Check the users' state files for the old absolute prefix (`<dataDir>/checkouts/`). A server host cannot create
      a linked project, but a file that holds one is listed and refuses the step, rather than breaking later. The
      test runs this check on a checkout a real host wrote with a server workspace open, so ordinary installations
      pass.
    - **Refusals.** A pre-flight that only reads makes every one before anything moves, so a refused step changes
      nothing on disk and stays `files`:
      - `tenancy-move-conflict`: a directory (or a kept `removed-…`) is in both its old and its new place; names
        both.
      - `tenancy-move-link`: a source is a symbolic link; the new layout follows no link.
      - `tenancy-move-cross-device`: a source is on another filesystem than the data directory, where a rename
        cannot go.
      - `tenancy-prefix-found`: a state file names the old checkouts path; names the file.
      - `tenancy-data-dir-empty`: the data directory holds no repositories or checkouts while the database has
        workspaces or browser sign-ins, so it is not the server's own. Start-up exits `2`. `migrate` exits `0` with
        a note: the schema is migrated, and the server moves its real directory at its next start (the image's empty
        `/data` with no volume mounted).
    - Then `tenancy_step = 'keys'`.
  - **`keys`:**
    - With the root configured, create the default tenant's data key and re-wrap every blob (§19.7) in each user's
      `secrets.json` and `cookie-jars/*.json`.
    - The data key is made by `TenantKeys`' compare-and-set on the pool, **outside** the step's unit, so it is
      committed before anything is sealed under it, and a rolled-back unit reuses it. It refuses with
      `tenancy-data-key-refused` when the stored key does not open under the root, and `tenancy-tenant-id-invalid`
      for a default tenant id that is not canonical; the step stays where it was.
    - A blob that opens under the new key is already done; one that opens under the old key is re-sealed. One that
      opens under neither, and a file or entry that does not parse, is left exactly as it is and counted in the log
      line, never set aside. A link, or anything else that is not a regular file or directory where a user's
      directory or a blob file is expected, is never followed and is counted as skipped: the host would follow it.
    - Each file is written durably: an exclusive temporary file beside it with the original's mode, fsynced, renamed
      over it (retried while Windows holds it), and the directory fsynced (not on Windows, which cannot, and whose
      file system journals the rename).
    - Then, only once every file is durable, `tenancy_step = 'done'`.
    - The keys step is strict: a file it cannot read or write fails start-up and `migrate` (exit `2`) with its errno
      code alone, never its path, and the step resumes at the next run.
    - Without the root, the step stays `keys` and blocks only the host module, which cannot be on without the root
      anyway. Start-up and `migrate` say why on stderr; start-up logs it at `info`.
  - **`done`:**
    - With the root and no data key (the root set only after the upgrade, or a build before the keys step): `keys`
      again, in the same unit.
    - With the root and a stored key the root refuses: the step stays `done`, the server starts, and only the host
      module is blocked (`4503`, below). Nothing is re-wrapped.
    - With the root and a key that opens: **the check**. The forward re-wrap runs again at every start-up and
      `migrate`. It re-seals what is still under the old key, such as a user's directory restored from a backup made
      before the upgrade, which a host would otherwise set aside. It is lenient: a file it cannot read or write is
      counted by its errno code, never named, and tried again at the next start, and start-up and `migrate` go on.
      With nothing to do it writes nothing and says nothing. A re-seal or an unreadable file is logged at `warn`; a
      steady count of blobs under neither key, or of links, at `info`. `migrate` skips the check while another
      server holds the running lock, whose hosts may be writing the same files, and says so; the server re-seals at
      its next start.
  - **The re-arm** (`keys` or `done` → `files`). A move recorded as made while this data directory still holds
    `repos/`, `checkouts/` or `tmp/` at its root (a `migrate` run against another directory, such as one without the
    volume mounted, or a re-armed move cut short) is moved again, in the same unit, through `files`' pre-flight:
    - only when every new place is absent or empty (empty ones are removed first), and every workspace of the
      database has its `<id>.git` at the old place or the new one;
    - when root is set, only when the stored data key opens under it (or there is none yet), so a changed root
      refuses before anything moves;
    - it writes a line naming the directories only, on stderr and in the start-up log at `warn`;
    - a kill or a refusal rolls the unit back to the step it came from, with what is still at the root, so the next
      start re-arms again: a refusal is a fixed point, never a loop.
    - Otherwise it refuses, changing nothing: `tenancy-files-left-behind` when a new place already holds data (it
      names what to merge by hand), and `tenancy-workspaces-missing` when a workspace's repository is in neither
      place (an older copy of the directory).
  - **Before the migrations**, start-up and `migrate` make the same left-behind judgement (`checkNothingLeftBehind`,
    read only) and refuse the same way, so a refused directory leaves the schema as it was too.
  - **Host sockets.** The server listens from `keys`; host sockets are accepted only at `done`. Before it a host
    socket closes `1013` (try again later) before any frame, and no host is built and no data key is made; the tab
    says the server is finishing an upgrade. At `done`, a stored key the root refuses closes `4503`, logged with the
    code and the tenant id.
  - **`migrate`** applies the migrations, then runs the step. With the data directory not there it skips the step
    and says so (the server moves it at its next start). It prints the re-wrap's counts, the re-arm's line, and the
    refusals with their codes (exit `2`, `0` for `tenancy-data-dir-empty`).
  - **`migrate --check`** changes nothing, and exits `1` when migrations are pending, when a step is due (`files`;
    `keys` with the root; `done` with the root and no data key), when a re-arm is due, and on a left-behind or
    missing-workspace refusal. `keys` without the root is not pending. A `done` whose check would re-seal a restored
    directory is not pending either: that is maintenance, done at the next start. With the data directory not
    mounted, `--check` stays `1` after a `migrate` until a server has moved the files.
  - `admin tenancy status` counts the blobs by a dry run, as lenient as the check, and names no file.
- **The way back** (my call). `wirebench-server admin tenancy revert` undoes slice 4. It runs as the owner role.
  - **It is refused:** when there is more than one tenant; when any migration newer than `0021` has run; and when it
    cannot take the server-running lock exclusively. "On a stopped server" is checked, not trusted:
    - Every running server holds the lock **shared**,
      `pg_try_advisory_lock_shared(SERVER_RUNNING_CLASS, hashtext(current_schema()))`, on one dedicated connection
      outside the pool, for its whole life. Any number of servers hold it at once, so several hosted processes, a
      start-before-stop restart and slice 5's multi-instance self-hosted server all start.
    - A server refuses start-up (`tenancy-reverting`) only when the shared try fails, which happens only while a
      revert holds it exclusively.
    - When the dedicated connection drops, the lock is gone with it, silently. The server re-takes the lock on a new
      connection, or exits when it cannot.
    - Revert takes `pg_try_advisory_lock(SERVER_RUNNING_CLASS, …)`, exclusive, which fails while any server holds the
      shared one, and holds it until revert finishes.
  - **It is resumable.** It drives `tenancy_step` backwards through three states, each idempotent, and a forward
    start-up refuses (`tenancy-reverting`) while the step is any of them:
    1. `reverting-keys`: every blob is re-sealed under the old per-user key. A blob is tried under the old key
       first, so a resumed run never seals twice.
    2. `reverting-files`: the directories are renamed back.
    3. `reverting-rows`: one transaction drops the policies, `tenant_scope()`, `for_each_tenant()` and
       `host_leases`; restores the `0019` keys, indexes and foreign keys under their names, including the singleton
       primary keys on the kept `singleton` and `only_row` columns; drops the tenant columns (catalog-only again);
       drops `tenants` and the two `server_identity` columns; and deletes rows `20` and `21` of `schema_migrations`.

    The states run one way, with one exception: `revert --abort`, only at `reverting-keys`, records `files` and
    hands the installation back to the upgrade, whose idempotent steps find the files in place and re-seal under the
    existing data key what the revert had moved back. At `reverting-files` or `reverting-rows` it refuses
    (`tenancy-revert-abort-too-late`).
  - **What it checks first, on every run** (Task 28's review, owner rulings 2026-11-02):
    - It refuses in hosted mode (`tenancy-revert-hosted`), before it connects.
    - It refuses a session whose `application_name` is not `wirebench-admin`, and an app URL that sets one, since
      it tells server connections apart by that name (`tenancy-revert-application-name`).
    - After the exclusive lock, it waits 180 s on every run, a resumed run and `--abort` included: the running
      lock's lost-lock stop (170 s) plus the server's drain (10 s), so that a server that lost its lock without
      knowing has exited. Then it refuses while any `wirebench-server%` session is still connected, which also
      counts another installation's servers in another schema of the same database (stop those too) and a pooler's
      kept connections.
    - Before `reverting-keys` is recorded, a dry run of the re-seal back counts what would stay under the new key.
      A value that opens under neither key, or a link it does not follow, refuses (`tenancy-revert-unopened`,
      nothing changed) unless run with `--accept-unopened`, one flag for both; the same gate after the re-seal is a
      backstop, whose message names `--abort`.
  - **After it.** The previous image reads only `WIREBENCH_SERVER_DATABASE_URL`, so the operator points it at the
    owner's direct URL again. The app role stays, unused; dropping it needs a superuser or the role's privileges
    (`DROP OWNED BY` acts as the role).
  - **The column order is restored.** No column of `0019` is dropped forward (rule 5), and a dropped `tenant_id` only
    leaves a hidden placeholder at the end of each table. The live columns are therefore those of `0019`, in the same
    order. The round-trip test compares the catalog through the migration test's own readers (§19.13).
  - **When it works.** The previous server image then starts on the result. Revert works only on a release that has
    `0020`, `0021` and the command. In the plan `0020` merges with Part A, `0021` with Part C and the revert with
    Part E, so **no release is cut from main between the merges of Part A and Part E**. The command goes away with
    the first release that adds migration `0022`.

### 19.11 Admin commands (amends §8)

- **Added:**
  - `wirebench-server admin tenancy check` (§19.10);
  - `admin tenancy status`: the step, the default tenant's id, whether its data key exists, the re-wrap counts and
    the backup-role advice;
  - `admin tenancy role [--print-sql]` (§19.4);
  - `admin tenancy revert [--accept-unopened | --abort]` (§19.10).
- **`--tenant <slug>`** joins every existing admin command (`invite`, `license`, `audit verify|export`, `schedules`,
  `scim-token`, `scim-group`). Hosted mode requires it. Self-hosted mode refuses it as a usage error (my call), since
  there is one tenant and nothing should ever print or ask for its slug.
- **Not in slice 4:** `admin tenant create|set-edition|suspend|resume|export|delete|import|migrate-self-hosted` are
  slice 7's, because the owner's ruling keeps slices 5 to 8 out of this one, and these commands need them:
  - §13 criterion 6 is about the export's format, its signed link and a chain verified by its own key, and §3.6
    makes export a control-plane lifecycle step;
  - `migrate-self-hosted` copies an installation into a hosted server that slices 5 to 7 have yet to make, and is
    `import` applied to an installation's own export.

  What slice 4 leaves for them:
  - `TenantDirectory.create({ slug, name, edition, region })`, the one function that makes a tenant and its data
    key, which the test helper calls and slice 7's signup and `admin tenant create` will call;
  - the list of scoped tables, generated from `tenant_scope()`'s callers, which an export will walk.

### 19.12 What slice 4 leaves for slices 5 to 8

- **5 `operations`:**
  - announcements carry `tenantId`, the payload §5.5's notification needs;
  - the tenant map has an `invalidate()` the notification listener will call, and so does the data-key cache;
  - the host lease already works across processes, and the repo-store lock is keyed so that an advisory lock can
    replace it;
  - a multi-instance self-hosted server must drop the self-hosted start-up's lease delete (§19.9);
  - `forEachTenant` is the place for per-tenant budgets, and the rate-limiter keys already lead with the tenant.
- **6 `domains`:**
  - `config.appDomain`, the one-label rule and `tenantUrl()`;
  - the slug check is syntax only, and the reserved list (§3.6) is slice 6's.
- **7 `control-plane`:**
  - the unread `tenants` columns and `TenantDirectory.create`;
  - `--tenant` on the admin commands;
  - `LicenseService.state(scope)`, ready to read `tenants.edition`;
  - the data key, which deletion clears, and the backup retention that makes the clearing final (§19.7);
  - the per-tenant chain key;
  - a database factory that takes a connection string, for its bypass role;
  - **per-tenant settings** (§19.1, owner ruling): slice 7 reads each module's sign-in, SCIM, forwarding, SMTP and
    retention settings through the tenant's scope. Today's environment variables become the default tenant's
    settings, and the federated routes stop answering `404` in hosted mode once a tenant has its own.
  - **promises slice 4 made to it** (Part C review M1):
    - the audit forwarder stops its whole pass after a failed send, which is right while one sink serves every
      tenant; once each tenant has its own sink, a failed send must stop only that tenant's batch, so one tenant's
      bad event or dead sink never starves the others (`audit-log/forward/forwarder.ts`);
    - the OIDC, SAML (flows and identities) and SCIM (tokens, users, groups) two-tenant cases run at the repository
      level today, as hosted mode serves none of those routes; they must run again through the routes once a tenant
      has its own identity provider;
    - a self-hosted install switched to hosted keeps its default tenant's chain sealed under the configured key, while
      hosted mode derives every tenant's key (ADR-0036), so `verify` answers `wrong-key` for it; slice 7's import of
      such an install must re-key or carry that chain.

  No signup page, subscription webhook, payment-provider code or control-plane table exists in slice 4.
- **8 `custom-domains`:** the resolver's map, keyed by full host name.

### 19.13 Testing

- **Unit and integration tests per task.**
  - **Until `0021`, a moved module is tested on one tenant**, and its suite shows that every statement it exercises
    goes through `withTenant`.
    - The module under test is registered with a `Proxy` over the one shared `ServerContext`. Its `db` getter throws
      `tenancy-unscoped`; every other read and write passes through, so licensing's replacement of `ctx.license` and
      `buildServer`'s of `ctx.log` still reach it. The modules registered beside it, not yet moved, see the real
      `ctx`.
    - The tenant database's test log asserts that each statement ran after `set_config`.
    - Keyed structures (hub, limiters, locks, instance map) get unit tests with two tenant ids.
    - **The limit:** with one tenant this cannot show the right tenant, only a tenant, and it covers only the paths a
      test runs: timers are off in the suites, and untested error branches are not seen. `check:tenant-scope`'s
      refusal of `defaultScope(` closes the commonest wrong-tenant case, and Tasks 18 and 19 prove the rest under the
      policy. They land in the same Part C pull request as `0021`, before anything can make a second tenant, and no
      release is cut in between.
  - Once `0021` forces the policy, each module gains its two-tenant case (guard 4).
- **The database roles.**
  - CI's PostgreSQL service creates `wirebench_owner` (`login nosuperuser nobypassrls`) and `wirebench_app`. The test
    helper creates each file's schema as the admin, `authorization wirebench_owner`, runs the migrations as the owner
    and the queries as the app role.
  - `test/integration/tenancy/role.test.ts` fails when the app role is a superuser, has `BYPASSRLS`, or owns a table,
    and when the owner is a superuser. A change to CI therefore cannot make every isolation test pass vacuously.
- **The migration test** (guard 3), over the catalog, as §19.8 lists it, after `0020` (constant default, no policy)
  and after `0021` (setting default, forced policy).
- **Outside a tenant.** For every scoped table, as the app role and as the owner, a select outside `withTenant`
  returns no rows and an insert fails.
- **The cross-tenant isolation suite**, `test/integration/tenancy/isolation.test.ts`. It starts a hosted-mode server
  with tenants A and B, made by `TenantDirectory.create`, and fills A through its own routes and repositories.
  - **Positive controls first**, so that the suite cannot pass for the wrong reason:
    - `fill` asserts at least one row of A's in every scoped table, counted inside A's scope.
    - Every route template answers `2xx` as A's admin on A's host before it is sent as B.
    - As the admin superuser, which bypasses the policy, every scoped table shows rows of both tenants, while the
      app role sees only the scope it set.
    - The table and route sweeps are run once more on a throwaway schema with the policies disabled (`alter table …
      disable row level security`), and must fail there.
  - **Every table.**
    - Inside B's scope, every scoped table counts zero.
    - An insert in B that names one of A's ids is refused by the composite key.
    - An insert in B that names `tenant_id = A` explicitly fails with `42501`.
    - B creates a workspace with A's workspace id and gets `201`, and both repositories exist (§19.3, rule 2).
  - **Every route.**
    - The suite collects every route Fastify registers (`onRoute`), and maps each one to a request template filled
      with A's ids, sent as B's server admin on B's host name.
    - The map's classes:
      - **refused or empty:** `404`, `403` or an empty list;
      - **B's own:** `200` holding only B's own data, such as `/api/v1/me`, `/api/v1/meta` or the license;
      - **federated:** answers `404` in hosted mode (§19.1).

      No response body may contain any of A's ids, names or emails.
    - A route missing from the map fails the suite, so every new route is classified when it is added.
    - A's token or cookie sent to B's host name answers `401`. An unknown host name answers `404` with an empty
      body.
  - **Every socket.**
    - Live: B cannot subscribe to A's workspace, and A's announcements never reach B's sockets.
    - Host: B's host cannot open a path in A's directory.
    - Terminal shares: B cannot join A's share.
  - **Every job.** With due rows in both tenants, each job of guard 6 serves both, the license listener included,
    and each effect stays inside its tenant:
    - one tenant's schedule alert never carries the other's data;
    - a tenant without `scheduled-runs` does not stop the other's schedules;
    - each tenant's chain seals on its own and verifies with its own key.
  - **Keys.** A blob sealed for a user of A does not open under B's key, nor under A's key for another user.
- **The migration.**
  - **The fixture is frozen** at `e9bdc5af1`: a `seed-0019.sql` (`pg_dump --data-only`) with rows in all 37 tables
    and sealed audit rows under a test chain key, a data-directory tarball (repositories, a checkout a real host
    wrote with a server workspace open, a `secrets.json` and cookie jars), and a script that regenerates both from
    that commit. The repositories the plan rewrites never touch it.
  - Migrating the fixture leaves:
    - every row in the default tenant;
    - `admin audit verify` passing;
    - every workspace syncing (head, snapshot, a push);
    - the host opening with its secrets and jars.
  - The file step is killed after each rename and halfway through the re-wrap, and resumes.
  - `admin tenancy revert` is killed in each of its three states and resumes. Its result matches the fixture's
    catalog (tables, live columns in order, keys and indexes by name and definition) and rows, and the old layout.
  - The scaled fixture's migration time is recorded (§19.10).
- **The lease.**
  - Two `HostInstances` with two holders on one database: the second socket gets `4409`.
  - An expired lease is taken over.
  - A process that cannot renew stops its instances before expiry.
  - The cap evicts an idle instance before it refuses with `4429`.
  - Self-hosted start-up clears leases.
- **End to end.**
  - The browser e2e of §17.7 and §18.7 runs unchanged on a server migrated from the frozen fixture, with its queries
    as `wirebench_app`. That is "invisible to self-hosted", tested.
  - An upgrade test starts a `0019` volume under the new `compose.yaml`: the app role is created and the server
    starts. The same volume with the old single URL starts too, with the warning.

### 19.14 Success criteria 3 and 4 (amends §13)

- **Criterion 3** ("two tenants … cannot read, list, push to or be alerted about each other's anything") is met by
  the isolation suite of §19.13 for every table, route, socket and job that exists when slice 4 ships. Each later
  slice's tables and routes join the suite, which refuses an unclassified route. The two tenants live in tests until
  slice 7 can create one.
- **Criterion 4** splits, because the owner's ruling keeps slices 5 to 8 out of slice 4 and a copy into a hosted
  server needs them:
  - **4a, slice 4:** an existing self-hosted database and data directory become one tenant in place, with every
    workspace syncing after (the migration tests of §19.13);
  - **4b, slice 7:** `admin tenant migrate-self-hosted` copies one into a hosted server, as an import of the
    installation's own export (§19.11).

### 19.15 What §19 changes in ADR-0032, §5.5 and §14

ADR-0032 (accepted) carries an amendment note naming these, as §17 and §18 did for theirs:

- `set_config(…, true)` replaces `set local`, which takes no bind parameter (§19.4).
- Repositories take a `TenantQuerier`, which carries the `TenantScope` (§19.8, guard 2).
- A self-hosted server may run with a bypassing role, with a warning (owner ruling, §19.4). Queries run as an app
  role separate from the owner where the operator sets one up, and new compose installations do.
- No bypass for jobs: every job runs per tenant (§19.8, guard 6).

§5.5's heartbeat advisory lock is a row lease (§19.9). §14's "one transaction for rows" is two migrations, `0020`
and `0021`, each one transaction (§19.10).

## 20. Slice 5 amendment: operations (2026-11-03)

Slice 5 (#821) lets the server run as several instances against one database and one data volume, and stops one
tenant from using up a shared server. It builds §5.5 (fan-out, the advisory lock, sticky host sockets), the
per-tenant budgets of §6 and the operations metrics of §6 and §8. It builds nothing of slices 6 to 8: no wildcard
name, no `app.` entry, no signup, no per-tenant settings. Where the build differs from the sections above, this
section wins, and ADR-0013 and ADR-0009 carry a note of what changed (§20.12). Plan:
`docs/plans/2026-11-03-operations.md`. ADR-0037 records the decision that instances share state only through
PostgreSQL, with one exception, the share relay (§20.6).

Owner rulings (popup, 2026-11-03):

1. **Metrics are pushed with OpenTelemetry** (OTLP over HTTP), and only when the operator sets an endpoint (§20.8).
2. **The budgets** are server-side sends per minute, concurrent server-side sends, and a fair share of scheduled-run
   slots, with server-wide defaults from the environment. Per-tenant overrides arrive with slice 7's settings
   (§20.7).
3. **A self-hosted server may run several instances on an Enterprise license only**, by opting in (§20.1).
4. **Sticky host sockets use the balancer's own cookie**, whatever the balancer. The docs give one worked example,
   and the host lease stays the guard (§20.5).
5. **Terminal shares cross instances through a node-to-node relay** (§20.6).

Built in #828, #833 and #836 (2026-11-04). The sections below record the build where it differs from the design
first written here. Owner rulings taken during the build (popup, 2026-11-04):

6. **Every request inside a run counts.** A run, a sequence or a send to several environments spends one token per
   request as it goes out, and an empty bucket makes the run wait, never fail (§20.7).
7. **A WebSocket open costs one token** and holds a slot only until it has opened; an open session holds none (§20.7).

### 20.1 One instance or several

- `WIREBENCH_SERVER_INSTANCES` takes `single` (the default) or `multi`. Hosted mode is always `multi`, whatever the
  variable says.
- **`single` is today's server.** Every mechanism of this section runs in it too, so there is one code path, not two
  (my call): the notification bus, the advisory repository lock and the shared limiter. A one-instance server pays a
  statement or two per push and per limited request, which `pnpm test:perf` measures (§20.11). What `single` keeps:
  - start-up deletes every host lease (§19.9), since no other process can hold one;
  - no instance address is needed, and the share relay never dials (§20.6).
- **`multi` on a self-hosted server needs Enterprise** (ruling 3).
  - Start-up reads the default tenant's license state. On anything but an Enterprise license that is valid or in
    grace, `serve` refuses with `server-instances-need-enterprise`, and `config check` says the same.
  - A license that lapses while the server runs does not stop it. Every instance logs a warning once an hour, and the
    next start refuses. A running fleet is not cut off by a renewal that is a day late (my call).
  - `multi` drops the start-up lease delete (§19.12), and needs `WIREBENCH_SERVER_INSTANCE_URL` and
    `WIREBENCH_SERVER_SECRETS_KEY`, the relay token's key (§20.6). Without either, `config check` and `serve` refuse.
- **What stays per process,** by design, in both modes: the eight host sockets per user and the live sockets per
  user (§17.3, ADR-0013). They guard one process's memory, not a tenant's share of the fleet.
- **Every instance mounts the same data volume read-write** (§5.5). Repositories are written under the advisory lock
  (§20.4), checkouts and host state under the host lease (§19.9), and nothing else on the volume is written by two
  processes.

### 20.2 The instance table

```sql
create table server_instances (
  holder      uuid primary key,          -- the process id of §19.9, random at start-up
  url         text,                      -- WIREBENCH_SERVER_INSTANCE_URL; null in `single`
  version     text not null,
  started_at  timestamptz not null default now(),
  renewed_at  timestamptz not null default now()
);
```

- **Unscoped**, like `server_identity`: it names processes, not tenants. It joins guard 3's allowlist (§19.8), and
  `check:tenant-scope` allows it only in `src/operations/`.
- Migration `0022`, under `packages/server/migrations/operations/`. The app role may select, insert, update and
  delete it.
- An instance inserts its row at start-up and renews it with the host leases' 15 s timer. A row older than 60 s is
  dead, and any instance's renew deletes dead rows. A clean shutdown deletes its own row.
- Readers: the share relay (§20.6), the metrics' instance count (§20.8), and `admin instances` (§20.10).

### 20.3 The notification bus (amends §5.5 and ADR-0013)

- **One listening connection per process,** an `openSession` on the same URL as the server-running lock (the
  migration URL where one is set): a transaction pooler cannot hold `LISTEN`, as it cannot hold a session lock.
- **One channel per server schema:** `wirebench_bus_` followed by the hex of `hashtext(SERVER_SCHEMA)`, so test
  schemas never hear each other.
- **Sending.** `announce(...)` keeps its contract: it never throws and never awaits. It now does two things:
  - delivers to this process's listeners at once, as today;
  - queues the event for `select pg_notify($channel, $payload)` on the pool, outside any tenant transaction, in
    order, with a queue of 10 000 events. A full queue drops the oldest and counts it (§20.8).
  - A failed `pg_notify` is tried three times in all (100 ms, then 1 s apart) before it is given up. After a give-up
    or an overflow the bus owes one **missed marker**, a `resync` with no tenant, sent at once when the queue is idle
    and otherwise ahead of the next payload. A peer that hears it acts as if its own bus had reconnected (below).
- **The payload** is JSON, at most 7 900 bytes: `{ v: 1, from: holder, at, kind, tenantId, …the event's ids }`.
  - `at` is the send time in epoch ms, for the lag histogram (§20.8). It is optional on decode, so an instance on the
    previous version, which sends none, is still heard during a rolling upgrade.
  - Each kind has its own field list, and the encoder copies only those fields. The decoder drops any key it does
    not know before it checks the known ones strictly, so a newer instance may add an envelope key during a rolling
    upgrade without its events going unheard; `v` stays the switch for a change an older decoder must refuse (Part C
    review). The encoder, not the decoder, keeps private fields off the wire, and a dropped key never reaches a
    listener. `check:tenant-scope` keeps `pg_notify` and `LISTEN` to `src/operations/`, so no other path puts a
    payload on the bus past the codec.
  - It carries ids only, never a name, an email or file content (ADR-0013).
  - `AccessChangedEvent` and `LicenseChangedEvent` carry a branded `TenantScope`. The receiver rebuilds it from
    `tenantId` with `scopeOf` in `src/tenancy/`, the only place a scope may be made.
  - An event that would not fit is never truncated. It is sent as `{ v: 1, from, kind: 'resync', tenantId }`, and each
    receiving hub resyncs that tenant's rooms (below).
- **Receiving.** A notification from this process's own `holder` is dropped, since it was delivered locally. The rest
  reach the listeners registered as **cluster** or **remote** listeners. A kind no such listener hears is dropped
  before any lookup. Received notifications wait in an inbox of 10 000; a full inbox drops the oldest and then
  resyncs this process as after a lost connection.
- **Three kinds of listener** (my call): a listener says whether it is `cluster`, `local` or `remote`.
  - **Cluster** listeners keep in-memory state in step, hearing this process and the others: the live hub, the host
    instances' `sessionEnded` and the terminal-share registry.
  - **Remote** listeners hear the other instances only: the tenant map and the data-key cache, which a write in this
    process already refreshed directly, so a key this process just wrote is not dropped again.
  - **Local** listeners have an effect that must happen once: the audit module's `licenseChanged` writes an audit
    event, and runs only in the process that announced it. Finished schedule runs are counted for metrics the same
    way (§20.8).
  - A listener that does not say which is a type error.
- **New events:** `tenantsChanged` (from `TenantDirectory.changed()`) and `tenantKeysChanged { tenantId? }` (from the
  data-key paths). Their remote listeners call `TenantResolver.invalidate()` and `TenantKeys.invalidate()`, which
  slice 4 left for this (§19.12). The resolver's 60 s poll stays as a backstop, at 10 minutes.
- **Presence crosses instances.** The hub announces `presenceChanged { tenantId, workspaceId, holder, users }` with
  its own sockets' users of that room. Every hub keeps the other holders' lists per room, and `presence` sends the
  union. A holder's lists are dropped when its `server_instances` row dies, or when it says `presenceReset`.
  - The event carries user ids only; each hub looks the display names up in the tenant, once per user and room.
  - A room whose list would pass the payload limit is cut into parts (`seq`, `part`, `parts`), not turned into a
    resync. The receiver replaces the holder's list once every part of one `seq` has come, and ignores stragglers
    of an older one.
  - A hub answers another's `presenceReset` with its own lists, so a holder that just started learns the room.
- **When the listening connection drops:**
  - the bus reconnects with a backoff of 1 s to 30 s;
  - once it listens again, it invalidates the tenant map and the key cache, sends `presenceReset` with its own
    lists, and **resyncs** every room it holds;
  - a resync is made of messages clients already know, so a desktop of any version understands it (§14): each
    subscribed socket gets `head` with the workspace's current head (one query per room), then `access`, then
    `presence`. Each makes the client run its ordinary fetch. Nothing replays a missed event, as before
    (ADR-0013); the 300 s safety-net fetch still converges every client.
  - it **re-validates every session it holds**: the live hub, the host instances and the share registry list their
    sockets' device tokens, one query per tenant finds the ones no longer live, and each goes through its holder's
    own `sessionEnded` path. The share registry also re-checks access in every tenant it holds shares in. A
    `sessionEnded` the bus missed would otherwise leave a revoked user connected.
  - A missed marker from a peer, or a full inbox, takes the same path.
- **Ordering.** Notifications from one process arrive in the order it sent them; notifications from two processes
  have no order. Every event is a hint followed by an HTTP fetch, so neither matters.

### 20.4 The repository lock (amends ADR-0009 and ADR-0012)

- `RepoStore.withLock(scope, workspaceId, fn)` keeps its signature. Inside, after the in-process queue, it takes
  `pg_advisory_lock(REPO_LOCK_CLASS, hashtext(SERVER_SCHEMA || ':' || tenant_id || ':' || workspace_id))` on a
  connection it holds for the length of `fn`, and unlocks before returning the connection.
  - A session lock, not a transaction lock: `fn` runs git for seconds and its own short transactions, so it cannot
    sit inside one transaction.
  - The connection comes from a **lock pool** of its own, on the migration URL like the bus (a transaction pooler
    would hand the session to someone else), with at most 8 connections. A ninth concurrent push waits in the
    in-process queue first, so one process never holds more than 8 (my call).
  - The in-process queue stays in front, so pushes to one workspace in one process never queue on the database.
  - `REPO_LOCK_CLASS` is `0x57425250` ("WBRP").
- A wait longer than 30 s answers `503 repo-busy` with `Retry-After: 5`. The desktop already retries a `503` push.
  The lock pool's connections carry `lock_timeout`, so the wait fails in PostgreSQL itself and can never go on to
  take the lock; a connection in doubt is destroyed, which drops whatever it held.
- A lost lock connection ends `fn` with `repo-lock-lost` before its next git step, also `503` with `Retry-After: 5`.
  A git step that already started runs to completion, as a crash would: the bare repository's own lock files and the
  push's compare-and-swap of the head keep it consistent.
  - A half-open connection (after a failover the old primary's socket gives no error) is caught by a probe: before
    a git step the lock connection is asked `select 1` with a 2 s timeout, at most once a second, and always right
    before `update-ref` or `symbolic-ref`, the push's last step. A failed or late probe marks the lock lost and
    destroys the connection (my call).
  - The server's `GitCli` is wrapped so each run checks its operation's state, carried in `AsyncLocalStorage`, so no
    caller changes.
- `drain()` waits for the in-process queue and for every held database lock to be released.

### 20.5 Sticky host sockets (amends §5.5)

- The server sets no routing cookie and reads none (ruling 4). The operator turns on the balancer's own sticky cookie
  for `/api/v1/host` and `/api/v1/live`.
- **The worked example is Traefik**, the reverse proxy slice 6's hosted compose uses (`sticky.cookie` with
  `secure`, `httpOnly` and `sameSite=lax` on the service). The docs say what any balancer must do: keep one browser
  on one instance while it lives, and move it when that instance is gone.
- **The lease stays the guard.** A socket that reaches the wrong instance gets `4409 host-lease-held` with
  `retryAfterMs`, as in §19.9. The bootstrap reconnects after that wait, the balancer sends it back to the holder
  while the holder lives, and once the holder is gone the next instance takes the lease after expiry.
- **Draining.** On `SIGTERM` an instance, as the shutdown's first step, before the app closes:
  - answers `503` on `/readyz` (§20.9) and refuses host and live upgrades;
  - runs each host's quit path, then releases its lease, then closes its sockets `4503 host-draining`. Release before
    close, so the tab's immediate reconnect finds the lease free on the next instance instead of a `4409` wait; never
    before the quit path, so no two hosts hold one checkout. A release that throws still closes the sockets, and is
    logged;
  - closes its live sockets `1012` (service restart);
  - keeps serving HTTP until the app closes.

  The whole drain is bounded by the server's drain time (10 s), and is not waited for once the server-running lock is
  lost, so a host whose quit path hangs does not hold the shutdown. The bootstrap reconnects at once after
  `4503 host-draining` on a socket that had its hello, and the balancer picks a live instance; one refused at the
  upgrade by the same draining server backs off as usual, so a tab never spins against it. `4503` already exists
  (§17.3); the reason is new.

### 20.6 The share relay (ruling 5)

A terminal share joins one owner socket with viewer sockets, all held by one registry in one process (team session
logs and sharing spec B1). With several instances, a viewer can land on another instance than the owner.

- **Where a share lives.** `terminal_share_locations(tenant_id, share_id, holder, created_at)`, scoped like every
  table, keyed `(tenant_id, share_id)`. The owner's instance writes the row when the share starts and deletes it when
  the share ends. A row whose `holder` has no live `server_instances` row is dead, and a join treats it as no share.
  - On each instance heartbeat the holder writes the rows of every share it still holds again (an upsert, per tenant
    in its scope), so a holder that was only slow, whose rows a peer cleared as dead, is found again within one beat.
  - Every 10 minutes the heartbeat also deletes, per tenant through the job loop, the rows whose holder has no live
    instance row and that are older than a dead instance's 60 s: a crashed holder's rows do not stay for good.
- **Joining elsewhere.** A viewer's instance that does not hold the share looks it up, then dials the holder's `url`
  at `/internal/v1/shares/<share_id>` with the viewer's identity, and pipes frames both ways unchanged. The holder
  sees one more viewer, with that viewer's identity, and every rule of the registry (the viewer limit, control,
  audit) applies there once. The viewer's instance clears a dead row it finds. A frame from the viewer before the
  holder has answered is out of order, and the viewer is closed with the bad-message code, as the holder would.
  - A share whose row cannot be written is ended before the create answers `500`.
- **The join dialog's info** is answered by the holder the same way: a client asks for it before it opens the socket,
  so the relay also serves `GET /internal/v1/shares/<share_id>/info`.
- **The internal listener.** `WIREBENCH_SERVER_INSTANCE_URL` names this instance's own address on the private
  network (for example `http://10.0.0.5:8091`), and the server listens on its port with a second Fastify that serves
  only `/internal/v1/*`. It binds the URL's host when that is an IP literal or `localhost`, and `0.0.0.0` for a DNS
  name, which may not resolve to a local address; `WIREBENCH_SERVER_INTERNAL_HOST` overrides the bind address. The
  listener speaks plain HTTP, so the URL must be `http://` (configuration refuses `https://`): the private network
  is the transport's guard.
  - Each relay request carries a token made with HMAC-SHA-256 under a key HKDF derives from
    `WIREBENCH_SERVER_SECRETS_KEY` ("wirebench/instance-relay/v1"), which is why `multi` needs that key (§20.1). The
    token binds the tenant, the share, the workspace, the viewer's user and token ids, the target holder, and an
    expiry 30 s ahead, and carries what the holder admits the viewer with: the display name, when the viewer's device
    token reaches its maximum age, and the audit source. It also names its route (`purpose`: `join` or `info`) and
    carries a random `jti`; the holder keeps each `jti` it accepted until the token expires, so a token works once and
    on its own route only. The holder refuses any other.
  - The public listener never routes `/internal/`, and the internal one routes nothing else.
  - The docs say the port must not be reachable from outside the private network. The token is the only guard if
    it is.
- **What does not change:** the share's protocol, its limits and its audit. When the holder dies, the share ends for
  every viewer, as a restart ends it today.
- `single` mode never dials: every share lives in the one process.

### 20.7 Per-tenant budgets (amends §6; ruling 2)

- **A shared limiter.** `limiter_buckets(tenant_id, key, tokens real, updated_at)`, an `unlogged` scoped table keyed
  `(tenant_id, key)`. A charge is one statement: refill by the elapsed time, take if there is enough, and return the
  tokens left. Unlogged is enough: after a crash the buckets start full, as an in-memory limiter does after a
  restart.
- **Every existing limiter moves to it** (amends ADR-0009's "shared rate-limit store"): sign-in per address and per
  email, SSO and SCIM, licensing, sync key requests, desktop audit events, the agent's pairing and nonce limits with
  the pairing failure budget, and catch-URL buckets. Their keys, sizes and refill rates are unchanged, and so is
  every refusal a client sees. Spread over several instances, one tenant's attacker gets no more attempts than on
  one.
  - Each limiter names its own rows (`name/key`), since sign-in and the agent's per-address limit key an address the
    same way and were two maps before. A charge runs in a unit of its own, so a request that fails afterwards cannot
    roll its charge back, and it uses the database's clock.
  - Rows unspent for the longest refill window of every registered limiter, and at least an hour, are swept every
    10 minutes, per tenant. Such a row is full, as a missing one is, so no decision changes.
  - **One limiter stays in memory:** slice 6's `app.` entry form (`entry/routes.ts`) is charged before the request has
    a tenant, and a scoped table cannot hold its buckets. Its limits are per instance.
- **The new budgets,** one bucket each per tenant, with server-wide defaults:

  | Budget | Variable | Default | Refused with |
  | --- | --- | --- | --- |
  | Server-side sends per minute | `WIREBENCH_SERVER_TENANT_SENDS_PER_MINUTE` | 600, burst 100 | `429 tenant-send-budget`, `retryAfterMs` |
  | Concurrent server-side sends | `WIREBENCH_SERVER_TENANT_CONCURRENT_SENDS` | 16 | `429 tenant-send-concurrency` |
  | Scheduled-run slots | `WIREBENCH_SERVER_TENANT_RUN_SLOTS` | `WIREBENCH_SERVER_SCHEDULES_CONCURRENCY` | queued, never refused |

  - The burst is one sixth of the per-minute rate, 100 at the default of 600, so raising the rate raises the burst.
  - The run slots default to the per-server schedules concurrency, not to 2, so a one-tenant self-hosted server runs
    as many scheduled runs at once as before (Part B review).

- **What a server-side send is.** A send the server host makes on a browser user's behalf: the host's send channels,
  listed in `src/operations/send-channels.ts`. A send through a paired agent is not one (`agent.send` runs on the
  person's machine; the host only builds its bundle and records the exchange); nor is a scheduled run's request,
  which the run slots govern instead.
  - **The rule.** A served channel whose last name segment starts with send, resend, open, run, invoke, call,
    execute, connect, fetch, refresh or import (or ends in `Send`, `Introspect` or `Refresh`) is listed as a send, as a send only when its source
    is a URL, or in `NOT_SENDS` with its reason. `send-channels.test.ts` fails on one in none, as the allowlist test
    fails on an unclassified channel (§17.3), so a new protocol's send cannot go uncharged by accident.
  - Outbound calls the host makes for the user count as sends: `oauth2.fetchToken`, `issuedTokens.fetch`,
    `api.grpcRefresh`, `api.refreshMcpCatalogue`. `definition.import`, `api.importOpenApi`, `api.importAsyncApi` and
    `api.importProto` count only when their source is a URL (or reflection). File and text imports, `sync.fetch`
    (this server, in process) and the local imports are not sends, each with its reason.
  - **Three charges** (owner rulings, 2026-11-04):
    - `send`: a single request or outbound call takes one token and one slot for the call.
    - `run`: `runner.run`, `sequence.run` and `request.sendToEnvironments` hold one slot for the whole call and take
      no token for it; each request inside spends a token as it goes out, through the host's new `sendGate` option,
      asked just before the wire. An empty bucket pauses the run, polling each second until the bucket's retry
      time, bounded by the run's cancel and its socket's close. It never fails the run.
    - `session`: `request.openWs` spends one token and holds a slot only until the handshake opens the session, so
      open sessions block no send.
  - The host socket charges each served frame in the user's tenant. A refusal is the call's error reply, with
    `retryAfterMs`, which the tab already shows as a failed send.
- **Concurrency across instances.** `send_slots(tenant_id, slot, holder, expires_at)`, unlogged and scoped. A send
  takes a slot (`insert … on conflict do update … where expires_at < now()` on one of the tenant's numbered slots)
  and frees it after.
  - The slot is taken before the token, and a budget refusal gives the slot back, so a send refused for concurrency
    spends no token.
  - The server cannot see a request's own deadline, so a slot lasts the host's default deadline (60 s) plus 30 s, and
    is renewed every 30 s while its call runs: a run keeps its slot, and a dead instance's slots free themselves
    within 90 s.
- **Run slots.** The scheduler's per-server cap (`WIREBENCH_SERVER_SCHEDULES_CONCURRENCY`) stays. Beside it, a
  tenant runs at most its slots at once across every instance: the claim counts that tenant's `running` runs in the
  same transaction that claims, under a per-tenant transaction lock (`0x57425253`, "WBRS"), and skips the tenant when
  it is full, as an empty turn. The round-robin of §19.8 then offers the slot to the next tenant.
- **Script limits stay per run** (ADR-0016): 1 s by default, 10 s at most, 64 MiB.
- **Overrides** per tenant are slice 7's settings. Until then every tenant gets the defaults. A self-hosted server's
  one tenant gets them too. The send budget's default is set high enough that a team's own use does not reach it,
  and the operator can raise it.
- **Where a budget is refused,** the browser shows the refusal on the send like any other failed send, with its
  retry time. Nothing is queued.

### 20.8 Metrics by tenant id (amends §6 and §8; rulings 1)

- **Off unless an endpoint is set:** the server starts the OpenTelemetry metrics SDK only when
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set. A self-hosted server sends nothing
  by default, and the product's no-telemetry promise is unchanged: the operator chooses where its own server's
  numbers go. The standard `OTEL_*` variables (headers, interval, timeout, resource attributes) apply as the SDK
  reads them. `OTEL_SERVICE_NAME` defaults to `wirebench-server`.
- **Dependencies,** confined to `src/operations/metrics/` and listed in the licences test: `@opentelemetry/api`,
  `@opentelemetry/sdk-metrics`, `@opentelemetry/resources` and `@opentelemetry/exporter-metrics-otlp-http`, all
  Apache-2.0, pinned exactly.
- **Attributes.** A metric names a tenant by `wirebench.tenant.id` (the uuid), never by slug or name. Other
  attributes are closed sets: the route template (never the URL), the method, the status class, a budget's name, an
  outcome. Nothing from a request's content, a header or a user is ever an attribute. A test sweeps every recorded
  attribute against that list.
- **Instruments:**

  | Name | Kind | Attributes |
  | --- | --- | --- |
  | `wirebench.http.requests` | counter | tenant, route, method, status class |
  | `wirebench.http.duration` | histogram (ms) | route, method |
  | `wirebench.live.sockets` | gauge | tenant |
  | `wirebench.host.instances` | gauge | tenant |
  | `wirebench.sends` | counter | tenant, outcome (`ok`, `failed`, `refused`) |
  | `wirebench.budget.refusals` | counter | tenant, budget |
  | `wirebench.schedules.runs` | counter | tenant, status |
  | `wirebench.repo.lock.wait` | histogram (ms) | tenant |
  | `wirebench.bus.dropped` | counter | none |
  | `wirebench.bus.lag` | histogram (ms) | none |
  | `wirebench.instances` | gauge | none |
  | `wirebench.db.pool.waiting` | gauge | pool (`app`, `lock`) |

  The process's id and version are resource attributes (`service.instance.id` is the `holder`).
- A route without a tenant (`/healthz`, the sign-in page before resolution) records `wirebench.tenant.id` as `none`.
- **As built:**
  - Modules record through `ctx.metrics`. With no endpoint, the instruments sit on the API's no-op meter, the SDK is
    loaded through `import()` only when an endpoint is set, and the gauges' sources are never read.
  - `wirebench.http.duration` carries no tenant (Part C review): a histogram's buckets multiply its series, so
    tenant × route × method × buckets would grow with every tenant. The counter keeps tenant × route × method × status
    class.
  - `wirebench.budget.refusals`'s budget is `sends` or `concurrency`.
  - `wirebench.instances` counts the live `server_instances` rows when the reader collects, not on a timer.
  - `wirebench.schedules.runs` records from a local listener, so each instance counts its own runs.
  - `wirebench.bus.lag` records only for an envelope that carries `at` (§20.3).
  - The periodic reader does not read `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_METRIC_EXPORT_TIMEOUT` itself, so the
    server parses them; `config.ts` lists none of the `OTEL_*` variables.
  - Shutdown flushes within 5 s, while the pools are still open.
  - The attribute sweep also refuses any value shaped like a URL, an email or a slug.

### 20.9 Health

- `GET /healthz` stays as it is (database, data directory, git).
- `GET /readyz` is new and unscoped: `200` once start-up has finished and while the bus listens; `503` with
  `starting`, `reconnecting` or `draining` otherwise. A balancer's health check uses it, so a draining instance gets no
  new socket.
  - It joins `/healthz` in `UNSCOPED_ROUTES` (`server.ts` and `tenancy/resolve.ts`), and the isolation suite's route
    map classifies it `own`.

### 20.10 Admin

- `wirebench-server admin instances` lists the live `server_instances` rows: holder, address, version, age, last
  renew. It prints no tenant.
- `wirebench-server admin tenancy revert` refuses a database at `0022`, and its refusal names it: §19.10 ends the way
  back with the first release that adds a migration after `0021`.

### 20.11 Testing

- **Two instances on one database** (§11's criterion): `test/integration/operations/two-instances.test.ts` starts two
  full servers on one schema and one data directory, each with its own `holder`, internal port and bus.
  - A push through one is a `head` on a live socket of the other within 2 s.
  - `accessChanged` and `sessionEnded` on one close or demote sockets and host instances on the other.
  - Presence on one shows users subscribed on the other, and drops them when that instance stops.
  - A tenant created on one resolves on the other, and a data-key change is seen there.
  - Two pushes to one workspace through the two instances never interleave (the advisory lock), and one waits.
  - A host socket on the instance that does not hold the lease gets `4409`, and after the holder drains, the other
    takes the lease at once.
  - A viewer on one joins a share owned on the other through the relay, and control works both ways.
  - A tenant's 17th concurrent send is refused on either instance, and its send budget is shared.
- **The bus:** a dropped listening connection reconnects and resyncs its rooms with `head`, `access` and `presence`;
  an oversized event goes as `resync`; a full queue drops the oldest; a process ignores its own notifications; a
  `local` listener runs once in the fleet.
- **The relay:** a token for another share, viewer, holder or tenant, or an expired one, is refused; the public port
  answers `404` on `/internal/`.
- **The limiter:** the same keys and refusals as the in-memory one, under both tenants (the isolation suite of §19.13
  gains `limiter_buckets`, `send_slots` and `terminal_share_locations`, and classifies `/readyz`).
- **Metrics:** with an in-memory exporter, each instrument records with its attributes, and the attribute sweep finds
  only the allowed keys; with no endpoint the SDK is never started.
- **`multi` and the license:** refused without Enterprise, warned when it lapses, the start-up lease delete skipped.
- **Perf:** `pnpm test:perf` measures a push and a sign-in before and after, on one instance.
- **CI** runs the two-instance suite in the server shard. It needs no new service.

### 20.12 What §20 changes in ADR-0009, ADR-0013, §5.5 and §19

- ADR-0009 and ADR-0013 carry an amendment note: the hub fans out through `LISTEN`/`NOTIFY`, the repository lock is
  an advisory lock, and the rate limits live in PostgreSQL. A server may run as several instances: hosted always,
  self-hosted on Enterprise by opting in. ADR-0037 is accepted with the build's changes (remote listeners, the missed
  marker, session re-validation, the entry's in-memory limiter).
- §5.5's sticky cookie is the balancer's, not the server's (ruling 4).
- §19.9's start-up lease delete runs in `single` mode only (§19.12).
- §19.8 guard 3's allowlist gains `server_instances`.
- Capture ids stay monotonic per process (`hooks/repo.ts`). Two captures in the same millisecond on two instances
  sort by their random part, not by arrival. Paging stays consistent, since it pages by id.

### 20.13 Success criteria (amends §13)

Slice 5 adds no criterion of §13. It is done when §11's operations line holds ("two server instances against one
database, a push on one seen by a live socket on the other") together with the rest of §20.11, and a self-hosted
one-instance server behaves as before with no new variable set.

## 21. Slice 6 amendment: domains (2026-11-03)

Slice 6 (#822) gives the hosted names their settings and their certificate, opens the neutral entry at
`app.<app-domain>`, and reserves the slugs no tenant may take. No domain is owned yet (owner, 2026-11-03), so every
name is read from configuration and none is written into the code, the tests or the docs: they say `<app-domain>`,
`<site-domain>`, or `app.test` and `site.test` in tests. It builds §3.2's `app.` paragraph, §3.6's reserved list,
§3.7 and §19.12's slice 6 items, and nothing of slices 5, 7 or 8: hosted mode stays refused by `loadConfig` (§19.1),
the entry is proven by tests that build a hosted `ServerConfig`, and the deployment recipe runs end to end once
slice 7 lifts that refusal. Where the build differs from the sections above, this section wins. ADR-0038. Plan:
`docs/plans/2026-11-03-domains.md`.

Owner rulings (2026-11-03, popup): Traefik terminates TLS and issues the wildcard certificate; Hetzner DNS is the
DNS-01 provider the recipe targets first; the entry's mail goes through the server's existing SMTP settings; the
reserved list is §3.6's plus infrastructure and brand names.

### 21.1 The two names (amends §3.7 and §19.5)

| Variable | Key | Meaning |
| --- | --- | --- |
| `WIREBENCH_SERVER_APP_DOMAIN` | `appDomain` | The product's registrable name. Tenants are `<slug>.<app-domain>`, the entry is `app.<app-domain>`. |
| `WIREBENCH_SERVER_SITE_DOMAIN` | `siteDomain` | The marketing site's registrable name (site, docs, signup). The server serves nothing there; the entry page and its mail link to `https://<site-domain>/`. |

- **Shape.** A lower-case DNS name of at least two labels, each `[a-z0-9-]`, 1–63 characters, not starting or ending
  with `-`, 253 characters at most; no scheme, port, path, trailing dot or IP literal. Upper case is folded, anything
  else is refused with the variable's name.
- **Two names, apart.** The two must differ, and neither may equal or end with `.` plus the other, so a cookie or a
  storage key set on one is never readable by a page on the other (§3.7). Whether each is a *registrable* name (one
  label under a public suffix) is not checked: that needs the public suffix list at run time, which the server does
  not carry. The operator runbook says it (§21.5).
- **Where they are read.** Only in hosted mode, where both are required (`domains-app-domain-missing`,
  `domains-site-domain-missing`). In self-hosted mode they are accepted and unused, and `config check` prints one
  line saying so; the public URL stays the one name a self-hosted server has.
- `tenantUrl()`, the resolver and `appDomainOf()` are unchanged: they read `appDomain` as slice 4 left them. The
  test-only field becomes the environment variable.

### 21.2 Reserved slugs (amends §3.6)

- **One list**, `src/tenancy/slugs.ts`, a frozen literal:
  - §3.6's: `app`, `api`, `www`, `docs`, `status`, `admin`, `agent`, `mail`, `help`, `support`, `billing`, `login`,
    `signup`;
  - every area id and every protocol kind id the app has (today `explorer`, `environments`, `search`, `history`, `wss`,
    `ssh`, `soap`, `rest`, `grpc`, `ws`, `mcp`), and the protocol names that are not kinds of their own (`graphql`, `http`,
    `https`, `telnet`, `serial`, `sftp`): a unit test imports `AREAS` and
    `KINDS` from `@wirebench/wire` and fails when one is missing, so a new area or kind cannot ship unreserved. The
    runtime list stays a literal, so the server's start-up imports nothing for it;
  - infrastructure names: `mx`, `smtp`, `imap`, `pop`, `ns1`, `ns2`, `cdn`, `static`, `assets`, `autoconfig`,
    `autodiscover`, `dev`, `staging`, `test`, `default`;
  - brand names: `wirebench`, `verathic`.
- **`checkSlug(slug)`** answers `ok`, `slug-invalid` (§19.2's syntax) or `slug-reserved`. `TenantAdmin.create`
  calls it first and throws `tenancy-slug-reserved` or `tenancy-slug-invalid`; it is the only writer of a slug in
  slice 6. Slice 7's signup, rename and `admin tenant create` call the same function.
- **Not in the database.** The `tenants.slug` check stays syntax only: the list changes with the app, and a check
  constraint would make every new area a migration. An existing tenant whose slug a later list reserves keeps it;
  only a new write is refused.
- **Self-hosted** never sees the list: the default tenant's slug is written by the migration, and `default` is on the
  list so no hosted tenant takes the name.

### 21.3 Resolution of the entry and the apex (amends §19.5)

In hosted mode the root `onRequest` hook reads the host key (§19.5) and branches before the tenant map:

| Host | Answer |
| --- | --- |
| `<app-domain>` (the apex) | `308` to `https://app.<app-domain>/`, path and query dropped, `cache-control: no-store`. |
| `app.<app-domain>` | The entry (§21.4): its own routes only. Any other path `404`s with an empty body, as an unknown slug does. `request.tenant` stays unresolved, so a module route that reached for it would throw rather than serve the default tenant. |
| `<slug>.<app-domain>` | Unchanged (§19.5). `app` is reserved, so the map never holds it; the branch above runs first all the same. |
| anything else | `404`, empty, `no-store` (unchanged). |

The entry's routes are registered with a Fastify host constraint of `app.<app-domain>`, so on a tenant host the same
paths do not exist. `/healthz` stays unscoped on every host.

### 21.4 The entry at `app.<app-domain>` (amends §3.2)

A server module, `src/entry/`, registered only in hosted mode.

- **`GET /`**: a small server-rendered page in the sign-in page's style (§17.2): the product name, one email field,
  one button, and a link to `https://<site-domain>/`. No script, no cookie, `cache-control: no-store`, the sign-in
  page's CSP.
- **`POST /`** (`application/x-www-form-urlencoded`, field `email`): the same page, saying "If that address has a
  team, a message is on its way." for every input, valid or not, known or not. The checks, in order:
  - the `Origin` header must be `https://app.<app-domain>`, else `403` (login CSRF would let a page make a visitor's
    browser mail someone);
  - a body over 1 KiB is `413`;
  - **rate limits**, in-process token buckets (identity's `RateLimiter`): 5 a minute per client address (behind the
    trusted proxy) and 3 an hour per lower-cased address. Over either limit the page is the same and nothing is
    queued: answering `429` would tell an address's owner nothing, but would tell a prober which addresses were
    being tried. A per-address bucket keyed by a keyed hash, so the map never holds an address in the clear;
  - a malformed address queues nothing.
- **The lookup runs after the answer.** A valid address joins an in-process queue of at most 200 items, served one at
  a time, and the response is sent before the lookup starts, so the time to answer does not say whether the address
  has a team. A full queue drops the item with a warning that names no address. A crash loses queued items; the
  person asks again (my call: an outbox table would hold addresses at rest for a mail that is only a convenience).
- **The lookup.** For each resolvable tenant (§19.5: active, not the default), one tenant unit through the job loop's
  shape (§19.8, guard 6) that reads `users` by `email_lower`, enabled only. No bypass role, no cross-tenant index.
  A tenant whose unit fails is skipped and logged by tenant id.
- **The mail.** One plain-text message per lookup with at least one match, none otherwise; sent through
  `WIREBENCH_SERVER_SMTP_URL` and `_SMTP_FROM` (owner ruling) with the alerts' transport (certificate always
  verified, the URL never printed). Subject "Your Wirebench teams"; the body lists each tenant's name and
  `https://<slug>.<app-domain>/sign-in`, then the site link, then "You asked for this at app.<app-domain>. If you
  did not, ignore it: nothing has changed." Plain text, so a tenant's name, which its admin writes, cannot carry
  markup into the message. The mail holds links only: no token, nothing that signs anyone in.
- **Hosted mode needs SMTP.** The module refuses to register without both SMTP settings
  (`entry-smtp-missing`), so a hosted server never shows a page that promises mail it cannot send.
- **Logs and audit.** One info line per lookup with the count of tenants matched and the time taken, never the
  address or a slug. Nothing is written to a tenant's audit chain: no tenant acted, and an address probe would
  otherwise land in a stranger's log.
- **Isolation.** The isolation suite (§19.13) classifies the entry's two routes as unscoped-by-host, and a test
  asserts that a match in tenant A and none in B mails A's link only, and that the page is byte-identical for a known
  address, an unknown one and a malformed one.

### 21.5 Certificates and the deployment recipe (owner ruling)

- **The server never touches TLS.** It stays plain HTTP behind a proxy, as every deployment is today.
  `WIREBENCH_SERVER_TRUST_PROXY=true` makes `request.hostname` and the client address the proxy's forwarded ones.
- **`packages/server/deploy/hosted/`** holds a compose file and a README:
  - **Traefik v3**, the only public listener: `:80` redirects to `:443`; one router for
    `Host(<app-domain>) || HostRegexp(^[a-z0-9-]+\.<app-domain>$)` to the server; one certificate resolver,
    Let's Encrypt by ACME DNS-01 with lego's `hetzner` provider, the token from `HETZNER_API_TOKEN` (a `_FILE` secret
    in the recipe), one certificate with main `<app-domain>` and SAN `*.<app-domain>` (a wildcard does not cover its
    apex). Certificates persist in a volume (`acme.json`, mode 600). HSTS without `preload` (preload is a later,
    one-way choice for a real domain).
  - **the server** with `WIREBENCH_SERVER_MODE=hosted`, both names from `.env`, the SMTP settings, the two database
    roles of §19.4, and no published port;
  - **PostgreSQL 16**, no published port.
  - `.env.example` names every variable with a placeholder (`APP_DOMAIN=example-app.test`); nothing real.
  - The DNS records the operator creates: `A`/`AAAA` for `<app-domain>` and `*.<app-domain>` to the proxy, and the
    site domain's own records, which point elsewhere (the site is static and built apart).
- **What proves it.** A unit test parses the compose file and the Traefik configuration and checks the router rule,
  the resolver, the two certificate names and that only Traefik publishes a port. `docker compose config` on the
  recipe runs in that test when Docker is present. A manual test (`docs/manual-tests/`) covers issuance against
  Let's Encrypt's staging endpoint once a domain exists. Running the whole recipe waits for slice 7, since hosted
  mode is refused until then.
- **Another DNS provider** is a change of `provider` and its token variable in the Traefik file; the README says so
  and names no other provider.

### 21.6 The public suffix list (operator step)

Not code. The runbook in `deploy/hosted/README.md` gives the steps, to take once `<app-domain>` is registered and
stable:

1. Keep the registration at least two years ahead; the list's maintainers ask for it.
2. Open a pull request to the list's private section adding `<app-domain>` under a comment naming the project and a
   contact address.
3. Add the TXT record `_psl.<app-domain>` holding that pull request's URL, and keep it as long as the entry is listed.
4. Until it is merged and shipped by browsers, which takes months, the `__Host-` cookie (§3.2) and per-origin storage
   protect sessions (§15).

### 21.7 Testing

- Config: each variable's shape, the apart rule both ways, required in hosted, unused-line in self-hosted.
- Slugs: every reserved slug refused by `TenantAdmin.create`; the `AREAS`/`KINDS` coverage test.
- Resolution: apex `308`, entry paths served and others `404`, entry routes absent on a tenant host, `request.tenant`
  unresolved on the entry.
- Entry: identical pages for known, unknown and malformed; `Origin` refused; both rate limits; queue bound; a lookup
  across two tenants mails only the matching tenant's link through a fake transport; disabled users and the default
  tenant never match; refused registration without SMTP.
- Recipe: the parse test of §21.5.

### 21.8 What slice 6 leaves for slices 7 and 8

- **7:** signup, rename and `admin tenant create` call `checkSlug`; renamed slugs' 30-day redirects and the retired
  list (§3.6); per-tenant SMTP senders (§19.1) do not change the entry, which mails as the operator; lifting the
  hosted refusal makes the recipe run.
- **8:** a custom name is one more resolver entry (§19.12) and one more Traefik router with an HTTP-01 certificate of
  its own; the entry and the wildcard are unchanged.

## 22. Slice 7 amendment: the control plane (2026-11-04)

Slice 7 (#829) is the control plane of §5.6: the module that creates, bills, suspends, renames, exports, imports and
deletes tenants, and the per-tenant settings that slice 4 deferred (§19.1). It is the slice that lets an operator
switch hosted mode on, so it lifts `loadConfig`'s refusal, in its last part (§22.1). It builds §3.6, §4.3, §5.6, §8's
`admin tenant` rows, §11's control-plane line, §13 criteria 5 and 6, and §19.12's and §21.8's slice 7 items. It builds
nothing of slice 8. Where the build differs from the sections above, this section wins. ADR-0039 records the decision
that the control plane alone bypasses row-level security and that billing reaches the server only as a verified
webhook. Plan: `docs/plans/2026-11-04-control-plane.md`.

Rulings that bind it, from earlier decisions: Paddle is the merchant of record and Enterprise is invoiced by Verathic
(decision 10); no free hosted tier (decision 7); EU only (decision 8); the control plane is the only module on the
bypass role and is loaded only in hosted mode (§12); a superuser connection is refused in hosted mode (§19.4); no
domain is owned, so every name is configuration (§21). There is no Paddle account yet: the verifier and the checkout
are built against Paddle's documented webhook signature and Paddle.js, tested with fixtures and a fake, and no real
key exists anywhere in the repository.

Owner rulings (popup, 2026-11-04):

1. **Signup lives at `app.<app-domain>/signup`**, on the entry host the server already serves. The site, which the
   server never serves (§21.1), links to it. This replaces §3.6's `https://<site-domain>/signup`.
2. **Unpaid means suspended 14 days after the subscription goes `past_due`.** Paddle's own payment retries run inside
   that window.
3. **A canceled subscription suspends the tenant and keeps its data until someone asks for deletion**: a tenant
   server admin or the operator. Nothing is deleted on a timer.
4. **The per-tenant settings get an API, an operator command and a settings screen in the app** in this slice, not a
   later one (§22.13).

### 22.1 Switching hosted mode on (amends §19.1)

- `WIREBENCH_SERVER_MODE=hosted` is accepted by `loadConfig` from Part H on (§22.19). Until then the refusal stays,
  and the parts are proven by tests that build a hosted `ServerConfig`, as slices 4 to 6 were.
- **Required in hosted mode,** each refused by name when missing: both names (§21.1); `WIREBENCH_SERVER_SMTP_URL`
  and `_SMTP_FROM` (moved from the entry's registration check into `loadConfig`, same code `entry-smtp-missing`);
  `WIREBENCH_SERVER_SECRETS_KEY` (every tenant needs a data key, §19.7); `WIREBENCH_SERVER_MIGRATION_DATABASE_URL`
  set apart from the app URL (two roles, §19.4); `WIREBENCH_SERVER_CONTROL_DATABASE_URL` (§22.2); and the Paddle
  settings of §22.5.
- **Refused in hosted mode,** because each is now a tenant's setting (§22.12): `WIREBENCH_SERVER_OIDC_*`,
  `_SAML_*`, `_AUDIT_FORWARD_*`, with `control-plane-setting-per-tenant` naming the variable. Silently ignoring an
  identity provider configured for the whole server would be the cross-tenant sign-in §19.1 exists to prevent.
- **Hosted mode means `multi`** (§20.1) and always denies private ranges (§17.5), as before.
- **Self-hosted is unchanged.** The new variables are refused there with `control-plane-hosted-only`, so a
  self-hosted operator who copies a hosted `.env` learns at once, rather than finding a Paddle secret ignored.

### 22.2 The control role (amends §4.2 and §19.4)

- **A third role,** `wirebench_control`: `login nosuperuser bypassrls noinherit`, in the new
  `WIREBENCH_SERVER_CONTROL_DATABASE_URL`. It is the only role that bypasses the policy, and only the control plane
  holds a connection on it.
- **Created by `admin tenancy role`** in hosted mode, beside the app role, with a SCRAM verifier computed in Node as
  for the app role. PostgreSQL lets only a superuser, or a role that itself has `BYPASSRLS`, create a `BYPASSRLS`
  role; an owner that may not gets `tenancy-control-role-create-refused` and uses `--print-sql`, which prints the
  statements for a superuser to run once.
- **Its grants:** `select, insert, update, delete` on `tenants` and on the control plane's own tables (§22.3);
  `select` on every scoped table, for the deletion check (§22.11); nothing else. It needs no write on a scoped table:
  every per-tenant write runs in that tenant's unit on the app role.
- **Checked at start-up in hosted mode,** after the app role's check of §19.4: the control role must have
  `rolbypassrls`, must not be a superuser (`control-plane-role-superuser`), must have neither `rolcreaterole` nor
  `rolcreatedb` (`control-plane-role-too-broad`), must own no table, schema, sequence, view, function or type
  (`control-plane-role-owns`), and must differ from both the app role and the owner. Any failure refuses start-up with its code.
- **Confined in code.** `controlDatabaseUrl` is not in `ModuleConfig`; `serve.ts` opens a pool of at most two
  connections and hands it to the control plane as a branded `ControlDb`, which only `src/control-plane/` may name.
  `check:tenant-scope` gains the rule, and allows `from tenants`, the control tables and `bypass` SQL in
  `src/control-plane/` only.
- **What it is used for,** and nothing else:

  | Use | Why it cannot be a tenant unit |
  | --- | --- |
  | Finding a tenant by its Paddle subscription | The webhook names a subscription, not a tenant |
  | The billing sweep (grace, suspension) | It reads every tenant's subscription at once |
  | Slug checks across `tenants`, `signups` and retired slugs | One answer across every tenant |
  | Tenant status, edition, rename and deletion writes | They change `tenants` itself |
  | The deletion check: no row of the tenant left in any scoped table | Proving absence needs a view across the policy |

### 22.3 The tables (amends §4.3)

Migration `0023`, under `packages/server/migrations/control-plane/`, owned by the control plane's `migrationsDir`
(the module is registered in every mode for its migrations, and serves nothing outside hosted mode).

```sql
alter table tenants
  add column edition_source text not null default 'license'
    check (edition_source in ('license', 'subscription', 'operator')),
  add column suspended_reason text check (suspended_reason in ('unpaid', 'canceled', 'operator', 'importing')),
  add column suspended_at timestamptz,
  add column deletion_requested_at timestamptz,
  add column deletion_requested_by text;      -- 'operator' or a user id; deleting_at is when the job runs

create table tenant_slugs_retired (            -- unscoped
  slug text primary key, tenant_id uuid not null, retired_at timestamptz not null default now(),
  redirect_to text, redirect_until timestamptz);

create table signups (                          -- unscoped: no tenant exists yet
  id uuid primary key, email_lower text not null, name text not null, slug text not null, seats integer not null,
  token_hash text not null unique, password_hash text, status text not null default 'pending'
    check (status in ('pending', 'verified', 'completed')),
  tenant_id uuid, created_at timestamptz not null default now(), expires_at timestamptz not null);
create unique index signups_slug_open on signups (slug) where status <> 'completed';

create table billing_events (                   -- unscoped: the provider's event ids, for replay and order
  provider text not null, event_id text not null, event_type text not null, occurred_at timestamptz not null,
  received_at timestamptz not null default now(), outcome text not null, primary key (provider, event_id));

create table tenant_deletions (                 -- unscoped: outlives the tenant
  tenant_id uuid primary key, slug text not null, requested_at timestamptz not null, deleted_at timestamptz not null,
  chain_seq bigint, chain_hash text, chain_key_id text);

-- scoped, each through tenant_scope() in the same file:
create table subscriptions (tenant_id …, provider text not null, provider_ref text not null, customer_ref text,
  plan text not null, seats integer not null, status text not null, current_period_end timestamptz,
  past_due_since timestamptz, last_event_at timestamptz not null, primary key (tenant_id));
create unique index subscriptions_ref on subscriptions (tenant_id, provider, provider_ref);
create table tenant_exports (tenant_id …, id text not null, requested_by text not null, status text not null,
  size_bytes bigint, sha256 text, error text, requested_at timestamptz not null default now(),
  ready_at timestamptz, expires_at timestamptz, primary key (tenant_id, id));
create table tenant_settings (tenant_id …, section text not null, value jsonb not null, sealed bytea,
  updated_at timestamptz not null default now(), updated_by text not null, primary key (tenant_id, section));
```

- **Unscoped allowlist** (guard 3, §19.8) gains `signups`, `billing_events`, `tenant_slugs_retired` and
  `tenant_deletions`; `check:tenant-scope` allows them in `src/control-plane/` only. The scoped list gains
  `subscriptions`, `tenant_exports` and `tenant_settings`.
- **A provider ref is unique across tenants** in practice (Paddle mints it), and the lookup runs on the control role;
  the composite index serves the tenant's own reads. The webhook refuses a ref already held by another tenant
  (`billing-ref-conflict`, logged by tenant id) rather than move a subscription between customers.
- **No `deleted` status.** A deleted tenant's row is removed (§22.11); `tenant_deletions` and the retired slug are
  what remain. A removed row also removes the data key, and with it the trap of `TenantKeys` lazily minting a new key
  for a null column (`tenancy/keys.ts`), which the deletion would otherwise have to fence.
- **Slug uniqueness across three tables** (amends §3.6's "the same unique index"): one index cannot span `tenants`,
  `signups` and `tenant_slugs_retired`, so every slug write takes `pg_advisory_xact_lock(SLUG_LOCK_CLASS,
  hashtext(SERVER_SCHEMA))` on the control role and checks all three in that transaction.

### 22.4 Edition and seats (amends §3.6 and §19.8, guard 5)

- **In hosted mode `LicenseService.state(scope)` reads the tenant row:** `tenants.edition` and `tenants.seats`, with
  the edition's features (`team` or `enterprise`; `community` is never a hosted edition). The license row is not
  read. `POST` of a license file answers `409 licensing-hosted`, and `admin license` refuses with the same code.
- **`edition_source`** says who set it: `license` (self-hosted, the default), `subscription` (a Team subscription),
  `operator` (`admin tenant set-edition`, for an Enterprise deal invoiced by Verathic). A webhook never changes a
  tenant whose source is `operator`; it records the subscription and logs that it was not applied.
- **Seats** are the subscription's quantity of the Team price (§22.5), or the operator's `--seats`. Seat counting,
  the seat lock and the host-instance cap (decision 11) read them through `state(scope)` unchanged. Lowering seats
  below enabled users disables nobody; new sign-ups and enables are refused at the limit, as in self-hosted mode.
- **Suspension does not change the edition**; it changes reachability (§22.7).

### 22.5 Paddle and the subscription adapter

- **Settings,** required in hosted mode:

  | Variable | Meaning |
  | --- | --- |
  | `WIREBENCH_SERVER_PADDLE_ENVIRONMENT` | `sandbox` or `production`; picks Paddle.js's environment. |
  | `WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN` | Paddle.js's client-side token (`test_…` or `live_…`; checked against the environment). Public by design. |
  | `WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID` | The Team seat price (`pri_…`). |
  | `WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET` | The notification destination's secret key (`pdl_ntfset_…`). Secret: never printed, `_FILE` accepted. |

- **The server never calls Paddle's API** (my call). It receives webhooks and renders the checkout overlay, nothing
  more, so it holds no API key that could refund, cancel or read customers. Changing seats or the card goes through
  Paddle's emailed customer portal; a seat change arrives as `subscription.updated`. A Paddle API client is a later
  decision if the settings screen ever needs a "change seats" button.
- **The webhook,** `POST /billing/paddle` on the entry host (`ENTRY_ROUTE`, so no tenant resolves):
  - raw body, at most 1 MiB, never parsed before the signature passes;
  - **signature:** the `Paddle-Signature` header is `ts=<unix>;h1=<hex>` with possibly several `h1` (Paddle sends
    more than one while a secret rotates). The signed payload is `<ts>:<raw body>`, HMAC-SHA256 under the secret;
    any `h1` that matches, compared in constant time, passes. `ts` must be within 300 s of now (my call: wider than
    the SDK's 5 s, because replays are stopped by the event id below, and a clock 10 s off must not drop billing).
    A failure answers `401` with an empty body and logs the reason code, never the header;
  - **replay and order:** `billing_events (provider, event_id)` is inserted first; a duplicate answers `200` and does
    nothing. An event older than the subscription's `last_event_at` is recorded and not applied (Paddle does not
    promise order);
  - answers `200` once applied, `500` on a database failure so Paddle retries, never another status.
- **The adapter,** `control-plane/billing/paddle.ts`, is the only file that knows Paddle's shapes. It turns an event
  into the control plane's own vocabulary (§5.6), and ignores every event type outside `subscription.*`:

  | Paddle `event_type` | Control plane event | Status |
  | --- | --- | --- |
  | `subscription.created` | `created` | from `data.status` |
  | `subscription.updated`, `.activated`, `.trialing`, `.past_due`, `.paused`, `.resumed`, `.imported` | `updated` | from `data.status` |
  | `subscription.canceled` | `deleted` | `canceled` |

  The event carries `ref` (`data.id`), `customerRef`, `status` (`active`, `trialing`, `past_due`, `paused`,
  `canceled`), `seats` (the summed `quantity` of items whose `price.id` is the Team price; zero refuses with
  `billing-no-team-item`), `periodEnd` (`current_billing_period.ends_at`), `occurredAt`, and from `custom_data` either
  `signup` (a signup id, §22.6) or `tenant` (a tenant id, for a resubscription).
- **Applying an event,** in one control transaction:
  - `created` with a `signup`: completes that signup (§22.6). With a `tenant`: attaches the subscription to it,
    replacing a canceled one. With neither: recorded, `outcome = 'unmatched'`, logged by event id.
  - `updated`: updates the row; `active` or `trialing` sets the tenant `team` (when its source is `subscription`)
    and its seats, clears `past_due_since`, and resumes a tenant suspended for `unpaid` or `canceled`; `past_due`
    sets `past_due_since` once; `paused` suspends at once with `canceled`.
  - `deleted`: suspends at once with `canceled` (Paddle sends it when the period ends, so the customer had what they
    paid for). Data is kept until a deletion is asked for (ruling 3).
- **The grace sweep** (§22.15) suspends with `unpaid` any tenant whose `past_due_since` is 14 days old (ruling 2).
  Each tenant's server admins are mailed through the operator's SMTP when it goes past due, three days before the
  suspension, and when it is suspended. The mails hold the team's name and a link to the tenant's sign-in page,
  nothing from Paddle.

### 22.6 Signup (amends §3.6; ruling 1)

Routes on the entry host, server-rendered in the entry page's style, no cookie at any step:

1. **`GET /signup`**: email, team name, slug, seats (1 to 500). **`POST /signup`** checks `Origin` (as §21.4), the body
   size, the entry's rate limits (5 a minute per address, 3 an hour per email, in the shared limiter once slice 5
   moves it), the email's syntax, the name (1–80 characters, plain text), and the slug: `checkSlug`, then free in
   `tenants`, open `signups` and `tenant_slugs_retired` under the slug lock (§22.3). A taken or reserved slug
   re-renders the form saying so; this is the one place a slug's existence is answered, and slugs are public names.
   On success it inserts the signup (24 h expiry, the slug held that long), mails a link
   `https://app.<app-domain>/signup/<token>`, and answers "Check your inbox". An address that already has teams may
   sign up another; the answer is the same either way.
2. **`GET /signup/<token>`**: the token is 32 random bytes, stored as a hash, single-use for the password step. The
   page asks for the first admin's password (`MIN_PASSWORD_LENGTH`) and shows the price summary. **`POST`** stores the
   password's scrypt hash on the signup, marks it `verified`, and renders the checkout step.
3. **The checkout step** loads Paddle.js (`https://cdn.paddle.com/paddle/v2/paddle.js`, the only third-party script
   the server ever serves, on this page only, with a CSP naming Paddle's script, frame and connect origins) and opens
   the overlay with the Team price, the seat quantity, the customer's email, and `customData: { signup: <id> }`.
   The page then polls `GET /signup/<token>/status` every 2 s.
4. **`subscription.created`** with that signup id (§22.5) completes it in one control transaction plus one tenant
   unit: `TenantAdmin.create` (slug, name, edition `team`, source `subscription`, region `eu`), the first user as
   server admin with the stored hash, the subscription row, the audit events `tenant.created` and `user.created`,
   then the signup `completed` and its `password_hash` cleared.
5. **The status poll** answers `pending` until then, and `ready` with `https://<slug>.<app-domain>/sign-in`; the page
   goes there and the person signs in with the email and password they chose. That is §13 criterion 5's "first
   sign-in", with no operator.

- An expired signup is deleted by the sweep, and its slug is free again. A signup that paid but whose token expired
  before the webhook arrived is still completed: the webhook, not the token, completes it.
- The verification mail and every page are plain text or escaped HTML; the team name is never markup.

### 22.7 Suspension (amends §3.6 and §19.5)

- **Who suspends:** the billing paths (`unpaid`, `canceled`), the operator (`operator`), the import (`importing`,
  §22.10). **Who resumes:** an `active` subscription for `unpaid` and `canceled`; `admin tenant resume` for any.
- **The resolver keeps suspended tenants** (amends §19.5's "answers `404`"): the hosted map holds active and
  suspended tenants with their status and reason. On a suspended tenant's host:
  - `GET /sign-in` renders the sign-in page with no form and one paragraph per reason: unpaid ("This team's
    subscription is unpaid. Its billing contact can pay from the email Paddle sent."), canceled, operator ("… by the
    operator. Contact support."), importing ("… being imported. Try again shortly.");
  - `/hooks/…` (catch URLs) answers `503` with an empty body (§3.6);
  - every other route, the API and both WebSocket upgrades answer `403` with `{ code: "tenant-suspended", reason }`,
    so the desktop, the CLI and the MCP server say why;
  - no one signs in, server admins included (my call): paying, and asking for an export or a deletion, go through
    Paddle and the operator while suspended.
- **At the moment of suspension** the status write announces `tenantsChanged` over the bus (§20.3). Every instance
  then closes that tenant's live sockets (`4403 tenant-suspended`), disposes its host instances and releases their
  leases, and ends its terminal shares.
- **Jobs** (§19.8, guard 6): `forEachTenant` still visits suspended tenants, so retention ages their data out as
  before. The scheduler does not fire their schedules, and when a tenant resumes each schedule's next run is computed
  from then, never caught up. The alert outbox holds their alerts. The audit sealer and forwarder keep running.
- `deleting` stays `404`, as in slice 4.

### 22.8 Rename and retired slugs (amends §3.6; §21.8)

- `admin tenant rename <slug> <new>` (operator only in this slice, my call) checks the new slug as a signup does,
  then in one control transaction moves `tenants.slug`, and inserts the old one into `tenant_slugs_retired` with
  `redirect_to` the new and `redirect_until` 30 days on.
- While a redirect lives, the resolver answers the old host with `308` to the same path and query on the new host.
  After it, the old host answers `404` like any unknown name, and the slug is never written again.
- A deleted tenant's slug is retired with no redirect (§22.11).

### 22.9 Export (amends §3.6)

- **Who:** a tenant server admin (§22.13, `POST /api/v1/tenant/exports`), or the operator (`admin tenant export
  <slug> --out <file>`; on a self-hosted server `admin tenant export --out <file>` exports its one tenant). One
  export runs per tenant at a time; a tenant keeps at most three.
- **The file,** `wirebench-export-<slug>-<utc>.tar.gz`, written by a small in-house ustar writer over `node:zlib`
  (no dependency):
  - `manifest.json`: `format: 1`, the server version, the tenant (id, slug, name, edition, region), the export time,
    every table with its row count and SHA-256, every workspace's bundle with its SHA-256, and the audit chain block
    (below);
  - `tables/<table>.ndjson`: one JSON object per row, columns by name, `bytea` as base64;
  - `repos/<workspaceId>.bundle`: `git bundle create … --all`, taken under the repository lock (`bundle` joins the
    engine's allowed git subcommands for the server only).
- **What is exported.** Every scoped table is classified in `control-plane/export/tables.ts` as `export`,
  `redact(columns)` or `skip`, and a test fails when a scoped table is missing from the list, as the route map does
  (§19.13). Skipped: the short-lived tables (flows, nonces, `device_tokens`, `agent_pairing_codes`, `agent_nonces`,
  `host_leases`, `limiter_buckets`, `send_slots`, `terminal_share_locations`, `audit_forward_queue`) and the control
  plane's own (`subscriptions`, `tenant_exports`). Redacted to null: every sealed value (`catch_urls.signature_secret`,
  `schedules.secrets`, `schedules.alerts`, `tenant_settings.sealed`). **Sealed secrets are never exported** (§3.6),
  and neither are checkouts or the users' sealed `secrets.json`. Password and token hashes are exported, so people
  sign in after an import; the export is therefore as sensitive as the database, and is said so on the screen.
- **The audit chain verifies on its own** (§13 criterion 6). `audit_events` is exported with its chain columns and
  `audit_chain_anchor` whole, and the manifest's chain block holds the tenant's chain key (hex), its key id and the
  anchor. `wirebench-server admin audit verify --export <file>` verifies an export with no database. Carrying the key
  is my call: the chain proves the export was not edited after the server wrote it, to the customer's auditor, who
  has no server to ask; the server's own record of the anchor is the independent witness.
- **Consistency.** The tables are read in one repeatable-read tenant transaction, then the bundles are taken. A push
  between the two lands in the bundle and not in the tables' snapshot of `workspaces`' heads; the manifest records
  both times (my call: a lock over a whole export would stop the team's work).
- **Delivery** (amends §3.6's "signed download link"): the file is written to `<tenantRoot>/exports/<id>.tar.gz` and
  served by `GET /api/v1/tenant/exports/:id/file` to a signed-in server admin of that tenant only, because §6 puts no
  token in a URL ever. Ready exports are mailed to the requester as a link to the settings screen, and expire after
  seven days, when the sweep deletes the file.

### 22.10 Import (amends §8 and §19.11)

- **`admin tenant import <file>`** restores an export. In hosted mode it makes a new tenant (`--slug`, `--name`,
  `--edition team|enterprise`, `--seats`; edition source `operator`), created `suspended` with reason `importing` and
  resumed at the end. On a self-hosted server it imports into the one tenant, which must hold no user and no
  workspace (`import-target-not-empty`).
- **Steps,** each resumable from the manifest: verify every checksum and the audit chain under the export's key
  (`import-chain-broken` refuses); insert the tables in foreign-key order, read from the catalog, inside the new
  tenant's units, with `tenant_id` rewritten; create each repository and fetch its bundle into it (`refs/*:refs/*`);
  re-seal the audit chain under the target tenant's key from the first event, then write `tenant.imported` with the
  source tenant id, key id, last sequence and hash. Re-keying is how §19.12's promise is met: a hosted tenant's chain
  is always under its derived key, and the source chain's seal is kept in that event (amends ADR-0036's note).
- **What does not come back:** sealed values (so a schedule that held secrets is imported disabled, and a catch URL
  with a signature secret is imported without one), sessions and device tokens (people sign in again), pairings and
  checkouts. The command prints each such item by id.
- **`admin tenant migrate-self-hosted` is not a command** (amends §8): the migration of an installation is its own
  export (`admin tenant export` on the self-hosted server) followed by `admin tenant import` on the hosted one, as
  §19.11 foresaw.

### 22.11 Deletion (amends §3.6)

- **Asked** by a tenant server admin (§22.13: they type the slug to confirm) or by the operator (`admin tenant
  delete <slug>`). It sets `deletion_requested_at`, `deletion_requested_by` and `deleting_at` 14 days on, mails every
  server admin, and leaves the tenant working, with a banner on the settings screen. A server admin or the operator
  cancels it until then (`--cancel`).
- **The subscription first.** The server cannot cancel a Paddle subscription (§22.5), so the request says to cancel
  it in Paddle's portal, and the deletion job waits while the subscription is `active`, `trialing` or `past_due`,
  logging `deletion-subscription-active` daily. A customer is never billed for a deleted team.
- **The job** (§22.15), at `deleting_at`, each step idempotent so a crash resumes it:
  1. status `deleting`, announced over the bus: the resolver drops the host, and every instance closes the tenant's
     sockets and hosts (§22.7);
  2. every scoped table's rows deleted in reverse foreign-key order, in the tenant's units on the app role;
  3. `<dataDir>/tenants/<id>/` removed: repositories, checkouts, temporary files and exports;
  4. one control transaction: the audit chain's last anchor into `tenant_deletions` (§3.6), the slug into
     `tenant_slugs_retired` with no redirect, and the `tenants` row removed, which removes the data key;
  5. the check: on the control role, every scoped table holds no row with that `tenant_id`. A row found logs
     `deletion-incomplete` by table and tenant id, and the job runs again next pass.
- **Backups** keep the data key until their retention ends (§19.7); the runbook says the deletion is final then.

### 22.12 Per-tenant settings (amends §19.1; owner ruling 2026-10-29)

- **Sections,** one row each in `tenant_settings`:

  | Section | Fields | Secret fields (sealed) | Who writes |
  | --- | --- | --- | --- |
  | `oidc` | issuer, client id, scopes, display name | client secret | tenant server admin |
  | `saml` | IdP metadata XML, display name, email and name attributes, clock skew | — | tenant server admin |
  | `auditForward` | URL, CA (PEM) | token | tenant server admin |
  | `smtp` | URL host part, from | the URL's credentials | tenant server admin |
  | `retention` | audit, captures, schedules and session-log ages; captures kept; session-log size | — | tenant server admin, within the operator's maxima |
  | `budgets` | sends per minute, burst, concurrent sends, run slots (§20.7) | — | operator only |

- **Secret fields** are sealed under the tenant's data key (AES-256-GCM, as the users' secrets), written through the
  API and never read back: a read answers `{ set: true }`. Deletion removes them with the row and the key.
- **Resolution.** `ctx.settings.of(scope, section)` reads and caches per tenant, invalidated by a new bus event
  `tenantSettingsChanged`. In self-hosted mode the default tenant's settings are today's environment, and the table
  is not read: the API answers each section read-only with `source: "environment"`. In hosted mode the table is the
  only source; the environment's SMTP is the fallback sender, its retention values are each setting's default and
  maximum, and its budgets are the defaults (§20.7).
- **What each module does with them:**
  - identity builds an OIDC client per tenant on first use (discovery cached an hour, fetched under the egress rule),
    so each tenant's link-by-verified-email (`identity/linking.ts`) trusts only its own provider;
  - SSO builds a SAML provider per tenant from the stored metadata (pasted XML, never fetched by the server, my
    call), and registers the SAML and SCIM routes in hosted mode. A tenant without settings answers as a disabled
    method, as a self-hosted server without OIDC does today. The `404` of §19.1 goes;
  - the audit forwarder keeps one sink per tenant, with its own backoff, and a failed send stops only that tenant's
    batch (§19.12's promise M1);
  - alerts and the control plane's tenant mails use the tenant's SMTP when set, else the operator's;
  - each retention sweep reads the tenant's ages inside its `forEachTenant` unit;
  - the budgets read the tenant's override, else the defaults, through slice 5's budget code (built on it after it
    merges).
- **Checked on save:** an OIDC issuer must be `https` and its discovery must answer; SAML metadata must parse and
  carry a signing certificate; a forward URL must be `https` with no credentials; an SMTP URL `smtp:` or `smtps:`. Each
  change writes `settings.changed` with the section name, never a value.
- **API,** server admins of the tenant only: `GET /api/v1/tenant/settings`, `PUT` and `DELETE
  /api/v1/tenant/settings/:section`. `budgets` answers `403 settings-operator-only` to a tenant. The operator uses
  `admin tenant settings <slug> get|set|clear <section> [--file <json>]`.
- **Two tenants through the routes** (§19.12's promise): OIDC, SAML and SCIM run their two-tenant cases end to end,
  each tenant with its own provider.

### 22.13 The settings screen (ruling 4)

- **Where:** a *Server* page in the app's full-window Settings, shown to a server admin of the connected server: in
  the browser client always, and in the desktop app when it is signed in to a team server. It reaches the server
  through new channels (`serverSettings.*`, `tenantBilling.get`, `tenantExports.*`, `tenantDeletion.*`) that the host
  serves over the server's API; the server host's allowlist (§3.10) gains them, the agent's browser subset does not.
- **Sections:** Sign-in (OIDC, SAML), Provisioning (SCIM tokens: list, create once-shown, revoke), Audit forwarding,
  Email, Retention, and in hosted mode Billing (plan, seats, status, period end, a past-due banner with the days
  left, "Manage billing from Paddle's emails"), Export (request, list, download) and Delete team (request with the
  slug typed, cancel, the countdown).
- **Self-hosted:** each environment-backed section is read-only with "Set by the server's environment"; Billing and
  Delete team are absent; Export is present, since it is the first half of a move to hosted.
- **Secrets** are inputs that never show a stored value: "Set — replace" or "Not set".
- The page follows the Settings page's layout (#396) and is shown as a mockup before it is built (Part G).

### 22.14 Admin commands (amends §8 and §19.11)

| Command | Does |
| --- | --- |
| `admin tenant list` | Slug, status and reason, edition and source, seats, subscription status, deletion date. Names no user. |
| `admin tenant create --slug --name --email [--edition team\|enterprise] [--seats n]` | Sales-led creation (source `operator`); mails the email a server-admin invitation, or prints its link without SMTP. |
| `admin tenant set-edition <slug> <edition> [--seats n] [--subscription]` | Operator override, or with `--subscription` back to the subscription's edition. |
| `admin tenant suspend <slug>` / `resume <slug>` | Reason `operator`; resume clears any reason. |
| `admin tenant rename <slug> <new>` | §22.8. |
| `admin tenant export [<slug>] --out <file>` | §22.9; no slug on a self-hosted server. |
| `admin tenant import <file> [--slug --name --edition --seats]` | §22.10. |
| `admin tenant delete <slug> [--cancel]` | §22.11. |
| `admin tenant settings <slug> get\|set\|clear <section> [--file]` | §22.12. |

- The slug is positional; `--tenant` is not used here. In self-hosted mode only `export` and `import` run; the rest
  refuse with `admin-tenant-hosted-only`.
- Each command that writes records an event in the tenant's chain, `tenant.<verb>`, with the actor `operator`, before
  a deletion removes the chain.

### 22.15 The control loop

- One loop per instance every 60 s, each pass under `pg_try_advisory_xact_lock(CONTROL_LOOP_CLASS,
  hashtext(SERVER_SCHEMA))` so one instance runs it at a time: the grace sweep and its mails, due deletions, queued
  exports (one at a time), expired exports, expired signups, ended redirects, and `billing_events` older than 90 days.
- A step's failure is logged with the step and the tenant id, and does not stop the others.

### 22.16 Security

- The webhook is the only way billing reaches the server, signature first, and the server holds no Paddle key that
  can act (§22.5). The webhook secret is never logged or printed; `config check` says only whether it is set.
- The control role is the only bypass, and its pool, its URL and its tables are confined to one directory by the
  type system and `check:tenant-scope` (§22.2).
- Signup answers whether a slug is free, which a public name has to; it never answers whether an address has a team.
- An export holds password hashes and captures: only a tenant's server admins and the operator reach it, behind a
  session, never a link alone.
- The checkout page is the only page that loads a third-party script, and only Paddle's.

### 22.17 Testing

- **§11's control-plane line, end to end** on a hosted test server with a fake checkout that posts signed webhook
  fixtures: signup to first sign-in; subscription webhook to edition and seats; past-due to suspension after the
  grace (time injected); suspend to refused sign-in, `403` on the API, `503` on a catch URL, closed sockets; delete to
  empty directories and rows, checked on the control role; export verifies its audit chain offline.
- **§13 criterion 6:** an export of a self-hosted server imports into a hosted test server and back into an empty
  self-hosted one, and every workspace syncs after.
- **The verifier** against Paddle's documented example, a rotated header with two `h1`, a stale `ts`, a body changed
  by one byte; the adapter against fixtures of each `subscription.*` type; replay and out-of-order events.
- **Roles:** start-up refuses a superuser control role, one without bypass, one equal to the app role; the app role
  still cannot bypass; `check:tenant-scope` refuses the control pool outside `src/control-plane/`.
- **The guards:** the export classification test, the route map gains every new route (`entry` for signup and the
  webhook, `own` for the tenant routes), the migration test's lists, and two-tenant cases for every tenant route.
- **The screen:** component tests per section, and one browser e2e that signs in as a server admin and saves an
  OIDC section against a fake issuer.

### 22.18 What §22 changes in §3.6, §4.3, §8, §19, §21 and ADR-0036

- §3.6: signup moves to the entry host (ruling 1); slug uniqueness is a lock over three tables, not one index; the
  export link is a session-guarded download; suspension keeps sign-in pages that say why.
- §4.3: the tables of §22.3, with `subscriptions` keyed by tenant and `signups` unscoped.
- §8: `admin tenant migrate-self-hosted` is export plus import; `list`, `rename` and `settings` are added.
- §19.1: hosted mode is accepted, the federated `404`s go, and the identity, SSO and forwarding variables are refused
  in hosted mode.
- §19.5: the resolver keeps suspended tenants and retired redirects.
- §19.8, guard 3: four unscoped tables join the allowlist, three scoped tables join the scoped list.
- §21.4: the entry host serves signup and the billing webhook beside its page.
- ADR-0036: an import re-keys the chain under the target tenant's key and records the source seal.

### 22.19 Parts and success criteria (amends §13)

Eight parts, one pull request each (the plan has the tasks): A the control role, the tables and the module; B tenant
lifecycle and the operator commands; C suspension; D billing; E signup; F export, import and deletion; G per-tenant
settings and the screen; H hosted mode switched on, the recipe run end to end, and the docs. Slice 7 is done when §11's
control-plane line holds, §13 criteria 5 and 6 hold, §22.17 passes, and a self-hosted server behaves as before with
no new variable set.

## 23. Slice 8 amendment: custom domains (2026-11-04)

Slice 8 (#830) lets an Enterprise tenant serve the product at a name of its own, such as `wirebench.example.com`.
The name is proved by a CNAME and a TXT record and gets a certificate of its own from the proxy. It builds §3.7's
custom-name paragraph and the slice 8 items of §19.12 and §21.8, and builds on slice 7's edition (§22). Where the
build differs from the sections above, this section wins. ADR-0040. Plan: `docs/plans/2026-11-04-custom-domains.md`.

§3.7 says the check reuses "the domain-verification shape of the SAML and SCIM module". That module has none: it
trusts the identity provider's assertions and never checks a domain. This section defines the shape, and any later
domain check (an email domain for SAML, say) should reuse it.

Owner rulings (2026-11-04, popup):

- The custom name is a **second full name**: both names serve the whole app, and the custom name becomes the
  tenant's primary.
- The CNAME points at one **fixed target, `custom.<app-domain>`**.
- **One** custom name per tenant.
- Tenant admins manage it through **the API, an admin command and a Settings tab**.

### 23.1 The name and its records

- **Who.** A tenant admin, with the `custom-domains` feature: a new entry in `FEATURES`
  (`packages/core/src/server-api/licensing.ts`). An Enterprise license or subscription grants every feature, so this
  is Enterprise only. In hosted mode `requireFeature` reads slice 7's per-tenant state, and this slice reads no
  edition column itself. Self-hosted servers have no use for a custom name: they choose their own public URL. There
  the routes answer `404` (`custom-domains-hosted-only`) and the tab is hidden.
- **The name.** `checkCustomName(name, config)` answers `ok` or a reason:
  - the shape of §21.1 (lower-cased, at least two labels, no scheme, port, path, trailing dot or IP literal), plus no
    `*` label;
  - `custom-name-ours`: the app domain, the site domain, or any name under either;
  - `custom-name-local`: `localhost` or a name under `.localhost`, `.local`, `.internal`, `.test`, `.example` or
    `.invalid`. Tests pass a test-only allowance to use `.test`.

  An apex (`example.com`) passes the shape check but cannot hold a CNAME, so its check never succeeds, and the
  Settings tab says so. The server carries no public suffix list (§21.1), so it cannot refuse an apex outright.
- **The records** the server shows, with a token made once per claim (32 random bytes, base64url):

  | Type | Name | Value |
  | --- | --- | --- |
  | `CNAME` | `<name>` | `custom.<app-domain>` |
  | `TXT` | `_wirebench.<name>` | `wirebench-domain-verification=<token>` |

  `custom` joins the reserved slugs (§21.2), so no tenant takes it. It needs no DNS record of its own, since the
  wildcard `*.<app-domain>` already covers it. The proxy routes nothing to it by name, so it answers `404` like an
  unknown slug.
- **One per tenant.** A second claim is refused with `custom-domains-one-per-tenant` until the first is removed.
- **Claims block no one.** Any number of tenants may claim the same name while it is unverified. The first to pass
  the check holds it. Holding is a primary key on the name in `tenant_hosts` (§23.3), so two checks cannot both win.
  A claim that sees the name held elsewhere shows `held-elsewhere`, never by whom.

### 23.2 The check

- **What passes.** Both of these, through one resolver:
  - **CNAME:** the name's CNAME is `custom.<app-domain>`, compared lower-case without the trailing dot. A provider that
    flattens CNAMEs (an "alias" at the apex, or a proxied record) also passes when the name's A and AAAA answers
    equal `custom.<app-domain>`'s, both non-empty.
  - **TXT:** one TXT string at `_wirebench.<name>` equals the claim's value exactly. Other strings at that name are
    ignored.
- **The resolver.** `node:dns/promises`' `Resolver`, using the servers in `WIREBENCH_SERVER_DNS_SERVERS` when set
  (comma-separated `host[:port]`), else the system's. A 5-second timeout and two tries per query. Tests inject a fake
  `DnsLookup`; no test asks real DNS.
- **When it runs.**
  - On demand: `POST …/check`, at most once a minute per tenant, otherwise `429` with `retry-after`.
  - From the job loop (§19.8, guard 6), in each tenant's own unit: hourly for pending claims (for 7 days, after which
    a claim is `expired` and stays until removed), and every 6 hours for verified and active names.
- **States.**

  | State | Meaning | Served? |
  | --- | --- | --- |
  | `pending` | Claimed, records not yet seen | no |
  | `verified` | Records seen, the name held in `tenant_hosts`, waiting for its certificate | no |
  | `active` | Certificate live (§23.4) | yes, and it is the primary |
  | `failing` | Records missing on a re-check since `failing_since`; still served | yes |
  | `lapsed` | Failing for 72 hours: released from `tenant_hosts`, router gone | no |
  | `paused` | The feature is gone (the edition left Enterprise): released | no |
  | `expired` | Pending for 7 days without a pass | no |

  A pass from `failing`, `lapsed` or `paused` goes back through `verified`, so an attacker who takes over a lapsed
  name has to prove it again. `paused` is set by the check job, which reads the feature through the tenant's scope.
  A suspended tenant keeps its name. The resolver drops every host of a tenant that is not `active` in
  `tenants.status` (§19.5), so a suspension takes effect at the next map reload, and resuming needs no new check.
- **Mail.** The tenant's server admins get one plain-text mail, through the tenant's SMTP sender (slice 7), when a
  name becomes `active`, `failing` or `lapsed`. Nothing is mailed without SMTP. Each change is an audit event in the
  tenant's chain: `custom-domain.claimed|verified|activated|failing|lapsed|paused|removed`. The token never appears in
  a log line or an audit event.

### 23.3 Storage (one migration)

- **`custom_domains`**, tenant-scoped under forced row-level security like every tenant table (§19.4):
  `tenant_id`, `name`, `token`, `state`, `created_by`, `created_at`, `checked_at`, `verified_at`, `active_at`,
  `failing_since` and `last_result` (jsonb: `cname`, `txt` and `certificate`, each `ok`, `missing` or `wrong`, plus a
  message). Primary key `(tenant_id)`, which is the one-per-tenant rule.
- **`tenant_hosts`**, **unscoped**, the custom-name counterpart of `tenants.slug`: `host` (primary key), `tenant_id`
  (references `tenants`, `on delete cascade`), `live` (boolean: certificate seen) and `since`. It holds no tenant
  content, only routing, and joins the migration test's allowlist of global tables (§19.13, guard 3) with that reason.
  Only the custom-domains module writes it: the claim's own row, inside the tenant unit that changes the claim's
  state. `check:tenant-scope` keeps the table's name to `src/custom-domains/` and `src/tenancy/directory.ts` (the
  resolver's read), as it keeps `server_instances` to `src/operations/` (§20.2).
- The migration takes the next free number when it merges: `allMigrations` refuses gaps across folders, so a
  number claimed ahead of slices 5 and 7 cannot land first. Like slice 5's, it lives in a fixed folder
  (`migrations/custom-domains/`) loaded with the tenancy migrations, since it calls `tenant_scope()`, and it runs in
  every mode so the schema never depends on the edition.
- Slice 7's deletion removes `custom_domains` with every tenant table, and the foreign key cascades to `tenant_hosts`.

### 23.4 Certificates and the proxy (amends §21.5)

- **The server still never touches TLS.** Traefik issues one certificate per verified name by **HTTP-01**, on the `web`
  entry point. A wildcard is not possible for a name we do not hold DNS for. Traefik's ACME challenge router takes
  precedence over the entry point's redirect to `https`.
- **Traefik learns the names from the server**, through its HTTP provider, which polls
  `GET /proxy/traefik` every 10 seconds. The endpoint is on a **second, internal listener**,
  `WIREBENCH_SERVER_PROXY_LISTEN` (default unset, so no listener). The recipe sets it to `0.0.0.0:8081` on the
  compose network, and Traefik's public routers never point at it. Every request must carry
  `authorization: Bearer <token>`, with the token read from `WIREBENCH_SERVER_PROXY_TOKEN_FILE`; otherwise `401`. The
  listener serves that one route and `/healthz`. Each instance answers the same payload, built from `tenant_hosts`.
- **The payload** has one router per held name (`verified`, `active` or `failing`):
  `Host(<name>)`, entry point `websecure`, `service: wirebench@file`, `middlewares: [hsts@file]` and
  `tls.certResolver: le-http`. Traefik asks for the certificate as soon as a router appears, which is why only a
  verified name gets one: an unproved name would spend the CA's rate limit on a name we cannot answer for. Router
  names are `custom-` plus a hash of the host, so a name's characters never become a Traefik identifier. A name
  whose router disappears keeps its certificate in `acme.json` until it expires. Traefik prunes nothing, and that is
  harmless.
- **`verified` → `active`.** The check job opens a TLS connection to `WIREBENCH_SERVER_PROXY_TLS_ADDRESS`
  (`traefik:443` in the recipe), sends the name as SNI, and requires a chain that verifies against the system roots
  (or `WIREBENCH_SERVER_PROXY_TLS_CA_FILE`, which only the Pebble test sets) and covers the name. On success it sets
  `live` in `tenant_hosts` and the state to `active`. Until then the resolver does not map the name, so a request that
  reaches it early answers `404`.
- **The recipe** (`deploy/hosted/`) adds `--providers.http.endpoint=http://server:8081/proxy/traefik`, its poll
  interval and its header. Traefik's provider headers take a value, not a file, so the header is
  `Bearer ${PROXY_TOKEN}` by compose's interpolation from `.env`, and the server reads the same variable as a file:
  a compose secret whose source is `PROXY_TOKEN`, at `WIREBENCH_SERVER_PROXY_TOKEN_FILE`. One value, so the two
  cannot drift. It also adds a second resolver, `le-http`, with
  `httpChallenge.entryPoint=web` and the same storage, and the server's new variables. The DNS records the operator
  creates are unchanged: `custom.<app-domain>` is under the wildcard.

### 23.5 Two names, one tenant (amends §19.5)

- **Resolution.** `TenantResolver` keys its map by full host name (§19.12), so each live custom name is one more key
  next to `<slug>.<app-domain>`, on the same `TenantEntry` as the slug's. The directory's read that feeds the map
  carries each tenant's live custom host (`tenant_hosts where live`) as `TenantScope.customHost`, for exactly the
  tenants the slug keys cover. The custom host has no status of its own: whatever the entry says of the tenant applies
  to both names, so a suspended tenant's custom host answers as its slug does (§22), and resuming needs no new check.
  A custom name that is not live answers `404`, empty and `no-store`, like any unknown host. When the check job makes
  a name live, or a name is released, the directory's change reloads this instance's map and `tenantsChanged` reloads
  every other's (§20.3). The apex and entry branches (§21.3) run first and are unchanged.
- **`tenantUrl` splits in two** (`tenancy/urls.ts`):
  - `tenantUrl(config, request)` is the URL of the host the request came on, slug or custom. Every check that
    compares with what the browser is showing reads this: `Origin`, the cookie's `Secure` choice, the browser
    client's base, the host's in-process transport and the agent pairing origin. Each host keeps its own `__Host-`
    cookie and its own sign-in. A person signed in on one name is not signed in on the other, which is what a browser
    does with two origins anyway.
  - `primaryUrl(config, scope)` is `https://<custom name>` while one is active, else `https://<slug>.<app-domain>`.
    Everything sent to someone not looking at a page reads this: invitation and alert links, mail, catch URLs shown
    to an admin, the OIDC redirect URI and the SAML entity ID and ACS URL, and the SCIM base URL.
    `tenantUrl(config, scope)` (a scope, not a request) becomes `primaryUrl`.
  - **Federated sign-in completes on the primary name.** A person who starts an OIDC or SAML sign-in on the slug name
    is sent through the identity provider to the primary name, and their session lands there. The identity provider
    needs only one redirect URI.
- **Switching the primary.** When a name becomes `active`, and again when it lapses, the identity-provider URLs move
  between the two names. The admin's Settings tab and the activation mail say so: update the identity provider's
  redirect URI or ACS URL, or sign-in through it fails until they do. Local and emailed sign-in are unaffected.
  Agent pairings stay bound to the origin they were made on (§3.8), so a machine paired on one name serves only pages
  on that name, and pairing again on the other name adds a second pairing.
- **Self-hosted** is untouched: `primaryUrl` and `tenantUrl` both return `WIREBENCH_SERVER_PUBLIC_URL`.

### 23.6 Routes, command and Settings

- **Routes**, under the tenant, server-admin only, behind `requireFeature('custom-domains')`, in hosted mode only:
  - `GET /api/v1/tenant/domain`: the claim, or `{}`. Shows the name, the state, the two records, the last result and
    when it was checked.
  - `PUT /api/v1/tenant/domain` with `{ name }`: claims the name. `409` if one exists, `400` with the reason from
    `checkCustomName`.
  - `POST /api/v1/tenant/domain/check`: checks now, then answers like `GET`.
  - `DELETE /api/v1/tenant/domain`: releases the name, drops the router at Traefik's next poll, and moves the primary
    back to the slug.
- **Admin command:** `wirebench-server admin domains list` (every tenant's claim: slug, name, state, checked at; the
  operator's view), `admin domains check --tenant <slug>` and `admin domains remove --tenant <slug>`, which an
  operator uses for abuse or a support case.
- **Settings:** a **Domain** tab in the team dialog's admin tabs, beside License and Provisioning. It is shown to
  server admins of a hosted server whose license state grants `custom-domains`. It has the name field, the two
  records with copy buttons, the state with its last result in words, **Check now**, **Remove**, and the
  identity-provider notice of §23.5. It works the same in the desktop app and the browser client.

### 23.7 Security

- **Takeover.** A dangling CNAME, where a customer removed their claim but left the record, gives an attacker
  nothing. Serving a name needs a TXT token that only the claiming tenant sees, and a new claimant gets a new token.
- **Name squatting.** A pending claim blocks no one (§23.1), and only a pass holds a name.
- **Cross-tenant reads.** The only cross-tenant data is `tenant_hosts`: host names, which are public in DNS anyway.
  Tokens, states and results stay under row-level security. Routes never say which tenant holds a name.
- **The proxy endpoint** lists host names only, behind a bearer token on a listener that is not public.
- **Rate.** On-demand checks are bounded per tenant. The job's queries are bounded by one claim per tenant.

### 23.8 Testing

- `checkCustomName`: each reason, including names under the app and site domains and local suffixes.
- The check, against a fake `DnsLookup`: CNAME match, case and trailing dot, flattened A/AAAA match and mismatch, TXT
  among other strings, a wrong token, timeouts. Every state change in §23.2's table, including 72 hours of failing,
  7 days pending, the feature gone, and back through `verified`.
- Holding: two tenants verify the same name at once and exactly one holds it; the other sees `held-elsewhere`.
- Two-tenant isolation (§19.13): the routes, the job's unit and the resolver. B never sees A's claim, token or state.
- Resolution and URLs: a live custom name resolves and a verified one does not; `tenantUrl` per host; `primaryUrl` for
  mail and identity-provider URLs; an OIDC sign-in started on the slug name lands on the primary.
- The proxy endpoint: `401` without the token, the payload's shape, nothing on the public listener.
- The certificate probe, against a local TLS server with a test CA.
- The recipe: the parse test of §21.5 extended to the HTTP provider and `le-http`. Where Docker is present, a test
  runs Traefik, Pebble and Pebble's challenge DNS server. A claim's router appears, Pebble issues by HTTP-01, and the
  probe sees the certificate. No real DNS or ACME anywhere.
- The Settings tab: renderer unit tests for each state. An e2e test of the tab against the Docker server rig.
