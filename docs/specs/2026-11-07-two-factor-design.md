# Two-step sign-in: authenticator codes and passkeys — design

Date: 2026-11-07 · Status: owner decisions 1–4 below are final · Builds on: the identity design (local
sign-in, §3.6 rate limits), `docs/specs/2026-11-07-settings-split-design.md` §4 (User settings → Password)
· Plan: `docs/plans/2026-11-07-two-factor.md`

## 1. Owner decisions

1. **A passkey is a second factor only.** Signing in with a password stays the first step; a passkey or an
   authenticator code is the second. No passwordless sign-in in this slice; it can come later on the same
   stored passkeys.
2. **Ten recovery codes, shown once.** Made when a person turns two-step sign-in on, each works once, and
   making a new set voids the old one. A server admin can also reset a person's two-step sign-in.
3. **One server-wide switch.** *Require two-step sign-in* under Team settings → Server → Sign-in. A person
   without it must set it up at their next password sign-in before they get a session.
4. **The desktop does passkeys through the system browser,** returning through the loopback as OIDC sign-in
   does today. Authenticator and recovery codes are typed in the app.

## 2. Scope

- Two-step sign-in guards **local password sign-in only**: the desktop's `POST /auth/local/sign-in` and the
  browser's `POST /sign-in/local`. OIDC and SAML sign-ins are not asked for a second factor: the identity
  provider owns that (ruling §9.1). The required switch (§6) does not apply to them either.
- Methods: **authenticator app** (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds) and **passkeys** (WebAuthn,
  any authenticator: platform, security key, phone).
- A person has two-step sign-in **on** when they have at least one confirmed method. One authenticator app
  per person; up to 10 passkeys, each named.
- CI tokens, browser pairing and SCIM are unchanged: they are not password sign-ins.

## 3. Sign-in flow

### 3.1 The second step

1. The password check (`checkLocalCredentials`) runs as today and is not changed. Its rate limits, decoy hash
   and failure events stay where they are, so the username sign-in work on the same function merges cleanly.
2. After it succeeds, a new step, `twoFactorGate`, looks at the user:
   - **No methods, not required:** a session is issued, as today.
   - **Has methods:** no session. The server stores a **challenge** (§3.2) and answers
     `200 { twoFactor: { challenge, methods } }`, where `methods` lists `totp`, `passkey` and `recovery` as
     the person has them. The `201 { token, user }` answer is unchanged.
   - **No methods, required (§6):** no session. A challenge with `setup: true` is answered instead, and the
     client shows the setup screen (§4.3) before the session is issued.
3. The client sends the second factor with the challenge; the server answers `201 { token, user }` as a
   sign-in would and records `auth.signed_in` with `secondFactor: totp | passkey | recovery`.

### 3.2 Challenges

- Table `identity_two_factor_challenges` (§7): id, user, the hash of a 43-character secret, `setup`, the
  sign-in's device name and kind (`device` or `browser`), the WebAuthn challenge when one was asked for, a
  wrong-attempt count, created and expires.
- **Five minutes** to live, **one use**, and **five wrong attempts** end it. The secret is returned once and
  kept only as its hash, like device tokens. The daily sweep deletes expired rows.
- The browser keeps the secret in an HttpOnly cookie, `__Host-wb_2fa` (`wb_2fa` on an `http:` tenant), with
  `SameSite=Strict` and a five-minute `Max-Age`, never in the page. The desktop keeps it in the host process,
  never in the renderer.

### 3.3 Rate limits

- Each second-factor attempt charges the existing identity buckets per address and per user
  (`<tenant>:user:<id>`), 10 a minute, so a stolen password cannot be used to guess codes quickly. With five
  attempts a challenge and six-digit codes, a guess succeeds about once in 200 000 challenges.
- A wrong code, a used recovery code and a failed passkey record `auth.second_factor_failed` with the method
  and reason; never the code.

### 3.4 Codes

- An authenticator code is accepted for the current 30-second step and one step either side. The last step
  used is stored, so a code cannot be replayed within its window, even on a second challenge.
- Recovery codes are 10 characters from a 32-letter alphabet without look-alikes, shown as `xxxxx-xxxxx`;
  case, spaces and dashes are ignored when typed. Each is stored as an HMAC-SHA-256 hash under a key derived
  from the tenant's data key (§7), and marked used on success. When the last one is used, the Password page
  asks the person to make a new set (§5).

### 3.5 Passkeys

- The relying party id is the tenant's **primary** host (`primaryUrl`); a passkey step on a custom domain
  moves to the primary first, as the browser OIDC start does. The origin checked is the primary URL only.
- Registration asks for `userVerification: preferred`, `residentKey: preferred`, no attestation (`none`),
  algorithms ES256 and RS256. Sign-in asks with `allowCredentials` listing the person's passkeys.
- The signature counter is stored; a counter that goes backwards (when not both zero) refuses the passkey and
  records `auth.second_factor_failed` with reason `passkey-counter`.
- The server verifies with `@simplewebauthn/server`; the browser pages use `@simplewebauthn/browser`.

## 4. Clients

### 4.1 Browser client sign-in

- After the password form, the server answers the **second-step page**, server-rendered like the sign-in
  page: a heading "Two-step sign-in", then the person's methods:
  - *Use a passkey* (a button, when they have one), which runs the passkey ceremony.
  - *Authenticator code*: a 6-digit field (`inputmode=numeric`, `autocomplete=one-time-code`) and *Verify*.
  - *Use a recovery code instead*, a link that swaps the field for a recovery code field.
  - *Cancel*, back to the sign-in page, which clears the challenge cookie.
- The page gains **one script**, served by the server at `/sign-in/two-factor.js` with the WebAuthn helper
  bundled in; the page's CSP gains `script-src 'self'` and `connect-src 'self'` and nothing else. Without
  script the code form still works: it is a plain form post to `/sign-in/two-factor`.
- A wrong code re-renders the page with "That code didn't work. Try again." and, once fewer than three
  remain, the attempts left. An ended challenge goes back to the sign-in page with "Sign in again."

### 4.2 Desktop sign-in

- The sign-in dialog gains a **second step** in the same dialog, with the methods of §4.1. Authenticator and
  recovery codes are typed in the app (`account.verifyTwoFactor`).
- *Use a passkey* opens the system browser at the server's passkey page for this sign-in
  (`/sign-in/two-factor/passkey?flow=<id>`); the page runs the ceremony and hands a one-time grant to the
  desktop's loopback, which the host trades with its PKCE verifier for the device token, as OIDC does. The
  dialog shows "Finish in your browser…" with *Cancel*, like OIDC.
- The flow id in that URL is not the challenge secret: the host starts the flow with the secret
  (`POST /auth/two-factor/passkey/browser-start`), and only the id and the grant pass through the browser.

### 4.3 Required setup at sign-in

- When the server requires two-step sign-in and the person has none, both clients show **"Set up two-step
  sign-in"** after the password: the authenticator setup (§5.1) inline, with *Use a passkey instead* in the
  browser client. Confirming the first method shows the recovery codes (§5.3); *I've saved them* issues the
  session.
- The setup challenge reaches the setup routes only; it cannot read or change anything else.

## 5. User settings → Password

The Password page gains a **Two-step sign-in** section under the password form. When local passwords are off
it says "Two-step sign-in applies to password sign-in, which is off on this server." and offers nothing.

- A status line: *On* or *Off*, and "Required on this server" when §6 is on.
- **Authenticator app**: *Set up* when none; otherwise "Added <date>" and *Remove*.
- **Passkeys**: a list (name, added, last used) with *Rename* and *Remove* on each, and *Add a passkey*.
- **Recovery codes**: "N of 10 left" and *Make new codes*, once two-step sign-in is on.
- Removing the last method turns two-step sign-in off and deletes the recovery codes. It asks first, and is
  refused with "This server requires two-step sign-in." when §6 is on.
- Each change asks for the **current password** first, except adding the first method in the required setup
  of §4.3, which follows a password check moments earlier.

### 5.1 Authenticator setup

- *Set up* asks for the password, then shows a QR code, the key as text (grouped in fours, with *Copy*), and a
  code field: "Enter the 6-digit code from your app." *Verify* confirms it.
- The server makes the QR code as SVG (`qrcode`) and answers it with the `otpauth://` URI; the client shows it
  as an `<img>` with a `data:` URL, which the desktop CSP already allows. The secret stays pending until
  confirmed and is dropped after ten minutes unconfirmed.

### 5.2 Adding a passkey

- The browser client runs the ceremony in the page, after asking for a name (defaulting to the browser and
  system, such as "Chrome on macOS").
- The desktop's *Add a passkey* opens the browser client at User settings → Password
  (`/?panel=user&page=password&add=passkey`). The desktop does not run WebAuthn itself (decision 4).

### 5.3 Recovery codes

- Shown once, when the first method is confirmed and on *Make new codes*: a grid of 10 codes, *Copy all*,
  *Download as text* (`wirebench-recovery-codes.txt`), and *I've saved them* to close. They are never shown
  again.

## 6. Requiring two-step sign-in

- A new settings section `twoFactor` (`tenant_settings`, hosted edition §22.12) holding `{ required: boolean }`,
  default `false`, written by server admins through the existing settings routes and shown on Team settings →
  Server → Sign-in as a switch: "Require two-step sign-in for password sign-in."
- Turning it on ends no session. Each person is held to it at their next password sign-in (§4.3).
- The page shows how many people with a password have no second factor yet.

## 7. Server changes

- **Migration `0026_two-factor.sql`** (identity folder), with forced row-level security like the other
  identity tables:
  - `identity_totp (user_id pk, sealed_secret bytea, confirmed_at, last_step bigint, created_at)`: the secret
    sealed AES-256-GCM (`hooks/secret-box.ts`) under a key derived from the tenant's data key with HKDF, salt
    `wirebench-two-factor`.
  - `identity_passkeys (id, user_id, credential_id bytea unique per tenant, public_key bytea, counter bigint,
    transports text[], name, created_at, last_used_at)`.
  - `identity_recovery_codes (user_id, code_hash, used_at)`, and `identity_two_factor_challenges` (§3.2).
- **Routes** under `/api/v1`:
  - `POST /auth/two-factor/verify` `{ challenge, method: totp | recovery, code }` → `201 { token, user }`.
  - `POST /auth/two-factor/passkey/options` `{ challenge }` → WebAuthn request options;
    `POST /auth/two-factor/passkey/verify` `{ challenge, response }` → `201 { token, user }`.
  - `POST /auth/two-factor/passkey/browser-start` `{ challenge, codeChallenge, loopbackPort }` → `{ url }`, and
    `POST /auth/two-factor/passkey/complete` `{ flow, grant, codeVerifier }` → `201 { token, user }` (§4.2).
  - `GET /me/two-factor` → `{ enabled, required, totp, passkeys, recoveryCodesLeft }`.
  - `POST /me/two-factor/totp` `{ password }` → `{ uri, qrSvg, secret }`; `POST /me/two-factor/totp/confirm`
    `{ code }` → `{ recoveryCodes? }`; `DELETE /me/two-factor/totp` `{ password }`.
  - `POST /me/two-factor/passkeys/options` `{ password }`; `POST /me/two-factor/passkeys` `{ name, response }`
    → `{ passkey, recoveryCodes? }`; `PATCH /me/two-factor/passkeys/:id` `{ name }`;
    `DELETE /me/two-factor/passkeys/:id` `{ password }`.
  - `POST /me/two-factor/recovery-codes` `{ password }` → `{ recoveryCodes }`.
  - `DELETE /users/:id/two-factor` (server admin): removes every method and code of that person and ends their
    sessions, like a password reset.
  - The setup challenge of §4.3 reaches the setup routes through `Authorization: TwoFactor <secret>`, accepted
    by those routes only, and the setup's confirm answers `201 { token, user }` with the recovery codes.
  - Browser form routes, with the sign-in form's Origin check: `POST /sign-in/two-factor` (the code form) and
    `GET /sign-in/two-factor/passkey`.
- **Audit actions** added to `AUDIT_ACTIONS`: `auth.second_factor_failed`, `user.two_factor_enabled`,
  `user.two_factor_disabled`, `user.two_factor_method_added`, `user.two_factor_method_removed`,
  `user.recovery_codes_regenerated` and `user.two_factor_reset` (by an admin). Details name the method and the
  passkey id, never a secret, code or public key.
- **Errors**: `identity-two-factor-invalid` (401), `identity-two-factor-expired` (401),
  `identity-two-factor-required` (403, removing the last method while required) and `identity-passkey-failed`
  (401).
- `GET /me` gains `twoFactor: boolean`; a server admin's People row shows a "2-step" badge from the users list.

## 8. Shared code

- `packages/core/src/server-api/identity.ts`: the request and answer schemas above; the local sign-in answer
  becomes a union of the session and the challenge.
- `packages/wire/src/ipc.ts`: `account.verifyTwoFactor`, `account.startTwoFactorPasskey`,
  `account.twoFactorStatus`, `account.setUpTotp`, `account.confirmTotp`, `account.removeTotp`,
  `account.passkeyOptions`, `account.addPasskey`, `account.renamePasskey`, `account.removePasskey` and
  `account.regenerateRecoveryCodes`; `account.signInLocal` may answer a second-step state.
- The renderer does not value-import `@wirebench/engine` or `@shared/wire-types.js` (the CSP trap); the
  WebAuthn browser helper is imported only by the browser client's Password page and the sign-in script.

## 9. Rulings

1. **SSO sign-ins skip the second factor.** OIDC and SAML identity providers own multi-factor sign-in; asking
   twice adds friction and no safety. The required switch says so in its hint.
2. **Recovery codes belong to the person,** not to a method: removing one method keeps them while another
   remains.
3. **The admin reset also ends sessions.** Someone who lost their phone may have lost it to someone else.
4. **No "remember this device".** Every password sign-in asks for the second factor; device tokens already
   last until they idle out, so the prompt is rare.
5. **No SMS or email codes.** Both are weaker than an authenticator, and need a sender this server may lack.
6. **The password check's decoy and timing are untouched.** The second step starts only after a correct
   password, so it tells an attacker nothing new about which emails have accounts.

## 10. Testing

- Unit: TOTP against the RFC 6238 test vectors, the ±1 window and replay; recovery code format, normalising and
  hashing; the challenge's expiry, one use and attempt count; the sealed secret's round trip and tenant binding.
- Server: sign-in with and without methods on both local routes; each second-factor route's success, wrong
  code, expired and used challenge, and rate limit; passkey registration and sign-in with a software
  authenticator, and a counter that goes backwards; the required switch at sign-in; the password on every
  `/me/two-factor` change; the admin reset; audit events and their details; RLS on the new tables.
- Host: `account.signInLocal`'s second step, the passkey loopback hand-off and its cancel.
- Renderer: the Password page section in each state; the sign-in dialog's second step.
- Browser e2e: set up an authenticator (the code computed in the test), sign out, sign in with a code and with
  a recovery code; the required setup at sign-in; passkeys through Chromium's virtual authenticator (CDP
  `WebAuthn.addVirtualAuthenticator`).
- Desktop e2e: sign in with an authenticator code; *Use a passkey* opens the browser (`openExternal` stubbed).
