# Token Auth for SOAP Owners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #43 — a SOAP interface, endpoint or request can use Bearer, API-key and OAuth2 auth,
through the REST auth model, apply code, keychain references and OAuth2 token service.

**Architecture:** One new format schema (`soapOwnerAuthSchema`, a union of the existing arms) at the three
SOAP sites, format 5; a `SoapOwnerAuth` engine type; `soap/auth.ts` `applySoapAuth` over `rest/auth.ts`
`applyAuth`; `resolveSoapAuth` over `resolveAuthConfig`; small additive main/wire changes; `AuthFields` at all
three SOAP forms.

**Tech Stack:** TypeScript (`strict`, `exactOptionalPropertyTypes`), Zod 4, vitest, Electron, React. No new
dependency.

**Spec:** `docs/specs/2026-09-22-soap-owner-auth-design.md` — read it first; D-numbers below are its.

## Global Constraints

- Branch `feat/soap-owner-auth`. One commit per task, only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
- Commit as Mohammed Naami <m.naami@outlook.com>. **No** `Co-Authored-By:` trailer, **no**
  `Claude-Session:` trailer, no generated-by footer. The body says why.
- Never name, in code, docs or UI copy, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows and no local e2e run; CI runs e2e. Heavy checks under `nice`.
- Do **not** change the REST auth model's shape, `rest/auth.ts`, or anything under
  `packages/engine/src/rest/openapi/`. Edits to `apps/desktop/src/main/project-host.ts` and
  `apps/desktop/src/shared/wire-types.ts` are small and additive; stay out of their REST sections.
- Secrets live in the keychain only; a project file never holds a token, key or client secret.
- `formatVersion` 4 → 5 (stamp-only migration). If `main` reaches 5 first, rebase to 6.
- A Basic/NTLM-only project loads, sends and saves exactly as before, apart from the version stamp.
- Engine style: `readonly` interfaces, discriminated unions, no `any`, conditional spreads, JSDoc that says why.

## File Structure

```
packages/engine/src/project/schema.ts      + soapOwnerAuthSchema; three SOAP sites use it
packages/engine/src/project/model.ts       + SoapOwnerAuth; FORMAT_VERSION = 5
packages/engine/src/project/migrate.ts     JSDoc: 4 → 5 is a stamp
packages/engine/src/project/load.ts        SOAP auth through authConfig()
packages/engine/src/project/endpoints.ts   effectiveAuth widened
packages/engine/src/soap/auth.ts           NEW applySoapAuth
packages/engine/src/send.ts                calls applySoapAuth
packages/engine/src/secrets/resolve.ts     + resolveSoapAuth
packages/engine/src/run/prepare.ts         prepareSoap uses resolveSoapAuth, refuses OAuth2
apps/desktop/src/main/…                    authFor, send-with-history, engine-service, ipc/request (cURL),
                                           ipc/oauth2, project-host soapAuthOf, router, workspace-service
apps/desktop/src/shared/wire-types.ts      + soapOwnerAuthWireSchema at SOAP sites
apps/desktop/src/renderer/…                auth-fields, auth-inspector, overview-tab, endpoints-dialog
docs/adr/0003-project-folder-format.md, docs-site/…/guides/auth.mdx, docs/roadmap.md, docs/success-criteria.md
```

### Task 1: Format 5 — SOAP sites accept the token schemes

**Files:** `packages/engine/src/project/schema.ts`, `model.ts`, `migrate.ts`, `load.ts`,
`packages/engine/src/index.ts`, `packages/engine/test/fixtures/format-v4/**` (new, copied from a v4 save),
`packages/engine/test/unit/project/auth-config.test.ts`, `…/migrate.test.ts`, `…/load-save.test.ts`,
`docs/adr/0003-project-folder-format.md`.

**Interfaces:**

```ts
// schema.ts
export const soapOwnerAuthSchema = z.union([endpointAuthSchema, bearerAuthSchema, apiKeyAuthSchema, oauth2AuthSchema]);
// endpointSchema.auth, interfaceFileSchema.auth, requestFileSchema.auth: soapOwnerAuthSchema.optional()
// model.ts
export type SoapOwnerAuth = Exclude<AuthConfig, InheritAuth>;
export const FORMAT_VERSION = 5;
// Interface.auth?, Endpoint.auth?, RequestDef.auth?: SoapOwnerAuth
```

`load.ts` maps the three SOAP `auth` values through `authConfig(parsed)` and narrows to `SoapOwnerAuth`.
Type errors this surfaces downstream (`effectiveAuth`, `run/effective-auth.ts`, desktop `authFor`) are fixed
by the narrowest cast-free change that keeps behaviour — usually typing the parameter `SoapOwnerAuth` and
leaving Basic/NTLM logic as is; real behaviour lands in Tasks 2–4. ADR-0003 gets an "Update (2026-09-22,
token auth for SOAP owners): `formatVersion: 5`" paragraph.

**Tests:**
- Each SOAP site parses `{type:'bearer',tokenRef}`, `{type:'api-key',name,in:'query',valueRef}`,
  `{type:'oauth2',grant:'client-credentials',tokenUrl,clientId}` (defaults `scopes: []`, `clientAuth: 'basic'`,
  `pkce: true` filled).
- Each SOAP site refuses `{type:'inherit'}` and a plaintext `token`, `clientSecret`, `apiKey`, `password`.
- A Basic and an NTLM SOAP file parse to the same model as before (snapshot of the v4 fixture's model).
- Round trip: load → save → load of a project with one of each token scheme on interface, endpoint, request.
- Migration: the v4 fixture opens; its save differs from the input only in `formatVersion: 5`; format 6 is
  refused with `project-format-too-new`.

### Task 2: SOAP-side applyAuth and precedence

**Files:** `packages/engine/src/soap/auth.ts` (new), `packages/engine/src/send.ts`,
`packages/engine/src/project/endpoints.ts`, `packages/engine/src/index.ts`,
`packages/engine/test/unit/soap/auth.test.ts` (new), `…/project/endpoints.test.ts`,
`…/send.test.ts` (or the stub-server integration test that covers `sendSoapRequest`).

**Interfaces:**

```ts
// soap/auth.ts
export interface SoapAppliedAuth {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly transportAuth?: SendAuth;
}
export function applySoapAuth(
  endpoint: string,
  headers: Readonly<Record<string, string>> | undefined,
  auth: SendAuth | undefined,
): SoapAppliedAuth;
// endpoints.ts
export function effectiveAuth(
  requestAuth: SoapOwnerAuth | undefined,
  endpointAuth: SoapOwnerAuth | undefined,
  authMode: 'override' | 'complement',
  interfaceAuth?: SoapOwnerAuth,
): SoapOwnerAuth | undefined;
```

`applySoapAuth` calls `applyAuth` from `rest/auth.ts`; caller headers win case-insensitively; query rows are
appended with `URL.searchParams.append`; an unparseable endpoint is returned unchanged. `sendSoapRequest`
applies it after property expansion and before WS-Addressing, and passes only `transportAuth` to
`sendWithAuth`. Complement field-merge only when both sides are Basic/NTLM (spec D2).

**Tests:**
- bearer → `Authorization: Bearer t`; `scheme: 'Token'` → `Token t`; oauth2 → `Bearer <accessToken>`.
- api-key header → `X-Api-Key: k`; query → `https://h/s?key=k`; existing `?a=1#f` → `?a=1&key=k#f`;
  value `a b&c` is encoded.
- Caller `authorization` header present → auth header not added.
- Basic/NTLM → no headers, `transportAuth` is the input.
- `effectiveAuth`: complement request `none` + endpoint bearer → bearer; complement request bearer + endpoint
  basic → bearer; complement basic + basic still merges fields (existing cases unchanged); override endpoint
  api-key wins over request bearer; nothing set → interface oauth2.
- Stub server: a bearer SOAP send arrives with the header; an api-key query send arrives with the parameter;
  `wsa:To` in the envelope is the endpoint without the key.

### Task 3: Resolution in the engine and the CLI runner

**Files:** `packages/engine/src/secrets/resolve.ts`, `packages/engine/src/run/prepare.ts`,
`packages/engine/src/run/effective-auth.ts`, `packages/engine/src/index.ts`,
`packages/engine/test/unit/secrets/resolve.test.ts`, `…/run/prepare.test.ts`.

**Interfaces:**

```ts
export async function resolveSoapAuth(
  auth: SoapOwnerAuth | undefined,
  getSecret: GetSecret,
  options?: { readonly accessToken?: string },
): Promise<SendAuth | undefined>;
```

Basic/NTLM: `toSendAuth(await resolveEndpointAuth(auth, getSecret))` (unchanged semantics). Others:
`resolveAuthConfig(auth, getSecret, options)`. `prepareSoap` uses it; a SOAP owner's OAuth2 throws
`auth-grant-unsupported` with the same messages as `prepareRest`.

**Tests:**
- bearer with a stored `tokenRef` → `{type:'bearer',token}`; dangling ref → `secret-missing`; no ref → undefined.
- api-key resolves `valueRef`; oauth2 with/without `accessToken`.
- Basic with username and no password → undefined (as today); NTLM unchanged.
- `prepareSoap`: bearer request resolves via `WIREBENCH_SECRET_<tokenEnv>`; oauth2 → `auth-grant-unsupported`.

### Task 4: Main resolves the new references

**Files:** `apps/desktop/src/main/project-host.ts` (`authFor` return type, new `soapAuthOf`),
`project-auth.ts`, `project-router.ts`, `workspace-service.ts` (forward `soapAuthOf`, index endpoint ids),
`engine-service.ts` (`send`, `effectiveSendInput` take `SoapOwnerAuth` + `accessToken`, use `resolveSoapAuth`
and `applySoapAuth`), `send-with-history.ts` (OAuth2 token, `keyParams`), `ipc/request.ts` (cURL path),
`ipc/oauth2.ts` (`configOf` fallback), `engine-wire.ts` / `har.ts` / `failed-exchange.ts` (pass `keyParams`
for SOAP), `expansion-preflight.ts` (type only), and their tests under `apps/desktop/test/unit/main/`.

**Interfaces:**

```ts
// ProjectHost
authFor(requestId: string): SoapOwnerAuth | undefined;
/** The credentials configured on one SOAP interface, endpoint or request — its own, not its effective ones. */
soapAuthOf(ownerId: string): SoapOwnerAuth | undefined;
// EngineService
send(request, options?: { auth?: SoapOwnerAuth; accessToken?: string; … }): Promise<ExchangeSummary>;
effectiveSendInput(input, options?: { scopes?: PropertyScopes; auth?: SoapOwnerAuth; accessToken?: string }): Promise<SoapSendInputWire>;
// ipc/oauth2.ts
readonly project: Pick<ProjectRouter, 'restAuthOf' | 'projectId'> & Partial<Pick<ProjectRouter, 'soapAuthOf' | 'restTlsFor' | 'proxyFor'>>;
```

`send-with-history.ts` fetches the token with `deps.oauth2.accessToken(auth, { credentials, tls, proxy })`
inside the existing prepare `try`, so a failure is a `prepare` row and History is not written. cURL export
never fetches a token over the network: it uses a cached one if present, otherwise leaves `Authorization`
out and says so in the existing note.

**Tests:**
- `authFor` returns an endpoint's bearer under override, a request's api-key under complement.
- `soapAuthOf` finds interface, endpoint and request ids; unknown → undefined.
- `configOf` falls back to `soapAuthOf`; a SOAP endpoint id routes through `WorkspaceService`.
- `send-with-history`: OAuth2 SOAP send calls `accessToken` once and sends `Bearer`; token failure → `prepare`
  failed row, no History entry; dangling `tokenRef` → `secret-missing` prepare row.
- Query api-key is `•••`-masked in the exchange summary URL, History, HAR and failed row; shown with show-secrets.
- cURL: bearer SOAP request shows a redacted `Authorization` header; api-key query appears in the URL redacted.

### Task 5: Wire schema and the shared form for SOAP owners

**Files:** `apps/desktop/src/shared/wire-types.ts`, `apps/desktop/src/main/project-mutations.ts`,
`apps/desktop/src/main/project-wire.ts` (if it narrows auth), `apps/desktop/src/renderer/components/auth-fields.tsx`,
`renderer/features/request-editor/inspectors/auth-inspector.tsx`,
`renderer/features/interface-editor/overview-tab.tsx`, `renderer/features/request-editor/endpoints-dialog.tsx`,
`renderer/state/project.ts`, tests under `apps/desktop/test/unit/`.

**Interfaces:**

```ts
// wire-types.ts (additive; SOAP sites and update-request/interface/endpoint-auth switch to it)
export const soapOwnerAuthWireSchema = authConfigWireSchema.refine((auth) => auth.type !== 'inherit', {
  message: 'a SOAP interface, endpoint or request cannot inherit',
});
export type SoapOwnerAuthWire = z.infer<typeof soapOwnerAuthWireSchema>;
// auth-fields.tsx
export const SOAP_AUTH_TYPES: readonly AuthConfigWire['type'][] = ['none', 'basic', 'ntlm', 'bearer', 'api-key', 'oauth2'];
export function asSoapAuth(auth: AuthConfigWire | null): SoapOwnerAuthWire | null;
// state/project.ts
readonly updateRequestAuth: (requestId: string, auth: SoapOwnerAuthWire | null) => void;
```

The request Auth inspector renders `AuthFields scope="Request" types={SOAP_AUTH_TYPES}` under its source line;
the WS-Security section is untouched. Each SOAP form passes `<OAuth2StatusPanel ownerId=… grant=…/>` for OAuth2.
`project-mutations.ts`'s wire→engine normaliser becomes the one REST already uses for `AuthConfigWire`
(minus `inherit`), not a copy.

**Tests:**
- Wire: each SOAP mutation accepts bearer/api-key/oauth2 and rejects `inherit`.
- Normaliser: absent optional fields are absent, not `undefined` (`exactOptionalPropertyTypes`).
- `asSoapAuth`: passes the six, maps `inherit` to null.
- Inspector: offers six types; choosing Bearer shows the token SecretField and commits `tokenRef`;
  OAuth2 shows the status panel; the source line still reads "Using endpoint 'x' credentials (override)".
- Overview tab and endpoints dialog offer six types.
- E2E (CI only, `e2e/`): Bearer on a SOAP interface against the stub server; the HTTP log shows
  `Authorization` redacted. Not run locally.

### Task 6: Docs

**Files:** `docs-site/src/content/docs/guides/auth.mdx`, `docs/roadmap.md`, `docs/success-criteria.md`,
`docs/specs/2026-09-13-wirebench-rest-client-design.md` (one line under §15.11: "built by #43, see
`2026-09-22-soap-owner-auth-design.md`"), `docs/architecture/overview.md` if it states the format version.

- `auth.mdx`: "REST and SOAP" section says every scheme is available at a SOAP interface, endpoint and
  request; SOAP has no *Inherit* (its request → endpoint → interface order explains itself); complement merges
  fields only between Basic and NTLM; an API key in the query string is added to the endpoint URL and masked
  in the log; the CLI runner refuses OAuth2.
- `roadmap.md`: mark "The three token-style auth kinds for SOAP owners" done 2026-09-22 and rewrite the
  _Authentication_ bullet in the past tense.
- `success-criteria.md`: add rows SC-O1–SC-O4 (format sites, apply, resolution, UI) with test evidence paths.
- Tests: `pnpm check:banned-terms` and the docs-site build via `pnpm check`.
