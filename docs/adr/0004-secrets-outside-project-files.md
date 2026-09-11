# ADR-0004: No secrets in project files — `safeStorage` plus `secretRef`

- Status: accepted
- Date: 2026-09-10 (recorded 2026-09-11; decision made in Task 33a)
- Context: spec §4, §7, §13 SC7; global constraint "secrets only via `safeStorage` + `secretRef`"

## Context

A Wirebench project holds endpoint credentials: HTTP Basic and NTLM passwords, WS-Security
UsernameToken passwords, PKCS#12 and PEM keystore passwords, proxy credentials. A project
folder is meant to be committed to git and shared with a team (ADR-0003). Those two facts
cannot both be honoured by a format that stores the credential.

The traditional answer — an encrypted-with-a-project-password blob inside the project file —
makes the secret travel with the project and reduces its safety to one shared passphrase.

## Decision

**A secret value never enters a project file, a log, or an IPC response.**

- Values live in `userData/secrets.json`, encrypted with Electron's `safeStorage` (macOS
  Keychain, Windows DPAPI, libsecret on Linux), one entry per secret.
- Project files carry only an opaque reference — `passwordSecretRef: "sec_…"` — which is
  meaningless on another machine.
- **There is no `secrets.get` IPC channel.** The renderer can create, replace, test existence
  of, delete and list secrets (labels and ids), and can never read a value back. Resolution
  from ref to value happens only in the main process, at the moment of use
  (`apps/desktop/src/main/secret-resolver.ts`).
- Everything logged or shown is redacted at the boundary: `Authorization`, `Proxy-Authorization`,
  WSS passwords and keystore passwords (`apps/desktop/src/main/redact.ts`).

Where a keyring is genuinely unavailable — some headless Linux CI and dev setups —
`safeStorage.isEncryptionAvailable()` is false; the store then writes base64 plaintext, marks
that entry `encrypted: false`, and logs one warning, rather than refusing to run. The
encryption flag is per entry, so a file written across a keyring change stays readable.

## Rationale

- **Sharing the project must not share the credentials.** A ref is safe to commit; a
  ciphertext that travels with its own password is not.
- **The renderer is the untrusted half** (ADR-0005). A channel that returns a secret value
  would put every credential one XSS-equivalent bug away from exfiltration; not having the
  channel is a stronger guarantee than guarding it.
- **The OS already solved key storage**, per platform, with hardware backing where available.
- **This is testable, and tested.** SC7 is proven by a test that saves a project containing
  every kind of credential and greps the resulting folder for the plaintext
  (`e2e/specs/secrets.spec.ts`, `apps/desktop/test/secrets.test.ts`).

## Consequences

- Moving a project to another machine means re-entering its secrets. This is the intended
  cost; the UI shows which refs are unresolved rather than failing at send time.
- Secret-using engine APIs take resolved values, not refs: the engine knows nothing about
  keychains, and the resolution step is a main-process concern with one implementation.
- The no-keyring fallback is a real weakening on such systems. It is explicit in the file
  (`encrypted: false`), warned about once, and documented in
  [`../security.md`](../security.md) rather than hidden.
