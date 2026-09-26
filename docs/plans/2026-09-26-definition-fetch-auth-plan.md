# Definitions behind authentication — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/specs/2026-09-26-definition-fetch-auth-design.md`. Issue #135.

**Goal:** Import an OpenAPI or AsyncAPI document that sits behind Basic auth, a bearer token or an API key, keep
the credential as a keychain reference on the API's `definition`, and re-read the document on Update Definition
without asking again.

**Architecture:** The engine gains a `DefinitionAuth` model (the existing Basic, Bearer and API-key arms) on
`RestDefinitionRef` and `WsDefinitionRef`, persisted through `definitionAuthSchema`, and one document fetcher,
`createHttpFetchDocument`, that goes through `sendHttp` with the host's TLS and proxy, follows redirects itself and
sends resolved credentials to the source's own origin only. Main's `OpenApiImportService` builds that fetcher per
read, resolving the references with `resolveAuthConfig` first. The `api.*` channels carry a strict
`definitionAuthWireSchema`, the project host records it on import and reuses it on Update Definition, and the
renderer offers an **Authentication** section (`DefinitionAuthFields`, built on `AuthFields`) in the Import dialog
and in the REST update chooser.

**Tech Stack:** TypeScript, zod 4, undici (`sendHttp`), Electron main + zod IPC channels, React 19, Zustand,
Vitest (node and jsdom), Playwright e2e.

Gate before each commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
Make one commit per task.

## Global Constraints

- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit (the gate line above is that command with
  more heap and a lower priority). One commit per task.
- Renderer modules import only **types** from `apps/desktop/src/shared/wire-types.ts` (`import type …`). An
  eager value import pulls zod into the renderer bundle and breaks every e2e spec through the CSP eval probe.
- Never launch Electron e2e locally. Typecheck the e2e files (`pnpm exec tsc --noEmit -p e2e/tsconfig.json`)
  and let CI run them.
- Never name the product that inspired a feature, in code, tests, docs or commit messages;
  `pnpm check:banned-terms` enforces it.
- Commits are made as **Mohammed Naami <m.naami@outlook.com>** (already the worktree's `user.name` /
  `user.email`). No `Co-Authored-By:` and no `Claude-Session:` trailer.
- No new dependency and no `formatVersion` bump (it stays 5; spec D1 *Format*).
- Secrets are references only, everywhere: `passwordRef`, `tokenRef`, `valueRef`. A plaintext `password`,
  `token`, `apiKey` or `value` is refused on load and over IPC.
- Credentials go only to the origin of the URL the user gave. A redirect or a `$ref` to another origin is
  fetched without them, and a query key never appears in a returned location, a progress message or an error.
- A 401 or 403 is `HttpError('definition-auth-required')` with `details: { location, status, authSent }` and the
  messages `The definition at <url> needs authentication (HTTP <status>).` (nothing sent) and
  `The definition at <url> refused the credentials given (HTTP <status>).` (credentials sent). Any other non-2xx
  stays `fetch-failed`.
- WSDL keeps `withBasicAuth` and its own *Use Basic auth* field; nothing here touches it. OAuth2, NTLM,
  client certificates and *trust invalid certificate* are out of scope for a definition fetch.
- In this worktree, three desktop files (`workspace-service`, `workspace-share`, `workspace-share-server`) can
  fail to load with "Electron failed to install correctly". That is the local Electron install, not this change;
  repair the install as the message says before running the gate, and never skip a failing file.

## Rulings on the spec

These close gaps the spec leaves open. Each is implemented and tested below.

1. The fetcher's tests live in `packages/engine/test/integration/http/document-fetch.test.ts`, not under
   `test/unit/`: every engine test that starts `startTestRestServer` is in the `engine-integration` project.
2. The Basic arm of `definitionAuthSchema` is `refuseSecretValues(endpointAuthSchema)` refined to `basic`, not
   the bare `endpointAuthSchema`: that one only refuses `password`, so a `token` or `apiKey` beside
   `type: basic` would have been ignored instead of refused.
3. `type: none` and `type: inherit` are refused in a file as well: the union has no arm for them. "No
   credentials" is the absence of `auth`.
4. The success-criteria rows are **SC-D1–SC-D8**. `docs/success-criteria.md` already uses SC-A1–SC-A6 for the
   AsyncAPI import; each row names the spec's SC-A number it proves.
5. The API wire's `definition.auth` (what main answers with) uses the loose `authConfigWireSchema`; only requests
   use the strict `definitionAuthWireSchema`. A file may hold a `…Env` name, which the strict schema would refuse
   and fail the whole response as `ipc-invalid-response`.
6. `ProjectHost.restSource` and `asyncApiSource` return `{ source, auth? }` instead of two new router methods.
   `ProjectRouter` and `WorkspaceService` forward them by `ReturnType`, so neither file changes.
7. `OpenApiImportService` takes `{ getSecret?, network?, createFetchDocument? }`. The old `fetchDocument`
   option goes; its one user, `apps/desktop/test/ipc-asyncapi.test.ts`, moves to `createFetchDocument`.
8. A definition's Basic is always preemptive: a 401 is refused as `definition-auth-required`, not answered as a
   challenge. The section therefore has no *preemptive* box (`AuthFields` gains `preemptiveOption`), and the
   wire's Basic arm has no `preemptive` field.
9. `AuthFields` always offers *Not configured*. In the definition section choosing it snaps back to **None**, so
   the two never mean different things. **None**, or a scheme whose secret was never entered, sends no `auth`.
10. `definition-auth-required` opens the REST chooser only while the recorded source was being read. A chosen URL
    that answers it keeps the chooser as it is and shows the message.
11. The fetcher strips its query key from every hop URL, including a redirect `Location` that echoes it, before
    deciding what to send. A server that echoes the key into a cross-origin redirect cannot carry it there.
12. A transport failure on a hop that carried a query key is thrown again as an `HttpError` with the same code, the
    URL masked in its message by `redactUrl`, `details: { location }` without the key, and no `cause`.
13. When the caller's signal is aborted, the fetcher throws `signal.reason` (an `AbortError`), as the global-fetch
    fetcher did, so a cancelled `$ref` stops the walk instead of being recorded as a reference problem.
14. The chooser's stored credentials follow the URL's origin: moving the URL onto the recorded origin offers them,
    moving it off resets to **None**. An edit made to the section is replaced when the URL crosses that line.
15. `readAsyncApiSource` sends the stored credentials only when the recorded source is a URL, as the REST read
    does.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/project/model.ts` | `DefinitionAuth` |
| `packages/engine/src/rest/model.ts`, `packages/engine/src/ws/model.ts` | `auth?: DefinitionAuth` on the definition refs |
| `packages/engine/src/project/schema.ts` | `definitionAuthSchema`; `auth` on both `definition` schemas |
| `packages/engine/src/project/load.ts`, `packages/engine/src/project/serialize.ts` | load and write `definition.auth` |
| `packages/engine/src/http/document-fetch.ts` (new) | `createHttpFetchDocument`, `DocumentFetchOptions` |
| `packages/engine/src/wsdl/fetch.ts` | export `decodeXmlBytes` |
| `packages/engine/src/index.ts` | the new exports |
| `packages/engine/test/helpers/test-rest-server.ts` | `TestRestServerDocument.auth` |
| `apps/desktop/src/main/openapi-import.ts` | options object, per-read fetcher, `auth` on every read |
| `apps/desktop/src/main/index.ts` | `getSecret` and `network` wiring |
| `apps/desktop/src/shared/wire-types.ts` | `definitionAuthWireSchema`; `auth` on the import requests, the REST update source and the API wire |
| `apps/desktop/src/main/ipc/api.ts` | `toDefinitionAuth`; auth through import, server preview and Update Definition; TODO removed |
| `apps/desktop/src/main/project-host.ts` | record `auth` on import; `restSource`/`asyncApiSource` return it; `applyRestUpdate` replaces or keeps it |
| `apps/desktop/src/main/project-wire.ts` | `definition.auth` on the API wire |
| `apps/desktop/src/renderer/components/auth-fields.tsx` | `preemptiveOption`, `registerFlush` |
| `apps/desktop/src/renderer/components/definition-auth.tsx` (new) | `DefinitionAuthFields` and its helpers |
| `apps/desktop/src/renderer/features/explorer/import-dialog.tsx` | the Authentication section |
| `apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx` | the section in the chooser; `definition-auth-required` |
| tests, e2e, docs | as listed per task |

---

## Task 1: `DefinitionAuth` in the model and the format

**Files:**
- Modify: `packages/engine/src/project/model.ts:141` (after `SoapOwnerAuth`)
- Modify: `packages/engine/src/rest/model.ts:16` (import), `:227-234` (`RestDefinitionRef`)
- Modify: `packages/engine/src/ws/model.ts:18` (import), `:103-110` (`WsDefinitionRef`)
- Modify: `packages/engine/src/project/schema.ts:152` (after `soapOwnerAuthSchema`), `:402-404`
  (`apiFileSchema.definition`), `:521-529` (`wsApiFileSchema.definition`)
- Modify: `packages/engine/src/project/load.ts:15-28` (imports), `:289` (helper), `:672`, `:708`
- Modify: `packages/engine/src/project/serialize.ts:11`, `:13` (imports), `:66` (helper), `:351`, `:408`
- Modify: `packages/engine/src/index.ts:313`, `:616`
- Test: `packages/engine/test/unit/project/schema.test.ts`, `packages/engine/test/unit/project/rest-format.test.ts`,
  `packages/engine/test/unit/project/ws-format.test.ts`

**Interfaces:**
- Consumes: `EndpointAuth`, `BearerAuth`, `ApiKeyAuth` (`project/model.ts`); `endpointAuthSchema`,
  `bearerAuthSchema`, `apiKeyAuthSchema`, `refuseSecretValues` (`project/schema.ts`); `authConfig` (`load.ts:269`),
  `authDocument` (`serialize.ts:59`).
- Produces:
  - `export type DefinitionAuth = (EndpointAuth & { readonly type: 'basic' }) | BearerAuth | ApiKeyAuth;`
    exported from `@wirebench/engine`.
  - `RestDefinitionRef.auth?: DefinitionAuth` and `WsDefinitionRef.auth?: DefinitionAuth`.
  - `export const definitionAuthSchema` (exported from `@wirebench/engine`); `apiFileSchema.definition.auth` and
    `wsApiFileSchema.definition.auth`.

- [ ] **Step 1: Write the failing tests**

In `packages/engine/test/unit/project/schema.test.ts`, add `apiFileSchema,` before `environmentFileSchema,` and
`wsApiFileSchema,` after `wssIncomingFileSchema,` in the `../../../src/project/schema.js` import. Then insert
before `describe('extension-point schemas', () => {` (`:234`):

```ts
describe("a definition's fetch credentials", () => {
  const restApi = (auth: unknown) => ({
    kind: 'rest',
    id: 'A',
    name: 'Pets',
    order: 0,
    baseUrl: 'https://api.test',
    definition: { source: 'https://gateway.test/openapi.yaml', cache: true, version: '3.1.0', auth },
  });
  const wsApi = (auth: unknown) => ({
    kind: 'websocket',
    id: 'W',
    name: 'Chat',
    order: 0,
    url: 'wss://chat.test',
    definition: { kind: 'asyncapi', source: 'https://gateway.test/asyncapi.yaml', cache: true, auth },
  });
  const sites = [
    ['a REST API', (auth: unknown) => parseFile(apiFileSchema, restApi(auth), 'api.yaml').definition?.auth],
    ['a WebSocket API', (auth: unknown) => parseFile(wsApiFileSchema, wsApi(auth), 'api.yaml').definition?.auth],
  ] as const;

  const accepted = [
    ['basic', { type: 'basic', username: 'ada', passwordRef: 'ref-p' }],
    ['bearer', { type: 'bearer', tokenRef: 'ref-t', scheme: 'Token' }],
    ['api-key in a header', { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'ref-v' }],
    ['api-key in the query', { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' }],
  ] as const;

  const refused = [
    ['a plaintext password', { type: 'basic', username: 'ada', password: 'hunter2' }],
    ['a plaintext token beside Basic', { type: 'basic', username: 'ada', token: 'abc' }],
    ['a plaintext token', { type: 'bearer', token: 'abc' }],
    ['a plaintext apiKey', { type: 'api-key', name: 'X-Api-Key', in: 'header', apiKey: 'k' }],
    ['NTLM', { type: 'ntlm', username: 'ada', passwordRef: 'ref-p' }],
    ['OAuth2', { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t.test', clientId: 'c' }],
    ['none', { type: 'none' }],
    ['inherit', { type: 'inherit' }],
  ] as const;

  for (const [siteLabel, parse] of sites) {
    it.each(accepted)(`accepts %s on ${siteLabel}`, (_label, auth) => {
      expect(parse(auth)).toMatchObject(auth);
    });

    it.each(refused)(`refuses %s on ${siteLabel}`, (_label, auth) => {
      expect(() => parse(auth)).toThrow(ProjectError);
    });

    it(`leaves ${siteLabel} without auth as it was`, () => {
      expect(parse(undefined)).toBeUndefined();
    });
  }
});

```

In `packages/engine/test/unit/project/rest-format.test.ts`, change the model import (`:21`) to
`import type { DefinitionAuth, Project } from '../../../src/project/model.js';` and insert before
`describe('a kind this build does not support', () => {` (`:412`):

```ts
describe("a definition's fetch credentials", () => {
  const withAuth = (auth: DefinitionAuth): Project => {
    const project = apiProject();
    const [first, ...rest] = project.apis;
    return {
      ...project,
      apis: [
        { ...first!, definition: { source: 'https://gateway.test/openapi.yaml', cache: true, version: '3.1.0', auth } },
        ...rest,
      ],
    };
  };

  it.each([
    ['basic', { type: 'basic', username: 'ada', passwordRef: 'ref-p' }],
    ['bearer', { type: 'bearer', tokenRef: 'ref-t' }],
    ['api-key', { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' }],
  ] as const)('round-trips %s auth as references, byte-stably', async (_label, auth) => {
    const dir = await tempProjectDir();
    const project = withAuth(auth);
    await saveProject(project, dir);

    const yaml = await readFile(join(dir, APIS_DIR, 'Petstore', 'api.yaml'), 'utf8');
    expect(yaml).toContain('  auth:\n');
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.apis[0]?.definition).toEqual(project.apis[0]?.definition);
    const again = await saveProject(loaded, dir);
    expect(again.written).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a plaintext password in a definition on load', async () => {
    const dir = await tempProjectDir();
    await saveProject(withAuth({ type: 'basic', username: 'ada', passwordRef: 'ref-p' }), dir);
    const file = join(dir, APIS_DIR, 'Petstore', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('passwordRef: ref-p', 'password: hunter2'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;

    expect(error).toBeInstanceOf(ProjectError);
    expect(error.code).toBe('project-file-invalid');
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a definition written without auth exactly as before', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);

    const { project: loaded } = await loadProject(dir);
    expect(loaded.apis[0]?.definition).toEqual({
      source: 'https://petstore.test/openapi.json',
      cache: true,
      version: '3.0.4',
    });
    await rm(dir, { recursive: true, force: true });
  });
});

```

Append to `packages/engine/test/unit/project/ws-format.test.ts`:

```ts
describe("an AsyncAPI definition's fetch credentials", () => {
  it('round-trips them as references, and a file without them loads without', async () => {
    const auth = { type: 'bearer' as const, tokenRef: 'ref-t' };
    const project = {
      ...emptyProject(),
      wsApis: [
        {
          ...createWsApi('Chat', { id: 'a1', url: 'wss://x.test' }),
          definition: { kind: 'asyncapi' as const, source: 'https://gateway.test/a.yaml', cache: true, auth },
        },
      ],
    };
    const files = serializeProject(project);
    expect(files.get('apis/Chat/api.yaml')).toContain('tokenRef: ref-t\n');
    const reloaded = await loadFrom(files);
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.project.wsApis[0]?.definition).toEqual({
      kind: 'asyncapi',
      source: 'https://gateway.test/a.yaml',
      cache: true,
      auth,
    });
    expect(serializeProject(reloaded.project)).toEqual(files);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/schema.test.ts packages/engine/test/unit/project/rest-format.test.ts packages/engine/test/unit/project/ws-format.test.ts`
Expected: FAIL. The `refuses …` cases pass `auth` through the loose `definition` object untouched, so
`toThrow(ProjectError)` fails; the round trips lose `definition.auth` on load.

- [ ] **Step 3: Add the model type**

In `packages/engine/src/project/model.ts`, after `export type SoapOwnerAuth = Exclude<AuthConfig, InheritAuth>;`
(`:141`):

```ts

/**
 * How a definition document is fetched: Basic, a bearer token or an API key. Secrets are keychain
 * references, as everywhere else. Separate from the API's own `auth`, which is what its requests send.
 */
export type DefinitionAuth = (EndpointAuth & { readonly type: 'basic' }) | BearerAuth | ApiKeyAuth;
```

In `packages/engine/src/rest/model.ts`, change the model import (`:16`) to
`import type { AttachmentSource, AuthConfig, CreateOptions, DefinitionAuth, IdGenerator } from '../project/model.js';`
and replace `RestDefinitionRef` (`:226-234`) with:

```ts
/** The definition an imported API came from, cached under `apis/<slug>/definition/`. */
export interface RestDefinitionRef {
  /** Where the document was fetched from: a URL, or a path as the user gave it. */
  readonly source: string;
  readonly cache: boolean;
  /** The OpenAPI version of the document, as it declared itself (e.g. `3.1.0`). */
  readonly version: string;
  /** Credentials the document is fetched with, sent to the source's own origin only. */
  readonly auth?: DefinitionAuth;
}
```

In `packages/engine/src/ws/model.ts`, change the model import (`:18`) to
`import type { AuthConfig, CreateOptions, DefinitionAuth, IdGenerator } from '../project/model.js';` and replace
`WsDefinitionRef` (`:102-110`) with:

```ts
/** Where an AsyncAPI-imported API's contract came from, and whether a copy is cached under `definition/`. */
export interface WsDefinitionRef {
  readonly kind: 'asyncapi';
  readonly source: string;
  readonly cache: boolean;
  /** The server key the API was mapped against, so an update maps the new document against the same one.
   *  Absent means the first WebSocket server. */
  readonly server?: string;
  /** Credentials the document is fetched with, sent to the source's own origin only. */
  readonly auth?: DefinitionAuth;
}
```

- [ ] **Step 4: Add the schema**

In `packages/engine/src/project/schema.ts`, after `soapOwnerAuthSchema` (`:152`):

```ts

/**
 * A definition's fetch credentials: Basic, Bearer or API key, each as references only. The Basic arm
 * takes the full plaintext-key rejection too, not only `endpointAuthSchema`'s `password`, so a `token`
 * or `apiKey` written beside `type: basic` is refused rather than ignored.
 */
export const definitionAuthSchema = z.union([
  refuseSecretValues(endpointAuthSchema).refine((auth) => auth.type === 'basic', {
    message: 'a definition supports Basic, not NTLM',
  }),
  bearerAuthSchema,
  apiKeyAuthSchema,
]);
```

In `apiFileSchema` (`:402-404`) replace:

```ts
  definition: z
    .looseObject({ source: nonEmpty, cache: z.boolean().default(true), version: z.string().default('') })
    .optional(),
```

with:

```ts
  definition: z
    .looseObject({
      source: nonEmpty,
      cache: z.boolean().default(true),
      version: z.string().default(''),
      auth: definitionAuthSchema.optional(),
    })
    .optional(),
```

In `wsApiFileSchema.definition`, after `server: z.string().optional(),` (`:526`) add:

```ts
      auth: definitionAuthSchema.optional(),
```

- [ ] **Step 5: Load and write it**

In `packages/engine/src/project/load.ts`, add `DefinitionAuth,` after `AuthConfig,` in the `./model.js` type import
(`:17`). Insert before `/** A table row as loaded: …` (`:290`):

```ts
/**
 * A definition's fetch credentials as loaded, through {@link authConfig}. `definitionAuthSchema` has
 * already refused every scheme but Basic, Bearer and API key, so the narrowing cast only restates
 * what parsing proved.
 */
function definitionAuth(parsed: Record<string, unknown> | undefined): DefinitionAuth | undefined {
  return parsed === undefined ? undefined : (authConfig(parsed) as unknown as DefinitionAuth);
}

```

In the WebSocket branch, after `...optional('server', parsed.definition.server),` (`:672`), and in the REST branch,
after `version: parsed.definition.version,` (`:708`), add:

```ts
                  ...optional('auth', definitionAuth(parsed.definition.auth)),
```

In `packages/engine/src/project/serialize.ts`, change the imports at `:11` and `:13` to:

```ts
import type { KeyValueEntry, RestApi, RestBody, RestDefinitionRef, RestRequestDef } from '../rest/model.js';
```

```ts
import type { WsApi, WsDefinitionRef, WsRequestDef } from '../ws/model.js';
```

Insert before `function requestDocument(` (`:66`):

```ts
/**
 * A REST or AsyncAPI definition record as written: its own fields, with the fetch credentials in
 * the schema's spelling through {@link authDocument} — references only, like every other auth.
 */
function definitionDocument(definition: RestDefinitionRef | WsDefinitionRef): Record<string, unknown> {
  return compact({ ...definition, auth: definition.auth === undefined ? undefined : authDocument(definition.auth) });
}

```

and in both `addRestApiFiles` (`:351`) and `addWsApiFiles` (`:408`) replace
`definition: api.definition === undefined ? undefined : compact({ ...api.definition }),` with:

```ts
        definition: api.definition === undefined ? undefined : definitionDocument(api.definition),
```

In `packages/engine/src/index.ts`, add `DefinitionAuth,` after `CreateRequestInput,` (`:313`) and
`definitionAuthSchema,` before `definitionCacheManifestSchema,` (`:616`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS, every existing project test included (a file without `definition.auth` loads unchanged).

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/model.ts packages/engine/src/rest/model.ts packages/engine/src/ws/model.ts \
  packages/engine/src/project/schema.ts packages/engine/src/project/load.ts packages/engine/src/project/serialize.ts \
  packages/engine/src/index.ts packages/engine/test/unit/project/schema.test.ts \
  packages/engine/test/unit/project/rest-format.test.ts packages/engine/test/unit/project/ws-format.test.ts
git commit -m "feat(format): a definition's fetch credentials, as references (#135)

REST and AsyncAPI definitions gain an optional auth of kind Basic, Bearer or API key, built from the
existing auth arms so their plaintext refusal comes with them; the Basic arm refuses every plaintext
key, not only password. Load and save carry it through authConfig and authDocument. A file without it
loads as before, so formatVersion stays 5."
```

---

## Task 2: the document fetcher

**Files:**
- Create: `packages/engine/src/http/document-fetch.ts`
- Modify: `packages/engine/src/wsdl/fetch.ts:17` (export `decodeXmlBytes`)
- Modify: `packages/engine/src/index.ts:91` (exports)
- Modify: `packages/engine/test/helpers/test-rest-server.ts:58` (`TestRestServerDocument.auth`), `:200` (helper),
  `:211-213` (the documents branch)
- Test: `packages/engine/test/integration/http/document-fetch.test.ts` (new)

**Interfaces:**
- Consumes: `sendHttp` (`http/client.ts:333`), `basicAuthorization` (`http/auth/basic.ts:21`), `applyAuth`
  (`rest/auth.ts:61`), `redactUrl` (`redact/index.ts:98`), `createDefaultFetchDocument` (`wsdl/fetch.ts:59`),
  `SendAuth` (`types.ts:111`), `FetchDocument` (`wsdl/resolver.ts:25`).
- Produces:
  - `export interface DocumentFetchOptions { readonly auth?: SendAuth; readonly authOrigin?: string; readonly network?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }> }`
  - `export function createHttpFetchDocument(options?: DocumentFetchOptions): FetchDocument`, both exported from
    `@wirebench/engine`.
  - `export function decodeXmlBytes(bytes: Uint8Array): string` in `wsdl/fetch.ts` (not re-exported).
  - `TestRestServerDocument.auth?: 'basic' | 'bearer' | 'api-key'`, which the e2e spec in Task 8 uses.

- [ ] **Step 1: Teach the test server to protect a document**

In `packages/engine/test/helpers/test-rest-server.ts`, add to `TestRestServerDocument` after `contentType` (`:58`):

```ts
  /**
   * Serve it only with the credential `/auth/basic`, `/auth/bearer` or `/auth/apikey` accepts: a
   * 401 (Basic, Bearer) or a 403 (API key) otherwise, as those routes answer.
   */
  readonly auth?: 'basic' | 'bearer' | 'api-key';
```

Insert before `const handler = (request: IncomingMessage, response: ServerResponse): void => {` (`:200`):

```ts
  /** The status a request without `kind`'s accepted credential gets, or `undefined` when it has it. */
  const refusalFor = (kind: 'basic' | 'bearer' | 'api-key', request: IncomingMessage, url: URL): number | undefined => {
    if (kind === 'basic') {
      const expected = `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString('base64')}`;
      return request.headers.authorization === expected ? undefined : 401;
    }
    if (kind === 'bearer') {
      const [scheme, token] = (request.headers.authorization ?? '').split(' ');
      return scheme === 'Bearer' && token === bearerToken ? undefined : 401;
    }
    return request.headers['x-api-key'] === apiKey || url.searchParams.get('api_key') === apiKey ? undefined : 403;
  };

```

and at the top of the documents branch, right after `if (document !== undefined) {` (`:212`):

```ts
        const refused = document.auth === undefined ? undefined : refusalFor(document.auth, request, url);
        if (refused !== undefined) {
          response.writeHead(refused, { 'content-length': '0' });
          response.end();
          return;
        }
```

- [ ] **Step 2: Write the failing test**

Create `packages/engine/test/integration/http/document-fetch.test.ts`:

```ts
/**
 * The OpenAPI and AsyncAPI document fetcher, against the in-process REST server: each credential
 * kind reads a protected document; a missing or wrong one is `definition-auth-required`; credentials
 * never leave the document's own origin, by redirect or by `$ref`; a query key never shows in a
 * location or an error; and the host's proxy and CA bundle are used.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { createHttpFetchDocument } from '../../../src/http/document-fetch.js';
import { parseOpenApi } from '../../../src/rest/openapi/import.js';
import type { SendAuth } from '../../../src/types.js';
import { generateServerCert, generateTestCa, type TestCertificate } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import {
  startTestRestServer,
  type TestRestServer,
  type TestRestServerDocument,
  type TestRestServerOptions,
} from '../../helpers/test-rest-server.js';

const BASIC: SendAuth = { type: 'basic', username: 'u', password: 'p', preemptive: true };
const BEARER: SendAuth = { type: 'bearer', token: 'good-token' };
const HEADER_KEY: SendAuth = { type: 'api-key', name: 'X-Api-Key', value: 'good-key', in: 'header' };
const QUERY_KEY: SendAuth = { type: 'api-key', name: 'api_key', value: 'good-key', in: 'query' };

const DOCUMENT = 'openapi: 3.0.3\n';

const servers: TestRestServer[] = [];
const proxies: TestProxy[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function start(
  documents: Record<string, TestRestServerDocument> = {},
  options: Omit<TestRestServerOptions, 'documents'> = {},
): Promise<TestRestServer> {
  const server = await startTestRestServer({ ...options, documents });
  servers.push(server);
  return server;
}

/** What `run` threw, as an `HttpError`, or a failure when it did not throw one. */
async function thrown(run: () => Promise<unknown>): Promise<HttpError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

/** The last request `server` recorded. */
function last(server: TestRestServer) {
  const request = server.requests.at(-1);
  if (request === undefined) throw new Error('the server recorded no request');
  return request;
}

describe('createHttpFetchDocument', () => {
  it.each([
    ['basic', 'basic', BASIC],
    ['bearer', 'bearer', BEARER],
    ['a header API key', 'api-key', HEADER_KEY],
    ['a query API key', 'api-key', QUERY_KEY],
  ] as const)('reads a document protected by %s', async (_label, kind, auth) => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: kind } });
    const url = `${server.url}/openapi.yaml`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: new URL(url).origin })(url);

    expect(fetched.text).toBe(DOCUMENT);
    // The key this fetcher added is not part of where the document lives.
    expect(fetched.location).toBe(url);
  });

  it('says a document needs authentication when none was sent', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'basic' } });
    const url = `${server.url}/openapi.yaml`;

    const error = await thrown(() => createHttpFetchDocument()(url));

    expect(error.code).toBe('definition-auth-required');
    expect(error.message).toBe(`The definition at ${url} needs authentication (HTTP 401).`);
    expect(error.details).toEqual({ location: url, status: 401, authSent: false });
  });

  it('says the credentials were refused when wrong ones were sent', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'api-key' } });
    const url = `${server.url}/openapi.yaml`;
    const wrong: SendAuth = { ...QUERY_KEY, value: 'bad-key' };

    const error = await thrown(() => createHttpFetchDocument({ auth: wrong, authOrigin: new URL(url).origin })(url));

    expect(error.code).toBe('definition-auth-required');
    expect(error.message).toBe(`The definition at ${url} refused the credentials given (HTTP 403).`);
    expect(error.details).toEqual({ location: url, status: 403, authSent: true });
    expect(error.message).not.toContain('bad-key');
  });

  it('keeps any other failure a fetch failure', async () => {
    const server = await start();
    const url = `${server.url}/status/404`;

    const error = await thrown(() => createHttpFetchDocument()(url));

    expect(error.code).toBe('fetch-failed');
    expect(error.details).toEqual({ location: url, status: 404 });
  });

  it.each([
    ['basic', BASIC],
    ['a header API key', HEADER_KEY],
    ['a query API key', QUERY_KEY],
  ] as const)('drops %s at a redirect to another origin', async (_label, auth) => {
    const other = await start({ '/openapi.yaml': { body: DOCUMENT } });
    const server = await start({}, { redirectOrigins: [other.url] });
    const url = `${server.url}/redirect/302?to=${encodeURIComponent(`${other.url}/openapi.yaml`)}`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: server.url })(url);

    expect(fetched.location).toBe(`${other.url}/openapi.yaml`);
    const reached = last(other);
    expect(reached.headers.authorization).toBeUndefined();
    expect(reached.headers['x-api-key']).toBeUndefined();
    expect(reached.url).not.toContain('api_key');
  });

  it.each([
    ['basic', 'basic', BASIC],
    ['a query API key', 'api-key', QUERY_KEY],
  ] as const)('keeps %s across a redirect on the same origin', async (_label, kind, auth) => {
    const server = await start({ '/moved.yaml': { body: DOCUMENT, auth: kind } });
    const url = `${server.url}/redirect/301?to=/moved.yaml`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: server.url })(url);

    expect(fetched.text).toBe(DOCUMENT);
    expect(fetched.location).toBe(`${server.url}/moved.yaml`);
  });

  it('sends credentials to a $ref sibling on the same origin, and not to one on another', async () => {
    const other = await start({ '/pet.yaml': { body: 'type: object\n' } });
    const documents: Record<string, TestRestServerDocument> = {};
    const server = await start(documents);
    documents['/common.yaml'] = { body: 'type: string\n', auth: 'basic' };
    documents['/openapi.yaml'] = {
      auth: 'basic',
      body: [
        'openapi: 3.0.3',
        'info: { title: Pets, version: "1" }',
        'paths: {}',
        'components:',
        '  schemas:',
        '    Name:',
        `      $ref: '${server.url}/common.yaml'`,
        '    Pet:',
        `      $ref: '${other.url}/pet.yaml'`,
        '',
      ].join('\n'),
    };
    const fetchDocument = createHttpFetchDocument({ auth: BASIC, authOrigin: server.url });

    const parsed = await parseOpenApi({ kind: 'url', url: `${server.url}/openapi.yaml` }, { fetchDocument });

    expect(parsed.refProblems).toEqual([]);
    expect(parsed.documents.map((document) => document.location).sort()).toEqual(
      [`${server.url}/openapi.yaml`, `${server.url}/common.yaml`, `${other.url}/pet.yaml`].sort(),
    );
    expect(last(other).headers.authorization).toBeUndefined();
  });

  it('never shows a query key in the location or in an error', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'api-key' } });
    const origin = server.url;
    const fetchDocument = createHttpFetchDocument({ auth: QUERY_KEY, authOrigin: origin });

    const fetched = await fetchDocument(`${origin}/openapi.yaml`);
    expect(fetched.location).not.toContain('good-key');
    expect(last(server).url).toContain('api_key=good-key');

    const missing = await thrown(() => fetchDocument(`${origin}/status/500`));
    expect(missing.message).not.toContain('good-key');
    expect(JSON.stringify(missing.details)).not.toContain('good-key');

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const refused = await thrown(() => fetchDocument(`${origin}/openapi.yaml`));
    expect(refused.message).not.toContain('good-key');
    expect(JSON.stringify(refused.details)).not.toContain('good-key');
  });

  it('reads a file: location as the default fetcher does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-document-fetch-'));
    const path = join(dir, 'openapi.yaml');
    await writeFile(path, DOCUMENT);

    const fetched = await createHttpFetchDocument({ auth: BASIC, authOrigin: 'http://127.0.0.1' })(
      pathToFileURL(path).href,
    );

    expect(fetched.text).toBe(DOCUMENT);
    await rm(dir, { recursive: true, force: true });
  });

  it('goes through the proxy the host resolved for the URL', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT } });
    const proxy = await startTestProxy();
    proxies.push(proxy);
    const url = `${server.url}/openapi.yaml`;
    const asked: string[] = [];

    await createHttpFetchDocument({
      network: (target) => {
        asked.push(target);
        return Promise.resolve({ proxy: { url: proxy.url } });
      },
    })(url);

    expect(asked).toEqual([url]);
    expect(proxy.requests.map((request) => request.target)).toEqual([url]);
  });

  describe('over TLS', () => {
    let ca: TestCertificate;
    let cert: TestCertificate;

    beforeAll(() => {
      ca = generateTestCa();
      cert = generateServerCert(ca);
    });

    it('trusts a server signed by the CA bundle the host resolved, and nothing else', async () => {
      const server = await start(
        { '/openapi.yaml': { body: DOCUMENT } },
        { tls: { cert: cert.certPem, key: cert.keyPem } },
      );
      const url = `${server.url}/openapi.yaml`;

      const untrusted = await thrown(() => createHttpFetchDocument()(url));
      expect(untrusted.code).toBe('tls-untrusted');

      const fetched = await createHttpFetchDocument({ network: () => Promise.resolve({ tls: { ca: [ca.certPem] } }) })(
        url,
      );
      expect(fetched.text).toBe(DOCUMENT);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/http/document-fetch.test.ts`
Expected: FAIL with `Cannot find module '../../../src/http/document-fetch.js'`.

- [ ] **Step 4: Write the fetcher**

In `packages/engine/src/wsdl/fetch.ts:17`, change `function decodeXmlBytes(` to `export function decodeXmlBytes(`.

Create `packages/engine/src/http/document-fetch.ts`:

```ts
/**
 * The fetcher every OpenAPI and AsyncAPI read goes through.
 *
 * It sends through the engine's own HTTP client rather than the global `fetch`, so the proxy and CA
 * bundle the host resolves apply to a definition as they do to a request. It follows redirects
 * itself: `sendHttp` scopes only the three standard credential headers to an origin, and a
 * definition's credentials may also be a custom API-key header or a query key. On every hop, and for
 * every `$ref` document, credentials go only to the origin of the document the user named.
 */

import { HttpError, WirebenchError } from '../errors.js';
import { redactUrl } from '../redact/index.js';
import { applyAuth } from '../rest/auth.js';
import type { SendAuth } from '../types.js';
import { createDefaultFetchDocument, decodeXmlBytes } from '../wsdl/fetch.js';
import type { FetchDocument, FetchedDocument } from '../wsdl/resolver.js';
import { basicAuthorization } from './auth/basic.js';
import { sendHttp } from './client.js';
import type { ProxyOptions, TlsOptions } from './types.js';

const TIMEOUT_MS = 20_000;
const USER_AGENT = 'wirebench/0.1';
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** How {@link createHttpFetchDocument} reaches the network, and with what credentials. */
export interface DocumentFetchOptions {
  /** Resolved credentials: values, not references. Sent only to `authOrigin`. */
  readonly auth?: SendAuth;
  /** Origin of the document the user named; absent means no auth is ever attached. */
  readonly authOrigin?: string;
  /** TLS and proxy for one URL, as the host resolves them. */
  readonly network?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
}

/** `url` without the query parameter `name`; `url` itself, unparsed and unchanged, when it has none. */
function withoutParam(url: string, name: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has(name)) {
    return url;
  }
  parsed.searchParams.delete(name);
  return parsed.toString();
}

/** What one hop sends: its URL (with a query key, on the auth origin) and its credential headers. */
function credentialsFor(
  url: string,
  options: DocumentFetchOptions,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  const { auth, authOrigin } = options;
  if (auth === undefined || authOrigin === undefined || new URL(url).origin !== authOrigin) {
    return { url, headers: {} };
  }
  if (auth.type === 'basic') {
    // Always preemptive: a definition endpoint that answers 401 is refused, not challenged through.
    return { url, headers: { Authorization: basicAuthorization(auth.username, auth.password) } };
  }
  if (auth.type === 'api-key' && auth.in === 'query') {
    const keyed = new URL(url);
    keyed.searchParams.append(auth.name, auth.value);
    return { url: keyed.toString(), headers: {} };
  }
  return { url, headers: applyAuth(auth).headers };
}

/**
 * A transport failure on a hop that carried a query key, told without the key: the URL in its text is
 * masked, and its details name the location without the key.
 */
function maskedFailure(error: unknown, sent: string, bare: string, keyName: string): unknown {
  if (!(error instanceof WirebenchError)) {
    return error;
  }
  const masked = redactUrl(sent, { extraParams: [keyName] });
  return new HttpError(error.code, error.message.split(sent).join(masked), { details: { location: bare } });
}

async function fetchHttp(
  location: string,
  signal: AbortSignal | undefined,
  options: DocumentFetchOptions,
): Promise<FetchedDocument> {
  const keyName = options.auth?.type === 'api-key' && options.auth.in === 'query' ? options.auth.name : undefined;
  // `bare` is the hop's URL as the resolver may see it: never with the key this fetcher adds, even
  // when a server echoed it into a redirect's `Location`.
  let bare = keyName === undefined ? location : withoutParam(location, keyName);
  for (let hops = 0; ; hops += 1) {
    const { url, headers } = credentialsFor(bare, options);
    const credentialsSent = url !== bare || Object.keys(headers).length > 0;
    const network = (await options.network?.(bare)) ?? {};
    let exchange;
    try {
      exchange = await sendHttp({
        url,
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, ...headers },
        timeoutMs: TIMEOUT_MS,
        followRedirects: false,
        ...(signal !== undefined ? { signal } : {}),
        ...(network.tls !== undefined ? { tls: network.tls } : {}),
        ...(network.proxy !== undefined ? { proxy: network.proxy } : {}),
      });
    } catch (error) {
      // A cancel stays a cancel: the resolver tells an `AbortError` from a document that failed.
      signal?.throwIfAborted();
      throw keyName === undefined || url === bare ? error : maskedFailure(error, url, bare, keyName);
    }

    const target = exchange.headers['location'];
    if (REDIRECT_STATUSES.has(exchange.status) && target !== undefined) {
      if (hops >= MAX_REDIRECTS) {
        throw new HttpError(
          'too-many-redirects',
          `GET ${location} redirected more than ${String(MAX_REDIRECTS)} times`,
          {
            details: { location },
          },
        );
      }
      const next = new URL(target, bare).toString();
      bare = keyName === undefined ? next : withoutParam(next, keyName);
      continue;
    }
    if (exchange.status === 401 || exchange.status === 403) {
      const status = String(exchange.status);
      throw new HttpError(
        'definition-auth-required',
        credentialsSent
          ? `The definition at ${bare} refused the credentials given (HTTP ${status}).`
          : `The definition at ${bare} needs authentication (HTTP ${status}).`,
        { details: { location: bare, status: exchange.status, authSent: credentialsSent } },
      );
    }
    if (exchange.status < 200 || exchange.status >= 300) {
      throw new HttpError('fetch-failed', `GET ${bare} failed with status ${String(exchange.status)}`, {
        details: { location: bare, status: exchange.status },
      });
    }
    return { location: bare, bytes: exchange.body, text: decodeXmlBytes(exchange.body) };
  }
}

/**
 * Creates the {@link FetchDocument} for OpenAPI and AsyncAPI reads: `file:` (and any other non-HTTP
 * location) as {@link createDefaultFetchDocument} reads it, and `http(s):` through `sendHttp` with
 * the host's TLS and proxy, following up to 5 redirects, with `options.auth` sent only to
 * `options.authOrigin`.
 *
 * The returned `location` never carries a query key this fetcher added, so `$ref` resolution,
 * progress messages, errors and a recorded source never do either.
 *
 * @throws HttpError `definition-auth-required` for a 401 or 403 (`details.authSent` says whether
 * credentials went with it), `fetch-failed` for any other non-2xx, `too-many-redirects`, or a
 * transport error from `sendHttp`
 */
export function createHttpFetchDocument(options: DocumentFetchOptions = {}): FetchDocument {
  const fallback = createDefaultFetchDocument();
  return async (location, signal) => {
    if (!/^https?:\/\//i.test(location)) {
      return fallback(location, signal);
    }
    return fetchHttp(location, signal, options);
  };
}
```

In `packages/engine/src/index.ts`, after `export { createDefaultFetchDocument } from './wsdl/fetch.js';` (`:91`):

```ts
export { createHttpFetchDocument } from './http/document-fetch.js';
export type { DocumentFetchOptions } from './http/document-fetch.js';
```

- [ ] **Step 5: Run it to verify it passes**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/http/document-fetch.test.ts`
Expected: PASS (17 tests). As a check that the tests bite, deleting `|| new URL(url).origin !== authOrigin` from
`credentialsFor` makes the three cross-origin redirect cases and the `$ref` case fail; put it back.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/http/document-fetch.ts packages/engine/src/wsdl/fetch.ts packages/engine/src/index.ts \
  packages/engine/test/helpers/test-rest-server.ts packages/engine/test/integration/http/document-fetch.test.ts
git commit -m "feat(engine): fetch definitions through the HTTP client, credentials to their own origin (#135)

createHttpFetchDocument sends through sendHttp with the host's proxy and CA bundle and follows
redirects itself, attaching Basic, a bearer token or an API key only on hops to the origin the user
named: sendHttp only scopes the three standard credential headers. A query key never shows in a
returned location or an error, and a 401 or 403 is definition-auth-required."
```

---

## Task 3: main builds one fetcher per read, with the definition's credentials

**Files:**
- Modify: `apps/desktop/src/main/openapi-import.ts` (whole file: imports, inputs, constructor, the four reads, `track`)
- Modify: `apps/desktop/src/main/index.ts:192-193`
- Modify: `apps/desktop/test/ipc-asyncapi.test.ts:119` (the constructor option it used goes)
- Test: `apps/desktop/test/openapi-import.test.ts` (new)

**Interfaces:**
- Consumes: `createHttpFetchDocument`, `DocumentFetchOptions`, `DefinitionAuth` (Tasks 1–2); `resolveAuthConfig`
  and `GetSecret` (`packages/engine/src/secrets/resolve.ts:118`, `:21`); `mainHttpOptions(url, deps)`
  (`apps/desktop/src/main/network-options.ts:93`); `secretsFor(undefined)` (`index.ts:115`).
- Produces:
  - `export interface OpenApiImportServiceOptions { readonly getSecret?: GetSecret; readonly network?: DocumentFetchOptions['network']; readonly createFetchDocument?: (options: DocumentFetchOptions) => FetchDocument }`
  - `new OpenApiImportService(options?: OpenApiImportServiceOptions)`.
  - `RunOpenApiImportInput.auth?: DefinitionAuth`, `RunAsyncApiImportInput.auth?: DefinitionAuth`.
  - `readOpenApi(source: OpenApiSource, auth?: DefinitionAuth): Promise<ParsedOpenApi>` and
    `readAsyncApi(source: OpenApiSource, auth?: DefinitionAuth): Promise<ParsedAsyncApi>`.
  - A `url` source's `auth` is resolved with `resolveAuthConfig` before any fetch (`secret-missing` on a dangling
    reference) and handed to the fetcher with `authOrigin: new URL(source.url).origin`; any other source gets no
    credentials.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/openapi-import.test.ts`:

```ts
// @vitest-environment node
/**
 * `OpenApiImportService` builds one fetcher per read: a definition's auth is resolved from the
 * keychain first, so a dangling reference fails before any network, and only a `url` source's own
 * origin is given the credentials. The host's network options reach every fetcher.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocumentFetchOptions, FetchDocument } from '@wirebench/engine';
import { OpenApiImportService } from '../src/main/openapi-import.js';

const OPENAPI = `openapi: 3.0.3
info:
  title: Pets
  version: '1'
paths: {}
`;

const ASYNCAPI = `asyncapi: 3.0.0
info:
  title: Chat
  version: '1'
`;

/** A service whose fetchers serve `text` for any location, recording the options each was built with. */
function service(text: string, secrets: Record<string, string> = {}) {
  const built: DocumentFetchOptions[] = [];
  const fetched: string[] = [];
  const network = vi.fn(() => Promise.resolve({}));
  const imports = new OpenApiImportService({
    getSecret: (ref) => Promise.resolve(secrets[ref]),
    network,
    createFetchDocument: (options) => {
      built.push(options);
      const fetchDocument: FetchDocument = (location) => {
        fetched.push(location);
        return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
      };
      return fetchDocument;
    },
  });
  return { imports, built, fetched, network };
}

describe('OpenApiImportService', () => {
  it("resolves the auth and scopes it to the source URL's origin", async () => {
    const { imports, built } = service(OPENAPI, { 'ref-p': 's3cret' });

    await imports.readOpenApi(
      { kind: 'url', url: 'https://gateway.test:8443/billing/openapi.yaml' },
      { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
    );

    expect(built).toHaveLength(1);
    expect(built[0]?.auth).toEqual({ type: 'basic', username: 'ada', password: 's3cret', preemptive: true });
    expect(built[0]?.authOrigin).toBe('https://gateway.test:8443');
  });

  it("passes the host's network options to every fetcher", async () => {
    const { imports, built, network } = service(OPENAPI);

    await imports.readOpenApi({ kind: 'url', url: 'https://api.test/openapi.yaml' });

    expect(built[0]?.network).toBe(network);
    expect(built[0]?.auth).toBeUndefined();
  });

  it('fails as secret-missing before fetching anything when a reference has no value', async () => {
    const { imports, fetched } = service(OPENAPI);

    const error = await imports
      .run({
        source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
        auth: { type: 'bearer', tokenRef: 'gone' },
      })
      .catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe('secret-missing');
    expect(fetched).toEqual([]);
  });

  it('never gives a file or pasted text any credentials', async () => {
    const { imports, built } = service(OPENAPI, { 'ref-t': 'tok' });

    await imports.readOpenApi({ kind: 'text', text: OPENAPI }, { type: 'bearer', tokenRef: 'ref-t' });

    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
  });

  it('reads an AsyncAPI document with the same credentials', async () => {
    const { imports, built } = service(ASYNCAPI, { 'ref-v': 'good-key' });

    await imports.readAsyncApi(
      { kind: 'url', url: 'https://gateway.test/asyncapi.yaml' },
      { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' },
    );

    expect(built[0]?.auth).toEqual({ type: 'api-key', name: 'api_key', value: 'good-key', in: 'query' });
    expect(built[0]?.authOrigin).toBe('https://gateway.test');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/openapi-import.test.ts`
Expected: FAIL. The service ignores `createFetchDocument` and fetches through the default fetcher, which cannot
reach `gateway.test`; `readOpenApi` takes no `auth`.

- [ ] **Step 3: Rewrite the service**

Replace `apps/desktop/src/main/openapi-import.ts` with:

```ts
/**
 * Running an OpenAPI import in main, with progress and a cancel.
 *
 * The engine's `importOpenApi` is one `await` with no notion of a window or a user: this is the
 * host's half of it — the fetcher that actually reaches the network, the progress events the import
 * dialog draws, and the abort controller `api.cancelImport` fires. Nothing is written to disk here;
 * placing the API and caching its documents is the project's job (`project-host.ts`), which is what
 * makes a cancelled import trivially leave nothing behind.
 */

import {
  createHttpFetchDocument,
  importAsyncApi,
  importOpenApi,
  parseAsyncApi,
  parseOpenApi,
  resolveAuthConfig,
  WirebenchError,
} from '@wirebench/engine';
import type {
  DefinitionAuth,
  DocumentFetchOptions,
  FetchDocument,
  GetSecret,
  ImportedAsyncApi,
  ImportedOpenApi,
  OpenApiSource,
  ParsedAsyncApi,
  ParsedOpenApi,
} from '@wirebench/engine';
import type { EngineProgressEvent } from '../shared/wire-types.js';

/** What one import needs beyond where to read from. */
export interface RunOpenApiImportInput {
  readonly source: OpenApiSource;
  /** Echoed on every progress event, and what `cancel` names this import by. */
  readonly token?: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly securityScheme?: string;
  readonly includeOptional?: boolean;
  readonly sampleValues?: boolean;
  /** Credentials for a `url` source's own origin; ignored for a file or pasted text. */
  readonly auth?: DefinitionAuth;
}

/** What one AsyncAPI import needs: the same source and token, and which server to dial. */
export interface RunAsyncApiImportInput {
  readonly source: OpenApiSource;
  readonly token?: string;
  /** The `ws`/`wss` server, by its key in the document; absent picks the first one. */
  readonly server?: string;
  /** Credentials for a `url` source's own origin; ignored for a file or pasted text. */
  readonly auth?: DefinitionAuth;
}

/** What the service reaches the network with. Every part is optional so a test builds only what it needs. */
export interface OpenApiImportServiceOptions {
  /** Resolves a definition's keychain references; without it a definition with auth cannot be read. */
  readonly getSecret?: GetSecret;
  /** The TLS and proxy for one URL: the preference-level CA bundle and proxy, as `mainHttpOptions` resolves them. */
  readonly network?: DocumentFetchOptions['network'];
  /** Builds one call's fetcher. Defaults to the engine's `createHttpFetchDocument`; tests inject their own. */
  readonly createFetchDocument?: (options: DocumentFetchOptions) => FetchDocument;
}

/** Hooks one import reports through. */
export interface RunOpenApiImportHooks {
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/**
 * Owns the in-flight OpenAPI imports of the session.
 *
 * One controller per token, dropped as soon as the import settles, so a `cancel` for an import that
 * has already finished is a no-op rather than an error — the dialog may well send one on the way out.
 */
export class OpenApiImportService {
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly options: OpenApiImportServiceOptions = {}) {}

  /**
   * Fetches, resolves, parses and maps one document.
   *
   * @throws the engine's `OpenApiError` codes, or an `AbortError` when the import was cancelled
   */
  async run(input: RunOpenApiImportInput, hooks: RunOpenApiImportHooks = {}): Promise<ImportedOpenApi> {
    return this.track(input.token, input.source, input.auth, hooks, async (fetchDocument, signal, progress) => {
      const imported = await importOpenApi(input.source, {
        fetchDocument,
        signal,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.securityScheme !== undefined ? { securityScheme: input.securityScheme } : {}),
        ...(input.includeOptional !== undefined ? { includeOptional: input.includeOptional } : {}),
        ...(input.sampleValues !== undefined ? { sampleValues: input.sampleValues } : {}),
      });
      progress('done', `Imported ${String(imported.summary.requests)} requests`);
      return imported;
    });
  }

  /**
   * Fetches, resolves, parses and maps one AsyncAPI document into a WebSocket API. It shares the
   * token map with {@link run}, so `api.cancelImport` stops it the same way.
   *
   * @throws the engine's `AsyncApiError` codes, or an `AbortError` when the import was cancelled
   */
  async runAsyncApi(input: RunAsyncApiImportInput, hooks: RunOpenApiImportHooks = {}): Promise<ImportedAsyncApi> {
    return this.track(input.token, input.source, input.auth, hooks, async (fetchDocument, signal, progress) => {
      const imported = await importAsyncApi(input.source, {
        fetchDocument,
        signal,
        ...(input.server !== undefined ? { server: input.server } : {}),
      });
      progress('done', `Imported ${String(imported.summary.requests)} requests`);
      return imported;
    });
  }

  /**
   * Reads and resolves an AsyncAPI document without mapping it — what an Update Definition compares
   * against the cached one. Fetched through the same fetcher an import uses, with the same credentials.
   */
  async readAsyncApi(source: OpenApiSource, auth?: DefinitionAuth): Promise<ParsedAsyncApi> {
    return this.track(undefined, source, auth, {}, (fetchDocument, signal) =>
      parseAsyncApi(source, { fetchDocument, signal }),
    );
  }

  /**
   * Reads and resolves an OpenAPI document without mapping it — what a REST Update Definition
   * compares against the cached one. Fetched through the same fetcher an import uses, with the same
   * credentials.
   */
  async readOpenApi(source: OpenApiSource, auth?: DefinitionAuth): Promise<ParsedOpenApi> {
    return this.track(undefined, source, auth, {}, (fetchDocument, signal) =>
      parseOpenApi(source, { fetchDocument, signal }),
    );
  }

  /**
   * The fetcher for one read of `source`. A `url` source's `auth` is resolved from the keychain first,
   * so a dangling reference fails as `secret-missing` before anything reaches the network, and is
   * sent only to that URL's origin. A file or pasted text is read with no credentials at all.
   *
   * @throws WirebenchError `secret-missing`
   */
  private async fetcherFor(source: OpenApiSource, auth: DefinitionAuth | undefined): Promise<FetchDocument> {
    const network = this.options.network;
    const base: DocumentFetchOptions = network !== undefined ? { network } : {};
    let options = base;
    if (auth !== undefined && source.kind === 'url') {
      const getSecret: GetSecret = this.options.getSecret ?? (() => Promise.resolve(undefined));
      const resolved = await resolveAuthConfig(auth, getSecret);
      options = resolved === undefined ? base : { ...base, auth: resolved, authOrigin: new URL(source.url).origin };
    }
    return (this.options.createFetchDocument ?? createHttpFetchDocument)(options);
  }

  /** Runs one import under `token`'s controller, naming every document fetched as progress. */
  private async track<T>(
    token: string | undefined,
    source: OpenApiSource,
    auth: DefinitionAuth | undefined,
    hooks: RunOpenApiImportHooks,
    body: (
      fetchDocument: FetchDocument,
      signal: AbortSignal,
      progress: (phase: EngineProgressEvent['phase'], message: string) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (token !== undefined) {
      // A second import under the same token replaces the first: the dialog only ever has one.
      this.inFlight.get(token)?.abort();
      this.inFlight.set(token, controller);
    }

    const progress = (phase: EngineProgressEvent['phase'], message: string): void => {
      hooks.onProgress?.({ kind: 'import', phase, message, ...(token !== undefined ? { token } : {}) });
    };

    try {
      progress('fetch', 'Starting');
      const fetcher = await this.fetcherFor(source, auth);
      let fetched = 0;
      const fetchDocument: FetchDocument = async (location, signal) => {
        fetched += 1;
        // Every document the resolver reaches is named, because a reference to a slow host is exactly
        // the case where the user needs to know what the import is waiting for.
        progress('fetch', fetched === 1 ? `Fetching ${location}` : `Fetching ${location} (${String(fetched)})`);
        return fetcher(location, signal);
      };
      return await body(fetchDocument, controller.signal, progress);
    } catch (error) {
      // A cancel is named as one over IPC; otherwise the envelope would call it an internal error.
      if (controller.signal.aborted) {
        throw new WirebenchError('aborted', 'The import was cancelled');
      }
      throw error;
    } finally {
      if (token !== undefined && this.inFlight.get(token) === controller) {
        this.inFlight.delete(token);
      }
    }
  }

  /** Aborts the import running under `token`, if one still is. */
  cancel(token: string): { readonly cancelled: boolean } {
    const controller = this.inFlight.get(token);
    if (controller === undefined) {
      return { cancelled: false };
    }
    controller.abort();
    this.inFlight.delete(token);
    return { cancelled: true };
  }

  /** Aborts every in-flight import; called when the window goes away. */
  cancelAll(): void {
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }
}
```

- [ ] **Step 4: Wire main and the one test that injected a fetcher**

In `apps/desktop/src/main/index.ts`, replace (`:192-193`):

```ts
/** The session's in-flight OpenAPI imports: one fetcher, one cancel per token. */
const openApiImports = new OpenApiImportService();
```

with:

```ts
/** The session's in-flight OpenAPI and AsyncAPI reads: one cancel per token, one fetcher per read. */
const openApiImports = new OpenApiImportService({
  getSecret: secretsFor(undefined),
  // The preference-level CA bundle and proxy a project-free send uses: an import may target a project
  // that does not exist yet, and a definition has no client identity of its own.
  network: (url) =>
    mainHttpOptions(url, {
      preferences: () => preferencesService.get(),
      picks: dialogPicks,
      getSecret: secretsFor(undefined),
      resolveSystemProxy: async (target) => await session.defaultSession.resolveProxy(target).catch(() => undefined),
    }),
});
```

`preferencesService` (`:121`), `dialogPicks` (`:124`), `session` and `mainHttpOptions` (`:72`) are already in
scope there.

In `apps/desktop/test/ipc-asyncapi.test.ts:119`, replace
`const imports = new OpenApiImportService({ fetchDocument });` with:

```ts
  const imports = new OpenApiImportService({ createFetchDocument: () => fetchDocument });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/openapi-import.test.ts apps/desktop/test/ipc-asyncapi.test.ts apps/desktop/test/ipc-rest-update.test.ts apps/desktop/test/ipc-api.test.ts`
Expected: PASS. `ipc-rest-update.test.ts` still builds `new OpenApiImportService()` and reads `file:` sources,
which `createHttpFetchDocument` hands to the default fetcher.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/openapi-import.ts apps/desktop/src/main/index.ts \
  apps/desktop/test/openapi-import.test.ts apps/desktop/test/ipc-asyncapi.test.ts
git commit -m "feat(import): one fetcher per definition read, with its credentials (#135)

OpenApiImportService builds createHttpFetchDocument per read: a definition's auth is resolved from
the keychain first, so a dangling reference is secret-missing before any network, and is sent only
to the source URL's origin. Main gives it the preference-level proxy and CA bundle through
mainHttpOptions, as a project-free send has."
```

---

## Task 4: the wire, and an import that records its credentials

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts:1462` (REST API wire `definition`), `:1673` (WebSocket API wire
  `definition`), before `:2719` (`definitionAuthWireSchema`), `:2780-2793`, `:2825-2836`, `:2851` (request schemas)
- Modify: `apps/desktop/src/main/ipc/api.ts:13` and `:15-20` (imports), before `:84` (`toDefinitionAuth`), `:175-178`
  and `:209` (`api.importOpenApi`), `:236-239` and `:268` (`api.importAsyncApi`), `:295` (`api.asyncApiServers`)
- Modify: `apps/desktop/src/main/project-host.ts:183` (import), `:2924` and `:2946` (`addApi`),
  `:2972` and `:2997` (`importAsyncApi`)
- Modify: `apps/desktop/src/main/project-wire.ts:361` (`toApiWire`), `:552-553` (`toWsApiWire`)
- Test: `apps/desktop/test/definition-auth-wire.test.ts` (new), `apps/desktop/test/ipc-api.test.ts`,
  `apps/desktop/test/ipc-asyncapi.test.ts`

**Interfaces:**
- Consumes: `OpenApiImportService.run`/`runAsyncApi`/`readAsyncApi` with `auth` (Task 3); `DefinitionAuth` (Task 1).
- Produces:
  - `export const definitionAuthWireSchema` and `export type DefinitionAuthWire` =
    `{ type: 'basic'; username: string; passwordRef: string } | { type: 'bearer'; tokenRef: string; scheme?: string } | { type: 'api-key'; name: string; in: 'header' | 'query'; valueRef: string }`
    (every arm `.strict()`).
  - `auth?: DefinitionAuthWire` on `apiImportOpenApiRequestSchema`, `apiImportAsyncApiRequestSchema` and
    `apiAsyncApiServersRequestSchema`, refused unless `source.kind === 'url'` (so `ApiAsyncApiServersRequest` is
    `{ source; auth? }`).
  - `RestApiWire['definition']['auth']` and `WsApiWire['definition']['auth']`: `AuthConfigWire | undefined`.
  - `ProjectHost.addApi` and `ProjectHost.importAsyncApi` inputs gain `auth?: DefinitionAuth`, written into
    `definition`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/definition-auth-wire.test.ts`:

```ts
/**
 * A definition's fetch credentials on the wire: references only, for a URL only, and never a scheme
 * a definition fetch cannot use. Every refusal here is a validation failure over IPC, so a plaintext
 * secret sent by mistake never reaches main, let alone a project file.
 */
import { describe, expect, it } from 'vitest';
import {
  apiAsyncApiServersRequestSchema,
  apiImportAsyncApiRequestSchema,
  apiImportOpenApiRequestSchema,
  definitionAuthWireSchema,
} from '../src/shared/wire-types.js';

const URL_SOURCE = { kind: 'url', url: 'https://gateway.test/openapi.yaml' } as const;
const BASIC = { type: 'basic', username: 'ada', passwordRef: 'ref-p' } as const;

/** Every channel that reads a definition for an import, with the rest of a valid request. */
const IMPORTS = [
  [
    'api.importOpenApi',
    (body: object) => apiImportOpenApiRequestSchema.safeParse({ target: { projectId: 'p1' }, ...body }),
  ],
  [
    'api.importAsyncApi',
    (body: object) => apiImportAsyncApiRequestSchema.safeParse({ target: { projectId: 'p1' }, ...body }),
  ],
  ['api.asyncApiServers', (body: object) => apiAsyncApiServersRequestSchema.safeParse(body)],
] as const;

describe('definitionAuthWireSchema', () => {
  it.each([
    ['basic', BASIC],
    ['bearer', { type: 'bearer', tokenRef: 'ref-t', scheme: 'Token' }],
    ['a header API key', { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'ref-v' }],
    ['a query API key', { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' }],
  ])('accepts %s as references', (_label, auth) => {
    expect(definitionAuthWireSchema.safeParse(auth).success).toBe(true);
  });

  it.each([
    ['a plaintext password', { ...BASIC, password: 'hunter2' }],
    ['a plaintext token', { type: 'bearer', tokenRef: 'ref-t', token: 'abc' }],
    ['a plaintext value', { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'ref-v', value: 'k' }],
    ['NTLM', { type: 'ntlm', username: 'ada', passwordRef: 'ref-p' }],
    ['OAuth2', { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t.test', clientId: 'c' }],
    ['an API key with no name', { type: 'api-key', name: '', in: 'header', valueRef: 'ref-v' }],
  ])('refuses %s', (_label, auth) => {
    expect(definitionAuthWireSchema.safeParse(auth).success).toBe(false);
  });
});

describe('credentials on an import request', () => {
  for (const [channel, parse] of IMPORTS) {
    it(`${channel} accepts them with a URL source`, () => {
      expect(parse({ source: URL_SOURCE, auth: BASIC }).success).toBe(true);
    });

    it(`${channel} refuses them with a file or pasted text`, () => {
      expect(parse({ source: { kind: 'file', path: '/tmp/openapi.yaml' }, auth: BASIC }).success).toBe(false);
      expect(parse({ source: { kind: 'text', text: 'openapi: 3.0.3' }, auth: BASIC }).success).toBe(false);
    });

    it(`${channel} still takes a request without them`, () => {
      expect(parse({ source: { kind: 'file', path: '/tmp/openapi.yaml' } }).success).toBe(true);
    });
  }
});
```

In `apps/desktop/test/ipc-api.test.ts`, insert before `describe('api.importOpenApi with a file source', () => {`
(`:274`):

```ts
describe("a definition's fetch credentials", () => {
  const BASIC = { type: 'basic', username: 'ada', passwordRef: 'ref-p' } as const;

  it('reads the document with them and records them on the placed API', async () => {
    const { addApi, run } = setup();

    await value('api.importOpenApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'https://gateway.test/openapi.yaml' },
      auth: BASIC,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ auth: BASIC }), expect.anything());
    expect(addApi).toHaveBeenCalledWith('p1', expect.objectContaining({ auth: BASIC }));
  });

  it('records nothing when none were given', async () => {
    const { addApi, run } = setup();

    await value('api.importOpenApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
    });

    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('auth');
    expect(addApi.mock.calls[0]?.[1]).not.toHaveProperty('auth');
  });

  it('refuses them with a file source before reading anything', async () => {
    const { run } = setup();

    const error = await failure('api.importOpenApi', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: '/tmp/openapi.yaml' },
      auth: BASIC,
    });

    expect(error.code).toBe('ipc-invalid-request');
    expect(run).not.toHaveBeenCalled();
  });

  it('gives them to the AsyncAPI server preview, which reads the same document', async () => {
    const readAsyncApi = vi.fn().mockResolvedValue({
      document: { servers: [{ key: 'public', url: 'wss://chat.test', protocol: 'wss' }] },
      documents: [],
    });
    setup({ asyncApiImports: { runAsyncApi: vi.fn(), readAsyncApi } });
    const auth = { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' } as const;

    const answer = await value<{ servers: unknown[] }>('api.asyncApiServers', {
      source: { kind: 'url', url: 'https://gateway.test/asyncapi.yaml' },
      auth,
    });

    expect(answer.servers).toEqual([{ key: 'public', url: 'wss://chat.test' }]);
    expect(readAsyncApi).toHaveBeenCalledWith({ kind: 'url', url: 'https://gateway.test/asyncapi.yaml' }, auth);
  });
});

```

In `apps/desktop/test/ipc-asyncapi.test.ts`, give the harness a URL it can serve and a record of what each fetcher
was built with. Replace `import { fileURLToPath } from 'node:url';` (`:13`) with
`import { fileURLToPath, pathToFileURL } from 'node:url';`, and the engine import (`:15`) with:

```ts
import {
  createDefaultFetchDocument,
  type DocumentFetchOptions,
  type FetchDocument,
  type WsFrame,
} from '@wirebench/engine';
```

After `const hosts = new Map<string, ProjectHost>();` (`:69`) add:

```ts

/** `https://docs.test/<name>` is `<name>` in the project folder: a source read by URL, served offline. */
const DOCS = 'https://docs.test/';
/** The value behind the keychain reference `ref-t`. */
const TOKEN = 's3cret-token';
/** Every fetcher the import service built, with its options: which credentials each read went with. */
let built: DocumentFetchOptions[];
```

In `beforeEach`, after `removed = [];` (`:81`) add `built = [];`, and replace the end of the fetcher and the
service (`:118-119`, as Task 3 left them):

```ts
      : real(location, signal);
  const imports = new OpenApiImportService({ createFetchDocument: () => fetchDocument });
```

with:

```ts
      : location.startsWith(DOCS)
        ? real(pathToFileURL(join(projectDir, location.slice(DOCS.length))).href, signal).then((document) => ({
            ...document,
            location,
          }))
        : real(location, signal);
  const imports = new OpenApiImportService({
    getSecret: (ref) => Promise.resolve(ref === 'ref-t' ? TOKEN : undefined),
    createFetchDocument: (options) => {
      built.push(options);
      return fetchDocument;
    },
  });
```

Then insert before `it('dials a non-default WebSocket server when one is chosen', async () => {` (`:240`):

```ts
  it('records the credentials a URL was read with, as references only', async () => {
    const response = await value<Imported>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: `${DOCS}asyncapi.yaml` },
      auth: { type: 'bearer', tokenRef: 'ref-t' },
    });

    expect(built.at(-1)).toMatchObject({ auth: { type: 'bearer', token: TOKEN }, authOrigin: 'https://docs.test' });
    const api = (hostFor('p1').snapshot() as ProjectWire).wsApis.find((one) => one.id === response.apiId);
    expect(api?.definition?.auth).toEqual({ type: 'bearer', tokenRef: 'ref-t' });
    const file = await readFile(join(projectDir, 'project', 'apis', api?.slug ?? '', 'api.yaml'), 'utf8');
    expect(file).toContain('tokenRef: ref-t');
    expect(file).not.toContain(TOKEN);
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/definition-auth-wire.test.ts apps/desktop/test/ipc-api.test.ts apps/desktop/test/ipc-asyncapi.test.ts`
Expected: FAIL. `definitionAuthWireSchema` is not exported; the channels strip `auth`, so `run` and `addApi`
never see it and the file-source refusal does not happen.

- [ ] **Step 3: The wire schemas**

In `apps/desktop/src/shared/wire-types.ts`, replace the REST API wire's definition (`:1462`)
`definition: z.object({ source: z.string(), cache: z.boolean(), version: z.string() }).optional(),` with:

```ts
  definition: z
    .object({
      source: z.string(),
      cache: z.boolean(),
      version: z.string(),
      /** How the definition document is fetched, as references; separate from the API's own `auth`. */
      auth: authConfigWireSchema.optional(),
    })
    .optional(),
```

In `wsApiWireSchema.definition`, after `servers: z.array(z.string()).optional(),` (`:1673`) add:

```ts
      /** How the definition document is fetched, as references; separate from the API's own `auth`. */
      auth: authConfigWireSchema.optional(),
```

Insert before the `/** Where an OpenAPI document comes from. …` comment above `openApiSourceSchema` (`:2719`):

```ts
/**
 * A definition document's fetch credentials: Basic, a bearer token or an API key, each carrying only
 * a `secretRef`. Every arm is `.strict()`, so a plaintext `password`, `token` or `value` sent by
 * mistake fails validation instead of being stripped, and NTLM or OAuth2 are refused by name.
 */
export const definitionAuthWireSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('basic'), username: z.string(), passwordRef: z.string() }).strict(),
  z.object({ type: z.literal('bearer'), tokenRef: z.string(), scheme: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal('api-key'),
      name: z.string().min(1),
      in: z.enum(['header', 'query']),
      valueRef: z.string(),
    })
    .strict(),
]);
export type DefinitionAuthWire = z.infer<typeof definitionAuthWireSchema>;

/** Credentials go with a URL only: a file or pasted text is never fetched from anywhere. */
const onlyWithAUrl = {
  message: 'Definition credentials are only sent with a URL source',
  path: ['auth'],
};

```

Replace `apiImportOpenApiRequestSchema` (`:2780-2793`) with:

```ts
export const apiImportOpenApiRequestSchema = z
  .object({
    target: projectAddInterfaceTargetSchema,
    source: openApiSourceSchema,
    /** Overrides `info.title` as the API's name; the dialog offers it for editing. */
    name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
    /** Overrides the first server's URL as the base URL. */
    baseUrl: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
    /** The security scheme, by its name in the document, to use as the API's own credentials. */
    securityScheme: z.string().max(200).optional(),
    /** Write the definition cache. Defaults to the definition-caching preference. */
    cache: z.boolean().optional(),
    /** Echoed back on `engine.progress` events raised while this import is in flight. */
    token: z.string().optional(),
    /** Credentials for fetching the document, recorded on the API for Update Definition. URL sources only. */
    auth: definitionAuthWireSchema.optional(),
  })
  .refine((request) => request.auth === undefined || request.source.kind === 'url', onlyWithAUrl);
```

Replace `apiImportAsyncApiRequestSchema` (`:2825-2836`) with:

```ts
export const apiImportAsyncApiRequestSchema = z
  .object({
    target: projectAddInterfaceTargetSchema,
    source: openApiSourceSchema,
    /** The `ws`/`wss` server to dial, by its key in the document; absent picks the first one. */
    server: z.string().max(200).optional(),
    /** Overrides `info.title` as the API's name; empty or whitespace-only falls back to the title. */
    name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
    /** Write the definition cache. Defaults to the definition-caching preference. */
    cache: z.boolean().optional(),
    /** Echoed back on `engine.progress` events raised while this import is in flight. */
    token: z.string().optional(),
    /** Credentials for fetching the document, recorded on the API for Update Definition. URL sources only. */
    auth: definitionAuthWireSchema.optional(),
  })
  .refine((request) => request.auth === undefined || request.source.kind === 'url', onlyWithAUrl);
```

Replace `apiAsyncApiServersRequestSchema` (`:2851`) with:

```ts
export const apiAsyncApiServersRequestSchema = z
  .object({ source: openApiSourceSchema, auth: definitionAuthWireSchema.optional() })
  .refine((request) => request.auth === undefined || request.source.kind === 'url', onlyWithAUrl);
```

- [ ] **Step 4: Main reads with them and records them**

In `apps/desktop/src/main/ipc/api.ts`, replace the engine type import (`:13`) with:

```ts
import type {
  AsyncApiOpRef,
  AsyncApiUpdatePlan,
  DefinitionAuth,
  OpenApiSource,
  RestOpRef,
  RestUpdatePlan,
} from '@wirebench/engine';
```

add `DefinitionAuthWire,` after `AsyncApiUpdatePlanWire,` in the `../../shared/wire-types.js` type import (`:16`), and
insert before `/** A sha256 over every document an update read, …` (`:84`):

```ts
/** A definition's fetch credentials off the wire, into the model: references only, absent optionals dropped. */
function toDefinitionAuth(wire: DefinitionAuthWire): DefinitionAuth {
  switch (wire.type) {
    case 'basic':
      return { type: 'basic', username: wire.username, passwordRef: wire.passwordRef };
    case 'bearer':
      return { type: 'bearer', tokenRef: wire.tokenRef, ...(wire.scheme !== undefined ? { scheme: wire.scheme } : {}) };
    case 'api-key':
      return { type: 'api-key', name: wire.name, in: wire.in, valueRef: wire.valueRef };
  }
}

```

In the `api.importOpenApi` handler, replace (`:175-178`):

```ts
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const imported = await deps.imports.run(
      {
        source: toEngineSource(checked),
```

with:

```ts
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);
    const imported = await deps.imports.run(
      {
        source: toEngineSource(checked),
        ...(auth !== undefined ? { auth } : {}),
```

and in its `place` object, after `declaredVersion: imported.document.declaredVersion,` (`:209`) add
`...(auth !== undefined ? { auth } : {}),`.

In the `api.importAsyncApi` handler, make the same two changes: after
`const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);` (`:236`) add
`const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);`, after
`source: toEngineSource(checked),` (`:239`) add `...(auth !== undefined ? { auth } : {}),`, and in its `place`, after
`...(imported.summary.server !== undefined ? { server: imported.summary.server } : {}),` (`:268`; the
identical line at `:255` is in `summary`, not `place`) add
`...(auth !== undefined ? { auth } : {}),`.

In the `api.asyncApiServers` handler, replace
`const { document } = await asyncApiImports.readAsyncApi(toEngineSource(checked));` (`:295`) with:

```ts
    // The picker reads the same document the import will, so it needs the same credentials.
    const auth = request.auth === undefined ? undefined : toDefinitionAuth(request.auth);
    const { document } = await asyncApiImports.readAsyncApi(toEngineSource(checked), auth);
```

In `apps/desktop/src/main/project-host.ts`, change the engine type import (`:183`) to
`import type { DefinitionAuth, EndpointAuth, JsonSchema, SoapOwnerAuth } from '@wirebench/engine';`. In `addApi`'s
input, after `readonly declaredVersion: string;` (`:2924`), and in `importAsyncApi`'s input, after
`readonly server?: string;` (`:2974`), add:

```ts
    /** The credentials the document was fetched with, kept so Update Definition can fetch it again. */
    readonly auth?: DefinitionAuth;
```

In `addApi`, replace `definition: { source: input.source, cache, version: input.declaredVersion },` (`:2946`) with:

```ts
      definition: {
        source: input.source,
        cache,
        version: input.declaredVersion,
        ...(input.auth !== undefined ? { auth: input.auth } : {}),
      },
```

In `importAsyncApi`, after `...(input.server !== undefined ? { server: input.server } : {}),` (`:2997`) add:

```ts
        ...(input.auth !== undefined ? { auth: input.auth } : {}),
```

In `apps/desktop/src/main/project-wire.ts`, replace the last line of `toApiWire` (`:361`)
`...(api.definition !== undefined ? { definition: { ...api.definition } } : {}),` with:

```ts
    ...(api.definition !== undefined
      ? {
          definition: {
            source: api.definition.source,
            cache: api.definition.cache,
            version: api.definition.version,
            ...(api.definition.auth !== undefined ? { auth: toAuthConfigWire(api.definition.auth) } : {}),
          },
        }
      : {}),
```

and in `toWsApiWire`, after `...(info !== undefined ? { version: info.version, servers: [...info.servers] } : {}),`
(`:553`) add:

```ts
            ...(api.definition.auth !== undefined ? { auth: toAuthConfigWire(api.definition.auth) } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/definition-auth-wire.test.ts apps/desktop/test/ipc-api.test.ts apps/desktop/test/ipc-asyncapi.test.ts apps/desktop/test/import-wire-limits.test.ts`
Expected: PASS. The AsyncAPI import test sees the resolved token on the fetcher and only `tokenRef` in `api.yaml`.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main/ipc/api.ts apps/desktop/src/main/project-host.ts \
  apps/desktop/src/main/project-wire.ts apps/desktop/test/definition-auth-wire.test.ts apps/desktop/test/ipc-api.test.ts \
  apps/desktop/test/ipc-asyncapi.test.ts
git commit -m "feat(import): import OpenAPI and AsyncAPI documents behind authentication (#135)

api.importOpenApi, api.importAsyncApi and api.asyncApiServers take a definition's credentials as
references, refused unless the source is a URL, and the wire arms are strict so a plaintext secret
fails validation. The import reads with them and records them on the API's definition, which the API
wire now carries so the dialogs can show it."
```

---

## Task 5: Update Definition reuses the stored credentials

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts:2908-2919` (`restUpdateSourceSchema`)
- Modify: `apps/desktop/src/main/project-host.ts:3176-3179` (`asyncApiSource`), `:3223-3226` (`restSource`),
  `:3278` and `:3292-3309` (`applyRestUpdate`)
- Modify: `apps/desktop/src/main/ipc/api.ts:312` and `:326` (`readAsyncApiSource`), `:360-389` (`readRestSource`,
  its TODO removed), `:405-407` (`api.restApplyUpdate`)
- Test: `apps/desktop/test/ipc-rest-update.test.ts`, `apps/desktop/test/ipc-asyncapi.test.ts`,
  `apps/desktop/test/definition-auth-wire.test.ts`

**Interfaces:**
- Consumes: `definitionAuthWireSchema`, `toDefinitionAuth` (Task 4); `readOpenApi`/`readAsyncApi` with `auth` (Task 3).
- Produces:
  - `RestUpdateSourceWire`'s `url` arm gains `auth?: DefinitionAuthWire`; `api.restPlanUpdate` and
    `api.restApplyUpdate` both carry it.
  - `ProjectHost.restSource(apiId)` and `ProjectHost.asyncApiSource(apiId)` return
    `{ readonly source: string; readonly auth?: DefinitionAuth }`.
  - `ProjectHost.applyRestUpdate(apiId, next, { source?, auth?, check? })`: with a `source`, `auth` replaces the
    stored credentials and absent clears them; without one, the stored credentials stay.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/ipc-rest-update.test.ts`, add `import { pathToFileURL } from 'node:url';` after the
`node:path` import (`:11`) and `import type { DocumentFetchOptions, FetchDocument } from '@wirebench/engine';`
after the `@wirebench/engine` value import (`:17`). After `let host: ProjectHost;` (`:134`) add:

```ts

/** `https://defs.test/<name>` is `<name>` in the project folder: a source read by URL, served offline. */
const DEFS = 'https://defs.test/';
/** The keychain, by reference: a test deletes an entry to leave a reference dangling. */
let secrets: Record<string, string>;
/** Every fetcher the import service built, with its options: which credentials each read went with. */
let built: DocumentFetchOptions[];
/** Every location a fetcher was asked for. */
let fetched: string[];
```

In `beforeEach`, replace `const imports = new OpenApiImportService();` (`:148`) with:

```ts
  secrets = { 'ref-p': 'hunter2', 'ref-t': 'tok-123' };
  built = [];
  fetched = [];
  const real = createDefaultFetchDocument();
  const fetchDocument: FetchDocument = (location, signal) => {
    fetched.push(location);
    return location.startsWith(DEFS)
      ? real(pathToFileURL(join(projectDir, location.slice(DEFS.length))).href, signal).then((document) => ({
          ...document,
          location,
        }))
      : real(location, signal);
  };
  const imports = new OpenApiImportService({
    getSecret: (ref) => Promise.resolve(secrets[ref]),
    createFetchDocument: (options) => {
      built.push(options);
      return fetchDocument;
    },
  });
```

Append to the file:

```ts
describe('an update reads the definition with the credentials it was imported with', () => {
  const BASIC = { type: 'basic', username: 'ada', passwordRef: 'ref-p' } as const;
  const BEARER = { type: 'bearer', tokenRef: 'ref-t' } as const;
  const URL_SOURCE = { kind: 'url', url: `${DEFS}openapi.yaml` } as const;

  async function importByUrl(): Promise<string> {
    const imported = await value<{ apiId: string }>('api.importOpenApi', {
      source: URL_SOURCE,
      target: { projectId: 'p1' },
      cache: true,
      auth: BASIC,
    });
    return imported.apiId;
  }

  function definition(apiId: string) {
    return (host.snapshot() as ProjectWire).apis.find((api) => api.id === apiId)?.definition;
  }

  async function planAndApply(apiId: string, source?: unknown) {
    const request = source === undefined ? { apiId } : { apiId, source };
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', request);
    return apiRestApplyUpdateResponseSchema.parse(
      await value('api.restApplyUpdate', { ...request, fingerprint: plan.fingerprint }),
    );
  }

  it('records them on import, and plans and applies with them without being given them again', async () => {
    const apiId = await importByUrl();
    expect(definition(apiId)?.auth).toEqual(BASIC);
    expect(built.at(-1)).toMatchObject({
      auth: { type: 'basic', username: 'ada', password: 'hunter2' },
      authOrigin: 'https://defs.test',
    });

    await writeFile(docPath, V2);
    built = [];
    const applied = await planAndApply(apiId);

    expect(applied.applied.requestsAdded).toBe(1);
    // Both the plan and the apply read the recorded source, each with the recorded credentials.
    expect(built).toHaveLength(2);
    for (const options of built) {
      expect(options).toMatchObject({ auth: { type: 'basic', password: 'hunter2' }, authOrigin: 'https://defs.test' });
    }
    expect(definition(apiId)).toMatchObject({ source: URL_SOURCE.url, auth: BASIC });
  });

  it('stores what a chosen URL was read with, and clears them for a URL given without any', async () => {
    const apiId = await importByUrl();
    await writeFile(docPath, V2);

    await planAndApply(apiId, { ...URL_SOURCE, auth: BEARER });
    expect(built.at(-1)?.auth).toEqual({ type: 'bearer', token: 'tok-123' });
    expect(definition(apiId)?.auth).toEqual(BEARER);

    await writeFile(docPath, V1);
    await planAndApply(apiId, URL_SOURCE);
    expect(built.at(-1)?.auth).toBeUndefined();
    expect(definition(apiId)).not.toHaveProperty('auth');
  });

  it('clears them when the update comes from a file', async () => {
    const apiId = await importByUrl();
    await writeFile(docPath, V2);

    await planAndApply(apiId, { kind: 'file', path: docPath });

    expect(built.at(-1)?.auth).toBeUndefined();
    expect(definition(apiId)).toMatchObject({ source: docPath });
    expect(definition(apiId)).not.toHaveProperty('auth');
  });

  it('fails as secret-missing before fetching anything when the reference has no value here', async () => {
    const apiId = await importByUrl();
    delete secrets['ref-p'];
    fetched = [];

    const error = await failure('api.restPlanUpdate', { apiId });

    expect(error.code).toBe('secret-missing');
    expect(fetched).toEqual([]);
  });
});
```

In `apps/desktop/test/ipc-asyncapi.test.ts`, insert before
`it('refuses to plan for an API that is not AsyncAPI-imported', async () => {`:

```ts
  it('plans and applies with the credentials the URL was imported with, without being given them', async () => {
    const imported = await value<Imported>('api.importAsyncApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: `${DOCS}asyncapi.yaml` },
      auth: { type: 'bearer', tokenRef: 'ref-t' },
    });
    built = [];

    const plan = await value<{ fingerprint: string }>('api.asyncApiPlanUpdate', { apiId: imported.apiId });
    await value('api.asyncApiApplyUpdate', { apiId: imported.apiId, fingerprint: plan.fingerprint });

    expect(built).toHaveLength(2);
    for (const options of built) {
      expect(options).toMatchObject({ auth: { type: 'bearer', token: TOKEN }, authOrigin: 'https://docs.test' });
    }
    const api = (hostFor('p1').snapshot() as ProjectWire).wsApis.find((one) => one.id === imported.apiId);
    expect(api?.definition?.auth).toEqual({ type: 'bearer', tokenRef: 'ref-t' });
  });

```

In `apps/desktop/test/definition-auth-wire.test.ts`, add `apiRestPlanUpdateRequestSchema,` after
`apiImportOpenApiRequestSchema,` in the wire-types import, and append:

```ts
describe('credentials on a REST update source', () => {
  it('keeps them on a URL source', () => {
    const parsed = apiRestPlanUpdateRequestSchema.parse({ apiId: 'a1', source: { ...URL_SOURCE, auth: BASIC } });
    expect(parsed.source).toEqual({ ...URL_SOURCE, auth: BASIC });
  });

  it('refuses a plaintext secret there too', () => {
    const source = { ...URL_SOURCE, auth: { ...BASIC, password: 'hunter2' } };
    expect(apiRestPlanUpdateRequestSchema.safeParse({ apiId: 'a1', source }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-rest-update.test.ts apps/desktop/test/ipc-asyncapi.test.ts apps/desktop/test/definition-auth-wire.test.ts`
Expected: FAIL. A plan with no source reads without credentials (`built` shows no `auth`), a chosen source's `auth`
is stripped by the schema, and a dangling reference is never looked up, so nothing fails as `secret-missing`.

- [ ] **Step 3: The update source on the wire**

In `apps/desktop/src/shared/wire-types.ts`, in `restUpdateSourceSchema`'s `url` arm, after the `url` field's
`.regex(/^https?:\/\//i, 'Only http and https URLs can be read'),` (`:2916`) add:

```ts
    /** Credentials for this URL; an apply records them on the API, and none clears the stored ones. */
    auth: definitionAuthWireSchema.optional(),
```

- [ ] **Step 4: The host answers and replaces the stored credentials**

In `apps/desktop/src/main/project-host.ts`, replace `asyncApiSource` (`:3176-3179`) with:

```ts
  /**
   * Where an AsyncAPI-imported API's definition came from, as the user gave it, and the credentials
   * it was fetched with, for an update to re-read it the same way.
   */
  asyncApiSource(apiId: string): { readonly source: string; readonly auth?: DefinitionAuth } {
    const { source, auth } = this.requireAsyncApi(apiId).definition;
    return { source, ...(auth !== undefined ? { auth } : {}) };
  }
```

replace `restSource` (`:3223-3226`) with:

```ts
  /**
   * Where a REST API's definition came from, as the user gave it, and the credentials it was fetched
   * with, for an update to re-read it the same way.
   */
  restSource(apiId: string): { readonly source: string; readonly auth?: DefinitionAuth } {
    const { source, auth } = this.requireCachedRestApi(apiId).definition;
    return { source, ...(auth !== undefined ? { auth } : {}) };
  }
```

In `applyRestUpdate`'s options, after `readonly source?: string;` (`:3278`) add:

```ts
      /**
       * The credentials `source` was read with. Only looked at with a `source`: the stored ones are then
       * replaced, and absent clears them, so a credential never follows the API to a source it was not
       * given for. Without a `source` the stored credentials stay as they are.
       */
      readonly auth?: DefinitionAuth;
```

Replace `const { source, check } = options;` (`:3292`) with `const { source, auth, check } = options;`, and replace:

```ts
    const { api: mapped, ...applied } = applyRestUpdate(api, old, next.document);
    const updated: RestApi = {
      ...mapped,
      definition: {
        // `requireCachedRestApi` proved this is there; the engine only ever rewrites its `version`,
        // which this sets itself.
        ...api.definition,
        version: next.document.declaredVersion,
        ...(source !== undefined ? { source } : {}),
      },
    };
```

with:

```ts
    const { api: mapped, ...applied } = applyRestUpdate(api, old, next.document);
    // `requireCachedRestApi` proved the definition is there; the engine only ever rewrites its
    // `version`, which this sets itself.
    const { auth: storedAuth, ...recorded } = api.definition;
    const nextAuth = source !== undefined ? auth : storedAuth;
    const updated: RestApi = {
      ...mapped,
      definition: {
        ...recorded,
        version: next.document.declaredVersion,
        ...(source !== undefined ? { source } : {}),
        ...(nextAuth !== undefined ? { auth: nextAuth } : {}),
      },
    };
```

- [ ] **Step 5: The channels read with them**

In `apps/desktop/src/main/ipc/api.ts`, in `readAsyncApiSource`, replace `const recorded = router.asyncApiSource(apiId);`
(`:312`) with `const { source: recorded, auth } = router.asyncApiSource(apiId);`, and replace its last line
`return asyncApiImports.readAsyncApi(toEngineSource(checked));` (`:326`) with:

```ts
    // The credentials it was imported with, without asking again; a file is read without any.
    return asyncApiImports.readAsyncApi(toEngineSource(checked), checked.kind === 'url' ? auth : undefined);
```

Replace `readRestSource` with its doc comment, TODO included (`:360-389`):

```ts
  /**
   * Reads a REST API's new definition: the source the user chose, or else the one the API records,
   * either way through the same path check an import makes. Answers the checked location too, so
   * an apply can record a chosen source as the API's own.
   *
   * TODO: carry credentials, so a definition behind basic auth can be updated. Not done here because
   * `api.importOpenApi` has no auth either — `OpenApiImportService.readOpenApi` and `run` both build
   * their fetcher without any — so it is not a small change to this handler but a new option through
   * the import service, the fetcher and the schema, plus somewhere to keep the API's `secretRef`.
   * Until then the chooser lets the user point at a local copy.
   */
  const readRestSource = async (apiId: string, chosen: RestUpdateSourceWire | undefined) => {
    let wire: OpenApiSourceWire;
    if (chosen !== undefined) {
      wire = chosen;
    } else {
      const recorded = router.restSource(apiId);
      if (recorded.startsWith('inline:')) {
        throw new WirebenchError(
          'definition-source-unavailable',
          'This API was imported from pasted text, so there is no source to read again',
          { details: { apiId } },
        );
      }
      wire = /^https?:\/\//i.test(recorded) ? { kind: 'url', url: recorded } : { kind: 'file', path: recorded };
    }
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, wire);
    const parsed = await deps.imports.readOpenApi(toEngineSource(checked));
    return { parsed, label: sourceLabel(checked) };
  };
```

with:

```ts
  /**
   * Reads a REST API's new definition: the source the user chose, with the credentials chosen with
   * it, or else the one the API records, with the credentials it records — so an update never asks
   * for what the import was given. Either way through the same path check an import makes. Answers
   * the checked location and the credentials used, so an apply can record a chosen source as the
   * API's own.
   */
  const readRestSource = async (apiId: string, chosen: RestUpdateSourceWire | undefined) => {
    let wire: OpenApiSourceWire;
    let auth: DefinitionAuth | undefined;
    if (chosen !== undefined) {
      if (chosen.kind === 'url') {
        wire = { kind: 'url', url: chosen.url };
        auth = chosen.auth === undefined ? undefined : toDefinitionAuth(chosen.auth);
      } else {
        wire = chosen;
      }
    } else {
      const recorded = router.restSource(apiId);
      if (recorded.source.startsWith('inline:')) {
        throw new WirebenchError(
          'definition-source-unavailable',
          'This API was imported from pasted text, so there is no source to read again',
          { details: { apiId } },
        );
      }
      wire = /^https?:\/\//i.test(recorded.source)
        ? { kind: 'url', url: recorded.source }
        : { kind: 'file', path: recorded.source };
      auth = wire.kind === 'url' ? recorded.auth : undefined;
    }
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, wire);
    const parsed = await deps.imports.readOpenApi(toEngineSource(checked), auth);
    return { parsed, label: sourceLabel(checked), auth };
  };
```

In the `api.restApplyUpdate` handler, replace (`:405-407`):

```ts
    const { parsed, label } = await readRestSource(request.apiId, request.source);
    const { project, plan, applied, warning } = await router.restApplyUpdate(request.apiId, parsed, {
      ...(request.source !== undefined ? { source: label } : {}),
```

with:

```ts
    const { parsed, label, auth } = await readRestSource(request.apiId, request.source);
    const { project, plan, applied, warning } = await router.restApplyUpdate(request.apiId, parsed, {
      // A chosen source brings its own credentials, or none: a file, or a URL given without any.
      ...(request.source !== undefined ? { source: label, ...(auth !== undefined ? { auth } : {}) } : {}),
```

`api.restPlanUpdate`'s own `const { parsed, label } = await readRestSource(…)` needs no change.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-rest-update.test.ts apps/desktop/test/ipc-asyncapi.test.ts apps/desktop/test/definition-auth-wire.test.ts apps/desktop/test/ipc-api.test.ts`
Expected: PASS, the existing update tests included (they import from a file, which never has credentials).

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main/project-host.ts apps/desktop/src/main/ipc/api.ts \
  apps/desktop/test/ipc-rest-update.test.ts apps/desktop/test/ipc-asyncapi.test.ts \
  apps/desktop/test/definition-auth-wire.test.ts
git commit -m "feat(update): re-read a definition with the credentials it was imported with (#135)

REST and AsyncAPI Update Definition read the recorded source with the stored auth, without asking.
A REST update from another URL carries that URL's credentials, which apply records in place of the
stored ones; a URL given without any, or a file, clears them, so a credential never follows the API
to a source it was not given for."
```

---

## Task 6: the Import dialog's Authentication section

**Files:**
- Modify: `apps/desktop/src/renderer/components/auth-fields.tsx:83`, `:87`, before `:112`, `:238`
- Create: `apps/desktop/src/renderer/components/definition-auth.tsx`
- Modify: `apps/desktop/src/renderer/features/explorer/import-dialog.tsx:21-22`, `:36`, after `:173`, `:251`,
  `:263-265`, `:304`, `:568`, `:613`, `:641`, `:886`
- Test: `apps/desktop/test/renderer/auth-fields.test.tsx`, `apps/desktop/test/renderer/definition-auth.test.ts` (new),
  `apps/desktop/test/renderer/import-openapi-dialog.test.tsx`, `apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx`

**Interfaces:**
- Consumes: `DefinitionAuthWire`, `ApiAsyncApiServersRequest` and the `auth` request fields (Task 4), as types only.
- Produces:
  - `AuthFieldsProps.preemptiveOption?: boolean` (default `true`) and
    `AuthFieldsProps.registerFlush?: (flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => void`.
  - `components/definition-auth.tsx`: `DEFINITION_AUTH_TYPES`, `NO_DEFINITION_AUTH`,
    `toDefinitionAuthWire(auth): DefinitionAuthWire | undefined` (undefined for none, not configured, or a
    half-filled form), `sameOrigin(a, b): boolean`, and `<DefinitionAuthFields auth onChange registerFlush? />`
    (a `fieldset` with `data-testid="definition-auth"`, scope `Definition`).
  - Import dialog: the section under the URL for OpenAPI and AsyncAPI only; `auth` on `api.importOpenApi`,
    `api.importAsyncApi` and `api.asyncApiServers` for a URL source only.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/renderer/auth-fields.test.tsx`:

```tsx
describe('AuthFields for a definition fetch', () => {
  it('leaves out the preemptive box when asked, since such a fetch is always preemptive', () => {
    installWirebenchApi();
    const auth: AuthConfigWire = { type: 'basic', username: 'ada' };
    render(<AuthFields scope="Definition" auth={auth} onChange={vi.fn()} preemptiveOption={false} />);

    expect(screen.queryByLabelText('Definition preemptive')).toBeNull();
  });

  it('hands its owner a flush that stores a typed secret and answers the configuration with its reference', async () => {
    installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) } });
    let flush: (() => Promise<AuthConfigWire | undefined>) | undefined;
    const auth: AuthConfigWire = { type: 'bearer' };
    render(
      <AuthFields
        scope="Definition"
        auth={auth}
        onChange={vi.fn()}
        registerFlush={(next) => {
          flush = next;
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Definition token'), 'tok');

    expect(await flush?.()).toEqual({ type: 'bearer', tokenRef: 'ref-flushed' });
  });
});
```

Create `apps/desktop/test/renderer/definition-auth.test.ts`:

```ts
/**
 * What the definition Authentication section sends: only a complete credential, only its
 * references, and a stored one offered again only on the same origin.
 */
import { describe, expect, it } from 'vitest';
import { sameOrigin, toDefinitionAuthWire } from '../../src/renderer/components/definition-auth.js';

describe('toDefinitionAuthWire', () => {
  it('keeps only the fields a definition fetch uses', () => {
    expect(toDefinitionAuthWire({ type: 'basic', username: 'ada', passwordRef: 'ref-p', preemptive: false })).toEqual({
      type: 'basic',
      username: 'ada',
      passwordRef: 'ref-p',
    });
    expect(toDefinitionAuthWire({ type: 'bearer', tokenRef: 'ref-t', scheme: ' Token ' })).toEqual({
      type: 'bearer',
      tokenRef: 'ref-t',
      scheme: 'Token',
    });
    expect(toDefinitionAuthWire({ type: 'api-key', name: ' api_key ', in: 'query', valueRef: 'ref-v' })).toEqual({
      type: 'api-key',
      name: 'api_key',
      in: 'query',
      valueRef: 'ref-v',
    });
  });

  it('sends nothing for None, or for a credential whose secret or name is missing', () => {
    expect(toDefinitionAuthWire(undefined)).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'none' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'basic', username: 'ada' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'bearer', scheme: 'Bearer' })).toBeUndefined();
    expect(toDefinitionAuthWire({ type: 'api-key', name: '', in: 'header', valueRef: 'ref-v' })).toBeUndefined();
  });
});

describe('sameOrigin', () => {
  it('matches scheme, host and port, and nothing that is not a URL', () => {
    expect(sameOrigin('https://gw.test/a/openapi.yaml', 'https://gw.test/b/v2.yaml')).toBe(true);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'http://gw.test/openapi.yaml')).toBe(false);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'https://gw.test:8443/openapi.yaml')).toBe(false);
    expect(sameOrigin('https://gw.test/openapi.yaml', 'https://other.test/openapi.yaml')).toBe(false);
    expect(sameOrigin('/tmp/openapi.yaml', 'https://gw.test/openapi.yaml')).toBe(false);
  });
});
```

In `apps/desktop/test/renderer/import-openapi-dialog.test.tsx`, after `const openFile = vi.fn();` (`:56`) add:

```ts
const setSecret = vi.fn();
const secretExists = vi.fn();
```

after `dialogs: { openFile },` (`:63`) add `secrets: { set: setSecret, exists: secretExists },`, after the
`openFile.mockReset()…` line in `beforeEach` (`:90`) add:

```ts
  setSecret.mockReset().mockResolvedValue({ ok: true, value: { ref: 'ref-1' } });
  secretExists.mockReset().mockResolvedValue({ ok: true, value: { exists: true } });
```

and append:

```tsx
describe('ImportOpenApiDialog — a document behind authentication', () => {
  it('offers the Authentication section on the URL tab only', async () => {
    mount();
    expect(screen.getByTestId('definition-auth')).toBeTruthy();
    const types = screen.getByLabelText<HTMLSelectElement>('Definition authentication type');
    expect([...types.options].map((option) => option.text)).toEqual([
      'Not configured',
      'None',
      'Basic',
      'Bearer token',
      'API key',
    ]);
    expect(types.value).toBe('none');

    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

  it('never offers it for WSDL, which keeps its own Basic auth', async () => {
    mount();
    await userEvent.selectOptions(screen.getByTestId('import-format-select'), 'wsdl');

    expect(screen.queryByTestId('definition-auth')).toBeNull();
    expect(screen.getByText('Use Basic auth')).toBeTruthy();
  });

  it('stores a typed password in the keychain on Import and sends only its reference', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://gateway.test/openapi.yaml');
    await userEvent.selectOptions(screen.getByLabelText('Definition authentication type'), 'basic');
    await userEvent.type(screen.getByLabelText('Definition username'), 'ada');
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    // Typed but never saved: Import stores it first, as the WSDL password is.
    await userEvent.type(screen.getByLabelText('Definition password'), 'hunter2');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalled();
    });
    expect(setSecret).toHaveBeenCalledWith({ value: 'hunter2', label: 'Definition password' });
    const request = importOpenApi.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['auth']).toEqual({ type: 'basic', username: 'ada', passwordRef: 'ref-1' });
    expect(JSON.stringify(request)).not.toContain('hunter2');
  });

  it('sends a query API key by reference, and nothing at all for None', async () => {
    mount();

    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://gateway.test/openapi.yaml');
    await userEvent.selectOptions(screen.getByLabelText('Definition authentication type'), 'api-key');
    await userEvent.type(screen.getByLabelText('Definition name'), 'api_key');
    await userEvent.selectOptions(screen.getByLabelText('Definition api key location'), 'query');
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Definition value'), 'good-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByTestId('import-openapi-submit'));

    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalledTimes(1);
    });
    expect((importOpenApi.mock.calls[0]?.[0] as Record<string, unknown>)['auth']).toEqual({
      type: 'api-key',
      name: 'api_key',
      in: 'query',
      valueRef: 'ref-1',
    });

    cleanup();
    importOpenApi.mockClear();
    mount();
    await userEvent.type(screen.getByTestId('import-openapi-url'), 'https://api.test/openapi.yaml');
    await userEvent.click(screen.getByTestId('import-openapi-submit'));
    await waitFor(() => {
      expect(importOpenApi).toHaveBeenCalledTimes(1);
    });
    expect(importOpenApi.mock.calls[0]?.[0]).not.toHaveProperty('auth');
  });
});
```

In `apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx`, after
`api: { importAsyncApi, asyncApiServers, cancelImport },` (`:61`) add:

```ts
    secrets: {
      set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-1' } }),
      exists: vi.fn().mockResolvedValue({ ok: true, value: { exists: true } }),
    },
```

and append:

```tsx
describe('ImportDialog — an AsyncAPI document behind authentication', () => {
  it('reads the servers and imports with the same credentials, by reference', async () => {
    mount();
    const url = 'https://gateway.test/asyncapi.yaml';
    await userEvent.selectOptions(screen.getByTestId('import-format-select'), 'asyncapi');
    await userEvent.type(screen.getByTestId('import-url-input'), url);
    await userEvent.selectOptions(screen.getByLabelText('Definition authentication type'), 'bearer');
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Definition token'), 'tok');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const auth = { type: 'bearer', tokenRef: 'ref-1' };
    await waitFor(() => {
      expect(asyncApiServers).toHaveBeenLastCalledWith({ source: { kind: 'url', url }, auth });
    });
    await userEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => {
      expect(importAsyncApi).toHaveBeenCalledTimes(1);
    });
    expect(importAsyncApi.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'url', url }, auth });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/auth-fields.test.tsx apps/desktop/test/renderer/definition-auth.test.ts apps/desktop/test/renderer/import-openapi-dialog.test.tsx apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx`
Expected: FAIL. `definition-auth.js` does not exist; there is no `definition-auth` section; the preemptive box
is always there.

- [ ] **Step 3: Two options on `AuthFields`**

In `apps/desktop/src/renderer/components/auth-fields.tsx`, after `readonly oauth2Status?: ReactNode;` (`:83`) add:

```tsx
  /**
   * Offer Basic's *Send credentials preemptively* box. Default true; a definition fetch is always
   * preemptive, so its form leaves the box out rather than show one that changes nothing.
   */
  readonly preemptiveOption?: boolean;
  /**
   * Receives a flush the owner awaits before submitting: every secret typed but not yet saved is
   * stored, and the flush answers the configuration with the fresh references. Called again with
   * `undefined` on unmount.
   */
  readonly registerFlush?: (flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => void;
```

Replace the signature (`:87`)
`export function AuthFields({ scope, auth, inheritable = false, types, onChange, oauth2Status }: AuthFieldsProps) {`
with:

```tsx
export function AuthFields({
  scope,
  auth,
  inheritable = false,
  types,
  onChange,
  oauth2Status,
  preemptiveOption = true,
  registerFlush,
}: AuthFieldsProps) {
```

Insert before the unmount effect `useEffect(\n    () => () => {` (`:112`):

```tsx
  useEffect(() => {
    registerFlush?.(async () => {
      let current = authRef.current;
      for (const [slot, flush] of flushes.current) {
        const ref = await flush();
        if (ref !== undefined && current !== undefined && ref !== current[slot]) {
          current = { ...current, [slot]: ref };
        }
      }
      return current;
    });
    return () => {
      registerFlush?.(undefined);
    };
  }, [registerFlush]);

```

`authRef` and `flushes` are the component's existing refs (the configuration as last rendered, and each
`SecretField`'s flush by slot). Replace `{type === 'basic' && (` above the preemptive checkbox (`:238`) with
`{type === 'basic' && preemptiveOption && (`.

- [ ] **Step 4: The shared section**

Create `apps/desktop/src/renderer/components/definition-auth.tsx`:

```tsx
/**
 * The Authentication section for fetching a definition document: an OpenAPI or AsyncAPI URL in the
 * Import dialog, and another URL in the REST Update Definition chooser.
 *
 * It is {@link AuthFields} narrowed to the three schemes a definition fetch can send — Basic, a
 * bearer token and an API key, in a header or the query — so every secret is still a `SecretField`
 * and only a `secretRef` ever leaves the form. The helpers turn the form's value into what the
 * channels take, and decide when a stored credential may be offered for a URL.
 */
import { AuthFields } from './auth-fields.js';
import type { AuthConfigWire, DefinitionAuthWire } from '../../shared/wire-types.js';

/** The schemes a definition fetch can send, in the form's order. */
export const DEFINITION_AUTH_TYPES: readonly AuthConfigWire['type'][] = ['none', 'basic', 'bearer', 'api-key'];

/** The form's starting value: no credentials. */
export const NO_DEFINITION_AUTH: AuthConfigWire = { type: 'none' };

/**
 * The form's value as a channel takes it: only the fields a definition fetch uses, and `undefined`
 * for **None** or for a scheme whose secret was never entered — sending half a credential would
 * only turn into a refusal from the server.
 */
export function toDefinitionAuthWire(auth: AuthConfigWire | undefined): DefinitionAuthWire | undefined {
  switch (auth?.type) {
    case 'basic':
      return auth.passwordRef === undefined
        ? undefined
        : { type: 'basic', username: auth.username ?? '', passwordRef: auth.passwordRef };
    case 'bearer':
      return auth.tokenRef === undefined
        ? undefined
        : {
            type: 'bearer',
            tokenRef: auth.tokenRef,
            ...(auth.scheme !== undefined && auth.scheme.trim() !== '' ? { scheme: auth.scheme.trim() } : {}),
          };
    case 'api-key': {
      const name = auth.name?.trim() ?? '';
      return auth.valueRef === undefined || name === ''
        ? undefined
        : { type: 'api-key', name, in: auth.in ?? 'header', valueRef: auth.valueRef };
    }
    default:
      return undefined;
  }
}

/** True when both are URLs on the same origin: the only case a stored credential is offered for. */
export function sameOrigin(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) {
    return false;
  }
  return new URL(a).origin === new URL(b).origin;
}

export interface DefinitionAuthFieldsProps {
  readonly auth: AuthConfigWire;
  readonly onChange: (auth: AuthConfigWire) => void;
  /** Receives the form's flush, which stores any secret typed but not saved; see {@link AuthFields}. */
  readonly registerFlush?: (flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => void;
}

/** The section: the scheme, its fields, and where the credentials are sent. */
export function DefinitionAuthFields({ auth, onChange, registerFlush }: DefinitionAuthFieldsProps) {
  return (
    <fieldset data-testid="definition-auth" className="flex flex-col gap-2">
      <legend className="text-xs font-medium text-fg-muted">Authentication</legend>
      <AuthFields
        scope="Definition"
        auth={auth}
        types={DEFINITION_AUTH_TYPES}
        preemptiveOption={false}
        // *Not configured* sends nothing either, so it reads as None rather than a second empty choice.
        onChange={(next) => onChange(next ?? NO_DEFINITION_AUTH)}
        {...(registerFlush !== undefined ? { registerFlush } : {})}
      />
      <p className="text-xs text-fg-subtle">
        Sent only to this URL’s own scheme, host and port — never to a redirect or a referenced document elsewhere.
      </p>
    </fieldset>
  );
}
```

- [ ] **Step 5: The Import dialog uses it**

In `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`, add `ApiAsyncApiServersRequest,` before
`AsyncApiImportSummaryWire,` (`:22`) and `AuthConfigWire,` after it in the `wire-types.js` type import; after
`import { Button } from '../../components/button.js';` (`:36`) add:

```tsx
import { DefinitionAuthFields, NO_DEFINITION_AUTH, toDefinitionAuthWire } from '../../components/definition-auth.js';
```

After `const [useForRequests, setUseForRequests] = useState(false);` (`:173`) add:

```tsx

  // OpenAPI and AsyncAPI by URL: the credentials the document is fetched with, as references.
  const [definitionAuth, setDefinitionAuth] = useState<AuthConfigWire>(NO_DEFINITION_AUTH);
  const definitionAuthFlushRef = useRef<(() => Promise<AuthConfigWire | undefined>) | undefined>(undefined);
  const registerDefinitionAuthFlush = useCallback((flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => {
    definitionAuthFlushRef.current = flush;
  }, []);
```

Replace `const asyncApiSourceKey = asyncApiSource === undefined ? '' : JSON.stringify(asyncApiSource);` (`:251`) with:

```tsx
  // The server picker reads the same document the import will, so it goes with the same credentials.
  const asyncApiAuth = tab === 'url' ? toDefinitionAuthWire(definitionAuth) : undefined;
  const asyncApiSourceKey =
    asyncApiSource === undefined
      ? ''
      : JSON.stringify({ source: asyncApiSource, ...(asyncApiAuth !== undefined ? { auth: asyncApiAuth } : {}) });
```

In the server-list effect, replace `const source = JSON.parse(asyncApiSourceKey) as OpenApiSourceWire;` (`:263`)
with `const request = JSON.parse(asyncApiSourceKey) as ApiAsyncApiServersRequest;` and `.api.asyncApiServers({ source })`
(`:265`) with `.api.asyncApiServers(request)`. In `reset`, after its `setWsServer('');` (`:304`) add
`setDefinitionAuth(NO_DEFINITION_AUTH);`.

In `onImport`, right after its `try {` (`:568`) add:

```tsx
      // Only a URL is fetched from anywhere, so only a URL carries credentials; a secret typed but not
      // yet saved is stored first, as the WSDL password is below.
      const definitionAuthWire =
        source.kind === 'url' && (targetFormat === 'openapi' || targetFormat === 'asyncapi')
          ? toDefinitionAuthWire((await definitionAuthFlushRef.current?.()) ?? definitionAuth)
          : undefined;
      const withDefinitionAuth = definitionAuthWire !== undefined ? { auth: definitionAuthWire } : {};

```

`targetFormat` and `source` are the ones `onImport` already computed above the `try`. Add `...withDefinitionAuth,`
as the last field of the `api.importOpenApi` request, after
`...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),` (`:613`), and of the `api.importAsyncApi`
request, after `...(name.trim().length > 0 ? { name: name.trim() } : {}),` below
`...(wsServers.length > 1 && wsServer !== '' ? { server: wsServer } : {}),` (`:641`).

After the URL error line `{urlError !== undefined && <p className="text-sm text-status-danger">{urlError}</p>}`
(`:886`) add:

```tsx

                    {(effectiveFormat === 'openapi' || effectiveFormat === 'asyncapi') && (
                      <DefinitionAuthFields
                        auth={definitionAuth}
                        onChange={setDefinitionAuth}
                        registerFlush={registerDefinitionAuthFlush}
                      />
                    )}
```

`OpenApiSourceWire` stays imported: `asyncApiSource` (`:245`) and `openApiSource` (`:620`) still use it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/auth-fields.test.tsx apps/desktop/test/renderer/definition-auth.test.ts apps/desktop/test/renderer/import-openapi-dialog.test.tsx apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx apps/desktop/test/renderer/import-dialog.test.tsx`
Expected: PASS, the existing import-dialog tests included (their sources carry no `auth`).

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/components/auth-fields.tsx apps/desktop/src/renderer/components/definition-auth.tsx \
  apps/desktop/src/renderer/features/explorer/import-dialog.tsx apps/desktop/test/renderer/auth-fields.test.tsx \
  apps/desktop/test/renderer/definition-auth.test.ts apps/desktop/test/renderer/import-openapi-dialog.test.tsx \
  apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx
git commit -m "feat(import): an Authentication section for OpenAPI and AsyncAPI by URL (#135)

The Import dialog offers None, Basic, Bearer and an API key under the URL, through the same AuthFields
the request editors use, without Basic's preemptive box since a definition fetch always sends it. A
secret typed but not saved is stored first on Import, and only the reference is sent; the AsyncAPI
server list is read with the same credentials."
```

---

## Task 7: the update dialogs

**Files:**
- Modify: `apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx:9-11`, `:15-18`, after `:84`, `:125`,
  `:130`, `:141-147`, `:295-296`, `:301`, `:311`, before `:326`
- Test: `apps/desktop/test/renderer/rest-update-dialog.test.tsx`, `apps/desktop/test/renderer/asyncapi-update-dialog.test.tsx`

**Interfaces:**
- Consumes: `DefinitionAuthFields`, `NO_DEFINITION_AUTH`, `sameOrigin`, `toDefinitionAuthWire` (Task 6);
  `RestApiWire['definition']['auth']` (Task 4); `auth` on a REST update URL source (Task 5).
- Produces: the REST chooser's Authentication section, prefilled with the stored credentials only while its URL is
  on the recorded source's origin; a `definition-auth-required` answer to a recorded-source plan opens the chooser
  on that URL with the message. The AsyncAPI dialog asks for nothing and needs no change: it shows the message as
  it shows any other error.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/renderer/rest-update-dialog.test.tsx`, insert before `describe('RestUpdateDialog', () => {`
(`:82`):

```tsx
/** Imported by URL behind Basic: the credentials Update Definition reuses without asking. */
const PROTECTED = restApiWire({
  id: 'protected',
  definition: {
    source: 'https://api.test/openapi.yaml',
    cache: true,
    version: '1.0.0',
    auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
  },
});

```

and before `it('applies once however often Apply is clicked', async () => {` (`:339`):

```tsx
  it('asks for nothing when the API records credentials: main reads the source with them', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: PROTECTED.id }));
    await screen.findByTestId('rest-update-added');
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

  it('offers the stored credentials for another URL on the same origin only', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);
    await screen.findByTestId('rest-update-added');
    fireEvent.click(screen.getByTestId('rest-update-choose'));
    const type = () => screen.getByLabelText<HTMLSelectElement>('Definition authentication type').value;
    expect(type()).toBe('none');

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/v2/openapi.yaml' } });
    expect(type()).toBe('basic');
    expect(screen.getByLabelText<HTMLInputElement>('Definition username').value).toBe('ada');
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({
        apiId: PROTECTED.id,
        source: {
          kind: 'url',
          url: 'https://api.test/v2/openapi.yaml',
          auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
        },
      }),
    );

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mirror.test/openapi.yaml' } });
    expect(type()).toBe('none');
    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith({
        apiId: PROTECTED.id,
        source: { kind: 'url', url: 'https://mirror.test/openapi.yaml' },
      }),
    );
  });

  it('opens the chooser on the recorded URL when it needs authentication, with the message', async () => {
    const message = 'The definition at https://api.test/openapi.yaml refused the credentials given (HTTP 401).';
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'definition-auth-required', message } })
      .mockResolvedValueOnce({ ok: true, value: PLAN });
    installWirebenchApi({ api: { restPlanUpdate: plan } });
    seed(PROTECTED);
    render(<RestUpdateDialog apiId={PROTECTED.id} open onOpenChange={vi.fn()} />);

    expect((await screen.findByTestId('rest-update-error')).textContent).toBe(message);
    expect(screen.getByTestId('rest-update-chooser')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('https://api.test/openapi.yaml');
    expect(screen.getByLabelText<HTMLSelectElement>('Definition authentication type').value).toBe('basic');

    fireEvent.click(screen.getByTestId('rest-update-url-preview'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(plan).toHaveBeenLastCalledWith({
      apiId: PROTECTED.id,
      source: {
        kind: 'url',
        url: 'https://api.test/openapi.yaml',
        auth: { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
      },
    });
  });

```

In `apps/desktop/test/renderer/asyncapi-update-dialog.test.tsx`, insert before
`it('says so when the source changed since the preview, and previews again on request', async () => {` (`:134`):

```tsx
  it('asks for nothing, and says so when the source needs credentials it was not given', async () => {
    const message = 'The definition at https://example.com/chat.yaml needs authentication (HTTP 401).';
    const plan = vi.fn().mockResolvedValue({ ok: false, error: { code: 'definition-auth-required', message } });
    installWirebenchApi({ api: { asyncApiPlanUpdate: plan } });

    renderCard();
    fireEvent.click(screen.getByTestId('asyncapi-definition-update'));

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: 'ws-api-1' }));
    expect((await screen.findByTestId('asyncapi-update-error')).textContent).toBe(message);
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/rest-update-dialog.test.tsx apps/desktop/test/renderer/asyncapi-update-dialog.test.tsx`
Expected: the two REST chooser tests FAIL (no `Definition authentication type` select; the recorded-source
refusal leaves the chooser shut). The "asks for nothing" tests already pass: they pin that the dialogs never ask
on their own.

- [ ] **Step 3: The chooser carries credentials**

In `apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx`, replace the header paragraph
(`:9-11`):

```tsx
 * The recorded source is read by default. An API imported from pasted text has none to read again
 * (`definition-source-unavailable`), so the dialog then asks for a file or URL; the same chooser is
 * offered for any API, to update from somewhere else.
```

with:

```tsx
 * The recorded source is read by default, with the credentials the API records for it, so nothing is
 * asked. An API imported from pasted text has none to read again (`definition-source-unavailable`), so
 * the dialog then asks for a file or URL; the same chooser is offered for any API, to update from
 * somewhere else. A source that answers `definition-auth-required` opens the chooser on itself, so the
 * credentials can be entered or fixed and previewed again.
```

After `import { Button } from '../../components/button.js';` (`:15`) add:

```tsx
import {
  DefinitionAuthFields,
  NO_DEFINITION_AUTH,
  sameOrigin,
  toDefinitionAuthWire,
} from '../../components/definition-auth.js';
```

and add `AuthConfigWire` to the `wire-types.js` type import (`:18`):

```tsx
import type { ApiRestPlanUpdateResponse, AuthConfigWire, RestUpdateSourceWire } from '../../../shared/wire-types.js';
```

After `const urlErrorId = useId();` (`:84`) add:

```tsx
  // The chooser's credentials. The stored ones are offered only while its URL is on the recorded
  // source's origin, so a stored credential is never sent to a new host unless the user picks it.
  const api = useProjectStore((state) => state.apis[apiId]);
  const recordedRef = useRef('');
  recordedRef.current = api?.definition?.source ?? '';
  const storedRef = useRef<AuthConfigWire | undefined>(undefined);
  storedRef.current = api?.definition?.auth;
  const [chooserAuth, setChooserAuth] = useState<AuthConfigWire>(NO_DEFINITION_AUTH);
  const offeredStored = useRef(false);
  const authFlush = useRef<(() => Promise<AuthConfigWire | undefined>) | undefined>(undefined);
  const registerAuthFlush = useCallback((flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => {
    authFlush.current = flush;
  }, []);

  /** Sets the chooser's URL, switching its credentials as it moves on or off the recorded origin. */
  const chooseUrl = useCallback((value: string): void => {
    setUrl(value);
    setUrlError(undefined);
    const stored = storedRef.current;
    const offer = stored !== undefined && sameOrigin(value.trim(), recordedRef.current);
    if (offer !== offeredStored.current) {
      offeredStored.current = offer;
      setChooserAuth(offer ? stored : NO_DEFINITION_AUTH);
    }
  }, []);
```

In `runPlan`, before its first `setError(result.error.message);` (`:125`) add:

```tsx
        if (result.error.code === 'definition-auth-required' && from === undefined) {
          // The recorded source wants credentials it was not given, or refused the stored ones: open the
          // chooser on it, so they can be entered or fixed and previewed again.
          setChoosing(true);
          chooseUrl(recordedRef.current);
        }
```

and change its dependency list `[apiId],` (`:130`) to `[apiId, chooseUrl],`. `from` is `runPlan`'s parameter, the
chosen source, `undefined` for the recorded one.

Replace `previewUrl` (`:141-147`):

```tsx
  function previewUrl(value: string): void {
    if (!/^https?:\/\//i.test(value)) {
      setUrlError('Only http and https URLs can be read.');
      return;
    }
    setUrlError(undefined);
    void runPlan({ kind: 'url', url: value });
  }
```

with:

```tsx
  async function previewUrl(value: string): Promise<void> {
    if (!/^https?:\/\//i.test(value)) {
      setUrlError('Only http and https URLs can be read.');
      return;
    }
    setUrlError(undefined);
    // A secret typed but not yet saved is stored first, so the preview goes with what is on screen.
    const auth = toDefinitionAuthWire((await authFlush.current?.()) ?? chooserAuth);
    await runPlan({ kind: 'url', url: value, ...(auth !== undefined ? { auth } : {}) });
  }
```

In the URL input, replace the two lines of its `onChange` (`:295-296`)

```tsx
                    setUrl(event.target.value);
                    setUrlError(undefined);
```

with `chooseUrl(event.target.value);`; make the Enter handler's `previewUrl(trimmedUrl);` (`:301`)
`void previewUrl(trimmedUrl);` and the Preview button's `onClick={() => previewUrl(trimmedUrl)}` (`:311`)
`onClick={() => void previewUrl(trimmedUrl)}`. Before the `<div>` holding the
`<Button data-testid="rest-update-browse" …>` (`:326`) add:

```tsx
              <DefinitionAuthFields auth={chooserAuth} onChange={setChooserAuth} registerFlush={registerAuthFlush} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/rest-update-dialog.test.tsx apps/desktop/test/renderer/asyncapi-update-dialog.test.tsx`
Expected: PASS, the existing chooser tests included: a URL off the recorded origin starts at None, so their
expected requests carry no `auth`.

- [ ] **Step 5: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx \
  apps/desktop/test/renderer/rest-update-dialog.test.tsx apps/desktop/test/renderer/asyncapi-update-dialog.test.tsx
git commit -m "feat(update): credentials in the REST update chooser (#135)

Update Definition asks for nothing when the API records credentials; main reads with them. The
chooser gains the Authentication section, prefilled with the stored credentials only while its URL is
on the recorded origin, so a stored secret is never sent to a new host unless picked. When the
recorded source needs authentication or refuses the stored credentials, the chooser opens on it with
the message, to fix them and preview again."
```

---

## Task 8: end to end, and the docs

**Files:**
- Create: `e2e/specs/definition-fetch-auth.spec.ts`
- Modify: `docs-site/src/content/docs/guides/importers.mdx`, `docs-site/src/content/docs/guides/asyncapi.mdx`,
  `docs-site/src/content/docs/guides/rest-client.mdx`, `CHANGELOG.md`, `docs/success-criteria.md`

**Interfaces:**
- Consumes: `TestRestServerDocument.auth` (Task 2), re-exported through `e2e/helpers/test-server.ts`; the
  `update` crafted fixture pair (`fixtures/openapi/crafted/update/petstore-update-{old,next}.yaml`); every task above.
- Produces: SC-D1–SC-D8 in `docs/success-criteria.md`, each row naming the tests that prove it.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/specs/definition-fetch-auth.spec.ts`:

```ts
/**
 * A definition behind authentication, end to end.
 *
 * The engine and IPC suites prove the fetcher, the storage and the reuse one layer at a time. What
 * only the real app can prove is the chain a user walks: an OpenAPI document imported by URL from a
 * server that demands Basic auth, the password typed once into the Import dialog and kept in the
 * keychain, and Update Definition reading the changed document from the same URL later without
 * asking for anything.
 *
 * Everything is local: the `update` crafted fixture pair is served by the in-process REST test
 * server behind its `/auth/basic` credentials (`u` / `p`), from a document map it reads live.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, openImportOpenApi, restRequestRow } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '../helpers/test-server.js';

const updateDir = fileURLToPath(new URL('../../fixtures/openapi/crafted/update/', import.meta.url));

/** One of the pair, read from disk, served only with the Basic credentials. */
function protectedFixture(name: string): TestRestServerDocument {
  return { body: readFileSync(join(updateDir, name), 'utf-8'), contentType: 'application/yaml', auth: 'basic' };
}

test.describe('A definition behind authentication', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let documents: Record<string, TestRestServerDocument> = {};

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    documents = {};
  });

  test('imports behind Basic auth, then updates from the same URL without asking again', async () => {
    documents = { '/secure/openapi.yaml': protectedFixture('petstore-update-old.yaml') };
    server = await startTestRestServer({ documents });
    const documentUrl = `${server.url}/secure/openapi.yaml`;

    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Definition auth');
    await createProject(page, 'Pets');

    // The Authentication section of the Import dialog: Basic, with the password saved to the keychain.
    await openImportOpenApi(page);
    const importDialog = page.getByTestId('import-openapi-dialog');
    await importDialog.getByTestId('import-openapi-url').fill(documentUrl);
    const section = importDialog.getByTestId('definition-auth');
    await section.getByLabel('Definition authentication type').selectOption('basic');
    await section.getByLabel('Definition username').fill('u');
    await section.getByRole('button', { name: 'Set…' }).click();
    await section.getByPlaceholder('Enter password').fill('p');
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('button', { name: 'Replace…' })).toBeVisible();
    await importDialog.getByTestId('import-openapi-submit').click();
    await expect(page.getByTestId('import-openapi-summary')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('import-openapi-done').click();
    await expect(importDialog).toBeHidden();

    await expect(apiRow(page, 'Petstore Update')).toBeVisible({ timeout: 20_000 });
    await expandExplorer(page, 'Delete a pet');
    await expect(restRequestRow(page, 'Delete a pet')).toBeVisible({ timeout: 20_000 });

    // The same URL now answers with the next document, still only to the right credentials.
    documents['/secure/openapi.yaml'] = protectedFixture('petstore-update-next.yaml');
    const before = server.requests.length;

    await chooseContextMenuItem(page, apiRow(page, 'Petstore Update'), 'Update Definition…');
    const dialog = page.getByTestId('rest-update-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-update-source')).toContainText(documentUrl, { timeout: 30_000 });
    await expect(page.getByTestId('rest-update-added')).toContainText('GET /owners', { timeout: 30_000 });
    await expect(page.getByTestId('rest-update-removed')).toContainText('DELETE /pets/{id}');
    // Nothing was asked for: no error, and the chooser with its Authentication section stayed shut.
    await expect(page.getByTestId('rest-update-error')).toHaveCount(0);
    await expect(dialog.getByTestId('definition-auth')).toHaveCount(0);
    // The preview went to the server with the stored credentials.
    const previewed = server.requests.slice(before).filter((request) => request.url === '/secure/openapi.yaml');
    expect(previewed.length).toBeGreaterThan(0);
    for (const request of previewed) {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    }

    await page.getByTestId('rest-update-apply').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('toast-viewport')).toContainText('1 added', { timeout: 20_000 });
    await expect(page.getByTestId('toast-viewport')).toContainText('1 orphaned');

    await expandExplorer(page, 'List owners');
    await expect(restRequestRow(page, 'List owners')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('explorer-orphaned-badge')).toHaveCount(1, { timeout: 20_000 });
  });
});
```

- [ ] **Step 2: Typecheck it (never launch Electron locally)**

Run: `nice pnpm exec tsc -p e2e/tsconfig.json --noEmit`
Expected: no errors. The spec runs in CI with the rest of e2e (`pnpm build && xvfb-run -a pnpm test:e2e`); do not
start it on this machine.

- [ ] **Step 3: The guides**

In `docs-site/src/content/docs/guides/importers.mdx`, replace the OpenAPI steps 2–3 and what follows them up to the
summary paragraph:

```mdx
2. Optionally set **Name** and **Base URL** overrides, and **Cache specification documents with the
   project** to keep a copy alongside the project.

3. Choose the target project and **Import**.

</Steps>
```

with:

```mdx
2. For a document behind authentication, fill in **Authentication** under the URL: **Basic**, a
   **Bearer token** or an **API key** in a header or the query string. The password, token or key is
   kept in your operating system's keychain; the project only records a reference to it.

3. Optionally set **Name** and **Base URL** overrides, and **Cache specification documents with the
   project** to keep a copy alongside the project.

4. Choose the target project and **Import**.

</Steps>

The credentials go only to the document's own origin — its scheme, host and port. A redirect or a
`$ref` to another origin is fetched without them, and a query key never appears in the recorded
source, a progress message or an error. A server that answers 401 or 403 is reported as needing
authentication, or as having refused the credentials given. The fetch uses the proxy and CA bundle
from your preferences. The same **Authentication** section appears for an AsyncAPI document by URL;
see [AsyncAPI](/wirebench/guides/asyncapi/#import-a-document).
```

In `docs-site/src/content/docs/guides/asyncapi.mdx`, replace the import steps 3–5:

```mdx
3. Optionally set a **Name** — by default the API is named after the document's title.
4. When the document declares more than one `ws` or `wss` server, pick one under
   **WebSocket server**. Its URL becomes the API's URL.
5. Choose **Import**.
```

with:

```mdx
3. For a document behind authentication, fill in **Authentication** under the URL: **Basic**, a
   **Bearer token** or an **API key**. The secret is kept in your keychain and only sent to the
   document's own origin; the server list is read with it too. See
   [OpenAPI](/wirebench/guides/importers/#openapi-and-swagger) for the details.
4. Optionally set a **Name** — by default the API is named after the document's title.
5. When the document declares more than one `ws` or `wss` server, pick one under
   **WebSocket server**. Its URL becomes the API's URL.
6. Choose **Import**.
```

and the update paragraph:

```mdx
When the document changes, open the API's tab and choose **Update definition…** in its
definition card. The source is read again and a preview lists **Added operations**, **Removed
operations** and **Changed operations**, each changed one with its reasons. Choose **Apply** to
take it.
```

with:

```mdx
When the document changes, open the API's tab and choose **Update definition…** in its
definition card. The source is read again — with the credentials it was imported with, if any,
without asking — and a preview lists **Added operations**, **Removed operations** and **Changed
operations**, each changed one with its reasons. Choose **Apply** to take it. If the source says it
needs authentication, the dialog shows that message.
```

In `docs-site/src/content/docs/guides/rest-client.mdx`, replace
`The dialog reads the source and previews, before anything changes:` with:

```mdx
The dialog reads the source and previews, before anything changes. A document imported with
**Authentication** is read again with the same credentials, from the keychain, without asking.
```

and insert before the paragraph starting `Apply carries a fingerprint of every document the preview read.`:

```mdx
Under the URL is the same **Authentication** section the Import dialog has. For a URL on the recorded
source's origin it starts with the stored credentials; for any other it starts at **None**, so a
stored credential is never sent to a new host unless you choose it. Applying from a URL records that
URL and the section's credentials (**None** clears them); applying from a file clears them. When the
recorded source answers that it needs authentication, or refuses the stored credentials, the dialog
opens this chooser on that URL with the message, so you can enter or fix them and preview again.

```

- [ ] **Step 4: The changelog and the success criteria**

In `CHANGELOG.md`, insert as the first entry under the unreleased heading, before
`- **Re-send and compare REST entries from History.**`:

```md
- **Definitions behind authentication.** Importing an OpenAPI or AsyncAPI document by URL offers an
  **Authentication** section: Basic, a bearer token, or an API key in a header or the query string.
  The secret is kept in the keychain and the project records only a reference, so Update Definition
  reads the document again later without asking. The credentials go only to the document's own
  origin, never to a redirect or a `$ref` elsewhere, and a query key never shows in the recorded
  source, progress or errors. A 401 or 403 says the definition needs authentication, or that the
  credentials were refused. **Choose another file or URL…** in the REST update offers the stored
  credentials for a URL on the same origin only; applying from a file clears them. Every OpenAPI and
  AsyncAPI fetch now uses the proxy and CA bundle from the preferences.

```

In `docs/success-criteria.md`, replace the sentence ending the intro's list of criteria sets:

```md
built by [`plans/2026-09-22-soap-owner-auth-plan.md`](plans/2026-09-22-soap-owner-auth-plan.md)). The SC1–SC13 rows stay about SOAP; nothing REST weakens them, and the whole SOAP
```

with:

```md
built by [`plans/2026-09-22-soap-owner-auth-plan.md`](plans/2026-09-22-soap-owner-auth-plan.md)), and SC-D1–SC-D8 for definitions behind authentication
([`specs/2026-09-26-definition-fetch-auth-design.md`](specs/2026-09-26-definition-fetch-auth-design.md), issue #135,
built by [`plans/2026-09-26-definition-fetch-auth-plan.md`](plans/2026-09-26-definition-fetch-auth-plan.md)). The SC1–SC13 rows stay about SOAP; nothing REST weakens them, and the whole SOAP
```

and add after the `| SC-O4 |` row:

```md
| SC-D1 | **Import behind auth** (definition auth, SC-A1) — an OpenAPI and an AsyncAPI document behind Basic, Bearer, a header API key and a query API key each import | `packages/engine/test/integration/http/document-fetch.test.ts` ("reads a document protected by %s"), `apps/desktop/test/openapi-import.test.ts`, `apps/desktop/test/ipc-api.test.ts` ("reads the document with them and records them on the placed API"), `apps/desktop/test/ipc-asyncapi.test.ts` ("records the credentials a URL was read with, as references only"), `apps/desktop/test/renderer/{import-openapi-dialog,import-dialog-asyncapi}.test.tsx`, `e2e/specs/definition-fetch-auth.spec.ts` | Met; e2e row proven in CI (not run locally) |
| SC-D2 | **References only** (SC-A2) — the project file holds only references; plaintext is refused on load and over IPC | `packages/engine/test/unit/project/schema.test.ts` ("a definition's fetch credentials"), `packages/engine/test/unit/project/{rest-format,ws-format}.test.ts`, `apps/desktop/test/definition-auth-wire.test.ts` | Met |
| SC-D3 | **Update without asking** (SC-A3) — Update Definition reads the recorded source again with the stored credentials | `apps/desktop/test/ipc-rest-update.test.ts` ("records them on import, and plans and applies with them without being given them again"), `apps/desktop/test/ipc-asyncapi.test.ts` ("plans and applies with the credentials the URL was imported with, without being given them"), `apps/desktop/test/renderer/rest-update-dialog.test.tsx`, `e2e/specs/definition-fetch-auth.spec.ts` | Met; e2e row proven in CI (not run locally) |
| SC-D4 | **Own origin only** (SC-A4) — credentials never reach another origin by redirect or `$ref`, and a query key never appears in a recorded source, a progress message or an error | `packages/engine/test/integration/http/document-fetch.test.ts` ("drops %s at a redirect to another origin", "sends credentials to a $ref sibling on the same origin, and not to one on another", "never shows a query key in the location or in an error") | Met |
| SC-D5 | **Typed refusal** (SC-A5) — a 401 or 403 answers `definition-auth-required`, saying whether credentials were sent | `packages/engine/test/integration/http/document-fetch.test.ts` ("says a document needs authentication when none was sent", "says the credentials were refused when wrong ones were sent"), `apps/desktop/test/renderer/{rest-update-dialog,asyncapi-update-dialog}.test.tsx` | Met |
| SC-D6 | **Proxy and CA bundle** (SC-A6) — every OpenAPI and AsyncAPI fetch uses the configured proxy and CA bundle | `packages/engine/test/integration/http/document-fetch.test.ts` ("goes through the proxy the host resolved for the URL", "trusts a server signed by the CA bundle the host resolved, and nothing else"), `apps/desktop/test/openapi-import.test.ts` ("passes the host's network options to every fetcher") | Met |
| SC-D7 | **Older files unchanged** (SC-A7) — a file written before this change loads and updates as before | `packages/engine/test/unit/project/rest-format.test.ts` ("loads a definition written without auth exactly as before"), `packages/engine/test/unit/project/schema.test.ts`, `apps/desktop/test/ipc-rest-update.test.ts` | Met |
| SC-D8 | **Changing the stored auth** (SC-A8) — choosing another URL can change the stored credentials, and a file source clears them | `apps/desktop/test/ipc-rest-update.test.ts` ("stores what a chosen URL was read with, and clears them for a URL given without any", "clears them when the update comes from a file"), `apps/desktop/test/renderer/rest-update-dialog.test.tsx` ("offers the stored credentials for another URL on the same origin only") | Met |
```

- [ ] **Step 5: Check the docs**

Run: `nice pnpm check:banned-terms && nice pnpm check:doc-paths`
Expected: both pass; every test path in the SC-D rows exists.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/specs/definition-fetch-auth.spec.ts docs-site/src/content/docs/guides/importers.mdx \
  docs-site/src/content/docs/guides/asyncapi.mdx docs-site/src/content/docs/guides/rest-client.mdx \
  CHANGELOG.md docs/success-criteria.md
git commit -m "docs: definitions behind authentication (#135)

The importer, AsyncAPI and REST client guides describe the Authentication section, the origin rule
and the update chooser; the changelog says what shipped; SC-D1 to SC-D8 name the tests behind each
acceptance criterion. The e2e spec walks an import behind Basic auth and an update from the same URL
that asks for nothing; it runs in CI."
```
