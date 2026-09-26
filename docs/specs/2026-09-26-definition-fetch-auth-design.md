# Definitions behind authentication — design

Issue: #135 · Date: 2026-09-26 · Status: approved to build (owner, 2026-09-26)

Builds on: Update Definition for a REST API (`docs/specs/2026-09-22-rest-update-definition-design.md`, #47),
the OpenAPI importer (`docs/specs/2026-09-14-swagger-and-openapi-3-2-import-design.md`), the AsyncAPI importer
(`docs/specs/2026-09-22-asyncapi-import-design.md`), the REST client's auth model
(`docs/specs/2026-09-13-wirebench-rest-client-design.md`, §3.5), token auth for SOAP owners
(`docs/specs/2026-09-22-soap-owner-auth-design.md`), secret scanning
(`docs/specs/2026-09-22-secret-scanning-design.md`), ADR-0003 (project folder format) and ADR-0004
(secrets outside project files).

## Objective

Import an OpenAPI or AsyncAPI document that sits behind Basic auth, a bearer token or an API key, and
re-read it on Update Definition without asking again. The credential is kept the way request auth is
kept: a keychain reference in the project file, the value in the OS keychain.

## Decisions

1. **One auth per definition, reusing the existing arms.** A definition carries an optional `auth` of
   kind Basic, Bearer, or API key (header or query). The shapes and schemas are the ones `AuthConfig`
   already has; nothing new is modelled. The definition's auth is separate from the API's own `auth`
   (the credentials its requests send): a gateway's definition endpoint and the API it describes may
   want different credentials.
2. **Secrets are references only.** `passwordRef`, `tokenRef`, `valueRef`. The existing
   `endpointAuthSchema` `password` refine and `refuseSecretValues` keep plaintext out of the file; the
   wire schemas are `.strict()` so a plaintext key fails validation over IPC too.
3. **One fetcher for every OpenAPI and AsyncAPI read.** It goes through the engine's HTTP client, so the
   app's proxy and CA bundle apply, which the current global-`fetch` fetcher ignores.
4. **Auth goes only to the document's own origin.** The origin of the URL the user gave. A redirect or a
   `$ref` to another origin is fetched without it.
5. **Update Definition reuses the stored auth without asking.** Choosing another URL shows the auth
   section, and applying from that URL stores what it holds.
6. **401 and 403 are a typed error**, `definition-auth-required`, with a message that says the
   definition needs authentication (or that the credentials given were refused).
7. **No `formatVersion` bump.** See _Format_ below.
8. **Out of scope:** OAuth2, NTLM, WSDL (keeps its own `withBasicAuth`), and definition auth used per
   request.

## Current state

| Concern | Where | Today |
| --- | --- | --- |
| REST definition record | `packages/engine/src/rest/model.ts:227` `RestDefinitionRef` | `{ source, cache, version }` |
| AsyncAPI definition record | `packages/engine/src/ws/model.ts:103` `WsDefinitionRef` | `{ kind: 'asyncapi', source, cache, server? }` |
| Format | `packages/engine/src/project/schema.ts:402` (`apiFileSchema.definition`), `:521` (`wsApiFileSchema.definition`) | `looseObject`s with no auth |
| Auth arms | `project/model.ts:50` `EndpointAuth`, `:75` `BearerAuth`, `:86` `ApiKeyAuth`; `schema.ts:46` `endpointAuthSchema`, `:94` `bearerAuthSchema`, `:103` `apiKeyAuthSchema`, `:67`/`:78` `PLAINTEXT_SECRET_KEYS`/`refuseSecretValues` | shared by every owner |
| Load / save | `project/load.ts:703-710` (REST), `:666-674` (WebSocket) copy named fields; `project/serialize.ts:351`, `:408` write `compact({ ...api.definition })` | an unknown key would be dropped on load |
| Default fetcher | `packages/engine/src/wsdl/fetch.ts:59` `createDefaultFetchDocument` | `file:` from disk; `http(s):` through global `fetch`, no proxy, no CA bundle, no auth; non-2xx → `HttpError('fetch-failed')` |
| WSDL auth | `packages/engine/src/import.ts:37` `withBasicAuth` | Basic header on every `http(s)` fetch, any origin |
| HTTP client | `packages/engine/src/http/client.ts:333` `sendHttp`; `:173-190` `CREDENTIAL_HEADERS` / `scopeHeadersToOrigin`, applied at `:449` | drops `Authorization`, `Proxy-Authorization` and `Cookie` on a cross-origin redirect; a custom API-key header or a query key is not dropped |
| Import service | `apps/desktop/src/main/openapi-import.ts:64` (constructor), `:73` `run`, `:95` `runAsyncApi`, `:111` `readAsyncApi`, `:119` `readOpenApi`, `:144-151` per-call wrapper | one fetcher built at construction, no credentials; wired at `apps/desktop/src/main/index.ts:193` |
| IPC | `apps/desktop/src/main/ipc/api.ts:172` `importOpenApi`, `:230` `importAsyncApi`, `:287` `asyncApiServers`, `:307` `readAsyncApiSource`, `:371` `readRestSource` (TODO at `:365`) | no auth anywhere |
| Placement | `apps/desktop/src/main/project-host.ts:2918` `addApi` (`:2946`), `:2964` `importAsyncApi` (`:2993`), `:3303` REST apply rewrites `definition` | records `source` only |
| Network for sends | `project-host.ts:1661` `restTlsFor`, `:2175` `trustAnchors`, `:2193` `proxyFor`; project-free: `apps/desktop/src/main/network-options.ts:93` `mainHttpOptions` | used by `sendRestRequest` (`ipc/request.ts:828-839`) and the server client |
| Secret resolution | `packages/engine/src/secrets/resolve.ts:118` `resolveAuthConfig`; main's getter `secretsFor(undefined)` (`index.ts:115`) | `secret-missing` on a dangling reference |
| Wire | `apps/desktop/src/shared/wire-types.ts:2780` `apiImportOpenApiRequestSchema`, `:2825` `apiImportAsyncApiRequestSchema`, `:2851` `apiAsyncApiServersRequestSchema`, `:2908` `restUpdateSourceSchema`, `:1462` / `:1663` definition on the API wire | no auth; WSDL has `importAuthSchema` (`:47`, `.strict()`) |
| Renderer | `features/explorer/import-dialog.tsx:164-172`, `:888-921` (WSDL *Use Basic auth*, `SecretField`); `features/rest-api/rest-update-dialog.tsx` (chooser at `:282`); `features/ws-api/asyncapi-update-dialog.tsx`; `components/auth-fields.tsx` (`AuthFields`, `types` prop) | no auth for OpenAPI or AsyncAPI |

## Design

### D1. Storage

`project/model.ts` adds

```ts
/** How a definition document is fetched. Secrets are keychain references, as everywhere else. */
export type DefinitionAuth = (EndpointAuth & { readonly type: 'basic' }) | BearerAuth | ApiKeyAuth;
```

and `RestDefinitionRef` and `WsDefinitionRef` each gain `readonly auth?: DefinitionAuth`.

`schema.ts` adds one schema built from the existing arms, so their plaintext rejection comes with them:

```ts
/** A definition's fetch credentials: Basic, Bearer or API key, each as references only. */
export const definitionAuthSchema = z.union([
  endpointAuthSchema.refine((auth) => auth.type === 'basic', { message: 'a definition supports Basic, not NTLM' }),
  bearerAuthSchema,
  apiKeyAuthSchema,
]);
```

`apiFileSchema.definition` and `wsApiFileSchema.definition` gain `auth: definitionAuthSchema.optional()`.
Persisted, a REST API reads:

```yaml
definition:
  source: https://gateway.example.test/billing/openapi.yaml
  cache: true
  version: 3.1.0
  auth:
    type: basic
    username: ada
    passwordRef: 6c1f…
```

`load.ts` copies it at `:703-710` and `:666-674` through the existing `authConfig` normaliser (`:269`);
`serialize.ts` writes it through `authDocument` (`:59`) rather than the bare spread. The `…Env` names the
reused schemas accept are kept if present but nothing sets them: only the desktop fetches a definition.

**Backward compatibility.** `auth` is optional. A file without it loads and behaves exactly as today: the
document is fetched without credentials.

**Format.** `formatVersion` stays 5. ADR-0003 says any additive field bumps the version; #100 and #47
added optional definition-side fields without one on the grounds that an older build dropping them loses
metadata, not data. The same holds here: an older build that saves drops `definition.auth`, the next
Update Definition answers `definition-auth-required`, and the user enters the credentials again through
**Choose another file or URL…**. The keychain entry is left unused, as any replaced reference is.

### D2. Fetching

New `packages/engine/src/http/document-fetch.ts`:

```ts
export interface DocumentFetchOptions {
  /** Resolved credentials: values, not references. Sent only to `authOrigin`. */
  readonly auth?: SendAuth;
  /** Origin of the document the user named; absent means no auth is ever attached. */
  readonly authOrigin?: string;
  /** TLS and proxy for one URL, as main resolves them. */
  readonly network?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
}
export function createHttpFetchDocument(options?: DocumentFetchOptions): FetchDocument;
```

- `file:` locations are delegated to `createDefaultFetchDocument` unchanged.
- `http(s):` goes through `sendHttp` with `followRedirects: false`, a 20 s timeout, the
  `wirebench/0.1` user agent as today, and `Accept: application/json, application/yaml, text/yaml,
  */*;q=0.8`. The host's proxy is resolved inside the same cancel scope as the send, so a cancel while
  it resolves stays a cancel. The fetcher follows up to 10 redirects itself, because
  `scopeHeadersToOrigin` only knows the three standard credential headers and would forward a custom
  API-key header or keep a query key. On each hop it attaches credentials only when the hop's origin
  equals `authOrigin`: Basic as a preemptive `Authorization` header (`basicAuthorization`,
  `http/auth/basic.ts:21`); Bearer and a header API key through `applyAuth` (`rest/auth.ts:61`); a query
  API key appended to that hop's URL. The same rule covers `$ref` documents: a sibling on the same origin
  gets the credentials, another origin does not.
- The returned `location` is the final hop's URL without the query key the fetcher added, so `$ref`
  resolution, progress messages, error messages and the recorded source never carry the key. Error
  text also passes through `redactUrl` (`redact/index.ts:98`) with the key's name.
- A 401 or 403 throws `HttpError('definition-auth-required', …)` with
  `details: { location, status, authSent }`. The message is "The definition at <url> needs
  authentication (HTTP 401)." when nothing was sent, and "The definition at <url> refused the
  credentials given (HTTP 403)." when credentials were sent. Any other non-2xx stays
  `fetch-failed`. A root failure reaches the caller as today; a `$ref` failure stays a reference
  problem (`rest/openapi/refs.ts:310-321`).

**Main.** `OpenApiImportService` takes `{ getSecret, network }` instead of a single prebuilt fetcher
(tests may still inject a factory). `run`, `runAsyncApi`, `readOpenApi` and `readAsyncApi` take an
optional `auth: DefinitionAuth`. Inside `track` they resolve it with `resolveAuthConfig` (a dangling
reference fails as `secret-missing` before any network) and build the call's fetcher with
`authOrigin` set to the source URL's origin. `index.ts:193` wires `getSecret` to `secretsFor(undefined)`
and `network` to `mainHttpOptions` (`network-options.ts:93`). That is the preference-level CA bundle and
proxy that `trustAnchors`/`proxyFor` resolve for a REST send, without a project, because an import may
target a project that does not exist yet. A definition has no client identity and no
`trustInvalid` of its own, so those per-request settings do not apply.

**Every read path uses it:** `api.importOpenApi`, `api.importAsyncApi`, `api.asyncApiServers` (the server
picker reads the same document, so it needs the same credentials), `readAsyncApiSource` and
`readRestSource`. The TODO on `readRestSource` goes. WSDL keeps `withBasicAuth` and its own path.

### D3. Wire

`wire-types.ts` adds

```ts
export const definitionAuthWireSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('basic'), username: z.string(), passwordRef: z.string() }).strict(),
  z.object({ type: z.literal('bearer'), tokenRef: z.string(), scheme: z.string().optional() }).strict(),
  z.object({ type: z.literal('api-key'), name: z.string().min(1), in: z.enum(['header', 'query']), valueRef: z.string() }).strict(),
]);
```

and uses it at:

- `apiImportOpenApiRequestSchema`, `apiImportAsyncApiRequestSchema` and `apiAsyncApiServersRequestSchema`:
  `auth` is optional, and refused unless `source.kind === 'url'`.
- `restUpdateSourceSchema`: the `url` arm gains `auth` (optional). Plan and apply both carry it, since both
  read the document.
- The API wire's `definition` (`:1462`, `:1663`) gains `auth` so the dialogs can show and prefill it.

The AsyncAPI update has no source on the wire (`apiAsyncApiApplyUpdateRequestSchema`, `:2886`, is
`{ apiId, fingerprint }`), so it only reuses the stored auth; see D5.

### D4. Import dialog

`import-dialog.tsx` shows an **Authentication** section on the URL tab when the format is OpenAPI or
AsyncAPI (detected or chosen). It is `AuthFields` with `types={['none', 'basic', 'bearer', 'api-key']}`.
API key offers the header/query choice that `AuthFields` already has. Secrets go through `SecretField`,
which stores the value with `secrets.set` and keeps only the reference, and the form flushes before
Import, as the WSDL `passwordRef` flow does (`:568-573`). **None** sends no `auth`. The same credentials
go to `api.asyncApiServers`, so the server picker works for a protected AsyncAPI document.

Main records the auth on the placed API: `addApi` and `importAsyncApi` in `project-host.ts` take
`auth?: DefinitionAuth` and write it into `definition`.

### D5. Update Definition

- **REST** (`rest-update-dialog.tsx`). With no chosen source, main reads the recorded source with the
  stored `definition.auth`, and the dialog asks nothing. **Choose another file or URL…** adds the same
  Authentication section under the URL field. It is prefilled with the stored auth when the typed URL has
  the same origin as the recorded source, and starts at **None** otherwise, so a stored credential is
  never offered to a new host by default. Applying from a URL stores the URL and the section's auth (none
  clears it). Applying from a file stores the file and clears `auth`. `restApplyUpdate`'s options
  (`project-host.ts`, the `definition` rewrite at `:3303`) take `auth` beside `source`.
- **AsyncAPI** (`features/ws-api/asyncapi-update-dialog.tsx`). It re-reads the recorded source with the
  stored auth. It has no source chooser today, and this design does not add one.
- **Errors.** On `definition-auth-required` the REST dialog opens the chooser with the recorded URL filled
  in and the error shown, so the user can enter or fix the credentials and preview again. The AsyncAPI
  dialog shows the message. `secret-missing` (a project opened on a machine without the keychain entry)
  shows its existing message.

## Testing

- **Engine fetcher**, `packages/engine/test/unit/http/document-fetch.test.ts`, against
  `startTestRestServer` (`packages/engine/test/helpers/test-rest-server.ts`). A served document gains an
  optional `auth: 'basic' | 'bearer' | 'api-key'`, checked with the credentials `/auth/basic`,
  `/auth/bearer` and `/auth/apikey` already accept. Cases: each kind reads a protected document; no
  credentials gives `definition-auth-required` with `authSent: false`; wrong credentials give it with
  `authSent: true`; a redirect to a second server (`redirectOrigins`) reaches it with no `Authorization`,
  no `X-Api-Key` and no `api_key` in the recorded request; a same-origin redirect keeps them; a `$ref`
  to another origin goes without them; the returned `location` and the error text never contain the
  query key; `file:` is unchanged; a proxy from `network` is used.
- **Engine format**, `packages/engine/test/unit/project/schema.test.ts`, `rest-format.test.ts` and
  `ws-format.test.ts`. `definition.auth` round-trips for all three kinds. `password`, `token` and `apiKey`
  are refused, and so are NTLM and OAuth2. A file without `auth` loads unchanged.
- **Main**, `apps/desktop/test/ipc-api.test.ts`, `ipc-asyncapi.test.ts` and `ipc-rest-update.test.ts`.
  Import stores the auth on `definition`. Plan and apply with no source reuse it (the fake fetcher sees
  the resolved credentials). Apply from a chosen URL stores the new auth, and from a file clears it. A
  dangling reference fails as `secret-missing` before any fetch. `asyncApiServers` passes auth through.
- **Wire**, a new `apps/desktop/test/definition-auth-wire.test.ts`, next to `soap-owner-auth-wire.test.ts`.
  A plaintext `password`, `token` or `value` is refused. `auth` with a `file` or `text` source is refused.
  OAuth2 and NTLM are refused.
- **Renderer**, `apps/desktop/test/renderer/import-openapi-dialog.test.tsx`,
  `import-dialog-asyncapi.test.tsx`, `rest-update-dialog.test.tsx` and `asyncapi-update-dialog.test.tsx`.
  The section shows for OpenAPI and AsyncAPI URL sources only, and never for WSDL. Import sends only
  references. The update dialog asks nothing by default. The chooser prefills the stored auth for the same
  origin only. A `definition-auth-required` answer opens the chooser.
- **e2e**, `e2e/specs/rest-update-definition.spec.ts` or a sibling `definition-fetch-auth.spec.ts`. Import
  an OpenAPI document by URL from the test server behind Basic, then Update Definition after the document
  changes, with no credentials asked for, and assert the plan and the applied result.

## Success criteria

- SC-A1: an OpenAPI and an AsyncAPI document behind Basic, Bearer, a header API key and a query API key
  each import.
- SC-A2: the project file holds only references; plaintext is refused on load and over IPC.
- SC-A3: Update Definition on such an API reads the source again without asking.
- SC-A4: credentials never reach another origin, whether by redirect or `$ref`, and a query key never
  appears in a recorded source, a progress message or an error.
- SC-A5: a 401 or 403 answers `definition-auth-required` with a message that says so.
- SC-A6: the fetch uses the configured proxy and CA bundle.
- SC-A7: a file written before this change loads and updates as before.
- SC-A8: choosing another URL can change the stored auth, and a file source clears it.

Evidence rows go in `docs/success-criteria.md`.

## Docs

- `docs-site/src/content/docs/guides/importers.mdx`: the OpenAPI section (and the AsyncAPI pointer)
  describe the Authentication section.
- `docs-site/src/content/docs/guides/rest-client.mdx`: under _Update Definition_ and _Another source_,
  the stored auth is reused, and the chooser lets you change it.
- `docs-site/src/content/docs/guides/asyncapi.mdx`: _Import a document_ and _Update Definition_.
- `CHANGELOG.md`, under _Unreleased / Added_.

## Out of scope

- OAuth2 and NTLM for definitions.
- WSDL. It keeps `withBasicAuth` and its own dialog field.
- Using a definition's auth for requests (the WSDL *Use these credentials for requests too*).
- A source chooser for the AsyncAPI Update Definition.
- Client certificates and *trust invalid certificate* for a definition fetch.

## Boundaries

- No new dependency and no `formatVersion` bump.
- Never name another product (`pnpm check:banned-terms`).
