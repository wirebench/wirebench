# Wirebench Server `identity` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `identity` of issue #74 — accounts on Wirebench Server (local passwords and
OIDC through `openid-client`, copyable one-time invitation links, revocable device tokens, the
`requireUser` / `requireServerAdmin` guard every later route uses, the `admin` command line) and
sign-in from the desktop app (a Sign in dialog, the OIDC hand-off through the system browser over a
loopback helper shared with the OAuth2 request flow, the token in the secret store, a status bar
item, an Accounts preferences section, Sign out). The app stays fully usable without an account.

**Architecture:** Server side, `packages/server/src/identity/` is one `ServerModule` registered
into the `/api/v1` scope: an `onRequest` hook turns `Authorization: Bearer wbs_…` into
`request.caller`, two `preHandler`s turn its absence into a problem, and six route files implement
spec §3.1 over a SQL repository, scrypt passwords, hashed tokens and secrets, in-process token
buckets and an `OidcProvider` that wraps `openid-client`. Every request and response shape is a
zod schema in `packages/engine/src/server-api/`, imported by the server's routes and the desktop's
client alike. Desktop side, main owns `accounts.yaml`, the loopback listener and the token; the
renderer only ever sees `AccountWire` (never a token) through `account.*` channels and one
`account.changed` event.

**Tech Stack:** as server-host (TypeScript strict + `exactOptionalPropertyTypes`, Node 24, Fastify
5.12, `pg` 8.23, zod 4, vitest 5, PostgreSQL 16) plus `openid-client` 6.8 and `ulidx` (already the
engine's) in `packages/server`; `node:crypto` for scrypt, SHA-256 and random bytes. Nothing new on
the desktop or in the engine. Electron `safeStorage` through the existing `SecretStore`.

**Spec:** `docs/specs/2026-09-24-wirebench-server-identity-design.md` — read it first; section
numbers below are its. It builds on `docs/specs/2026-09-24-wirebench-server-host-design.md` (the
`ServerModule` contract, problems, logging) and ADR-0009. Module id and build order:
`docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- Branch `feat/identity`, from `main` (which contains `server-host`, PR #156). Worktree under
  `git-worktrees/identity`. One commit per task, only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
- Commit as Mohammed Naami <m.naami@outlook.com>. **No** `Co-Authored-By:` trailer, **no**
  `Claude-Session:` trailer, no generated-by footer. The body says why.
- Never name, in code, docs or UI copy, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows and no local e2e run; CI runs e2e. Heavy checks under `nice`.
- Runtime dependencies of `packages/server` become exactly `@wirebench/engine`, `fastify`, `pg`,
  `zod`, `openid-client` and `ulidx`. Nothing is added to `apps/desktop` or `packages/engine`.
  `openid-client` is imported by `packages/server/src/identity/oidc.ts` and nowhere else (§15).
- Routes validate with `jsonSchema()` from `packages/server/src/schema.ts` (`io: 'input'` for
  body/querystring/params), never with a type provider (ADR-0009). Handlers read the validated
  `request.body` through the engine schema's inferred type.
- Identity's migration lives at `packages/server/migrations/identity/0002_identity.sql` (not under
  `src/`, as spec §4.2 writes: `tsc` copies no `.sql`, and the package ships `migrations/`).
- Error codes are `identity-*` (§10). Clients see `{ code, message }` only.
- **Always** (§12): hash tokens and invitation secrets before storing (SHA-256); compare a
  password's hash with `timingSafeEqual`; read identity only through `request.caller`; keep the
  token out of the renderer; rate-limit every unauthenticated endpoint that takes a secret; require
  `email_verified` for linking. **Never:** store or log a password or token; return a token more
  than once; let an admin lock themselves out; open the browser to a URL the server did not
  return; create a user from an OIDC login without an invitation or an existing account; prompt to
  sign in when no server is known.
- `password`, `token`, `secret`, `clientSecret` are already redacted from logs at two depths
  (`packages/server/src/server.ts`); log nothing carrying a credential deeper than that. The `req`
  serializer already drops the query string (`?secret=`, `?grant=`).
- Renderer rule (memory `renderer-wire-types-csp`): a renderer module loaded at start-up must not
  import *values* from `apps/desktop/src/shared/wire-types.ts` or from the engine's server-api
  schemas; type-only imports are fine. Zod-free constants go in a zod-free module.
- Integration tests skip, printing why, when `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. Locally:
  `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db` (5432 belongs
  to another project's container, never stop it), then once
  `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`, and
  `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`.
- Engine and server style: `readonly` interfaces, discriminated unions, no `any`, conditional
  spreads, JSDoc that says why. Ids are ULIDs (`ulid()` from `ulidx`); every SQL statement is
  parameterised.

## File Structure

```
packages/engine/src/server-api/meta.ts                 metaResponseSchema (moved from the server), SERVER_NAME, SERVER_API_VERSION
packages/engine/src/server-api/identity.ts             every §3.1 request/response schema; MIN_PASSWORD_LENGTH, SECRET_PATTERN, DEVICE_TOKEN_PATTERN
packages/engine/src/account/schema.ts                  accounts.yaml schema (§4.3), parseAccountsFile
packages/engine/src/project/preferences.ts             + accounts: { showInStatusBar } (Task 14)
packages/engine/src/index.ts                           + server-api, account exports
packages/engine/test/unit/server-api/identity.test.ts, account/schema.test.ts
packages/server/package.json                           + openid-client, ulidx
packages/server/migrations/identity/0002_identity.sql  §4.2 tables and the partial unique index
packages/server/src/config.ts                          + the nine §4.1 variables and their cross-field rules
packages/server/src/modules.ts                         BUILTIN_MODULES = [identityModule()]
packages/server/src/main.ts                            serve/migrate use BUILTIN_MODULES; `config check` prints the redirect URI; `admin` dispatch
packages/server/src/args.ts                            + admin invite | list-invitations | revoke-invitation
packages/server/src/serve.ts                           a module that fails to register → StartupError (exit 2)
packages/server/src/routes/meta.ts                     imports metaResponseSchema from the engine
packages/server/src/context.ts, server.ts               ServerModule.registerPublic (root-level routes: the invitation page)
packages/server/src/identity/module.ts                 identityModule(options): migrationsDir, meta, discovery, hook, routes, sweep
packages/server/src/identity/env.ts                    IdentityEnv: ctx, settings, now, limiter, provider?
packages/server/src/identity/errors.ts                 one function per identity-* problem
packages/server/src/identity/passwords.ts              scrypt: hashPassword, verifyPassword, parseStoredHash, SCRYPT_PARAMS
packages/server/src/identity/tokens.ts                 newId, mintSecret, hashSecret, mintToken, hashToken, bearerToken, pkceChallenge
packages/server/src/identity/rate-limit.ts             RateLimiter (token bucket), rateLimit() preHandler
packages/server/src/identity/repo.ts                   every SQL statement; row types
packages/server/src/identity/guard.ts                  Caller, authenticate(), requireUser, requireServerAdmin
packages/server/src/identity/sessions.ts               issueToken, publicUser
packages/server/src/identity/invitations.ts            createInvitation, lookupInvitation, acceptInvitation (routes and CLI share them)
packages/server/src/identity/oidc.ts                   OidcProvider, OidcClaims, discoverOidc (the only openid-client import)
packages/server/src/identity/linking.ts                decideLink (pure §3.3 table), linkClaims
packages/server/src/identity/invite-page.ts            the static invitation HTML
packages/server/src/identity/routes/{auth-local,auth-oidc,me,invitations,users,invite-page}.ts
packages/server/src/identity/cli.ts                    runAdmin
packages/server/test/helpers/identity.ts               identityHarness, signedInUser
packages/server/test/helpers/net.ts                    freePort (moved out of boot.test.ts)
packages/server/test/helpers/fake-oidc-issuer.ts       discovery + JWKS + authorize + token over node:http, RS256 with node:crypto
packages/server/test/unit/identity/{passwords,tokens,rate-limit,linking,invite-page}.test.ts, test/unit/args.test.ts
packages/server/test/integration/identity/{config,repo,guard,auth-local,me,invitations,users,oidc,cli}.test.ts
packages/server/README.md                              regenerated table; Accounts section
scripts/third-party-licenses.test.ts, THIRD-PARTY-LICENSES.md
apps/desktop/src/main/loopback-callback.ts             startLoopbackCallback, callbackPage, escapeHtml (out of oauth2.ts)
apps/desktop/src/main/oauth2.ts                        authorize() uses the helper; behaviour unchanged
apps/desktop/src/main/network-options.ts               resolveTrustAnchors, resolveProxy, mainHttpOptions (lifted out of ProjectHost)
apps/desktop/src/main/project-host.ts                  trustAnchors/proxyFor delegate to network-options
apps/desktop/src/main/server-client.ts                 ServerClient, normalizeServerUrl
apps/desktop/src/main/account-service.ts               AccountService: accounts.yaml, secret store, sign-in state machine
apps/desktop/src/main/ipc/account.ts                   registerAccountChannels
apps/desktop/src/main/index.ts                         wiring
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/state/account.ts             useAccountStore, subscribeToAccounts
apps/desktop/src/renderer/state/ui.ts                  signInDialog { open, url }, openSignInDialog, setSignInDialogOpen
apps/desktop/src/renderer/state/preferences-defaults.ts + accounts (restated default)
apps/desktop/src/renderer/features/account/{sign-in-dialog,account-status-item}.tsx
apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx, preferences-editor.tsx
apps/desktop/src/renderer/commands/register-account-commands.ts, register-shell-commands.ts
apps/desktop/src/renderer/shell/{status-bar,app-shell}.tsx
apps/desktop/test/{loopback-callback,network-options,server-client,account-service,ipc-account}.test.ts
apps/desktop/test/renderer/{account-store,account-commands}.test.ts, {sign-in-dialog,account-status-item,accounts-section}.test.tsx
apps/desktop/test/renderer/preferences-editor.test.tsx  + 'Accounts' label
apps/desktop/test/mocks/wirebench-api.ts               + account channels
e2e/helpers/fake-server.ts, e2e/specs/account.spec.ts
docs/collaborate.md                                    "Sign in to a server"
docs/security.md                                       "Server accounts"
docs/adr/0010-server-identity-is-device-tokens-and-invitations.md
docs-site/src/content/docs/guides/{shared-workspaces,preferences}.mdx
docs-site/src/content/docs/reference/commands.md       regenerated
```

---

### Task 1: Shared wire schemas in the engine

**Files:**
- Create: `packages/engine/src/server-api/meta.ts`, `packages/engine/src/server-api/identity.ts`,
  `packages/engine/src/account/schema.ts`, `packages/engine/test/unit/server-api/identity.test.ts`,
  `packages/engine/test/unit/account/schema.test.ts`
- Modify: `packages/engine/src/index.ts` (append), `packages/server/src/routes/meta.ts:1-13`

**Interfaces:**
- Produces (all from `@wirebench/engine`): `SERVER_NAME`, `SERVER_API_VERSION`, `metaResponseSchema`,
  `MetaResponse`; `MIN_PASSWORD_LENGTH`, `MAX_PASSWORD_LENGTH`, `SECRET_PATTERN`,
  `DEVICE_TOKEN_PATTERN`, `PKCE_VERIFIER_PATTERN`; the schemas and types listed in Step 3;
  `ACCOUNTS_FILE_VERSION`, `serverAccountSchema`, `accountsFileSchema`, `parseAccountsFile`,
  `ServerAccount`, `AccountsFile`.
- Consumed by: every server route (Tasks 5–7), `ServerClient` (Task 10), `AccountService`
  (Task 11), the desktop wire types (Task 12).

- [ ] **Step 1: Write the failing engine tests**

`packages/engine/test/unit/server-api/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_PATTERN,
  invitationAcceptRequestSchema,
  localSignInRequestSchema,
  meResponseSchema,
  metaResponseSchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  SECRET_PATTERN,
  signInResponseSchema,
} from '../../../src/index.js';

const SECRET = 'A'.repeat(43);
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: true };

describe('server-api identity schemas', () => {
  it('parse the documented examples', () => {
    expect(localSignInRequestSchema.parse({ email: 'a@b.co', password: 'x'.repeat(12), device: { name: 'Mac' } })).toMatchObject({ device: { name: 'Mac' } });
    expect(signInResponseSchema.parse({ token: `wbs_${SECRET}`, user: USER }).user.serverAdmin).toBe(true);
    expect(oidcStartRequestSchema.parse({ device: { name: 'Mac' }, codeChallenge: SECRET, loopbackPort: 49152 }).loopbackPort).toBe(49152);
    expect(oidcCompleteRequestSchema.parse({ flowId: 'f', grant: SECRET, codeVerifier: 'v'.repeat(43) }).grant).toBe(SECRET);
    expect(meResponseSchema.parse({ user: USER, methods: { local: true, oidc: [{ issuer: 'https://idp.test' }] } }).methods.oidc).toHaveLength(1);
    expect(invitationAcceptRequestSchema.parse({ secret: SECRET, displayName: 'Alice', password: 'p'.repeat(12), device: { name: 'Mac' } }).displayName).toBe('Alice');
    expect(metaResponseSchema.parse({ name: 'wirebench-server', version: '1', apiVersion: 1, publicUrl: 'https://x.test', auth: { local: true, oidc: false }, capabilities: [] }).apiVersion).toBe(1);
  });

  it('refuse the shapes the server must never accept', () => {
    expect(signInResponseSchema.safeParse({ token: 'not-a-token', user: USER }).success).toBe(false);
    expect(oidcStartRequestSchema.safeParse({ device: { name: 'Mac' }, codeChallenge: 'short', loopbackPort: 1 }).success).toBe(false);
    expect(oidcStartRequestSchema.safeParse({ device: { name: 'Mac' }, codeChallenge: SECRET, loopbackPort: 70000 }).success).toBe(false);
    expect(localSignInRequestSchema.safeParse({ email: 'a@b.co', password: '', device: { name: 'Mac' } }).success).toBe(false);
    expect(localSignInRequestSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(12), device: { name: 'n'.repeat(81) } }).success).toBe(false);
    expect(SECRET_PATTERN.test('A'.repeat(42))).toBe(false);
    expect(DEVICE_TOKEN_PATTERN.test(`wbs_${SECRET}`)).toBe(true);
  });
});
```

`packages/engine/test/unit/account/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { accountsFileSchema, parseAccountsFile } from '../../../src/index.js';

const SERVER = {
  url: 'https://wirebench.example.com',
  userId: '01J8Z0000000000000000000AB',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'MacBook of Alice',
  tokenRef: 'sec_0123456789abcdef0123456789',
  addedAt: '2026-09-24T12:00:00.000Z',
};

describe('accounts.yaml schema', () => {
  it('parses the documented example, with and without signedOut', () => {
    expect(accountsFileSchema.parse({ version: 1, servers: [SERVER] }).servers[0]?.signedOut).toBeUndefined();
    expect(accountsFileSchema.parse({ version: 1, servers: [{ ...SERVER, signedOut: true }] }).servers[0]?.signedOut).toBe(true);
  });
  it('refuses a token in the file: only a secret-store ref is allowed', () => {
    expect(accountsFileSchema.safeParse({ version: 1, servers: [{ ...SERVER, tokenRef: 'wbs_abc' }] }).success).toBe(false);
  });
  it('parseAccountsFile yields an empty file for anything malformed, never throws', () => {
    expect(parseAccountsFile(undefined)).toEqual({ version: 1, servers: [] });
    expect(parseAccountsFile({ version: 2, servers: [] })).toEqual({ version: 1, servers: [] });
    expect(parseAccountsFile('garbage')).toEqual({ version: 1, servers: [] });
  });
});
```

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/server-api packages/engine/test/unit/account`
Expected: FAIL — the exports do not exist.

- [ ] **Step 2: `server-api/meta.ts`**

```ts
/**
 * What `GET /api/v1/meta` answers (host spec §3.2). Shared with the desktop so the Sign in
 * dialog can tell a Wirebench Server from any other host by shape, not by guesswork.
 */
import { z } from 'zod';

export const SERVER_NAME = 'wirebench-server';
export const SERVER_API_VERSION = 1;

export const metaResponseSchema = z.object({
  name: z.literal(SERVER_NAME),
  version: z.string(),
  apiVersion: z.literal(SERVER_API_VERSION),
  publicUrl: z.string().url(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;
```

- [ ] **Step 3: `server-api/identity.ts`**

```ts
/**
 * The identity module's wire shapes (identity spec §3.1), one object per request and response.
 * The server's routes validate with them (through `z.toJSONSchema`) and the desktop's
 * `ServerClient` parses answers with them, so a drift between the two fails typecheck.
 *
 * Nothing here trims or lower-cases: Fastify validates the JSON Schema rendering, which cannot
 * carry a transform, so normalisation happens in the handler (`emailKey` in the server).
 */
import { z } from 'zod';

/** §3.4: the only composition rule. Checked in the handler so the problem can name the number. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_DEVICE_NAME_LENGTH = 80;
export const MAX_DISPLAY_NAME_LENGTH = 120;
/** 32 random bytes in base64url without padding: invitation secrets, grants, PKCE challenges. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_TOKEN_PATTERN = /^wbs_[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1 verifier alphabet and length. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export const emailSchema = z.string().min(3).max(254).email();
export const passwordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);
export const deviceSchema = z.object({ name: z.string().min(1).max(MAX_DEVICE_NAME_LENGTH) });
export const identityIdSchema = z.string().min(1).max(64);

export const serverUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  serverAdmin: z.boolean(),
});
export type ServerUser = z.infer<typeof serverUserSchema>;

export const signInResponseSchema = z.object({ token: z.string().regex(DEVICE_TOKEN_PATTERN), user: serverUserSchema });
export type SignInResponse = z.infer<typeof signInResponseSchema>;

export const localSignInRequestSchema = z.object({ email: emailSchema, password: passwordSchema, device: deviceSchema });
export type LocalSignInRequest = z.infer<typeof localSignInRequestSchema>;

export const oidcStartRequestSchema = z.object({
  device: deviceSchema,
  codeChallenge: z.string().regex(SECRET_PATTERN),
  loopbackPort: z.number().int().min(1).max(65_535),
});
export type OidcStartRequest = z.infer<typeof oidcStartRequestSchema>;
export const oidcStartResponseSchema = z.object({
  flowId: z.string(),
  authorizationUrl: z.string().url(),
  expiresAt: z.string(),
});
export type OidcStartResponse = z.infer<typeof oidcStartResponseSchema>;
export const oidcCompleteRequestSchema = z.object({
  flowId: identityIdSchema,
  grant: z.string().regex(SECRET_PATTERN),
  codeVerifier: z.string().regex(PKCE_VERIFIER_PATTERN),
});
export type OidcCompleteRequest = z.infer<typeof oidcCompleteRequestSchema>;
/** The IdP's redirect back to the server; `code` and `error` are mutually exclusive in practice. */
export const oidcCallbackQuerySchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});
export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;

export const signInMethodsSchema = z.object({ local: z.boolean(), oidc: z.array(z.object({ issuer: z.string() })) });
export const meResponseSchema = z.object({ user: serverUserSchema, methods: signInMethodsSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const passwordChangeRequestSchema = z.object({
  currentPassword: passwordSchema.optional(),
  newPassword: passwordSchema,
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const deviceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean(),
});
export const devicesResponseSchema = z.array(deviceSummarySchema);
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const invitationCreateRequestSchema = z.object({ email: emailSchema, serverAdmin: z.boolean().optional() });
export type InvitationCreateRequest = z.infer<typeof invitationCreateRequestSchema>;
export const invitationCreatedSchema = z.object({
  id: z.string(),
  email: z.string(),
  url: z.string().url(),
  expiresAt: z.string(),
});
export type InvitationCreated = z.infer<typeof invitationCreatedSchema>;
export const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  serverAdmin: z.boolean(),
  /** `null` for one created from the console (`admin invite`). */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
});
export const invitationsResponseSchema = z.array(invitationSummarySchema);
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
export const invitationLookupQuerySchema = z.object({ secret: z.string().regex(SECRET_PATTERN) });
export const invitationLookupResponseSchema = z.object({
  email: z.string(),
  methods: z.object({ local: z.boolean(), oidc: z.boolean() }),
});
export type InvitationLookupResponse = z.infer<typeof invitationLookupResponseSchema>;
export const invitationAcceptRequestSchema = z.object({
  secret: z.string().regex(SECRET_PATTERN),
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  password: passwordSchema,
  device: deviceSchema,
});
export type InvitationAcceptRequest = z.infer<typeof invitationAcceptRequestSchema>;

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  serverAdmin: z.boolean(),
  disabledAt: z.string().optional(),
  methods: signInMethodsSchema,
});
export const usersResponseSchema = z.array(userSummarySchema);
export type UserSummary = z.infer<typeof userSummarySchema>;
export const userPatchRequestSchema = z.object({ serverAdmin: z.boolean().optional(), disabled: z.boolean().optional() });
export type UserPatchRequest = z.infer<typeof userPatchRequestSchema>;
export const passwordResetCreatedSchema = z.object({ url: z.string().url(), expiresAt: z.string() });
export type PasswordResetCreated = z.infer<typeof passwordResetCreatedSchema>;
export const identityIdParamsSchema = z.object({ id: identityIdSchema });
```

- [ ] **Step 4: `account/schema.ts`**

```ts
/**
 * `userData/accounts.yaml` (identity spec §4.3): the servers this installation knows and who it
 * is signed in as on each. The token itself is never here — `tokenRef` names a secret-store
 * entry — so the file is safe to read by the CLI later and to show in a bug report.
 */
import { z } from 'zod';

export const ACCOUNTS_FILE_VERSION = 1;

export const serverAccountSchema = z.object({
  /** The server's origin, as `GET /api/v1/meta` reports its `publicUrl`. */
  url: z.string().url(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  deviceName: z.string(),
  /** A `SecretStore` ref (`sec_…`), never the token. */
  tokenRef: z.string().regex(/^sec_[0-9a-f]{26}$/),
  /** Set when the server last answered `identity-unauthenticated`; cleared by a new sign-in. */
  signedOut: z.literal(true).optional(),
  addedAt: z.string(),
});
export type ServerAccount = z.infer<typeof serverAccountSchema>;

export const accountsFileSchema = z.object({
  version: z.literal(ACCOUNTS_FILE_VERSION),
  servers: z.array(serverAccountSchema),
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

/** A missing, malformed or newer file yields no accounts rather than a crash at start-up. */
export function parseAccountsFile(document: unknown): AccountsFile {
  const parsed = accountsFileSchema.safeParse(document);
  return parsed.success ? parsed.data : { version: ACCOUNTS_FILE_VERSION, servers: [] };
}
```

- [ ] **Step 5: Export from the engine index and use the moved meta schema in the server**

Append to `packages/engine/src/index.ts`:

```ts
// ---------------------------------------------------------------------------
// Wirebench Server API: wire schemas shared by packages/server and the desktop client
// ---------------------------------------------------------------------------
export { SERVER_API_VERSION, SERVER_NAME, metaResponseSchema } from './server-api/meta.js';
export type { MetaResponse } from './server-api/meta.js';
export {
  DEVICE_TOKEN_PATTERN,
  MAX_DEVICE_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PKCE_VERIFIER_PATTERN,
  SECRET_PATTERN,
  deviceSchema,
  devicesResponseSchema,
  deviceSummarySchema,
  emailSchema,
  identityIdParamsSchema,
  identityIdSchema,
  invitationAcceptRequestSchema,
  invitationCreatedSchema,
  invitationCreateRequestSchema,
  invitationLookupQuerySchema,
  invitationLookupResponseSchema,
  invitationsResponseSchema,
  invitationSummarySchema,
  localSignInRequestSchema,
  meResponseSchema,
  oidcCallbackQuerySchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  oidcStartResponseSchema,
  passwordChangeRequestSchema,
  passwordResetCreatedSchema,
  passwordSchema,
  serverUserSchema,
  signInMethodsSchema,
  signInResponseSchema,
  userPatchRequestSchema,
  usersResponseSchema,
  userSummarySchema,
} from './server-api/identity.js';
export type {
  DeviceSummary,
  InvitationAcceptRequest,
  InvitationCreated,
  InvitationCreateRequest,
  InvitationLookupResponse,
  InvitationSummary,
  LocalSignInRequest,
  MeResponse,
  OidcCallbackQuery,
  OidcCompleteRequest,
  OidcStartRequest,
  OidcStartResponse,
  PasswordChangeRequest,
  PasswordResetCreated,
  ServerUser,
  SignInResponse,
  UserPatchRequest,
  UserSummary,
} from './server-api/identity.js';
export { ACCOUNTS_FILE_VERSION, accountsFileSchema, parseAccountsFile, serverAccountSchema } from './account/schema.js';
export type { AccountsFile, ServerAccount } from './account/schema.js';
```

`packages/server/src/routes/meta.ts` becomes:

```ts
import { metaResponseSchema, SERVER_API_VERSION, SERVER_NAME } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { jsonSchema } from '../schema.js';

export const metaRoutes =
  (ctx: ServerContext) =>
  (app: FastifyInstance): void => {
    app.get('/meta', { schema: { response: { 200: jsonSchema(metaResponseSchema) } } }, () => ({
      name: SERVER_NAME,
      version: ctx.config.version,
      apiVersion: SERVER_API_VERSION,
      publicUrl: ctx.config.publicUrl,
      auth: ctx.meta.signInMethods(),
      capabilities: ctx.meta.capabilities(),
    }));
  };
```

Run: `pnpm --filter @wirebench/engine build && nice pnpm vitest run --project engine-unit packages/engine/test/unit/server-api packages/engine/test/unit/account && nice pnpm vitest run --project server-unit packages/server/test/unit/server.test.ts`
Expected: engine 5 passed; the server's meta test still passes.

- [ ] **Step 6: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/engine/src/server-api packages/engine/src/account packages/engine/src/index.ts packages/engine/test/unit/server-api packages/engine/test/unit/account packages/server/src/routes/meta.ts
git commit -m "feat(engine): wire schemas for the server's meta and identity endpoints

The server's routes and the desktop's client will import the same zod
objects, so the two sides cannot drift; accounts.yaml gets a schema of
its own because the CLI will read it later."
```

---

### Task 2: Identity configuration, migration and the module skeleton

**Files:**
- Create: `packages/server/migrations/identity/0002_identity.sql`, `packages/server/src/identity/module.ts`,
  `packages/server/src/identity/env.ts`, `packages/server/src/identity/oidc.ts` (interface only),
  `packages/server/src/identity/rate-limit.ts` (Task 3's file; created here because `env.ts` names it),
  `packages/server/src/modules.ts`, `packages/server/test/helpers/net.ts`,
  `packages/server/test/integration/identity/config.test.ts`
- Modify: `packages/server/package.json`, `packages/server/src/config.ts`, `packages/server/src/main.ts`,
  `packages/server/src/serve.ts:214-220`, `packages/server/test/unit/config.test.ts`,
  `packages/server/test/integration/boot.test.ts:14-25`, `packages/server/README.md` (regenerated
  table), `scripts/third-party-licenses.test.ts:143-148`, `THIRD-PARTY-LICENSES.md` (regenerated)

**Interfaces:**
- Produces: `ServerConfig` gains `localAuth: boolean`, `oidcIssuer?: string`, `oidcClientId?: string`,
  `oidcClientSecret?: string`, `oidcScopes: readonly string[]`, `oidcDisplayName: string`,
  `tokenIdleDays`, `tokenMaxDays`, `invitationDays` (numbers). `identityModule(options?: IdentityOptions): ServerModule`,
  `IDENTITY_MIGRATIONS_DIR`, `IdentityOptions { now?, provider?, sweepIntervalMs? }`, `IdentityEnv`,
  `IdentitySettings`, `identitySettings(config)`, `BUILTIN_MODULES`, `OidcProvider`, `OidcClaims`,
  `freePort()`.
- Consumes: `ServerModule`, `MetaRegistry.setSignInMethods` (server-host).

- [ ] **Step 1: Add the dependencies and attribute them**

```bash
pnpm --filter @wirebench/server add openid-client@^6.8.8 ulidx@^2.4.1
pnpm licenses:third-party
```

In `scripts/third-party-licenses.test.ts` the server test's list becomes
`for (const name of ['fastify', 'pg', 'openid-client', 'jose', 'oauth4webapi'])`.

Run: `grep -c "| UNKNOWN |" THIRD-PARTY-LICENSES.md` → `0`.

- [ ] **Step 2: Write the failing config tests**

Append to `packages/server/test/unit/config.test.ts` (add `CONFIG_VARIABLES` and `ConfigError` to its
import from `../../src/config.js` if missing):

```ts
describe('identity configuration (§4.1)', () => {
  const base = { WIREBENCH_SERVER_DATABASE_URL: 'postgres://x', WIREBENCH_SERVER_PUBLIC_URL: 'https://w.test' };
  const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
    try {
      loadConfig(env, '1');
      return [];
    } catch (error) {
      return (error as ConfigError).problems.map((p) => `${p.variable}: ${p.message}`);
    }
  };

  it('defaults to local auth on, OIDC off, 30/180-day tokens, 7-day invitations, the documented scopes', () => {
    const config = loadConfig(base, '1');
    expect(config).toMatchObject({ localAuth: true, tokenIdleDays: 30, tokenMaxDays: 180, invitationDays: 7, oidcDisplayName: 'OIDC' });
    expect(config.oidcIssuer).toBeUndefined();
    expect(config.oidcScopes).toEqual(['openid', 'email', 'profile']);
  });

  it('requires the client id and secret once an issuer is set, naming both at once', () => {
    const problems = problemsOf({ ...base, WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test' });
    expect(problems).toEqual([
      'WIREBENCH_SERVER_OIDC_CLIENT_ID: is required when WIREBENCH_SERVER_OIDC_ISSUER is set',
      'WIREBENCH_SERVER_OIDC_CLIENT_SECRET: is required when WIREBENCH_SERVER_OIDC_ISSUER is set',
    ]);
  });

  it('refuses both methods off with identity-no-method', () => {
    expect(problemsOf({ ...base, WIREBENCH_SERVER_LOCAL_AUTH: 'false' })[0]).toContain('identity-no-method');
  });

  it('accepts an http issuer only with the insecure flag, and splits the scopes on whitespace', () => {
    const oidc = { WIREBENCH_SERVER_OIDC_ISSUER: 'http://127.0.0.1:9', WIREBENCH_SERVER_OIDC_CLIENT_ID: 'c', WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 's' };
    expect(problemsOf({ ...base, ...oidc })[0]).toContain('WIREBENCH_SERVER_OIDC_ISSUER');
    const config = loadConfig({ ...base, ...oidc, WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true', WIREBENCH_SERVER_OIDC_SCOPES: ' openid  email ' }, '1');
    expect(config.oidcScopes).toEqual(['openid', 'email']);
    expect(config.oidcClientSecret).toBe('s');
  });

  it('marks the client secret as a secret so config check and the README never print it', () => {
    expect(CONFIG_VARIABLES.find((v) => v.env === 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET')?.secret).toBe(true);
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/config.test.ts`
Expected: FAIL — unknown fields.

- [ ] **Step 3: Extend `config.ts`**

In `inputSchema`, after `allowInsecurePublicUrl`, add:

```ts
  localAuth: booleanText('true'),
  oidcIssuer: z.string().url().optional(),
  oidcClientId: z.string().min(1).optional(),
  oidcClientSecret: z.string().min(1).optional(),
  oidcScopes: z
    .string()
    .min(1)
    .default('openid email profile')
    .transform((value) => value.split(/\s+/).filter((scope) => scope.length > 0)),
  oidcDisplayName: z.string().min(1).max(60).default('OIDC'),
  tokenIdleDays: integerText(1, 3650, '30'),
  tokenMaxDays: integerText(1, 3650, '180'),
  invitationDays: integerText(1, 365, '7'),
```

Append to `CONFIG_VARIABLES` (order is the README's order):

```ts
  { env: 'WIREBENCH_SERVER_LOCAL_AUTH', key: 'localAuth', required: false, defaultText: 'true', secret: false, description: 'Offer local accounts (email and password).' },
  { env: 'WIREBENCH_SERVER_OIDC_ISSUER', key: 'oidcIssuer', required: false, secret: false, description: 'OIDC issuer URL; setting it turns OIDC sign-in on. Discovery runs at start-up.' },
  { env: 'WIREBENCH_SERVER_OIDC_CLIENT_ID', key: 'oidcClientId', required: false, secret: false, description: 'Client id registered at the issuer. Required with the issuer.' },
  { env: 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET', key: 'oidcClientSecret', required: false, secret: true, description: 'Client secret registered at the issuer. Required with the issuer.' },
  { env: 'WIREBENCH_SERVER_OIDC_SCOPES', key: 'oidcScopes', required: false, defaultText: 'openid email profile', secret: false, description: 'Scopes requested from the issuer, space-separated.' },
  { env: 'WIREBENCH_SERVER_OIDC_DISPLAY_NAME', key: 'oidcDisplayName', required: false, defaultText: 'OIDC', secret: false, description: 'The label of the *Continue with …* button in the app.' },
  { env: 'WIREBENCH_SERVER_TOKEN_IDLE_DAYS', key: 'tokenIdleDays', required: false, defaultText: '30', secret: false, description: 'A device token unused for this long expires.' },
  { env: 'WIREBENCH_SERVER_TOKEN_MAX_DAYS', key: 'tokenMaxDays', required: false, defaultText: '180', secret: false, description: 'A device token older than this expires whatever its use.' },
  { env: 'WIREBENCH_SERVER_INVITATION_DAYS', key: 'invitationDays', required: false, defaultText: '7', secret: false, description: 'How long an invitation or password-reset link stays valid.' },
```

In `loadConfig`, after the public URL check and before `return`, add the cross-field rules:

```ts
  // Cross-field rules zod cannot express per key: the two IdP credentials travel with the issuer,
  // an http:// issuer is a development-only choice like an http:// public URL, and a server with
  // no way to sign in at all is a misconfiguration, not a quiet server (identity spec §4.1).
  const problems: ConfigProblem[] = [];
  if (config.oidcIssuer !== undefined) {
    for (const [key, variable] of [
      ['oidcClientId', 'WIREBENCH_SERVER_OIDC_CLIENT_ID'],
      ['oidcClientSecret', 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET'],
    ] as const) {
      if (config[key] === undefined) problems.push({ variable, message: 'is required when WIREBENCH_SERVER_OIDC_ISSUER is set' });
    }
    const issuer = new URL(config.oidcIssuer);
    if (!(issuer.protocol === 'https:' || (issuer.protocol === 'http:' && config.allowInsecurePublicUrl))) {
      problems.push({
        variable: 'WIREBENCH_SERVER_OIDC_ISSUER',
        message: 'must be https://; set WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true for an http:// development issuer',
      });
    }
  }
  if (!config.localAuth && config.oidcIssuer === undefined) {
    problems.push({
      variable: 'WIREBENCH_SERVER_LOCAL_AUTH',
      message: 'identity-no-method: at least one sign-in method must be on; set it to true or set WIREBENCH_SERVER_OIDC_ISSUER',
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/config.test.ts && pnpm docs:server-config`
Expected: PASS; the README table gains nine rows.

- [ ] **Step 4: The migration**

`packages/server/migrations/identity/0002_identity.sql`:

```sql
-- Wirebench Server 0002: identity (identity spec §4.2). `email` keeps what the admin typed for
-- display; `email_lower` is the key every comparison uses.
create table users (
  id           text primary key,
  email        text not null,
  email_lower  text not null unique,
  display_name text not null,
  server_admin boolean not null default false,
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);

create table local_credentials (
  user_id       text primary key references users on delete cascade,
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

create table oidc_identities (
  issuer    text not null,
  subject   text not null,
  user_id   text not null references users on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (issuer, subject)
);
create index oidc_identities_user_id on oidc_identities (user_id);

create table invitations (
  id           text primary key,
  kind         text not null check (kind in ('invite', 'reset')),
  email        text not null,
  email_lower  text not null,
  user_id      text references users on delete cascade,
  secret_hash  text not null unique,
  server_admin boolean not null default false,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
-- One open invitation per email (§4.2); resets are per user and may coexist with an invite.
create unique index invitations_one_open_per_email
  on invitations (email_lower) where kind = 'invite' and accepted_at is null and revoked_at is null;

create table device_tokens (
  id           text primary key,
  user_id      text not null references users on delete cascade,
  token_hash   text not null unique,
  device_name  text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index device_tokens_user_id on device_tokens (user_id);

create table oidc_flows (
  id             text primary key,
  code_challenge text not null,
  loopback_port  integer not null,
  device_name    text not null,
  state          text not null unique,
  nonce          text not null,
  grant_hash     text unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  user_id        text
);
```

- [ ] **Step 5: The module skeleton, its environment and the built-in list**

`packages/server/src/identity/oidc.ts` (Task 7 adds `discoverOidc`; for now only the contract):

```ts
/** What the routes see of the identity provider; `openid-client` is wrapped behind it (spec §15). */
export interface OidcClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

export interface OidcProvider {
  readonly issuer: string;
  authorizationUrl(input: { readonly state: string; readonly nonce: string; readonly redirectUri: string }): string;
  /** Exchanges the code in `callbackUrl` and verifies the ID token; rejects when the IdP refuses. */
  exchange(input: { readonly callbackUrl: URL; readonly state: string; readonly nonce: string }): Promise<OidcClaims>;
}
```

`packages/server/src/identity/rate-limit.ts`: create it now with the exact contents of Task 3
Step 4 (the class and the `rateLimit`, `ipKey`, `emailKey` helpers); Task 3 adds its tests.

`packages/server/src/identity/env.ts`:

```ts
import type { ServerConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import type { OidcProvider } from './oidc.js';
import type { RateLimiter } from './rate-limit.js';

/** The §4.1 knobs the routes read, derived once from the configuration. */
export interface IdentitySettings {
  readonly local: boolean;
  readonly oidc: { readonly issuer: string; readonly displayName: string } | undefined;
  readonly tokenIdleMs: number;
  readonly tokenMaxMs: number;
  readonly invitationMs: number;
  readonly redirectUri: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function identitySettings(config: ServerConfig): IdentitySettings {
  return {
    local: config.localAuth,
    oidc: config.oidcIssuer === undefined ? undefined : { issuer: config.oidcIssuer, displayName: config.oidcDisplayName },
    tokenIdleMs: config.tokenIdleDays * DAY_MS,
    tokenMaxMs: config.tokenMaxDays * DAY_MS,
    invitationMs: config.invitationDays * DAY_MS,
    redirectUri: `${config.publicUrl}/api/v1/auth/oidc/callback`,
  };
}

/** Everything a route file needs; built once by `module.ts` and passed to each route group. */
export interface IdentityEnv {
  readonly ctx: ServerContext;
  readonly settings: IdentitySettings;
  readonly now: () => Date;
  readonly limiter: RateLimiter;
  readonly provider: OidcProvider | undefined;
}
```

`packages/server/src/identity/module.ts`:

```ts
/**
 * The `identity` ServerModule (spec §5.1). Registration order inside `register` matters: the
 * `onRequest` hook must exist before any route that reads `request.caller`, and the module is
 * mounted into the shared /api/v1 scope, so the hook also reaches `teams-access` and
 * `server-sync` registered after it.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings, type IdentityEnv } from './env.js';
import type { OidcProvider } from './oidc.js';
import { RateLimiter } from './rate-limit.js';

export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/identity/', import.meta.url));

export interface IdentityOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** A provider instead of discovery — the fake issuer in tests. */
  readonly provider?: OidcProvider;
  /** How often expired tokens and flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

export function identityModule(options: IdentityOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      const env: IdentityEnv = {
        ctx,
        settings,
        now,
        limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
        provider: options.provider,
      };
      ctx.meta.setSignInMethods({
        local: settings.local,
        oidc: settings.oidc !== undefined,
        ...(settings.oidc !== undefined ? { oidcDisplayName: settings.oidc.displayName } : {}),
      });
      ctx.meta.addCapability('identity');
      void env; // Tasks 4–7 add the hook, the routes, discovery and the sweep here.
      await Promise.resolve();
    },
  };
}
```

`packages/server/src/modules.ts`:

```ts
import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';

/** The modules a production process runs, in registration order. Tests pass their own list. */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule()];
```

- [ ] **Step 6: Wire the built-in modules, the redirect URI and the register-failure exit**

`packages/server/src/main.ts`:
- import `BUILTIN_MODULES` from `./modules.js`;
- `case 'migrate': return runMigrate(io.env, io, command.check, serveOptions.modules ?? BUILTIN_MODULES);`
- `case 'serve'`: `startServer(io.env, io, { modules: BUILTIN_MODULES, ...serveOptions })`;
- in `case 'config-check'`, keep `loadConfig`'s result and print the IdP redirect URI when OIDC is
  on (§4.1):

```ts
        const config = loadConfig(io.env, packageVersion());
        if (config.oidcIssuer !== undefined) {
          io.stdout.write(`OIDC redirect URI to register at the issuer: ${config.publicUrl}/api/v1/auth/oidc/callback\n`);
        }
        return ExitCode.Ok;
```

`packages/server/src/serve.ts`, the `buildServer` try/catch (around line 214):

```ts
  } catch (error) {
    await db.close(); // a module that fails to register must not leave the pool holding the process open
    if (error instanceof StartupError) throw error;
    // Discovery against the IdP, a duplicate decorator, a bad route: all configuration-shaped
    // failures of a module's register(), reported as exit 2 with the module's own message.
    throw new StartupError(ExitCode.Config, `a module failed to register: ${error instanceof Error ? error.message : String(error)}`);
  }
```

- [ ] **Step 7: Integration test: the migration applies and meta reports the methods**

Move `freePort()` from `packages/server/test/integration/boot.test.ts:14-25` to
`packages/server/test/helpers/net.ts` (`export function freePort(): Promise<number>`, same body and
comment) and import it in `boot.test.ts`.

`packages/server/test/integration/identity/config.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { identityModule } from '../../../src/identity/module.js';
import { main } from '../../../src/main.js';
import { allMigrations, startServer } from '../../../src/serve.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

describeDb('identity module boot', () => {
  let dataDir: string;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = (extra: Record<string, string> = {}) => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    ...extra,
  });
  const io = (e: NodeJS.ProcessEnv) => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: e });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    db = await testDatabase();
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('brings 0002_identity into the migration list right after the host', async () => {
    expect((await allMigrations([identityModule()])).map((m) => `${m.version}_${m.name}`)).toEqual(['1_init', '2_identity']);
  });

  it('applies the identity tables and reports local auth in meta by default', async () => {
    const e = env({ WIREBENCH_SERVER_PORT: String(await freePort()) });
    const server = await startServer(e, io(e), { signals: new EventEmitter(), exit: vi.fn(), modules: [identityModule({ sweepIntervalMs: 0 })] });
    try {
      const meta: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/meta`)).json();
      expect(meta).toMatchObject({ auth: { local: true, oidc: false }, capabilities: ['identity'] });
      expect((await db.query("select to_regclass('users') is not null as ok")).rows[0]).toEqual({ ok: true });
      expect((await db.query('select version from schema_migrations order by version')).rows).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      await server.close();
    }
  });

  it('serve exits 2 with identity-no-method when both methods are off', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['serve'], { stdout: { write: vi.fn() }, stderr, env: env({ WIREBENCH_SERVER_LOCAL_AUTH: 'false' }) }, { exit: vi.fn() });
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).toContain('identity-no-method');
  });

  it('config check prints the redirect URI once an issuer is configured, never the secret', async () => {
    const stdout = { write: vi.fn() };
    const code = await main(['config', 'check'], {
      stdout,
      stderr: { write: vi.fn() },
      env: env({ WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test', WIREBENCH_SERVER_OIDC_CLIENT_ID: 'c', WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 'top-secret' }),
    });
    expect(code).toBe(0);
    const text = stdout.write.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('https://wirebench.test/api/v1/auth/oidc/callback');
    expect(text).not.toContain('top-secret');
  });
});
```

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/identity/config.test.ts packages/server/test/integration/boot.test.ts`
Expected: PASS (4 + the boot suite).

- [ ] **Step 8: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server pnpm-lock.yaml scripts/third-party-licenses.test.ts THIRD-PARTY-LICENSES.md
git commit -m "feat(server): identity configuration, schema migration and module skeleton

The nine WIREBENCH_SERVER_{LOCAL_AUTH,OIDC_*,TOKEN_*,INVITATION_DAYS}
variables join the host's table so config check and the README stay
generated from one place; the cross-field rules (credentials travel
with the issuer, at least one method on) are the ones zod cannot state
per key. The migration lives under migrations/identity because tsc
copies no .sql. A module whose register() throws now exits 2 instead of
surfacing as an unhandled rejection."
```

---

### Task 3: Passwords, tokens, secrets and the rate limiter

**Files:**
- Create: `packages/server/src/identity/passwords.ts`, `packages/server/src/identity/tokens.ts`,
  `packages/server/src/identity/errors.ts`, `packages/server/test/unit/identity/passwords.test.ts`,
  `packages/server/test/unit/identity/tokens.test.ts`, `packages/server/test/unit/identity/rate-limit.test.ts`
- Modify: `packages/server/src/identity/rate-limit.ts` (created in Task 2 Step 5 with this task's Step 4 contents)

**Interfaces:**
- Produces: `SCRYPT_PARAMS`, `hashPassword(password, params?) → Promise<string>`,
  `verifyPassword(password, stored) → Promise<{ ok: boolean; rehash: boolean }>`, `parseStoredHash`;
  `newId(): string`, `mintSecret(): { secret; hash }`, `hashSecret(secret): string` (hex sha256),
  `mintToken(): { token; hash }`, `hashToken(token)`, `bearerToken(header) → string | undefined`,
  `pkceChallenge(verifier): string`; `RateLimiter` with `take(key) → { allowed; retryAfterSeconds }`,
  `rateLimit(env, keysOf) → preHandlerHookHandler`, `ipKey`, `emailKey`; one function per problem in
  `errors.ts` (`unauthenticated`, `forbidden`, `userDisabled`, `methodDisabled`, `invalidCredentials`,
  `invitationInvalid`, `invitationExists`, `userExists`, `flowInvalid`, `passwordTooShort`,
  `selfChange`, `notFound(what)`, `emailUnverified`, `notInvited`, `oidcFailed`).
- Consumes: `problem()` (server-host), `MIN_PASSWORD_LENGTH`, `DEVICE_TOKEN_PATTERN` (Task 1), `IdentityEnv` (Task 2).

- [ ] **Step 1: Write the failing unit tests**

`packages/server/test/unit/identity/passwords.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, parseStoredHash, SCRYPT_PARAMS, verifyPassword } from '../../../src/identity/passwords.js';

describe('passwords (§3.4)', () => {
  it('stores scrypt$N$r$p$salt$hash with the documented parameters and a fresh 16-byte salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(a).not.toBe(b);
    expect(parseStoredHash(a)?.params).toEqual(SCRYPT_PARAMS);
  });
  it('verifies the right password, refuses a wrong one, and never throws on garbage', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, rehash: false });
    expect(await verifyPassword('correct horse batter', stored)).toEqual({ ok: false, rehash: false });
    expect(await verifyPassword('x', 'not-a-hash')).toEqual({ ok: false, rehash: false });
    expect(await verifyPassword('x', 'scrypt$abc$8$1$AA$AA')).toEqual({ ok: false, rehash: false });
  });
  it('asks for a rehash when the stored parameters are older than the current set', async () => {
    const old = await hashPassword('correct horse battery', { N: 2 ** 14, r: 8, p: 1, keylen: 32 });
    expect(await verifyPassword('correct horse battery', old)).toEqual({ ok: true, rehash: true });
  });
});
```

`packages/server/test/unit/identity/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN, SECRET_PATTERN } from '@wirebench/engine';
import { bearerToken, hashSecret, hashToken, mintSecret, mintToken, newId, pkceChallenge } from '../../../src/identity/tokens.js';

describe('tokens and secrets (§3.5, §6)', () => {
  it('mints wbs_ + 43 base64url characters and stores only a sha256 hex', () => {
    const { token, hash } = mintToken();
    expect(token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(4, 20));
  });
  it('mints invitation secrets and grants in the shared shape', () => {
    const { secret, hash } = mintSecret();
    expect(secret).toMatch(SECRET_PATTERN);
    expect(hashSecret(secret)).toBe(hash);
    expect(mintSecret().secret).not.toBe(secret);
  });
  it('parses a Bearer header case-insensitively and rejects everything else', () => {
    const { token } = mintToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(`Basic ${token}`)).toBeUndefined();
    expect(bearerToken('Bearer nope')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
  it('derives the S256 challenge the desktop sends (RFC 7636 appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('mints 26-character ULIDs', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
```

`packages/server/test/unit/identity/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/identity/rate-limit.js';

describe('RateLimiter (§3.6)', () => {
  const limiter = (start = 0) => {
    let now = start;
    const limit = new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now });
    return { limit, tick: (ms: number) => (now += ms) };
  };
  it('allows ten attempts a minute per key, then refuses with a Retry-After', () => {
    const { limit } = limiter();
    for (let i = 0; i < 10; i += 1) expect(limit.take('ip:1').allowed).toBe(true);
    const refused = limit.take('ip:1');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(6);
    expect(limit.take('ip:2').allowed).toBe(true);
  });
  it('refills one attempt every six seconds and never beyond the capacity', () => {
    const { limit, tick } = limiter();
    for (let i = 0; i < 10; i += 1) limit.take('k');
    tick(6_000);
    expect(limit.take('k').allowed).toBe(true);
    expect(limit.take('k').allowed).toBe(false);
    tick(600_000);
    for (let i = 0; i < 10; i += 1) expect(limit.take('k').allowed).toBe(true);
    expect(limit.take('k').allowed).toBe(false);
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/identity`
Expected: passwords and tokens FAIL (modules not found); rate-limit passes if Task 2 created the file.

- [ ] **Step 2: `passwords.ts`**

```ts
/**
 * Password hashing (identity spec §3.4): scrypt from node:crypto, parameters stored beside the
 * hash so they can change later without a migration — a sign-in with an older set verifies and
 * then asks to be rehashed. Argon2 would need a native module; scrypt with these parameters is
 * the memory-hard choice the platform ships.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

/** Changing these is an "ask first" item (spec §12). */
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
const PREFIX = 'scrypt';

/** scrypt needs 128·N·r bytes; Node's default `maxmem` (32 MiB) is exactly that for N=2^15, r=8. */
const maxmem = (params: ScryptParams): number => 256 * params.N * params.r;

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return (await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params) })) as Buffer;
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params);
  return [PREFIX, params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function parseStoredHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64');
  const hash = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || hash.length === 0) return undefined;
  return { params: { N: N!, r: r!, p: p!, keylen: hash.length }, salt, hash };
}

/** `rehash` is true when the password is right but was hashed with parameters older than {@link SCRYPT_PARAMS}. */
export async function verifyPassword(password: string, stored: string): Promise<{ readonly ok: boolean; readonly rehash: boolean }> {
  const parsed = parseStoredHash(stored);
  if (parsed === undefined) return { ok: false, rehash: false };
  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed.params);
  } catch {
    return { ok: false, rehash: false }; // parameters scrypt refuses (N not a power of two, too much memory)
  }
  const ok = candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  const current = parsed.params;
  const rehash =
    ok && (current.N !== SCRYPT_PARAMS.N || current.r !== SCRYPT_PARAMS.r || current.p !== SCRYPT_PARAMS.p || current.keylen !== SCRYPT_PARAMS.keylen);
  return { ok, rehash };
}
```

- [ ] **Step 3: `tokens.ts`**

```ts
/**
 * Random material and its hashes (identity spec §3.5, §6): device tokens, invitation secrets,
 * OIDC grants and states. The database only ever sees `sha256(value)`; the value goes to the
 * client exactly once. A token is `wbs_` + base64url(32 bytes) so a leaked one is recognisable
 * in a log or a scanner, and `bearerToken` accepts nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { ulid } from 'ulidx';

export const TOKEN_PREFIX = 'wbs_';

export function newId(): string {
  return ulid();
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function mintSecret(): { readonly secret: string; readonly hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}

export function hashToken(token: string): string {
  return hashSecret(token);
}

export function mintToken(): { readonly token: string; readonly hash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/** The token in an `Authorization: Bearer wbs_…` header, or `undefined` for anything else. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token !== undefined && DEVICE_TOKEN_PATTERN.test(token) ? token : undefined;
}

/** RFC 7636 S256: what the desktop sends as `codeChallenge` and proves with the verifier later. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
```

- [ ] **Step 4: `rate-limit.ts` and `errors.ts`**

`packages/server/src/identity/rate-limit.ts`:

```ts
/**
 * In-process token buckets (identity spec §3.6): 10 attempts a minute per key, refilled
 * continuously. State is per process by design — ADR-0009 runs one replica — and resets on
 * restart. The map is pruned of full buckets when it grows, so an address scan cannot make it
 * grow without bound.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { IdentityEnv } from './env.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until one attempt is available again; `0` when allowed. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const PRUNE_ABOVE = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: { readonly capacity: number; readonly refillPerMs: number; readonly now?: () => number }) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.now = options.now ?? (() => Date.now());
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
      this.prune();
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, updatedAt: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
  }

  private prune(): void {
    if (this.buckets.size <= PRUNE_ABOVE) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * A preHandler that charges every key `keysOf` returns and answers 429 with `Retry-After` when
 * any is empty. Sent directly rather than thrown: the host's error handler sets no headers.
 */
export function rateLimit(env: IdentityEnv, keysOf: (request: FastifyRequest) => readonly (string | undefined)[]): preHandlerHookHandler {
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    let retryAfter = 0;
    for (const key of keysOf(request)) {
      if (key === undefined) continue;
      const decision = env.limiter.take(key);
      if (!decision.allowed) retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
    }
    if (retryAfter > 0) {
      void reply
        .header('retry-after', String(retryAfter))
        .code(429)
        .send({ code: 'identity-rate-limited', message: 'Too many attempts. Try again shortly.' });
      return;
    }
    done();
  };
}

/** The per-IP key; `request.ip` already honours `trustProxy`. */
export const ipKey = (request: FastifyRequest): string => `ip:${request.ip}`;
/** The per-email key of a body that carries one, lower-cased so case cannot dodge the bucket. */
export const emailKey = (request: FastifyRequest): string | undefined => {
  const email = (request.body as { readonly email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? `email:${email.trim().toLowerCase()}` : undefined;
};
```

`packages/server/src/identity/errors.ts`:

```ts
/** Every `identity-*` problem (spec §3.1, §10), one function each so a code is spelled once. */
import { MIN_PASSWORD_LENGTH } from '@wirebench/engine';
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const unauthenticated = (): WirebenchError => problem('identity-unauthenticated', 'Sign in to continue.', 401);
export const forbidden = (): WirebenchError => problem('identity-forbidden', 'Only a server admin can do this.', 403);
export const userDisabled = (): WirebenchError => problem('identity-user-disabled', 'This account is disabled.', 403);
export const methodDisabled = (): WirebenchError =>
  problem('identity-method-disabled', 'This sign-in method is not offered by this server.', 404);
/** One message for an unknown email and a wrong password (§6). */
export const invalidCredentials = (): WirebenchError =>
  problem('identity-invalid-credentials', 'The email or password is not right.', 401);
export const invitationInvalid = (): WirebenchError =>
  problem('identity-invitation-invalid', 'This invitation has expired or was already used.', 404);
export const invitationExists = (): WirebenchError =>
  problem('identity-invitation-exists', 'An open invitation for this email already exists; revoke it first.', 409);
export const userExists = (): WirebenchError => problem('identity-user-exists', 'A user with this email already exists.', 409);
export const flowInvalid = (): WirebenchError =>
  problem('identity-flow-invalid', 'This sign-in could not be completed. Start again from Wirebench.', 400);
export const passwordTooShort = (): WirebenchError =>
  problem('identity-password-too-short', `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters long.`, 400);
export const selfChange = (): WirebenchError =>
  problem('identity-self-change', 'You cannot remove your own admin flag or disable yourself.', 400);
export const notFound = (what: string): WirebenchError => problem('identity-not-found', `${what} was not found.`, 404);
export const emailUnverified = (): WirebenchError =>
  problem('identity-email-unverified', 'The identity provider did not assert email_verified for this account, so it cannot be linked.', 403);
export const notInvited = (): WirebenchError =>
  problem('identity-not-invited', 'No account or open invitation exists for this email. Ask a server admin to invite you.', 403);
export const oidcFailed = (): WirebenchError =>
  problem('identity-oidc-failed', 'The identity provider did not complete the sign-in.', 502);
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/identity`
Expected: 10 passed.

- [ ] **Step 5: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src/identity packages/server/test/unit/identity
git commit -m "feat(server): scrypt passwords, hashed tokens and secrets, token-bucket rate limiter

Parameters travel with each hash so they can change without a migration;
the database only ever holds sha256 of a token or invitation secret; the
limiter is per process because ADR-0009 runs one replica."
```

---

### Task 4: The SQL repository and the caller guard

**Files:**
- Create: `packages/server/src/identity/repo.ts`, `packages/server/src/identity/guard.ts`,
  `packages/server/test/helpers/identity.ts`, `packages/server/test/integration/identity/repo.test.ts`,
  `packages/server/test/integration/identity/guard.test.ts`
- Modify: `packages/server/src/identity/module.ts` (register the hook)

**Interfaces:**
- Produces: row types `UserRow`, `CredentialRow`, `InvitationRow`, `TokenRow`, `FlowRow`; the
  `repo.*` functions listed in Step 2 (every one takes a `Querier` first); `Caller`,
  `authenticate(env)`, `requireUser`, `requireServerAdmin`, `isTokenExpired`, `TOUCH_EVERY_MS`;
  test helpers `identityHarness(options?)` → `{ app, db, clock, close }` and
  `signedInUser(harness, input)` → `{ user, token, tokenId, headers }`.
- Consumes: `Querier`, `Database`, `problem` (server-host); `IdentityEnv` (Task 2); `hashToken`,
  `bearerToken`, `newId` (Task 3); `errors.ts` (Task 3).

- [ ] **Step 1: The test harness**

`packages/server/test/helpers/identity.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import type { ServerEvents, ServerModule } from '../../src/context.js';
import { migrate } from '../../src/db/migrate.js';
import { identityModule } from '../../src/identity/module.js';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { hashPassword } from '../../src/identity/passwords.js';
import * as repo from '../../src/identity/repo.js';
import { mintToken, newId } from '../../src/identity/tokens.js';
import { allMigrations } from '../../src/serve.js';
import { buildServer } from '../../src/server.js';
import { testContext } from './context.js';
import { testDatabase } from './database.js';
import { mkTempDir, removeTempDir } from './git.js';

export interface TestClock {
  now: Date;
  set(at: Date): void;
  advance(ms: number): void;
}

export interface IdentityHarness {
  readonly app: FastifyInstance;
  readonly db: Awaited<ReturnType<typeof testDatabase>>;
  readonly clock: TestClock;
  /** The context's emitter, to assert on `invitation.accepted`. */
  readonly events: ServerEvents;
  close(): Promise<void>;
}

export const OIDC_ENV = {
  WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test',
  WIREBENCH_SERVER_OIDC_CLIENT_ID: 'wirebench',
  WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 'client-secret',
};

/**
 * A server with the identity module (and any `modules` after it) over a fresh schema, an
 * injectable clock and no sweep timer. `env` overrides the configuration; pass `OIDC_ENV` plus a
 * `provider` to turn OIDC on without discovery.
 */
export async function identityHarness(
  options: { readonly env?: Record<string, string>; readonly provider?: OidcProvider; readonly modules?: readonly ServerModule[] } = {},
): Promise<IdentityHarness> {
  const db = await testDatabase();
  const dataDir = await mkTempDir();
  const clock: TestClock = {
    now: new Date('2026-09-24T12:00:00.000Z'),
    set(at) {
      this.now = at;
    },
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const config = loadConfig(
    {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      ...options.env,
    },
    '0.0.0-test',
  );
  const identity = identityModule({
    now: () => clock.now,
    sweepIntervalMs: 0,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });
  const modules = [identity, ...(options.modules ?? [])];
  await migrate(db, await allMigrations(modules));
  const ctx = await testContext({ dataDir, db, config });
  const app = await buildServer(ctx, { modules });
  return {
    app,
    db,
    clock,
    events: ctx.events,
    close: async () => {
      await app.close();
      await db.close();
      await removeTempDir(dataDir);
    },
  };
}

export interface SignedInUser {
  readonly user: repo.UserRow;
  readonly token: string;
  readonly tokenId: string;
  readonly headers: { readonly authorization: string };
}

/** A user written straight into the tables, with a credential when `password` is given and one device token. */
export async function signedInUser(
  harness: IdentityHarness,
  input: { readonly email: string; readonly password?: string; readonly serverAdmin?: boolean; readonly disabled?: boolean; readonly deviceName?: string },
): Promise<SignedInUser> {
  const at = harness.clock.now;
  const user = await repo.insertUser(harness.db, {
    id: newId(),
    email: input.email,
    displayName: input.email.split('@')[0] ?? input.email,
    serverAdmin: input.serverAdmin ?? false,
    at,
  });
  if (input.password !== undefined) await repo.upsertCredential(harness.db, user.id, await hashPassword(input.password), at);
  if (input.disabled === true) await repo.setDisabled(harness.db, user.id, at);
  const { token, hash } = mintToken();
  const tokenId = newId();
  await repo.insertToken(harness.db, { id: tokenId, userId: user.id, tokenHash: hash, deviceName: input.deviceName ?? 'test device', at });
  return { user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
}
```

- [ ] **Step 2: `repo.ts`**

```ts
/**
 * Every SQL statement of the identity module (spec §4.2), one function each over a `Querier` so
 * a route can run several inside one `db.transaction`. Columns come back aliased to the
 * camelCase the module uses; `timestamptz` values arrive from pg as `Date` and leave here as
 * ISO-8601 strings, the only date shape the wire schemas know.
 */
import type { Querier } from '../context.js';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly emailLower: string;
  readonly displayName: string;
  readonly serverAdmin: boolean;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}
export interface CredentialRow {
  readonly userId: string;
  readonly passwordHash: string;
  readonly updatedAt: string;
}
export interface InvitationRow {
  readonly id: string;
  readonly kind: 'invite' | 'reset';
  readonly email: string;
  readonly emailLower: string;
  readonly userId: string | null;
  readonly secretHash: string;
  readonly serverAdmin: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}
export interface TokenRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly deviceName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly revokedAt: string | null;
}
export interface FlowRow {
  readonly id: string;
  readonly codeChallenge: string;
  readonly loopbackPort: number;
  readonly deviceName: string;
  readonly state: string;
  readonly nonce: string;
  readonly grantHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly userId: string | null;
}

type Raw = Record<string, unknown>;

const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : (value instanceof Date ? value : new Date(String(value))).toISOString();

/** Converts the named timestamp columns of `row` to ISO strings; everything else is already the right type. */
function withDates<T>(row: Raw, keys: readonly string[]): T {
  const out: Raw = { ...row };
  for (const key of keys) if (key in out) out[key] = isoOrNull(out[key]);
  return out as T;
}

const USER_COLUMNS =
  'id, email, email_lower as "emailLower", display_name as "displayName", server_admin as "serverAdmin", created_at as "createdAt", disabled_at as "disabledAt"';
const USER_DATES = ['createdAt', 'disabledAt'];
const INVITATION_COLUMNS =
  'id, kind, email, email_lower as "emailLower", user_id as "userId", secret_hash as "secretHash", server_admin as "serverAdmin", created_by as "createdBy", created_at as "createdAt", expires_at as "expiresAt", accepted_at as "acceptedAt", revoked_at as "revokedAt"';
const INVITATION_DATES = ['createdAt', 'expiresAt', 'acceptedAt', 'revokedAt'];
const TOKEN_COLUMNS =
  'id, user_id as "userId", token_hash as "tokenHash", device_name as "deviceName", created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"';
const TOKEN_DATES = ['createdAt', 'lastUsedAt', 'revokedAt'];
const FLOW_COLUMNS =
  'id, code_challenge as "codeChallenge", loopback_port as "loopbackPort", device_name as "deviceName", state, nonce, grant_hash as "grantHash", created_at as "createdAt", expires_at as "expiresAt", user_id as "userId"';
const FLOW_DATES = ['createdAt', 'expiresAt'];

const first = <T>(rows: readonly Raw[], dates: readonly string[]): T | undefined =>
  rows[0] === undefined ? undefined : withDates<T>(rows[0], dates);

// ---- users -------------------------------------------------------------------------------

export async function findUserByEmail(db: Querier, emailLower: string): Promise<UserRow | undefined> {
  return first((await db.query(`select ${USER_COLUMNS} from users where email_lower = $1`, [emailLower])).rows, USER_DATES);
}

export async function findUserById(db: Querier, id: string): Promise<UserRow | undefined> {
  return first((await db.query(`select ${USER_COLUMNS} from users where id = $1`, [id])).rows, USER_DATES);
}

export async function insertUser(
  db: Querier,
  input: { readonly id: string; readonly email: string; readonly displayName: string; readonly serverAdmin: boolean; readonly at: Date },
): Promise<UserRow> {
  const rows = (
    await db.query(
      `insert into users (id, email, email_lower, display_name, server_admin, created_at) values ($1, $2, $3, $4, $5, $6) returning ${USER_COLUMNS}`,
      [input.id, input.email.trim(), input.email.trim().toLowerCase(), input.displayName, input.serverAdmin, input.at],
    )
  ).rows;
  return withDates<UserRow>(rows[0]!, USER_DATES);
}

export async function listUsers(db: Querier): Promise<readonly UserRow[]> {
  return (await db.query(`select ${USER_COLUMNS} from users order by email_lower`)).rows.map((row) => withDates<UserRow>(row, USER_DATES));
}

export async function setServerAdmin(db: Querier, id: string, serverAdmin: boolean): Promise<void> {
  await db.query('update users set server_admin = $2 where id = $1', [id, serverAdmin]);
}

/** `at: null` re-enables. */
export async function setDisabled(db: Querier, id: string, at: Date | null): Promise<void> {
  await db.query('update users set disabled_at = $2 where id = $1', [id, at]);
}

// ---- credentials and OIDC identities -------------------------------------------------------

export async function credentialOf(db: Querier, userId: string): Promise<CredentialRow | undefined> {
  return first(
    (await db.query('select user_id as "userId", password_hash as "passwordHash", updated_at as "updatedAt" from local_credentials where user_id = $1', [userId])).rows,
    ['updatedAt'],
  );
}

export async function upsertCredential(db: Querier, userId: string, passwordHash: string, at: Date): Promise<void> {
  await db.query(
    'insert into local_credentials (user_id, password_hash, updated_at) values ($1, $2, $3) on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at',
    [userId, passwordHash, at],
  );
}

export async function oidcIdentityOf(db: Querier, issuer: string, subject: string): Promise<{ readonly userId: string } | undefined> {
  const rows = (await db.query<{ userId: string }>('select user_id as "userId" from oidc_identities where issuer = $1 and subject = $2', [issuer, subject])).rows;
  return rows[0];
}

export async function insertOidcIdentity(db: Querier, input: { readonly issuer: string; readonly subject: string; readonly userId: string; readonly at: Date }): Promise<void> {
  await db.query('insert into oidc_identities (issuer, subject, user_id, linked_at) values ($1, $2, $3, $4)', [input.issuer, input.subject, input.userId, input.at]);
}

export interface SignInMethods {
  readonly local: boolean;
  readonly oidc: readonly { readonly issuer: string }[];
}

/** The methods each of `userIds` can sign in with; a user with neither is still in the map. */
export async function signInMethodsOf(db: Querier, userIds: readonly string[]): Promise<ReadonlyMap<string, SignInMethods>> {
  const result = new Map<string, { local: boolean; oidc: { issuer: string }[] }>(userIds.map((id) => [id, { local: false, oidc: [] }]));
  if (userIds.length === 0) return result;
  for (const row of (await db.query<{ userId: string }>('select user_id as "userId" from local_credentials where user_id = any($1)', [userIds])).rows) {
    result.get(row.userId)!.local = true;
  }
  for (const row of (
    await db.query<{ userId: string; issuer: string }>('select user_id as "userId", issuer from oidc_identities where user_id = any($1) order by issuer', [userIds])
  ).rows) {
    result.get(row.userId)!.oidc.push({ issuer: row.issuer });
  }
  return result;
}

// ---- invitations ---------------------------------------------------------------------------

export async function insertInvitation(
  db: Querier,
  input: {
    readonly id: string;
    readonly kind: 'invite' | 'reset';
    readonly email: string;
    readonly userId: string | null;
    readonly secretHash: string;
    readonly serverAdmin: boolean;
    readonly createdBy: string | null;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<InvitationRow> {
  const rows = (
    await db.query(
      `insert into invitations (id, kind, email, email_lower, user_id, secret_hash, server_admin, created_by, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${INVITATION_COLUMNS}`,
      [input.id, input.kind, input.email.trim(), input.email.trim().toLowerCase(), input.userId, input.secretHash, input.serverAdmin, input.createdBy, input.createdAt, input.expiresAt],
    )
  ).rows;
  return withDates<InvitationRow>(rows[0]!, INVITATION_DATES);
}

/** The one open (unaccepted, unrevoked, unexpired) `invite` for an email, if any. */
export async function openInvitationByEmail(db: Querier, emailLower: string, now: Date): Promise<InvitationRow | undefined> {
  return first(
    (
      await db.query(
        `select ${INVITATION_COLUMNS} from invitations where kind = 'invite' and email_lower = $1 and accepted_at is null and revoked_at is null and expires_at > $2`,
        [emailLower, now],
      )
    ).rows,
    INVITATION_DATES,
  );
}

export async function invitationBySecretHash(db: Querier, secretHash: string): Promise<InvitationRow | undefined> {
  return first((await db.query(`select ${INVITATION_COLUMNS} from invitations where secret_hash = $1`, [secretHash])).rows, INVITATION_DATES);
}

export async function invitationById(db: Querier, id: string): Promise<InvitationRow | undefined> {
  return first((await db.query(`select ${INVITATION_COLUMNS} from invitations where id = $1`, [id])).rows, INVITATION_DATES);
}

export async function listInvitations(db: Querier): Promise<readonly InvitationRow[]> {
  return (await db.query(`select ${INVITATION_COLUMNS} from invitations where kind = 'invite' order by created_at desc`)).rows.map((row) =>
    withDates<InvitationRow>(row, INVITATION_DATES),
  );
}

export async function acceptInvitation(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update invitations set accepted_at = $2 where id = $1', [id, at]);
}

export async function revokeInvitation(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update invitations set revoked_at = $2 where id = $1', [id, at]);
}

/** Closes every open reset for a user, so a new reset link is the only one that works. */
export async function revokeOpenResetsOf(db: Querier, userId: string, at: Date): Promise<void> {
  await db.query("update invitations set revoked_at = $2 where kind = 'reset' and user_id = $1 and accepted_at is null and revoked_at is null", [userId, at]);
}

// ---- device tokens -------------------------------------------------------------------------

export async function insertToken(
  db: Querier,
  input: { readonly id: string; readonly userId: string; readonly tokenHash: string; readonly deviceName: string; readonly at: Date },
): Promise<void> {
  await db.query('insert into device_tokens (id, user_id, token_hash, device_name, created_at, last_used_at) values ($1, $2, $3, $4, $5, $5)', [
    input.id,
    input.userId,
    input.tokenHash,
    input.deviceName,
    input.at,
  ]);
}

/** The token row and its user in one round trip: what every authenticated request costs. */
export async function tokenByHash(db: Querier, tokenHash: string): Promise<{ readonly token: TokenRow; readonly user: UserRow } | undefined> {
  const rows = (
    await db.query(
      `select t.id, t.user_id as "userId", t.token_hash as "tokenHash", t.device_name as "deviceName", t.created_at as "createdAt", t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt",
              u.email as "u_email", u.email_lower as "u_emailLower", u.display_name as "u_displayName", u.server_admin as "u_serverAdmin", u.created_at as "u_createdAt", u.disabled_at as "u_disabledAt"
       from device_tokens t join users u on u.id = t.user_id where t.token_hash = $1`,
      [tokenHash],
    )
  ).rows;
  const row = rows[0];
  if (row === undefined) return undefined;
  const user: Raw = { id: row.userId };
  const token: Raw = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('u_')) user[key.slice(2)] = value;
    else token[key] = value;
  }
  return { token: withDates<TokenRow>(token, TOKEN_DATES), user: withDates<UserRow>(user, USER_DATES) };
}

export async function touchToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update device_tokens set last_used_at = $2 where id = $1', [id, at]);
}

export async function revokeToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update device_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [id, at]);
}

/** Revokes every live token of a user except `exceptId` (the device doing the changing). */
export async function revokeTokensOfUser(db: Querier, userId: string, at: Date, exceptId?: string): Promise<void> {
  await db.query('update device_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null and ($3::text is null or id <> $3)', [userId, at, exceptId ?? null]);
}

export async function tokensOfUser(db: Querier, userId: string): Promise<readonly TokenRow[]> {
  return (await db.query(`select ${TOKEN_COLUMNS} from device_tokens where user_id = $1 and revoked_at is null order by created_at`, [userId])).rows.map((row) =>
    withDates<TokenRow>(row, TOKEN_DATES),
  );
}

export async function deleteToken(db: Querier, id: string): Promise<void> {
  await db.query('delete from device_tokens where id = $1', [id]);
}

/** The daily sweep (§3.5): expired by idleness, by age, or revoked more than a day ago. */
export async function deleteExpiredTokens(db: Querier, input: { readonly idleBefore: Date; readonly createdBefore: Date; readonly revokedBefore: Date }): Promise<number> {
  const result = await db.query('delete from device_tokens where last_used_at < $1 or created_at < $2 or revoked_at < $3', [input.idleBefore, input.createdBefore, input.revokedBefore]);
  return result.rowCount ?? 0;
}

// ---- OIDC flows ----------------------------------------------------------------------------

export async function insertFlow(
  db: Querier,
  input: {
    readonly id: string;
    readonly codeChallenge: string;
    readonly loopbackPort: number;
    readonly deviceName: string;
    readonly state: string;
    readonly nonce: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    'insert into oidc_flows (id, code_challenge, loopback_port, device_name, state, nonce, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [input.id, input.codeChallenge, input.loopbackPort, input.deviceName, input.state, input.nonce, input.createdAt, input.expiresAt],
  );
}

export async function flowById(db: Querier, id: string): Promise<FlowRow | undefined> {
  return first((await db.query(`select ${FLOW_COLUMNS} from oidc_flows where id = $1`, [id])).rows, FLOW_DATES);
}

export async function flowByState(db: Querier, state: string): Promise<FlowRow | undefined> {
  return first((await db.query(`select ${FLOW_COLUMNS} from oidc_flows where state = $1`, [state])).rows, FLOW_DATES);
}

/** Records the IdP's answer: which user the flow resolved to and the one-time grant's hash. */
export async function grantFlow(db: Querier, id: string, grantHash: string, userId: string): Promise<void> {
  await db.query('update oidc_flows set grant_hash = $2, user_id = $3 where id = $1', [id, grantHash, userId]);
}

export async function deleteFlow(db: Querier, id: string): Promise<void> {
  await db.query('delete from oidc_flows where id = $1', [id]);
}

export async function deleteExpiredFlows(db: Querier, now: Date): Promise<number> {
  return (await db.query('delete from oidc_flows where expires_at < $1', [now])).rowCount ?? 0;
}
```

- [ ] **Step 3: `guard.ts` and the hook in `module.ts`**

`packages/server/src/identity/guard.ts`:

```ts
/**
 * The guard other modules use (identity spec §3.2). One `onRequest` hook parses the header when
 * present and leaves `request.caller` undefined when absent; the two `preHandler`s turn absence
 * into `identity-unauthenticated` / `identity-forbidden`. Nothing else in the server reads
 * `Authorization`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import type { IdentityEnv, IdentitySettings } from './env.js';
import { forbidden, unauthenticated, userDisabled } from './errors.js';
import * as repo from './repo.js';
import { bearerToken, hashToken } from './tokens.js';

export interface Caller {
  readonly id: string;
  readonly email: string;
  readonly serverAdmin: boolean;
  readonly tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

/** `last_used_at` is written at most this often per token (§3.1), so a busy client is one update a minute. */
export const TOUCH_EVERY_MS = 60_000;

export function isTokenExpired(token: { readonly createdAt: string; readonly lastUsedAt: string }, now: Date, settings: IdentitySettings): boolean {
  return now.getTime() - Date.parse(token.lastUsedAt) > settings.tokenIdleMs || now.getTime() - Date.parse(token.createdAt) > settings.tokenMaxMs;
}

/** Hex digests of equal length compared in constant time (spec §12), even though the lookup already keyed on the hash. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticate(env: IdentityEnv): onRequestAsyncHookHandler {
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return; // no header (or not a device token): the preHandlers decide
    const hash = hashToken(token);
    const found = await repo.tokenByHash(env.ctx.db, hash);
    if (found === undefined || !sameHash(found.token.tokenHash, hash) || found.token.revokedAt !== null) throw unauthenticated();
    const now = env.now();
    if (isTokenExpired(found.token, now, env.settings)) {
      await repo.deleteToken(env.ctx.db, found.token.id); // lazy expiry (§3.5); the daily sweep gets the rest
      throw unauthenticated();
    }
    if (found.user.disabledAt !== null) throw userDisabled();
    if (now.getTime() - Date.parse(found.token.lastUsedAt) >= TOUCH_EVERY_MS) await repo.touchToken(env.ctx.db, found.token.id, now);
    request.caller = { id: found.user.id, email: found.user.email, serverAdmin: found.user.serverAdmin, tokenId: found.token.id };
  };
}

export const requireUser: preHandlerHookHandler = (request, _reply, done) => {
  done(request.caller === undefined ? unauthenticated() : undefined);
};

export const requireServerAdmin: preHandlerHookHandler = (request, _reply, done) => {
  if (request.caller === undefined) done(unauthenticated());
  else done(request.caller.serverAdmin ? undefined : forbidden());
};
```

In `packages/server/src/identity/module.ts`, replace `void env; // Tasks 4–7 …` with:

```ts
      app.addHook('onRequest', authenticate(env));
      // Tasks 5–7 register the route groups and the sweep after this line.
```

and add `import { authenticate } from './guard.js';`.

- [ ] **Step 4: Write the integration tests**

`packages/server/test/integration/identity/repo.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret, newId } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

describeDb('identity repo', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('keys users on the lower-cased email and keeps the typed one for display', async () => {
    const user = await repo.insertUser(h.db, { id: newId(), email: 'Alice@Example.com', displayName: 'Alice', serverAdmin: false, at: h.clock.now });
    expect(user).toMatchObject({ email: 'Alice@Example.com', emailLower: 'alice@example.com', disabledAt: null });
    expect(user.createdAt).toBe('2026-09-24T12:00:00.000Z');
    expect((await repo.findUserByEmail(h.db, 'alice@example.com'))?.id).toBe(user.id);
    await expect(repo.insertUser(h.db, { id: newId(), email: 'ALICE@example.com', displayName: 'A', serverAdmin: false, at: h.clock.now })).rejects.toThrow();
  });

  it('allows one open invite per email, and a second once the first is revoked or accepted', async () => {
    const invite = (secretHash: string) =>
      repo.insertInvitation(h.db, { id: newId(), kind: 'invite', email: 'bob@example.com', userId: null, secretHash, serverAdmin: false, createdBy: null, createdAt: h.clock.now, expiresAt: new Date(h.clock.now.getTime() + 1000) });
    const first = await invite(mintSecret().hash);
    await expect(invite(mintSecret().hash)).rejects.toThrow();
    await repo.revokeInvitation(h.db, first.id, h.clock.now);
    const second = await invite(mintSecret().hash);
    expect((await repo.openInvitationByEmail(h.db, 'bob@example.com', h.clock.now))?.id).toBe(second.id);
    expect(await repo.openInvitationByEmail(h.db, 'bob@example.com', new Date(h.clock.now.getTime() + 2000))).toBeUndefined();
  });

  it('joins a token to its user, revokes all but one device, and sweeps the expired', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const second = await signedInUser(h, { email: 'carol@example.com' });
    const { hash } = { hash: (await repo.tokensOfUser(h.db, alice.user.id))[0]!.tokenHash };
    expect((await repo.tokenByHash(h.db, hash))?.user.email).toBe('alice@example.com');
    await repo.insertToken(h.db, { id: newId(), userId: alice.user.id, tokenHash: mintSecret().hash, deviceName: 'phone', at: h.clock.now });
    await repo.revokeTokensOfUser(h.db, alice.user.id, h.clock.now, alice.tokenId);
    expect((await repo.tokensOfUser(h.db, alice.user.id)).map((t) => t.id)).toEqual([alice.tokenId]);
    expect(await repo.tokensOfUser(h.db, second.user.id)).toHaveLength(1);
    const later = new Date(h.clock.now.getTime() + 10_000);
    expect(await repo.deleteExpiredTokens(h.db, { idleBefore: later, createdBefore: new Date(0), revokedBefore: new Date(0) })).toBe(3);
  });

  it('reports sign-in methods per user, including none', async () => {
    const local = await signedInUser(h, { email: 'a@example.com', password: 'p'.repeat(12) });
    const none = await signedInUser(h, { email: 'b@example.com' });
    await repo.insertOidcIdentity(h.db, { issuer: 'https://idp.test', subject: 'sub-1', userId: none.user.id, at: h.clock.now });
    const methods = await repo.signInMethodsOf(h.db, [local.user.id, none.user.id]);
    expect(methods.get(local.user.id)).toEqual({ local: true, oidc: [] });
    expect(methods.get(none.user.id)).toEqual({ local: false, oidc: [{ issuer: 'https://idp.test' }] });
    expect((await repo.signInMethodsOf(h.db, [])).size).toBe(0);
  });
});
```

`packages/server/test/integration/identity/guard.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerModule } from '../../../src/context.js';
import { requireServerAdmin, requireUser } from '../../../src/identity/guard.js';
import * as repo from '../../../src/identity/repo.js';
import { mintToken } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const DAY = 24 * 60 * 60 * 1000;

/** A module registered after identity, the way teams-access will be: it only reads request.caller. */
const probeModule: ServerModule = {
  name: 'teams-access',
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
  register: async (app) => {
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/user', { preHandler: requireUser }, async (request) => ({ caller: request.caller }));
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/admin', { preHandler: requireServerAdmin }, async (request) => ({ id: request.caller?.id }));
  },
};

describeDb('the caller guard (§3.2)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness({ modules: [probeModule] });
  });
  afterEach(() => h.close());

  const get = (url: string, authorization?: string) =>
    h.app.inject({ method: 'GET', url, ...(authorization !== undefined ? { headers: { authorization } } : {}) });

  it('answers 401 identity-unauthenticated without a header, with garbage, and with an unknown token', async () => {
    for (const header of [undefined, 'Basic abc', `Bearer ${mintToken().token}`]) {
      const res = await get('/api/v1/probe/user', header);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'identity-unauthenticated', message: 'Sign in to continue.' });
    }
  });

  it('sets request.caller for a later module from a valid token, and gates admin routes', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const ok = await get('/api/v1/probe/user', alice.headers.authorization);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ caller: { id: alice.user.id, email: 'alice@example.com', serverAdmin: false, tokenId: alice.tokenId } });
    const forbidden = await get('/api/v1/probe/admin', alice.headers.authorization);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ code: string }>().code).toBe('identity-forbidden');
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    expect((await get('/api/v1/probe/admin', root.headers.authorization)).statusCode).toBe(200);
  });

  it('answers 403 identity-user-disabled for a valid token of a disabled user', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', disabled: true });
    const res = await get('/api/v1/probe/user', alice.headers.authorization);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('identity-user-disabled');
  });

  it('expires a token idle for 30 days or older than 180, deleting the row lazily', async () => {
    const idle = await signedInUser(h, { email: 'idle@example.com' });
    h.clock.advance(31 * DAY);
    expect((await get('/api/v1/probe/user', idle.headers.authorization)).statusCode).toBe(401);
    expect(await repo.tokensOfUser(h.db, idle.user.id)).toHaveLength(0);

    const old = await signedInUser(h, { email: 'old@example.com' });
    for (let day = 0; day < 181; day += 1) {
      h.clock.advance(DAY); // used daily, so never idle
      const res = await get('/api/v1/probe/user', old.headers.authorization);
      if (day < 180) expect(res.statusCode).toBe(200);
      else expect(res.statusCode).toBe(401);
    }
  });

  it('writes lastUsedAt at most once a minute', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const before = (await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt;
    h.clock.advance(30_000);
    await get('/api/v1/probe/user', alice.headers.authorization);
    expect((await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt).toBe(before);
    h.clock.advance(31_000);
    await get('/api/v1/probe/user', alice.headers.authorization);
    expect((await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt).toBe(h.clock.now.toISOString());
  });
});
```

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/identity`
Expected: PASS (4 repo, 5 guard, plus Task 2's file).

- [ ] **Step 5: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src/identity packages/server/test/helpers/identity.ts packages/server/test/integration/identity
git commit -m "feat(server): identity repository and the request.caller guard

One onRequest hook parses the bearer token into request.caller and two
preHandlers turn its absence into a problem, so no later module ever
reads the Authorization header. Expiry is lazy on use; last_used_at is
written at most once a minute so a busy client does not become a write
per request."
```

---

### Task 5: Local sign-in, sign-out, `/me` and the token sweep

**Files:**
- Create: `packages/server/src/identity/sessions.ts`, `packages/server/src/identity/routes/auth-local.ts`,
  `packages/server/src/identity/routes/me.ts`, `packages/server/test/integration/identity/auth-local.test.ts`,
  `packages/server/test/integration/identity/me.test.ts`
- Modify: `packages/server/src/identity/module.ts`

**Interfaces:**
- Produces: `publicUser(user: UserRow): ServerUser`, `issueToken(env, user, deviceName) → Promise<SignInResponse>`,
  `emailLower(email)`, `sweepExpired(env) → Promise<void>`; routes `POST /auth/local/sign-in`,
  `POST /auth/sign-out`, `GET /me`, `POST /me/password`, `GET /me/devices`, `DELETE /me/devices/:id`;
  `authLocalRoutes(env)`, `meRoutes(env)`.
- Consumes: Tasks 1–4.

- [ ] **Step 1: Write the failing integration tests**

`packages/server/test/integration/identity/auth-local.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import * as repo from '../../../src/identity/repo.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, OIDC_ENV, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DEVICE = { name: 'MacBook of Alice' };

describeDb('POST /auth/local/sign-in and /auth/sign-out (§3.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  const signIn = (email: string, password: string, ip = '10.0.0.1') =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email, password, device: DEVICE }, remoteAddress: ip });

  it('answers 201 with a token and the user; the token then authenticates', async () => {
    const alice = await signedInUser(h, { email: 'Alice@example.com', password: PASSWORD });
    const res = await signIn('alice@EXAMPLE.com', PASSWORD);
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { id: string; email: string } }>();
    expect(body.token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(body.user).toEqual({ id: alice.user.id, email: 'Alice@example.com', displayName: 'Alice', serverAdmin: false });
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    expect((await repo.tokensOfUser(h.db, alice.user.id)).map((t) => t.deviceName)).toContain('MacBook of Alice');
  });

  it('says the same thing for an unknown email and a wrong password', async () => {
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const unknown = await signIn('nobody@example.com', PASSWORD);
    const wrong = await signIn('alice@example.com', 'not the password');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect(unknown.json<{ code: string }>().code).toBe('identity-invalid-credentials');
  });

  it('distinguishes a disabled user only after a correct password', async () => {
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD, disabled: true });
    expect((await signIn('alice@example.com', 'wrong')).json<{ code: string }>().code).toBe('identity-invalid-credentials');
    expect((await signIn('alice@example.com', PASSWORD)).json<{ code: string }>().code).toBe('identity-user-disabled');
  });

  it('answers 404 identity-method-disabled when local auth is off', async () => {
    await h.close();
    h = await identityHarness({ env: { WIREBENCH_SERVER_LOCAL_AUTH: 'false', ...OIDC_ENV }, provider: { issuer: 'https://idp.test', authorizationUrl: () => 'https://idp.test/a', exchange: () => Promise.reject(new Error('unused')) } });
    const res = await signIn('alice@example.com', PASSWORD);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('identity-method-disabled');
  });

  it('rate-limits the eleventh attempt from one address within a minute, with Retry-After (§3.6)', async () => {
    for (let i = 0; i < 10; i += 1) expect((await signIn(`u${i}@example.com`, 'x'.repeat(12))).statusCode).toBe(401);
    const refused = await signIn('u11@example.com', 'x'.repeat(12));
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ code: string }>().code).toBe('identity-rate-limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await signIn('other@example.com', 'x'.repeat(12), '10.0.0.2')).statusCode).toBe(401); // another address
    h.clock.advance(60_000);
    expect((await signIn('u11@example.com', 'x'.repeat(12))).statusCode).toBe(401);
  });

  it('rate-limits one email across addresses', async () => {
    for (let i = 0; i < 10; i += 1) await signIn('alice@example.com', 'x'.repeat(12), `10.0.1.${i}`);
    expect((await signIn('ALICE@example.com', 'x'.repeat(12), '10.0.2.1')).statusCode).toBe(429);
  });

  it('rehashes a password stored with older scrypt parameters on a successful sign-in', async () => {
    const { hashPassword } = await import('../../../src/identity/passwords.js');
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    await repo.upsertCredential(h.db, alice.user.id, await hashPassword(PASSWORD, { N: 2 ** 14, r: 8, p: 1, keylen: 32 }), h.clock.now);
    expect((await signIn('alice@example.com', PASSWORD)).statusCode).toBe(201);
    expect((await repo.credentialOf(h.db, alice.user.id))?.passwordHash).toMatch(/^scrypt\$32768\$/);
  });

  it('sign-out revokes the calling token and nothing else', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const second = await signedInUser(h, { email: 'alice2@example.com' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: alice.headers });
    expect(res.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: second.headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out' })).statusCode).toBe(401);
  });

  it('rejects a malformed body as invalid-request without touching the limiter', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('invalid-request');
  });
});
```

`packages/server/test/integration/identity/me.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { sweepExpired } from '../../../src/identity/sessions.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

describeDb('/me (§3.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('GET /me reports the user and the methods they can sign in with', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD, serverAdmin: true });
    await repo.insertOidcIdentity(h.db, { issuer: 'https://idp.test', subject: 's', userId: alice.user.id, at: h.clock.now });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers });
    expect(res.json()).toEqual({
      user: { id: alice.user.id, email: 'alice@example.com', displayName: 'alice', serverAdmin: true },
      methods: { local: true, oidc: [{ issuer: 'https://idp.test' }] },
    });
  });

  it('POST /me/password needs the current password when one exists, enforces the minimum, and revokes the other devices', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const phone = await signedInUser(h, { email: 'alice@example.com' }).catch(() => undefined); // same email: insertUser refuses
    expect(phone).toBeUndefined();
    const { mintToken, newId } = await import('../../../src/identity/tokens.js');
    const other = mintToken();
    await repo.insertToken(h.db, { id: newId(), userId: alice.user.id, tokenHash: other.hash, deviceName: 'phone', at: h.clock.now });
    const post = (payload: object) => h.app.inject({ method: 'POST', url: '/api/v1/me/password', headers: alice.headers, payload });
    expect((await post({ newPassword: 'n'.repeat(12) })).json<{ code: string }>().code).toBe('identity-invalid-credentials');
    expect((await post({ currentPassword: 'wrong', newPassword: 'n'.repeat(12) })).json<{ code: string }>().code).toBe('identity-invalid-credentials');
    expect((await post({ currentPassword: PASSWORD, newPassword: 'short' })).json<{ code: string }>().code).toBe('identity-password-too-short');
    expect((await post({ currentPassword: PASSWORD, newPassword: 'n'.repeat(12) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(401);
    const signIn = await h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'alice@example.com', password: 'n'.repeat(12), device: { name: 'x' } } });
    expect(signIn.statusCode).toBe(201);
  });

  it('POST /me/password sets a first password for an OIDC-only user without a current one', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/me/password', headers: alice.headers, payload: { newPassword: 'n'.repeat(12) } });
    expect(res.statusCode).toBe(204);
    expect(await repo.credentialOf(h.db, alice.user.id)).toBeDefined();
  });

  it('GET /me/devices lists live tokens with `current`, and DELETE revokes one of the caller’s own', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', deviceName: 'laptop' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const { mintToken, newId } = await import('../../../src/identity/tokens.js');
    const phoneId = newId();
    await repo.insertToken(h.db, { id: phoneId, userId: alice.user.id, tokenHash: mintToken().hash, deviceName: 'phone', at: h.clock.now });
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/me/devices', headers: alice.headers });
    expect(list.json<{ name: string; current: boolean }[]>().map((d) => [d.name, d.current])).toEqual([['laptop', true], ['phone', false]]);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/me/devices/${bob.tokenId}`, headers: alice.headers })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/me/devices/${phoneId}`, headers: alice.headers })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me/devices', headers: alice.headers })).json()).toHaveLength(1);
  });

  it('the sweep deletes tokens idle 30 days, older than 180 days, or revoked over a day ago', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    await repo.revokeToken(h.db, bob.tokenId, h.clock.now);
    h.clock.advance(2 * DAY);
    const carol = await signedInUser(h, { email: 'carol@example.com' });
    h.clock.advance(29 * DAY);
    await sweepExpired({ ctx: { db: h.db } as never, settings: { tokenIdleMs: 30 * DAY, tokenMaxMs: 180 * DAY } as never, now: () => h.clock.now } as never);
    expect(await repo.tokensOfUser(h.db, alice.user.id)).toHaveLength(0);
    expect((await h.db.query('select count(*)::int as n from device_tokens where user_id = $1', [bob.user.id])).rows[0]).toEqual({ n: 0 });
    expect(await repo.tokensOfUser(h.db, carol.user.id)).toHaveLength(1);
  });
});
```

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/identity/auth-local.test.ts packages/server/test/integration/identity/me.test.ts`
Expected: FAIL — 404 not-found for every route.

- [ ] **Step 2: `sessions.ts`**

```ts
/** Minting a session for a user who just proved who they are, and the sweep that ends stale ones. */
import { MAX_DEVICE_NAME_LENGTH, type ServerUser, type SignInResponse } from '@wirebench/engine';
import type { IdentityEnv } from './env.js';
import * as repo from './repo.js';
import { mintToken, newId } from './tokens.js';

export const emailLower = (email: string): string => email.trim().toLowerCase();

export function publicUser(user: repo.UserRow): ServerUser {
  return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin };
}

/** The token is returned here and nowhere else (§3.5); the row keeps only its hash. */
export async function issueToken(env: IdentityEnv, user: repo.UserRow, deviceName: string): Promise<SignInResponse> {
  const { token, hash } = mintToken();
  await repo.insertToken(env.ctx.db, {
    id: newId(),
    userId: user.id,
    tokenHash: hash,
    deviceName: deviceName.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || 'device',
    at: env.now(),
  });
  return { token, user: publicUser(user) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The daily sweep (§3.5): what lazy expiry never touched because nobody used it again. */
export async function sweepExpired(env: IdentityEnv): Promise<void> {
  const now = env.now().getTime();
  await repo.deleteExpiredTokens(env.ctx.db, {
    idleBefore: new Date(now - env.settings.tokenIdleMs),
    createdBefore: new Date(now - env.settings.tokenMaxMs),
    revokedBefore: new Date(now - DAY_MS),
  });
  await repo.deleteExpiredFlows(env.ctx.db, new Date(now));
}
```

- [ ] **Step 3: `routes/auth-local.ts`**

```ts
import { localSignInRequestSchema, signInResponseSchema, type LocalSignInRequest } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, userDisabled } from '../errors.js';
import { requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { emailKey, ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { emailLower, issueToken } from '../sessions.js';

/**
 * Verified instead of a credential when the email is unknown, so an unknown email costs the
 * same scrypt as a wrong password and the two are indistinguishable by timing as well as by
 * message (§6). Computed once, lazily.
 */
let decoy: Promise<string> | undefined;
const decoyHash = (): Promise<string> => (decoy ??= hashPassword('wirebench-decoy-never-matches'));

export const authLocalRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/local/sign-in',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request), emailKey(request)])],
        schema: { body: jsonSchema(localSignInRequestSchema, { io: 'input' }), response: { 201: jsonSchema(signInResponseSchema) } },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as LocalSignInRequest;
        const user = await repo.findUserByEmail(env.ctx.db, emailLower(body.email));
        const credential = user === undefined ? undefined : await repo.credentialOf(env.ctx.db, user.id);
        const verdict = await verifyPassword(body.password, credential?.passwordHash ?? (await decoyHash()));
        if (user === undefined || credential === undefined || !verdict.ok) throw invalidCredentials();
        if (user.disabledAt !== null) throw userDisabled();
        if (verdict.rehash) await repo.upsertCredential(env.ctx.db, user.id, await hashPassword(body.password), env.now());
        return reply.code(201).send(await issueToken(env, user, body.device.name));
      },
    );

    app.post('/auth/sign-out', { preHandler: requireUser }, async (request, reply) => {
      await repo.revokeToken(env.ctx.db, request.caller!.tokenId, env.now());
      return reply.code(204).send();
    });
  };
```

- [ ] **Step 4: `routes/me.ts`**

```ts
import {
  devicesResponseSchema,
  identityIdParamsSchema,
  meResponseSchema,
  MIN_PASSWORD_LENGTH,
  passwordChangeRequestSchema,
  type PasswordChangeRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, notFound, passwordTooShort, unauthenticated } from '../errors.js';
import { isTokenExpired, requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import * as repo from '../repo.js';
import { publicUser } from '../sessions.js';

export const meRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get('/me', { preHandler: requireUser, schema: { response: { 200: jsonSchema(meResponseSchema) } } }, async (request) => {
      const caller = request.caller!;
      const user = await repo.findUserById(env.ctx.db, caller.id);
      if (user === undefined) throw unauthenticated();
      const methods = (await repo.signInMethodsOf(env.ctx.db, [user.id])).get(user.id)!;
      return { user: publicUser(user), methods };
    });

    app.post(
      '/me/password',
      { preHandler: requireUser, schema: { body: jsonSchema(passwordChangeRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const caller = request.caller!;
        const body = request.body as PasswordChangeRequest;
        if (body.newPassword.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
        const credential = await repo.credentialOf(env.ctx.db, caller.id);
        if (credential !== undefined) {
          const current = body.currentPassword === undefined ? undefined : await verifyPassword(body.currentPassword, credential.passwordHash);
          if (current?.ok !== true) throw invalidCredentials();
        }
        const hash = await hashPassword(body.newPassword);
        const now = env.now();
        await env.ctx.db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
        });
        return reply.code(204).send();
      },
    );

    app.get('/me/devices', { preHandler: requireUser, schema: { response: { 200: jsonSchema(devicesResponseSchema) } } }, async (request) => {
      const caller = request.caller!;
      const now = env.now();
      return (await repo.tokensOfUser(env.ctx.db, caller.id))
        .filter((token) => !isTokenExpired(token, now, env.settings))
        .map((token) => ({ id: token.id, name: token.deviceName, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, current: token.id === caller.tokenId }));
    });

    app.delete(
      '/me/devices/:id',
      { preHandler: requireUser, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const caller = request.caller!;
        const { id } = request.params as { id: string };
        const owned = (await repo.tokensOfUser(env.ctx.db, caller.id)).some((token) => token.id === id);
        if (!owned) throw notFound('Device');
        await repo.revokeToken(env.ctx.db, id, env.now());
        return reply.code(204).send();
      },
    );
  };
```

- [ ] **Step 5: Register the routes and the sweep in `module.ts`**

Replace the `// Tasks 5–7 register …` comment with:

```ts
      authLocalRoutes(env)(app);
      meRoutes(env)(app);
      // Tasks 6–7 register invitations, users, the invite page and OIDC here.

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepExpired(env).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
```

Add `const DAY_MS = 24 * 60 * 60 * 1000;` at module level and the imports of `authLocalRoutes`,
`meRoutes` and `sweepExpired`.

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/identity`
Expected: PASS (auth-local 9, me 5, plus the earlier files).

- [ ] **Step 6: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src/identity packages/server/test/integration/identity
git commit -m "feat(server): local sign-in, sign-out, /me and the daily token sweep

An unknown email and a wrong password answer with one body and cost one
scrypt each; changing a password revokes every other device; the sweep
removes what lazy expiry never saw again."
```

---

### Task 6: Invitations, users, password resets and the invitation page

**Files:**
- Create: `packages/server/src/identity/invitations.ts`, `packages/server/src/identity/invite-page.ts`,
  `packages/server/src/identity/routes/invitations.ts`, `packages/server/src/identity/routes/users.ts`,
  `packages/server/src/identity/routes/invite-page.ts`, `packages/server/test/unit/identity/invite-page.test.ts`,
  `packages/server/test/integration/identity/invitations.test.ts`, `packages/server/test/integration/identity/users.test.ts`
- Modify: `packages/server/src/context.ts:61-71` (`ServerModule.registerPublic`),
  `packages/server/src/server.ts` (register public routes at the root), `packages/server/src/identity/module.ts`

**Interfaces:**
- Produces: `ServerModule.registerPublic?(app, ctx)` — routes served at the root, outside `/api/v1`
  (the invitation page is `<publicUrl>/invite/<secret>`, §3.1); `createInvitation(env, { email, serverAdmin, createdBy })`,
  `createPasswordReset(env, user, createdBy)`, `openInvitationBySecret(env, secret)`,
  `lookupInvitation(env, secret)`, `acceptInvitation(env, request)`, `revokeOpenInvitation(env, id)`,
  `invitationSummary(row)`, `inviteUrl(env, secret)`; `renderInvitePage(input)`; routes of §3.1 for
  `/invitations*`, `/users*`, `/invite/:secret`.
- Consumes: Tasks 1–5; `ServerEvents` `'invitation.accepted'` (server-host).

- [ ] **Step 1: The host change — public routes**

`packages/server/src/context.ts`, in `ServerModule` after `migrationsDir`:

```ts
  /**
   * Routes served at the root, outside `/api/v1` and outside every module hook: a page a browser
   * opens from a link (identity's `/invite/:secret`). Most modules have none.
   */
  registerPublic?(app: FastifyInstance, ctx: ServerContext): Promise<void>;
```

`packages/server/src/server.ts`, after the `/api/v1` `app.register(...)` call and before `await app.ready()`:

```ts
  for (const module of options.modules) {
    if (module.registerPublic !== undefined) {
      await app.register(async (root) => {
        await module.registerPublic!(root, context);
      });
    }
  }
```

Add to `packages/server/test/unit/server.test.ts` (in `describe('buildServer')`):

```ts
  it('serves a module’s public routes at the root, outside /api/v1', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          register: () => Promise.resolve(),
          // eslint-disable-next-line @typescript-eslint/require-await -- registerPublic is async; this one has no await
          registerPublic: async (root) => {
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
            root.get('/page', async (_request, reply) => reply.type('text/html').send('<p>hi</p>'));
          },
        },
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/page' })).body).toBe('<p>hi</p>');
    expect((await app.inject({ method: 'GET', url: '/api/v1/page' })).statusCode).toBe(404);
    await app.close();
  });
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/server.test.ts` → PASS.

- [ ] **Step 2: Write the failing tests**

`packages/server/test/unit/identity/invite-page.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderInvitePage } from '../../../src/identity/invite-page.js';

describe('the invitation page (§3.1)', () => {
  it('tells an invited person what to do, with the server URL and the code, and escapes the email', () => {
    const html = renderInvitePage({ publicUrl: 'https://wirebench.test', state: 'open', email: 'a<b>@example.com', secret: 'S'.repeat(43) });
    expect(html).toContain('https://wirebench.test');
    expect(html).toContain('S'.repeat(43));
    expect(html).toContain('a&lt;b&gt;@example.com');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src=|href="http/);
  });
  it('renders the same page with the expired line when the invitation is closed, without a code', () => {
    const html = renderInvitePage({ publicUrl: 'https://wirebench.test', state: 'closed' });
    expect(html).toContain('This invitation has expired or was already used.');
    expect(html).not.toContain('invitation code');
  });
});
```

`packages/server/test/integration/identity/invitations.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, OIDC_ENV, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery';

describeDb('invitations (§3.1, §3.7)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeEach(async () => {
    h = await identityHarness();
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  });
  afterEach(() => h.close());

  const create = (payload: object, headers = admin.headers) => h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers, payload });
  const lookup = (secret: string, ip = '10.0.0.1') => h.app.inject({ method: 'GET', url: `/api/v1/invitations/lookup?secret=${secret}`, remoteAddress: ip });
  const accept = (payload: object) => h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload });
  const secretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

  it('an admin creates one; the URL carries the secret exactly once and the row only its hash', async () => {
    const res = await create({ email: 'Bob@example.com' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; email: string; url: string; expiresAt: string }>();
    expect(body.url).toMatch(/^https:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(h.clock.now.getTime() + 7 * DAY).toISOString());
    const row = await repo.invitationById(h.db, body.id);
    expect(row).toMatchObject({ email: 'Bob@example.com', serverAdmin: false, createdBy: admin.user.id });
    expect(row?.secretHash).not.toContain(secretOf(body.url).slice(0, 10));
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
    expect(list.json<{ id: string; createdBy: string }[]>()).toEqual([expect.objectContaining({ id: body.id, createdBy: admin.user.id })]);
    expect(JSON.stringify(list.json())).not.toContain(secretOf(body.url));
  });

  it('is refused for a non-admin, an existing user, and an email with an open invitation', async () => {
    const member = await signedInUser(h, { email: 'member@example.com' });
    expect((await create({ email: 'x@example.com' }, member.headers)).statusCode).toBe(403);
    expect((await create({ email: 'ROOT@example.com' })).json<{ code: string }>().code).toBe('identity-user-exists');
    await create({ email: 'bob@example.com' });
    expect((await create({ email: 'bob@example.com' })).json<{ code: string }>().code).toBe('identity-invitation-exists');
  });

  it('lookup answers the email and the methods for an open one and 404 for a bad, expired, revoked or used one', async () => {
    const { url, id } = (await create({ email: 'bob@example.com' })).json<{ url: string; id: string }>();
    const secret = secretOf(url);
    expect((await lookup(secret)).json()).toEqual({ email: 'bob@example.com', methods: { local: true, oidc: false } });
    expect((await lookup(mintSecret().secret)).json<{ code: string }>().code).toBe('identity-invitation-invalid');
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers })).statusCode).toBe(204);
    expect((await lookup(secret)).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers })).statusCode).toBe(404);
    const second = secretOf((await create({ email: 'bob@example.com' })).json<{ url: string }>().url);
    h.clock.advance(8 * DAY);
    expect((await lookup(second)).statusCode).toBe(404);
  });

  it('accept creates the user with a password and a token, marks the invitation, emits the event, and works once', async () => {
    const accepted = vi.fn();
    h.events.on('invitation.accepted', accepted);
    const { url, id } = (await create({ email: 'Bob@example.com', serverAdmin: true })).json<{ url: string; id: string }>();
    const res = await accept({ secret: secretOf(url), displayName: 'Bob', password: PASSWORD, device: { name: 'Bob laptop' } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { id: string; email: string; serverAdmin: boolean } }>();
    expect(body.user).toMatchObject({ email: 'Bob@example.com', displayName: 'Bob', serverAdmin: true });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } })).statusCode).toBe(200);
    expect((await repo.invitationById(h.db, id))?.acceptedAt).toBe(h.clock.now.toISOString());
    expect((await accept({ secret: secretOf(url), displayName: 'Bob', password: PASSWORD, device: { name: 'x' } })).statusCode).toBe(404);
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
    expect(list.json<{ acceptedAt?: string }[]>()[0]?.acceptedAt).toBe(h.clock.now.toISOString());
    expect(accepted).toHaveBeenCalledWith({ invitationId: id, userId: body.user.id });
  });

  it('accept enforces the password minimum, and answers method-disabled when local auth is off', async () => {
    const { url } = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    expect((await accept({ secret: secretOf(url), displayName: 'Bob', password: 'short', device: { name: 'x' } })).json<{ code: string }>().code).toBe('identity-password-too-short');
    await h.close();
    h = await identityHarness({ env: { WIREBENCH_SERVER_LOCAL_AUTH: 'false', ...OIDC_ENV }, provider: { issuer: 'https://idp.test', authorizationUrl: () => 'https://idp.test/a', exchange: () => Promise.reject(new Error('unused')) } });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const oidcOnly = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    expect((await lookup(secretOf(oidcOnly.url))).json()).toEqual({ email: 'bob@example.com', methods: { local: false, oidc: true } });
    expect((await accept({ secret: secretOf(oidcOnly.url), displayName: 'Bob', password: PASSWORD, device: { name: 'x' } })).json<{ code: string }>().code).toBe('identity-method-disabled');
  });

  it('rate-limits lookups per address', async () => {
    for (let i = 0; i < 10; i += 1) await lookup(mintSecret().secret);
    expect((await lookup(mintSecret().secret)).statusCode).toBe(429);
    expect((await lookup(mintSecret().secret, '10.0.0.9')).statusCode).toBe(404);
  });

  it('serves the invitation page at the root for an open code and the closed variant otherwise', async () => {
    const { url } = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    const open = await h.app.inject({ method: 'GET', url: `/invite/${secretOf(url)}` });
    expect(open.statusCode).toBe(200);
    expect(open.headers['content-type']).toContain('text/html');
    expect(open.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(open.body).toContain('bob@example.com');
    expect(open.body).toContain(secretOf(url));
    const closed = await h.app.inject({ method: 'GET', url: `/invite/${mintSecret().secret}` });
    expect(closed.statusCode).toBe(200);
    expect(closed.body).toContain('This invitation has expired or was already used.');
    expect((await h.app.inject({ method: 'GET', url: '/invite/not-a-secret' })).statusCode).toBe(404);
  });
});
```

`packages/server/test/integration/identity/users.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';

describeDb('users and password resets (§3.1)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeEach(async () => {
    h = await identityHarness();
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true, password: PASSWORD });
  });
  afterEach(() => h.close());

  const patch = (id: string, payload: object, headers = admin.headers) => h.app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers, payload });

  it('GET /users lists everyone with their methods and disabled state, admins only', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', disabled: true });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: bob.headers })).statusCode).toBe(403);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    expect(res.json()).toEqual([
      { id: bob.user.id, email: 'bob@example.com', displayName: 'bob', serverAdmin: false, disabledAt: h.clock.now.toISOString(), methods: { local: false, oidc: [] } },
      { id: admin.user.id, email: 'root@example.com', displayName: 'root', serverAdmin: true, methods: { local: true, oidc: [] } },
    ]);
  });

  it('PATCH toggles admin and disabled; disabling revokes every token; an admin cannot lock themselves out', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    expect((await patch(bob.user.id, { serverAdmin: true })).json<{ serverAdmin: boolean }>().serverAdmin).toBe(true);
    expect((await patch(bob.user.id, { disabled: true })).json<{ disabledAt?: string }>().disabledAt).toBe(h.clock.now.toISOString());
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bob.headers })).statusCode).toBe(403);
    expect((await repo.tokensOfUser(h.db, bob.user.id)).length).toBe(0);
    expect((await patch(bob.user.id, { disabled: false })).json<{ disabledAt?: string }>().disabledAt).toBeUndefined();
    expect((await patch(admin.user.id, { serverAdmin: false })).json<{ code: string }>().code).toBe('identity-self-change');
    expect((await patch(admin.user.id, { disabled: true })).json<{ code: string }>().code).toBe('identity-self-change');
    expect((await patch(admin.user.id, { serverAdmin: true })).statusCode).toBe(200);
    expect((await patch('01J8Z0000000000000000000ZZ', { disabled: true })).statusCode).toBe(404);
  });

  it('POST /users/:id/password-reset gives a one-time link; accepting it replaces the credential and revokes every token', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', password: 'old password 123' });
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/users/${bob.user.id}/password-reset`, headers: admin.headers });
    expect(res.statusCode).toBe(201);
    const { url } = res.json<{ url: string }>();
    const secret = url.slice(url.lastIndexOf('/') + 1);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/invitations/lookup?secret=${secret}` })).json<{ email: string }>().email).toBe('bob@example.com');
    const accept = await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload: { secret, displayName: 'Bob', password: PASSWORD, device: { name: 'x' } } });
    expect(accept.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bob.headers })).statusCode).toBe(401); // old device
    const signIn = (password: string) => h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'bob@example.com', password, device: { name: 'y' } } });
    expect((await signIn('old password 123')).statusCode).toBe(401);
    expect((await signIn(PASSWORD)).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload: { secret, displayName: 'Bob', password: PASSWORD, device: { name: 'x' } } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers })).json()).toEqual([]); // resets are not in the invite list
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/users/01J8Z0000000000000000000ZZ/password-reset', headers: admin.headers })).statusCode).toBe(404);
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/identity/invite-page.test.ts && nice pnpm vitest run --project server-integration packages/server/test/integration/identity/invitations.test.ts packages/server/test/integration/identity/users.test.ts`
Expected: FAIL.

- [ ] **Step 3: `invitations.ts`**

```ts
/**
 * Invitations and password resets (identity spec §2, §3.1, §3.7): one table, two kinds. The
 * secret is minted here, returned to the caller once inside the URL, and stored only hashed.
 * `createInvitation` is what both `POST /invitations` and `admin invite` run.
 */
import {
  MIN_PASSWORD_LENGTH,
  type InvitationAcceptRequest,
  type InvitationCreated,
  type InvitationLookupResponse,
  type InvitationSummary,
  type PasswordResetCreated,
  type SignInResponse,
} from '@wirebench/engine';
import type { IdentityEnv } from './env.js';
import { invitationExists, invitationInvalid, methodDisabled, passwordTooShort, userExists } from './errors.js';
import { hashPassword } from './passwords.js';
import * as repo from './repo.js';
import { emailLower, issueToken } from './sessions.js';
import { hashSecret, mintSecret, newId } from './tokens.js';

export const inviteUrl = (env: IdentityEnv, secret: string): string => `${env.ctx.config.publicUrl}/invite/${secret}`;

export interface CreateInvitationInput {
  readonly email: string;
  readonly serverAdmin: boolean;
  /** The admin's user id, or `null` from the console. */
  readonly createdBy: string | null;
}

export async function createInvitation(env: IdentityEnv, input: CreateInvitationInput): Promise<InvitationCreated> {
  const lower = emailLower(input.email);
  const now = env.now();
  if ((await repo.findUserByEmail(env.ctx.db, lower)) !== undefined) throw userExists();
  if ((await repo.openInvitationByEmail(env.ctx.db, lower, now)) !== undefined) throw invitationExists();
  const { secret, hash } = mintSecret();
  const row = await repo.insertInvitation(env.ctx.db, {
    id: newId(),
    kind: 'invite',
    email: input.email.trim(),
    userId: null,
    secretHash: hash,
    serverAdmin: input.serverAdmin,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + env.settings.invitationMs),
  });
  return { id: row.id, email: row.email, url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}

/** A `reset` row for an existing user; any earlier open reset for them is closed first. */
export async function createPasswordReset(env: IdentityEnv, user: repo.UserRow, createdBy: string): Promise<PasswordResetCreated> {
  const now = env.now();
  const { secret, hash } = mintSecret();
  const row = await env.ctx.db.transaction(async (tx) => {
    await repo.revokeOpenResetsOf(tx, user.id, now);
    return repo.insertInvitation(tx, {
      id: newId(),
      kind: 'reset',
      email: user.email,
      userId: user.id,
      secretHash: hash,
      serverAdmin: false,
      createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + env.settings.invitationMs),
    });
  });
  return { url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}

export function isOpen(row: repo.InvitationRow, now: Date): boolean {
  return row.acceptedAt === null && row.revokedAt === null && Date.parse(row.expiresAt) > now.getTime();
}

/** The row behind a secret while it is still usable; `undefined` for unknown, used, revoked or expired. */
export async function openInvitationBySecret(env: IdentityEnv, secret: string): Promise<repo.InvitationRow | undefined> {
  const row = await repo.invitationBySecretHash(env.ctx.db, hashSecret(secret));
  return row !== undefined && isOpen(row, env.now()) ? row : undefined;
}

export async function lookupInvitation(env: IdentityEnv, secret: string): Promise<InvitationLookupResponse> {
  const row = await openInvitationBySecret(env, secret);
  if (row === undefined) throw invitationInvalid();
  return { email: row.email, methods: { local: env.settings.local, oidc: env.settings.oidc !== undefined } };
}

/**
 * The local path in (§3.1): an `invite` creates the user and credential; a `reset` replaces the
 * credential of its user and revokes every device. Both mark the row accepted in the same
 * transaction, so a second use finds it closed.
 */
export async function acceptInvitation(env: IdentityEnv, input: InvitationAcceptRequest): Promise<SignInResponse> {
  if (!env.settings.local) throw methodDisabled();
  if (input.password.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
  const invitation = await openInvitationBySecret(env, input.secret);
  if (invitation === undefined) throw invitationInvalid();
  const hash = await hashPassword(input.password);
  const now = env.now();
  const outcome = await env.ctx.db.transaction(async (tx) => {
    if (invitation.kind === 'reset') {
      const user = invitation.userId === null ? undefined : await repo.findUserById(tx, invitation.userId);
      if (user === undefined || user.disabledAt !== null) throw invitationInvalid();
      await repo.upsertCredential(tx, user.id, hash, now);
      await repo.revokeTokensOfUser(tx, user.id, now);
      await repo.acceptInvitation(tx, invitation.id, now);
      return { user, created: false };
    }
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    const displayName = input.displayName.trim() || (invitation.email.split('@')[0] ?? invitation.email);
    const user = await repo.insertUser(tx, { id: newId(), email: invitation.email, displayName, serverAdmin: invitation.serverAdmin, at: now });
    await repo.upsertCredential(tx, user.id, hash, now);
    await repo.acceptInvitation(tx, invitation.id, now);
    return { user, created: true };
  });
  if (outcome.created) env.ctx.events.emit('invitation.accepted', { invitationId: invitation.id, userId: outcome.user.id });
  return issueToken(env, outcome.user, input.device.name);
}

/** Revokes an open `invite`; `false` when there is no such open invitation. */
export async function revokeOpenInvitation(env: IdentityEnv, id: string): Promise<boolean> {
  const row = await repo.invitationById(env.ctx.db, id);
  if (row === undefined || row.kind !== 'invite' || !isOpen(row, env.now())) return false;
  await repo.revokeInvitation(env.ctx.db, id, env.now());
  return true;
}

export function invitationSummary(row: repo.InvitationRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    serverAdmin: row.serverAdmin,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.acceptedAt !== null ? { acceptedAt: row.acceptedAt } : {}),
  };
}
```

- [ ] **Step 4: `invite-page.ts` and `routes/invite-page.ts`**

`packages/server/src/identity/invite-page.ts`:

```ts
/**
 * The one page the server renders (§3.1): static text, no script, no external asset, and the
 * only interpolated values are the server's own origin, the admin-typed email and the secret
 * that is already in the URL. Everything is escaped anyway.
 */
const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export type InvitePageInput =
  | { readonly publicUrl: string; readonly state: 'open'; readonly email: string; readonly secret: string }
  | { readonly publicUrl: string; readonly state: 'closed' };

/** Sent with every invitation page: the page needs nothing but its own inline style. */
export const INVITE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function renderInvitePage(input: InvitePageInput): string {
  const body =
    input.state === 'open'
      ? `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.publicUrl)}</code> as <strong>${escapeHtml(input.email)}</strong>.</p>
<ol>
<li>Install Wirebench.</li>
<li>Choose <em>Sign in…</em> from the command palette.</li>
<li>Enter the server URL: <code>${escapeHtml(input.publicUrl)}</code></li>
<li>Enter this invitation code: <code>${escapeHtml(input.secret)}</code></li>
</ol>`
      : `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.publicUrl)}</code>.</p>
<p>This invitation has expired or was already used. Ask a server admin for a new one.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wirebench Server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}code{word-break:break-all}</style>
</head><body><h1>Wirebench Server</h1>${body}</body></html>`;
}
```

`packages/server/src/identity/routes/invite-page.ts`:

```ts
import { SECRET_PATTERN } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { IdentityEnv } from '../env.js';
import { openInvitationBySecret } from '../invitations.js';
import { INVITE_PAGE_CSP, renderInvitePage } from '../invite-page.js';

/** `GET /invite/:secret` at the root (via `registerPublic`): a browser's landing from the link. */
export const invitePageRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get('/invite/:secret', async (request, reply) => {
      const { secret } = request.params as { secret: string };
      if (!SECRET_PATTERN.test(secret)) return reply.code(404).send({ code: 'not-found', message: 'No such page.' });
      const publicUrl = env.ctx.config.publicUrl;
      const row = await openInvitationBySecret(env, secret);
      const html = row === undefined ? renderInvitePage({ publicUrl, state: 'closed' }) : renderInvitePage({ publicUrl, state: 'open', email: row.email, secret });
      return reply
        .header('content-security-policy', INVITE_PAGE_CSP)
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(html);
    });
  };
```

- [ ] **Step 5: `routes/invitations.ts` and `routes/users.ts`**

`packages/server/src/identity/routes/invitations.ts`:

```ts
import {
  identityIdParamsSchema,
  invitationAcceptRequestSchema,
  invitationCreatedSchema,
  invitationCreateRequestSchema,
  invitationLookupQuerySchema,
  invitationLookupResponseSchema,
  invitationsResponseSchema,
  signInResponseSchema,
  type InvitationAcceptRequest,
  type InvitationCreateRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { notFound } from '../errors.js';
import { requireServerAdmin } from '../guard.js';
import { acceptInvitation, createInvitation, invitationSummary, lookupInvitation, revokeOpenInvitation } from '../invitations.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';

export const invitationRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/invitations',
      {
        preHandler: requireServerAdmin,
        schema: { body: jsonSchema(invitationCreateRequestSchema, { io: 'input' }), response: { 201: jsonSchema(invitationCreatedSchema) } },
      },
      async (request, reply) => {
        const body = request.body as InvitationCreateRequest;
        const created = await createInvitation(env, { email: body.email, serverAdmin: body.serverAdmin ?? false, createdBy: request.caller!.id });
        return reply.code(201).send(created);
      },
    );

    app.get('/invitations', { preHandler: requireServerAdmin, schema: { response: { 200: jsonSchema(invitationsResponseSchema) } } }, async () =>
      (await repo.listInvitations(env.ctx.db)).map(invitationSummary),
    );

    app.delete(
      '/invitations/:id',
      { preHandler: requireServerAdmin, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!(await revokeOpenInvitation(env, id))) throw notFound('Invitation');
        return reply.code(204).send();
      },
    );

    app.get(
      '/invitations/lookup',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: { querystring: jsonSchema(invitationLookupQuerySchema, { io: 'input' }), response: { 200: jsonSchema(invitationLookupResponseSchema) } },
      },
      async (request) => lookupInvitation(env, (request.query as { secret: string }).secret),
    );

    app.post(
      '/invitations/accept',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: { body: jsonSchema(invitationAcceptRequestSchema, { io: 'input' }), response: { 201: jsonSchema(signInResponseSchema) } },
      },
      async (request, reply) => reply.code(201).send(await acceptInvitation(env, request.body as InvitationAcceptRequest)),
    );
  };
```

`packages/server/src/identity/routes/users.ts`:

```ts
import {
  identityIdParamsSchema,
  passwordResetCreatedSchema,
  userPatchRequestSchema,
  usersResponseSchema,
  userSummarySchema,
  type UserPatchRequest,
  type UserSummary,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { notFound, selfChange } from '../errors.js';
import { requireServerAdmin } from '../guard.js';
import { createPasswordReset } from '../invitations.js';
import * as repo from '../repo.js';

async function summaries(env: IdentityEnv, users: readonly repo.UserRow[]): Promise<UserSummary[]> {
  const methods = await repo.signInMethodsOf(env.ctx.db, users.map((user) => user.id));
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    serverAdmin: user.serverAdmin,
    ...(user.disabledAt !== null ? { disabledAt: user.disabledAt } : {}),
    methods: methods.get(user.id)!,
  }));
}

export const userRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get('/users', { preHandler: requireServerAdmin, schema: { response: { 200: jsonSchema(usersResponseSchema) } } }, async () =>
      summaries(env, await repo.listUsers(env.ctx.db)),
    );

    app.patch(
      '/users/:id',
      {
        preHandler: requireServerAdmin,
        schema: {
          params: jsonSchema(identityIdParamsSchema, { io: 'input' }),
          body: jsonSchema(userPatchRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(userSummarySchema) },
        },
      },
      async (request) => {
        const { id } = request.params as { id: string };
        const body = request.body as UserPatchRequest;
        // §3.1: never a way to lock yourself out, whatever the rest of the patch says.
        if (id === request.caller!.id && (body.serverAdmin === false || body.disabled === true)) throw selfChange();
        const user = await repo.findUserById(env.ctx.db, id);
        if (user === undefined) throw notFound('User');
        const now = env.now();
        await env.ctx.db.transaction(async (tx) => {
          if (body.serverAdmin !== undefined) await repo.setServerAdmin(tx, id, body.serverAdmin);
          if (body.disabled === true) {
            await repo.setDisabled(tx, id, now);
            await repo.revokeTokensOfUser(tx, id, now); // disabling revokes every token (§3.1)
          } else if (body.disabled === false) {
            await repo.setDisabled(tx, id, null);
          }
        });
        return (await summaries(env, [(await repo.findUserById(env.ctx.db, id))!]))[0];
      },
    );

    app.post(
      '/users/:id/password-reset',
      {
        preHandler: requireServerAdmin,
        schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }), response: { 201: jsonSchema(passwordResetCreatedSchema) } },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = await repo.findUserById(env.ctx.db, id);
        if (user === undefined) throw notFound('User');
        return reply.code(201).send(await createPasswordReset(env, user, request.caller!.id));
      },
    );
  };
```

- [ ] **Step 6: Register in `module.ts`**

Replace `// Tasks 6–7 register …` with:

```ts
      invitationRoutes(env)(app);
      userRoutes(env)(app);
      // Task 7 registers the OIDC routes here.
```

Add `registerPublic` to the returned module, after `register`:

```ts
    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      invitePageRoutes(envFor(ctx))(root);
      await Promise.resolve();
    },
```

Both `register` and `registerPublic` need the same `IdentityEnv`, so hoist its construction into a
memoised `envFor(ctx)` closure inside `identityModule` (`let env: IdentityEnv | undefined;`
`const envFor = (ctx) => (env ??= { … })`), and have `register` use it too. The public page only
reads `env.settings`, `env.now` and the database, none of which depend on registration order.

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/identity packages/server/test/unit/server.test.ts && nice pnpm vitest run --project server-integration packages/server/test/integration/identity`
Expected: all PASS.

- [ ] **Step 7: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): invitations, password resets, user administration and the invitation page

One-time secrets live in the URL and nowhere else; a reset is an
invitation row of another kind so the accept path is shared; the page a
browser lands on is static text served at the root through the new
ServerModule.registerPublic, outside /api/v1 and every module hook."
```

---

### Task 7: OIDC — provider, linking rules, start / callback / complete, the fake issuer

**Files:**
- Create: `packages/server/src/identity/linking.ts`, `packages/server/src/identity/routes/auth-oidc.ts`,
  `packages/server/test/helpers/fake-oidc-issuer.ts`, `packages/server/test/unit/identity/linking.test.ts`,
  `packages/server/test/integration/identity/oidc.test.ts`
- Modify: `packages/server/src/identity/oidc.ts` (add `discoverOidc`), `packages/server/src/identity/invite-page.ts`
  (add `renderReturnPage`), `packages/server/src/identity/module.ts` (final form, Step 6)

**Interfaces:**
- Produces: `discoverOidc(settings: OidcSettings) → Promise<OidcProvider>`; `decideLink(facts) → LinkDecision`,
  `linkClaims(env, claims) → Promise<{ ok: true; user } | { ok: false; code }>`, `LinkRefusal`;
  `authOidcRoutes(env)` with `POST /auth/oidc/start`, `GET /auth/oidc/callback`, `POST /auth/oidc/complete`;
  `renderReturnPage(message)`; test helper `startFakeOidcIssuer()` → `{ url, clientId, clientSecret, nextUser, authorize, tokenRequests, close }`.
- Consumes: `OidcProvider`, `OidcClaims` (Task 2), `mintSecret`, `hashSecret`, `pkceChallenge`,
  `newId` (Task 3), `repo` flows (Task 4), `issueToken` (Task 5), `openInvitationByEmail` (Task 4).

- [ ] **Step 1: The pure linking table and its unit test**

`packages/server/test/unit/identity/linking.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideLink } from '../../../src/identity/linking.js';

describe('decideLink (§3.3)', () => {
  const user = { id: 'u1', disabled: false };
  const invitation = { id: 'i1', serverAdmin: true };
  it.each([
    ['1: a known (iss, sub) → that user', { identity: { userId: 'u9', disabled: false }, emailVerified: false }, { kind: 'existing', userId: 'u9' }],
    ['1: a known identity of a disabled user → disabled', { identity: { userId: 'u9', disabled: true }, emailVerified: true, user }, { kind: 'refuse', code: 'identity-user-disabled' }],
    ['2: unverified email → unverified, even with a user or an invitation', { emailVerified: false, user, invitation }, { kind: 'refuse', code: 'identity-email-unverified' }],
    ['3: a user with that email → link', { emailVerified: true, user, invitation }, { kind: 'link', userId: 'u1' }],
    ['3: that user disabled → disabled', { emailVerified: true, user: { id: 'u1', disabled: true } }, { kind: 'refuse', code: 'identity-user-disabled' }],
    ['4: an open invitation → create with its admin flag', { emailVerified: true, invitation }, { kind: 'create', invitationId: 'i1', serverAdmin: true }],
    ['5: nothing → not invited', { emailVerified: true }, { kind: 'refuse', code: 'identity-not-invited' }],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideLink(facts)).toEqual(expected);
  });
});
```

`packages/server/src/identity/linking.ts`:

```ts
/**
 * The linking rules of identity spec §3.3, as a pure decision over facts the repository looked
 * up, then the writes each decision needs. Rule order is the whole point: a known identity wins
 * before `email_verified` is even consulted, and an unverified email can never link or create.
 */
import type { IdentityEnv } from './env.js';
import type { OidcClaims } from './oidc.js';
import * as repo from './repo.js';
import { emailLower } from './sessions.js';
import { newId } from './tokens.js';

export type LinkRefusal = 'identity-user-disabled' | 'identity-email-unverified' | 'identity-not-invited';

export interface LinkFacts {
  readonly identity?: { readonly userId: string; readonly disabled: boolean };
  readonly emailVerified: boolean;
  readonly user?: { readonly id: string; readonly disabled: boolean };
  readonly invitation?: { readonly id: string; readonly serverAdmin: boolean };
}

export type LinkDecision =
  | { readonly kind: 'existing'; readonly userId: string }
  | { readonly kind: 'link'; readonly userId: string }
  | { readonly kind: 'create'; readonly invitationId: string; readonly serverAdmin: boolean }
  | { readonly kind: 'refuse'; readonly code: LinkRefusal };

export function decideLink(facts: LinkFacts): LinkDecision {
  if (facts.identity !== undefined) {
    return facts.identity.disabled ? { kind: 'refuse', code: 'identity-user-disabled' } : { kind: 'existing', userId: facts.identity.userId };
  }
  if (!facts.emailVerified) return { kind: 'refuse', code: 'identity-email-unverified' };
  if (facts.user !== undefined) {
    return facts.user.disabled ? { kind: 'refuse', code: 'identity-user-disabled' } : { kind: 'link', userId: facts.user.id };
  }
  if (facts.invitation !== undefined) return { kind: 'create', invitationId: facts.invitation.id, serverAdmin: facts.invitation.serverAdmin };
  return { kind: 'refuse', code: 'identity-not-invited' };
}

export type LinkOutcome = { readonly ok: true; readonly user: repo.UserRow } | { readonly ok: false; readonly code: LinkRefusal };

/** Looks up the facts for `claims`, decides, and writes what the decision needs. */
export async function linkClaims(env: IdentityEnv, claims: OidcClaims): Promise<LinkOutcome> {
  const db = env.ctx.db;
  const now = env.now();
  const identity = await repo.oidcIdentityOf(db, claims.issuer, claims.subject);
  const identityUser = identity === undefined ? undefined : await repo.findUserById(db, identity.userId);
  const lower = claims.email === undefined || claims.email.trim() === '' ? undefined : emailLower(claims.email);
  const byEmail = identity === undefined && lower !== undefined ? await repo.findUserByEmail(db, lower) : undefined;
  const invitation = identity === undefined && byEmail === undefined && lower !== undefined ? await repo.openInvitationByEmail(db, lower, now) : undefined;

  const decision = decideLink({
    ...(identityUser !== undefined ? { identity: { userId: identityUser.id, disabled: identityUser.disabledAt !== null } } : {}),
    emailVerified: claims.emailVerified === true && lower !== undefined,
    ...(byEmail !== undefined ? { user: { id: byEmail.id, disabled: byEmail.disabledAt !== null } } : {}),
    ...(invitation !== undefined ? { invitation: { id: invitation.id, serverAdmin: invitation.serverAdmin } } : {}),
  });

  switch (decision.kind) {
    case 'refuse':
      return { ok: false, code: decision.code };
    case 'existing':
      return { ok: true, user: identityUser! };
    case 'link':
      await repo.insertOidcIdentity(db, { issuer: claims.issuer, subject: claims.subject, userId: decision.userId, at: now });
      return { ok: true, user: byEmail! };
    case 'create': {
      const email = claims.email!;
      const displayName = claims.name?.trim() || (email.split('@')[0] ?? email);
      const user = await db.transaction(async (tx) => {
        const created = await repo.insertUser(tx, { id: newId(), email, displayName, serverAdmin: decision.serverAdmin, at: now });
        await repo.insertOidcIdentity(tx, { issuer: claims.issuer, subject: claims.subject, userId: created.id, at: now });
        await repo.acceptInvitation(tx, decision.invitationId, now);
        return created;
      });
      env.ctx.events.emit('invitation.accepted', { invitationId: decision.invitationId, userId: user.id });
      return { ok: true, user };
    }
  }
}
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/identity/linking.test.ts` → 7 passed.

- [ ] **Step 2: `discoverOidc` in `oidc.ts`**

Append to `packages/server/src/identity/oidc.ts` (keep the two interfaces from Task 2 above it):

```ts
import * as client from 'openid-client';

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`: an `http://` issuer, for the in-test one only. */
  readonly allowInsecure: boolean;
}

/**
 * Discovery at start-up (§4.1) and the two operations the routes need. `openid-client` performs
 * discovery over TLS, validates the ID token's signature against the issuer's JWKS and checks
 * `iss`, `aud`, `exp`, `nonce` and `state`; the configured issuer is pinned by construction
 * (§6). Nothing outside this file names the library (§15).
 */
export async function discoverOidc(settings: OidcSettings): Promise<OidcProvider> {
  const config = await client.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret,
    undefined,
    settings.allowInsecure ? { execute: [client.allowInsecureRequests] } : {},
  );
  const issuer = config.serverMetadata().issuer;
  return {
    issuer,
    authorizationUrl: ({ state, nonce, redirectUri }) =>
      client.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: settings.scopes.join(' '), state, nonce }).href,
    exchange: async ({ callbackUrl, state, nonce }) => {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, { expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (claims === undefined) throw new Error('the token response carried no ID token');
      return {
        issuer: claims.iss,
        subject: claims.sub,
        ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
        ...(typeof claims.email_verified === 'boolean' ? { emailVerified: claims.email_verified } : {}),
        ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      };
    },
  };
}
```

- [ ] **Step 3: The fake issuer**

`packages/server/test/helpers/fake-oidc-issuer.ts`:

```ts
/**
 * An OpenID provider in a few dozen lines: discovery, JWKS, `/authorize` (answers a code at
 * once, no login page), `/token` (client_secret_post, one use per code) and RS256 ID tokens
 * signed with node:crypto — enough for `openid-client` to really discover, exchange and verify.
 * `nextUser` decides whose claims the next code carries; omit `email` or `email_verified` to
 * test the refusals of spec §3.3.
 */
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIdpUser {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
}

export interface FakeOidcIssuer {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Whose claims the next authorization code carries. */
  nextUser(user: FakeIdpUser): void;
  /** Plays the browser: opens the authorization URL and returns the URL the IdP redirects back to. */
  authorize(authorizationUrl: string): Promise<URL>;
  readonly tokenRequests: number;
  close(): Promise<void>;
}

function base64url(value: object | Buffer): string {
  return (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const data = `${base64url({ alg: 'RS256', typ: 'JWT', kid })}.${base64url(payload)}`;
  return `${data}.${base64url(createSign('RSA-SHA256').update(data).sign(privateKey))}`;
}

export async function startFakeOidcIssuer(options: { readonly clientId?: string; readonly clientSecret?: string } = {}): Promise<FakeOidcIssuer> {
  const clientId = options.clientId ?? 'wirebench';
  const clientSecret = options.clientSecret ?? 'client-secret';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-idp-key';
  const jwk = publicKey.export({ format: 'jwk' });
  const codes = new Map<string, { user: FakeIdpUser; nonce: string; redirectUri: string }>();
  let pending: FakeIdpUser = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' };
  let tokenRequests = 0;
  let url = '';

  const server = createServer((request, response) => {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const target = new URL(request.url ?? '/', url);
    if (target.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        jwks_uri: `${url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
      return;
    }
    if (target.pathname === '/jwks') {
      json(200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
      return;
    }
    if (target.pathname === '/authorize') {
      const code = randomBytes(16).toString('hex');
      const redirectUri = target.searchParams.get('redirect_uri') ?? '';
      codes.set(code, { user: pending, nonce: target.searchParams.get('nonce') ?? '', redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', target.searchParams.get('state') ?? '');
      response.writeHead(302, { location: back.href });
      response.end();
      return;
    }
    if (target.pathname === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        tokenRequests += 1;
        const form = new URLSearchParams(body);
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (grant === undefined || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret || form.get('redirect_uri') !== grant.redirectUri) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(
          {
            iss: url,
            sub: grant.user.sub,
            aud: clientId,
            exp: now + 300,
            iat: now,
            nonce: grant.nonce,
            ...(grant.user.email !== undefined ? { email: grant.user.email } : {}),
            ...(grant.user.email_verified !== undefined ? { email_verified: grant.user.email_verified } : {}),
            ...(grant.user.name !== undefined ? { name: grant.user.name } : {}),
          },
          privateKey,
          kid,
        );
        json(200, { access_token: randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    clientId,
    clientSecret,
    nextUser: (user) => {
      pending = user;
    },
    authorize: async (authorizationUrl) => {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== 302 || location === null) throw new Error(`authorize answered ${response.status}`);
      return new URL(location);
    },
    get tokenRequests() {
      return tokenRequests;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 4: Write the failing integration test**

`packages/server/test/integration/identity/oidc.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInvitation } from '../../../src/identity/invitations.js';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret, pkceChallenge } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const VERIFIER = 'v'.repeat(43);
const PORT = 49152;

describeDb('OIDC sign-in (§3.1, §3.3, §13.3)', () => {
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
    h = await identityHarness({
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_OIDC_DISPLAY_NAME: 'Example IdP',
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
  });
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  /** Injects env through the harness's module: `createInvitation` wants an IdentityEnv-shaped object. */
  const env = () => ({ ctx: { db: h.db, config: { publicUrl: 'https://wirebench.test' }, events: h.events }, settings: { invitationMs: 7 * 86_400_000 }, now: () => h.clock.now }) as never;
  const start = () => h.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/start', payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: PORT } });
  const callback = async (authorizationUrl: string) => {
    const back = await idp.authorize(authorizationUrl);
    return h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
  };
  const loopback = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers['location']));
  const complete = (flowId: string, grant: string, codeVerifier = VERIFIER, ip = '10.0.0.1') =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/oidc/complete', payload: { flowId, grant, codeVerifier }, remoteAddress: ip });

  /** The whole happy path up to the grant. */
  const signInUpToGrant = async () => {
    const started = await start();
    expect(started.statusCode).toBe(201);
    const { flowId, authorizationUrl } = started.json<{ flowId: string; authorizationUrl: string }>();
    expect(authorizationUrl.startsWith(`${idp.url}/authorize?`)).toBe(true);
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe('https://wirebench.test/api/v1/auth/oidc/callback');
    const cb = await callback(authorizationUrl);
    return { flowId, cb };
  };

  it('meta reports OIDC with its display name', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).toMatchObject({ auth: { local: true, oidc: true, oidcDisplayName: 'Example IdP' } });
  });

  it('start → callback → complete creates an invited user with the invitation’s admin flag and links the identity', async () => {
    const accepted = vi.fn();
    h.events.on('invitation.accepted', accepted);
    const invitation = await createInvitation(env(), { email: 'Alice@example.com', serverAdmin: true, createdBy: null });
    idp.nextUser({ sub: 'sub-alice', email: 'alice@EXAMPLE.com', email_verified: true, name: 'Alice Liddell' });
    const { flowId, cb } = await signInUpToGrant();
    expect(cb.statusCode).toBe(302);
    const back = loopback(cb);
    expect(back.origin).toBe(`http://127.0.0.1:${PORT}`);
    expect(back.pathname).toBe('/callback');
    expect(back.searchParams.get('flow')).toBe(flowId);
    const grant = back.searchParams.get('grant')!;
    const done = await complete(flowId, grant);
    expect(done.statusCode).toBe(201);
    const body = done.json<{ token: string; user: { id: string; displayName: string; serverAdmin: boolean } }>();
    expect(body.user).toMatchObject({ displayName: 'Alice Liddell', serverAdmin: true });
    expect(accepted).toHaveBeenCalledWith({ invitationId: invitation.id, userId: body.user.id });
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.json()).toMatchObject({ methods: { local: false, oidc: [{ issuer: idp.url }] } });
    expect(await repo.flowById(h.db, flowId)).toBeUndefined(); // single use
    expect(idp.tokenRequests).toBe(1);
  });

  it('links an existing local user by verified email; a second sign-in matches the identity row without an email', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: 'p'.repeat(12) });
    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true });
    const first = await signInUpToGrant();
    expect((await complete(first.flowId, loopback(first.cb).searchParams.get('grant')!)).json<{ user: { id: string } }>().user.id).toBe(alice.user.id);
    idp.nextUser({ sub: 'sub-alice' }); // no email claim at all this time
    const second = await signInUpToGrant();
    expect((await complete(second.flowId, loopback(second.cb).searchParams.get('grant')!)).json<{ user: { id: string } }>().user.id).toBe(alice.user.id);
  });

  it.each([
    ['an unverified email', { sub: 's1', email: 'bob@example.com', email_verified: false }, 'identity-email-unverified'],
    ['no email_verified claim', { sub: 's2', email: 'bob@example.com' }, 'identity-email-unverified'],
    ['an uninvited email', { sub: 's3', email: 'nobody@example.com', email_verified: true }, 'identity-not-invited'],
  ])('refuses %s by redirecting the browser to the loopback with the code', async (_name, user, code) => {
    await createInvitation(env(), { email: 'bob@example.com', serverAdmin: false, createdBy: null }).catch(() => undefined);
    idp.nextUser(user);
    const { flowId, cb } = await signInUpToGrant();
    expect(cb.statusCode).toBe(302);
    expect(loopback(cb).searchParams.get('error')).toBe(code);
    expect(await repo.flowById(h.db, flowId)).toBeUndefined();
    expect(await repo.findUserByEmail(h.db, 'nobody@example.com')).toBeUndefined();
  });

  it('refuses a disabled user whether matched by identity or by email', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', disabled: true });
    idp.nextUser({ sub: 'sub-bob', email: 'bob@example.com', email_verified: true });
    expect(loopback((await signInUpToGrant()).cb).searchParams.get('error')).toBe('identity-user-disabled');
    await repo.insertOidcIdentity(h.db, { issuer: idp.url, subject: 'sub-bob', userId: bob.user.id, at: h.clock.now });
    expect(loopback((await signInUpToGrant()).cb).searchParams.get('error')).toBe('identity-user-disabled');
  });

  it('refuses a wrong state, a reused grant, a wrong verifier and an expired flow', async () => {
    await createInvitation(env(), { email: 'alice@example.com', serverAdmin: false, createdBy: null });
    const wrongState = await h.app.inject({ method: 'GET', url: `/api/v1/auth/oidc/callback?code=x&state=${mintSecret().secret}` });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.headers['content-type']).toContain('text/html');
    expect(wrongState.body).toContain('Return to Wirebench');

    const { flowId, cb } = await signInUpToGrant();
    const grant = loopback(cb).searchParams.get('grant')!;
    expect((await complete(flowId, grant, 'w'.repeat(43))).json<{ code: string }>().code).toBe('identity-flow-invalid');
    expect((await complete(flowId, mintSecret().secret)).json<{ code: string }>().code).toBe('identity-flow-invalid');
    expect((await complete(flowId, grant)).statusCode).toBe(201);
    expect((await complete(flowId, grant)).json<{ code: string }>().code).toBe('identity-flow-invalid'); // reused

    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true });
    const late = await start();
    const { flowId: lateId, authorizationUrl } = late.json<{ flowId: string; authorizationUrl: string }>();
    h.clock.advance(11 * 60_000);
    const expired = await callback(authorizationUrl);
    expect(expired.statusCode).toBe(400);
    expect(await repo.flowById(h.db, lateId)).toBeDefined(); // the sweep removes it; the callback only refuses
  });

  it('redirects the IdP’s refusal to the loopback as identity-oidc-refused', async () => {
    const { flowId } = (await start()).json<{ flowId: string }>();
    const flow = await repo.flowById(h.db, flowId);
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/auth/oidc/callback?error=access_denied&state=${flow!.state}` });
    expect(res.statusCode).toBe(302);
    expect(loopback(res).searchParams.get('error')).toBe('identity-oidc-refused');
  });

  it('rate-limits complete per address', async () => {
    const { flowId } = (await start()).json<{ flowId: string }>();
    for (let i = 0; i < 10; i += 1) await complete(flowId, mintSecret().secret);
    expect((await complete(flowId, mintSecret().secret)).statusCode).toBe(429);
  });

  it('serve exits 2 naming the module when discovery fails', async () => {
    await idp.close();
    const dataDir = await mkTempDir();
    const stderr = { write: vi.fn() };
    const code = await main(
      ['serve'],
      {
        stdout: { write: vi.fn() },
        stderr,
        env: {
          WIREBENCH_SERVER_DATABASE_URL: h.db.url,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_DATA_DIR: dataDir,
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
          WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
          WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
          WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
          WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        },
      },
      { exit: vi.fn() },
    );
    await removeTempDir(dataDir);
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).toContain('a module failed to register');
    idp = await startFakeOidcIssuer(); // so afterEach can close something
  });
});
```

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/identity/oidc.test.ts`
Expected: FAIL — no routes, no discovery.

- [ ] **Step 5: `routes/auth-oidc.ts` and the return page**

Append to `packages/server/src/identity/invite-page.ts`:

```ts
/** What the browser sees after the IdP redirect: one line, then it is the desktop's turn. */
export function renderReturnPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wirebench Server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}</style>
</head><body><h1>Wirebench Server</h1><p>${escapeHtml(message)}</p></body></html>`;
}
```

`packages/server/src/identity/routes/auth-oidc.ts`:

```ts
/**
 * The OIDC flow (identity spec §3.1, §6): the desktop starts a flow with a PKCE challenge and
 * its loopback port, the browser round-trips through the IdP and back to `/callback` on this
 * server, which links the claims and hands the browser a one-time grant for the loopback; the
 * desktop then proves the verifier and the grant at `/complete` and gets a device token. The
 * ID token never leaves this process and the desktop never sees the IdP.
 */
import {
  oidcCallbackQuerySchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  oidcStartResponseSchema,
  signInResponseSchema,
  type OidcCallbackQuery,
  type OidcCompleteRequest,
  type OidcStartRequest,
} from '@wirebench/engine';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { flowInvalid, methodDisabled } from '../errors.js';
import { INVITE_PAGE_CSP, renderReturnPage } from '../invite-page.js';
import { linkClaims } from '../linking.js';
import type { OidcClaims } from '../oidc.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { issueToken } from '../sessions.js';
import { hashSecret, mintSecret, newId, pkceChallenge } from '../tokens.js';

/** §2: a pending flow lives ten minutes. */
const FLOW_TTL_MS = 10 * 60 * 1000;

function sameSecret(storedHash: string, candidateHash: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function htmlPage(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply
    .code(status)
    .header('content-security-policy', INVITE_PAGE_CSP)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(renderReturnPage(message));
}

/** The browser goes to the loopback; the body is only for a browser that does not follow the redirect. */
function redirectToLoopback(reply: FastifyReply, flow: repo.FlowRow, params: Readonly<Record<string, string>>): FastifyReply {
  const url = new URL(`http://127.0.0.1:${String(flow.loopbackPort)}/callback`);
  url.searchParams.set('flow', flow.id);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return reply
    .code(302)
    .header('location', url.href)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(renderReturnPage('Return to Wirebench to finish signing in.'));
}

export const authOidcRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/oidc/start',
      { schema: { body: jsonSchema(oidcStartRequestSchema, { io: 'input' }), response: { 201: jsonSchema(oidcStartResponseSchema) } } },
      async (request, reply) => {
        const provider = env.provider;
        if (provider === undefined) throw methodDisabled();
        const body = request.body as OidcStartRequest;
        const now = env.now();
        const id = newId();
        const state = mintSecret().secret;
        const nonce = mintSecret().secret;
        const expiresAt = new Date(now.getTime() + FLOW_TTL_MS);
        await repo.insertFlow(env.ctx.db, {
          id,
          codeChallenge: body.codeChallenge,
          loopbackPort: body.loopbackPort,
          deviceName: body.device.name,
          state,
          nonce,
          createdAt: now,
          expiresAt,
        });
        return reply.code(201).send({
          flowId: id,
          authorizationUrl: provider.authorizationUrl({ state, nonce, redirectUri: env.settings.redirectUri }),
          expiresAt: expiresAt.toISOString(),
        });
      },
    );

    app.get('/auth/oidc/callback', { schema: { querystring: jsonSchema(oidcCallbackQuerySchema, { io: 'input' }) } }, async (request, reply) => {
      const provider = env.provider;
      if (provider === undefined) throw methodDisabled();
      const query = request.query as OidcCallbackQuery;
      const flow = await repo.flowByState(env.ctx.db, query.state);
      if (flow === undefined || flow.grantHash !== null || Date.parse(flow.expiresAt) <= env.now().getTime()) {
        return htmlPage(reply, 400, 'This sign-in has expired or was already completed. Return to Wirebench and start again.');
      }
      if (query.code === undefined || query.error !== undefined) {
        await repo.deleteFlow(env.ctx.db, flow.id);
        return redirectToLoopback(reply, flow, { error: 'identity-oidc-refused' });
      }
      let claims: OidcClaims;
      try {
        claims = await provider.exchange({ callbackUrl: new URL(request.url, env.ctx.config.publicUrl), state: flow.state, nonce: flow.nonce });
      } catch (error) {
        request.log.warn({ err: error, flowId: flow.id }, 'oidc code exchange failed');
        await repo.deleteFlow(env.ctx.db, flow.id);
        return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
      }
      if (claims.issuer !== provider.issuer) {
        await repo.deleteFlow(env.ctx.db, flow.id); // §6: the issuer is pinned from configuration
        return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
      }
      const linked = await linkClaims(env, claims);
      if (!linked.ok) {
        await repo.deleteFlow(env.ctx.db, flow.id);
        return redirectToLoopback(reply, flow, { error: linked.code });
      }
      const grant = mintSecret();
      await repo.grantFlow(env.ctx.db, flow.id, grant.hash, linked.user.id);
      return redirectToLoopback(reply, flow, { grant: grant.secret });
    });

    app.post(
      '/auth/oidc/complete',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: { body: jsonSchema(oidcCompleteRequestSchema, { io: 'input' }), response: { 201: jsonSchema(signInResponseSchema) } },
      },
      async (request, reply) => {
        if (env.provider === undefined) throw methodDisabled();
        const body = request.body as OidcCompleteRequest;
        const flow = await repo.flowById(env.ctx.db, body.flowId);
        if (flow === undefined || flow.grantHash === null || flow.userId === null || Date.parse(flow.expiresAt) <= env.now().getTime()) throw flowInvalid();
        if (!sameSecret(flow.grantHash, hashSecret(body.grant)) || pkceChallenge(body.codeVerifier) !== flow.codeChallenge) throw flowInvalid();
        await repo.deleteFlow(env.ctx.db, flow.id); // single use, whatever happens next
        const user = await repo.findUserById(env.ctx.db, flow.userId);
        if (user === undefined || user.disabledAt !== null) throw flowInvalid();
        return reply.code(201).send(await issueToken(env, user, flow.deviceName));
      },
    );
  };
```

- [ ] **Step 6: The final `module.ts`**

Replace the whole file with:

```ts
/**
 * The `identity` ServerModule (spec §5.1). Registration order inside `register` matters: OIDC
 * discovery runs first (a failure is a start-up failure, exit 2 via serve.ts), then the
 * `onRequest` hook, then the routes that read `request.caller`. The module is mounted into the
 * shared /api/v1 scope, so the hook also reaches `teams-access` and `server-sync` registered
 * after it. The invitation page is served at the root through `registerPublic`.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings, type IdentityEnv } from './env.js';
import { authenticate } from './guard.js';
import { discoverOidc, type OidcProvider } from './oidc.js';
import { RateLimiter } from './rate-limit.js';
import { authLocalRoutes } from './routes/auth-local.js';
import { authOidcRoutes } from './routes/auth-oidc.js';
import { invitationRoutes } from './routes/invitations.js';
import { invitePageRoutes } from './routes/invite-page.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
import { sweepExpired } from './sessions.js';

export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/identity/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IdentityOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** A provider instead of discovery — a fake in tests. */
  readonly provider?: OidcProvider;
  /** How often expired tokens and flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

export function identityModule(options: IdentityOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  let env: IdentityEnv | undefined;
  const envFor = (ctx: ServerContext, provider: OidcProvider | undefined): IdentityEnv =>
    (env ??= {
      ctx,
      settings: identitySettings(ctx.config),
      now,
      limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
      provider,
    });

  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      let provider = options.provider;
      if (settings.oidc !== undefined && provider === undefined) {
        provider = await discoverOidc({
          issuer: settings.oidc.issuer,
          clientId: ctx.config.oidcClientId!,
          clientSecret: ctx.config.oidcClientSecret!,
          scopes: ctx.config.oidcScopes,
          allowInsecure: ctx.config.allowInsecurePublicUrl,
        });
      }
      const identity = envFor(ctx, provider);
      ctx.meta.setSignInMethods({
        local: settings.local,
        oidc: settings.oidc !== undefined,
        ...(settings.oidc !== undefined ? { oidcDisplayName: settings.oidc.displayName } : {}),
      });
      ctx.meta.addCapability('identity');

      app.addHook('onRequest', authenticate(identity));
      authLocalRoutes(identity)(app);
      authOidcRoutes(identity)(app);
      meRoutes(identity)(app);
      invitationRoutes(identity)(app);
      userRoutes(identity)(app);

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepExpired(identity).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      invitePageRoutes(envFor(ctx, options.provider))(root);
      await Promise.resolve();
    },
  };
}
```

(`register` runs before `registerPublic` — `buildServer` registers `/api/v1` first — so the memoised
env already carries the discovered provider by the time the public page asks for it.)

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit && nice pnpm vitest run --project server-integration packages/server/test/integration`
Expected: all PASS, including the OIDC suite (9).

- [ ] **Step 7: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src/identity packages/server/test
git commit -m "feat(server): OIDC sign-in through openid-client with invitation-gated linking

The server is the relying party: the desktop only ever sees a flow id
and a one-time grant on its loopback, never an ID token. Linking follows
the spec's five rules in order, so a known identity wins and an
unverified email can neither link nor create. The integration suite runs
a real discovery and exchange against an in-process issuer signing
RS256 tokens with node:crypto."
```

---

### Task 8: The `admin` command line, README and the server's final gate

**Files:**
- Create: `packages/server/src/identity/cli.ts`, `packages/server/test/integration/identity/cli.test.ts`
- Modify: `packages/server/src/args.ts`, `packages/server/src/main.ts`, `packages/server/src/identity/env.ts`
  (`InvitationEnv`), `packages/server/src/identity/invitations.ts` (signatures), `packages/server/test/unit/args.test.ts`,
  `packages/server/README.md` (Accounts section)

**Interfaces:**
- Produces: `ServerCommand` gains `{ command: 'admin-invite'; email; serverAdmin }`,
  `{ command: 'admin-list-invitations' }`, `{ command: 'admin-revoke-invitation'; id }`;
  `runAdmin(command, io, options?) → Promise<number>`; `InvitationEnv`
  (`{ ctx: Pick<ServerContext, 'db' | 'config' | 'events'>; settings: Pick<IdentitySettings, 'invitationMs' | 'local' | 'oidc'>; now }`).
- Consumes: `createInvitation`, `revokeOpenInvitation`, `invitationSummary`, `isOpen` (Task 6),
  `allMigrations`, `pendingMigrations`, `createDatabase`, `ConfigError`, `loadConfig`, `ExitCode`.

- [ ] **Step 1: Loosen the invitation functions to `InvitationEnv`**

In `packages/server/src/identity/env.ts` add:

```ts
/** What the invitation functions need: the CLI builds one without a Fastify app or a provider. */
export interface InvitationEnv {
  readonly ctx: Pick<ServerContext, 'db' | 'config' | 'events'>;
  readonly settings: Pick<IdentitySettings, 'invitationMs' | 'local' | 'oidc'>;
  readonly now: () => Date;
}
```

In `invitations.ts` change every `env: IdentityEnv` parameter (and `inviteUrl`'s) to
`env: InvitationEnv`, and the import accordingly; `acceptInvitation` keeps `IdentityEnv` because
`issueToken` needs it. `IdentityEnv` is assignable to `InvitationEnv`, so the routes do not change.
The oidc test's `env()` helper (Task 7) already builds exactly this shape.

- [ ] **Step 2: Write the failing tests**

Append to `packages/server/test/unit/args.test.ts`:

```ts
describe('admin commands (§3.7)', () => {
  it('parses invite, list-invitations and revoke-invitation', () => {
    expect(parseServerArgs(['admin', 'invite', 'alice@example.com'])).toEqual({ command: 'admin-invite', email: 'alice@example.com', serverAdmin: true });
    expect(parseServerArgs(['admin', 'invite', 'alice@example.com', '--no-admin'])).toEqual({ command: 'admin-invite', email: 'alice@example.com', serverAdmin: false });
    expect(parseServerArgs(['admin', 'list-invitations'])).toEqual({ command: 'admin-list-invitations' });
    expect(parseServerArgs(['admin', 'revoke-invitation', '01J8Z'])).toEqual({ command: 'admin-revoke-invitation', id: '01J8Z' });
  });
  it('refuses a missing email or id, an unknown sub-command, and --no-admin elsewhere', () => {
    expect(() => parseServerArgs(['admin', 'invite'])).toThrow(/usage: wirebench-server admin invite <email>/);
    expect(() => parseServerArgs(['admin', 'revoke-invitation'])).toThrow(/usage/);
    expect(() => parseServerArgs(['admin', 'frobnicate'])).toThrow(/unknown admin command/);
    expect(() => parseServerArgs(['serve', '--no-admin'])).toThrow(/--no-admin only applies to admin invite/);
  });
});
```

`packages/server/test/integration/identity/cli.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/main.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

describeDb('wirebench-server admin (§3.7)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({ WIREBENCH_SERVER_DATABASE_URL: db.url, WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test', WIREBENCH_SERVER_LOG_LEVEL: 'fatal' });
  const run = async (args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(args, { stdout: { write: (t: string) => stdout.push(t) }, stderr: { write: (t: string) => stderr.push(t) }, env: env() });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  };
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('refuses to run before migrate, then invites, lists and revokes', async () => {
    const early = await run(['admin', 'invite', 'alice@example.com']);
    expect(early.code).toBe(3);
    expect(early.stderr).toContain('wirebench-server migrate');
    expect((await run(['migrate'])).code).toBe(0);

    const invite = await run(['admin', 'invite', 'Alice@example.com']);
    expect(invite.code).toBe(0);
    expect(invite.stdout).toMatch(/Invitation for Alice@example\.com \(server admin\)\nhttps:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}\nExpires 2\d{3}-/);
    const again = await run(['admin', 'invite', 'alice@example.com']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('identity-invitation-exists');

    const list = await run(['admin', 'list-invitations']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Alice@example.com');
    expect(list.stdout).toContain('open');
    expect(list.stdout).not.toContain('/invite/');
    const id = /^(\S+)\s+Alice@example\.com/m.exec(list.stdout)?.[1];
    expect(id).toBeDefined();

    expect((await run(['admin', 'revoke-invitation', id!])).code).toBe(0);
    expect((await run(['admin', 'list-invitations'])).stdout).toContain('revoked');
    expect((await run(['admin', 'revoke-invitation', id!])).code).toBe(1);
    const member = await run(['admin', 'invite', 'bob@example.com', '--no-admin']);
    expect(member.stdout).toContain('(member)');
  });

  it('exits 2 on bad configuration without values, like every other command', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['admin', 'invite', 'a@b.co'], { stdout: { write: vi.fn() }, stderr, env: { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@x/y' } });
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('s3cret');
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/args.test.ts` → FAIL.

- [ ] **Step 3: `args.ts`**

Add to `ServerCommand`:

```ts
  | { readonly command: 'admin-invite'; readonly email: string; readonly serverAdmin: boolean }
  | { readonly command: 'admin-list-invitations' }
  | { readonly command: 'admin-revoke-invitation'; readonly id: string };
```

Add to `HELP_TEXT` after the `config check` line:

```
  wirebench-server admin invite <email> [--no-admin]
                                    Create an invitation link (a server admin unless --no-admin)
  wirebench-server admin list-invitations
  wirebench-server admin revoke-invitation <id>
```

Add `'no-admin': { type: 'boolean' }` to `OPTIONS`. In `parseServerArgs`, destructure
`const [word, second, third] = parsed.positionals;`, refuse `--no-admin` outside `admin invite`
(`if (parsed.values['no-admin'] && !(word === 'admin' && second === 'invite')) throw new UsageError('--no-admin only applies to admin invite');`)
before the `switch`, and add:

```ts
    case 'admin':
      switch (second) {
        case 'invite':
          if (third === undefined) throw new UsageError('usage: wirebench-server admin invite <email> [--no-admin]');
          return { command: 'admin-invite', email: third, serverAdmin: parsed.values['no-admin'] !== true };
        case 'list-invitations':
          return { command: 'admin-list-invitations' };
        case 'revoke-invitation':
          if (third === undefined) throw new UsageError('usage: wirebench-server admin revoke-invitation <id>');
          return { command: 'admin-revoke-invitation', id: third };
        default:
          throw new UsageError(`unknown admin command "${second ?? ''}"; try --help`);
      }
```

- [ ] **Step 4: `cli.ts` and the dispatch**

`packages/server/src/identity/cli.ts`:

```ts
/**
 * `wirebench-server admin …` (identity spec §3.7): the same code as the admin endpoints, run by
 * an operator who cannot sign in yet — on a fresh server, the first admin comes from here.
 * It refuses to run against an unmigrated database rather than guessing at the schema.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, loadConfig } from '../config.js';
import { ServerEvents } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { BUILTIN_MODULES } from '../modules.js';
import { allMigrations, StartupError } from '../serve.js';
import { identitySettings, type InvitationEnv } from './env.js';
import { createInvitation, invitationSummary, isOpen, revokeOpenInvitation } from './invitations.js';
import * as repo from './repo.js';

type AdminCommand = Extract<ServerCommand, { command: `admin-${string}` }>;

/** `now` exists for tests; the bin passes nothing. */
export async function runAdmin(command: AdminCommand, io: ServerIo, options: { readonly now?: () => Date } = {}): Promise<number> {
  let env: InvitationEnv;
  let db: ReturnType<typeof createDatabase>;
  try {
    const config = loadConfig(io.env, packageVersion());
    delete process.env.WIREBENCH_SERVER_DATABASE_URL;
    db = createDatabase(config.databaseUrl);
    env = { ctx: { db, config, events: new ServerEvents() }, settings: identitySettings(config), now: options.now ?? (() => new Date()) };
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
  try {
    const pending = await pendingMigrations(db, await allMigrations(BUILTIN_MODULES));
    if (pending.length > 0) {
      io.stderr.write(`${pending.length} migrations are pending; run wirebench-server migrate first\n`);
      return ExitCode.Migration;
    }
    switch (command.command) {
      case 'admin-invite': {
        const created = await createInvitation(env, { email: command.email, serverAdmin: command.serverAdmin, createdBy: null });
        io.stdout.write(`Invitation for ${created.email} (${command.serverAdmin ? 'server admin' : 'member'})\n${created.url}\nExpires ${created.expiresAt}\n`);
        return ExitCode.Ok;
      }
      case 'admin-list-invitations': {
        const now = env.now();
        const rows = await repo.listInvitations(db);
        io.stdout.write(`${'id'.padEnd(26)}  ${'email'.padEnd(40)}  admin  status    expires\n`);
        for (const row of rows) {
          const summary = invitationSummary(row);
          const status = row.acceptedAt !== null ? 'accepted' : row.revokedAt !== null ? 'revoked' : isOpen(row, now) ? 'open' : 'expired';
          io.stdout.write(`${summary.id}  ${summary.email.padEnd(40)}  ${summary.serverAdmin ? 'yes  ' : 'no   '}  ${status.padEnd(8)}  ${summary.expiresAt}\n`);
        }
        return ExitCode.Ok;
      }
      case 'admin-revoke-invitation': {
        if (!(await revokeOpenInvitation(env, command.id))) {
          io.stderr.write(`identity-not-found: no open invitation with id ${command.id}\n`);
          return 1;
        }
        io.stdout.write(`Revoked ${command.id}\n`);
        return ExitCode.Ok;
      }
    }
  } catch (error) {
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof StartupError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  } finally {
    await db.close();
  }
}
```

In `packages/server/src/main.ts` add, before `case 'serve'`:

```ts
    case 'admin-invite':
    case 'admin-list-invitations':
    case 'admin-revoke-invitation':
      return runAdmin(command, io);
```

with `import { runAdmin } from './identity/cli.js';`.

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/args.test.ts && nice pnpm vitest run --project server-integration packages/server/test/integration/identity/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: README — the Accounts section**

Append to `packages/server/README.md` after "Running":

```markdown
## Accounts

Accounts are invite-only. On a fresh server, create the first admin from the console:

    docker compose -f packages/server/compose.yaml exec server wirebench-server admin invite you@example.com

It prints a one-time link (`<public URL>/invite/<code>`), valid for `WIREBENCH_SERVER_INVITATION_DAYS`
(default 7). Open it, or paste the code into Wirebench's *Account: Sign in to a server…* dialog under
*Have an invitation code?*, choose a password, and you are the first server admin. Every later
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
```

- [ ] **Step 6: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server
git commit -m "feat(server): wirebench-server admin invite, list-invitations and revoke-invitation

The first admin of a fresh server has nobody to invite them, so the
console runs the same createInvitation the endpoint does, with
createdBy = null. It refuses an unmigrated database with exit 3 instead
of failing on a missing table."
```

The server half is complete here: every §3.1 endpoint, §3.7 command and §13 criteria 1–3 and 6 are
covered by the integration suite. Tasks 9–15 are the desktop.

---

### Task 9: Desktop — the loopback callback helper, extracted from the OAuth2 flow

**Files:**
- Create: `apps/desktop/src/main/loopback-callback.ts`, `apps/desktop/test/loopback-callback.test.ts`
- Modify: `apps/desktop/src/main/oauth2.ts:16-30,92-140,148-156,178-190,260-392` (the page, the
  `PendingFlow` type, `cancel`, `authorize`, `handleCallback`, `finish`, `abandon`)

**Interfaces:**
- Produces: `startLoopbackCallback(options: LoopbackCallbackOptions) → Promise<LoopbackCallback>`,
  `LoopbackCallbackOptions { expected: { name: string; value: () => string | undefined }; port?: number; timeoutMs: number; describe: (params: URLSearchParams) => { ok: boolean; message: string } }`,
  `LoopbackCallback { redirectUri: string; port: number; result: Promise<URLSearchParams>; cancel(): void }`,
  `callbackPage(message)`, `escapeHtml(text)`; errors `loopback-timeout`, `loopback-cancelled`.
- Consumes: nothing new. `OAuth2Service`'s public API and every test in `apps/desktop/test/oauth2.test.ts`
  and `ipc-oauth2.test.ts` are unchanged (spec §13.8) — ruling: those tests stay where they are as the
  regression net for the extraction; the helper gets its own file of tests.

- [ ] **Step 1: Write the failing helper tests**

`apps/desktop/test/loopback-callback.test.ts`:

```ts
// @vitest-environment node
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startLoopbackCallback } from '../src/main/loopback-callback.js';

const describeOk = (params: URLSearchParams) =>
  params.get('error') === null ? { ok: true, message: 'Signed in. You can close this tab.' } : { ok: false, message: `Refused (${params.get('error') ?? ''}).` };

/** Whether a TCP connection to `host:port` is accepted. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

describe('startLoopbackCallback', () => {
  it('listens on 127.0.0.1 on a random port, answers the matching callback once, then closes', async () => {
    const listener = await startLoopbackCallback({ expected: { name: 'state', value: () => 'abc' }, timeoutMs: 5_000, describe: describeOk });
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${String(listener.port)}/callback`);
    const response = await fetch(`${listener.redirectUri}?code=xyz&state=abc`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Signed in.');
    expect((await listener.result).get('code')).toBe('xyz');
    expect(await reachable('127.0.0.1', listener.port)).toBe(false);
  });

  it('answers 400 to a callback whose expected value does not match and stays pending', async () => {
    const listener = await startLoopbackCallback({ expected: { name: 'state', value: () => 'abc' }, timeoutMs: 5_000, describe: describeOk });
    const wrong = await fetch(`${listener.redirectUri}?code=injected&state=nope`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('did not match');
    const settled = await Promise.race([listener.result.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 100))]);
    expect(settled).toBe('pending');
    listener.cancel();
    await expect(listener.result).rejects.toMatchObject({ code: 'loopback-cancelled' });
  });

  it('keeps refusing until the expected value is known, then accepts it', async () => {
    let flow: string | undefined;
    const listener = await startLoopbackCallback({ expected: { name: 'flow', value: () => flow }, timeoutMs: 5_000, describe: describeOk });
    expect((await fetch(`${listener.redirectUri}?flow=f1&grant=g`)).status).toBe(400);
    flow = 'f1';
    expect((await fetch(`${listener.redirectUri}?flow=f1&grant=g`)).status).toBe(200);
    expect((await listener.result).get('grant')).toBe('g');
  });

  it('renders a refusal with a 400 and escapes what the caller interpolated', async () => {
    const listener = await startLoopbackCallback({ expected: { name: 'state', value: () => 's' }, timeoutMs: 5_000, describe: describeOk });
    const response = await fetch(`${listener.redirectUri}?state=s&error=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect((await listener.result).get('error')).toContain('<script>');
  });

  it('times out with loopback-timeout and frees the port', async () => {
    const listener = await startLoopbackCallback({ expected: { name: 'state', value: () => 's' }, timeoutMs: 50, describe: describeOk });
    await expect(listener.result).rejects.toMatchObject({ code: 'loopback-timeout' });
    expect(await reachable('127.0.0.1', listener.port)).toBe(false);
  });

  it('honours a fixed port and answers 410 once the flow is over', async () => {
    const first = await startLoopbackCallback({ expected: { name: 'state', value: () => 's' }, timeoutMs: 5_000, describe: describeOk });
    const port = first.port;
    first.cancel();
    await first.result.catch(() => undefined);
    const second = await startLoopbackCallback({ expected: { name: 'state', value: () => 's' }, port, timeoutMs: 5_000, describe: describeOk });
    expect(second.port).toBe(port);
    await fetch(`${second.redirectUri}?state=s`);
    await second.result;
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/loopback-callback.test.ts` → FAIL.

- [ ] **Step 2: `loopback-callback.ts`**

```ts
/**
 * The one loopback listener a browser hand-off answers to, shared by the OAuth2 request flow and
 * the server sign-in (identity spec §5.3). Security, stated once: it binds `127.0.0.1` only, on a
 * random port unless the caller pinned one, accepts exactly one callback whose `expected`
 * parameter matches, answers everything else with 400 without ending the flow, and gives up
 * after `timeoutMs` (RFC 8252 §8.3). The page it renders is plain HTML with every interpolated
 * value escaped: the `error` parameter is chosen by whoever drove the redirect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WirebenchError } from '@wirebench/engine';

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes `text` for interpolation into HTML element content. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** The one-page response the listener returns to the browser; `message` is escaped, not trusted. */
export function callbackPage(message: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Wirebench</title>',
    '<style>body{font:14px system-ui;margin:3rem;color:#222}</style>',
    '</head><body><h1>Wirebench</h1><p>',
    escapeHtml(message),
    '</p></body></html>',
  ].join('');
}

export interface LoopbackCallbackOptions {
  /**
   * The query parameter that ties a callback to this flow and the value it must carry. A
   * function, because the server sign-in learns its flow id only after it has told the server
   * the port; until it returns a value every callback is refused.
   */
  readonly expected: { readonly name: string; readonly value: () => string | undefined };
  /** A fixed port a provider demands; a random free one otherwise. */
  readonly port?: number;
  readonly timeoutMs: number;
  /** What the browser is told for the matching callback: `ok` picks 200 or 400. */
  readonly describe: (params: URLSearchParams) => { readonly ok: boolean; readonly message: string };
}

export interface LoopbackCallback {
  readonly redirectUri: string;
  readonly port: number;
  /** The matching callback's query; rejects `loopback-timeout` or `loopback-cancelled`. */
  readonly result: Promise<URLSearchParams>;
  cancel(): void;
}

export async function startLoopbackCallback(options: LoopbackCallbackOptions): Promise<LoopbackCallback> {
  const server: Server = createServer();
  let settle: { resolve: (params: URLSearchParams) => void; reject: (error: Error) => void } | undefined;
  let done = false;
  const finish = (outcome: { params: URLSearchParams } | { error: Error }): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    if ('params' in outcome) settle?.resolve(outcome.params);
    else settle?.reject(outcome.error);
  };
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(() => {
    finish({ error: new WirebenchError('loopback-timeout', 'The sign-in was not completed in time') });
  }, options.timeoutMs);
  timer.unref?.();

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    if (done) {
      response.writeHead(410).end();
      return;
    }
    const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
    const expected = options.expected.value();
    if (expected === undefined || params.get(options.expected.name) !== expected) {
      // Not this flow's callback: answered, but neither accepted nor allowed to end the flow.
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackPage('This sign-in response did not match the request. You can close this tab.'));
      return;
    }
    const verdict = options.describe(params);
    response.writeHead(verdict.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(callbackPage(verdict.message));
    finish({ params });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${String(port)}/callback`,
    port,
    result,
    cancel: () => finish({ error: new WirebenchError('loopback-cancelled', 'The sign-in was cancelled') }),
  };
}
```

- [ ] **Step 3: Make `OAuth2Service` use it**

In `apps/desktop/src/main/oauth2.ts`:
- delete `HTML_ESCAPES`, `escapeHtml`, `callbackPage`, `handleCallback`, `finish`, `abandon` and the
  `node:http` / `node:net` imports; import `startLoopbackCallback, type LoopbackCallback` from
  `./loopback-callback.js`;
- `PendingFlow` becomes `interface PendingFlow { readonly listener: LoopbackCallback; readonly state: string }`;
- `cancel()` becomes:

```ts
  cancel(): { readonly cancelled: boolean } {
    if (this.pending === undefined) return { cancelled: false };
    this.pending.listener.cancel();
    return { cancelled: true };
  }
```

- `authorize()` becomes:

```ts
  private async authorize(
    config: OAuth2Auth,
  ): Promise<{ readonly code: string; readonly redirectUri: string; readonly verifier?: string }> {
    if (this.pending !== undefined) {
      throw new WirebenchError('oauth2-flow-pending', 'A sign-in is already waiting for the browser');
    }
    const pair = config.pkce ? pkce() : undefined;
    const state = newState();
    const port = this.deps.callbackPort?.();
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => state },
      ...(port !== undefined ? { port } : {}),
      timeoutMs: FLOW_TIMEOUT_MS,
      describe: (params) => {
        const error = params.get('error');
        return error === null && params.get('code') !== null
          ? { ok: true, message: 'Signed in. You can close this tab and go back to Wirebench.' }
          : { ok: false, message: `The provider refused the sign-in (${error ?? 'no code'}). You can close this tab.` };
      },
    });
    this.pending = { listener, state };
    // Nothing awaits the result until the browser has been opened, and a provider that refuses
    // immediately can answer first: the no-op handler keeps that from surfacing as unhandled.
    void listener.result.catch(() => undefined);
    try {
      await this.deps.openExternal(
        authorizationUrl({ config, redirectUri: listener.redirectUri, state, ...(pair !== undefined ? { challenge: pair.challenge } : {}) }),
      );
      const params = await listener.result;
      const code = params.get('code');
      const error = params.get('error');
      if (error !== null || code === null) {
        throw new WirebenchError('oauth2-authorization-failed', `The provider refused the sign-in: ${error ?? 'no code'}`);
      }
      return { code, redirectUri: listener.redirectUri, ...(pair !== undefined ? { verifier: pair.verifier } : {}) };
    } catch (error) {
      listener.cancel(); // a no-op once the listener has settled; frees the port when openExternal threw
      throw translateLoopbackError(error);
    } finally {
      this.pending = undefined;
    }
  }
```

and, at module level:

```ts
/** The helper's codes, in this service's vocabulary — the renderer and its tests know only these. */
function translateLoopbackError(error: unknown): unknown {
  if (error instanceof WirebenchError && error.code === 'loopback-timeout') {
    return new WirebenchError('oauth2-timeout', 'The sign-in was not completed in time');
  }
  if (error instanceof WirebenchError && error.code === 'loopback-cancelled') {
    return new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled');
  }
  return error;
}
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/loopback-callback.test.ts apps/desktop/test/oauth2.test.ts apps/desktop/test/ipc-oauth2.test.ts`
Expected: all PASS, the OAuth2 suites unchanged.

- [ ] **Step 4: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add apps/desktop/src/main/loopback-callback.ts apps/desktop/src/main/oauth2.ts apps/desktop/test/loopback-callback.test.ts
git commit -m "refactor(desktop): extract the loopback callback listener from the OAuth2 flow

The server sign-in needs the same listener with the same rules
(127.0.0.1 only, one matching callback, a timeout, an escaped page), so
it becomes a helper the OAuth2 service calls; its behaviour and tests
are unchanged."
```

---

### Task 10: Desktop — `network-options.ts` and `ServerClient`

**Files:**
- Create: `apps/desktop/src/main/network-options.ts`, `apps/desktop/src/main/server-client.ts`,
  `apps/desktop/test/network-options.test.ts`, `apps/desktop/test/server-client.test.ts`
- Modify: `apps/desktop/src/main/project-host.ts:2178-2242` (`trustAnchors`, `proxyFor` delegate)

**Interfaces:**
- Produces: `resolveTrustAnchors({ caBundlePath, roots, picks })`, `resolveProxy({ url, proxy, getSecret, resolveSystemProxy? })`,
  `mainHttpOptions(url, deps: MainHttpDeps) → Promise<{ tls?: TlsOptions; proxy?: ProxyOptions }>`,
  `MainHttpDeps { preferences: () => Preferences; picks?: ReadPicks; getSecret; resolveSystemProxy? }`;
  `normalizeServerUrl(text): string` (throws `server-url-invalid`), `ServerClient` with `meta`,
  `signInLocal`, `startOidc`, `completeOidc`, `signOut`, `me`, `lookupInvitation`, `acceptInvitation`;
  error codes `server-unreachable`, `server-not-wirebench`, `server-api-version`, `server-bad-response`,
  plus every `identity-*` code passed through from the body.
- Consumes: engine `sendHttp`, `HttpRequest`, `HttpExchange`, `TlsOptions`, `ProxyOptions`,
  `resolveProxyFor`, `isExcluded`, `splitPemBundle`, `Preferences`; the Task 1 schemas;
  `allowsReadPath` (`main/path-access.ts`), `ReadPicks` (`main/dialog-picks.ts`).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/network-options.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '@wirebench/engine';
import { mainHttpOptions, resolveProxy, resolveTrustAnchors } from '../src/main/network-options.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('network options without a project', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-net-'));
    await writeFile(join(dir, 'ca.pem'), PEM);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('trusts a CA bundle only when main picked it, and never a relative path with no root', async () => {
    const picks = { allowsRead: (path: string) => path === join(dir, 'ca.pem') };
    expect(await resolveTrustAnchors({ caBundlePath: join(dir, 'ca.pem'), roots: [], picks })).toHaveLength(1);
    expect(await resolveTrustAnchors({ caBundlePath: join(dir, 'ca.pem'), roots: [], picks: undefined })).toBeUndefined();
    expect(await resolveTrustAnchors({ caBundlePath: 'ca.pem', roots: [], picks })).toBeUndefined();
    expect(await resolveTrustAnchors({ caBundlePath: 'ca.pem', roots: [dir], picks: undefined })).toHaveLength(1);
    expect(await resolveTrustAnchors({ caBundlePath: undefined, roots: [dir], picks })).toBeUndefined();
  });

  it('resolves a manual proxy with its keychain password and skips excluded hosts for the system proxy', async () => {
    const manual = await resolveProxy({
      url: 'https://wirebench.example.com/api/v1/meta',
      proxy: { mode: 'manual', host: 'proxy.local', port: 3128, username: 'u', passwordRef: 'sec_p', excludes: [] },
      getSecret: (ref) => Promise.resolve(ref === 'sec_p' ? 'pw' : undefined),
    });
    expect(manual).toMatchObject({ url: expect.stringContaining('proxy.local:3128') });
    const excluded = await resolveProxy({
      url: 'https://wirebench.example.com/',
      proxy: { mode: 'system', excludes: ['*.example.com'] },
      getSecret: () => Promise.resolve(undefined),
      resolveSystemProxy: () => Promise.resolve('PROXY should-not-be-asked:8080'),
    });
    expect(excluded).toBeUndefined();
    expect(await resolveProxy({ url: 'https://x.test/', proxy: { mode: 'none', excludes: [] }, getSecret: () => Promise.resolve(undefined) })).toBeUndefined();
  });

  it('mainHttpOptions combines the two from the preferences document', async () => {
    const preferences: Preferences = {
      ...DEFAULT_PREFERENCES,
      ssl: { ...DEFAULT_PREFERENCES.ssl, caBundlePath: join(dir, 'ca.pem'), caBundlePickedByMain: true },
      proxy: { mode: 'manual', host: 'proxy.local', port: 3128, excludes: [] },
    };
    const options = await mainHttpOptions('https://wirebench.example.com/', {
      preferences: () => preferences,
      picks: { allowsRead: (path) => path === join(dir, 'ca.pem') },
      getSecret: () => Promise.resolve(undefined),
    });
    expect(options.tls?.ca).toHaveLength(1);
    expect(options.tls?.minVersion).toBe('TLSv1.2');
    expect(options.proxy).toBeDefined();
    expect(await mainHttpOptions('https://x.test/', { preferences: () => DEFAULT_PREFERENCES, getSecret: () => Promise.resolve(undefined) })).toEqual({});
  });
});
```

(Check `ReadPicks` in `apps/desktop/src/main/dialog-picks.ts:58` and `path-access.ts:26-30` for the
exact method name the picks object exposes — the test above assumes `allowsRead(path)`; use whatever
`allowsReadPath` calls on `picks`.)

`apps/desktop/test/server-client.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { normalizeServerUrl, ServerClient } from '../src/main/server-client.js';

const META = { name: 'wirebench-server', version: '2.1.1', apiVersion: 1, publicUrl: 'https://wb.test', auth: { local: true, oidc: false }, capabilities: [] };
const USER = { id: '01J8Z0000000000000000000AB', email: 'a@b.co', displayName: 'A', serverAdmin: false };
const TOKEN = `wbs_${'A'.repeat(43)}`;

function exchange(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): HttpExchange {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return { request: { url: '', method: 'GET', headers: {} }, status, statusText: '', headers, rawHeaders: [], body: bytes, rawBody: bytes } as unknown as HttpExchange;
}

/** A client over a recorded `send`; `answers` are consumed in order. */
function client(...answers: (HttpExchange | Error)[]) {
  const sent: HttpRequest[] = [];
  const send = vi.fn(async (request: HttpRequest) => {
    sent.push(request);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? exchange(500, {});
  });
  return { client: new ServerClient({ send, options: () => Promise.resolve({ tls: { ca: ['pem'] }, proxy: { url: 'http://proxy.local:3128' } }) }), sent };
}

describe('normalizeServerUrl', () => {
  it('keeps the origin and refuses anything that is not http(s)', () => {
    expect(normalizeServerUrl(' https://WB.test/some/path?x=1 ')).toBe('https://wb.test');
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    for (const bad of ['', 'wb.test', 'ftp://wb.test', 'javascript:alert(1)']) expect(() => normalizeServerUrl(bad)).toThrow(/server-url-invalid/);
  });
});

describe('ServerClient', () => {
  it('meta asks /api/v1/meta with the CA and proxy options and parses the answer', async () => {
    const { client: c, sent } = client(exchange(200, META));
    expect(await c.meta('https://wb.test')).toEqual(META);
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://wb.test/api/v1/meta', tls: { ca: ['pem'] }, proxy: { url: 'http://proxy.local:3128' }, followRedirects: false });
    expect(sent[0]?.headers['accept']).toBe('application/json');
  });

  it('tells a non-Wirebench host, an unknown api version and an unreachable one apart', async () => {
    await expect(client(exchange(200, '<html>', { 'content-type': 'text/html' })).client.meta('https://wb.test')).rejects.toMatchObject({ code: 'server-not-wirebench' });
    await expect(client(exchange(200, { hello: 1 })).client.meta('https://wb.test')).rejects.toMatchObject({ code: 'server-not-wirebench' });
    await expect(client(exchange(200, { ...META, apiVersion: 2 })).client.meta('https://wb.test')).rejects.toMatchObject({ code: 'server-api-version' });
    await expect(client(new Error('ECONNREFUSED')).client.meta('https://wb.test')).rejects.toMatchObject({ code: 'server-unreachable' });
  });

  it('posts JSON bodies and passes the server’s problem code through', async () => {
    const { client: c, sent } = client(exchange(201, { token: TOKEN, user: USER }), exchange(401, { code: 'identity-invalid-credentials', message: 'nope' }));
    const ok = await c.signInLocal('https://wb.test', { email: 'a@b.co', password: 'p'.repeat(12), device: { name: 'Mac' } });
    expect(ok.token).toBe(TOKEN);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://wb.test/api/v1/auth/local/sign-in' });
    expect(sent[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.body))).toEqual({ email: 'a@b.co', password: 'p'.repeat(12), device: { name: 'Mac' } });
    await expect(c.signInLocal('https://wb.test', { email: 'a@b.co', password: 'x'.repeat(12), device: { name: 'Mac' } })).rejects.toMatchObject({ code: 'identity-invalid-credentials', message: 'nope', details: { status: 401 } });
  });

  it('sends the bearer token for me and sign-out, and treats 204 as done', async () => {
    const { client: c, sent } = client(exchange(200, { user: USER, methods: { local: true, oidc: [] } }), exchange(204, ''));
    expect((await c.me('https://wb.test', TOKEN)).user.email).toBe('a@b.co');
    await c.signOut('https://wb.test', TOKEN);
    expect(sent.map((r) => r.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(sent[1]).toMatchObject({ method: 'POST', url: 'https://wb.test/api/v1/auth/sign-out' });
  });

  it('looks up and accepts invitations, and starts and completes an OIDC flow', async () => {
    const secret = 'S'.repeat(43);
    const { client: c, sent } = client(
      exchange(200, { email: 'a@b.co', methods: { local: true, oidc: true } }),
      exchange(201, { token: TOKEN, user: USER }),
      exchange(201, { flowId: 'f', authorizationUrl: 'https://idp.test/a?x=1', expiresAt: '2026-09-24T12:10:00.000Z' }),
      exchange(201, { token: TOKEN, user: USER }),
    );
    expect((await c.lookupInvitation('https://wb.test', secret)).methods.oidc).toBe(true);
    expect(sent[0]?.url).toBe(`https://wb.test/api/v1/invitations/lookup?secret=${secret}`);
    await c.acceptInvitation('https://wb.test', { secret, displayName: 'A', password: 'p'.repeat(12), device: { name: 'Mac' } });
    expect((await c.startOidc('https://wb.test', { device: { name: 'Mac' }, codeChallenge: 'C'.repeat(43), loopbackPort: 49152 })).flowId).toBe('f');
    expect((await c.completeOidc('https://wb.test', { flowId: 'f', grant: 'G'.repeat(43), codeVerifier: 'v'.repeat(43) })).token).toBe(TOKEN);
  });

  it('reports a 2xx that does not match the schema as server-bad-response', async () => {
    await expect(client(exchange(201, { token: 'bad', user: USER })).client.signInLocal('https://wb.test', { email: 'a@b.co', password: 'p'.repeat(12), device: { name: 'Mac' } })).rejects.toMatchObject({ code: 'server-bad-response' });
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/network-options.test.ts apps/desktop/test/server-client.test.ts` → FAIL.

- [ ] **Step 2: `network-options.ts`**

```ts
/**
 * The CA bundle and proxy a send from main must honour, resolved from the preferences alone
 * (identity spec §5.3, assumption 7). Lifted out of `ProjectHost.trustAnchors` / `proxyFor` so a
 * call with no project open — the server client — gets the same trust and the same proxy as a
 * request send; `ProjectHost` now delegates here.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { isExcluded, resolveProxyFor, splitPemBundle, type Preferences, type ProxyConfig, type ProxyOptions, type TlsOptions } from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import { allowsReadPath } from './path-access.js';

/**
 * The PEM anchors of the configured bundle, or `undefined` when none is configured, it cannot
 * be read, or it fails the read rule: inside one of `roots`, or picked through a native dialog
 * this session. With no roots (no project) only a picked absolute path qualifies. Failing
 * quietly leaves verification stricter, never looser.
 */
export async function resolveTrustAnchors(input: {
  readonly caBundlePath: string | undefined;
  readonly roots: readonly string[];
  readonly picks: ReadPicks | undefined;
}): Promise<readonly string[] | undefined> {
  const path = input.caBundlePath;
  if (path === undefined || path.length === 0) return undefined;
  const root = input.roots[0];
  const resolved = root !== undefined ? resolvePath(root, path) : isAbsolute(path) ? path : undefined;
  if (resolved === undefined || !(await allowsReadPath(input.roots, input.picks, resolved))) return undefined;
  try {
    const anchors = splitPemBundle(await readFile(resolved, 'utf-8'));
    return anchors.length > 0 ? anchors : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The proxy a send to `url` goes through, or `undefined` for direct. The manual proxy's
 * `passwordRef` is resolved here, in main, and only the resolved options reach the transport.
 * @throws WirebenchError `proxy-unsupported` for a SOCKS answer from the system (undici cannot dial it)
 */
export async function resolveProxy(input: {
  readonly url: string;
  readonly proxy: Preferences['proxy'];
  readonly getSecret: (ref: string) => Promise<string | undefined>;
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
}): Promise<ProxyOptions | undefined> {
  const proxy = input.proxy;
  if (proxy.mode === 'none') return undefined;
  if (proxy.mode === 'system') {
    let hostname: string;
    try {
      hostname = new URL(input.url).hostname;
    } catch {
      return undefined;
    }
    // A host the user said to reach directly is not worth a PAC lookup, which can be slow.
    if (isExcluded(hostname, proxy.excludes)) return undefined;
    const pac = await input.resolveSystemProxy?.(input.url);
    return resolveProxyFor(input.url, { mode: 'system', excludes: proxy.excludes }, { resolveSystem: () => pac });
  }
  const config: ProxyConfig = {
    mode: 'manual',
    host: proxy.host ?? '',
    port: proxy.port ?? 0,
    excludes: proxy.excludes,
    ...(proxy.username !== undefined ? { username: proxy.username } : {}),
    ...(proxy.passwordRef !== undefined ? { passwordRef: proxy.passwordRef } : {}),
  };
  const password = proxy.passwordRef !== undefined && proxy.passwordRef.length > 0 ? await input.getSecret(proxy.passwordRef) : undefined;
  return resolveProxyFor(input.url, config, { ...(password !== undefined ? { password } : {}) });
}

export interface MainHttpDeps {
  readonly preferences: () => Preferences;
  readonly picks?: ReadPicks;
  readonly getSecret: (ref: string) => Promise<string | undefined>;
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
}

/** What a project-free send from main passes to `sendHttp` beyond the request itself. */
export async function mainHttpOptions(url: string, deps: MainHttpDeps): Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }> {
  const preferences = deps.preferences();
  const ca = await resolveTrustAnchors({ caBundlePath: preferences.ssl.caBundlePath, roots: [], picks: deps.picks });
  const proxy = await resolveProxy({
    url,
    proxy: preferences.proxy,
    getSecret: deps.getSecret,
    ...(deps.resolveSystemProxy !== undefined ? { resolveSystemProxy: deps.resolveSystemProxy } : {}),
  });
  return {
    ...(ca !== undefined ? { tls: { ca: [...ca], minVersion: preferences.ssl.minVersion } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
  };
}
```

Then in `apps/desktop/src/main/project-host.ts` replace the bodies of `trustAnchors()` and
`proxyFor()` with delegations (keep both JSDoc blocks):

```ts
  private async trustAnchors(): Promise<readonly string[] | undefined> {
    const open = this.open;
    if (open === undefined) return undefined;
    return resolveTrustAnchors({ caBundlePath: this.prefs()?.ssl.caBundlePath, roots: [open.dir], picks: this.picks });
  }

  async proxyFor(url: string): Promise<ProxyOptionsWire | undefined> {
    const proxy = this.prefs()?.proxy;
    if (proxy === undefined) return undefined;
    return resolveProxy({
      url,
      proxy,
      getSecret: (ref) => this.getSecret(ref),
      ...(this.resolveSystemProxy !== undefined ? { resolveSystemProxy: this.resolveSystemProxy } : {}),
    });
  }
```

Remove the now-unused imports (`isExcluded`, `resolveProxyFor`, `splitPemBundle`, `ProxyConfig`,
`readFile` if nothing else uses it) and add `import { resolveProxy, resolveTrustAnchors } from './network-options.js';`.
`ProxyOptions` and `ProxyOptionsWire` are the same shape; if typecheck disagrees, return
`resolveProxy(...) as Promise<ProxyOptionsWire | undefined>` with a one-line comment.

Run: `nice pnpm vitest run --project desktop apps/desktop/test/network-options.test.ts apps/desktop/test/project-host*.test.ts apps/desktop/test/ipc-request-trust.test.ts`
Expected: PASS; the existing trust/proxy tests are unchanged.

- [ ] **Step 3: `server-client.ts`**

```ts
/**
 * The desktop's HTTP client for Wirebench Server (identity spec §5.3): one method per endpoint
 * the sign-in flow uses, each parsed with the engine's shared schema so a server that drifts is
 * an error here, not a crash in the renderer. Every call goes through the engine's `sendHttp`
 * with the same CA bundle and proxy a request send would use. The token is a parameter, never
 * a field: this class holds no state and can serve several servers.
 */
import {
  invitationLookupResponseSchema,
  meResponseSchema,
  metaResponseSchema,
  oidcStartResponseSchema,
  SERVER_API_VERSION,
  SERVER_NAME,
  sendHttp,
  signInResponseSchema,
  WirebenchError,
  type HttpExchange,
  type HttpRequest,
  type InvitationAcceptRequest,
  type InvitationLookupResponse,
  type LocalSignInRequest,
  type MeResponse,
  type MetaResponse,
  type OidcCompleteRequest,
  type OidcStartRequest,
  type OidcStartResponse,
  type ProxyOptions,
  type SignInResponse,
  type TlsOptions,
} from '@wirebench/engine';
import type { z } from 'zod';

export interface ServerClientDeps {
  /** The engine's `sendHttp` by default; a stub in tests. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  /** TLS and proxy for a URL: `mainHttpOptions` in the app. */
  readonly options?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The origin of what the user typed: scheme, host, port. Anything that is not http(s) is refused. */
export function normalizeServerUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new WirebenchError('server-url-invalid', 'Enter the server address as a URL, such as https://wirebench.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WirebenchError('server-url-invalid', 'The server address must start with https:// or http://');
  }
  return url.origin;
}

interface Call<T> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly schema?: z.ZodType<T>;
  readonly body?: unknown;
  readonly token?: string;
}

export class ServerClient {
  private readonly send: (request: HttpRequest) => Promise<HttpExchange>;

  constructor(private readonly deps: ServerClientDeps = {}) {
    this.send = deps.send ?? sendHttp;
  }

  async meta(url: string): Promise<MetaResponse> {
    const raw = await this.call<unknown>(url, { method: 'GET', path: '/api/v1/meta' });
    const shape = raw as { readonly name?: unknown; readonly apiVersion?: unknown } | null;
    if (typeof shape !== 'object' || shape === null || shape.name !== SERVER_NAME) {
      throw new WirebenchError('server-not-wirebench', 'That address is not a Wirebench Server');
    }
    if (shape.apiVersion !== SERVER_API_VERSION) {
      throw new WirebenchError('server-api-version', `This server speaks API version ${String(shape.apiVersion)}; this app needs ${String(SERVER_API_VERSION)}. Update Wirebench.`);
    }
    return parseOrBad(metaResponseSchema, raw);
  }

  signInLocal(url: string, body: LocalSignInRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/local/sign-in', body, schema: signInResponseSchema });
  }

  startOidc(url: string, body: OidcStartRequest): Promise<OidcStartResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/start', body, schema: oidcStartResponseSchema });
  }

  completeOidc(url: string, body: OidcCompleteRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/auth/oidc/complete', body, schema: signInResponseSchema });
  }

  async signOut(url: string, token: string): Promise<void> {
    await this.call<unknown>(url, { method: 'POST', path: '/api/v1/auth/sign-out', token });
  }

  me(url: string, token: string): Promise<MeResponse> {
    return this.call(url, { method: 'GET', path: '/api/v1/me', token, schema: meResponseSchema });
  }

  lookupInvitation(url: string, secret: string): Promise<InvitationLookupResponse> {
    return this.call(url, { method: 'GET', path: `/api/v1/invitations/lookup?secret=${encodeURIComponent(secret)}`, schema: invitationLookupResponseSchema });
  }

  acceptInvitation(url: string, body: InvitationAcceptRequest): Promise<SignInResponse> {
    return this.call(url, { method: 'POST', path: '/api/v1/invitations/accept', body, schema: signInResponseSchema });
  }

  private async call<T>(url: string, call: Call<T>): Promise<T> {
    const origin = normalizeServerUrl(url);
    const options = (await this.deps.options?.(origin)) ?? {};
    const payload = call.body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(call.body));
    let exchange: HttpExchange;
    try {
      exchange = await this.send({
        url: `${origin}${call.path}`,
        method: call.method,
        headers: {
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(call.token !== undefined ? { authorization: `Bearer ${call.token}` } : {}),
        },
        ...(payload !== undefined ? { body: payload } : {}),
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        followRedirects: false,
        ...(options.tls !== undefined ? { tls: options.tls } : {}),
        ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
      });
    } catch (error) {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause: error });
    }
    const text = new TextDecoder().decode(exchange.body);
    const json = parseJson(text, exchange.headers['content-type']);
    if (exchange.status >= 200 && exchange.status < 300) {
      if (call.schema === undefined) return json as T;
      return parseOrBad(call.schema, json);
    }
    const problem = json as { readonly code?: unknown; readonly message?: unknown } | undefined;
    if (typeof problem?.code === 'string' && typeof problem.message === 'string') {
      throw new WirebenchError(problem.code, problem.message, { details: { status: exchange.status } });
    }
    throw new WirebenchError('server-bad-response', `${origin} answered ${String(exchange.status)}`, { details: { status: exchange.status } });
  }
}

function parseJson(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return undefined;
  if (contentType === undefined || !contentType.includes('json')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseOrBad<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WirebenchError('server-bad-response', 'The server answered with an unexpected shape');
  return parsed.data;
}
```

`sendHttp`, `HttpExchange`, `HttpRequest`, `TlsOptions`, `ProxyOptions` are already exported from the
engine index (the OAuth2 service imports them the same way).

Run: `nice pnpm vitest run --project desktop apps/desktop/test/server-client.test.ts` → 7 passed.

- [ ] **Step 4: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add apps/desktop/src/main/network-options.ts apps/desktop/src/main/server-client.ts apps/desktop/src/main/project-host.ts apps/desktop/test/network-options.test.ts apps/desktop/test/server-client.test.ts
git commit -m "feat(desktop): server client over the engine's sendHttp, with project-free CA and proxy

The CA bundle and proxy resolvers leave ProjectHost for a module any
main-process send can use, with the same read rule (inside the project
or picked this session); the server client parses every answer with the
engine's shared schemas so a drift is an error, not a crash."
```

---

### Task 11: Desktop — `AccountService`

**Files:**
- Create: `apps/desktop/src/main/account-service.ts`, `apps/desktop/test/account-service.test.ts`

**Interfaces:**
- Produces: `AccountService` with `load()`, `list(): readonly ServerAccount[]`, `onChange(listener)`,
  `probe(url) → Promise<{ url; meta }>`, `signInLocal({ url, email, password, deviceName? })`,
  `startOidc({ url, deviceName? })`, `cancelSignIn() → { cancelled }`, `lookupInvitation({ url, secret })`,
  `acceptInvitation({ url, secret, displayName, password, deviceName? })`, `signOut(url)`, `remove(url)`,
  `tokenFor(url) → Promise<string | undefined>`, `markSignedOut(url)`, `refresh(url)`, `refreshAll()`; `ACCOUNTS_FILE`, `SIGN_IN_TIMEOUT_MS`,
  `TOKEN_LABEL_PREFIX = 'wirebench-server:'`; errors `account-sign-in-pending`, `account-sign-in-timeout`,
  `account-sign-in-cancelled`, `account-sign-in-failed`, `account-unknown-server`.
- Consumes: `ServerClient`, `normalizeServerUrl` (Task 10), `startLoopbackCallback` (Task 9),
  `SecretStore` (`set(value, { label })`, `get(ref)`, `delete(ref)`), engine `pkce`,
  `parseAccountsFile`, `accountsFileSchema`, `ServerAccount`, `AccountsFile` (Task 1), `yaml`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/account-service.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { parse as parseYaml } from 'yaml';
import { AccountService, ACCOUNTS_FILE, TOKEN_LABEL_PREFIX } from '../src/main/account-service.js';
import type { LoopbackCallback } from '../src/main/loopback-callback.js';
import type { ServerClient } from '../src/main/server-client.js';

const URL_A = 'https://wb.test';
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: true };
const TOKEN = `wbs_${'A'.repeat(43)}`;
const META = { name: 'wirebench-server', version: '1', apiVersion: 1, publicUrl: URL_A, auth: { local: true, oidc: true, oidcDisplayName: 'Corp' }, capabilities: [] };

/** An in-memory SecretStore: refs in, values out, labels kept. */
function fakeSecrets() {
  const entries = new Map<string, { value: string; label?: string }>();
  let n = 0;
  return {
    entries,
    set: vi.fn(async (value: string, opts?: { label?: string }) => {
      const ref = `sec_${String(++n).padStart(26, '0')}`;
      entries.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return ref;
    }),
    get: vi.fn(async (ref: string) => entries.get(ref)?.value),
    delete: vi.fn(async (ref: string) => entries.delete(ref)),
  };
}

function fakeClient(overrides: Partial<Record<keyof ServerClient, unknown>> = {}): ServerClient {
  return {
    meta: vi.fn().mockResolvedValue(META),
    signInLocal: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    startOidc: vi.fn().mockResolvedValue({ flowId: 'flow-1', authorizationUrl: 'https://idp.test/authorize?x=1', expiresAt: '2026-09-24T12:10:00.000Z' }),
    completeOidc: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    signOut: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue({ user: USER, methods: { local: true, oidc: [] } }),
    lookupInvitation: vi.fn().mockResolvedValue({ email: 'alice@example.com', methods: { local: true, oidc: false } }),
    acceptInvitation: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    ...overrides,
  } as unknown as ServerClient;
}

/** A loopback whose result the test settles by hand. */
function fakeLoopback() {
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
  const listener: LoopbackCallback = {
    redirectUri: 'http://127.0.0.1:49152/callback',
    port: 49152,
    result: new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }),
    cancel: vi.fn(() => settle?.reject(new WirebenchError('loopback-cancelled', 'cancelled'))),
  };
  return { listener, start: vi.fn(async () => listener), answer: (params: Record<string, string>) => settle?.resolve(new URLSearchParams(params)) };
}

describe('AccountService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-accounts-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const service = (client = fakeClient(), secrets = fakeSecrets(), loopback = fakeLoopback(), openExternal = vi.fn().mockResolvedValue(undefined)) =>
    new AccountService({ userDataDir: dir, client, secrets, loopback: loopback.start, openExternal, defaultDeviceName: () => 'test-host', now: () => new Date('2026-09-24T12:00:00.000Z') });

  it('probe normalises the URL and returns meta', async () => {
    const client = fakeClient();
    expect(await service(client).probe(' https://WB.test/path ')).toEqual({ url: URL_A, meta: META });
    expect(client.meta).toHaveBeenCalledWith(URL_A);
  });

  it('local sign-in stores the token in the secret store under the server label and the account in accounts.yaml, never the token', async () => {
    const client = fakeClient();
    const secrets = fakeSecrets();
    const changed = vi.fn();
    const s = service(client, secrets);
    s.onChange(changed);
    const account = await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    expect(client.signInLocal).toHaveBeenCalledWith(URL_A, { email: 'alice@example.com', password: 'pw'.repeat(6), device: { name: 'test-host' } });
    expect(account).toMatchObject({ url: URL_A, userId: USER.id, email: 'alice@example.com', displayName: 'Alice', deviceName: 'test-host', addedAt: '2026-09-24T12:00:00.000Z' });
    expect(account.signedOut).toBeUndefined();
    expect([...secrets.entries.values()]).toEqual([{ value: TOKEN, label: `${TOKEN_LABEL_PREFIX}${URL_A}` }]);
    const file = parseYaml(await readFile(join(dir, ACCOUNTS_FILE), 'utf8')) as { version: number; servers: { tokenRef: string }[] };
    expect(file.version).toBe(1);
    expect(file.servers[0]?.tokenRef).toMatch(/^sec_/);
    expect(JSON.stringify(file)).not.toContain(TOKEN);
    expect(changed).toHaveBeenCalledWith([expect.objectContaining({ url: URL_A })]);
    expect(await s.tokenFor(URL_A)).toBe(TOKEN);
  });

  it('a second sign-in to the same server replaces the entry and the old secret', async () => {
    const secrets = fakeSecrets();
    const s = service(fakeClient(), secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6), deviceName: 'first' });
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6), deviceName: 'second' });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.deviceName).toBe('second');
    expect(secrets.entries.size).toBe(1);
  });

  it('OIDC: starts the flow with the loopback port, opens the browser at the server’s URL, completes with the grant', async () => {
    const client = fakeClient();
    const loopback = fakeLoopback();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const s = service(client, fakeSecrets(), loopback, openExternal);
    const pending = s.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://idp.test/authorize?x=1'));
    const startBody = (client.startOidc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { codeChallenge: string; loopbackPort: number };
    expect(startBody.loopbackPort).toBe(49152);
    expect(startBody.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    loopback.answer({ flow: 'flow-1', grant: 'G'.repeat(43) });
    const account = await pending;
    expect(account.email).toBe('alice@example.com');
    const completeBody = (client.completeOidc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { flowId: string; grant: string; codeVerifier: string };
    expect(completeBody).toMatchObject({ flowId: 'flow-1', grant: 'G'.repeat(43) });
    expect(completeBody.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('OIDC: an error on the loopback becomes that code; cancel and timeout have their own; one flow at a time', async () => {
    const loopback = fakeLoopback();
    const s = service(fakeClient(), fakeSecrets(), loopback);
    const pending = s.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(loopback.start).toHaveBeenCalled());
    await expect(s.startOidc({ url: URL_A })).rejects.toMatchObject({ code: 'account-sign-in-pending' });
    loopback.answer({ flow: 'flow-1', error: 'identity-not-invited' });
    await expect(pending).rejects.toMatchObject({ code: 'identity-not-invited' });

    const second = fakeLoopback();
    const s2 = service(fakeClient(), fakeSecrets(), second);
    const pending2 = s2.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(second.start).toHaveBeenCalled());
    expect(s2.cancelSignIn()).toEqual({ cancelled: true });
    await expect(pending2).rejects.toMatchObject({ code: 'account-sign-in-cancelled' });
    expect(s2.cancelSignIn()).toEqual({ cancelled: false });
  });

  it('sign out revokes on the server, deletes the secret and keeps the entry as signed out; a failed server call still clears', async () => {
    const client = fakeClient({ signOut: vi.fn().mockRejectedValue(new WirebenchError('server-unreachable', 'down')) });
    const secrets = fakeSecrets();
    const s = service(client, secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    await s.signOut(URL_A);
    expect(client.signOut).toHaveBeenCalledWith(URL_A, TOKEN);
    expect(secrets.entries.size).toBe(0);
    expect(s.list()[0]).toMatchObject({ url: URL_A, signedOut: true });
    expect(await s.tokenFor(URL_A)).toBeUndefined();
    await expect(s.signOut('https://unknown.test')).rejects.toMatchObject({ code: 'account-unknown-server' });
  });

  it('remove revokes when signed in and drops the entry; markSignedOut flags an account the server no longer knows', async () => {
    const client = fakeClient();
    const s = service(client);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });
    s.markSignedOut(URL_A);
    expect(s.list()[0]?.signedOut).toBe(true);
    await s.remove(URL_A);
    expect(client.signOut).not.toHaveBeenCalled(); // already signed out: nothing to revoke
    expect(s.list()).toEqual([]);
    expect(parseYaml(await readFile(join(dir, ACCOUNTS_FILE), 'utf8'))).toEqual({ version: 1, servers: [] });
  });

  it('accepts an invitation the same way local sign-in does, and looks one up', async () => {
    const client = fakeClient();
    const s = service(client);
    expect((await s.lookupInvitation({ url: URL_A, secret: 'S'.repeat(43) })).email).toBe('alice@example.com');
    const account = await s.acceptInvitation({ url: URL_A, secret: 'S'.repeat(43), displayName: 'Alice', password: 'pw'.repeat(6) });
    expect(account.userId).toBe(USER.id);
    expect(client.acceptInvitation).toHaveBeenCalledWith(URL_A, { secret: 'S'.repeat(43), displayName: 'Alice', password: 'pw'.repeat(6), device: { name: 'test-host' } });
  });

  it('refresh marks the account signed out on identity-unauthenticated, updates the name on success, and ignores an outage', async () => {
    const client = fakeClient();
    const secrets = fakeSecrets();
    const s = service(client, secrets);
    await s.signInLocal({ url: URL_A, email: 'alice@example.com', password: 'pw'.repeat(6) });

    (client.me as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ user: { ...USER, displayName: 'Alice L.' }, methods: { local: true, oidc: [] } });
    await s.refreshAll();
    expect(s.list()[0]?.displayName).toBe('Alice L.');

    (client.me as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new WirebenchError('server-unreachable', 'down'));
    await s.refresh(URL_A);
    expect(s.list()[0]?.signedOut).toBeUndefined();

    (client.me as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new WirebenchError('identity-unauthenticated', 'revoked'));
    await s.refresh(URL_A);
    expect(s.list()[0]?.signedOut).toBe(true);
    expect(secrets.entries.size).toBe(0);
    expect(client.me).toHaveBeenCalledTimes(3);
    await s.refresh(URL_A); // signed out: no call
    expect(client.me).toHaveBeenCalledTimes(3);
  });

  it('load reads an existing file and tolerates a malformed one', async () => {
    await writeFile(join(dir, ACCOUNTS_FILE), 'version: 1\nservers:\n  - url: https://wb.test\n    userId: u\n    email: a@b.co\n    displayName: A\n    deviceName: d\n    tokenRef: sec_00000000000000000000000001\n    addedAt: "2026-09-24T12:00:00.000Z"\n');
    const s = service();
    await s.load();
    expect(s.list()).toHaveLength(1);
    await writeFile(join(dir, ACCOUNTS_FILE), 'nonsense: [');
    const broken = service();
    await broken.load();
    expect(broken.list()).toEqual([]);
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/account-service.test.ts` → FAIL.

- [ ] **Step 2: `account-service.ts`**

```ts
/**
 * Who this installation is signed in as, per server (identity spec §3.8, §4.3, §5.3). Main owns
 * all of it: `accounts.yaml` (no token inside — only a secret-store ref), the token itself in the
 * secret store under `wirebench-server:<url>`, the browser hand-off for OIDC, and the rule that a
 * server answering `identity-unauthenticated` marks the account signed out rather than looping.
 * The renderer receives `ServerAccount` minus `tokenRef` (see `ipc/account.ts`).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNTS_FILE_VERSION,
  parseAccountsFile,
  pkce,
  WirebenchError,
  type AccountsFile,
  type InvitationLookupResponse,
  type MetaResponse,
  type ServerAccount,
  type SignInResponse,
} from '@wirebench/engine';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { startLoopbackCallback, type LoopbackCallback } from './loopback-callback.js';
import { normalizeServerUrl, type ServerClient } from './server-client.js';

export const ACCOUNTS_FILE = 'accounts.yaml';
export const TOKEN_LABEL_PREFIX = 'wirebench-server:';
/** As the OAuth2 request flow: five minutes for the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface AccountServiceDeps {
  readonly userDataDir: string;
  readonly client: ServerClient;
  readonly secrets: {
    set(value: string, opts?: { label?: string }): Promise<string>;
    get(ref: string): Promise<string | undefined>;
    delete(ref: string): Promise<boolean>;
  };
  /** The loopback helper; injected so tests settle the browser's answer by hand. */
  readonly loopback?: typeof startLoopbackCallback;
  /** Opens the IdP's URL in the user's browser (already gated by `isExternalUrlAllowed` in the app). */
  readonly openExternal: (url: string) => Promise<void>;
  readonly defaultDeviceName?: () => string;
  readonly now?: () => Date;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The sign-in codes the server hands back on the loopback, in the app's words. */
const LOOPBACK_MESSAGES: Readonly<Record<string, string>> = {
  'identity-not-invited': 'No account or open invitation exists for this email. Ask a server admin to invite you.',
  'identity-email-unverified': 'The identity provider did not confirm your email address, so it cannot be linked.',
  'identity-user-disabled': 'This account is disabled.',
  'identity-oidc-refused': 'The identity provider refused the sign-in.',
  'identity-oidc-failed': 'The identity provider did not complete the sign-in.',
};

export class AccountService {
  private readonly file: string;
  private accounts: AccountsFile = { version: ACCOUNTS_FILE_VERSION, servers: [] };
  private pending: LoopbackCallback | undefined;
  private readonly listeners = new Set<(servers: readonly ServerAccount[]) => void>();

  constructor(private readonly deps: AccountServiceDeps) {
    this.file = join(deps.userDataDir, ACCOUNTS_FILE);
  }

  async load(): Promise<void> {
    let document: unknown;
    try {
      document = parseYaml(await readFile(this.file, 'utf8'));
    } catch {
      document = undefined;
    }
    this.accounts = parseAccountsFile(document);
  }

  list(): readonly ServerAccount[] {
    return this.accounts.servers;
  }

  onChange(listener: (servers: readonly ServerAccount[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async probe(url: string): Promise<{ readonly url: string; readonly meta: MetaResponse }> {
    const origin = normalizeServerUrl(url);
    return { url: origin, meta: await this.deps.client.meta(origin) };
  }

  async signInLocal(input: { readonly url: string; readonly email: string; readonly password: string; readonly deviceName?: string }): Promise<ServerAccount> {
    const origin = normalizeServerUrl(input.url);
    const deviceName = this.deviceName(input.deviceName);
    const response = await this.deps.client.signInLocal(origin, { email: input.email, password: input.password, device: { name: deviceName } });
    return this.store(origin, response, deviceName);
  }

  async lookupInvitation(input: { readonly url: string; readonly secret: string }): Promise<InvitationLookupResponse> {
    return this.deps.client.lookupInvitation(normalizeServerUrl(input.url), input.secret);
  }

  async acceptInvitation(input: {
    readonly url: string;
    readonly secret: string;
    readonly displayName: string;
    readonly password: string;
    readonly deviceName?: string;
  }): Promise<ServerAccount> {
    const origin = normalizeServerUrl(input.url);
    const deviceName = this.deviceName(input.deviceName);
    const response = await this.deps.client.acceptInvitation(origin, {
      secret: input.secret,
      displayName: input.displayName,
      password: input.password,
      device: { name: deviceName },
    });
    return this.store(origin, response, deviceName);
  }

  /**
   * The OIDC hand-off (§3.8): open the loopback first because the server needs its port, then
   * ask the server to start a flow, send the browser to the URL the server returned (never one
   * we built), wait for the grant on the loopback, and trade it plus the PKCE verifier for a
   * device token. One flow at a time, as the OAuth2 request flow behaves.
   */
  async startOidc(input: { readonly url: string; readonly deviceName?: string }): Promise<ServerAccount> {
    if (this.pending !== undefined) throw new WirebenchError('account-sign-in-pending', 'A sign-in is already waiting for the browser');
    const origin = normalizeServerUrl(input.url);
    const deviceName = this.deviceName(input.deviceName);
    const pair = pkce();
    let flowId: string | undefined;
    const listener = await (this.deps.loopback ?? startLoopbackCallback)({
      expected: { name: 'flow', value: () => flowId },
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      describe: (params) =>
        params.get('grant') !== null
          ? { ok: true, message: 'Signed in. You can close this tab and go back to Wirebench.' }
          : { ok: false, message: `Wirebench could not sign you in (${params.get('error') ?? 'no grant'}). You can close this tab.` },
    });
    this.pending = listener;
    void listener.result.catch(() => undefined);
    try {
      const started = await this.deps.client.startOidc(origin, { device: { name: deviceName }, codeChallenge: pair.challenge, loopbackPort: listener.port });
      flowId = started.flowId;
      await this.deps.openExternal(started.authorizationUrl);
      const params = await listener.result;
      const error = params.get('error');
      if (error !== null) throw new WirebenchError(error, LOOPBACK_MESSAGES[error] ?? 'The sign-in was refused.');
      const grant = params.get('grant');
      if (grant === null) throw new WirebenchError('account-sign-in-failed', 'The browser came back without a grant.');
      const response = await this.deps.client.completeOidc(origin, { flowId: started.flowId, grant, codeVerifier: pair.verifier });
      return await this.store(origin, response, deviceName);
    } catch (error) {
      listener.cancel();
      if (error instanceof WirebenchError && error.code === 'loopback-timeout') throw new WirebenchError('account-sign-in-timeout', 'The sign-in was not completed in time');
      if (error instanceof WirebenchError && error.code === 'loopback-cancelled') throw new WirebenchError('account-sign-in-cancelled', 'The sign-in was cancelled');
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  cancelSignIn(): { readonly cancelled: boolean } {
    if (this.pending === undefined) return { cancelled: false };
    this.pending.cancel();
    return { cancelled: true };
  }

  /** Best effort on the server; the token is gone locally either way (§3.8). */
  async signOut(url: string): Promise<void> {
    const origin = normalizeServerUrl(url);
    const account = this.find(origin);
    if (account === undefined) throw new WirebenchError('account-unknown-server', `No account for ${origin}`);
    const token = await this.deps.secrets.get(account.tokenRef);
    if (token !== undefined && account.signedOut !== true) {
      await this.deps.client.signOut(origin, token).catch(() => undefined);
    }
    await this.deps.secrets.delete(account.tokenRef);
    await this.replace(origin, { ...account, signedOut: true });
  }

  async remove(url: string): Promise<void> {
    const origin = normalizeServerUrl(url);
    const account = this.find(origin);
    if (account === undefined) return;
    if (account.signedOut !== true) await this.signOut(origin);
    await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
    await this.persist({ ...this.accounts, servers: this.accounts.servers.filter((server) => server.url !== origin) });
  }

  /** The device token for a server, for the modules that call it; `undefined` when signed out. */
  async tokenFor(url: string): Promise<string | undefined> {
    const account = this.find(normalizeServerUrl(url));
    if (account === undefined || account.signedOut === true) return undefined;
    return this.deps.secrets.get(account.tokenRef);
  }

  /** The server said `identity-unauthenticated`: the account shows as signed out, nothing retries. */
  markSignedOut(url: string): void {
    const account = this.find(normalizeServerUrl(url));
    if (account === undefined || account.signedOut === true) return;
    void this.replace(account.url, { ...account, signedOut: true });
  }

  /**
   * Asks the server who the token belongs to. `identity-unauthenticated` (revoked, expired,
   * device removed) marks the account signed out (§3.8); a fresh display name or email is taken
   * over; any other failure — offline, a proxy in the way — changes nothing, so a laptop on a
   * train does not lose its session. Never retried: one call, one answer.
   */
  async refresh(url: string): Promise<void> {
    const account = this.find(normalizeServerUrl(url));
    if (account === undefined || account.signedOut === true) return;
    const token = await this.deps.secrets.get(account.tokenRef);
    if (token === undefined) {
      await this.replace(account.url, { ...account, signedOut: true });
      return;
    }
    try {
      const me = await this.deps.client.me(account.url, token);
      if (me.user.email !== account.email || me.user.displayName !== account.displayName) {
        await this.replace(account.url, { ...account, email: me.user.email, displayName: me.user.displayName });
      }
    } catch (error) {
      if (error instanceof WirebenchError && error.code === 'identity-unauthenticated') {
        await this.deps.secrets.delete(account.tokenRef).catch(() => undefined);
        await this.replace(account.url, { ...account, signedOut: true });
      }
    }
  }

  /** {@link refresh} for every signed-in account, in parallel; called once after {@link load}. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.accounts.servers.filter((server) => server.signedOut !== true).map((server) => this.refresh(server.url)));
  }

  private deviceName(given: string | undefined): string {
    const name = given?.trim();
    return name !== undefined && name.length > 0 ? name : (this.deps.defaultDeviceName ?? hostname)();
  }

  private find(origin: string): ServerAccount | undefined {
    return this.accounts.servers.find((server) => server.url === origin);
  }

  private async store(origin: string, response: SignInResponse, deviceName: string): Promise<ServerAccount> {
    const previous = this.find(origin);
    if (previous !== undefined) await this.deps.secrets.delete(previous.tokenRef).catch(() => undefined);
    const tokenRef = await this.deps.secrets.set(response.token, { label: `${TOKEN_LABEL_PREFIX}${origin}` });
    const account: ServerAccount = {
      url: origin,
      userId: response.user.id,
      email: response.user.email,
      displayName: response.user.displayName,
      deviceName,
      tokenRef,
      addedAt: previous?.addedAt ?? (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    await this.replace(origin, account);
    return account;
  }

  private async replace(origin: string, account: ServerAccount): Promise<void> {
    const others = this.accounts.servers.filter((server) => server.url !== origin);
    await this.persist({ ...this.accounts, servers: [...others, account].sort((a, b) => a.url.localeCompare(b.url)) });
  }

  private async persist(next: AccountsFile): Promise<void> {
    await mkdir(this.deps.userDataDir, { recursive: true });
    await writeAtomic(this.file, stringifyYaml(next, { lineWidth: 0 }));
    this.accounts = next;
    for (const listener of this.listeners) listener(next.servers);
  }
}
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/account-service.test.ts` → 10 passed.

- [ ] **Step 3: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add apps/desktop/src/main/account-service.ts apps/desktop/test/account-service.test.ts
git commit -m "feat(desktop): AccountService owns accounts.yaml, the token and the OIDC hand-off

The file names a secret-store ref and never the token; the browser is
opened only at the URL the server returned; a server that no longer
knows the token marks the account signed out instead of retrying."
```

---

### Task 12: Desktop — IPC channels, wire types and main wiring

**Files:**
- Create: `apps/desktop/src/main/ipc/account.ts`, `apps/desktop/test/ipc-account.test.ts`
- Modify: `apps/desktop/src/shared/wire-types.ts` (append), `apps/desktop/src/shared/ipc.ts`
  (`channels.account`, `events.account`), `apps/desktop/src/main/index.ts`,
  `apps/desktop/test/mocks/wirebench-api.ts` (defaults for `account.*`)

**Interfaces:**
- Produces: wire schemas `accountWireSchema`, `AccountWire`, `serverMetaWireSchema`, `accountListResponseSchema`,
  `accountProbeRequestSchema`, `accountProbeResponseSchema`, `accountSignInLocalRequestSchema`,
  `accountStartOidcRequestSchema`, `accountResponseSchema`, `accountLookupInvitationRequestSchema`,
  `accountLookupInvitationResponseSchema`, `accountAcceptInvitationRequestSchema`, `accountUrlRequestSchema`,
  `accountCancelResponseSchema`, `accountChangedEventSchema`; channels `account.list`, `account.probe`,
  `account.signInLocal`, `account.startOidc`, `account.cancelSignIn`, `account.lookupInvitation`,
  `account.acceptInvitation`, `account.signOut`, `account.remove`; event `account.changed { servers }`;
  `registerAccountChannels({ accounts })`, `toAccountWire(account)`.
- Consumes: `AccountService` (Task 11), `registerHandler`, `defineChannel`, `defineEvent`.

- [ ] **Step 1: Wire types and channels**

Append to `apps/desktop/src/shared/wire-types.ts` (restated, not imported from the engine: this file
is bundled into the preload, which must not pull the engine in):

```ts
/**
 * A known server and who this installation is on it (identity spec §4.3), as the renderer sees
 * it: the secret-store ref and the token itself never cross the bridge.
 */
export const accountWireSchema = z.object({
  url: z.string(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  deviceName: z.string(),
  /** True once the server stopped accepting the token (sign-out, revocation, expiry). */
  signedOut: z.boolean(),
  addedAt: z.string(),
});
export type AccountWire = z.infer<typeof accountWireSchema>;

export const accountListResponseSchema = z.object({ servers: z.array(accountWireSchema) });
export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

/** `GET /api/v1/meta`, as far as the Sign in dialog needs it. */
export const serverMetaWireSchema = z.object({
  name: z.string(),
  version: z.string(),
  apiVersion: z.number(),
  publicUrl: z.string(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
});
export type ServerMetaWire = z.infer<typeof serverMetaWireSchema>;

export const accountUrlRequestSchema = z.object({ url: z.string() });
export const accountProbeResponseSchema = z.object({ url: z.string(), meta: serverMetaWireSchema });
export type AccountProbeResponse = z.infer<typeof accountProbeResponseSchema>;
export const accountSignInLocalRequestSchema = z.object({
  url: z.string(),
  email: z.string(),
  password: z.string(),
  deviceName: z.string().optional(),
});
export const accountStartOidcRequestSchema = z.object({ url: z.string(), deviceName: z.string().optional() });
export const accountResponseSchema = z.object({ account: accountWireSchema });
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export const accountLookupInvitationRequestSchema = z.object({ url: z.string(), secret: z.string() });
export const accountLookupInvitationResponseSchema = z.object({
  email: z.string(),
  methods: z.object({ local: z.boolean(), oidc: z.boolean() }),
});
export type AccountLookupInvitationResponse = z.infer<typeof accountLookupInvitationResponseSchema>;
export const accountAcceptInvitationRequestSchema = z.object({
  url: z.string(),
  secret: z.string(),
  displayName: z.string(),
  password: z.string(),
  deviceName: z.string().optional(),
});
export const accountCancelResponseSchema = z.object({ cancelled: z.boolean() });
export const accountChangedEventSchema = accountListResponseSchema;
export type AccountChangedEvent = z.infer<typeof accountChangedEventSchema>;
```

In `apps/desktop/src/shared/ipc.ts`, import the new schemas and add to `channels` (after `oauth2`):

```ts
  /**
   * Accounts on Wirebench Server. A password crosses exactly once, in `signInLocal` or
   * `acceptInvitation`; the token never crosses at all — main keeps it in the secret store and
   * answers with the account minus its ref.
   */
  account: {
    list: defineChannel('account.list', z.undefined(), accountListResponseSchema),
    probe: defineChannel('account.probe', accountUrlRequestSchema, accountProbeResponseSchema),
    signInLocal: defineChannel('account.signInLocal', accountSignInLocalRequestSchema, accountResponseSchema),
    /** Resolves when the browser hand-off has completed; `cancelSignIn` ends it early. */
    startOidc: defineChannel('account.startOidc', accountStartOidcRequestSchema, accountResponseSchema),
    cancelSignIn: defineChannel('account.cancelSignIn', z.undefined(), accountCancelResponseSchema),
    lookupInvitation: defineChannel('account.lookupInvitation', accountLookupInvitationRequestSchema, accountLookupInvitationResponseSchema),
    acceptInvitation: defineChannel('account.acceptInvitation', accountAcceptInvitationRequestSchema, accountResponseSchema),
    signOut: defineChannel('account.signOut', accountUrlRequestSchema, accountListResponseSchema),
    remove: defineChannel('account.remove', accountUrlRequestSchema, accountListResponseSchema),
  },
```

and to `events`:

```ts
  account: {
    /** The list of known servers changed (sign-in, sign-out, removal, a token the server refused). */
    changed: defineEvent('account.changed', accountChangedEventSchema),
  },
```

- [ ] **Step 2: Write the failing channel test**

`apps/desktop/test/ipc-account.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccount } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerAccountChannels, toAccountWire } = await import('../src/main/ipc/account.js');

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { code: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> => handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const ACCOUNT: ServerAccount = {
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  tokenRef: 'sec_00000000000000000000000001',
  addedAt: '2026-09-24T12:00:00.000Z',
};

function fakeService() {
  return {
    list: vi.fn(() => [ACCOUNT]),
    probe: vi.fn().mockResolvedValue({ url: 'https://wb.test', meta: { name: 'wirebench-server', version: '1', apiVersion: 1, publicUrl: 'https://wb.test', auth: { local: true, oidc: false }, capabilities: [] } }),
    signInLocal: vi.fn().mockResolvedValue(ACCOUNT),
    startOidc: vi.fn().mockResolvedValue(ACCOUNT),
    cancelSignIn: vi.fn(() => ({ cancelled: true })),
    lookupInvitation: vi.fn().mockResolvedValue({ email: 'alice@example.com', methods: { local: true, oidc: false } }),
    acceptInvitation: vi.fn().mockResolvedValue(ACCOUNT),
    signOut: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('account.* channels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('never lets the token ref across the bridge', () => {
    expect(toAccountWire(ACCOUNT)).toEqual({ url: 'https://wb.test', userId: 'u1', email: 'alice@example.com', displayName: 'Alice', deviceName: 'Mac', signedOut: false, addedAt: '2026-09-24T12:00:00.000Z' });
    expect(toAccountWire({ ...ACCOUNT, signedOut: true }).signedOut).toBe(true);
  });

  it('registers every channel and answers with wire shapes', async () => {
    const accounts = fakeService();
    registerAccountChannels({ accounts: accounts as never });
    expect(await invoke('account.list', undefined)).toEqual({ ok: true, value: { servers: [toAccountWire(ACCOUNT)] } });
    expect(await invoke('account.probe', { url: 'https://wb.test' })).toMatchObject({ ok: true, value: { url: 'https://wb.test', meta: { apiVersion: 1 } } });
    expect(await invoke('account.signInLocal', { url: 'https://wb.test', email: 'a', password: 'p' })).toEqual({ ok: true, value: { account: toAccountWire(ACCOUNT) } });
    expect(accounts.signInLocal).toHaveBeenCalledWith({ url: 'https://wb.test', email: 'a', password: 'p' });
    expect(await invoke('account.startOidc', { url: 'https://wb.test' })).toMatchObject({ ok: true });
    expect(await invoke('account.cancelSignIn', undefined)).toEqual({ ok: true, value: { cancelled: true } });
    expect(await invoke('account.lookupInvitation', { url: 'https://wb.test', secret: 's' })).toMatchObject({ ok: true, value: { email: 'alice@example.com' } });
    expect(await invoke('account.acceptInvitation', { url: 'https://wb.test', secret: 's', displayName: 'A', password: 'p' })).toMatchObject({ ok: true });
    expect(await invoke('account.signOut', { url: 'https://wb.test' })).toEqual({ ok: true, value: { servers: [toAccountWire(ACCOUNT)] } });
    expect(await invoke('account.remove', { url: 'https://wb.test' })).toEqual({ ok: true, value: { servers: [toAccountWire(ACCOUNT)] } });
  });

  it('answers a WirebenchError from the service as a failed envelope with its code', async () => {
    const { WirebenchError } = await import('@wirebench/engine');
    const accounts = fakeService();
    accounts.signInLocal.mockRejectedValue(new WirebenchError('identity-invalid-credentials', 'nope'));
    registerAccountChannels({ accounts: accounts as never });
    const result = await invoke('account.signInLocal', { url: 'https://wb.test', email: 'a', password: 'p' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('identity-invalid-credentials');
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-account.test.ts` → FAIL.

- [ ] **Step 3: `ipc/account.ts`**

```ts
/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password once and
 * gets an account back; the token and its secret-store ref stay in main.
 */
import type { ServerAccount } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { AccountWire } from '../../shared/wire-types.js';
import type { AccountService } from '../account-service.js';
import { registerHandler } from './register.js';

export interface AccountChannelDeps {
  readonly accounts: Pick<
    AccountService,
    'list' | 'probe' | 'signInLocal' | 'startOidc' | 'cancelSignIn' | 'lookupInvitation' | 'acceptInvitation' | 'signOut' | 'remove'
  >;
}

/** Everything but the secret-store ref; `signedOut` becomes a plain boolean. */
export function toAccountWire(account: ServerAccount): AccountWire {
  return {
    url: account.url,
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    deviceName: account.deviceName,
    signedOut: account.signedOut === true,
    addedAt: account.addedAt,
  };
}

export function registerAccountChannels(deps: AccountChannelDeps): void {
  const servers = (): { servers: AccountWire[] } => ({ servers: deps.accounts.list().map(toAccountWire) });

  registerHandler(channels.account.list, () => Promise.resolve(servers()));
  registerHandler(channels.account.probe, (request) => deps.accounts.probe(request.url));
  registerHandler(channels.account.signInLocal, async (request) => ({ account: toAccountWire(await deps.accounts.signInLocal(request)) }));
  registerHandler(channels.account.startOidc, async (request) => ({ account: toAccountWire(await deps.accounts.startOidc(request)) }));
  registerHandler(channels.account.cancelSignIn, () => Promise.resolve(deps.accounts.cancelSignIn()));
  registerHandler(channels.account.lookupInvitation, (request) => deps.accounts.lookupInvitation(request));
  registerHandler(channels.account.acceptInvitation, async (request) => ({ account: toAccountWire(await deps.accounts.acceptInvitation(request)) }));
  registerHandler(channels.account.signOut, async (request) => {
    await deps.accounts.signOut(request.url);
    return servers();
  });
  registerHandler(channels.account.remove, async (request) => {
    await deps.accounts.remove(request.url);
    return servers();
  });
}
```

(`exactOptionalPropertyTypes`: the request objects carry `deviceName?: string | undefined` from zod;
if the service's `deviceName?: string` refuses them, spread conditionally:
`{ url: request.url, email: request.email, password: request.password, ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}) }`.)

- [ ] **Step 4: Wire main and the renderer test mock**

`apps/desktop/src/main/index.ts`:
- imports: `hostname` from `node:os`, `AccountService` from `./account-service.js`, `ServerClient`
  from `./server-client.js`, `mainHttpOptions` from `./network-options.js`,
  `registerAccountChannels, toAccountWire` from `./ipc/account.js`;
- after `oauth2Service` (line ~118):

```ts
/** Opens an IdP URL for the server sign-in: the same gate the OAuth2 request flow uses. */
const openExternalChecked = async (url: string): Promise<void> => {
  if (!isExternalUrlAllowed(url)) {
    throw new WirebenchError('external-url-refused', 'That sign-in URL is not an http(s) address');
  }
  await shell.openExternal(url);
};
const serverClient = new ServerClient({
  options: (url) =>
    mainHttpOptions(url, {
      preferences: () => preferencesService.get(),
      picks: dialogPicks,
      getSecret: secretsFor(undefined),
      resolveSystemProxy: async (target) => await session.defaultSession.resolveProxy(target).catch(() => undefined),
    }),
});
const accountService = new AccountService({
  userDataDir: app.getPath('userData'),
  client: serverClient,
  secrets: secretStore,
  openExternal: openExternalChecked,
  defaultDeviceName: hostname,
});
```

(and have `oauth2Service`'s `openExternal` call `openExternalChecked` too, so the gate is spelled
once; `preferencesService` and `dialogPicks` are declared later in the file — move these two
declarations after them, keeping the order the file already uses for services that depend on each
other);

- in `whenReady`, next to `registerOAuth2Channels`:

```ts
  registerAccountChannels({ accounts: accountService });
  accountService.onChange((servers) => broadcast(events.account.changed, { servers: servers.map(toAccountWire) }));
  // One `GET /me` per signed-in account at launch, so a token revoked while the app was closed
  // shows as signed out now rather than on the first action; no account, no call (§3.8).
  void accountService.load().then(() => accountService.refreshAll());
```

`apps/desktop/test/mocks/wirebench-api.ts`: add to `defaults`:

```ts
    account: {
      list: vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } }),
      probe: fail('account.probe'),
      signInLocal: fail('account.signInLocal'),
      startOidc: fail('account.startOidc'),
      cancelSignIn: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: false } }),
      lookupInvitation: fail('account.lookupInvitation'),
      acceptInvitation: fail('account.acceptInvitation'),
      signOut: fail('account.signOut'),
      remove: fail('account.remove'),
    },
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-account.test.ts apps/desktop/test/build-api.test.ts apps/desktop/test/ipc-oauth2.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/account.ts apps/desktop/src/main/index.ts apps/desktop/test/ipc-account.test.ts apps/desktop/test/mocks/wirebench-api.ts
git commit -m "feat(desktop): account.* IPC channels and the account.changed event

Nine channels, one event; the renderer never receives the token or its
secret-store ref, and a password crosses the bridge exactly once."
```

---

### Task 13: Renderer — account store, `Account` commands and the Sign in dialog

**Files:**
- Create: `apps/desktop/src/renderer/state/account.ts`, `apps/desktop/src/renderer/features/account/sign-in-dialog.tsx`,
  `apps/desktop/src/renderer/commands/register-account-commands.ts`, `apps/desktop/test/renderer/account-store.test.ts`,
  `apps/desktop/test/renderer/sign-in-dialog.test.tsx`, `apps/desktop/test/renderer/account-commands.test.ts`
- Modify: `apps/desktop/src/shared/commands.ts` (`COMMAND_IDS`, `CommandCategory`), `apps/desktop/src/shared/command-catalog.ts`,
  `apps/desktop/src/renderer/commands/register-shell-commands.ts`, `apps/desktop/src/renderer/state/ui.ts`
  (`signInDialog` state), `apps/desktop/src/renderer/shell/app-shell.tsx` (mount + subscribe),
  `docs-site/src/content/docs/reference/commands.md` (regenerated by `pnpm docs:commands`)

**Interfaces:**
- Produces: `useAccountStore` (`servers`, `loaded`, `load()`, `applyChanged(servers)`, `signOut(url)`, `remove(url)`),
  `signedInServers(servers)`, `subscribeToAccounts()`, `signInErrorMessage(error: IpcError)`;
  ui store `signInDialog: { open, url }`, `openSignInDialog(url?)`, `setSignInDialogOpen(open)`;
  commands `account.signIn`, `account.signOut`; category `'Account'`; `SignInDialog`; testids listed in Step 3.
- Consumes: channels and wire types from Task 12; `showToast(message, action?)`; `catalogEntry`, `registerCommand`.
- Rulings: the renderer omits `deviceName` on sign-in (main defaults it to the host name; a rename
  belongs to a later devices UI). `account.signOut` signs out directly when exactly one server is
  signed in and opens Preferences → Accounts otherwise. The dialog calls `ipc().account.*` itself for
  the sign-in steps — the password lives in the dialog's `useState` and nowhere else (spec §10); the
  store holds only the list.

- [ ] **Step 1: Command ids, category and catalog**

`apps/desktop/src/shared/commands.ts`: append `'account.signIn', 'account.signOut',` to `COMMAND_IDS`
(after `'project.moveToWorkspace'`) and `| 'Account'` to `CommandCategory` (after `'Sync'`).

`apps/desktop/src/shared/command-catalog.ts`, at the end of `COMMAND_CATALOG`:

```ts
  'account.signIn': {
    id: 'account.signIn',
    label: 'Account: Sign in to a server…',
    category: 'Account',
  },
  'account.signOut': {
    id: 'account.signOut',
    label: 'Account: Sign out…',
    category: 'Account',
  },
```

`apps/desktop/src/renderer/state/ui.ts`: add to the store interface, next to `joinDialogOpen`:

```ts
  /**
   * Whether the Sign in dialog is open and, when it was opened for a known server (the status
   * bar's "Sign in" on a signed-out account), which URL to start from. Transient.
   */
  readonly signInDialog: { readonly open: boolean; readonly url: string | undefined };
  readonly openSignInDialog: (url?: string) => void;
  readonly setSignInDialogOpen: (open: boolean) => void;
```

initial state `signInDialog: { open: false, url: undefined },` and the actions:

```ts
    openSignInDialog: (url) => {
      set({ signInDialog: { open: true, url } });
    },
    setSignInDialogOpen: (open) => {
      set({ signInDialog: { open, url: open ? get().signInDialog.url : undefined } });
    },
```

Run `pnpm docs:commands` to regenerate the reference page (`docs:commands --check` is part of
`pnpm check`).

- [ ] **Step 2: Write the failing store and command tests**

`apps/desktop/test/renderer/account-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const { signedInServers, signInErrorMessage, subscribeToAccounts, useAccountStore } = await import('../../src/renderer/state/account.js');
const { useUiStore } = await import('../../src/renderer/state/ui.js');

const account = (patch: Partial<AccountWire> = {}): AccountWire => ({
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
  ...patch,
});

describe('account store', () => {
  beforeEach(() => {
    useAccountStore.setState({ servers: [], loaded: false });
    showToast.mockReset();
  });
  afterEach(() => {
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
  });

  it('load reads account.list once and marks itself loaded', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account()] } });
    installWirebenchApi({ account: { list } });
    await useAccountStore.getState().load();
    expect(useAccountStore.getState().servers).toEqual([account()]);
    expect(useAccountStore.getState().loaded).toBe(true);
    expect(signedInServers(useAccountStore.getState().servers)).toHaveLength(1);
    expect(signedInServers([account({ signedOut: true })])).toEqual([]);
  });

  it('an account the server stopped accepting is toasted once, with Sign in again opening the dialog', () => {
    installWirebenchApi();
    useAccountStore.getState().applyChanged([account()]);
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, action] = showToast.mock.calls[0] as [string, { label: string; onClick: () => void }];
    expect(message).toContain('https://wb.test');
    expect(action.label).toBe('Sign in again');
    action.onClick();
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
    // The same state again is not news.
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('a sign-out the user asked for is not toasted as a surprise', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account({ signedOut: true })] } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.getState().applyChanged([account()]);
    expect(await useAccountStore.getState().signOut('https://wb.test')).toBe(true);
    // The event main broadcasts arrives after the reply; still no surprise toast.
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toBe('Signed out of https://wb.test');
    expect(useAccountStore.getState().servers[0]?.signedOut).toBe(true);
  });

  it('remove drops the entry and a failed call is toasted and reported', async () => {
    const remove = vi.fn().mockResolvedValue({ ok: false, error: { code: 'server-unreachable', message: 'down' } });
    installWirebenchApi({ account: { remove } });
    useAccountStore.getState().applyChanged([account()]);
    expect(await useAccountStore.getState().remove('https://wb.test')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('down'));
  });

  it('subscribeToAccounts feeds account.changed into the store', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    installWirebenchApi();
    Object.defineProperty(window, 'wirebench', {
      configurable: true,
      value: { ...window.wirebench, on: (name: string, handler: (payload: unknown) => void) => { handlers.set(name, handler); return () => handlers.delete(name); } },
    });
    const off = subscribeToAccounts();
    handlers.get('account.changed')?.({ servers: [account()] });
    expect(useAccountStore.getState().servers).toHaveLength(1);
    off();
    expect(handlers.has('account.changed')).toBe(false);
  });

  it('maps the codes a sign-in can fail with to copy, and falls back to the message', () => {
    expect(signInErrorMessage({ code: 'identity-invalid-credentials', message: 'x' })).toBe('Wrong email or password.');
    expect(signInErrorMessage({ code: 'server-not-wirebench', message: 'x' })).toBe('That address is not a Wirebench Server.');
    expect(signInErrorMessage({ code: 'identity-not-invited', message: 'x' })).toContain('invite you');
    expect(signInErrorMessage({ code: 'something-else', message: 'the message' })).toBe('the message');
  });
});
```

`apps/desktop/test/renderer/account-commands.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url, userId: 'u', email: `a@${new URL(url).host}`, displayName: 'A', deviceName: 'd', signedOut, addedAt: '2026-09-24T12:00:00.000Z',
});

describe('account.* commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined }, preferences: { open: false, section: undefined } });
  });

  it('account.signIn is always available and opens the dialog blank', () => {
    const command = getCommand('account.signIn')!;
    expect(command.when?.()).not.toBe(false);
    command.run();
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: undefined });
  });

  it('account.signOut is gated on a signed-in server; one server signs out, several open Accounts', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut } });
    const command = getCommand('account.signOut')!;
    expect(command.when?.()).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test', true)] });
    expect(command.when?.()).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test')] });
    expect(command.when?.()).toBe(true);
    command.run();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://one.test' }));
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test')] });
    command.run();
    expect(useUiStore.getState().preferences).toEqual({ open: true, section: 'accounts' });
  });
});
```

(`'accounts'` joins `preferencesSectionSchema` in Task 14; until then the last assertion fails
typecheck — Task 13 lands `openPreferences('accounts' as never)` in the command and Task 14 removes
the cast. Ruling: cheaper than reordering the tasks around one enum member.)

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/account-store.test.ts apps/desktop/test/renderer/account-commands.test.ts` → FAIL.

- [ ] **Step 3: `state/account.ts` and the commands**

```ts
/**
 * The renderer's mirror of the known servers (identity spec §5.4): the list main keeps in
 * `accounts.yaml`, minus anything secret. Fed by `account.changed`; the dialog performs the
 * sign-in steps itself so a password never enters a store.
 */
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type { AccountChangedEvent, AccountWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useUiStore } from './ui.js';

export interface AccountStore {
  readonly servers: readonly AccountWire[];
  /** True once `account.list` has answered, so the status bar does not flash "no account". */
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /** Applies an `account.changed` payload; toasts a sign-out the user did not ask for. */
  readonly applyChanged: (servers: readonly AccountWire[]) => void;
  /** Signs out of `url`; resolves `true` when main did. */
  readonly signOut: (url: string) => Promise<boolean>;
  readonly remove: (url: string) => Promise<boolean>;
}

/** The servers with a live session. */
export function signedInServers(servers: readonly AccountWire[]): readonly AccountWire[] {
  return servers.filter((server) => !server.signedOut);
}

/** Sign-outs the user asked for, so the resulting `account.changed` is not reported as a surprise. */
const expectedSignOuts = new Set<string>();

export const useAccountStore = create<AccountStore>((set, get) => ({
  servers: [],
  loaded: false,

  load: async () => {
    const result = await ipc().account.list(undefined);
    if (result.ok) set({ servers: result.value.servers, loaded: true });
    else set({ loaded: true });
  },

  applyChanged: (servers) => {
    const before = new Map(get().servers.map((server) => [server.url, server]));
    for (const server of servers) {
      const previous = before.get(server.url);
      if (server.signedOut && previous !== undefined && !previous.signedOut) {
        if (expectedSignOuts.delete(server.url)) {
          showToast(`Signed out of ${server.url}`);
        } else {
          showToast(`Signed out of ${server.url}: the server no longer accepts this session.`, {
            label: 'Sign in again',
            onClick: () => {
              useUiStore.getState().openSignInDialog(server.url);
            },
          });
        }
      }
    }
    set({ servers, loaded: true });
  },

  signOut: async (url) => {
    expectedSignOuts.add(url);
    const result = await ipc().account.signOut({ url });
    if (!result.ok) {
      expectedSignOuts.delete(url);
      showToast(`Could not sign out: ${result.error.message}`);
      return false;
    }
    get().applyChanged(result.value.servers);
    return true;
  },

  remove: async (url) => {
    expectedSignOuts.add(url);
    const result = await ipc().account.remove({ url });
    expectedSignOuts.delete(url);
    if (!result.ok) {
      showToast(`Could not remove the server: ${result.error.message}`);
      return false;
    }
    set({ servers: result.value.servers });
    return true;
  },
}));

/** Called once from the shell, next to `subscribeToSync`; returns the unsubscribe. */
export function subscribeToAccounts(): () => void {
  return window.wirebench.on('account.changed', ((payload: AccountChangedEvent) => {
    useAccountStore.getState().applyChanged(payload.servers);
  }) as (payload: unknown) => void);
}

/** What the Sign in dialog shows for each way a step can fail; the server's message otherwise. */
const SIGN_IN_MESSAGES: Readonly<Record<string, string>> = {
  'server-url-invalid': 'Enter the server address as a URL, such as https://wirebench.example.com.',
  'server-unreachable': 'Could not reach that address. Check the URL, your network and the proxy settings.',
  'server-not-wirebench': 'That address is not a Wirebench Server.',
  'server-api-version': 'This server needs a newer Wirebench. Update the app and try again.',
  'server-bad-response': 'The server answered in a way Wirebench did not understand.',
  'identity-invalid-credentials': 'Wrong email or password.',
  'identity-user-disabled': 'This account is disabled. Ask a server admin.',
  'identity-method-disabled': 'The server does not allow this way of signing in.',
  'identity-rate-limited': 'Too many attempts. Wait a minute and try again.',
  'identity-invitation-invalid': 'This invitation code is not valid, was already used, or has expired.',
  'identity-password-too-short': 'Choose a password of at least 12 characters.',
  'identity-user-exists': 'An account with this email already exists. Sign in instead.',
  'identity-not-invited': 'No account or open invitation exists for this email. Ask a server admin to invite you.',
  'identity-email-unverified': 'The identity provider did not confirm your email address, so it cannot be linked.',
  'identity-oidc-refused': 'The identity provider refused the sign-in.',
  'identity-oidc-failed': 'The identity provider did not complete the sign-in.',
  'account-sign-in-pending': 'A sign-in is already waiting for the browser.',
  'account-sign-in-timeout': 'The browser did not come back in time. Try again.',
  'account-sign-in-cancelled': 'Sign-in cancelled.',
  'external-url-refused': 'The server returned a sign-in address that is not http(s); nothing was opened.',
};

export function signInErrorMessage(error: IpcError): string {
  return SIGN_IN_MESSAGES[error.code] ?? error.message;
}
```

`apps/desktop/src/renderer/commands/register-account-commands.ts`:

```ts
import { catalogEntry } from '@shared/command-catalog.js';
import { registerCommand } from '../lib/commands.js';
import { signedInServers, useAccountStore } from '../state/account.js';
import { useUiStore } from '../state/ui.js';

/** True when at least one known server has a live session — the gate for `account.signOut`. */
export function hasSignedInServer(): boolean {
  return signedInServers(useAccountStore.getState().servers).length > 0;
}

/**
 * Registers the `account.*` commands. Sign-in is always available (it is how a server first
 * becomes known); sign-out acts directly with one signed-in server and defers to Preferences →
 * Accounts, where each server has its own button, with more.
 */
export function registerAccountCommands(): void {
  registerCommand({
    ...catalogEntry('account.signIn'),
    run: () => {
      useUiStore.getState().openSignInDialog();
    },
  });

  registerCommand({
    ...catalogEntry('account.signOut'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      const signedIn = signedInServers(useAccountStore.getState().servers);
      const only = signedIn.length === 1 ? signedIn[0] : undefined;
      if (only !== undefined) {
        void useAccountStore.getState().signOut(only.url);
      } else {
        useUiStore.getState().openPreferences('accounts');
      }
    },
  });
}
```

Add `'account.signedIn': 'a server account is signed in',` to `COMMAND_WHEN_SCOPES` in
`apps/desktop/src/shared/commands.ts`, and `registerAccountCommands();` after `registerSyncCommands();`
in `register-shell-commands.ts`.

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/account-store.test.ts apps/desktop/test/renderer/account-commands.test.ts apps/desktop/test/renderer/command-catalog.test.ts` → PASS (the catalog audit picks the two ids up by itself).

- [ ] **Step 4: Write the failing dialog test**

`apps/desktop/test/renderer/sign-in-dialog.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MIN_PASSWORD_LENGTH as ENGINE_MIN } from '@wirebench/engine';
import { MIN_PASSWORD_LENGTH, SignInDialog } from '../../src/renderer/features/account/sign-in-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const META = { name: 'wirebench-server', version: '1', apiVersion: 1, publicUrl: 'https://wb.test', auth: { local: true, oidc: true, oidcDisplayName: 'Corp SSO' }, capabilities: [] };
const ACCOUNT = { url: 'https://wb.test', userId: 'u1', email: 'alice@example.com', displayName: 'Alice', deviceName: 'Mac', signedOut: false, addedAt: '2026-09-24T12:00:00.000Z' };
const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string, message = code) => ({ ok: false, error: { code, message } });

async function openDialog(url?: string): Promise<void> {
  render(<SignInDialog />);
  act(() => {
    useUiStore.getState().openSignInDialog(url);
  });
  await screen.findByTestId('sign-in-dialog');
}

/** Types a URL and gets to the method step against `meta`. */
async function reachMethods(meta: unknown = META): Promise<ReturnType<typeof vi.fn>> {
  const probe = vi.fn().mockResolvedValue(ok({ url: 'https://wb.test', meta }));
  installWirebenchApi({ account: { probe } });
  await openDialog();
  await userEvent.type(screen.getByTestId('sign-in-url'), 'https://WB.test/');
  await userEvent.click(screen.getByTestId('sign-in-continue'));
  await screen.findByTestId('sign-in-methods');
  return probe;
}

describe('SignInDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
    showToast.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('restates the engine’s minimum password length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(ENGINE_MIN);
  });

  it('is closed until opened, and starts on the server step with a given URL prefilled', async () => {
    render(<SignInDialog />);
    expect(screen.queryByTestId('sign-in-dialog')).toBeNull();
    await openDialog('https://known.test');
    expect((screen.getByTestId('sign-in-url') as HTMLInputElement).value).toBe('https://known.test');
  });

  it('shows the probe’s failure inline and stays on the server step', async () => {
    installWirebenchApi({ account: { probe: vi.fn().mockResolvedValue(fail('server-not-wirebench')) } });
    await openDialog();
    await userEvent.type(screen.getByTestId('sign-in-url'), 'https://example.com');
    await userEvent.click(screen.getByTestId('sign-in-continue'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('That address is not a Wirebench Server.');
    expect(screen.getByTestId('sign-in-url')).toBeTruthy();
  });

  it('builds the method step from meta.auth: local form, an SSO button with the display name, and the invitation link', async () => {
    const probe = await reachMethods();
    expect(probe).toHaveBeenCalledWith({ url: 'https://WB.test/' });
    expect(screen.getByTestId('sign-in-email')).toBeTruthy();
    expect(screen.getByTestId('sign-in-oidc').textContent).toBe('Continue with Corp SSO');
    expect(screen.getByTestId('sign-in-have-code')).toBeTruthy();
    expect(screen.getByTestId('sign-in-server').textContent).toContain('https://wb.test');
  });

  it('hides the local form when the server has only OIDC', async () => {
    await reachMethods({ ...META, auth: { local: false, oidc: true } });
    expect(screen.queryByTestId('sign-in-email')).toBeNull();
    expect(screen.getByTestId('sign-in-oidc').textContent).toBe('Continue with OIDC');
  });

  it('local: sends the email and password once, closes and toasts on success; maps a refusal inline', async () => {
    const signInLocal = vi.fn().mockResolvedValueOnce(fail('identity-invalid-credentials')).mockResolvedValueOnce(ok({ account: ACCOUNT }));
    await reachMethods();
    installWirebenchApi({ account: { signInLocal, probe: vi.fn() } });
    await userEvent.type(screen.getByTestId('sign-in-email'), 'alice@example.com');
    await userEvent.type(screen.getByTestId('sign-in-password'), 'wrong-password!');
    await userEvent.click(screen.getByTestId('sign-in-submit'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('Wrong email or password.');
    expect(signInLocal).toHaveBeenCalledWith({ url: 'https://wb.test', email: 'alice@example.com', password: 'wrong-password!' });

    await userEvent.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => expect(useUiStore.getState().signInDialog.open).toBe(false));
    expect(showToast).toHaveBeenCalledWith('Signed in as alice@example.com');
  });

  it('OIDC: shows Waiting for the browser… with Cancel, and Cancel calls account.cancelSignIn', async () => {
    let settle!: (value: unknown) => void;
    const startOidc = vi.fn().mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const cancelSignIn = vi.fn().mockResolvedValue(ok({ cancelled: true }));
    await reachMethods();
    installWirebenchApi({ account: { startOidc, cancelSignIn, probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-oidc'));
    await screen.findByTestId('sign-in-waiting');
    expect(startOidc).toHaveBeenCalledWith({ url: 'https://wb.test' });
    await userEvent.click(screen.getByTestId('sign-in-cancel'));
    expect(cancelSignIn).toHaveBeenCalled();
    settle(fail('account-sign-in-cancelled'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('Sign-in cancelled.');
    expect(screen.getByTestId('sign-in-methods')).toBeTruthy();
  });

  it('invitation: looks the code up, asks for a name and matching password of the minimum length, then accepts', async () => {
    const lookupInvitation = vi.fn().mockResolvedValue(ok({ email: 'bob@example.com', methods: { local: true, oidc: true } }));
    const acceptInvitation = vi.fn().mockResolvedValue(ok({ account: { ...ACCOUNT, email: 'bob@example.com' } }));
    await reachMethods();
    installWirebenchApi({ account: { lookupInvitation, acceptInvitation, probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-have-code'));
    await userEvent.type(screen.getByTestId('sign-in-code'), 'S'.repeat(43));
    await userEvent.click(screen.getByTestId('sign-in-code-continue'));
    expect((await screen.findByTestId('sign-in-invited-email')).textContent).toContain('bob@example.com');
    expect(lookupInvitation).toHaveBeenCalledWith({ url: 'https://wb.test', secret: 'S'.repeat(43) });

    await userEvent.type(screen.getByTestId('sign-in-display-name'), 'Bob');
    await userEvent.type(screen.getByTestId('sign-in-new-password'), 'short');
    await userEvent.type(screen.getByTestId('sign-in-confirm-password'), 'short');
    expect(screen.getByTestId('sign-in-accept').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('sign-in-password-hint').textContent).toContain('12');
    await userEvent.clear(screen.getByTestId('sign-in-new-password'));
    await userEvent.type(screen.getByTestId('sign-in-new-password'), 'correct horse battery');
    await userEvent.clear(screen.getByTestId('sign-in-confirm-password'));
    await userEvent.type(screen.getByTestId('sign-in-confirm-password'), 'correct horse battery');
    await waitFor(() => expect(screen.getByTestId('sign-in-accept').hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByTestId('sign-in-accept'));
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith({ url: 'https://wb.test', secret: 'S'.repeat(43), displayName: 'Bob', password: 'correct horse battery' }));
    await waitFor(() => expect(useUiStore.getState().signInDialog.open).toBe(false));
  });

  it('Back returns to the server step and clears what was typed', async () => {
    await reachMethods();
    await userEvent.type(screen.getByTestId('sign-in-password'), 'secret-secret-1');
    await userEvent.click(screen.getByTestId('sign-in-back'));
    await screen.findByTestId('sign-in-url');
    await userEvent.click(screen.getByTestId('sign-in-continue'));
    await screen.findByTestId('sign-in-methods');
    expect((screen.getByTestId('sign-in-password') as HTMLInputElement).value).toBe('');
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/sign-in-dialog.test.tsx` → FAIL.

- [ ] **Step 5: `features/account/sign-in-dialog.tsx`**

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import type { IpcError } from '../../../shared/ipc.js';
import type { AccountWire, ServerMetaWire } from '../../../shared/wire-types.js';
import { signInErrorMessage } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';

/**
 * Restated from the engine's `MIN_PASSWORD_LENGTH`: the renderer must not import a value from
 * the engine's Node-only entry. `sign-in-dialog.test.tsx` keeps the copy honest.
 */
export const MIN_PASSWORD_LENGTH = 12;

type Step = 'server' | 'methods' | 'waiting' | 'code' | 'password';

const INPUT_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

/**
 * *Sign in to a server…* (identity spec §3.8): the server's URL first, then whatever
 * `meta.auth` allows — a local form, a *Continue with <provider>* button, and behind *Have an
 * invitation code?* the accept flow. Every secret typed here lives in this component's state,
 * crosses the bridge once, and is cleared when the dialog closes.
 */
export function SignInDialog() {
  const open = useUiStore((state) => state.signInDialog.open);
  const initialUrl = useUiStore((state) => state.signInDialog.url);
  const setOpen = useUiStore((state) => state.setSignInDialogOpen);
  const [step, setStep] = useState<Step>('server');
  const [url, setUrl] = useState('');
  const [meta, setMeta] = useState<ServerMetaWire | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [invitedEmail, setInvitedEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const clearSecrets = (): void => {
    setPassword('');
    setCode('');
    setNewPassword('');
    setConfirmPassword('');
  };

  useEffect(() => {
    if (open) {
      setStep('server');
      setUrl(initialUrl ?? '');
      setMeta(undefined);
      setEmail('');
      setInvitedEmail('');
      setDisplayName('');
      setError(undefined);
      setBusy(false);
      clearSecrets();
    } else {
      clearSecrets();
    }
    // `clearSecrets` is a plain closure over setters, which never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialUrl]);

  const failed = (ipcError: IpcError): void => {
    setError(signInErrorMessage(ipcError));
  };

  const finished = (account: AccountWire): void => {
    clearSecrets();
    setOpen(false);
    showToast(`Signed in as ${account.email}`);
  };

  const probe = async (): Promise<void> => {
    if (busy || url.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.probe({ url });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    setUrl(result.value.url);
    setMeta(result.value.meta);
    setStep('methods');
  };

  const signInLocal = async (): Promise<void> => {
    if (busy || email.trim().length === 0 || password.length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.signInLocal({ url, email: email.trim(), password });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const startOidc = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setStep('waiting');
    const result = await ipc().account.startOidc({ url });
    setBusy(false);
    if (!result.ok) {
      setStep('methods');
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const cancelOidc = (): void => {
    void ipc().account.cancelSignIn(undefined);
  };

  const lookup = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.lookupInvitation({ url, secret: code.trim() });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    setInvitedEmail(result.value.email);
    setStep('password');
  };

  const passwordLongEnough = newPassword.length >= MIN_PASSWORD_LENGTH;
  const passwordsMatch = newPassword === confirmPassword;
  const canAccept = displayName.trim().length > 0 && passwordLongEnough && passwordsMatch && !busy;

  const accept = async (): Promise<void> => {
    if (!canAccept) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.acceptInvitation({ url, secret: code.trim(), displayName: displayName.trim(), password: newPassword });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const onEnter = (action: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      action();
    }
  };

  const providerName = meta?.auth.oidcDisplayName ?? 'OIDC';

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="sign-in-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          onEscapeKeyDown={step === 'waiting' ? cancelOidc : undefined}
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Sign in to a server</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {step === 'server'
              ? 'The address of your team’s Wirebench Server.'
              : <span data-testid="sign-in-server">{url}</span>}
          </Dialog.Description>

          {step === 'server' && (
            <>
              <label className={LABEL_CLASS} htmlFor="sign-in-url">Server URL</label>
              <input
                id="sign-in-url"
                data-testid="sign-in-url"
                autoFocus
                placeholder="https://wirebench.example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={onEnter(() => void probe())}
                className={INPUT_CLASS}
              />
            </>
          )}

          {step === 'methods' && meta !== undefined && (
            <div data-testid="sign-in-methods">
              {meta.auth.local && (
                <>
                  <label className={LABEL_CLASS} htmlFor="sign-in-email">Email</label>
                  <input id="sign-in-email" data-testid="sign-in-email" autoFocus autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className={INPUT_CLASS} />
                  <label className={LABEL_CLASS} htmlFor="sign-in-password">Password</label>
                  <input id="sign-in-password" data-testid="sign-in-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={onEnter(() => void signInLocal())} className={INPUT_CLASS} />
                  <div className="mt-3 flex justify-end">
                    <Button variant="primary" data-testid="sign-in-submit" disabled={busy || email.trim().length === 0 || password.length === 0} onClick={() => void signInLocal()}>
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </div>
                </>
              )}
              {meta.auth.oidc && (
                <div className={meta.auth.local ? 'mt-3 border-t border-hairline pt-3' : 'mt-3'}>
                  <Button data-testid="sign-in-oidc" disabled={busy} onClick={() => void startOidc()} className="w-full justify-center">
                    Continue with {providerName}
                  </Button>
                </div>
              )}
              <button
                type="button"
                data-testid="sign-in-have-code"
                className="mt-3 text-xs text-accent hover:underline"
                onClick={() => {
                  setError(undefined);
                  setStep('code');
                }}
              >
                Have an invitation code?
              </button>
            </div>
          )}

          {step === 'waiting' && (
            <div data-testid="sign-in-waiting" className="mt-3 text-sm text-fg-subtle">
              Waiting for the browser… Finish signing in with {providerName}, then come back here.
            </div>
          )}

          {step === 'code' && (
            <>
              <label className={LABEL_CLASS} htmlFor="sign-in-code">Invitation code</label>
              <input id="sign-in-code" data-testid="sign-in-code" autoFocus value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={onEnter(() => void lookup())} className={`${INPUT_CLASS} font-mono`} />
              <p className="mt-1 text-xs text-fg-subtle">The code from the invitation link, or paste the whole link.</p>
            </>
          )}

          {step === 'password' && (
            <>
              <p data-testid="sign-in-invited-email" className="mt-3 text-sm text-fg-default">
                Creating the account for <span className="font-medium">{invitedEmail}</span>.
              </p>
              <label className={LABEL_CLASS} htmlFor="sign-in-display-name">Display name</label>
              <input id="sign-in-display-name" data-testid="sign-in-display-name" autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={INPUT_CLASS} />
              <label className={LABEL_CLASS} htmlFor="sign-in-new-password">Choose a password</label>
              <input id="sign-in-new-password" data-testid="sign-in-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className={INPUT_CLASS} />
              <p data-testid="sign-in-password-hint" className={`mt-1 text-xs ${newPassword.length > 0 && !passwordLongEnough ? 'text-status-danger' : 'text-fg-subtle'}`}>
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
              <label className={LABEL_CLASS} htmlFor="sign-in-confirm-password">Confirm password</label>
              <input id="sign-in-confirm-password" data-testid="sign-in-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} onKeyDown={onEnter(() => void accept())} className={INPUT_CLASS} />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <p role="alert" className="mt-1 text-xs text-status-danger">The passwords do not match.</p>
              )}
            </>
          )}

          {error !== undefined && (
            <p role="alert" data-testid="sign-in-error" className="mt-3 text-xs text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-4 flex items-center justify-between">
            <div>
              {step !== 'server' && step !== 'waiting' && (
                <Button
                  variant="ghost"
                  data-testid="sign-in-back"
                  disabled={busy}
                  onClick={() => {
                    setError(undefined);
                    clearSecrets();
                    if (step === 'password') setStep('code');
                    else if (step === 'code') setStep('methods');
                    else setStep('server');
                  }}
                >
                  Back
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {step === 'waiting' ? (
                <Button data-testid="sign-in-cancel" onClick={cancelOidc}>Cancel</Button>
              ) : (
                <Dialog.Close asChild>
                  <Button data-testid="sign-in-close">Close</Button>
                </Dialog.Close>
              )}
              {step === 'server' && (
                <Button variant="primary" data-testid="sign-in-continue" disabled={busy || url.trim().length === 0} onClick={() => void probe()}>
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              )}
              {step === 'code' && (
                <Button variant="primary" data-testid="sign-in-code-continue" disabled={busy || code.trim().length === 0} onClick={() => void lookup()}>
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              )}
              {step === 'password' && (
                <Button variant="primary" data-testid="sign-in-accept" disabled={!canAccept} onClick={() => void accept()}>
                  {busy ? 'Creating…' : 'Create account'}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

If the code field receives a whole invitation link, `lookup` should accept it: before calling,
`const secret = code.trim().replace(/^.*\/invite\//, '')` and use `secret` for both the lookup and
the accept (store it in state as `code` after lookup succeeds). The test above passes a bare code.

Mount it in `apps/desktop/src/renderer/shell/app-shell.tsx` next to `<JoinDialog />` and subscribe
next to `subscribeToSync`:

```tsx
  useEffect(() => subscribeToAccounts(), []);
  useEffect(() => {
    void useAccountStore.getState().load();
  }, []);
```

with `import { subscribeToAccounts, useAccountStore } from '../state/account.js';` and
`import { SignInDialog } from '../features/account/sign-in-dialog.js';`. The shell tests stub
`window.wirebench` with `installWirebenchApi`, whose `account.list` default answers an empty list.

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/sign-in-dialog.test.tsx apps/desktop/test/renderer/shell.test.tsx apps/desktop/test/renderer/app-shell-panels.test.tsx` → PASS.

- [ ] **Step 6: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add apps/desktop/src/shared/commands.ts apps/desktop/src/shared/command-catalog.ts apps/desktop/src/renderer/state/account.ts apps/desktop/src/renderer/state/ui.ts apps/desktop/src/renderer/features/account/sign-in-dialog.tsx apps/desktop/src/renderer/commands/register-account-commands.ts apps/desktop/src/renderer/commands/register-shell-commands.ts apps/desktop/src/renderer/shell/app-shell.tsx apps/desktop/test/renderer/account-store.test.ts apps/desktop/test/renderer/account-commands.test.ts apps/desktop/test/renderer/sign-in-dialog.test.tsx docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): Sign in dialog, account store and the Account commands

Server URL first, then whatever the server's meta allows: a local form,
Continue with <provider>, and the invitation flow behind one link. The
password lives in the dialog's state and crosses the bridge once."
```

---

### Task 14: Status bar item, Accounts preferences section and the `accounts` preference

**Files:**
- Create: `apps/desktop/src/renderer/features/account/account-status-item.tsx`,
  `apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx`,
  `apps/desktop/test/renderer/account-status-item.test.tsx`, `apps/desktop/test/renderer/accounts-section.test.tsx`
- Modify: `packages/engine/src/project/preferences.ts` (`AccountPreferences`, `accounts` in `Preferences`,
  `DEFAULT_PREFERENCES`, `preferencesSchema`, `mergePreferences`), `apps/desktop/src/shared/wire-types.ts`
  (`preferencesWireSchema.accounts`, `preferencesSectionSchema` + `'accounts'`, `preferencesPatchWireSchema.accounts`),
  `apps/desktop/src/renderer/state/preferences-defaults.ts`, `apps/desktop/src/renderer/features/preferences/preferences-editor.tsx`,
  `apps/desktop/src/renderer/shell/status-bar.tsx`, `apps/desktop/src/renderer/commands/register-account-commands.ts`
  (drop the `as never`), `apps/desktop/test/renderer/preferences-editor.test.tsx` (add `'Accounts'` to the label list),
  `docs-site/src/content/docs/guides/preferences.mdx` (an *Accounts* entry)

**Interfaces:**
- Produces: `AccountStatusItem`, `AccountsSection`, preference `accounts.showInStatusBar` (default `true`),
  section id `'accounts'`; testids `status-bar-account`, `status-bar-account-menu`, `account-sign-out-<host>`,
  `accounts-section`, `account-row-<host>`, `account-row-sign-out`, `account-row-remove`, `accounts-add-server`,
  `accounts-show-in-status-bar`.
- Consumes: Task 13's store, dialog state and commands; `SettingsGroup`, `BooleanSetting`; `@radix-ui/react-dropdown-menu`
  (already a dependency; `env-switcher.tsx` shows the pattern).

- [ ] **Step 1: The preference, engine to renderer**

`packages/engine/src/project/preferences.ts`:
- add `export interface AccountPreferences { /** Whether the status bar shows the account item once a server is known. */ readonly showInStatusBar: boolean; }`
  and `readonly accounts: AccountPreferences;` to `Preferences` after `updates`;
- `DEFAULT_PREFERENCES`: `accounts: Object.freeze({ showInStatusBar: true }),` after `updates`;
- `preferencesSchema`: `accounts: z.object({ showInStatusBar: z.boolean().optional() }).optional(),` after `updates`;
- `mergePreferences`: `accounts: parseSection(shape.accounts, root['accounts']),` and
  `accounts: mergeSection(base.accounts, value.accounts),` beside the `updates` lines.

`apps/desktop/src/shared/wire-types.ts`: `accounts: z.object({ showInStatusBar: z.boolean() }),` in
`preferencesWireSchema` after `updates`; `'accounts',` in `preferencesSectionSchema` after `'updates'`;
`accounts: z.record(z.string(), z.unknown()).optional(),` in `preferencesPatchWireSchema`.

`apps/desktop/src/renderer/state/preferences-defaults.ts`: `accounts: { showInStatusBar: true },` after
`updates` (`preferences-defaults.test.ts` fails until both sides agree).

`preferences-editor.tsx`: `{ id: 'accounts', label: 'Accounts' },` after `updates` in `SECTIONS`,
`{active === 'accounts' && <AccountsSection {...sectionProps} />}`, and the import. In
`preferences-editor.test.tsx` add `'Accounts'` to the "lists every section" labels. In
`register-account-commands.ts` change `openPreferences('accounts' as never)` to `openPreferences('accounts')`.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/preferences* --project desktop apps/desktop/test/preferences-defaults.test.ts apps/desktop/test/renderer/preferences-editor.test.tsx` → PASS once `AccountsSection` exists (Step 3); run again after it.

- [ ] **Step 2: Write the failing tests**

`apps/desktop/test/renderer/account-status-item.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountStatusItem } from '../../src/renderer/features/account/account-status-item.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url, userId: 'u', email: `a@${new URL(url).host}`, displayName: 'A', deviceName: 'd', signedOut, addedAt: '2026-09-24T12:00:00.000Z',
});

describe('AccountStatusItem', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined }, preferences: { open: false, section: undefined } });
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing while no server is known, and nothing when the preference is off', () => {
    const { rerender } = render(<AccountStatusItem />);
    expect(screen.queryByTestId('status-bar-account')).toBeNull();
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES_WIRE, accounts: { showInStatusBar: false } } });
    rerender(<AccountStatusItem />);
    expect(screen.queryByTestId('status-bar-account')).toBeNull();
  });

  it('shows the email of the signed-in server, and Sign out of it in the menu', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account('https://wb.test', true)] } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('a@wb.test');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    const signOutItem = await screen.findByTestId('account-sign-out-wb.test');
    expect(signOutItem.textContent).toBe('Sign out of https://wb.test');
    fireEvent.click(signOutItem);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://wb.test' }));
  });

  it('a known but signed-out server shows Sign in, which opens the dialog on that URL', () => {
    useAccountStore.setState({ servers: [account('https://wb.test', true)] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('Sign in');
    fireEvent.click(item);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
  });

  it('with several signed-in servers the label counts them and the menu lists each', async () => {
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test')] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('a@one.test +1');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    await screen.findByTestId('account-sign-out-one.test');
    await screen.findByTestId('account-sign-out-two.test');
    fireEvent.click(screen.getByTestId('account-manage'));
    expect(useUiStore.getState().preferences).toEqual({ open: true, section: 'accounts' });
  });
});
```

`apps/desktop/test/renderer/accounts-section.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountsSection } from '../../src/renderer/features/preferences/sections/accounts-section.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url, userId: 'u', email: `a@${new URL(url).host}`, displayName: 'Ada', deviceName: 'Mac', signedOut, addedAt: '2026-09-24T12:00:00.000Z',
});

describe('AccountsSection', () => {
  beforeEach(() => {
    installWirebenchApi();
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
  });

  it('lists each server with its state and offers Add server…', () => {
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test', true)] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    const one = screen.getByTestId('account-row-one.test');
    expect(one.textContent).toContain('a@one.test');
    expect(one.textContent).toContain('Ada');
    expect(one.textContent).toContain('Signed in');
    expect(one.querySelector('[data-testid="account-row-sign-out"]')).not.toBeNull();
    const two = screen.getByTestId('account-row-two.test');
    expect(two.textContent).toContain('Signed out');
    expect(two.querySelector('[data-testid="account-row-sign-out"]')).toBeNull();
    fireEvent.click(two.querySelector('[data-testid="account-row-sign-in"]')!);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://two.test' });
    fireEvent.click(screen.getByTestId('accounts-add-server'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: undefined });
  });

  it('Sign out and Remove call the store, and the toggle patches the preference', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account('https://one.test', true)] } });
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut, remove } });
    useAccountStore.setState({ servers: [account('https://one.test')] });
    const update = vi.fn();
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={update} />);
    fireEvent.click(screen.getByTestId('account-row-sign-out'));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://one.test' }));
    fireEvent.click(screen.getByTestId('account-row-remove'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ url: 'https://one.test' }));
    fireEvent.click(screen.getByTestId('accounts-show-in-status-bar'));
    expect(update).toHaveBeenCalledWith({ accounts: { showInStatusBar: false } });
  });

  it('says so when no server is known', () => {
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect(screen.getByTestId('accounts-section').textContent).toContain('No servers yet');
  });
});
```

(`BooleanSetting` renders its checkbox with `data-testid={testId}`; if it puts the id on a wrapper
instead, click `screen.getByTestId('accounts-show-in-status-bar').querySelector('input')!` — check
`settings-grid.tsx:191`.)

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/account-status-item.test.tsx apps/desktop/test/renderer/accounts-section.test.tsx` → FAIL.

- [ ] **Step 3: The two components**

`apps/desktop/src/renderer/features/account/account-status-item.tsx`:

```tsx
import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { UserRound } from 'lucide-react';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';

const ITEM_CLASS =
  'flex cursor-default select-none items-center rounded-sm px-2 py-1 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover';

/** `https://wb.test:8443` → `wb.test:8443`, for test ids and short labels. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The status bar's account item (identity spec §3.8). Hidden until a server is known and while
 * `accounts.showInStatusBar` is off. A signed-out server shows *Sign in*, which reopens the
 * dialog on that URL; a signed-in one shows the email with a menu holding *Sign out of <server>*
 * per server and *Manage accounts…*.
 */
export function AccountStatusItem() {
  const servers = useAccountStore((state) => state.servers);
  const show = usePreferencesStore((state) => state.preferences.accounts.showInStatusBar);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);
  const openPreferences = useUiStore((state) => state.openPreferences);
  const signOut = useAccountStore((state) => state.signOut);
  const [open, setOpen] = useState(false);

  if (!show || servers.length === 0) return null;

  const signedIn = signedInServers(servers);
  const first = signedIn[0];
  if (first === undefined) {
    const known = servers[0]!;
    return (
      <button
        type="button"
        data-testid="status-bar-account"
        data-state="signed-out"
        title={`Sign in to ${known.url}`}
        className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
        onClick={() => {
          openSignInDialog(known.url);
        }}
      >
        <UserRound size={12} aria-hidden="true" />
        Sign in
      </button>
    );
  }

  const label = signedIn.length === 1 ? first.email : `${first.email} +${String(signedIn.length - 1)}`;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="status-bar-account"
          data-state="signed-in"
          title="Account"
          aria-label={`Account: ${label}`}
          className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
        >
          <UserRound size={12} aria-hidden="true" />
          {label}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={4}
          data-testid="status-bar-account-menu"
          className="z-50 min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {signedIn.map((server) => (
            <DropdownMenu.Item
              key={server.url}
              data-testid={`account-sign-out-${hostOf(server.url)}`}
              className={ITEM_CLASS}
              onSelect={() => {
                void signOut(server.url);
              }}
            >
              Sign out of {server.url}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            data-testid="account-manage"
            className={ITEM_CLASS}
            onSelect={() => {
              openPreferences('accounts');
            }}
          >
            Manage accounts…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

In `apps/desktop/src/renderer/shell/status-bar.tsx`, render it after the `SyncBadge` block:

```tsx
        <AccountStatusItem />
```

wrapped the same way the sync badge is — but since the item decides for itself whether to render,
the separator must not appear alone. Give the item the separator: in `AccountStatusItem`, return the
`·` span plus the control as a fragment (`<><span aria-hidden="true" className="text-fg-faint">·</span>…</>`)
in both branches, and `null` otherwise. `status-bar.test.tsx` stubs `window.wirebench` by hand without
`account`; the item only reads stores, so it needs nothing from the API there (it renders `null` with no
servers).

`apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx`:

```tsx
import { Button } from '../../../components/button.js';
import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import { useAccountStore } from '../../../state/account.js';
import { useUiStore } from '../../../state/ui.js';
import type { SectionProps } from './section-props.js';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Preferences → Accounts (identity spec §3.9): every known server, its state, and the two
 * actions per row. The list itself is not a preference — it lives in `accounts.yaml` in main and
 * arrives through the account store — only the status bar toggle is.
 */
export function AccountsSection({ preferences, update }: SectionProps) {
  const servers = useAccountStore((state) => state.servers);
  const signOut = useAccountStore((state) => state.signOut);
  const remove = useAccountStore((state) => state.remove);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);

  return (
    <div data-testid="accounts-section">
      <SettingsGroup title="Servers" hint="Where you are signed in. Removing a server also signs out of it.">
        {servers.length === 0 ? (
          <p className="text-sm text-fg-subtle">No servers yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {servers.map((server) => (
              <li key={server.url} data-testid={`account-row-${hostOf(server.url)}`} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg-default">{server.url}</div>
                  <div className="truncate text-xs text-fg-subtle">
                    {server.email} · {server.displayName} · {server.signedOut ? 'Signed out' : 'Signed in'} · {server.deviceName}
                  </div>
                </div>
                {server.signedOut ? (
                  <Button data-testid="account-row-sign-in" onClick={() => openSignInDialog(server.url)}>Sign in</Button>
                ) : (
                  <Button data-testid="account-row-sign-out" onClick={() => void signOut(server.url)}>Sign out</Button>
                )}
                <Button variant="ghost" data-testid="account-row-remove" onClick={() => void remove(server.url)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2">
          <Button variant="primary" data-testid="accounts-add-server" onClick={() => openSignInDialog()}>Add server…</Button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Status bar">
        <BooleanSetting
          label="Show sign-in in the status bar"
          value={preferences.accounts.showInStatusBar}
          testId="accounts-show-in-status-bar"
          onChange={(showInStatusBar) => update({ accounts: { showInStatusBar } })}
          hint="Once a server is known, the status bar shows who you are signed in as."
        />
      </SettingsGroup>
    </div>
  );
}
```

`docs-site/src/content/docs/guides/preferences.mdx`: add an **Accounts** entry in the same shape as
the *Updates* one: the list of servers with *Sign out* / *Remove* / *Add server…*, and *Show sign-in
in the status bar* (default on), linking to the *Sign in to a server* section of the shared
workspaces guide (Task 15 writes it).

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/account-status-item.test.tsx apps/desktop/test/renderer/accounts-section.test.tsx apps/desktop/test/renderer/status-bar.test.tsx apps/desktop/test/renderer/preferences-editor.test.tsx apps/desktop/test/preferences-defaults.test.ts apps/desktop/test/renderer/account-commands.test.ts` → PASS.

- [ ] **Step 4: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/engine/src/project/preferences.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/renderer/state/preferences-defaults.ts apps/desktop/src/renderer/features/preferences/preferences-editor.tsx apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx apps/desktop/src/renderer/features/account/account-status-item.tsx apps/desktop/src/renderer/shell/status-bar.tsx apps/desktop/src/renderer/commands/register-account-commands.ts apps/desktop/test/renderer/account-status-item.test.tsx apps/desktop/test/renderer/accounts-section.test.tsx apps/desktop/test/renderer/preferences-editor.test.tsx docs-site/src/content/docs/guides/preferences.mdx
git commit -m "feat(desktop): account status bar item and the Accounts preferences section

Hidden until a server is known; a signed-out server offers Sign in on
its URL, a signed-in one its email and a Sign out per server. The list
is main's; only the status bar toggle is a preference."
```

---

### Task 15: e2e against a fake server, docs and the ADR

**Files:**
- Create: `e2e/helpers/fake-server.ts`, `e2e/specs/account.spec.ts`, `docs/adr/0010-server-identity-is-device-tokens-and-invitations.md`
- Modify: `docs/collaborate.md` (new section *Sign in to a server*, before *Troubleshooting*),
  `docs-site/src/content/docs/guides/shared-workspaces.mdx` (the same section, site voice),
  `docs/security.md` (a *Server accounts* section after *The OAuth2 callback listens on loopback only*),
  `docs/roadmap.md` (mark the identity slice done, if it lists it)

**Interfaces:**
- Produces: `startFakeServer({ users, invitations }) → { url, close, tokens, signOuts }`; `startNotWirebenchServer()`.
- Consumes: the status bar and dialog testids of Tasks 13–14; `launchApp`, `runCommand`.

- [ ] **Step 1: `e2e/helpers/fake-server.ts`**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
}

export interface FakeServer {
  readonly url: string;
  /** Tokens issued so far, in order. */
  readonly tokens: string[];
  /** Tokens the app signed out. */
  readonly signOuts: string[];
  close(): Promise<void>;
}

const NAME = 'wirebench-server';
const API_VERSION = 1;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string): void {
  send(response, status, { code, message: code });
}

let nextId = 1;
const newToken = (): string => `wbs_${String(nextId++).padStart(43, 'A')}`;

/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11): meta, local
 * sign-in, invitation lookup and accept, me and sign-out, in memory. The real thing is covered
 * by `packages/server`'s integration suite; this exists so the e2e spec needs no PostgreSQL.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map((options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]));
  const invitations = new Map(Object.entries(options.invitations ?? {}));
  const sessions = new Map<string, string>(); // token → email
  const tokens: string[] = [];
  const signOuts: string[] = [];
  let url = '';

  const userOf = (email: string) => {
    const user = users.get(email.toLowerCase())!;
    return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: false };
  };
  const issue = (response: ServerResponse, email: string): void => {
    const token = newToken();
    sessions.set(token, email);
    tokens.push(token);
    send(response, 201, { token, user: userOf(email) });
  };
  const bearer = (request: IncomingMessage): string | undefined => request.headers.authorization?.replace(/^Bearer /, '');

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', url);
      if (request.method === 'GET' && path.pathname === '/api/v1/meta') {
        send(response, 200, { name: NAME, version: '0.0.0-e2e', apiVersion: API_VERSION, publicUrl: url, auth: { local: true, oidc: options.oidc ?? false }, capabilities: [] });
        return;
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/local/sign-in') {
        const body = (await readJson(request)) as { email: string; password: string };
        const user = users.get(body.email.toLowerCase());
        if (user === undefined || user.password !== body.password) return problem(response, 401, 'identity-invalid-credentials');
        return issue(response, user.email);
      }
      if (request.method === 'GET' && path.pathname === '/api/v1/invitations/lookup') {
        const invitation = invitations.get(path.searchParams.get('secret') ?? '');
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        return send(response, 200, { email: invitation.email, methods: { local: true, oidc: false } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/invitations/accept') {
        const body = (await readJson(request)) as { secret: string; displayName: string; password: string };
        const invitation = invitations.get(body.secret);
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        invitations.delete(body.secret);
        users.set(invitation.email.toLowerCase(), { email: invitation.email, password: body.password, displayName: body.displayName, id: `u-${invitation.email}` });
        return issue(response, invitation.email);
      }
      const token = bearer(request);
      const email = token === undefined ? undefined : sessions.get(token);
      if (request.method === 'GET' && path.pathname === '/api/v1/me') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        return send(response, 200, { user: userOf(email), methods: { local: true, oidc: [] } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/sign-out') {
        if (email === undefined || token === undefined) return problem(response, 401, 'identity-unauthenticated');
        sessions.delete(token);
        signOuts.push(token);
        return send(response, 204);
      }
      problem(response, 404, 'not-found');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    tokens,
    signOuts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A plain web server: what a wrong URL looks like to the Sign in dialog. */
export async function startNotWirebenchServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>hello</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: `e2e/specs/account.spec.ts`**

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakeServer, startNotWirebenchServer, type FakeServer } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const ALICE = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };

/** Opens the Sign in dialog from the palette and gets past the server step. */
async function openSignIn(page: Page, url: string): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await dialog.getByTestId('sign-in-continue').click();
}

test.describe('server accounts', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-account-'));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('sign in with a password, the status bar shows the email, a restart keeps the session, sign out clears it', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ALICE] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await expect(page.getByTestId('status-bar-account')).toHaveCount(0);

    await openSignIn(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    await dialog.getByTestId('sign-in-email').fill(ALICE.email);
    await dialog.getByTestId('sign-in-password').fill('wrong password here');
    await dialog.getByTestId('sign-in-submit').click();
    await expect(dialog.getByTestId('sign-in-error')).toHaveText('Wrong email or password.');
    await dialog.getByTestId('sign-in-password').fill(ALICE.password);
    await dialog.getByTestId('sign-in-submit').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toContainText(ALICE.email);

    // The file names a ref, never the token.
    const accounts = readFileSync(join(userDataDir, 'accounts.yaml'), 'utf8');
    expect(accounts).toContain('tokenRef: sec_');
    expect(accounts).not.toContain(server.tokens[0]!);

    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    await expect(page.getByTestId('status-bar-account')).toContainText(ALICE.email, { timeout: 20_000 });

    await page.getByTestId('status-bar-account').click();
    await page.getByTestId(`account-sign-out-${new URL(server.url).host}`).click();
    await expect(page.getByTestId('status-bar-account')).toContainText('Sign in', { timeout: 20_000 });
    expect(server.signOuts).toEqual([server.tokens[0]]);
  });

  test('accepting an invitation code creates the account and signs in', async () => {
    test.setTimeout(90_000);
    const secret = 'I'.repeat(43);
    server = await startFakeServer({ invitations: { [secret]: { email: 'bob@example.com' } } });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await openSignIn(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    await dialog.getByTestId('sign-in-have-code').click();
    await dialog.getByTestId('sign-in-code').fill(secret);
    await dialog.getByTestId('sign-in-code-continue').click();
    await expect(dialog.getByTestId('sign-in-invited-email')).toContainText('bob@example.com');
    await dialog.getByTestId('sign-in-display-name').fill('Bob');
    await dialog.getByTestId('sign-in-new-password').fill('a password of length');
    await dialog.getByTestId('sign-in-confirm-password').fill('a password of length');
    await dialog.getByTestId('sign-in-accept').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toContainText('bob@example.com');
    expect(server.tokens).toHaveLength(1);
  });

  test('a server that is not Wirebench shows the inline error', async () => {
    const other = await startNotWirebenchServer();
    try {
      launched = await launchApp({ userDataDir, keepUserDataDir: true });
      const page = launched.window;
      await openSignIn(page, other.url);
      await expect(page.getByTestId('sign-in-dialog').getByTestId('sign-in-error')).toHaveText('That address is not a Wirebench Server.');
      await expect(page.getByTestId('sign-in-url')).toBeVisible();
    } finally {
      await other.close();
    }
  });
});
```

Run locally, headless and quietly, only if the build is fresh: `pnpm build && xvfb-run -a pnpm test:e2e -- account.spec.ts`
(on macOS without xvfb: rely on CI — the owner does not want local Electron windows). Expected: 3 passed.

- [ ] **Step 3: Docs**

`docs/collaborate.md`, a new section before `## Troubleshooting`:

```markdown
## Sign in to a server

A team that runs Wirebench Server signs in to it from the app. Run **Account: Sign in to a
server…** from the palette, use the status bar's **Sign in**, or **Add server…** under Settings →
Accounts, then:

1. Enter the server's address. Wirebench checks that it is a Wirebench Server of a version this app
   understands and remembers the address as its origin (`https://wirebench.example.com`).
2. Sign in the way the server allows: with an email and password, or with **Continue with
   <provider>** when the server is connected to the team's identity provider — that opens your
   browser and comes back to the app when the provider is done. **Have an invitation code?** takes
   the code from an invitation link (an admin sends it) and lets you choose your display name and
   password.

Once signed in, the status bar shows your email. The session is a device token the server issued to
this installation: it lives in the OS keychain (`secrets.json` names it under `wirebench-server:<url>`,
the value is never in a file) and expires after 30 days without use, or 180 days at most. The
password is sent once to the server and kept nowhere.

**Sign out** (status bar → *Sign out of <server>*, or Settings → Accounts) revokes the token on the
server and forgets it here. If the server stops accepting the token — an admin removed the device, it
expired — the app says so once, with **Sign in again**, and does nothing on its own.

Admins manage accounts from the server: `wirebench-server admin invite <email>` prints an invitation
link, and the API under `/api/v1/users` and `/api/v1/invitations` does the rest (see the server's
README). Nothing in the app needs a server; without one, no account UI is shown and no network call
is made.
```

Mirror the section in `docs-site/src/content/docs/guides/shared-workspaces.mdx` (same content, the
site's heading level). `docs/security.md`, after *The OAuth2 callback listens on loopback only*:

```markdown
## Server accounts

Signing in to Wirebench Server yields a device token (`wbs_…`), stored in the OS keychain under the
label `wirebench-server:<url>`; `accounts.yaml` holds the keychain reference and the account's
public facts, never the token. The renderer has no channel that returns it: main adds the `Bearer`
header itself, and a password crosses the bridge exactly once, in the sign-in call. The OIDC hand-off
reuses the loopback listener described above — same `127.0.0.1` binding, same one-callback rule, same
five-minute timeout — and the browser is only ever opened at the URL the server returned from
`/auth/oidc/start`. The server stores tokens and invitation secrets as SHA-256 hashes and compares
them in constant time; passwords are scrypt hashes. A token the server refuses marks the account
signed out; nothing retries or re-prompts.
```

`docs/roadmap.md`: if the server identity slice has an entry, mark it shipped with the PR number;
otherwise leave the file alone.

- [ ] **Step 4: ADR-0010**

`docs/adr/0010-server-identity-is-device-tokens-and-invitations.md`:

```markdown
# ADR-0010: Server identity is device tokens, invitations and OIDC linking by verified email

Status: accepted · Date: 2026-09-24 · Spec: `docs/specs/2026-09-24-wirebench-server-identity-design.md`

## Context

Wirebench Server (ADR-0009) needs to know who is calling before it can host workspaces, teams and
roles. Teams run their own identity provider, or none; the desktop app is the only client today, but
the CLI runner will follow; the server may sit behind a proxy and be reached from a laptop that is
sometimes offline.

## Decision

- **Opaque device tokens, not JWTs.** A sign-in from one installation mints one `wbs_` token, stored
  hashed, with an idle expiry (30 days) and an absolute one (180 days). Revocation is a row update
  and takes effect on the next request; there is no signing key to rotate and nothing to decode
  client-side.
- **Invitation-only.** No open registration: an admin creates an invitation for an email, the link
  carries a one-time secret, and accepting it creates the user. A password reset is an invitation of
  kind `reset`. The first admin comes from `admin invite` on the server's command line.
- **Two methods, one user.** Local (email + scrypt password) and OIDC (Authorization Code + PKCE via
  `openid-client`), both attached to the same user row. An OIDC login links to an existing user by
  `email_verified` email, creates one only against an open invitation, and refuses everything else.
- **The browser hand-off ends on the app's loopback with a one-time grant, not a token.** The server
  redirects to `http://127.0.0.1:<port>/callback?flow=&grant=`; the app trades the grant plus its PKCE
  verifier for the token over HTTPS. A token never appears in a URL.
- **The desktop keeps the token in the OS keychain and the renderer never sees it.** `accounts.yaml`
  holds a keychain reference; main adds the bearer header.

## Consequences

- One `SELECT` per authenticated request (token hash → user), cached by nothing; fine at this scale
  and simple to reason about. Revocation is immediate.
- The rate limiter and the OIDC flow table are per instance / in the database respectively; a second
  replica shares the flows but not the limiter (ADR-0009's one-replica note still applies).
- Every later module reads `request.caller` and never a header; `requireUser` / `requireServerAdmin`
  are the only gates.
- IdPs that omit `email_verified` cannot link; the refusal names the claim. Scopes are configurable
  per server.

## Alternatives considered

- **JWT access tokens.** Stateless, but revocation needs a denylist anyway, the desktop would have to
  refresh, and a leaked signing key is a disaster. Rejected.
- **Sessions in cookies.** The client is a desktop app and a CLI, not a browser. Rejected.
- **OIDC only.** Small teams and home labs have no IdP. Local accounts stay, behind invitations.
- **Passing the token on the loopback redirect.** Simpler, but a token in a browser history and proxy
  log. The one-time grant plus PKCE costs one extra request. Rejected.
```

- [ ] **Step 5: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` (includes
`check:banned-terms`, `check:doc-paths`, `docs:commands --check`, `docs:server-config --check`).

```bash
git add e2e/helpers/fake-server.ts e2e/specs/account.spec.ts docs/collaborate.md docs-site/src/content/docs/guides/shared-workspaces.mdx docs/security.md docs/adr/0010-server-identity-is-device-tokens-and-invitations.md docs/roadmap.md
git commit -m "test(e2e): server account sign-in, invitation and wrong-server specs; docs and ADR-0010

The e2e fake server implements the six endpoints the sign-in flow uses
so the spec needs no PostgreSQL; the real server is covered by its own
integration suite."
```

Then, before the push: `nice pnpm test:perf` (unskipped), `git push -u origin feat/identity`, and
open the pull request with `gh pr create --base main --title "feat: server identity — accounts, invitations, OIDC and the desktop sign-in" --body-file <file>`
whose body has the sections *What*, *Why*, *How to verify* and *Follow-ups* and ends with its last
section: no generated-by footer, no session link (CLAUDE.md). Bind the PR and watch CI; merge with
`gh pr merge --merge` only once every check on the latest head is green.

---

## Self-review against the spec

Spec section → task (every requirement has a home; names are defined once and reused):

| Spec | Task(s) |
| --- | --- |
| §3.1 endpoints: meta contribution, `auth/local/sign-in`, `auth/sign-out`, `me`, `me/password`, `me/devices` | 2 (meta), 5 |
| §3.1 `auth/oidc/start`, `callback`, `complete` | 7 |
| §3.1 `invitations`, `invitations/lookup`, `invitations/accept`, `/invite/:secret` page, `users`, `users/:id`, `users/:id/password-reset` | 6 |
| §3.2 `authenticate` hook, `Caller`, `requireUser`, `requireServerAdmin` | 4 |
| §3.3 linking rules (`decideLink`, `linkClaims`) | 7 |
| §3.4 scrypt format, parameters, rehash on older params | 3 (5 applies the rehash on sign-in) |
| §3.5 device tokens: format, hashing, idle/absolute expiry, touch every minute, sweep | 3, 4, 5 |
| §3.6 rate limits: 10/min per IP and per email on the four unauthenticated secret-taking routes | 2 (module), 3 (limiter), 5–7 (applied) |
| §3.7 `admin invite`, `list-invitations`, `revoke-invitation` | 8 |
| §3.8 desktop sign-in: entry points, steps, local, OIDC, after, sign-out, token invalid later, no account | 9–14 (`refresh` in 11 makes "token invalid later" observable) |
| §3.9 Accounts section | 14 |
| §4.1 configuration and `config check` redirect URI line | 2 |
| §4.2 migration `0002_identity.sql` | 2 |
| §4.3 `accounts.yaml`, keychain label, `accounts.showInStatusBar` | 1 (schema), 11, 14 |
| §5.1–5.4 file layout | File Structure |
| §6 security rules | 3, 4, 6, 7, 9, 11, 12 |
| §8 commands | 8, 13 |
| §11 tests: server unit and integration, engine unit, desktop unit, e2e | each task; 15 |
| §13 success criteria 1–9 | 8+13 (1), 6 (2), 7 (3), owner manual check (4), 5+11+15 (5), 5 (6), 14+15 (7), 9 (8), 15 (9) |

Checks run on the text: no `TBD`/`TODO`/"similar to Task N"; every referenced name is defined in the
task that produces it (`startLoopbackCallback`, `mainHttpOptions`, `ServerClient`, `AccountService`,
`toAccountWire`, `useAccountStore`, `signInErrorMessage`, `AccountStatusItem`, `AccountsSection`,
`startFakeServer`); the request shapes the desktop sends (`{ email, password, device }`,
`{ device, codeChallenge, loopbackPort }`, `{ flowId, grant, codeVerifier }`, `{ secret, displayName, password, device }`)
match the Task 1 schemas the server validates against; the `identity-*` codes the renderer maps are
the ones Task 3 defines plus `identity-rate-limited` from the limiter and `identity-oidc-refused`
from the callback route.

Known trade-offs recorded as rulings: the invitation URL is served by the server at
`<publicUrl>/invite/<secret>` through the new `registerPublic` hook; the `invitations` table keeps a
display `email` column beside `email_lower`; the OAuth2 tests stay in place as the regression net
for the loopback extraction; the renderer omits `deviceName`; `account.signOut` with several servers
opens Preferences → Accounts; `'accounts' as never` bridges Tasks 13 and 14 for one commit.
