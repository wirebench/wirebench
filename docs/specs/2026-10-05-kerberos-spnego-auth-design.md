# Kerberos/SPNEGO authentication — design

**Issue:** #40 · **Date:** 2026-10-05 · **Status:** approved 2026-10-05; amended with the plan (see _Amendments_)

Builds on: [ADR-0019](../adr/0019-kerberos-uses-an-optional-native-module.md) (the native-module ruling),
ADR-0004 (secrets outside project files), the SOAP owner auth design
(`docs/specs/2026-09-22-soap-owner-auth-design.md`), the definition fetch auth design
(`docs/specs/2026-09-26-definition-fetch-auth-design.md`), and `docs/roadmap.md` item 7. WS-Trust (#41) uses
the token seam in D1.

## Objective

A request authenticates with the Kerberos ticket the user already holds: their Windows logon, or `kinit` on
macOS and Linux. The server answers `WWW-Authenticate: Negotiate`, and Wirebench answers with a Kerberos
token, so the user types no password. This works for every owner and every path that sends HTTP:

- SOAP and REST sends;
- WSDL, OpenAPI and AsyncAPI fetches;
- the CLI runner and the MCP server;
- WebSocket upgrades;
- gRPC calls.

On Windows the user can instead name another account with a username, a domain and a password reference.

## Decisions (owner rulings, 2026-10-05)

| # | Question | Ruling |
| --- | --- | --- |
| R1 | How is the token obtained? | The `kerberos` npm package as an optional native dependency, vendored per architecture in the desktop build (ADR-0019). |
| R2 | Whose credentials? | The logged-in ticket by default. Windows may also use an explicit `username` + `domain` + `passwordRef`; on macOS and Linux a send with explicit credentials is refused, never silently ignored. |
| R3 | Which surfaces? | SOAP and REST sends, the CLI runner and MCP, definition fetches (WSDL, OpenAPI, AsyncAPI), WebSocket and gRPC. |
| R4 | NTLM fallback? | None. The Kerberos mechanism only; a failure is reported, not papered over by NTLM. |

## Non-goals

- NTLM inside Negotiate, on any platform (R4).
- Credential delegation (`GSS_C_DELEG_FLAG`). The flag is off, and a server that needs a forwarded ticket
  fails visibly. This can be added as an option once someone asks.
- Running `kinit`, managing the ticket cache, or prompting for a password to get a ticket. A missing ticket is
  an error that says what to run.
- Canonicalising the host through DNS (`CNAME` lookups) to build the SPN, as browsers do. The SPN override
  covers that case without a DNS dependency.
- Kerberos for the Wirebench Server's own sign-in (OIDC is the server's answer).
- The WS-Trust request itself (#41). This spec only provides the token seam it calls (D1).
- Proxy authentication with Negotiate. Authenticated proxies keep Basic and NTLM.

## Facts this design rests on

Checked against `kerberos@7.0.0`, the version to pin:

- The package is Apache-2.0 and N-API v9. Its prebuilds cover `darwin-x64`, `darwin-arm64`, `linux-x64`,
  `linux-arm64` and `win32-x64`. There is **no `win32-arm64` prebuild**.
- `initializeClient(service, options, callback)` creates the client. The binary reads the options `mechOID`, `flags`, `principal` (Unix), `user`, `domain` and `password` (Windows); the package's `index.d.ts` calls two of them `gssFlag` and `pass`, which the C++ ignores.
  `client.step(challengeBase64)` returns the next token; `contextComplete` reports when the handshake is
  done.
- `mechOID: GSS_MECH_OID_KRB5` (9) maps to the SSPI package `L"Kerberos"` on Windows
  (`src/win32/kerberos_win32.cc:149–152`). `GSS_MECH_OID_SPNEGO` would map to `L"Negotiate"`, which may pick
  NTLM. R4 therefore means always passing `GSS_MECH_OID_KRB5`.
- With that mechanism, the first `step('')` returns the GSS-API initial context token for Kerberos v5: the
  RFC 1964/4121 framing around an AP-REQ. This is the token an HTTP `Negotiate` header carries for a
  Kerberos-only client. It is also what WS-Security's `#GSS_Kerberosv5_AP_REQ` value type names.
- `user` and `pass` are honoured on Windows only. `principal` (`user@REALM`) picks a ticket from the cache on
  GSSAPI.
- The service name is passed to the OS unchanged. SSPI wants `HTTP/host`, and GSSAPI's host-based form is
  `HTTP@host`.
- `lib/util.js` loads `../build/Release/kerberos.node` relative to the package, so the package's JavaScript
  cannot be pointed at a vendored binary. The engine loads the `.node` binding itself (D1).
- The release jobs build macOS universal/x64/arm64, Windows x64/arm64 and Linux x64/arm64, each from one
  `pnpm install`, with `npmRebuild: false` (`apps/desktop/electron-builder.yml:49`,
  `.github/workflows/release.yml`). An installed binary only matches the runner it was installed on.

## Current state

| Concern | Where | Today |
| --- | --- | --- |
| Transport auth | `packages/engine/src/http/auth/apply.ts` `sendWithAuth` | Basic (preemptive or challenged) and the three-leg NTLM handshake over one connection (`ntlm-transport.ts`) |
| Header/query auth | `http/auth/apply-auth.ts` `applyAuth` | Bearer, API key and OAuth2 |
| Send credentials | `http/auth/send-auth.ts` `SendAuth`, `AuthSummary` | `basic`, `ntlm`, `bearer`, `api-key`, `oauth2`; `attempts: 1 \| 2 \| 3` |
| Format | `packages/engine/src/project/schema-parts.ts` — `endpointAuthSchema` (l.40), `authConfigSchema` (l.130), `soapOwnerAuthSchema` (l.146), `definitionAuthSchema` (l.153) | No Kerberos arm. `FORMAT_VERSION = 7` (`project/model.ts:42`) |
| SOAP/REST send | `soap/send.ts`, `rest/send.ts` | Call `sendWithAuth` |
| WebSocket | `ws/call.ts:86–103` | Refuses NTLM (`ws-auth-unsupported`); preemptive Basic; otherwise `applyAuth` |
| gRPC | `grpc/send.ts:148`, `grpc/command.ts:59` | Basic as metadata; token schemes as metadata |
| Definition fetch | `http/document-fetch.ts` (OpenAPI, AsyncAPI); `soap/import.ts:44` `withBasicAuth` (WSDL) | Same-origin preemptive credentials per hop; WSDL Basic only |
| Secret resolution | `secrets/resolve.ts` (`resolveEndpointAuth`, `resolveAuthConfig`) | `passwordRef` and `passwordEnv` for Basic/NTLM |
| Packaging | `apps/desktop/electron-builder.yml` (`asarUnpack`, `npmRebuild: false`), `docs/release.md:75` | "Wirebench has no native modules" |

## Design

### D1. The native binding and the token seam

Two files. `http/auth/kerberos-native.ts` is the only file that touches the native code.
`http/auth/kerberos-token.ts` is the seam every caller uses.

```ts
// kerberos-native.ts
export type KerberosAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** What the engine needs from the OS: one client per security context. */
export interface KerberosProvider {
  availability(): KerberosAvailability;
  initClient(input: {
    readonly spn: string;            // already in the platform's form
    readonly principal?: string;     // GSSAPI only
    readonly user?: string;          // Windows only
    readonly password?: string;      // Windows only
  }): Promise<KerberosClientLike>;
}
export interface KerberosClientLike {
  step(challengeBase64: string): Promise<string>;
  readonly contextComplete: boolean;
}

/** Loads the binding at `bindingPath`, or the installed package's binding when omitted. */
export function loadKerberosProvider(options?: { bindingPath?: string }): KerberosProvider;
```

```ts
// kerberos-token.ts — the seam. HTTP Negotiate (D3–D4) and WS-Trust (#41) are both callers.
export interface KerberosCredentials {
  readonly principal?: string;   // GSSAPI only
  readonly username?: string;    // Windows only
  readonly domain?: string;      // Windows only
  readonly password?: string;    // Windows only, already resolved by the host
}

/** A started security context: the initial token, and a way to verify the acceptor's reply. */
export interface KerberosContext {
  /** The GSS-API initial context token for Kerberos v5 (framed AP-REQ), raw bytes. */
  readonly token: Uint8Array;
  /** The SPN actually used, in the platform's form; for summaries and errors. */
  readonly spn: string;
  /** Feeds the acceptor's reply token (mutual auth). Throws `kerberos-mutual-auth-failed` if it does not verify. */
  verify(replyToken: Uint8Array): Promise<void>;
}

export function startKerberosContext(
  spn: string,                     // any accepted form: `HTTP/host`, `HTTP@host`, `host/sts.corp`, bare `host`
  credentials: KerberosCredentials,
  options?: { readonly provider?: KerberosProvider; readonly platform?: NodeJS.Platform },
): Promise<KerberosContext>;

/** Convenience for one-shot callers that never see a reply token (WS-Security, preemptive gRPC). */
export function kerberosToken(spn: string, credentials: KerberosCredentials, options?: …): Promise<Uint8Array>;
```

How `startKerberosContext` works:

- It first applies the rules every caller shares, so no caller repeats them:
  - **availability.** An unavailable provider throws `kerberos-unavailable`.
  - **The Windows-only check (R2).** If `username` or `password` is present and the platform is not `win32`,
    it throws `kerberos-explicit-credentials-unsupported`.
  - **SPN normalisation.** Either separator is accepted, and a bare host gets the `HTTP` service.
  - **The mechanism and flags (R4).** Always `GSS_MECH_OID_KRB5` and `GSS_C_MUTUAL_FLAG`.
  - **OS error mapping** to the codes in D3.
- It then calls `initClient` and `step('')`.
- `kerberosToken` is `startKerberosContext(…).then((c) => c.token)`.
- #41 places that token, base64, in a `wsse:BinarySecurityToken` with
  `ValueType="…#GSS_Kerberosv5_AP_REQ"`. It uses the same credential source (D5 resolves it), and gets the
  same refusal when the module is missing.

How the binding is loaded and injected:

- **Loading.** The loader requires the `.node` file directly, through `createRequire(import.meta.url)`, and
  promisifies `initializeClient` and `step` itself.
  - The desktop app passes
    `path.join(process.resourcesPath, 'kerberos', `${process.platform}-${process.arch}`, 'kerberos.node')`.
  - The CLI and development runs pass nothing; the loader resolves
    `require.resolve('kerberos/package.json')` and loads `build/Release/kerberos.node` next to it.
  - The constants used (`GSS_MECH_OID_KRB5 = 9`, `GSS_C_MUTUAL_FLAG = 2`) are copied, with a comment naming
    the pinned version.
- **Laziness.** Nothing loads at import time. The first `availability()` or `initClient()` loads the binding,
  and the result, a provider or the failure reason, is memoised for the life of the process. Load failures
  become reasons:
  - "the Kerberos component is not installed" (`MODULE_NOT_FOUND`);
  - "not available on Windows on ARM";
  - for a missing `libgssapi_krb5`, the OS loader's message plus "install the Kerberos libraries (krb5)".
- **Injection.** Every caller takes an optional `kerberos?: KerberosProvider` and passes it to
  `startKerberosContext`. That option is how the desktop app injects its vendored provider (D5), and how unit
  tests inject a fake. The default is a module-level `loadKerberosProvider()`. The callers are
  `sendWithAuth`, `document-fetch`, `ws/call`, `grpc/send`, and #41's STS client.
- **Exports.** `startKerberosContext`, `kerberosToken`, `KerberosProvider`, `KerberosCredentials` and
  `loadKerberosProvider` are exported from the engine's index, so main and #41 import them by name.
- **Renderer.** The renderer never imports these files, nor any value from a module that does. Availability
  reaches it over IPC (D6), which keeps the renderer's import graph clear of the engine's value exports (see
  the wire-types CSP trap).

### D2. Model and format

New arm, in `schema-parts.ts`:

```ts
export const kerberosAuthSchema = z
  .looseObject({
    type: z.literal('kerberos'),
    /** Service principal; default `HTTP` + the request URL's host. Written `HTTP/host` or `HTTP@host`; normalised per platform. */
    spn: z.string().optional(),
    /** GSSAPI: pick this principal's ticket from the cache (`user@REALM`). */
    principal: z.string().optional(),
    /** Windows only: authenticate as this account instead of the logged-in one. */
    username: z.string().optional(),
    domain: z.string().optional(),
    passwordRef: z.string().optional(),
    passwordEnv: envName,
  })
  .refine((value) => !('password' in value), { message: '…use passwordRef', path: ['password'] });
```

- The arm joins `authConfigSchema`, `soapOwnerAuthSchema` and `definitionAuthSchema`, the last of which
  covers OpenAPI and AsyncAPI sources. The gRPC and WebSocket owners, and the WSDL import options, take the
  arm wherever they use one of those unions.
- `FORMAT_VERSION` goes **7 → 8**. An older Wirebench then refuses a project that holds a Kerberos arm as
  "too new", rather than failing on an unknown `type`. The migration from 7 is a no-op that only stamps the
  version, as the 4 → 5 one was.
- `effectiveAuth` (`project/endpoints.ts`) treats `kerberos` as a whole value and does not merge fields
  into it from the interface. An endpoint that overrides with Kerberos replaces the interface's Basic
  outright.
- `SendAuth` gains:

  ```ts
  | { readonly type: 'kerberos'; readonly spn?: string } & KerberosCredentials
  ```

- `AuthSummary` gains an optional `spn?: string`. It is always set for Kerberos, so the timeline can say
  which principal was asked for, and it is not secret. `attempts` stays within `1 | 2`.

### D3. The HTTP handshake: `http/auth/kerberos-transport.ts`

`sendWithAuth` routes `type: 'kerberos'` here, as it routes NTLM. A caller-supplied `Authorization` header
still wins.

```
leg 1  the real request, bare            → not 401, or 401 without Negotiate: that is the result
                                          → 401 + WWW-Authenticate: Negotiate
leg 2  Authorization: Negotiate <token>, the real body again
                                          → the final response
       if the final response carries `WWW-Authenticate: Negotiate <token>`, context.verify(token):
       a token that does not verify fails the send (`kerberos-mutual-auth-failed`)
```

- **One connection.** Both legs travel over one dedicated single-connection dispatcher
  (`createSingleConnectionDispatcher`), as NTLM's legs do, because IIS ties an authenticated session to the
  socket. The dispatcher is closed afterwards.
- **One time budget.** Both legs share the request's timeout budget, as Basic's retry does. When the budget
  is already spent, leg 1's 401 is the result.
- **Token generation.** The token for leg 2 comes from `startKerberosContext`. It is created only after leg 1
  is challenged, so a server that never asks costs nothing, and the native code is never loaded for it.
- **Preemptive mode** (`preemptive: true`, used by D4). This skips leg 1 and sends the token on the first
  request. A Kerberos AP-REQ stands on its own, so this is valid, which it is not for NTLM.
- **The SPN** defaults to `HTTP` plus the hostname of the request URL. That is the host after redirect
  scoping, without the port, as Windows does by default.

Errors are `HttpError`s with the codes below; the D1 seam raises them all. Every message names the SPN tried
and carries the OS's text in `details.osMessage`.

| Code | When | Message gist |
| --- | --- | --- |
| `kerberos-unavailable` | The provider is unavailable | the reason from D1 |
| `kerberos-explicit-credentials-unsupported` | username/password off Windows | "Explicit credentials are Windows-only. Run `kinit user@REALM` and leave them empty." |
| `kerberos-no-credentials` | No ticket / no TGT (`GSS_S_NO_CRED`, `SEC_E_NO_CREDENTIALS`) | "No Kerberos ticket. Sign in to the domain, or run `kinit`." |
| `kerberos-unknown-spn` | `KDC_ERR_S_PRINCIPAL_UNKNOWN` / `SEC_E_TARGET_UNKNOWN` | "The KDC does not know HTTP/host. Set the SPN to the name the service is registered under." |
| `kerberos-clock-skew` | `KRB_AP_ERR_SKEW` / `SEC_E_TIME_SKEW` | "This machine's clock differs from the domain's by more than allowed." |
| `kerberos-rejected` | 401 again after leg 2 | "The server refused the Kerberos token (HTTP 401)." |
| `kerberos-mutual-auth-failed` | The reply token does not verify | "The server's reply could not be verified." |
| `kerberos-failed` | Any other OS error | the OS text |

When leg 1 is challenged without `Negotiate`, the result is the plain 401, and the summary records
`challenged: true, attempts: 1`. A hint under the response names the schemes the server did offer. That is
not an error: the user sees what came back.

### D4. Every send path

- **SOAP and REST.** No change beyond `sendWithAuth`. The redaction of `Authorization: Negotiate …` comes
  free from the existing header masker. Check it, and add `Negotiate` to the scheme list if the masker keys on
  the scheme.
- **CLI runner and MCP.** `run/prepare.ts` (`prepareSoap`, and the REST path) resolve the arm with the
  others, `passwordEnv` included. An unavailable provider makes that request **error** (the run exits 3),
  not fail, and leaves the rest of the run to continue.
- **Definition fetch.** `document-fetch.ts` attaches Kerberos **preemptively** on each same-origin hop, the
  way it attaches Basic, with a fresh token per hop. `soap/import.ts` drops `withBasicAuth` for a small
  `withTransportAuth` that takes `basic | kerberos` and uses the same per-hop rule. The import dialog and
  Update Definition dialogs (`components/definition-auth.tsx`) offer Kerberos. A 401 with Kerberos sent is
  `definition-auth-required` with `authSent: true`, as today.
- **WebSocket.** `ws/call.ts` sends a preemptive `Authorization: Negotiate <token>` on the upgrade request. A
  handshake gets one request, as the Basic comment there explains. If the `101` response carries a Negotiate
  token, it is verified as in D3; if it carries none, the upgrade is accepted, as browsers do. Building the
  headers becomes `async`.
- **gRPC.** `grpc/send.ts` adds `authorization: Negotiate <token>` metadata from `kerberosToken`,
  preemptively, with a new token for each call. A streaming call gets one token at call start. Mutual auth is
  not checked on gRPC: trailers carry no Negotiate token in practice. `grpc/command.ts` (the grpcurl export)
  refuses Kerberos with a clear "not expressible as a command" note, as it does for the other non-static
  schemes.

### D5. Resolution in main

- `secrets/resolve.ts`. `resolveEndpointAuth` and `resolveAuthConfig` map the arm to `SendAuth`. A
  `passwordRef` or `passwordEnv` is resolved only when a `username` is set. A dangling reference is
  `secret-missing`, before any network traffic. #41 resolves its STS Kerberos credential through the same
  function, so both features read a credential the same way.
- `apps/desktop/src/main` creates one provider at start-up with the vendored `bindingPath` (D7), and
  `main/index.ts` installs it process-wide with `configureKerberos` (amended). Every send path picks it up
  from there: REST, SOAP, WebSocket and gRPC through `desktopSendHost`, and definition fetches.
- The cURL export (`ipc/request.ts`) emits `--negotiate --user :`, or `--negotiate --user 'DOMAIN\user:'`, never with a password
  (amended: the export has no NTLM output to mirror).

### D6. Wire and renderer

- `wire-types.ts` gets a `kerberosAuthWireSchema` mirroring D2 at every site that takes an auth union, and a
  query `auth.kerberosAvailability` → `KerberosAvailability`.
- `components/auth-fields.tsx` gains a **Kerberos** option in every scheme picker it serves: REST, SOAP
  owners, gRPC, WebSocket, and definition auth. Its fields:
  - **SPN.** Placeholder `HTTP/<host of the request>`, help text "Leave empty unless the service is registered
    under another name".
  - **Principal.** Shown on macOS and Linux only; placeholder `user@REALM`.
  - **Use another account.** Windows only. A disclosure with Username, Domain and Password, the password going
    to the keychain as `passwordRef` like NTLM's.
  - When availability is false, the option stays visible but disabled, with the reason as its description.
    A saved Kerberos config still shows its fields, plus the reason, so the user can see why sends fail.
- The SOAP request auth inspector (`request-editor/inspectors/auth-inspector.tsx`) gains the same option.
- The response timeline and the HTTP log describe the exchange: "Kerberos: challenged, authenticated as
  HTTP/host (2 attempts)", or "sent preemptively".

### D7. Packaging

- `kerberos` goes in `packages/engine/package.json` `optionalDependencies` at the exact version `7.0.0`. Its
  `install` script runs `prebuild-install`. pnpm 9 runs it by default. A failed
  install leaves the module absent and the engine working.
- New `scripts/vendor-kerberos.ts`, run by the `package:*` scripts before electron-builder:
  - It downloads `kerberos-v7.0.0-napi-v9-<platform>-<arch>.tar.gz` from the package's GitHub release, for
    every architecture of the target platform that has a prebuild.
  - It checks each tarball against SHA-256s committed in `scripts/kerberos-prebuilds.json`. A
    mismatch fails the build.
  - It extracts `kerberos.node` to `apps/desktop/build-resources/kerberos/<platform>-<arch>/`.
- `electron-builder.yml` copies that folder through `extraResources` (outside the asar, so no `asarUnpack`
  entry is needed). On macOS the files are signed with the app and covered by notarisation. On Windows they go
  through SignPath with the rest of the unpacked app.
  - Each per-arch build carries the same folder, so the universal merge sees identical files.
  - `win32-arm64` has no file, and the loader reports "not available on Windows on ARM".
- The SBOM step lists `kerberos@7.0.0` (Apache-2.0) as a component of the desktop app.
- `docs/release.md:75` and the `npmRebuild` comment in `electron-builder.yml` change from "no native modules"
  to "one native module, vendored, not rebuilt", and link ADR-0019.

### D8. Redaction and security

- A Negotiate token is a bearer credential for as long as it is valid. Header redaction covers it in
  History, the HTTP log, the HAR export and CLI reports, which mask `Authorization` whatever the scheme.
  This is checked by a test, not assumed. (#41 owns masking the token inside a `BinarySecurityToken`.)
- The password, when present, follows ADR-0004 exactly as NTLM's does: keychain or environment, never the
  project file. The schema refuses `password`.
- Credentials never cross origins. Definition fetches attach Kerberos only on same-origin hops (D4), and
  `scopeHeadersToOrigin` already strips `Authorization` from a REST redirect to another origin.
- The binding is loaded only from the vendored path in a packaged app, never from a path a project or an
  environment variable names.

## Testing

**Unit, engine, with a fake `KerberosProvider`:**

- The seam (`kerberos-token.ts`):
  - SPN normalisation per platform, with `platform` injected, including `host/sts.corp` and a bare host;
  - the mechanism and flags are always `KRB5` and `MUTUAL`, so the NTLM-fallback ruling is asserted at the
    one boundary;
  - the Windows-only refusal on darwin and linux, before the provider is touched;
  - each OS error string or code maps to its error code;
  - `kerberosToken` returns the raw bytes of the first `step`;
  - `verify` passes the reply through, and a failing `step` gives `kerberos-mutual-auth-failed`.
- Leg sequencing:
  - unchallenged: 1 attempt, and the provider is never touched;
  - challenged: 2 attempts, the same connection, the body sent twice;
  - challenged without Negotiate: plain 401 and the hint;
  - 401 after leg 2: `kerberos-rejected`;
  - the timeout budget is shared.
- SPN default from the request URL.
- Schema:
  - the arm is accepted at every site;
  - `password` is refused;
  - 7 → 8 migration: a v7 fixture loads unchanged and is rewritten with only the version line changed;
  - a v9 folder is refused as too new.
- `effectiveAuth` does not merge interface fields into Kerberos.
- WebSocket preemptive header and 101 verification; gRPC metadata per call; grpcurl export refusal.
- Definition fetch: Kerberos is attached on a same-origin hop and not on another origin's.
- Redaction: `Authorization: Negotiate …` is masked in History, HAR and the JSON report.

**Unit, desktop:**

- Wire schemas, including plaintext refused over IPC.
- `auth.kerberosAvailability`.
- `AuthFields`: the disabled option with its reason, the Windows-only disclosure, and principal on non-Windows
  only.
- The cURL export.

**Integration (CI, `ubuntu-latest`, new job `kerberos-integration`):** an apt-installed MIT KDC (amended), with a realm,
a user and an `HTTP/localhost` keytab, and a small Negotiate-protected HTTP server built on
`KerberosServer` from the same package. The test runs `kinit` with a test keytab, then:

- a REST send and a SOAP send through `sendWithAuth`, each succeeding with mutual auth;
- `kerberosToken` called directly, its bytes accepted by `KerberosServer.step`, which proves the seam #41
  depends on;
- a send with a wrong SPN, giving `kerberos-unknown-spn`;
- a send with no ticket (`kdestroy`), giving `kerberos-no-credentials`.

This proves the real binding and the real GSSAPI, end to end. Every credential in it is generated in the
job.

**Packaging check:** `scripts/check-kerberos-vendor.ts` runs after `--dir` packaging in the release
jobs and in the nightly. It asserts that each unpacked build has `resources/kerberos/<platform>-<arch>/kerberos.node`
for every arch it ships with a prebuild, that the hashes match, and that the host's own arch loads
(`availability().available === true`).

**Manual, documented in `docs/release.md`:** a Windows domain-joined check per release candidate. It covers
SSO to an IIS site with Windows Authentication (Kerberos-only provider), the explicit-account path, and a
wrong SPN. CI has no domain controller, so this is a checklist, not a test.

## Success criteria

Evidence rows go in `docs/success-criteria.md` as SC-K1–SC-K10.

- **SC-K1:** a REST and a SOAP send to a Negotiate-protected server succeed with the logged-in ticket, with
  mutual auth verified (integration job).
- **SC-K2:** no path falls back to NTLM: the mechanism is always Kerberos, and a Kerberos failure is reported
  by code with the SPN tried.
- **SC-K3:** Windows can send as another account with `username`/`domain`/`passwordRef`. macOS and Linux
  refuse that config before any network traffic.
- **SC-K4:** WSDL, OpenAPI and AsyncAPI documents behind Negotiate import, and Update Definition reads them
  again; credentials never reach another origin.
- **SC-K5:** the CLI runner and MCP send with Kerberos. Where the binding is unavailable, that request
  errors and the run continues.
- **SC-K6:** a WebSocket upgrade and a gRPC call carry a preemptive Negotiate token.
- **SC-K7:** the format moves to 8. A v7 project loads unchanged and is rewritten with only the version line
  changed. Plaintext `password` is refused on load and over IPC.
- **SC-K8:** every desktop build ships a vendored, hash-checked `kerberos.node` for each arch with a
  prebuild. Where none loads, the UI shows the scheme disabled with the reason, and nothing crashes.
- **SC-K9:** Negotiate tokens are masked in History, the HTTP log, HAR exports and CLI reports.
- **SC-K10:** `kerberosToken(spn, credentials)` is exported from the engine, applies the same availability,
  credential and mechanism rules as the HTTP path, and its token is accepted by a real acceptor.

## Docs

- `docs-site/src/content/docs/guides/auth.mdx` gets a Kerberos section covering:
  - single sign-on, and `kinit` on macOS and Linux;
  - the SPN override;
  - the Windows-only account option;
  - no NTLM fallback;
  - a troubleshooting table keyed by the error codes in D3;
  - platform availability, Windows on ARM included.
- `docs-site/.../guides/importers.mdx` and the CLI reference: Kerberos for definitions and in runs.
- `docs/roadmap.md` item 7 and the _Authentication_ section: Kerberos is specified, with a link here.
- `docs/release.md`: native module, vendoring, and the manual Windows checklist.
- `CHANGELOG.md`, _Unreleased / Added_.

## Amendments (2026-10-05, with the plan)

The plan, `docs/plans/2026-10-05-kerberos-spnego-auth-plan.md`, lists thirteen amendments where the code disagreed
with this spec. The ones that change the design are:

- **The provider is process-wide.** `configureKerberos` is called once by the desktop app, and once per test.
  `startKerberosContext(…, { provider })` still overrides it. `kerberosToken`'s signature is unchanged.
- **One-request paths make a bearer first.** WebSocket, gRPC and definition fetches turn Kerberos into
  `Authorization: Negotiate <token>` with `negotiateBearer`/`withNegotiate` before their synchronous header
  builders run. The WebSocket `101` reply is not verified.
- **WSDL fetches.** A Kerberos WSDL is fetched through the origin-scoped document fetcher. The import dialog
  offers the signed-in ticket and an SPN only.
- **Masking.** `WWW-Authenticate: Negotiate <token>` is masked, as well as `Authorization`.
- **UI.** The only auth summary in the UI is the SOAP status note, and it becomes Kerberos-aware. The cURL
  export gains `--negotiate`. The availability channel also returns the platform.
- **Packaging.** The vendoring and check scripts live in root `scripts/`. macOS ships one universal binary in
  both architecture folders, listed under `mac.x64ArchFiles`. The licence script reads `optionalDependencies`.
  The vendor check runs in the release jobs only.
- **CI.** The KDC is apt-installed on the runner. No container image is pulled.

## Delivery

There are two PRs, each green on its own (amended: WebSocket and gRPC moved into the engine PR).

1. **Engine and format:** D1 (the seam #41 waits for), D2, D3 and D4 for HTTP sends, the definition fetch,
   the CLI and MCP, plus the schema bump, the unit tests and the integration job. The desktop app is not
   wired yet, so the scheme is not offered.
2. **Desktop:** D5, D6, D7 and D8. Resolution, the UI, the vendoring script, the packaging check, the release
   docs and the cURL export.
3. **WebSocket and gRPC:** the preemptive paths and their UI pickers.

## Boundaries

- One new dependency, `kerberos`, by the ruling in ADR-0019 and nothing else. The KDC image for the
  integration job is CI-only.
- `formatVersion` 7 → 8, with a no-op migration.
- Never name another product (`pnpm check:banned-terms`).
