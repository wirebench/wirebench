# Security model

Wirebench is a local desktop app that holds real credentials for real services. This page
describes, in plain words, what protects them — and, at the end, what the test hooks do and
why they are in the shipped binary.

The one-line version: **the renderer is treated as untrusted; the main process is the only
thing with authority, and it verifies everything it is asked to do.**

## The renderer is sandboxed

Every window runs with the same hardened `webPreferences` — `contextIsolation: true`,
`sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
`allowRunningInsecureContent: false` — pinned as one object
(`apps/desktop/src/main/security.ts`) and snapshot-tested
(`apps/desktop/test/security-baseline.test.ts`), so a window created with weaker settings
fails the build rather than shipping.

A strict CSP (`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`) is
applied both as a response header and as a `<meta>` tag, so it holds in the dev server as well
as in the packaged app. `style-src 'unsafe-inline'` is there for Monaco's inline styles and is
the only relaxation.

The packaged renderer is served from a custom `app://wirebench/…` protocol rather than
`file://`. A `file://` origin is opaque, which breaks Monaco's workers; `app://` is registered
as a standard, secure scheme with CORS off, so the renderer has a real origin that the CSP,
`fetch` and workers all agree on.

No remote content is ever loaded. Navigation away from the app is blocked, and
`shell.openExternal` accepts `http:`/`https:` only — never `file:`, `javascript:` or any other
scheme handler.

## The bridge is narrow and typed

Preload publishes exactly one object, `window.wirebench.*`, through `contextBridge`.
`ipcRenderer` itself is never exposed: the renderer can call the methods that exist and has no
way to reach a channel that was not deliberately published.

Every channel is declared once, in `apps/desktop/src/shared/ipc.ts`, with a zod schema for the
request *and* for the response. Both directions are validated: a malformed or hostile message
fails at the boundary with a typed error instead of somewhere deeper where it would be a bug.
Most request schemas are plain `z.object`, which strips unknown fields rather than rejecting
them — an extra field the renderer sends is silently dropped, not returned as an error. That is
an acceptable relaxation at this boundary: the renderer is our own code, unknown fields carry no
authority (only the fields the schema declares are ever read), and stripping keeps this trust
boundary from becoming a place where every unrelated renderer change has to be coordinated with
the schema. The one exception is `sendTlsOptionsSchema` (`apps/desktop/src/shared/wire-types.ts`),
which is `z.strictObject`: TLS options control certificate verification, so a field the schema
does not know about — for instance a typo'd `rejectUnauthorized` — is rejected outright rather
than silently ignored, since silently ignoring it there could leave a user believing an option
took effect when it did not.

## Secrets live in the OS keychain, behind references

Passwords, keystore passphrases and tokens are stored in `userData/secrets.json`, encrypted
with Electron's `safeStorage` (macOS Keychain, Windows DPAPI, libsecret). Project files carry
only an opaque `secretRef: "sec_…"`.

**There is no `secrets.get` channel.** The renderer can create, replace, test-for-existence,
delete and list (ids and labels) — it can never read a value back. Refs are resolved to values
only in main, at the moment of use. Anything logged, exported or shown is redacted first:
`Authorization`, `Proxy-Authorization`, WSS passwords, keystore passwords.

Where no keyring is available (some headless Linux setups), the store degrades to base64
plaintext, marks that entry `encrypted: false`, and logs one warning rather than refusing to
run. That is a real weakening on such systems, and it is stated in the file rather than
hidden. Full reasoning: [ADR-0004](adr/0004-secrets-outside-project-files.md).

## Paths from the renderer are proven, not trusted

Main never opens a path just because the renderer named one. A path is usable only if it is
**contained** — inside the project folder or its caches, with `realpath` resolved through the
existing prefix so a planted symlink cannot escape the check — or **dialog-proven**: the user
drove a native OS dialog to that exact path this session, and main remembers it. Both halves
meet in one predicate, so every file-touching feature asks the same question.

Names the user types become path segments only through `slugify`, which cannot produce a
traversal segment, strips characters illegal on any supported OS, and refuses Windows device
names. Full reasoning: [ADR-0005](adr/0005-renderer-path-safety.md).

## TLS

Certificate verification is on by default, everywhere. Turning it off is per endpoint
(`trustInvalid`), never global, and the UI badges such an endpoint in red permanently, so a
debugging shortcut cannot quietly become the way a project always runs. Custom trust anchors
and client certificates are configured per endpoint too, and both are reflected in the SSL Info
inspector and in exported cURL commands (as a note, never with the credential).

## The packaged binary

Six Electron fuses are flipped into the executable at build time
(`scripts/fuses.ts`, table `WIREBENCH_FUSES`), and the packaged e2e reads them back off the
built binary to make sure none was quietly dropped:

| Fuse | Setting | Why |
|---|---|---|
| `RunAsNode` | off | The app binary is not a general-purpose Node interpreter |
| `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` cannot inject `--require` |
| `EnableNodeCliInspectArguments` | off | No debugger can be attached to read secrets |
| `EnableCookieEncryption` | on | Session cookies encrypted at rest |
| `EnableEmbeddedAsarIntegrityValidation` | on | The asar is hash-checked against the binary |
| `OnlyLoadAppFromAsar` | on | No loading app code from a directory beside the asar |

Update checks are opt-in and consent-gated; the feed is GitHub Releases, and the repository URL
is parsed with the host anchored, so a look-alike host cannot become an update source.

## Test hooks in the shipped binary

Several `WIREBENCH_E2E_*` environment variables — plus `WIREBENCH_E2E`,
`WIREBENCH_USER_DATA_DIR` and `WIREBENCH_SKIP_PERF` — are honoured by the app **including the
packaged build**. That is deliberate, and worth being explicit about.

| Variable | Effect |
|---|---|
| `WIREBENCH_E2E` | Mirrored to the renderer as `window.wirebench.env.e2e`; makes editor internals reachable for assertions |
| `WIREBENCH_USER_DATA_DIR` | Uses a throwaway profile directory instead of the real one |
| `WIREBENCH_E2E_OPEN_PATH`, `WIREBENCH_E2E_SAVE_PATH`, `WIREBENCH_E2E_FILE_DIALOG_PATH`, `WIREBENCH_E2E_DIALOG_FOLDER`, `WIREBENCH_E2E_DIALOG_SAVE` | Answer a native open/save dialog with a preset path instead of showing it |
| `WIREBENCH_E2E_EXTRA_CA_FILE` | Adds a CA bundle so the test server's self-signed certificate verifies |
| `WIREBENCH_E2E_DEBUG_CONSOLE` | Extra diagnostic output |
| `WIREBENCH_SKIP_PERF` | Skips the performance gates |

**Why this is acceptable.** Every one of these is read from the process environment. An
attacker who can set the environment of a process you launch already runs code as you: they
can read `~/.ssh`, install a shim earlier in `PATH`, or attach to the app's own profile
directory directly. There is no privilege boundary between "a program running as you" and
"the app running as you" for a local-user desktop application, so a hook readable only by
someone who is already on that side of the line grants nothing new. The alternative —
maintaining a separate, differently-built binary for e2e — would mean the tests stop proving
anything about the artifact users actually install, which is the more serious loss. The e2e
suite runs against the *packaged* app precisely so that it does.

**What they do not do.** None of these hooks bypasses main's checks:

- The dialog hooks replace the *dialog*, not the authorization. A path supplied that way is
  recorded as a dialog pick and still goes through the same containment/dialog-evidence
  predicate as a real pick — it grants exactly what clicking the same file in a real dialog
  would.
- No hook exposes a secret value to the renderer; there is still no channel that returns one.
- No hook relaxes `webPreferences`, the CSP, the fuses, navigation blocking or
  `shell.openExternal` filtering.
- `WIREBENCH_E2E_EXTRA_CA_FILE` *adds* a trust anchor from a file the user's own environment
  names; it does not turn verification off.

## Reporting a vulnerability

Open a GitHub issue for anything already public. For something not yet public, contact the
maintainers privately through the repository's security advisory page rather than filing a
public issue.
