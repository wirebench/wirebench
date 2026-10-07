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
`Authorization`, `Proxy-Authorization`, WSS passwords, keystore passwords. The marker is
`<redacted>`; a masked XML element, such as a WSS password, holds it escaped as `&lt;redacted&gt;`
so the document stays well formed.

Request and response bodies are masked by key too. In JSON bodies (`application/json` and any
`+json` type) and urlencoded form bodies, the values of `password`, `passwd`, `secret`, `token`,
`access_token`, `refresh_token`, `id_token`, `client_secret`, `api_key`, `apikey` and
`authorization` — compared case-insensitively, at any depth — become `<redacted>` wherever
show-secrets is off (`SECRET_BODY_KEYS` in `apps/desktop/src/main/redact.ts`). A value that is an
object or array under such a key is masked whole; a body that is not valid JSON, or is compressed,
is left as it is.

An API key may be configured under any header or query-parameter name, not only the ones above. A
REST or SOAP send whose auth is an API key masks it by the name it was configured under: in the
URL, the request headers and the raw request of the summary and its failure row, and on a later
re-render. The summary carries those names (`http.keyNames`, never the value), so a row shown with
show-secrets on is masked by them again when it is exported as HAR or copied as cURL.

A server may echo a credential back: a reflected query or header in the body, a key in a redirect's
`Location`. So main also records, for the session, each credential a send's auth resolves to, in
the form it goes on the wire — an API key's value, a bearer or OAuth2 access token, and Basic's
`base64(user:password)` — and masks it by value wherever the HTTP log shows an exchange (unless
show-secrets is on) and always in History, the same way as a `${secret:name}` value. A bare password
is never recorded: people choose passwords, so one is often ordinary text (`admin` in
`/admin/users`), and masking it everywhere would rewrite unrelated History lines. NTLM never
sends the password itself, so it has nothing to echo. The 4-character floor below
applies here too.

The same recorded values are masked in a REST response body (the decoded text the pane renders and copies, the body and the raw body bytes; show-secrets reveals them) before it reaches the renderer, and in a REST request copied as cURL from the editor, URL,
headers and body alike, unless show-secrets is on. Only the recorded values' own bytes are replaced, so
a binary body keeps every other byte.

Copying an HTTP Log row as cURL builds the command in main from the row the renderer holds. For a
finished exchange it follows the show-secrets toggle; for a failure row it is always masked, since
that row was redacted when it was recorded and has no unredacted copy. Resending a row never sends
the row's own (redacted) headers or body: it replays the saved request behind it, as it is now.

Exporting the HTTP Log as HAR is redacted in main with show-secrets ignored: a HAR file is made to
be shared, so sensitive headers (including `Set-Cookie`), secret URL parameters (in the request URL
and in `Location`, `Content-Location` and `Referer`), WS-Security passwords and JSON/form secret
keys are always `<redacted>`. The renderer only sends the rows; the path comes from the native save
dialog in main, and the file is written atomically. A failure row carries an `_error`; a truncated
body carries `_truncated` and no text. A body that is neither textual nor JSON/form (binary
responses, gRPC messages) is written as base64 without redaction, as the log shows it.

Where no keyring is available (some headless Linux setups), the store degrades to base64
plaintext, marks that entry `encrypted: false`, and logs one warning rather than refusing to
run. That is a real weakening on such systems, and it is stated in the file rather than
hidden. Full reasoning: [ADR-0004](adr/0004-secrets-outside-project-files.md).

## The CLI runner has no keychain, only environment variables

`wirebench run` and `wirebench secrets list` (`@wirebench/cli`) never open `userData/secrets.json`
and never touch the OS keychain — a pipeline has no per-user keychain to read. A ref resolves only
from `WIREBENCH_SECRET_<NAME>` (when the file declares a friendlier name beside the ref, e.g.
`passwordEnv: BILLING_PASSWORD`) or `WIREBENCH_SECRET_<REF>` (the ref itself); neither set is a
`secret-missing` error, never a silent empty credential. Every value resolved this way is
registered with the redactor and masked wherever it could reach an output — headers, URL, bodies,
an assertion's reported "actual" text — in every reporter (`cli`, `junit`, `json`, `html`) alike; a
report file is written already masked, the same as anything printed to the terminal.

That literal masking has a floor: a resolved value shorter than 4 characters is not replaced,
because a string that short is too likely to occur by chance elsewhere in ordinary output and
masking it would shred unrelated text rather than protect anything. This does not weaken the
pattern-based redaction next to it — `Authorization`/`Proxy-Authorization` headers, `wsse:Password`
elements and the JSON/form secret-key list (`SECRET_BODY_KEYS`) are always redacted by pattern
regardless of the value's length. Choose secret values of ordinary length (not four-character test
placeholders) to get the literal-masking guarantee as well.

## Values read from the process environment are masked too

A request can read any process environment variable through `${#System#NAME}`, and nothing marks
such a value as a secret. So whenever Wirebench expands one, the value is recorded and masked by
value like a resolved secret: in `wirebench run`'s reports (`cli`, `junit`, `json`, `html`), in
`send` results (over MCP too), in History, and in the desktop's HTTP log, History and WebSocket
frames, in the places a recorded secret is masked. A value is recorded when anything expands it,
not only a send: a request's script properties are expanded before its script runs, and in the
desktop the preflight, the Code panel's command, the body-schema lookup and a resend's comparison
expand the request too, each recording for the session. So a value can be masked although no send
used it. The rest of the environment, which nothing expands, is never recorded. Only a value of at
least 8 characters is recorded — the same floor as the MCP server's seeded secrets — since a short
value such as `1` or `true` would mask ordinary text everywhere. A shorter value is sent and shown
as it is, so keep credentials in `${secret:…}` tokens rather than `${#System#…}` references.

## The MCP server is gated, redacted and local

`wirebench mcp` (issue #32) lets a coding agent drive one project. What the agent can do is what the
person who started the server allowed. The CLI verbs (`wirebench send`, `import` and the rest) are
not gated: the person typing the command has allowed it. The gates belong to the server.

- **Gates.** `send` and the contract tools (one per imported operation) make requests only with
  `--allow-send`, and only under the environments `--env` lists when it is given; under `--env`, a
  call that resolves no environment is refused. `import`
  writes the project only with `--allow-write`. A gated tool is still listed and answers
  `send-not-allowed` or `write-not-allowed`, naming the flag.
- **Redaction, by pattern.** Every tool result and every error passes one step before it leaves: the
  engine's header, URL, XML and structured-body redactors, then every secret value the call resolved,
  masked with the same masker as `wirebench run`. The patterns mask the `Authorization`,
  `Proxy-Authorization`, `Cookie`, `Set-Cookie` and `X-API-Key` headers; a URL's password and the value of
  a query parameter from a fixed list (`api_key`, `token`, `key`, `signature` and the like; the user name
  stays); the text of a WS-Security `Password` element; and the values under secret-looking JSON or form
  keys from the engine's fixed list (`password`, `secret`, `token`, `api_key`, `authorization` and the
  like). A value under any other name, such as `<ApiToken>`, stays readable unless it is a secret the
  call resolved. `validate`, `query` and `history_diff` apply the pattern redaction to the message before
  they read it, so those values are never in what they return; that is all it promises, not that a
  query cannot learn a secret the patterns do not cover. Column numbers in a validation problem count
  on the redacted text. Those three read a message as XML when its text starts with `<` and as JSON
  otherwise; `send` goes by the response's declared `Content-Type`, so its key-based masking covers XML,
  and JSON or form bodies only when the response declares that type. Any other body is masked only for
  the secret values resolved for the send. `send`'s assertion results are redacted by pattern as well:
  URLs in them are redacted, and the value a header or `match` assertion read shows as `<redacted>` when
  the header is one of those above or the JSONPath/XPath ends in one of the secret keys, callback
  assertion reasons included; a node or object a `match` read is passed through the XML or JSON
  redaction, and one cut short that still holds a secret key or an unclosed `Password` shows as
  `<redacted>` whole. No tool accepts a secret value as input; secrets come from
  `WIREBENCH_SECRET_<NAME>` variables in the server's environment, and only the ones the saved request
  uses are read. As defence in depth, every `WIREBENCH_SECRET_*` value of at least 8 characters the
  server was started with, and `WIREBENCH_MCP_TOKEN` (at least 16), are masked in every tool's result
  whether or not the call resolved them; a shorter secret is masked where a call resolves it, under the
  masker's own floor, since seeding a value like `true` would mask ordinary text everywhere. History is stored as the desktop stores it and is not an agent-facing surface: the tools read
  it through the redaction, and the `file` source refuses any file in the History folder in use. A
  send from the server never trims History below what the file holds, so it cannot delete entries the
  user kept under a larger cap than the default; the desktop's own cap applies on its next write.
- **The `send` body override is sent as written.** A `${…}` placeholder in it is refused, because it
  would expand against the server's own environment (`${#System#NAME}` reads the process
  environment). The saved request's own body still expands placeholders as usual, and the override
  reaches no secret the saved request does not already use.
- **Contract tools (#33).** Every imported operation is also a tool, gated by `--allow-send` like
  `send`. Its description carries the contract's own documentation (the WSDL's or the OpenAPI
  document's text, cut at 1,000 characters): text the user imported, shown to the agent as data, as
  `operations` already shows it. Its arguments are checked against the tool's JSON Schema, a string
  holding `${` is refused (it would expand against the server's environment), and a SOAP body is
  checked against the XSD before anything is sent; nothing in the arguments is ever expanded. An `xs:any`
  argument is an XML fragment inserted as written once a strict parser reads it whole. The request takes
  its endpoint, auth and secrets from the project, never from the arguments, and its result passes the
  same redaction as `send`'s, with every number or boolean that holds a resolved secret masked too.
  `--tools` limits which interfaces and APIs are served; at most 128 contract tools are served at once.
- **Local HTTP only.** `--http` binds `127.0.0.1` and nothing else. Every request needs
  `Authorization: Bearer <token>` (`WIREBENCH_MCP_TOKEN`, or 32 random bytes made at start and
  printed once to stderr), compared in constant time; a missing or wrong token gets 401. The variable
  is trimmed, an empty value counts as unset, and a token you set must be at least 16 characters with
  no spaces, or the server refuses to start (exit 2). A request whose `Origin` is not
  `http://localhost:<port>` or `http://127.0.0.1:<port>` is refused with 403 before the token is looked
  at, and so is one whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`; together they
  stop a web page from reaching the server through DNS rebinding. Any path other than
  `/mcp` gets 404, and `--http 80` is refused because clients drop the default port from `Host` and
  `Origin`. A request body is capped at 16 MiB; at most 128 connections are open at once, and one that
  has not finished its headers is dropped after about 10 seconds. One process holds at most 64 live
  sessions. Only a request the server has accepted as a real `initialize` makes room past that: it
  closes the session idle longest, preferring one with no GET stream open, and that client gets 404 on
  its next request and must initialize again; a malformed or non-initialize request closes nothing.
  Every client shares the one token, so any holder of it can close other clients' sessions by opening
  new ones. There is no idle timeout below the cap: stop the process to drop them.
- **On stdio, stdout is frames only.** `console.log`, `info` and `debug` are pointed at stderr while
  the server runs, and so is the stdout of the engine's worker threads (the XPath and JSONPath
  evaluator, the REST contract check, the script checker and sandbox, the WebSocket frame check): a
  stray line from any of them lands on stderr, not in the protocol stream.
- **No model runs in Wirebench.** The server answers tool calls; the agent, its model and its prompts
  live outside the app. Nothing is sent anywhere except the requests the user or the agent asks
  `send` to make.
- **Files and URLs are reached with the server's rights.** With `--allow-write`, `import` reads any
  local path the process can read, or fetches any http(s) URL the machine's network reaches; the
  desktop's import is limited to project roots and files the user picked, the server's is not.
  `validate` and `query` read any regular file of 16 MiB or less the process can read (any file in the
  History folder in use excepted). The path is checked before anything is opened, so a device or a
  named pipe is refused without being opened. A relative path resolves against the working directory, which an MCP client chooses, so
  give absolute paths. Start the server as a user, and in a project, you mean the agent to work on.
- **Bounded results.** `query` returns at most 64 Ki characters per result and 256 Ki in total, and
  `history_diff` at most 256 Ki characters of changes, and `send` cuts a response body at 256 Ki
  characters (`bodyTruncated`), so a large response cannot flood the agent's context; both
  set `truncated`.

## Paths from the renderer are proven, not trusted

Main never opens a path just because the renderer named one. A path is usable only if it is
**contained** — inside the project folder or its caches, with `realpath` resolved through the
existing prefix so a planted symlink cannot escape the check — or **dialog-proven**: the user
drove a native OS dialog to that exact path this session, and main remembers it. Both halves
meet in one predicate, so every file-touching feature asks the same question.

Names the user types become path segments only through `slugify`, which cannot produce a
traversal segment, strips characters illegal on any supported OS, and refuses Windows device
names. Full reasoning: [ADR-0005](adr/0005-renderer-path-safety.md).

A project file is input too: it can arrive by a pull, a shared folder or an import. So a file name a
request file records — a REST request's body file, a gRPC request's message file, a WebSocket
request's message files — must be a single segment beside the request (`assertPathSegment`), and a
name that is not, such as `../../secret.txt`, refuses the project (`project-path-invalid`) rather than
loading a file from elsewhere into a request that would send it. Script files are never named by
the file at all; their names come from the request's slug. Tests:
`packages/engine/test/unit/project/{rest-format,grpc-format}.test.ts`.

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
(`import-limit`). Implementation: `packages/engine/src/http/ref-policy.ts`.

A legacy SOAP project import (`project.importLegacy`) adds three rules of its own, because the project
file is untrusted input that names further locations. Its definitions are served from the copy the file
itself carries. A document the file lacks may be fetched over `http(s)`, but never from a `file:` location,
since that path comes from the imported file and not from the user. The file is parsed with DTDs refused
outright, so there is no entity expansion. And nothing in it runs: its passwords are never written to the
project (the report asks for them to be re-entered in the keychain), and its scripts are saved as inert text
under `imported-scripts/`, which nothing in Wirebench reads. Each script file is created exclusively, so
a file or link already at its name, even one that appeared a moment before, is never replaced or followed;
the script takes the next `-2`, `-3` name instead. Implementation:
`packages/engine/src/soap/legacy-project/` and `ProjectHost.importLegacyProject`.

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

An assertion's `matches:` regular expression runs on that same worker, under the same budget
(`matchRegexWithTimeout`). The pattern comes from a file that may have come from someone else, and a
backtracking pattern such as `(a+)+$` against a long near-miss runs for minutes. JavaScript cannot interrupt a
running `RegExp`, so a thread that can be terminated is the only bound. A timeout or an invalid pattern is an
`errored` assertion (`packages/engine/test/unit/assert/match-regex.test.ts`).

## An HTML preview is a frame with nothing granted

Preview renders an HTML response or webhook capture inside `<iframe sandbox="" srcdoc>`. The empty
`sandbox` attribute sets every flag and grants no exception (no `allow-*` token, pinned by a test), so
the document gets an opaque origin, no script, no forms, no popups and no navigation of its parent.
The document also leads with its own policy, declared before anything the server sent:

```
default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'
```

That is `HTML_PREVIEW_CSP` (`apps/desktop/src/shared/html-preview-csp.ts`). Inline styles and `data:`
images render; fonts fall back to the system fonts, because the frame also inherits the app CSP
(`font-src 'self'`) and both policies are enforced. Every other fetch is refused, and the referrer is
`no-referrer`. In the main process a `will-frame-navigate` handler (`denySubframeNavigation`) denies
every subframe navigation except the preview's own `about:srcdoc` load, so a meta refresh or a link click that slipped past the sandbox still goes nowhere. A body over
`rest.prettyPrintMaxBytes` is not framed at all.

The residual risk is a Chromium sandbox escape, which keeping Electron current mitigates. Spec §4
(`docs/specs/2026-10-03-wirebench-html-response-preview-design.md`) has the full threat table.

## A response value is data, never a template

A [sequence](specs/2026-09-28-sequences-design.md) lifts values out of one response (a token, an id,
a cookie) and puts them into the next request as `${#Sequence#name}`. That value is text a server
chose. Property expansion was built for values the user typed, so a response value is held to
stricter rules, recorded as [ADR-0015](adr/0015-response-values-are-data.md). Each rule closes a
specific way for a server to reach further than its own response:

- **Never expanded again.** Expansion is recursive, so a server answering `${secret:prod-db}` would
  otherwise have the next request resolve and send that keychain value. A Sequence value is
  substituted literally (`project/properties.ts`), so `${…}` inside one stays as text. A reference
  whose *name* is built from one (`${${#Sequence#n}}`, `${secret:${#Sequence#n}}`) is refused as
  `name-from-response`. Tests: `packages/engine/test/unit/project/sequence-scope.test.ts`.
- **Explicit only.** The `${name}` shorthand never reads the Sequence scope, so a response can't shadow
  `${baseUrl}` or any value a request already uses.
- **Escaped where it lands, exactly once.** In a JSON, XML or HTML body, a SOAP envelope and a gRPC
  message, a Sequence value is escaped (all five XML entities, quotes included), whether or not the
  request escapes its own values. Otherwise a value such as `x", "admin": true, "y": "` could add
  fields to the next request (`expandWithSequenceEscaped`, `project/sequence-guards.ts`).
- **Never the destination.** A step whose scheme, host or port would depend on a Sequence value is
  refused before it is sent (`sequence-origin-from-response`). The request's auth goes wherever the
  URL points, so this is what keeps a response from redirecting the next step's credentials. A gRPC
  target may not hold one at all.
- **No header splitting.** A Sequence value with CR, LF or NUL is refused in a URL, a header, gRPC
  metadata, a SOAP action or a WS-Addressing field (`sequence-value-invalid`). Tests for these three
  rules: `packages/engine/test/unit/project/sequence-guards.test.ts`.
- **Bounded.** A value over 64 KiB errors its step. A sequence file over 256 KiB, over 100 steps, or over
  50 transfers or assertions in a step is refused before it is used.
- **Masked from the moment it exists.** A transfer marked secret, or one holding a credential already
  recorded, is recorded for masking as soon as it is extracted. In the desktop that happens inside
  an observer the engine service *awaits* before it builds the step's own summary, so even the
  step that produced the secret has it masked in its HTTP Log raw response and its History entry. A
  secret transfer never carries its value to the renderer or into a report. Tests:
  `apps/desktop/test/sequence-runner.test.ts`, `packages/cli/test/integration/sequence.test.ts`.

A sequence file may come from a teammate, so it is untrusted input too. It is parsed with the
project's YAML parser after a size check, validated field by field, and names requests only by id,
never by path. Transfers and assertions evaluate only through the worker-bound, host-isolated
evaluators above. A file this build cannot read is never deleted or overwritten by a save.

What this does not change: running a sequence someone else wrote sends requests to the hosts its
requests name, with your credentials. That is the trust any shared *request* already asks for. A
shared request can already put `${secret:x}` into a URL of its choosing. The rules above make
sure a *server* gains nothing more.

## A script runs with no capabilities

A SOAP, REST or gRPC request can carry a pre-request and a post-response script (#63): TypeScript
files beside the request file, or JavaScript for one imported from Postman. A script is code from the
project, so it may come from a teammate, a pull or an import. The decision is
[ADR-0016](adr/0016-scripts-run-with-no-capabilities.md), which holds together with ADR-0015:

- **Nothing to call.** A script runs in QuickJS compiled to WebAssembly, on a worker thread, in a fresh
  runtime for every run. The only API it gets is a set of functions of strings — hashing, HMAC,
  encodings, XPath over the response, a log — installed by the engine. No host object, function or
  prototype is reachable, and there is no network, file system, keychain, timer or module loader. The
  sandbox and the TypeScript checker run in main (the app) or the CLI process; the renderer gains no
  `unsafe-eval`, no `wasm-unsafe-eval` and no language worker. Tests:
  `packages/engine/test/unit/script/{sandbox,execute}.test.ts`.
- **Bounded.** Time (1 s by default, at most 10 s, with the worker terminated and replaced as a
  backstop), 64 MiB of memory, a 1 MiB stack, and caps on log lines and bytes, tests and values. A
  script file over 256 KiB is refused.
- **The destination is fixed first.** A pre-request script runs after property expansion and before
  auth, WS-Addressing, WS-Security and signing. A change to the scheme, host or port fails the send
  (`script-origin-change`), and a CR, LF or NUL in a URL, header, metadata or SOAP action fails it
  (`script-value-invalid`). Configured credentials are applied after the script, bound to that origin,
  and a script never sees them. Tests: `packages/engine/test/unit/script/apply.test.ts`.
- **Secrets by listing only.** `secrets.get` returns a value only for a name the request file lists under
  `scripts.secrets`, and each value it returns is recorded for masking before the script runs. A
  `${secret:…}` in the request's own text reaches the script as a placeholder (`wbsec`, a nonce new for
  every send, an index, `z`) and is put back after it; every expander substitutes secrets raw, so the
  value lands exactly where it would have. A `${secret:…}` the script writes itself is never resolved
  (`script-secret-denied`), so neither a script nor a server value passed through one can name a secret
  to be read. Tests: `packages/engine/test/integration/run/scripts.test.ts`,
  `apps/desktop/test/script-send.test.ts`.
- **What a script produces is data.** A value it sets with `vars.set` is held to every rule of
  ADR-0015 above, and one marked secret (or holding a known secret) is masked from the moment it is
  set. In the desktop, the post-response script runs inside the same awaited observer as a sequence's
  transfers, so the summary, the HTTP Log row and the History entry of the very send that produced a
  secret already mask it.
- **Checked before it runs.** A script is type-checked against its request's types before the send;
  an error stops the send, and a run in CI exits 2 before anything is sent.
- **Imported scripts start switched off.** A Postman collection's scripts are imported with
  `enabled: false`; switching them on is a change to the request file, visible in review.

What this does not change: a script someone else wrote runs when you send its request, as a shared
request already sends what it says to where it says. The rules above make sure the script gains
nothing a declarative request could not already do, beyond CPU and memory within its limits.

## The cookie jar

Responses' cookies are kept in a jar per workspace (#44,
`docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md`):

- **At rest.** Cookies with an expiry are written to `cookies/<workspace id>.json` in the app's data
  folder, encrypted with the OS keychain (`safeStorage`); without it nothing is written. Session cookies
  never reach disk. The jar never reaches the project folder, a shared workspace's git tree or the server.
  A file from a newer version is left untouched and the jar runs in memory; a corrupt file is set aside
  as `.corrupt`. Tests: `apps/desktop/test/cookie-store.test.ts`.
- **Opt-in sending.** Jar cookies go out only from REST requests with *Send cookies* on (off by
  default), only to a matching domain and path, and `Secure` cookies only over https. An http response
  cannot set or overwrite a `Secure` cookie. Tests: `packages/engine/test/unit/rest/cookie-jar.test.ts`.
- **Per hop.** The jar is matched again for every redirect hop, and a cross-origin hop already drops a
  hand-set `Cookie`, so a redirect to another host gets only that host's cookies. Tests:
  `packages/engine/test/integration/rest/redirects.test.ts` (a cross-origin hop) and
  `packages/engine/test/integration/run/rest-exchange.test.ts`.
- **Domain rules.** A response's `Domain` must domain-match the request host; a `Domain` that is an IP
  address or a single label is refused unless it equals the host.
- **Bounded.** 4 KB per cookie, 50 per domain, 3,000 in all; past that, the cookie expiring soonest goes first, session cookies last.
- **Masking.** `Cookie` and `Set-Cookie` stay redacted in History and logs; the cookie manager masks
  values until asked.
- **Residual risk: no public-suffix list.** A server under `a.example.co.uk` can set `Domain=co.uk`, and
  that cookie then reaches every `*.co.uk` host a request with *Send cookies* on is sent to. Accepted:
  the jar holds your own test traffic, sending is opt-in per request, and a public-suffix list is a
  large, moving dependency.
- **Headless.** `wirebench run`, `call` and `mcp` keep their jar in memory only.

## Current values are kept in memory only

A variable's current value (#44) is a session-only override of its committed value:

- **The store is memory only.** The current-value store lives in the main process. It is never written
  to the project, the workspace, the keychain or the server, is never shared, and is gone on quit. Tests:
  `apps/desktop/test/current-values.test.ts`.
- **A send records what was sent.** A request that uses a current value expands it like a committed
  value, so History, the HTTP Log and HAR export record the expanded value just as they would a
  committed one. Keep credentials in `${secret:…}` references, which those records redact, not in a current value.
- **User input, not response data.** A current value is typed by the user and expands like a
  committed value; ADR-0015's boundary (a response value is data, never a template) is unchanged.
- **Masked like the value.** A secret's Current cell is masked while secrets are hidden.

## Catch URLs take anyone's request

A catch URL (webhook capture) is the one Wirebench Server route that needs no account, so its secret
is the whole credential.

- **The secret.** It is 128 bits from `crypto.randomBytes`. Only the workspace's members see it, inside
  the full URL. `/meta` never carries it, request logs show `/hooks/[redacted]`, and an editor can
  rotate it at once.
- **Nothing to probe.** An unknown secret and a disabled one both get the same bare `404`.
- **Bounded writes.** A token bucket per catch URL, a per-workspace cap, a stored-body limit, and
  retention by count and by age bound what a stranger holding a URL can make the server store.
- **No held connection.** A configured response delay never holds a database connection.
- **Untrusted content.** A capture is shown only through the viewers that already show untrusted
  response bodies, so nothing in it is rendered as HTML or run. The app keeps captures in memory
  while their tab is open (`apps/desktop/src/main/hooks/hooks-service.ts`) and never writes them to
  disk.

### CI tokens

`wirebench run` reads a workspace's captures with a **CI token**, created by an editor or admin in
Preferences → Devices & tokens. It is a `wbs_…` token with a narrower reach than a device token:

- It is read-only and scoped to one workspace. It never expires and can be revoked; a revoked token is
  refused on its next request.
- The server accepts it only on `ci/whoami` and on reading that workspace's hooks list and captures.
  Every other existing route, including every write and every other workspace, answers 403.
- The hooks list omits each catch URL (the secret address). A capture can still quote its own URL if
  the sender or a proxy puts it in a header or the body, so treat a leaked CI token as able to read
  everything sent to the workspace's catch URLs, and revoke it.
- Use an `https://` address outside a local network: over `http://` the token crosses the network in
  clear.
- Live sockets refuse it.
- The server stores only a hash, and shows the token once, when it is created.
- The token list shows each token's name, who created it and when it was last used, so an unused or
  unexpected one stands out.
- Callback `equals` and `matches` values are expanded like other assertion values, `${#System#…}`
  included, and can appear in a failure message; a `${#System#…}` value of at least 8 characters is
  masked there, a shorter one is not. Keep credentials out of them.

### Signature secrets

A catch URL can check the signature of what it receives, and a webhook item can sign what it sends.

- **On the server.** The catch URL's secret is encrypted at rest with AES-256-GCM under
  `WIREBENCH_SERVER_HOOKS_SECRET_KEY` (32 random bytes, base64) and is never logged. Without the key
  the server refuses to store one. The secret is write-only over the API: it is never returned, only
  a hint (its last four characters, for secrets of eight or more) shown to editors and admins.
- **On the desktop.** A signing secret lives in the OS keychain behind a reference and never in the
  project file or the repository; the file holds only the reference and a CI name.
- **In CI.** The CLI reads `WIREBENCH_SECRET_<name>` and masks the value like any other secret.

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
