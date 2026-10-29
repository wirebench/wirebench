# Wirebench Hosted Edition: the browser client, the local agent and a multi-tenant server — design

Date: 2026-10-24 · Status: **architecture only** — approved scope is the design, not a build plan (owner,
2026-10-24, popup); the 2026-10-15 ruling stands that the hosted edition starts after ten self-hosted paying
customers · Amended 2026-10-26 after an independent review: its four high findings are folded into §4.2
(row-level security must be forced), §3.8 and §3.10 (the agent serves a browser a declared subset), §5.4
guard 6 (background jobs have a tenant scope) and §5.1 (the host package is a factory with no module-level
state); the rest are folded in where they apply · Amended 2026-10-27 for slice 2 (§17, decision 12,
ADR-0034) · Amended 2026-10-29 for slice 3 (§18, ADR-0035) · Issue: #776 (slice 1 is #777, slice 2 is #783, slice 3 is #790) · Module ids: `host-seam`,
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
  page shows a six-character code that lives ten minutes and dies on the fifth wrong attempt (my call).
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
`(tenantId, userId)`** in PostgreSQL (an advisory lock held by a heartbeat row) before it touches
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
| 3 | `local-agent` | **Scheduled 2026-10-29** (#790; §18 records what changed from this row). `packages/agent` as a library, the loopback socket transport, pairing with the browser subset, the send-route rule and the send bundle, `wirebench agent`, the agent's packaging | 1, 2 | yes |
| 4 | `tenancy` | `tenants`, `tenant_id` on every table, forced row-level security, tenant resolution by `Host`, per-tenant directories and data keys with the one-time re-wrap, the six guards of §5.4 including the job scope, the host-instance lease, the self-hosted migration | 2 | yes, invisibly (one tenant) |
| 5 | `operations` | `LISTEN`/`NOTIFY` hub fan-out, advisory locks, sticky host sockets, per-tenant budgets, metrics by tenant id | 4 | partly (multi-instance self-hosted) |
| 6 | `domains` | The two registrable names, wildcard certificates, `app.` entry with emailed links, reserved slugs, public suffix submission | 4 | no |
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
6. A tenant's export verifies its audit chain and restores into a self-hosted server through
   `admin tenant import`.

## 14. Migration and compatibility

- The tenancy migration is one transaction for rows and one directory move for repositories, with the
  single tenant's id written to `server_identity` first so a crash between the two is resumable.
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
  the sign-out action (17.2).
- The server serves the build from `dist/browser/` with `@fastify/static`, hashed assets cached as
  immutable, and the CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
  blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors
  'none'` (`blob:` for image previews) as a header. The page's meta tag carries the same policy less
  `frame-ancestors`, which only a header can. The container image builds it in its build stage.

### 17.7 Testing

- Unit and integration tests per task, two-host-instances-in-one-process tests on the server, and the
  egress rule as a table test over every range above.
- One Playwright suite (`e2e/browser/`) against the server image in Docker with PostgreSQL, run in CI:
  sign in with a local password, open a server workspace, send a request to an echo service on the compose network (a private address, open by default), see
  a request to `127.0.0.1` refused by the egress rule, and see
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
  - `agent.hello`: capabilities, the agent's version and `sshOptIn`.
  - `agent.send`: one send bundle in, the kind's ordinary send result out, with `sentFrom: 'agent'`.
  - `agent.cancel`.
  - `agent.cookies.clear`: clears the jars the agent holds for this pairing's origin.
- `ssh` is recorded as an opt-in at pairing, and nothing is served for it yet. The browser's SSH area needs the hosts
  and snippets files the agent does not hold, so it stays off in slice 3. SSH in the browser is a follow-up.
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
    cannot be tied to a user or a code (it matches no row), so guessing is bounded by two limits: five
    attempts per address in ten minutes, and 50 failed attempts server-wide in ten minutes, after which
    pairing answers `429` for everyone until the window refills.
  - `GET /api/v1/agent/pairings` (cookie): the user's pairings, with port and last seen.
  - `POST /api/v1/agent/nonces` (cookie, Origin-checked): `{ pairingId }` → a single-use nonce that lives 60 seconds.
  - `POST /api/v1/agent/nonces/redeem` (rate-limited per address): signed by the agent's key over
    `nonce‖pairingId‖timestamp`. It answers `{ userId, email, displayName }` and consumes the nonce. A replayed
    or expired nonce, a bad signature or an unknown pairing answers `401`.
  - `DELETE /api/v1/agent/pairings/:id` (cookie or agent signature): unpairs, from either side.
  - `PATCH /api/v1/agent/pairings/:id` (agent signature): the agent's new port, when it moved.
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

- **Address.** `ws://127.0.0.1:<port>/host`, never another interface. The port is `47615` by default, and the next
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
- **CSP.** The browser build's CSP gains `connect-src ws://127.0.0.1:*`.

### 18.4 The send route rule and the send bundle (amends §3.4)

- **The rule** runs on the server host, which has the project: `request.route { projectId, itemId, environment? }` →
  `{ route: 'server' } | { route: 'agent', needs: Capability[] }`. These need the agent:
  - A target whose host the egress classifier resolves to loopback, link-local or a private range, even when the
    server could reach a private range. In the browser, §3.4 rule 1 wins over decision 12: the person's `localhost`
    is never the server's.
  - A `${#System#…}` reference, a secret source, a team secret, a keystore on a machine path, Kerberos, NTLM with a
    machine credential, or a cookie jar the agent holds for the target's domain.

  A pin to `agent` in the browser state, on the workspace or on the request, also forces the agent.
- **The renderer** asks `request.route` before a send when the window has an agent transport or lacks
  `send:private`:
  - `route: 'server'`: the send goes as today.
  - `route: 'agent'` with an agent connected: `request.bundle` on the server host, then `agent.send` on the agent,
    then `exchanges.recordAgentSend` on the server host with the redacted exchange, so History stays one list.
  - `route: 'agent'` with no agent: the send fails with `send-needs-agent` naming the needs, and the error offers
    *Pair this machine*.
- **No split sends.** A send whose needs span both hosts is not split (§3.4 rule 4). It fails with `secret-missing`
  naming the host that lacks the value.
- **The bundle** holds:
  - the request item and every script in its folder chain;
  - the project's and the active environment's non-secret values;
  - the cookie-jar policy;
  - secret references, by name only;
  - the project files the request reads, by relative path (a body file, attachments, a proto set), capped at 32 MiB;
  - for a team secret, the workspace's `team-secrets/` subtree.

  The agent writes the bundle to a fresh directory under its temp dir, loads it with the engine's `loadProject`,
  runs the one send path on that one item, and deletes the directory.
- **`sentFrom`.** `sentFrom: 'server' | 'agent'` is an optional field on History entries and the exchange summaries.
  The desktop leaves it out, and the renderer shows a chip only when it is present. The send button shows *Server* or
  *Agent* for the route the next send takes, and the pin.

### 18.5 Team secrets on the agent

- **Desktop agent.** It resolves a team secret from the values its own approved machine has already imported for
  that workspace, by workspace id and name, exactly as a desktop send does. The bundle's `team-secrets/` subtree is
  then used only to check that the value is current (my call: one trust pipeline, the desktop's). If the agent's
  machine is not approved for that workspace, the send fails with `team-secret-needs-approval`.
- **Headless agent.** It has no team secrets in slice 3 (my call): it has no approved machine key, and no UI to
  request one. A team-secret send routed to a headless agent fails with `team-secret-needs-approval`, which says to
  use the desktop app.

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
- **Commands:**
  - `wirebench agent`: start, print the port, wait.
  - `wirebench agent pair <code> --server <url> [--ssh]`.
  - `wirebench agent unpair [--server <url>]`.
  - `wirebench agent status`.

### 18.7 Testing

- Unit and integration tests per task.
- The agent's allowlist classification test.
- Pairing refused for a wrong origin, a replayed nonce, an expired code, a code after its fifth wrong attempt and an unpaired agent.
- A send that needs the agent fails cleanly without one.
- The browser e2e of §17.7 gains a headless `wirebench agent` beside the browser, in CI on the runner, outside
  Docker. It pairs through the UI, sends to an echo server on the runner's `127.0.0.1`, and sees `sentFrom: 'agent'`
  on that exchange and `sentFrom: 'server'` on the echo-service send. That is §13 criterion 2 in full.
