# Wirebench Server: `identity` — design

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24 · Module: `identity` of
`docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md`
- Builds on: `docs/specs/2026-09-24-wirebench-server-host-design.md` (the `ServerModule` contract, config,
  migrations, problems, logging), `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` §5.4
  (sign-in in the system browser, token in `safeStorage`), the desktop's OAuth2 loopback flow
  (`apps/desktop/src/main/oauth2.ts`) and the engine's PKCE helpers (`packages/engine/src/rest/oauth2.ts`),
  ADR-0004 (the token is a secret and lives in the secret store).
- Decisions taken with the owner on 2026-09-24: invitations are **copyable one-time links, no SMTP**;
  accounts are **invite-only, an OIDC login is linked by the IdP's verified email**; OIDC is done with
  **`openid-client`**; the first account comes from **`wirebench-server admin invite <email>`**.

## Assumptions I'm making

1. **The server is the OIDC relying party, not the desktop.** One client registration at the IdP, with
   the server's public URL as redirect URI; the IdP client secret stays on the server. The desktop
   never sees an ID token. It receives a Wirebench device token at the end, the same token a local
   sign-in yields, so every later module sees one kind of caller.
2. **A device token is opaque and server-side.** `wbs_` plus 32 random bytes in base64url, stored
   hashed, revocable per device, listed in the account UI. No JWTs: nothing needs to be verified
   offline, and revocation must be immediate.
3. **Passwords are hashed with `node:crypto` scrypt.** No dependency; parameters below. Argon2 would
   need a native module.
4. **The desktop keeps one token per server.** A user may be signed in to several servers at once; each
   token is a secret-store entry labelled by the server URL.
5. **`email_verified` is required for linking.** An IdP that does not assert it cannot link a login to an
   invitation; the error names the claim.
6. **Server admin is a per-user flag, distinct from team roles.** Who may invite users and manage teams
   is decided here; what a member may do in a workspace is `teams-access`.
7. **The desktop's HTTP calls to the server honour the CA bundle and proxy preferences.** They are
   global preferences already; only a project-free accessor is missing, and this module adds it.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Accounts on Wirebench Server and sign-in from the desktop app. Server side: users, local
credentials, OIDC identities, invitations, device tokens, and the `requireUser` guard every later route
uses. Desktop side: a Sign in dialog reachable from the command palette and the status bar, the OIDC
hand-off through the system browser, the token in the secret store, an Accounts section in
Preferences, and Sign out. The app remains fully usable without an account.

**Why.** Roles need a caller with an identity, and people without git hosting need a way in that is
not git. Both identity modes on day one: local accounts because the owner's team includes people
outside any IdP, OIDC because the rest of them already have one.

**Who.** A server admin inviting a colleague; a colleague accepting the invitation and signing in from
the app; the two modules after this one, which trust `request.caller`.

**User stories.**

- As a server admin, I run one command on a fresh server and get a link that makes me the first admin.
- As a server admin, I invite a QA colleague by email and paste the link into chat; the link works once
  and expires in seven days.
- As a colleague with an invitation, I open the link, and it tells me to install Wirebench and sign in
  to `https://wirebench.example.com` with my email, or with the company IdP; I choose a password in the
  app, or I click *Continue with Company IdP* and finish in the browser.
- As a user, I see who I am signed in as in the status bar and can sign out from there.
- As a user on a second machine, I sign in again; my first machine stays signed in until I revoke it.
- As a user without an account, nothing in the app asks me to sign in.

**Non-goals (this module).** Teams and roles; workspaces on the server; SAML, SCIM, audit log; MFA;
password-strength scoring beyond a minimum length; email delivery; self-service sign-up; account
deletion by the user (an admin disables); a web UI (the invitation page is the only page the server
serves, and it is static text).

## 2. Concept model

- **User.** `id` (ULID), `email` (unique, case-insensitive), `displayName`, `serverAdmin`, `disabledAt`.
  A user has at most one local credential and any number of OIDC identities (one per issuer).
- **Invitation.** Created by a server admin for an email; carries a one-time secret; accepted by
  creating a local credential in the app, or consumed by an OIDC login whose verified email matches.
  Consumed or expired invitations stay as rows for the admin list.
- **Device token.** A session bound to one desktop installation ("MacBook of Alice"), created by a
  sign-in, revoked by sign-out, by the user from another device, or by an admin disabling the user.
- **Flow.** A pending OIDC sign-in started by the desktop: server-side row with the desktop's PKCE
  challenge and loopback port, the IdP `state` and `nonce`, ten-minute expiry.

## 3. Behaviour

### 3.1 Server endpoints (all under `/api/v1`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/local/sign-in` | none | `{ email, password, device: { name } }` → `201 { token, user }`. Wrong email or password → `401 identity-invalid-credentials` (same message either way); disabled → `403 identity-user-disabled`; local auth off → `404 identity-method-disabled`. Rate-limited (§3.6). |
| `POST /auth/oidc/start` | none | `{ device: { name }, codeChallenge, loopbackPort }` → `201 { flowId, authorizationUrl, expiresAt }`. OIDC off → `404 identity-method-disabled`. |
| `GET /auth/oidc/callback` | none (browser) | The IdP redirect. Validates `state`, exchanges the code with the IdP through `openid-client`, checks `nonce`, `email_verified`, links or refuses (§3.3), mints a one-time `grant` for the flow, then redirects the browser to `http://127.0.0.1:<loopbackPort>/callback?flow=<flowId>&grant=<grant>`. On refusal, redirects to the loopback with `error=<code>` so the app can show it, and renders nothing itself beyond a "return to Wirebench" line. |
| `POST /auth/oidc/complete` | none | `{ flowId, grant, codeVerifier }` → `201 { token, user }`. The verifier must hash to the flow's challenge; the grant is single-use; the flow must be unexpired. Otherwise `400 identity-flow-invalid`. |
| `POST /auth/sign-out` | user | Revokes the calling token. `204`. |
| `GET /me` | user | `{ user: { id, email, displayName, serverAdmin }, methods: { local: boolean, oidc: { issuer }[] } }`. |
| `POST /me/password` | user | `{ currentPassword?, newPassword }`; `currentPassword` required when a local credential exists. Revokes every *other* device token of the user. |
| `GET /me/devices` | user | `[{ id, name, createdAt, lastUsedAt, current }]`. |
| `DELETE /me/devices/:id` | user | Revokes one of the caller's tokens. `204`. |
| `POST /invitations` | server admin | `{ email, serverAdmin?: boolean }` → `201 { id, email, url, expiresAt }`. `url` is `<publicUrl>/invite/<secret>`; the secret is returned exactly once. An existing user with that email → `409 identity-user-exists`; an open invitation → `409 identity-invitation-exists` (the admin revokes it first). |
| `GET /invitations` | server admin | `[{ id, email, serverAdmin, createdBy, createdAt, expiresAt, acceptedAt? }]`. |
| `DELETE /invitations/:id` | server admin | Revokes an open invitation. `204`. |
| `GET /invite/:secret` | none (browser) | A static page: "You have been invited to Wirebench Server at `<publicUrl>` as `<email>`. Install Wirebench, choose *Sign in…*, enter the server URL and this invitation code: `<secret>`." Expired or used → the same page with "This invitation has expired or was already used." No JSON, no scripts, no external assets. |
| `GET /invitations/lookup?secret=` | none | `{ email, methods: { local, oidc } }` for an open invitation, `404 identity-invitation-invalid` otherwise. The app calls it after the user pastes the code. Rate-limited. |
| `POST /invitations/accept` | none | `{ secret, displayName, password, device: { name } }` → `201 { token, user }`: creates the user and local credential, marks the invitation accepted. Local auth off → `404 identity-method-disabled`; the OIDC path never calls this. |
| `GET /users` | server admin | `[{ id, email, displayName, serverAdmin, disabledAt?, methods }]`. |
| `PATCH /users/:id` | server admin | `{ serverAdmin?, disabled? }`. Disabling revokes every token. An admin cannot remove their own admin flag or disable themselves (`400 identity-self-change`). |
| `POST /users/:id/password-reset` | server admin | → `201 { url, expiresAt }`: a one-time link the admin passes on; it is an invitation row with `kind: reset` for the existing user. Accepting it (`POST /invitations/accept` with the secret and a new password) replaces the credential and revokes every token. |

Every `user` endpoint reads `Authorization: Bearer wbs_…`; a missing, unknown, revoked or expired
token → `401 identity-unauthenticated`; a valid token of a disabled user → `403 identity-user-disabled`.
`lastUsedAt` is updated at most once a minute per token.

### 3.2 The guard other modules use

```ts
// exported by the identity module for teams-access and server-sync
export interface Caller { readonly id: string; readonly email: string; readonly serverAdmin: boolean; readonly tokenId: string; }
declare module 'fastify' { interface FastifyRequest { caller?: Caller } }
export const requireUser: preHandlerHookHandler;         // sets request.caller or throws 401/403
export const requireServerAdmin: preHandlerHookHandler;  // requireUser, then 403 identity-forbidden
```

Registered as a Fastify `onRequest` hook that parses the header when present and leaves `caller`
undefined when absent; the two `preHandler`s turn absence into a problem. Nothing else inspects headers.

### 3.3 OIDC linking rules

On a successful IdP callback with claims `{ iss, sub, email, email_verified, name }`:

1. An `oidc_identities` row for `(iss, sub)` exists → that user. If the row's user is disabled →
   `identity-user-disabled`.
2. Otherwise `email_verified !== true` → `identity-email-unverified`.
3. Otherwise a user with that email exists → link: insert the identity row, proceed. This is how a
   local-account user later gains OIDC.
4. Otherwise an open invitation for that email exists → create the user (`displayName` from `name` or
   the email's local part, `serverAdmin` from the invitation), insert the identity row, mark the
   invitation accepted.
5. Otherwise → `identity-not-invited`. The message says whom to ask.

Email comparison is case-insensitive: the column stores the lower-cased address and the original for
display.

### 3.4 Local credentials

- scrypt via `node:crypto`: `N = 2^15, r = 8, p = 1, keylen = 32`, 16-byte salt, stored as
  `scrypt$N$r$p$<salt b64>$<hash b64>` so parameters can change later; a sign-in with an older
  parameter set rehashes on success.
- Minimum password length 12, maximum 256, no other composition rule; `identity-password-too-short`
  names the minimum.
- Passwords travel only in the request body over TLS and exist in memory only during hashing; the
  log's redaction (server-host §3.6) already covers the `password` key.

### 3.5 Device tokens

- Minted as `wbs_` + base64url(32 random bytes); the database stores `sha256(token)` and never the
  token. Returned once.
- Idle expiry 30 days (`lastUsedAt`), absolute expiry 180 days (`createdAt`); both configurable (§4.1).
  An expired token is deleted lazily on its next use and by a daily sweep.
- `device.name` is supplied by the app (`<hostname>` by default, editable in the dialog), trimmed to 80
  characters.

### 3.6 Rate limiting

In-process token buckets, no dependency: per client IP (respecting `trustProxy`) and per email, on
`POST /auth/local/sign-in`, `POST /invitations/accept`, `GET /invitations/lookup` and
`POST /auth/oidc/complete`: 10 attempts per minute, then `429 identity-rate-limited` with `Retry-After`.
The buckets reset on restart (assumption 1 of server-host: one instance).

### 3.7 Command line

`wirebench-server admin invite <email> [--no-admin]` creates an invitation (server admin by default) and
prints the URL and the expiry. It runs the same code as `POST /invitations` with `createdBy = null`
("console"). `wirebench-server admin list-invitations` and `admin revoke-invitation <id>` exist for an
operator who cannot yet sign in.

### 3.8 Desktop: sign-in

- **Entry points.** Command `account.signIn` ("Account: Sign in to a server…"), the status bar's
  account item when no account is signed in ("Sign in"), and Preferences → Accounts → *Add server…*.
  All open `SignInDialog`.
- **Step 1, server.** A URL field. On *Continue*, main calls `GET /api/v1/meta` (through the server
  client, §5.3). Not a Wirebench server, unreachable, or `apiVersion` unknown → inline error. The URL
  is normalised to its origin.
- **Step 2, method.** Built from `meta.auth`: a local form (email, password) when `local` is on, a
  *Continue with <displayName>* button when `oidc` is on, both when both. A *Have an invitation code?*
  link reveals a code field: entering it calls `invitations/lookup`, then shows *Choose a password*
  (display name, password, confirm) and submits `invitations/accept`.
- **Local.** Renderer sends `{ url, email, password, deviceName }` over `account.signInLocal`; main posts
  it, stores the token, drops the password. Errors map to inline messages by code.
- **OIDC.** Main opens a loopback listener (the generalised helper, §5.3), calls
  `POST /auth/oidc/start` with a fresh PKCE challenge and the port, then `shell.openExternal` on the
  `authorizationUrl` (through the existing `isExternalUrlAllowed`). The dialog shows *Waiting for the
  browser…* with *Cancel*. On the loopback callback, main posts `/auth/oidc/complete` with the verifier,
  stores the token, and the loopback page says "Signed in. You can close this tab." Timeout five
  minutes (`FLOW_TIMEOUT_MS`), one pending flow at a time, exactly as the OAuth2 flow behaves today.
- **After sign-in.** The dialog closes; the status bar item shows the email; `account.changed` fires.
- **Sign out.** Status bar item → *Sign out of <server>*; Preferences → Accounts → *Sign out*. Main
  posts `/auth/sign-out` (best effort; a failed request still removes the token locally) and deletes
  the secret-store entry.
- **Token invalid later.** Any server call that returns `identity-unauthenticated` marks the account
  `signedOut: true` and shows a toast with *Sign in again*; nothing loops.
- **No account.** No badge, no prompt, no network call. The status bar item is hidden until a server is
  known; Preferences → Accounts → *Show sign-in in the status bar* controls it afterwards (default on).

### 3.9 Desktop: Accounts preferences section

Lists known servers: URL, email, display name, signed-in state, *Sign out*, *Remove* (also revokes
the token when signed in), *Add server…*. The list itself is not a preference (§4.3).

## 4. Data model and storage

### 4.1 Configuration (adds to server-host §4.1)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WIREBENCH_SERVER_LOCAL_AUTH` | no | `true` | Offer local accounts. |
| `WIREBENCH_SERVER_OIDC_ISSUER` | no | — | Issuer URL; presence turns OIDC on. Discovery at start-up; failure exits 2. |
| `WIREBENCH_SERVER_OIDC_CLIENT_ID` | with issuer | — | |
| `WIREBENCH_SERVER_OIDC_CLIENT_SECRET` | with issuer | — | Never logged. |
| `WIREBENCH_SERVER_OIDC_SCOPES` | no | `openid email profile` | |
| `WIREBENCH_SERVER_OIDC_DISPLAY_NAME` | no | `OIDC` | The button label in the app. |
| `WIREBENCH_SERVER_TOKEN_IDLE_DAYS` | no | `30` | |
| `WIREBENCH_SERVER_TOKEN_MAX_DAYS` | no | `180` | |
| `WIREBENCH_SERVER_INVITATION_DAYS` | no | `7` | |

Both auth modes off → exit 2 (`identity-no-method`). The IdP redirect URI is
`<publicUrl>/api/v1/auth/oidc/callback`, printed by `config check` so the operator can register it.

### 4.2 Database (`packages/server/src/identity/migrations/0002_identity.sql`)

```
users             (id text pk, email text not null, email_lower text not null unique, display_name text not null,
                   server_admin boolean not null default false, created_at timestamptz not null default now(),
                   disabled_at timestamptz)
local_credentials (user_id text pk references users on delete cascade, password_hash text not null,
                   updated_at timestamptz not null default now())
oidc_identities   (issuer text not null, subject text not null, user_id text not null references users on delete cascade,
                   linked_at timestamptz not null default now(), primary key (issuer, subject))
invitations       (id text pk, kind text not null check (kind in ('invite','reset')), email_lower text not null,
                   user_id text references users on delete cascade, secret_hash text not null unique,
                   server_admin boolean not null default false, created_by text references users on delete set null,
                   created_at timestamptz not null default now(), expires_at timestamptz not null,
                   accepted_at timestamptz, revoked_at timestamptz)
device_tokens     (id text pk, user_id text not null references users on delete cascade, token_hash text not null unique,
                   device_name text not null, created_at timestamptz not null default now(),
                   last_used_at timestamptz not null default now(), revoked_at timestamptz)
oidc_flows        (id text pk, code_challenge text not null, loopback_port int not null, device_name text not null,
                   state text not null unique, nonce text not null, grant_hash text unique,
                   created_at timestamptz not null default now(), expires_at timestamptz not null, user_id text)
```

A partial unique index on `invitations (email_lower) where kind = 'invite' and accepted_at is null and
revoked_at is null` enforces one open invitation per email.

### 4.3 Desktop storage

- `userData/accounts.yaml`: `{ version: 1, servers: [{ url, userId, email, displayName, deviceName,
  tokenRef, signedOut?: true, addedAt }] }`, written atomically by `AccountService`; validated by a
  zod schema in `packages/engine/src/account/schema.ts` so the CLI can read it later.
- The token is a `SecretStore` entry labelled `wirebench-server:<url>`; `tokenRef` is its `sec_…` ref.
  The renderer never receives the token (there is no `secrets.get` channel, and none is added).
- Preferences gain `accounts: { showInStatusBar: boolean }` only.

## 5. Architecture

### 5.1 Server module

`packages/server/src/identity/` — `module.ts` (the `ServerModule`: migrations dir, routes, the
`onRequest` hook, meta contribution `{ auth: { local, oidc }, oidcDisplayName }`), `passwords.ts`,
`tokens.ts`, `invitations.ts`, `oidc.ts` (an `OidcProvider` interface with the `openid-client`
implementation), `rate-limit.ts`, `routes/{auth-local,auth-oidc,me,invitations,users,invite-page}.ts`,
`repo.ts` (SQL), `cli.ts` (the `admin` sub-commands).

### 5.2 Wire schemas shared with the desktop

`packages/engine/src/server-api/identity.ts` holds the zod schemas for every request and response
above (`signInResponseSchema`, `meResponseSchema`, `invitationLookupSchema`, …). The server's routes
and the desktop's client import the same objects, so a drift fails typecheck.

### 5.3 Desktop main

- `main/loopback-callback.ts`: the listener, state check, timeout and callback page extracted from
  `oauth2.ts` (`OAuth2Service` keeps its behaviour and calls the helper).
- `main/server-client.ts`: `ServerClient` with `meta(url)`, `signInLocal`, `startOidc`, `completeOidc`,
  `signOut`, `me`, `acceptInvitation`, `lookupInvitation`; each call goes through the engine's
  `sendHttp` with `tls.ca` from `ssl.caBundlePath` and `proxy` from the proxy preferences, via a new
  `main/network-options.ts` (`mainHttpOptions(url)`) that lifts the two resolvers out of
  `ProjectHost` so they no longer require an open project. Bearer header set by the client from the
  secret store; `identity-unauthenticated` is mapped to the account's `signedOut` flag.
- `main/account-service.ts`: `AccountService` owns `accounts.yaml`, the sign-in state machine, and
  emits `account.changed`.
- IPC (`shared/ipc.ts`): `account.list`, `account.probe { url }`, `account.signInLocal`,
  `account.startOidc`, `account.cancelSignIn`, `account.acceptInvitation`,
  `account.lookupInvitation`, `account.signOut { url }`, `account.remove { url }`; event
  `account.changed { servers }`. Wire types in `shared/wire-types.ts` reuse the engine schemas of §5.2
  minus the token.

### 5.4 Desktop renderer

`renderer/features/account/{sign-in-dialog,account-status-item}.tsx`, `state/account.ts` (zustand
store fed by `account.changed`), `preferences/sections/accounts-section.tsx`, commands
`account.signIn`, `account.signOut` in `command-catalog.ts` under a new `Account` category.

## 6. Security

- Tokens: hashed at rest, never logged, never in the renderer, revocable, idle and absolute expiry.
- Sign-in responses do not distinguish unknown email from wrong password; rate-limited per IP and
  email; the disabled case is distinguishable only after a correct password.
- The OIDC flow binds the desktop with PKCE, binds the IdP round trip with `state` and `nonce`, checks
  `email_verified`, and hands the desktop a single-use grant over the loopback.
- The loopback listener binds `127.0.0.1`, accepts one callback, checks its parameters, and times out:
  the existing behaviour, now shared.
- `openid-client` performs discovery over TLS and validates ID-token signatures against the issuer's
  JWKS; the server pins the issuer from config and refuses a mismatching `iss`.
- Invitation secrets: 32 random bytes, stored hashed, single-use, expiring; the invitation page is
  static and reveals only the email the admin typed.
- Admin self-lockout is refused (§3.1).
- Passwords: scrypt with a per-user salt; the minimum length is the only rule; changing the password
  revokes other devices.

## 7. Tech stack

Adds `openid-client` (the current major, ESM) to `packages/server`. `node:crypto` for scrypt, hashing
and random bytes. Nothing new on the desktop.

## 8. Commands

As server-host §8, plus:

```
node packages/server/dist/bin.js admin invite alice@example.com
node packages/server/dist/bin.js admin list-invitations
node packages/server/dist/bin.js admin revoke-invitation <id>
```

Desktop commands: `account.signIn`, `account.signOut` (palette, no default shortcut).

## 9. Project structure (new or changed)

```
packages/server/src/identity/**                       # §5.1, including migrations/0002_identity.sql
packages/server/test/unit/identity/**                 # passwords, tokens, invitations, rate-limit, linking rules (fake provider)
packages/server/test/integration/identity/**          # routes against PostgreSQL; oidc against the in-test issuer
packages/server/test/helpers/fake-oidc-issuer.ts      # discovery + JWKS + authorize + token, signs with an in-memory RSA key
packages/engine/src/server-api/identity.ts            # shared zod schemas
packages/engine/src/account/schema.ts                 # accounts.yaml schema
apps/desktop/src/main/{loopback-callback,server-client,network-options,account-service}.ts
apps/desktop/src/main/oauth2.ts                       # uses loopback-callback
apps/desktop/src/main/ipc/account.ts
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/features/account/{sign-in-dialog,account-status-item}.tsx
apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx
apps/desktop/src/renderer/state/account.ts
apps/desktop/src/renderer/shell/status-bar.tsx        # account item
apps/desktop/test/{main,renderer}/account/**
e2e/helpers/fake-server.ts  e2e/specs/account.spec.ts
docs/collaborate.md                                   # "Sign in to a server" section
```

## 10. Code style

As server-host §10. Error codes are `identity-*`. A route reads `request.caller`, never the header:

```ts
app.get('/me/devices', { preHandler: requireUser, schema: { response: { 200: devicesResponseSchema } } },
  async (request) => {
    const caller = request.caller!;
    const rows = await repo.devicesOf(ctx.db, caller.id);
    return rows.map((row) => ({ ...row, current: row.id === caller.tokenId }));
  });
```

Desktop: the renderer sends a password exactly once, over one IPC call, and never keeps it in a store;
components hold it in local `useState` and clear it on close, as `join-dialog.tsx` does with its
fields.

## 11. Testing strategy

- **Server unit:** scrypt format round-trip and parameter upgrade; token mint/hash/parse; invitation
  expiry and single use; rate limiter windows; the linking rules of §3.3 as a table over a fake
  `OidcProvider`; self-lockout refusal; `admin invite` output.
- **Server integration (PostgreSQL):** every route in §3.1 with the status and code it specifies;
  `requireUser` and `requireServerAdmin` on a probe route; the whole OIDC flow against
  `fake-oidc-issuer.ts` running in-process (`openid-client` really discovers, exchanges and verifies),
  including a wrong `state`, an unverified email, an uninvited email, and a reused grant; token idle
  and absolute expiry with an injected clock; disabling a user revokes tokens.
- **Engine unit:** the shared schemas parse the documented examples; `accounts.yaml` schema.
- **Desktop unit:** `loopback-callback` (the tests that today cover `authorize()` move with it, plus
  the OAuth2 tests still pass); `ServerClient` against a stub `send`, including CA and proxy options
  being passed; `AccountService` state machine (sign in, invalid token → `signedOut`, sign out with a
  failed server call, remove); renderer: `SignInDialog` steps and error mapping, the status bar item,
  the Accounts section, commands registered.
- **e2e:** `fake-server.ts` (node `http`, implements meta, local sign-in, invitation lookup and accept,
  me, sign-out): sign in with a password, badge shows the email, restart keeps the session, sign out
  clears it; accept an invitation code; a server that is not Wirebench shows the inline error. OIDC is
  not run in e2e (browser hand-off); its coverage is the server integration flow plus the desktop unit
  tests of the loopback helper.
- **Checks:** `docs:server-config --check` picks up the new variables; `check:banned-terms`.

## 12. Boundaries

Extends server-host §12.

- **Always:** hash tokens and invitation secrets before storing; compare hashes in constant time; read
  identity only through `request.caller`; keep the token out of the renderer; rate-limit every
  unauthenticated endpoint that takes a secret; require `email_verified` for linking.
- **Ask first:** any auth method beyond local and OIDC; MFA; SMTP delivery; a longer token lifetime
  than 180 days; an open-registration mode; any JWT; changing the scrypt parameters.
- **Never:** store or log a password or token; return a token more than once; let an admin lock
  themselves out; open the browser to a URL the server did not return from `/auth/oidc/start`; create
  a user from an OIDC login without an invitation or an existing account; prompt to sign in when no
  server is known.

## 13. Success criteria (done when all are true)

1. `wirebench-server admin invite` on a fresh server prints a link; accepting it from the app's Sign in
   dialog with a password yields a signed-in server admin, and `GET /me` says so.
2. An admin invites a second email through the API; the invitation page renders the instructions; the
   code works once and refuses a second use and an expired one.
3. With `WIREBENCH_SERVER_OIDC_ISSUER` set to the fake issuer, the integration test signs in through
   `start → callback → complete`, links by verified email, refuses an unverified email and an
   uninvited one, and refuses a reused grant.
4. A desktop OIDC sign-in against a real IdP (manual check by the owner against their IdP) ends with
   the badge showing the email and a token in `secrets.json` under the `wirebench-server:` label.
5. Sign out revokes the token server-side and clears it locally; a revoked token used again yields
   `identity-unauthenticated`, and the app shows *Sign in again* once.
6. Ten failed sign-ins within a minute from one address yield `429` with `Retry-After`.
7. The app with no known server shows no account UI and makes no network call on launch.
8. The OAuth2 request flow still passes its tests after the loopback extraction.
9. `WIREBENCH_SKIP_PERF=1 pnpm check` is green; the e2e account spec passes on all three OSes.

## 14. Migration and compatibility

Nothing existing changes shape. `secrets.json` gains entries under a new label prefix.
`preferences.yaml` gains an optional `accounts` section with a default. The engine gains two modules.

## 15. Risks

- **IdP variance.** Some IdPs omit `email_verified` or `email` without the `email` scope. Mitigation:
  scopes are configurable; the refusal names the claim; the fake issuer tests both omissions.
- **Loopback blocked.** A locked-down machine may forbid listening on a port. Mitigation: the same
  limitation already applies to the OAuth2 request flow; the error is the same one.
- **`openid-client` major changes.** Its API changed across majors. Mitigation: it is wrapped behind
  `OidcProvider`; only `oidc.ts` imports it.
- **Rate-limit state per instance.** Acceptable under the one-instance assumption; noted in ADR-0009.

## 16. Open questions (bold = proposed default)

1. Token lifetimes: **idle 30 days, absolute 180 days**.
2. Minimum password length: **12**.
3. Invitation validity: **7 days**.
4. A server admin invited and first signing in via OIDC: **the invitation's `serverAdmin` flag applies**.
5. Status bar item before any server is known: **hidden**.
