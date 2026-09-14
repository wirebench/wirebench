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

## A WSDL is not a file-read primitive

Importing a definition means fetching whatever it references, transitively, so the references
themselves are untrusted input. Two rules bound what an import can touch.

The path the import starts from is proven like any other: `definition.import { kind: 'file' }`
runs the same containment/dialog-pick check above and refuses anything else
(`import-path-refused`). A file dropped on the import dialog is not a dialog pick, so the
renderer reads the dropped bytes itself and imports them as text — at the cost that the
dropped document's own relative imports no longer resolve, which the import reports along with
"use Browse…".

Nested `wsdl:import`/`xs:import`/`xs:include` references are confined to the root document's
world: a definition imported from a file may reference only files inside that file's folder
(compared as real paths, so a symlink cannot walk out); a definition fetched over `http(s)`
may reference any `http(s)` host but never `file:`; a pasted or dropped one may never reach
the disk at all. A refused reference becomes an `import-ref-refused` problem and the import
completes with what did resolve. The graph is capped at 32 levels and 500 documents
(`import-limit`). Implementation: `packages/engine/src/wsdl/ref-policy.ts`.

What this deliberately does *not* prevent: a remote WSDL naming an internal `http://` host.
Fetching what the document points at is the whole of what "import this WSDL" means, and the
user chose that URL; the reachable surface is a GET with no credentials attached unless the
user configured Basic auth for the import.

## Git execution for shared workspaces

Sharing a workspace (`docs/collaborate.md`, [ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md))
runs the system `git`, never a bundled one, and only from the main process:

- **`execFile` with argument arrays, never a shell.** Every call goes through one `GitCli.run`,
  `cwd` pinned to the workspace's tree. There is no code path that concatenates git arguments into
  a command string.
- **A subcommand allow-list.** Only the git subcommands the sync engine actually needs
  (`GIT_SUBCOMMANDS` in `apps/desktop/src/main/sync/git-cli.ts`) can be invoked; anything else is
  refused with `git-failed` before a process is spawned.
- **No prompts, ever.** `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS` mean git can never block
  waiting for a password typed at a terminal the user cannot see. `GIT_SSH_COMMAND=ssh -o
  BatchMode=yes` is set by default so SSH cannot prompt for a passphrase or a host-key
  confirmation either — but only when the user has not already configured `GIT_SSH_COMMAND`,
  `GIT_SSH`, or a repository/global `core.sshCommand`: a custom SSH transport the user set up
  themselves is used exactly as configured, never overridden.
- **Hooks disabled.** Every invocation carries `-c core.hooksPath=<empty directory>`, so a cloned
  repository's hooks — `post-checkout`, `post-merge`, anything else a hostile remote could ship —
  never execute, on join, pull, commit or any other command the app runs. Hostile *remote
  content* therefore cannot execute code.
- **A repository's local config must pass an allow-list.** `.git/config` never arrives with a
  clone, but a folder the user joins from (or a synced folder that turns out to hold `.git`) can
  carry one, and git has many settings that name a program to run — too many for a list of refused
  keys to be trusted. Before the app runs any other git command in such a repository, and again at
  every open of a git share, it lists the local config keys (`git config --local --list
  --name-only -z`) and refuses with `git-config-refused` unless every key (case-insensitively; `*`
  is any subsection) is one of: `core.repositoryformatversion`, `core.filemode`, `core.bare`,
  `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`,
  `core.autocrlf`, `core.safecrlf`, `core.eol`, `core.quotepath`, `core.longpaths`,
  `core.checkstat`, `core.trustctime`, `user.name`, `user.email`, `remote.*.url`,
  `remote.*.fetch`, `remote.*.tagopt`, `remote.*.prune`, `branch.*.remote`, `branch.*.merge`,
  `branch.*.rebase`, `pull.rebase`, `pull.ff`, `fetch.prune`, `init.defaultbranch`, `gc.auto`.
  That covers everything `git init`/`git clone` and the app itself write. Every `remote.*.url`
  value must also pass the remote URL allow-list below; a refusal names the key, never the URL.
  Anything else — `extensions.*`, `include.*`, `includeIf.*`, `url.*`, `protocol.*`, `gpg.*`,
  `commit.gpgsign`, `remote.*.pushurl`, any other `core.*` — is refused. Global and system config
  are the user's own and are not checked. Clones the app makes itself are safe by construction.
- **A remote URL allow-list.** `assertRemoteUrl` accepts only `https://`, `ssh://`, `file://`, or
  `user@host:path`; refuses `ext::` (git's "run an arbitrary command" transport), values starting
  with `-` (parsed as a flag by git or by a transport helper's own shell), and a user or host
  component starting with `-` even once decoded out of a URL's authority. The failure never echoes
  the URL back — only its scheme — since a remote URL can carry embedded credentials.
- **A branch-name allow-list.** `assertBranchName` refuses empty names, a leading `-`, whitespace
  or control characters, `..`, `@{`, backslash, `~^:?*[`, a trailing `/` or `.lock`, a leading or
  trailing `/`, `//`, and a path component starting with `.` — applied to every branch name the
  app writes into `share.yaml` or passes to git, whether it came from the Share/Join dialogs or
  the Sync settings.
- **No URL in error messages.** `git-auth-failed`, `git-offline` and `git-remote-refused` carry a
  code and a generic message; the remote URL itself is never put in a message, since it may embed
  a token or password. A failed git command's error `details` do carry its arguments (with any
  `user:token@` stripped from an `https://` URL) and up to the last 2 KiB of git's stderr, which is
  *not* redacted and can include whatever git printed, a remote URL among it. Those details travel
  only inside the IPC error envelope to the renderer: toasts show the message alone, the sync
  status keeps only the code and message, and the app writes no log of error details.
- **`git.path` is main-only and marker-gated**, exactly like the TLS CA bundle path
  (`ssl.caBundlePath`): a path is honoured only when `git.pathPickedByMain` is `true`, set only
  when the user picked it through **Locate…** in Preferences → Git. A path hand-edited into
  `preferences.yaml` is inert — the renderer cannot make main run an arbitrary binary by writing
  to a file main will read.
- **The tree stays free of anything machine-local.** `local.yaml`, `share.yaml`, `unsaved/`,
  secret values and history never enter the shared tree; an external `share.path` that resolves
  inside `<userData>` is refused (`share-path-invalid`), so a share can never be pointed at
  another workspace's own app-data directory.

## TLS

Certificate verification is on by default, everywhere. Turning it off is per endpoint
(`trustInvalid`), never global, and the UI badges such an endpoint in red permanently, so a
debugging shortcut cannot quietly become the way a project always runs. Custom trust anchors
and client certificates are configured per endpoint too, and both are reflected in the SSL Info
inspector and in exported cURL commands (as a note, never with the credential).

PKCS#12 keystores are matched to their private key by RSA modulus only: an EC or Ed25519 key
in a `.p12` loads its certificate but is never paired with it, so the alias reports no private
key and signing with it fails — rather than silently pairing a certificate with the wrong key.
Signing and TLS client authentication with non-RSA keystores are not supported yet.

## The OAuth2 callback listens on loopback only

A REST request whose credentials are an OAuth2 configuration is signed with an access token main
obtains itself. Two parts of that are security-relevant: a port, and a token.

The authorization-code grant answers to a URL, so main opens an HTTP listener for it. It binds
`127.0.0.1` and nothing else — a listener on a routable address is a way to hand somebody else's
authorization code to this app (RFC 8252 §8.3). It takes a random free port unless the user pinned
one in Preferences, because some providers insist on an exact registered redirect URI. It accepts
exactly one callback and then closes, requires the `state` value it generated (a callback carrying
any other `state` is answered but neither accepted nor allowed to end the flow), and gives up after
five minutes. Only one sign-in may be pending at a time, and the user can cancel it. PKCE
(RFC 7636, S256) is on by default. The authorization URL is opened through the same http(s)-only
check every other outbound link goes through.

Access tokens live in main's memory, keyed by a hash of the configuration that produced them, and
are never written to disk. A refresh token is written to the keychain only when the configuration
carries a reference to put it behind — the user asking for it to be remembered — and otherwise
lasts the session. `oauth2.status` never returns the token itself unless the session's show-secrets
flag is on.

Every `oauth2.*` call names an *owner*: an API, a folder or a request. Main reads the configuration
from the project model, because a channel that accepted one would be a channel for pointing the app
at an attacker's token endpoint with the user's client secret.

Sending a request never opens a browser. An authorization-code configuration whose token has
expired and cannot be refreshed fails the send with `oauth2-sign-in-required`, and the user presses
*Get new token*.

## A response body never gets to run

The Query view evaluates an expression the user wrote against bytes a server returned, which makes
the evaluator a place worth being explicit about.

XPath 3.1 and XQuery 3.1 run under `fontoxpath`, which has no facility for calling out to the host at
all. JSONPath runs under `jsonpath-plus`, which does: its `?(...)` filters and `(...)` script
expressions can be evaluated either with the platform's real `eval`/`Function`, or with a `jsep`
expression parser that cannot reach the host. Wirebench passes `eval: 'safe'`, which selects the
parser (`packages/engine/src/xpath/jsonpath.ts`). Filters keep working — that mode is not a
restriction on what a user can express — but the classic escape through
`constructor.constructor('…')()` is refused rather than executed, whether it is reached through
`this` or through a value in the document. Two tests in
`packages/engine/test/unit/xpath/jsonpath.test.ts` try both routes.

Both evaluators also run on a **worker thread** with a five-second budget
(`xpath/evaluate-async.ts`), so an expression that never terminates costs a terminated worker rather
than a frozen window, and neither library is in the renderer bundle: evaluation is an IPC call, and
the renderer has no evaluator of its own.

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
