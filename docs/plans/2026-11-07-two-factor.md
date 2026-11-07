# Two-step sign-in — implementation plan

**Goal:** Password sign-in gains a second step: an authenticator code (TOTP), a passkey (WebAuthn) or a recovery
code. People turn it on in User settings → Password; a server admin can require it server-wide and reset a
person's methods. The desktop types codes in the app and does passkeys through the system browser and its
loopback.

**Spec:** `docs/specs/2026-11-07-two-factor-design.md` (owner decisions §1, rulings §9). Builds on the settings
split (#858: User settings → Password, Team settings → Server → Sign-in).

## Global constraints

- One commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green, as Mohammed Naami
  <m.naami@outlook.com>, no trailers. `pnpm test:perf` before every push.
- No local Electron or e2e windows; e2e runs in CI.
- Renderer files never value-import from `@shared/wire-types.js` or `@wirebench/engine` (the zod CSP probe).
- `eslint.config.js` is protected: do not touch it. Never `git stash` bare.
- No other product named anywhere (`pnpm check:banned-terms`).
- **`checkLocalCredentials` is not edited.** The username sign-in work (`feat/user-profile`) changes it and its
  callers' first lines; this work adds one call after it in each caller (`twoFactorGate`), so the two merge with
  at most a small conflict in the callers. Expect a rebase.
- No secret, code, recovery code, public key or challenge secret in a log line, an audit detail or an error
  message.

## Review focus

- **No session without the second factor** (Tasks 5, 8): both local routes answer a challenge, never a token,
  for a person with a method or under the required switch; the setup challenge reaches the setup routes only.
- **Challenges are one-use and short** (Task 5): taken with `delete … returning` in the same unit as the token,
  five minutes, five wrong attempts, hashed at rest.
- **Replay** (Tasks 2, 5): a TOTP step is accepted once per person (`last_step`), a recovery code once, a
  passkey's counter never goes backwards.
- **Re-authentication** (Task 6): every `/me/two-factor` change but a rename checks the current password.
- **Tenancy** (Task 3): every new table is scoped by `tenant_scope()`, and the sealed TOTP secret is bound to its
  tenant and person (the HKDF info carries the user id).

## Rulings (spec gaps found while planning)

1. **Migration number.** `0026_two-factor.sql` in `migrations/identity/`, the next free number across all
   folders today. If `feat/user-profile` lands a `0026` first, this one is renumbered at the rebase.
2. **The passkey page script is hand-written,** not `@simplewebauthn/browser`: the server has no bundler for
   page assets, and the page needs only base64url conversions around `navigator.credentials.get` (about 60
   lines in `identity/two-factor/page-script.ts`, served at `/sign-in/two-factor.js` under `script-src 'self'`,
   spec §4.1). The renderer uses `@simplewebauthn/browser` for registration; vite bundles it.
3. **Passkeys need the primary host.** The relying party id is the primary host (spec §3.5), and the challenge
   cookie is `__Host-` (host-only). On a custom domain the second-step page offers codes, plus "To use a
   passkey, sign in at <primary>." as a link; the browser client's *Add a passkey* says the same there.
4. **The desktop's passkey flow lives on the challenge row:** `flow_id`, `code_challenge`, `loopback_port` and
   `grant_hash` columns, rather than another flow table. Once a flow is started, the challenge can only end
   through it.
5. **The desktop's required setup offers the authenticator only.** Adding a passkey needs a session in the
   browser client, which the person does not have yet; they can add one afterwards.
6. **Two-step sign-in needs a password.** The `/me/two-factor` change routes answer `identity-method-disabled`
   when local passwords are off or the person has no password (an SSO-only account); `GET /me/two-factor`
   answers `{ available: false }` then, and the Password page shows the spec §5 sentence.
7. **The authenticator's label** is `Wirebench (<primary host>):<email>`, issuer `Wirebench`, so two servers do
   not overwrite each other's entry in the app.
8. **The users list gains `twoFactor: boolean`** (`usersResponseSchema`), for the People badge and the Sign-in
   page's count (spec §6), so neither needs a new route.
9. **The second step's rate limits** are a limiter of their own, `two-factor` (spec §3.3), 10 a minute per address
   and per user, with the per-user key in the existing `<tenant>:user:<id>` shape (as `callerKey`) from the
   challenge's user, since the request has no caller yet. The lockout is a second limiter,
   `two-factor-failures` (capacity 10, refilled over 15 minutes), peeked before an attempt and taken only on a
   failure, as the agent module's failed-pairing limit is.
10. **Self-hosted, the required switch is an environment variable,** `WIREBENCH_SERVER_REQUIRE_TWO_FACTOR`
    (default `false`): a self-hosted server answers every settings section read-only from its environment
    (settings split), so the `twoFactor` section reads `{ required }` from it there and is writable only on a
    hosted tenant.
11. **The two-step queries live in `identity/two-factor/repo.ts`,** not `identity/repo.ts`, so the username
    sign-in work on `repo.ts` merges cleanly. The challenge row has `purpose` (`sign-in`, `setup` or
    `register`) in place of `setup boolean`, so a passkey registration challenge uses the same table.

## Tasks

### Task 1 — spec and plan

- [ ] This plan; the spec's Plan line names it. (Spec #862.)

### Task 2 — server: TOTP and recovery code primitives

Files:

- `packages/server/src/identity/two-factor/totp.ts`:
  - `newTotpSecret(): Buffer` (20 random bytes), `base32(secret): string`, `otpauthUri({ secret, label, issuer })`.
  - `totpAt(secret: Buffer, step: number): string` (HMAC-SHA-1, dynamic truncation, 6 digits).
  - `verifyTotp(secret, code, nowMs, lastStep): { ok: true; step: number } | { ok: false }`: steps `t-1, t, t+1`,
    each `> lastStep`, compared with `timingSafeEqual`.
- `packages/server/src/identity/two-factor/recovery.ts`: `newRecoveryCodes(): string[]` (10 codes of 10
  characters from a 32-letter alphabet without look-alikes, formatted `xxxxx-xxxxx`), `normaliseRecoveryCode`,
  `recoveryCodeHash(key, code)` (HMAC-SHA-256 hex).
- `packages/server/src/identity/two-factor/keys.ts`: `twoFactorKey(dataKey, userId, use: 'totp' | 'recovery')`,
  HKDF-SHA-256 with salt `wirebench-two-factor` and info `<use>:<userId>`; `sealTotpSecret` / `openTotpSecret`
  over `hooks/secret-box.ts`.

Tests — `packages/server/test/unit/identity/two-factor.test.ts`:

- `it('matches the RFC 6238 SHA-1 vectors')` (times 59, 1111111109, 1111111111, 1234567890, 2000000000 and
  20000000000; the last six digits of the published values).
- `it('accepts one step either side, refuses two, and refuses a step at or before lastStep')`.
- `it('recovery codes: ten, unique, the alphabet, and normalising ignores case, spaces and dashes')`.
- `it('a sealed secret opens for its person only')` — another user id or another data key throws.

Commit: `server: TOTP and recovery code primitives`.

### Task 3 — server: migration and repo

Files:

- `packages/server/migrations/identity/0026_two-factor.sql`: the four tables of spec §7, `tenant_id` first in
  each key with the setting default, `references users … on delete cascade` through `(tenant_id, user_id)` as
  0021 shapes them, and `select tenant_scope(…)` for each. `identity_two_factor_challenges`: `id`, `user_id`,
  `secret_hash unique`, `purpose` (ruling 11), `device_name`, `token_kind`, `webauthn_challenge`, `attempts int`,
  `flow_id unique`, `code_challenge`, `loopback_port`, `grant_hash`, `created_at`, `expires_at` (ruling 4).
- `packages/server/src/identity/two-factor/repo.ts` (ruling 11): `totpOf`, `upsertPendingTotp`, `confirmTotp`, `setTotpLastStep`
  (`update … where last_step < $step`, answering whether it moved: the replay guard under concurrency),
  `deleteTotp`; `passkeysOf`, `passkeyByCredentialId`, `insertPasskey`, `renamePasskey`, `deletePasskey`,
  `setPasskeyCounter`; `replaceRecoveryCodes`, `useRecoveryCode` (`update … where used_at is null returning`),
  `recoveryCodesLeft`; `insertChallenge`, `challengeBySecretHash`, `bumpChallengeAttempts`, `takeChallenge`
  (delete returning), `setChallengeWebauthn`, `startChallengeFlow`, `takeChallengeByFlow`;
  `deleteTwoFactorOf(userId)`; `twoFactorUsers(userIds)` for the users list; `deleteExpiredChallenges`, and the
  delete of unconfirmed TOTP rows older than ten minutes.
- `packages/server/src/identity/sessions.ts`: `sweepExpired` calls the two deletes.
- The tenant-scope and catalog checks (`check:tenant-scope`, `test/helpers/catalog.ts`): the new tables.

Tests — `packages/server/test/integration/identity/two-factor-repo.test.ts`:

- `it('scopes every new table to its tenant')` — rows written in tenant A are invisible in B.
- `it('a recovery code and a challenge are taken once under two racing takes')`.
- `it('setTotpLastStep refuses a step at or below the stored one')`.
- `it('the sweep deletes expired challenges and stale pending secrets, and keeps the rest')`.
- `it('deleting a user deletes their methods')`.

Commit: `server: two-step sign-in tables and repo`.

### Task 4 — server and wire: the twoFactor settings section

Files:

- `packages/server/src/settings/sections.ts`: `twoFactor` in `SETTINGS_SECTIONS`, input
  `z.strictObject({ required: z.boolean() })`, no secret fields; an absent row means not required.
- `packages/wire/src/wire-base.ts`: `twoFactor` in `SERVER_SETTINGS_SECTIONS` and `SERVER_SETTINGS_WRITABLE`, and
  its view schema.
- `packages/server/src/identity/two-factor/required.ts`: `twoFactorRequired(ctx, scope): Promise<boolean>`.

Tests — the settings integration suite: `it('a server admin sets twoFactor.required; a member is refused')`,
`it('an unknown field is refused')`.

Commit: `server: a twoFactor settings section`.

### Task 5 — server: the second step at sign-in

Files:

- `packages/core/src/server-api/identity.ts`: `TWO_FACTOR_METHODS = ['totp', 'passkey', 'recovery']`,
  `twoFactorChallengeResponseSchema` (`{ twoFactor: { challenge, methods, setup } }`),
  `localSignInResponseSchema = z.union([signInResponseSchema, twoFactorChallengeResponseSchema])`,
  `twoFactorVerifyRequestSchema` (`{ challenge, method: 'totp' | 'recovery', code }`).
- `packages/core/src/server-api/audit.ts`: the eight actions of spec §7.
- `packages/server/src/identity/errors.ts`: `twoFactorInvalid`, `twoFactorExpired`, `twoFactorRequired`,
  `passkeyFailed`.
- `packages/server/src/identity/two-factor/gate.ts`:

  ```ts
  /** After a correct password: a session's go-ahead, or a challenge (spec §3.1). */
  export async function twoFactorGate(
    env: IdentityEnv,
    scope: TenantScope,
    user: repo.UserRow,
    sign: { readonly deviceName: string; readonly kind: repo.TokenKind },
  ): Promise<{ readonly challenge: undefined } | { readonly challenge: TwoFactorChallenge }>;

  /** The challenge for `secret`, or `twoFactorExpired()`; charges the `two-factor` buckets, checks the lockout. */
  export async function presentedChallenge(env, request, secret): Promise<ChallengeRow>;

  /** A wrong answer: attempts + 1, the challenge dropped at five, the lockout charged, `auth.second_factor_failed`. */
  export async function failedAttempt(env, scope, source, row, method, reason): Promise<never>;

  /** Takes the challenge and issues the session with `auth.signed_in` and `secondFactor`, in one unit. */
  export async function finishChallenge(env, scope, row, method, source): Promise<SignInResponse>;
  ```

  `signIn` (`sessions.ts`) gains an optional `secondFactor` detail; nothing else in it changes.
- `routes/auth-local.ts`: after `checkLocalCredentials`, `twoFactorGate`; a challenge answers 200 with
  `twoFactorChallengeResponseSchema`. The 201 schema stays.
- `routes/two-factor.ts` (new): `POST /auth/two-factor/verify`: TOTP through `openTotpSecret`, `verifyTotp` and
  `setTotpLastStep`; recovery through `useRecoveryCode`; `finishChallenge` on success.
- `routes/browser-sign-in.ts`: after `checkLocalCredentials`, `twoFactorGate`; a challenge sets the `wb_2fa`
  cookie (`cookies.ts`: `setChallengeCookie`, `clearChallengeCookie`, `challengeCookie`) and answers the
  second-step page (Task 8 renders the full page; this task answers a plain code form).
- `README.md` and `test/integration/tenancy/route-map.ts`: the new route.

Tests — `packages/server/test/integration/identity/two-factor-sign-in.test.ts`:

- `it('a person without methods signs in as before')` — both routes.
- `it('a person with an authenticator gets a challenge, no token, then a session for a right code')`.
- `it('a wrong code counts; the fifth ends the challenge; a used challenge is expired')`.
- `it('a code is not accepted twice, even on a new challenge')`.
- `it('a recovery code works once')`.
- `it('an expired challenge is refused')` (clock injected).
- `it('the second step charges its own buckets, not the password step\'s')`.
- `it('ten wrong factors lock the second step for the person, with the usual 429, and audit it once')`.
- `it('every wrong factor answers the same problem, whatever the method or reason')`.
- `it('records auth.second_factor_failed without the code, and auth.signed_in with secondFactor')`.
- `it('the required switch answers a setup challenge to a person without methods')`.
- `it('the browser form sets the challenge cookie and the code form finishes the session')`.

Commit: `server: password sign-in asks for a second step`.

### Task 6 — server: enrolment, status, admin reset

Files:

- `packages/core/src/server-api/identity.ts`: `twoFactorStatusSchema`, `totpSetupResponseSchema`
  (`{ uri, qrSvg, secret }`), `totpConfirmRequestSchema`, `recoveryCodesResponseSchema`, `reauthRequestSchema`
  (`{ password }`); `meResponseSchema` gains `twoFactor`, and the users list rows gain it too (ruling 8).
- `packages/server/package.json`: `qrcode` (MIT) and `@types/qrcode`; the licences list.
- `routes/me-two-factor.ts` (new): the `/me/two-factor` routes of spec §7 except passkeys (Task 7). A
  `twoFactorCaller` preHandler accepts a signed-in caller, or `Authorization: TwoFactor <secret>` naming a setup
  challenge (setup routes only). Re-authentication through `verifyPassword` (ruling 6). The first confirmed
  method makes recovery codes; with a setup challenge the confirm also takes the challenge and answers
  `201 { token, user, recoveryCodes }`. Removing the last method under the required switch → `twoFactorRequired()`.
- `routes/users.ts`: `DELETE /users/:id/two-factor` (server admin): `deleteTwoFactorOf`, revoke the user's tokens,
  announce `sessionEnded`, audit `user.two_factor_reset`.
- `routes/me.ts`: `twoFactor` on `GET /me` and `PATCH /me`.

Tests — `packages/server/test/integration/identity/two-factor-enrol.test.ts`:

- `it('setting up an authenticator needs the password, answers a QR code, and stays pending until confirmed')`.
- `it('confirming answers ten recovery codes once; the status shows enabled and 10 left')`.
- `it('making new codes voids the old set')`.
- `it('removing the last method turns it off and deletes the codes; refused while required')`.
- `it('an SSO-only person is told two-step sign-in needs a password')`.
- `it('a setup challenge reaches only the setup routes and its confirm signs in')`.
- `it('an admin reset removes every method and ends every session')`.
- `it('records each change with the method and no secret')`.

Commit: `server: set up and remove two-step sign-in`.

### Task 7 — server: passkeys

Files:

- `packages/server/package.json`: `@simplewebauthn/server` (MIT); the licences list.
- `packages/server/src/identity/two-factor/passkeys.ts`: `registrationOptions`, `verifyRegistration`,
  `authenticationOptions` and `verifyAuthentication` around `@simplewebauthn/server`, with `rpID` and
  `expectedOrigin` from `primaryUrl` (spec §3.5). The sign-in's WebAuthn challenge is stored on its two-factor
  challenge row; a registration's on a short-lived challenge row of the signed-in caller.
- `routes/two-factor.ts`: `POST /auth/two-factor/passkey/options` and `/verify`.
- `routes/me-two-factor.ts`: the four passkey routes of spec §7, at most 10 passkeys per person.

Tests — `packages/server/test/integration/identity/two-factor-passkeys.test.ts`, with a software authenticator
(`test/helpers/soft-authenticator.ts`: P-256 through `node:crypto`, making `none` attestations and assertions):

- `it('registers a passkey after the password, and lists it by name')`.
- `it('signs in with the passkey as the second step')`.
- `it('refuses an unknown credential, another origin, and a counter that goes backwards')`.
- `it('an eleventh passkey is refused')`.
- `it('rename needs no password; remove does')`.

Commit: `server: passkeys as a second step`.

### Task 8 — server: the browser's second-step page and the desktop's passkey hand-off

Files:

- `packages/server/src/identity/two-factor-page.ts`: `renderTwoFactorPage({ serverUrl, methods, message,
  attemptsLeft, passkeyHere, primaryUrl, redirectTo })`, escaped like the sign-in page; its CSP is the sign-in
  page's plus `script-src 'self'` and `connect-src 'self'`.
- `packages/server/src/identity/two-factor/page-script.ts`: the hand-written script (ruling 2), served at
  `/sign-in/two-factor.js`: fetch the options, `navigator.credentials.get`, post the answer, follow the redirect;
  on the desktop's flow page, go to the loopback with the grant instead.
- `routes/browser-sign-in.ts`: `POST /sign-in/two-factor` (code form; Origin check; cookie),
  `POST /sign-in/two-factor/cancel`, the script's JSON calls (`/sign-in/two-factor/passkey/options` and
  `/verify`, cookie-bound and Origin-checked), and `GET /sign-in/two-factor/passkey?flow=` for the desktop.
- `routes/two-factor.ts`: `POST /auth/two-factor/passkey/browser-start` and `/complete`, with PKCE as
  `auth-oidc.ts` does it (ruling 4).

Tests — `packages/server/test/integration/identity/two-factor-browser.test.ts`:

- `it('the page lists only the person’s methods and escapes every value')`.
- `it('the code form refuses another Origin and a missing cookie')`.
- `it('a right code sets the session cookie and clears the challenge cookie')`.
- `it('on a custom domain the page offers codes and links to the primary for passkeys')`.
- `it('the desktop flow: browser-start, the passkey on the page, the grant to the loopback, complete with the verifier')`.
- `it('complete refuses a wrong verifier, a used grant and an expired flow')`.
- `it('the page's CSP allows the served script and nothing else')`.

Commit: `server: the browser's second step and the desktop's passkey hand-off`.

### Task 9 — wire and host

Files:

- `packages/wire/src/wire-base.ts` and `ipc.ts`: the channels of spec §8. `account.signInLocal` answers
  `accountResponseSchema` or `{ twoFactor: { methods, setup } }`: the challenge secret stays in the host
  (spec §3.2). `account.setUpTotp` answers `{ uri, qrSvg, secret }`; recovery codes cross once, in the confirm's
  or the regenerate's answer.
- `packages/host/src/server-client.ts`: one method per server route.
- `packages/host/src/account-service.ts`: one pending second step per sign-in (the secret, the server, the device
  name), dropped on cancel, on success and after five minutes; `verifyTwoFactor`; `startTwoFactorPasskey`, reusing
  `browserSignIn`'s loopback (`browser-start`, `openExternal`, the grant, `complete`); the setup calls with the
  pending secret.
- `packages/host/src/ipc/account.ts`: the handlers.

Tests — `packages/host/test/account-service-two-factor.test.ts`:

- `it('signInLocal holds the challenge and answers the methods only')`.
- `it('verifyTwoFactor finishes the sign-in and stores the account')`.
- `it('the passkey hand-off opens the browser and completes with the grant; cancel ends it')`.
- `it('a pending step is dropped after five minutes')`.

Commit: `host: the second sign-in step and the two-step settings channels`.

### Task 10 — renderer: the sign-in dialog's second step

Files:

- `apps/desktop/src/renderer/features/account/sign-in-dialog.tsx`: a second-step stage after the password, with
  the methods of spec §4.1: a code field, *Use a recovery code instead*, *Use a passkey* (then "Finish in your
  browser…" with *Cancel*) and *Back*. The setup stage (ruling 5): QR code, key, code, then the recovery codes.
- `apps/desktop/src/renderer/features/account/two-factor/recovery-codes.tsx`: the grid, *Copy all*, *Download as
  text*, *I've saved them* (shared with Task 11).

Tests — `apps/desktop/test/renderer/sign-in-two-factor.test.tsx`: each stage; a wrong code keeps the field and
shows the message; the setup's codes are shown once.

Commit: `desktop: the sign-in dialog asks for the second step`.

### Task 11 — renderer: User settings → Password, the two-step section

Files:

- `apps/desktop/src/renderer/features/preferences/user/two-factor-section.tsx`: spec §5's section (status,
  authenticator, passkeys, recovery codes), each change behind a password prompt.
- `apps/desktop/src/renderer/features/preferences/user/passkey-register.ts`: `@simplewebauthn/browser`'s
  `startRegistration`, in the browser client only; the desktop's *Add a passkey* opens the browser client at
  `/?panel=user&page=password&add=passkey` (ruling 3 on a custom domain).
- The browser client's User settings address, `panel=user&page=<page>[&add=passkey]`, parsed beside `team-link.ts`.
- `apps/desktop/package.json`: `@simplewebauthn/browser` (MIT); the licences list.

Tests — `apps/desktop/test/renderer/two-factor-section.test.tsx`: off, on, required, SSO-only; set up; removing the
last method asks first; adding a passkey in the browser client, and the desktop's link.

Commit: `desktop: two-step sign-in on the Password page`.

### Task 12 — renderer: the required switch and the People badge

Files:

- `apps/desktop/src/renderer/features/preferences/server/sign-in-section.tsx`: the switch (spec §6), with the count
  of password users without a second factor, from the users list.
- Team settings → People: a "2-step" badge on the rows of people with it on, for server admins only; the row's ⋯
  menu gains *Reset two-step sign-in* behind a confirm.

Tests — the server-page and People renderer tests: the switch saves `twoFactor.required`; the badge and the reset
show for a server admin only.

Commit: `desktop: require two-step sign-in, and reset it for a person`.

### Task 13 — e2e

- `e2e/browser/two-factor.spec.ts`: set up an authenticator (the code computed in the test from the shown key),
  sign out, sign in with a code and with a recovery code; turn the required switch on and sign in as a person
  without it; add a passkey and sign in with it through CDP `WebAuthn.addVirtualAuthenticator`.
- `e2e/specs/auth.spec.ts` (desktop, fake server): the second step with a code; *Use a passkey* calls the stubbed
  `openExternal`.

Commit: `e2e: two-step sign-in in the browser client and the desktop`.

### Task 14 — docs and changelog

- `packages/server/README.md`: the routes and the settings section. The user docs gain a "Two-step sign-in" page
  under the account docs. `CHANGELOG.md` `[Unreleased]` → Added.

Commit: `docs: two-step sign-in`.

### Task 15 — ship

- `pnpm test:perf`, push, open the implementation PR, Auto-fix on, CI green; the owner merges.

## Order and parallel work

Tasks 2–8 are the server, in order, each building on the last. Task 9 needs the schemas of 5–8; Tasks 10–12 need
9; Task 13 needs everything. One branch, `feat/two-factor`, one PR; no parallel sessions, since every task touches
the identity module or the account channels.

## Unresolved questions

None blocking. Ruling 3 (no passkeys on a custom domain; a link to the primary instead) is the one the owner may
want to revisit.
