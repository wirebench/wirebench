# Bearer, API-key and OAuth2 auth for SOAP owners — design

Issue: #43 · Date: 2026-09-22 · Status: draft for review

Builds on: the REST client design (`docs/specs/2026-09-13-wirebench-rest-client-design.md`, §3.5 and the
§15.11 amendment), ADR-0003 (project folder format), ADR-0004 (secrets outside project files),
`docs/roadmap.md` item 8 ("The three token-style auth kinds for SOAP owners" and the _Authentication_
section).

## Objective

A SOAP interface, endpoint or request can authenticate with a Bearer token, an API key (header or query) or
an OAuth2 access token, through the same form, the same keychain references, the same OAuth2 token service
and the same apply code a REST owner uses. Today those three schemes are offered to REST owners only,
although the auth model (`AuthConfig`) and the form (`AuthFields`) are already shared.

§15.11 first assumed this was "tests only". Its amendment recorded why it is not: the project format persists
SOAP owners under the narrower `endpointAuthSchema`, the engine types SOAP owners as `EndpointAuth`, the SOAP
send path applies only the schemes the transport owns (Basic, NTLM), and main resolves only `passwordRef`
for SOAP. This design closes each of those four gaps and nothing else.

## Goals

1. The three SOAP auth sites in the project format accept `bearer`, `api-key` and `oauth2` with exactly the
   REST shapes (`bearerAuthSchema`, `apiKeyAuthSchema`, `oauth2AuthSchema`), plaintext-secret rejection
   included.
2. The engine's `Interface.auth`, `Endpoint.auth` and `RequestDef.auth` are typed as the SOAP-owner subset of
   `AuthConfig` (every arm except `inherit`).
3. A SOAP send puts a Bearer/OAuth2 token in `Authorization` and an API key in its header or in the endpoint
   URL's query string, using the REST `applyAuth`; Basic and NTLM still go to the transport unchanged.
4. Main resolves `tokenRef`, `valueRef` and an OAuth2 access token for a SOAP send, the cURL export and the
   CLI runner exactly as it does for REST.
5. The SOAP interface overview, the endpoints dialog and the request Auth inspector offer all six
   non-inherit schemes; the OAuth2 token panel works for a SOAP owner.

## Non-goals

- Changing the REST auth model's shape, `rest/auth.ts`'s behaviour, or any REST/OpenAPI code
  (`packages/engine/src/rest/openapi/**` is being edited elsewhere and is not touched).
- `inherit` for SOAP owners. The SOAP chain stays request → endpoint (override/complement) → interface.
- The browser grant in the CLI runner. A SOAP owner's OAuth2 goes through the runner's `authFor`, as a REST
  one does since the runner's slice S7: client credentials gets its token once per run, and the
  authorization-code grant is refused with the same `auth-grant-unsupported` error.
- Token auth for WSDL import (the import dialog keeps Basic).
- WS-Security token profiles; WS-Security is unchanged and orthogonal (it can be combined with any HTTP auth).

## Current state

| Concern | Where | What it does today |
| --- | --- | --- |
| Format, SOAP sites | `packages/engine/src/project/schema.ts` — `endpointSchema.auth` (l.148), `interfaceFileSchema.auth` (l.214), `requestFileSchema.auth` (l.273) | `endpointAuthSchema`: `type: none/basic/ntlm`, refuses a plaintext `password` |
| Format, REST sites | same file, `authConfigSchema` (l.136) | union of `endpointAuthSchema`, `inherit`, `bearer`, `api-key`, `oauth2`; `refuseSecretValues` on the token arms |
| Engine types | `packages/engine/src/project/model.ts` — `Interface.auth` (l.150), `Endpoint.auth` (l.272), `RequestDef.auth` (l.329) | `EndpointAuth`; `AuthConfig` is the full union |
| Precedence | `packages/engine/src/project/endpoints.ts` `effectiveAuth` | override/complement merge of `EndpointAuth` fields, interface fallback |
| Secret resolution | `packages/engine/src/secrets/resolve.ts` | `resolveEndpointAuth` + `toSendAuth` (SOAP), `resolveAuthConfig` (REST/gRPC/WS; takes `accessToken` for OAuth2) |
| Apply | `packages/engine/src/rest/auth.ts` `applyAuth` | `SendAuth` → headers / query rows / `transportAuth`; already reused by `ws/call.ts` |
| SOAP send | `packages/engine/src/send.ts` `sendSoapRequest` | passes `input.auth` to `http/auth/apply.ts` `sendWithAuth`, which handles only Basic/NTLM and ignores the rest — a Bearer `SendAuth` would be silently dropped |
| CLI | `packages/engine/src/run/prepare.ts` `prepareSoap` | `resolveEndpointAuth` → `toSendAuth` |
| Main, SOAP | `apps/desktop/src/main/project-host.ts` `authFor` (l.807), `project-auth.ts`, `send-with-history.ts`, `engine-service.ts` `send`/`effectiveSendInput`, `ipc/request.ts` cURL (l.515), `expansion-preflight.ts` (l.93) | typed `EndpointAuth`, resolved with `resolveEndpointAuth` |
| Main, OAuth2 | `apps/desktop/src/main/oauth2.ts` `OAuth2Service`, `ipc/oauth2.ts` `configOf` | owner looked up with `restAuthOf` only |
| Wire | `apps/desktop/src/shared/wire-types.ts` `endpointAuthSchema` (l.916) at `endpointWire`, `interfaceWire`, `requestWire` and the three `update-*-auth` mutations (l.2352–2365); `authConfigWireSchema` (l.1304) | SOAP sites narrow |
| Renderer | `components/auth-fields.tsx` `SOAP_AUTH_TYPES`, `asSoapAuth`; `interface-editor/overview-tab.tsx`, `request-editor/endpoints-dialog.tsx` use `AuthFields`; `request-editor/inspectors/auth-inspector.tsx` has its own Basic/NTLM form | offers three schemes |
| Docs | `docs-site/src/content/docs/guides/auth.mdx` | claims SOAP gets the token schemes "at the endpoint/interface level" — wrong today |

## Design

### D1. Format: one new schema, three sites

`schema.ts` gains

```ts
/** What a SOAP interface, endpoint or request may hold: every scheme except `inherit`. */
export const soapOwnerAuthSchema = z.union([endpointAuthSchema, bearerAuthSchema, apiKeyAuthSchema, oauth2AuthSchema]);
```

and the three SOAP sites switch from `endpointAuthSchema.optional()` to `soapOwnerAuthSchema.optional()`.
`endpointAuthSchema` itself is **not** widened in place: it is an arm of `authConfigSchema`, and widening its
enum would make its looser object shape swallow token configs before the stricter arms see them. The REST
schemas are reused, not copied, so the plaintext rejection (`password`, `token`, `clientSecret`, `apiKey`, …)
applies to SOAP files too. `authConfigSchema` is unchanged.

`serialize.ts` already writes SOAP auth through `authDocument(auth: AuthConfig)` (l.59, 79, 99, 103), which
handles every arm, so it needs no change. `load.ts` copies SOAP `auth` through `optional('auth', …)`
(l.178, 242, 257); it switches to the existing `authConfig(parsed)` normaliser (l.268) so OAuth2 defaults
(`scopes`, `clientAuth`, `pkce`) are filled exactly as for REST.

### D2. Engine types

`model.ts` adds `export type SoapOwnerAuth = Exclude<AuthConfig, InheritAuth>;` and types the three fields as
`SoapOwnerAuth`. `EndpointAuth` is unchanged and remains the Basic/NTLM arm.

`effectiveAuth` (`project/endpoints.ts`) widens to `SoapOwnerAuth` with one rule added: **field-merging in
`complement` mode happens only when both sides are Basic/NTLM** (the only arms with shared fields). Otherwise
`complement` means "the request's own auth, unless it is absent or `none`, then the endpoint's". `override` and
the interface fallback are unchanged. A Basic/NTLM-only project therefore resolves identically.

### D3. SOAP-side `applyAuth`

New `packages/engine/src/soap/auth.ts`:

```ts
export interface SoapAppliedAuth {
  readonly endpoint: string;                          // with an API key appended when `in: 'query'`
  readonly headers: Readonly<Record<string, string>>; // caller headers win
  readonly transportAuth?: SendAuth;                  // Basic / NTLM only
}
export function applySoapAuth(endpoint: string, headers: Readonly<Record<string, string>> | undefined,
  auth: SendAuth | undefined): SoapAppliedAuth;
```

It calls `rest/auth.ts` `applyAuth` (the single implementation of the header and query forms), merges the
auth headers *under* the caller's (an explicit `Authorization` header wins, as it does for Basic in
`sendWithAuth`), and appends query rows with `URL.searchParams.append` (existing query, fragment and encoding
kept; an unparseable endpoint is left as is and the send fails where it would have). `sendSoapRequest` calls
it after property expansion and before WS-Addressing, so `wsa:To` is the endpoint the user configured, not
the one carrying a key; `sendWithAuth` receives only `transportAuth`. `effectiveSendInput` (cURL) goes
through the same function so the exported command matches the send.

### D4. Resolution

- Engine: `resolveSoapAuth(auth: SoapOwnerAuth | undefined, getSecret, options?: { accessToken?: string })`
  in `secrets/resolve.ts` delegates to `resolveAuthConfig`, except that Basic/NTLM keep `toSendAuth`'s
  existing "incomplete pair means no credentials" behaviour so no SOAP send changes. `prepareSoap` uses it and
  refuses OAuth2 as `prepareRest` does.
- Main: `authFor` returns `SoapOwnerAuth | undefined`. `send-with-history.ts` obtains an OAuth2 access token
  through the existing `OAuth2Service.accessToken` (same TLS/proxy the send uses; an interactive grant refuses
  and asks for *Get new token*, as REST does) and hands `accessToken` to `EngineService.send`, which calls
  `resolveSoapAuth`. A missing reference raises `secret-missing` before the wire, reported as a `prepare`
  failure like REST's.
- Main, OAuth2 channels: `ProjectHost` gains `soapAuthOf(ownerId)` (interface, endpoint or request id → its
  own `auth`), `ProjectRouter`/`WorkspaceService` forward it, and `ipc/oauth2.ts` `configOf` falls back to it
  when `restAuthOf` finds nothing. `WorkspaceService.reindex` also indexes endpoint ids so an endpoint can be
  an OAuth2 owner. All additive; no REST method changes.

### D5. Wire and renderer

`wire-types.ts` adds `soapOwnerAuthWireSchema = authConfigWireSchema.refine((a) => a.type !== 'inherit')` and
uses it at the three SOAP wire sites and the three `update-*-auth` mutations; `EndpointAuthWire` stays for
code that still means Basic/NTLM. `project-mutations.ts`'s wire→engine normaliser handles every arm.

`SOAP_AUTH_TYPES` becomes the six non-inherit schemes and `asSoapAuth` drops `inherit` only. The request
Auth inspector replaces its own Basic/NTLM form with `AuthFields` (keeping its "Using … credentials" source
line and the WS-Security section below). All three SOAP sites pass `OAuth2StatusPanel` with their owner id.

### D6. Redaction

An API key in the query string is masked in the SOAP exchange summary, History, the HTTP log, HAR and the
failed-exchange row by passing `keyParams: [name]` to the same `redactUrl` calls REST already uses; a header
key is masked the way REST masks it. The cURL export shows it only with *show secrets* on, as for REST.

## Format and migration decision

**`formatVersion` goes 4 → 5.** ADR-0003 and the `schema.ts` header say *any* additive change bumps the
version because the loader drops unknown keys on save; the CLI runner design (3 → 4) applied it to two
optional fields. Here a SOAP file gains new keys (`tokenRef`, `valueRef`, `clientId`, …) and new enum values.
Without a bump, a 2.x build reading such a file fails the narrow schema with a confusing "invalid project
file" error; with it, the build refuses cleanly with `project-format-too-new`. The 4 → 5 migration is a stamp
(no data moves), proven by a version-4 fixture whose save changes only the `formatVersion` line. ADR-0003 gets
an "Update (formatVersion: 5)" paragraph and `FORMAT_VERSION`'s JSDoc says what 5 added.

Coordination: if another branch bumps to 5 first, this one rebases to 6 — the migration is still a stamp.

## Security

- No secret value is ever written: the REST arms' `refuseSecretValues` now guards SOAP files too (tests pin
  `token`, `clientSecret`, `apiKey` on each SOAP site).
- Access tokens stay in `OAuth2Service`'s memory cache; refresh tokens only as `refreshTokenRef` (ADR-0004).
- An API key in the query string is a known leak surface (server logs, proxies); the form already says so for
  REST, and redaction covers every local surface (D6).
- An explicit `Authorization` header on the request still wins, so nothing sends two credentials.
- The renderer never receives a value: `secrets.get` does not exist; OAuth2 status shows a token only under
  show-secrets, unchanged.

## Testing

- Engine unit: schema (each arm at each SOAP site, `inherit` refused, plaintext keys refused, Basic/NTLM files
  parse unchanged, round-trip), migration 4 → 5 fixture, `effectiveAuth` matrix, `applySoapAuth` (bearer,
  custom scheme, oauth2, api-key header, api-key query with and without an existing query/fragment, caller
  `Authorization` wins, Basic/NTLM pass-through), `sendSoapRequest` against the local stub server (header
  arrives, query arrives, `wsa:To` unchanged), `resolveSoapAuth`, `prepareSoap` (bearer resolves, OAuth2
  refused).
- Desktop unit: `authFor` returns token schemes, `send-with-history` fetches a token for OAuth2 and reports
  `prepare` failures, `soapAuthOf` + `configOf` fallback, endpoint ids indexed, wire schemas, mutation
  normaliser, `asSoapAuth`, the inspector renders `AuthFields` with six types, redaction of a query key.
- E2E (CI only, never run locally): set a Bearer token on a SOAP interface against the stub server and see the
  `Authorization` header in the HTTP log redacted.
- The SOAP e2e suite and every REST test stay green untouched.

## Acceptance criteria (issue #43 checklist)

| Issue item | Met by |
| --- | --- |
| Widen `endpointAuthSchema` at its three sites | D1: `soapOwnerAuthSchema` at `endpointSchema`, `interfaceFileSchema`, `requestFileSchema`; format 5 |
| Engine `Interface`/`Endpoint`/`RequestDef` auth types | D2: `SoapOwnerAuth` on all three; `effectiveAuth` widened |
| A SOAP-side `applyAuth` for header and query schemes | D3: `soap/auth.ts` `applySoapAuth` over `rest/auth.ts` `applyAuth`, used by send and cURL |
| Main resolves the new references | D4: `resolveSoapAuth`, OAuth2 token in `send-with-history`, `soapAuthOf`, CLI runner |
| (implied) offered in the UI | D5: six schemes at the three SOAP forms, OAuth2 panel |

Plus: a Basic/NTLM-only project loads, sends and saves exactly as before (apart from the version stamp).
