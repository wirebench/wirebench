# Wirebench Hosted Edition: the browser client, the local agent and a multi-tenant server — design

Date: 2026-10-24 · Status: **architecture only** — approved scope is the design, not a build plan (owner,
2026-10-24, popup); the 2026-10-15 ruling stands that the hosted edition starts after ten self-hosted paying
customers · Amended 2026-10-26 after an independent review: its four high findings are folded into §4.2
(row-level security must be forced), §3.8 and §3.10 (the agent serves a browser a declared subset), §5.4
guard 6 (background jobs have a tenant scope) and §5.1 (the host package is a factory with no module-level
state); the rest are folded in where they apply · Amended 2026-10-27 for slice 2 (§17, decision 12,
ADR-0034) · Amended 2026-10-29 for slice 3 (§18, ADR-0035) · Amended 2026-10-29 for slice 4 (§19, ADR-0036) ·
Issue: #776 (slice 1 is #777, slice 2 is #783, slice 3 is #790, slice 4 is #798) · Module ids: `host-seam`,
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
| 4 | `tenancy` | **Specified 2026-10-29** (#798; §19 records what changed from this row). `tenants`, `tenant_id` on every table, forced row-level security, tenant resolution by `Host`, per-tenant directories and data keys with the one-time re-wrap, the six guards of §5.4 including the job scope, the host-instance lease, the self-hosted migration | 2 | yes, invisibly (one tenant) |
| 5 | `operations` | `LISTEN`/`NOTIFY` hub fan-out, advisory locks, sticky host sockets, per-tenant budgets, metrics by tenant id | 4 | partly (multi-instance self-hosted) |
| 6 | `domains` | The two registrable names, wildcard certificates, `app.` entry with emailed links, reserved slugs, public suffix submission | 4 | no |
| 7 | `control-plane` | Signup, subscriptions, edition from subscription, suspension, export, deletion, operator commands; per-tenant settings (OIDC, SAML, SCIM, audit forwarding, SMTP sender, retention), today's environment variables becoming the default tenant's (§19.1, §19.12) | 4, 5, 6 | no |
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
    in this process** (`update … where holder = $holder returning user_id`), not for every tenant.
  - A lease missing from that answer was lost: its instance closes its sockets `4409` and is disposed.
  - A process that has not renewed for 30 s by its own monotonic clock stops its instances on its own, half a lease
    before anyone else could take them, so two processes never write one checkout (§5.5). Database time sets the
    expiry; local time only decides when to stop early.
- **Giving it back.** Eviction deletes the lease after the host's quit path has run. Shutdown releases every lease
  after `closeAll`.
- **After a crash.** A self-hosted server is one process (ADR-0013), so in self-hosted mode start-up deletes every
  lease it finds, through `forEachTenant`, since the app role outside a tenant sees no row. A crash and restart then
  do not keep users out for a minute (my call). A hosted process leaves leases to expire. A multi-instance
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
  - `admin tenancy revert`.
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
