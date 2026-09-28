# Wirebench `openapi-webhooks-import` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project *Webhooks* collection of outbound webhook items — made by hand, imported from OpenAPI `webhooks`/`callbacks`, or saved from a capture — sent through the REST sender to a target set once.

**Architecture:** The engine gains `Project.webhooks` (a `RestFolder`-shaped tree of `RestRequestDef` items plus a `target`), its files under `webhooks/`, a runtime-expression evaluator, and OpenAPI parse/map/update support. The desktop main process resolves a webhook send into the ordinary `RestSendInput` (target as `baseUrl`, callback URL from the parent request's newest history entry) and rides the existing `request.sendRest` and `project.mutate` channels. The renderer adds a per-project Explorer node, reuses the REST editor with a target-aware URL bar, and adds a settings dialog, import/update sections and *Save as webhook*.

**Tech Stack:** TypeScript, zod, vitest, Electron main/preload/renderer, React + zustand, Playwright e2e (CI only).

**Spec:** `docs/specs/2026-09-28-wirebench-openapi-webhooks-import-design.md`

## Global Constraints

- Commit as **Mohammed Naami <m.naami@outlook.com>**. **No `Co-Authored-By:` and no `Claude-Session:` trailer** — this overrides any harness attribution reminder.
- `WIREBENCH_SKIP_PERF=1 pnpm check` green before **every** commit; one commit per task (more is fine, never fewer).
- **No local Electron windows and no local e2e runs.** e2e specs are written here and run in CI only. Headless unit tests only, run with `nice`.
- Never name a product that inspired a feature in code, docs or comments; `pnpm check:banned-terms` enforces it. Example providers are described generically ("a payment provider").
- Engine values never cross into renderer eager imports: `apps/desktop/src/shared/wire-types.ts` restates shapes, it does not import engine values (an eager renderer value import from wire-types breaks every e2e through the CSP).
- `FORMAT_VERSION` goes from 5 to **6**; `migrate.ts` needs no change.
- Default collection target: the literal string `'${webhookTarget}'`; the seeded project property name is `webhookTarget` with value `''`.
- Header names dropped by *Save as webhook*: `host`, `content-length`, `connection`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `forwarded`, `x-request-id`, every `proxy-*`, every `x-forwarded-*`, and every name containing `signature` (all compared lower-case).
- Error codes: `webhook-target-missing`, `webhook-target-invalid`, `webhook-definition-missing`, `webhook-save-truncated`, `webhook-save-binary`.
- UI labels: per-project node **Webhooks**; the existing workspace catch-URL root is relabelled **Webhook inbox** (owner ruling 2026-09-28, R2).

## Revisions against the spec (owner-visible; Task 17 records them in the spec)

- **R1 — import dialog selection.** The OpenAPI import dialog has no preview step (only AsyncAPI previews), so the dialog shows one checkbox *Import webhooks & callbacks* (ticked) before *Import*, and the result lists what was imported with *→ added to <project> ▸ Webhooks ▸ <API>*. Per-item ticking is offered by *Import webhooks…* on an existing API (which reads the cached definition first). Spec §3.4 otherwise unchanged.
- **R2 — naming.** The existing workspace root label *Webhooks* becomes *Webhook inbox*; the new per-project node is *Webhooks*. Internal kinds stay `webhooks`/`catch-url`; new kinds are `webhook-collection`, `webhook-folder`, `webhook-request`.
- **R3 — CLI/runner.** `run/select.ts` selects webhook items as REST items against a synthetic API whose `baseUrl` is the item's effective target. The runner has no history, so a callback always uses the target fallback there.
- **R4 — callback exchange.** A callback expression is evaluated against the parent request's newest REST history entry: request URL = `entry.endpoint`, method = `entry.method`, request headers = `entry.request.headers`, request body = `entry.request.envelopeXml`, response status/headers/body = `entry.response.status` / `rawHeaders` / `envelopeXml`. `$request.path.<name>` matches the parent's `contract.path` template against the endpoint path.
- **R5 — wire.** Webhook folders and requests travel to the renderer as `RestFolderWire` / `RestRequestWire` rows whose `apiId` is the collection id `webhooks:<projectId>`, plus a `webhooks` wire per project. The REST editor and the REST mutations therefore work on them with small, explicit branches.
- **R6 — hook key.** Update matches imported items by `hookKey`: `webhook <name> <method>` or `callback <operation> <name> <method>` (the expression is refreshed on merge, not part of the key).

---

## File Structure

Engine (`packages/engine/src/`):
- `webhooks/model.ts` — **new**: `WebhookCollection`, `WebhookFolder`, `HookLink`, factories, walkers, `effectiveTarget`, `hookKey`, `WEBHOOKS_COLLECTION_PREFIX`.
- `rest/model.ts` — `RestRequestDef.hook?`, `CreateRestRequestInput.hook?`.
- `project/model.ts` — `Project.webhooks?`, `FORMAT_VERSION = 6`.
- `project/paths.ts` — `WEBHOOKS_DIR`, `WEBHOOKS_FILE`.
- `project/schema.ts` — `webhooksFileSchema`, `webhookFolderFileSchema`, `hookLinkSchema`, `hook` on `restRequestFileSchema`.
- `project/serialize.ts`, `project/load.ts`, `project/save.ts` — the `webhooks/` tree.
- `project/request-location.ts`, `secrets/scan/walk.ts`, `secrets/scan/apply.ts`, `run/select.ts` — walkers.
- `rest/openapi/runtime-expression.ts` — **new**: parse + evaluate.
- `rest/openapi/model.ts`, `parse.ts` — `webhooks`, `callbacks`.
- `rest/openapi/map.ts` — `requestFromOperation` (extracted), `webhooksFromDocument`, `webhookItemsOf`.
- `rest/openapi/update.ts` — `planWebhookUpdate`, `applyWebhookUpdate`.
- `rest/openapi/import.ts` — returns the `webhooks` group.
- `index.ts` — exports.

Fixtures: `fixtures/openapi/crafted/webhooks/openapi.yaml`, `fixtures/openapi/crafted/update/webhooks-old.yaml`, `webhooks-next.yaml`.

Desktop main (`apps/desktop/src/main/`):
- `project-webhook-mutations.ts` — **new**: ensure collection, add request/folder, settings, folder target, import group.
- `project-rest-mutations.ts` — webhook-tree branches in update/remove/clone/move/folder ops; `removeApi` clears `source`.
- `project-mutations.ts` — new `change.kind` cases.
- `project-wire.ts` — `webhooks` wire.
- `webhook-send.ts` — **new**: `resolveWebhookSend`, `callbackUrlFor`.
- `history-service.ts` — `newestFor(projectId, requestId)`.
- `project-host.ts` — `restSend`, `restMeta`, auth chain, preflight for webhook ids; import/update integration.
- `ipc/api.ts` — `importOpenApi` option `webhooks`, `api.webhookItems`, `api.importWebhooks`, plan/apply include webhooks.

Shared: `apps/desktop/src/shared/wire-types.ts`, `shared/ipc.ts`.

Renderer (`apps/desktop/src/renderer/`):
- `state/project.ts` — `webhooks` per project, actions.
- `features/explorer/tree-nodes.ts`, `context-menu.tsx`, `explorer-actions.ts`.
- `features/webhook-items/` — **new** folder (not `features/webhooks/`, which is the inbox): `webhook-settings-dialog.tsx`, `webhook-url-note.tsx`, `save-as-webhook-dialog.tsx`, `save-as-webhook.ts`, `import-webhooks-dialog.tsx`, `webhook-items-state.ts`.
- `features/rest-editor/url-bar.tsx`, `rest-editor.tsx` — target-aware variant.
- `features/explorer/import-dialog.tsx`, `features/rest-api/rest-update-dialog.tsx`.
- `features/webhooks/capture-viewer.tsx`, `catch-url-tab.tsx` — *Save as webhook…* button.

e2e: `e2e/specs/webhooks-send.spec.ts`; `e2e/specs/server-webhooks.spec.ts` (inbox label).

Docs: `docs-site/src/content/docs/guides/sending-webhooks.mdx` (**new**), `guides/webhooks.mdx`, `guides/importers.mdx`, `docs-site/astro.config.mjs`, `CHANGELOG.md`, the spec.

---

### Task 1: Engine webhook model

**Files:**
- Create: `packages/engine/src/webhooks/model.ts`
- Modify: `packages/engine/src/rest/model.ts` (`RestRequestDef`, `CreateRestRequestInput`, `createRestRequest`)
- Modify: `packages/engine/src/project/model.ts` (`Project`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/webhooks/model.test.ts`

**Interfaces:**
- Produces:
  - `type HookLink = { kind: 'webhook'; name: string } | { kind: 'callback'; operation: string; name: string; expression: string }`
  - `interface WebhookFolder extends Omit<RestFolder, 'folders'> { target?: string; source?: { apiId: string }; folders: readonly WebhookFolder[] }`
  - `interface WebhookCollection { target: string; auth?: AuthConfig; folders: readonly WebhookFolder[]; requests: readonly RestRequestDef[] }`
  - `DEFAULT_WEBHOOK_TARGET = '${webhookTarget}'`, `WEBHOOK_TARGET_PROPERTY = 'webhookTarget'`, `WEBHOOKS_COLLECTION_PREFIX = 'webhooks:'`
  - `createWebhookCollection(input?)`, `createWebhookFolder(name, input?)`
  - `webhookRequests(c)`, `webhookFolders(c)`, `findWebhookRequest(c, id)`, `webhookPath(c, id): { request; chain: WebhookFolder[] } | undefined`
  - `effectiveTarget(c, chain): string` (nearest folder `target` from the leaf up, else `c.target`)
  - `hookKey(link: HookLink, method: string): string` (R6)
  - `RestRequestDef.hook?: HookLink`; `Project.webhooks?: WebhookCollection`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/webhooks/model.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBHOOK_TARGET,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  effectiveTarget,
  findWebhookRequest,
  hookKey,
  webhookFolders,
  webhookPath,
  webhookRequests,
} from '../../../src/index.js';

function collection() {
  const inner = createWebhookFolder('Inner', {
    id: 'f2',
    requests: [createRestRequest('Deep', { id: 'r3', method: 'POST', url: '/deep' })],
  });
  const group = createWebhookFolder('Petstore API', {
    id: 'f1',
    target: '${petstoreTarget}',
    source: { apiId: 'api-1' },
    folders: [inner],
    requests: [
      createRestRequest('newPet', {
        id: 'r2',
        method: 'POST',
        url: '/newPet',
        hook: { kind: 'webhook', name: 'newPet' },
      }),
    ],
  });
  return createWebhookCollection({
    folders: [group],
    requests: [createRestRequest('order.created', { id: 'r1', method: 'POST', url: '/orders' })],
  });
}

describe('webhook collection', () => {
  it('defaults its target to the webhookTarget property', () => {
    expect(createWebhookCollection().target).toBe(DEFAULT_WEBHOOK_TARGET);
    expect(DEFAULT_WEBHOOK_TARGET).toBe('${webhookTarget}');
  });

  it('walks requests and folders depth-first', () => {
    const c = collection();
    expect(webhookRequests(c).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(webhookFolders(c).map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(findWebhookRequest(c, 'r3')?.name).toBe('Deep');
    expect(findWebhookRequest(c, 'nope')).toBeUndefined();
  });

  it('resolves the target from the nearest folder that sets one', () => {
    const c = collection();
    expect(effectiveTarget(c, webhookPath(c, 'r1')!.chain)).toBe('${webhookTarget}');
    expect(effectiveTarget(c, webhookPath(c, 'r2')!.chain)).toBe('${petstoreTarget}');
    // f2 sets none, so f1's wins.
    expect(effectiveTarget(c, webhookPath(c, 'r3')!.chain)).toBe('${petstoreTarget}');
  });

  it('keeps the hook link on a created request', () => {
    const request = createRestRequest('x', { hook: { kind: 'webhook', name: 'x' } });
    expect(request.hook).toEqual({ kind: 'webhook', name: 'x' });
    expect(createRestRequest('y').hook).toBeUndefined();
  });

  it('keys hooks by kind, name and method, never by the expression', () => {
    expect(hookKey({ kind: 'webhook', name: 'newPet' }, 'POST')).toBe('webhook newPet post');
    expect(
      hookKey({ kind: 'callback', operation: 'post /subscriptions', name: 'onPetEvent', expression: '{$url}' }, 'post'),
    ).toBe('callback post /subscriptions onPetEvent post');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/model.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Implement**

In `packages/engine/src/rest/model.ts`, import the type and extend the request:

```ts
import type { HookLink } from '../webhooks/model.js';
```

Inside `RestRequestDef`, after `contract?`:

```ts
  /**
   * Set only on an item of a project's webhook collection that was imported from an OpenAPI
   * `webhooks` or `callbacks` entry: which one, so *Update definition* can keep it in step.
   */
  readonly hook?: HookLink;
```

Inside `CreateRestRequestInput`: `readonly hook?: HookLink;` and in `createRestRequest`, after the `contract` spread:

```ts
    ...(input.hook !== undefined ? { hook: { ...input.hook } } : {}),
```

Create `packages/engine/src/webhooks/model.ts`:

```ts
/**
 * A project's webhook collection: outbound requests that play a provider calling the user's own
 * receiver (spec `2026-09-28-wirebench-openapi-webhooks-import-design.md` §4). Items are ordinary
 * REST requests; the collection and its folders carry a *target* where an API carries a base URL.
 */
import type { AuthConfig, CreateOptions } from '../project/model.js';
import { generateId } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { RestFolder, RestRequestDef } from '../rest/model.js';

/** The link from an imported item back to the OpenAPI entry it came from. */
export type HookLink =
  | { readonly kind: 'webhook'; readonly name: string }
  | {
      readonly kind: 'callback';
      /** The parent operation's contract key, e.g. `post /subscriptions`. */
      readonly operation: string;
      readonly name: string;
      /** The callback's path-item key, verbatim, e.g. `{$request.body#/callbackUrl}`. */
      readonly expression: string;
    };

/** A folder of the webhook collection: a REST folder that may override the target. */
export interface WebhookFolder extends Omit<RestFolder, 'folders'> {
  /** Overrides the inherited target for everything inside; the nearest folder that sets one wins. */
  readonly target?: string;
  /** Set on a group imported from an API's definition: that API, so its update can find the group. */
  readonly source?: { readonly apiId: string };
  readonly folders: readonly WebhookFolder[];
}

/** One project's webhook collection. */
export interface WebhookCollection {
  /** Where items are sent; may contain `${…}` properties. */
  readonly target: string;
  /** What items (and folders) whose auth is `inherit` end up using. */
  readonly auth?: AuthConfig;
  readonly folders: readonly WebhookFolder[];
  readonly requests: readonly RestRequestDef[];
}

/** The target a new collection starts with. */
export const DEFAULT_WEBHOOK_TARGET = '${webhookTarget}';
/** The project property a new collection seeds, empty, when the project has none by that name. */
export const WEBHOOK_TARGET_PROPERTY = 'webhookTarget';
/** Prefix of the id the desktop gives a project's collection on the wire: `webhooks:<projectId>`. */
export const WEBHOOKS_COLLECTION_PREFIX = 'webhooks:';

export interface CreateWebhookCollectionInput {
  readonly target?: string;
  readonly auth?: AuthConfig;
  readonly folders?: readonly WebhookFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates an empty collection aimed at {@link DEFAULT_WEBHOOK_TARGET}. */
export function createWebhookCollection(input: CreateWebhookCollectionInput = {}): WebhookCollection {
  return {
    target: input.target ?? DEFAULT_WEBHOOK_TARGET,
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

export interface CreateWebhookFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly target?: string;
  readonly source?: { readonly apiId: string };
  readonly folders?: readonly WebhookFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates a webhook folder. */
export function createWebhookFolder(name: string, input: CreateWebhookFolderInput = {}): WebhookFolder {
  return {
    id: input.id ?? (input.newId ?? generateId)(),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.source !== undefined ? { source: { apiId: input.source.apiId } } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

type Tree = Pick<WebhookCollection, 'folders' | 'requests'>;

/** Every request of the collection, root first, then each folder depth-first. */
export function webhookRequests(tree: Tree): RestRequestDef[] {
  return [...tree.requests, ...tree.folders.flatMap((folder) => webhookRequests(folder))];
}

/** Every folder of the collection, depth-first. */
export function webhookFolders(tree: Tree): WebhookFolder[] {
  return tree.folders.flatMap((folder) => [folder, ...webhookFolders(folder)]);
}

/** The request with `id`, and the folders from the root down to it. */
export function webhookPath(
  tree: Tree,
  id: string,
): { readonly request: RestRequestDef; readonly chain: readonly WebhookFolder[] } | undefined {
  const request = tree.requests.find((candidate) => candidate.id === id);
  if (request !== undefined) return { request, chain: [] };
  for (const folder of tree.folders) {
    const found = webhookPath(folder, id);
    if (found !== undefined) return { request: found.request, chain: [folder, ...found.chain] };
  }
  return undefined;
}

/** The request with `id`, anywhere in the collection. */
export function findWebhookRequest(tree: Tree, id: string): RestRequestDef | undefined {
  return webhookPath(tree, id)?.request;
}

/** The target an item under `chain` (root → leaf folders) is sent to, before property expansion. */
export function effectiveTarget(collection: Pick<WebhookCollection, 'target'>, chain: readonly WebhookFolder[]): string {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const target = chain[index]?.target;
    if (target !== undefined) return target;
  }
  return collection.target;
}

/** The key *Update definition* matches an imported item by: kind, name, method — never the URL. */
export function hookKey(link: HookLink, method: string): string {
  const verb = method.toLowerCase();
  return link.kind === 'webhook'
    ? `webhook ${link.name} ${verb}`
    : `callback ${link.operation} ${link.name} ${verb}`;
}
```

In `packages/engine/src/project/model.ts`, import `import type { WebhookCollection } from '../webhooks/model.js';` and add to `Project` after `sequences`:

```ts
  /**
   * The project's webhook collection (spec `…-openapi-webhooks-import-design.md`), absent until the
   * first webhook is created or imported. Not a list like the API containers: one per project.
   */
  readonly webhooks?: WebhookCollection;
```

In `packages/engine/src/index.ts`, beside the `rest/model.js` block:

```ts
export {
  DEFAULT_WEBHOOK_TARGET,
  WEBHOOKS_COLLECTION_PREFIX,
  WEBHOOK_TARGET_PROPERTY,
  createWebhookCollection,
  createWebhookFolder,
  effectiveTarget,
  findWebhookRequest,
  hookKey,
  webhookFolders,
  webhookPath,
  webhookRequests,
} from './webhooks/model.js';
export type {
  CreateWebhookCollectionInput,
  CreateWebhookFolderInput,
  HookLink,
  WebhookCollection,
  WebhookFolder,
} from './webhooks/model.js';
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): webhook collection model"
```

---

### Task 2: Engine files for `webhooks/` and format 6

**Files:**
- Modify: `packages/engine/src/project/paths.ts`, `schema.ts`, `serialize.ts`, `load.ts`, `save.ts`, `model.ts` (`FORMAT_VERSION`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/project/webhooks-format.test.ts`; update `packages/engine/test/unit/project/format-migration.test.ts` if it pins `5`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `WEBHOOKS_DIR = 'webhooks'`, `WEBHOOKS_FILE = 'webhooks.yaml'`, `webhooksFileSchema`, `webhookFolderFileSchema`, `hookLinkSchema`; `projectFiles` writes and `loadProject` reads `project.webhooks`; `FORMAT_VERSION === 6`.

Design notes for the implementer (from reading the code):
- `addFolderFiles` (serialize.ts) writes `folder.yaml` from a fixed object, and `loadFolderContents` (load.ts) parses `folder.yaml` with a hard-coded `restFolderFileSchema`. Add an **optional folder hook** to each, defaulting to today's behaviour, so the webhook tree can write and read `target`/`source`: `addFolderFiles(files, dir, node, depth, writeRequest, folderExtra?: (folder) => Record<string, unknown>)` spreading `folderExtra?.(folder)` into the `compact({...})` object; `loadFolderContents(fs, root, dir, depth, problems, readRequest, folderExtra?: (document: unknown, relative: string) => Record<string, unknown>)` spreading its result into the pushed folder. Recursion passes the hook down.
- `hook` on a request: add `hook: hookLinkSchema.optional()` to `restRequestFileSchema`; `restRequestDocument` writes it; `restRequestReader` reads it. **Outside `webhooks/`** a `hook` is rejected: `loadApi`'s REST branch uses a reader wrapper that throws `ProjectError('project-file-invalid', …)` when the request has a hook. The default folder hook ignores `target`/`source` (they never load under `apis/`); the webhook folder hook is used only under `webhooks/`.
- Save: `listManagedFiles` adds `webhooks/webhooks.yaml` (when present) and `listApiTreeFiles(fs, root, 'webhooks/requests')`. Removing `project.webhooks` removes those files through the ordinary diff.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/project/webhooks-format.test.ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  loadProject,
  projectFiles,
  saveProject,
} from '../../../src/index.js';
import type { Project } from '../../../src/index.js';
import { tempProjectDir } from './fixture.js';

function webhookProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    properties: { webhookTarget: '' },
    webhooks: createWebhookCollection({
      target: '${webhookTarget}',
      requests: [
        createRestRequest('order.created', {
          id: 'r1',
          slug: 'order-created',
          method: 'POST',
          url: '/orders',
          body: { kind: 'raw', language: 'json', text: '{ "event": "order.created" }' },
        }),
      ],
      folders: [
        createWebhookFolder('Petstore API', {
          id: 'f1',
          slug: 'petstore-api',
          target: '${petstoreTarget}',
          source: { apiId: 'api-1' },
          requests: [
            createRestRequest('newPet', {
              id: 'r2',
              slug: 'new-pet',
              method: 'POST',
              url: '/newPet',
              hook: { kind: 'webhook', name: 'newPet' },
            }),
            createRestRequest('onPetEvent', {
              id: 'r3',
              slug: 'on-pet-event',
              method: 'POST',
              url: '/onPetEvent',
              hook: {
                kind: 'callback',
                operation: 'post /subscriptions',
                name: 'onPetEvent',
                expression: '{$request.body#/callbackUrl}',
              },
            }),
          ],
        }),
      ],
    }),
  };
}

describe('the webhooks/ tree', () => {
  it('is format 6', () => {
    expect(FORMAT_VERSION).toBe(6);
  });

  it('writes webhooks.yaml and a request tree beside it', () => {
    const files = projectFiles(webhookProject());
    expect([...files.keys()].filter((key) => key.startsWith('webhooks/')).sort()).toEqual([
      'webhooks/requests/order-created.body.json',
      'webhooks/requests/order-created.request.yaml',
      'webhooks/requests/petstore-api/folder.yaml',
      'webhooks/requests/petstore-api/new-pet.request.yaml',
      'webhooks/requests/petstore-api/on-pet-event.request.yaml',
      'webhooks/webhooks.yaml',
    ]);
    expect(files.get('webhooks/webhooks.yaml')).toContain('${webhookTarget}');
    expect(files.get('webhooks/requests/petstore-api/folder.yaml')).toContain('apiId: api-1');
    expect(files.get('webhooks/requests/petstore-api/new-pet.request.yaml')).toContain('kind: webhook');
  });

  it('writes nothing under webhooks/ for a project without a collection', () => {
    const files = projectFiles(createProject('Plain', { id: 'p2' }));
    expect([...files.keys()].some((key) => key.startsWith('webhooks/'))).toBe(false);
  });

  it('round-trips, byte-stable', async () => {
    const dir = await tempProjectDir();
    await saveProject(webhookProject(), dir);
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.webhooks).toEqual(webhookProject().webhooks);
    const again = await saveProject(project, dir);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the files when the collection goes', async () => {
    const dir = await tempProjectDir();
    await saveProject(webhookProject(), dir);
    const { webhooks, ...rest } = webhookProject();
    void webhooks;
    const result = await saveProject(rest as Project, dir);
    expect(result.removed.filter((file) => file.startsWith('webhooks/')).length).toBe(6);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a hook on a request under apis/', async () => {
    const dir = await tempProjectDir();
    await saveProject(createProject('Plain', { id: 'p3' }), dir);
    await mkdir(join(dir, 'apis/a/requests'), { recursive: true });
    await writeFile(join(dir, 'apis/a/api.yaml'), 'kind: rest\nid: a1\nname: A\norder: 0\nbaseUrl: ""\n');
    await writeFile(
      join(dir, 'apis/a/requests/x.request.yaml'),
      'kind: rest\nid: x1\nname: X\norder: 0\nmethod: GET\nurl: /\nhook: { kind: webhook, name: x }\n',
    );
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });
});
```

(`saveProject`'s result fields `written`/`removed` are the ones `rest-format.test.ts` asserts; if the remove count differs because `saveProject` reports removed paths differently, assert on the six paths by name instead.)

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/project/webhooks-format.test.ts`
Expected: FAIL (format is 5; no `webhooks/` files).

- [ ] **Step 3: Implement**

`paths.ts`, beside `APIS_DIR`:

```ts
/** Directory holding the project's webhook collection (`webhooks.yaml` and a `requests/` tree). */
export const WEBHOOKS_DIR = 'webhooks';
/** File describing the webhook collection: its target and default credentials. */
export const WEBHOOKS_FILE = 'webhooks.yaml';
```

`schema.ts`:

```ts
/** A request's link to the OpenAPI `webhooks`/`callbacks` entry it was imported from. */
export const hookLinkSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('webhook'), name: nonEmpty }),
  z.looseObject({
    kind: z.literal('callback'),
    operation: nonEmpty,
    name: nonEmpty,
    expression: z.string(),
  }),
]);

/** `webhooks/webhooks.yaml`. */
export const webhooksFileSchema = z.looseObject({
  target: z.string(),
  auth: authConfigSchema.optional(),
});

/** `webhooks/requests/[<folder>/…]folder.yaml`: a REST folder plus a target override and its source API. */
export const webhookFolderFileSchema = restFolderFileSchema.extend({
  target: z.string().optional(),
  source: z.looseObject({ apiId: nonEmpty }).optional(),
});
```

and in `restRequestFileSchema` after `contract`:

```ts
  /** Only under `webhooks/`: the imported `webhooks`/`callbacks` entry; refused elsewhere by the loader. */
  hook: hookLinkSchema.optional(),
```

Export the three schemas from `index.ts` in the `project/schema.js` block, and `WEBHOOKS_DIR`, `WEBHOOKS_FILE` in the `project/paths.js` block.

`model.ts`: `export const FORMAT_VERSION = 6;` and append to its doc comment: `6 added the project's webhook collection under \`webhooks/\` and \`hook\` on a request.`

`serialize.ts`:
- `restRequestDocument`: add `hook: request.hook === undefined ? undefined : { ...request.hook },` after `contract`.
- `addFolderFiles`: add the optional `folderExtra` parameter and spread `...(folderExtra?.(folder) ?? {})` into the `compact({...})` object; pass `folderExtra` in the recursive call.
- New function, called in `projectFiles` after the `wsApis` loop:

```ts
/** The webhook collection's files: `webhooks/webhooks.yaml` and the request tree under it. */
function addWebhookFiles(files: Map<string, string>, webhooks: WebhookCollection): void {
  files.set(
    `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`,
    stringifyYaml(
      compact({
        target: webhooks.target,
        auth: webhooks.auth === undefined ? undefined : authDocument(webhooks.auth),
      }),
    ),
  );
  addFolderFiles<RestRequestDef>(
    files,
    `${WEBHOOKS_DIR}/${REQUESTS_DIR}`,
    webhooks,
    0,
    writeRestRequest,
    (folder) => {
      const hook = folder as Partial<WebhookFolder>;
      return {
        target: hook.target,
        source: hook.source === undefined ? undefined : { apiId: hook.source.apiId },
      };
    },
  );
}
```

```ts
  if (project.webhooks !== undefined) {
    addWebhookFiles(files, project.webhooks);
  }
```

`load.ts`:
- `restRequestReader` returns `...(parsed.hook !== undefined ? { hook: exact<HookLink>(parsed.hook) } : {})`.
- A reader for `apis/` that refuses a hook:

```ts
/** A REST request under `apis/`: the same as {@link restRequestReader}, but a `hook` has no place there. */
function apiRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<RestRequestDef> {
  const read = restRequestReader(fs, root, problems);
  return async (dir, fileName, unclaimed) => {
    const request = await read(dir, fileName, unclaimed);
    if (request.hook !== undefined) {
      const file = `${dir}/${fileName}`;
      throw new ProjectError('project-file-invalid', `Invalid project file ${file}: hook is only allowed under ${WEBHOOKS_DIR}/`, {
        details: { file, issues: [{ path: 'hook', message: `only allowed under ${WEBHOOKS_DIR}/` }] },
      });
    }
    return request;
  };
}
```

  Use it in `loadApi`'s REST (`default:`) branch instead of `restRequestReader`.
- `loadFolderContents`: add the optional `folderExtra` parameter; spread `...(folderExtra?.(document, relative) ?? {})` into the pushed folder; pass it down.
- New loader, called from `loadProject` after the APIs; the assembled project gets `...(webhooks !== undefined ? { webhooks } : {})`:

```ts
/** Loads `webhooks/`, or nothing when the project has no `webhooks.yaml`. */
async function loadWebhooks(fs: FsLike, root: string, problems: ProjectProblem[]): Promise<WebhookCollection | undefined> {
  const relative = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  const document = await readYaml(fs, root, relative);
  if (document === undefined) return undefined;
  const parsed = parseFile(webhooksFileSchema, document, relative);
  const contents = await loadFolderContents(
    fs,
    root,
    `${WEBHOOKS_DIR}/${REQUESTS_DIR}`,
    0,
    problems,
    restRequestReader(fs, root, problems),
    (folderDocument, folderFile) => {
      if (folderDocument === undefined) return {};
      const folder = parseFile(webhookFolderFileSchema, folderDocument, folderFile);
      return {
        ...optional('target', folder.target),
        ...(folder.source !== undefined ? { source: { apiId: folder.source.apiId } } : {}),
      };
    },
  );
  return {
    target: parsed.target,
    ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
    folders: contents.folders as unknown as WebhookFolder[],
    requests: contents.requests,
  };
}
```

`save.ts` `listManagedFiles`, after the `APIS_DIR` loop (and add two bullets to its doc comment):

```ts
  const webhooksFile = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  if ((await readFileIfExists(fs, toAbsolute(root, webhooksFile))) !== undefined) {
    managed.push(webhooksFile);
  }
  managed.push(...(await listApiTreeFiles(fs, root, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`)));
```

If `format-migration.test.ts` asserts `formatVersion: 5` literally, change it to `FORMAT_VERSION`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/project`
Expected: PASS, including the existing REST/gRPC/WS format tests.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): store the webhook collection under webhooks/ (format 6)"
```

---

### Task 3: Engine walkers join the collection

**Files:**
- Modify: `packages/engine/src/project/request-location.ts`
- Modify: `packages/engine/src/secrets/scan/walk.ts`, `packages/engine/src/secrets/scan/apply.ts`
- Modify: `packages/engine/src/run/select.ts`
- Create: `packages/engine/test/unit/webhooks/fixture.ts`
- Test: extend `packages/engine/test/unit/project/request-location.test.ts`, `test/unit/secrets/scan/scan.test.ts`, `test/unit/secrets/scan/apply.test.ts`, `test/unit/run/select.test.ts`

**Interfaces:**
- Consumes: Task 1 (`webhookPath`, `effectiveTarget`), Task 2 (`WEBHOOKS_DIR`).
- Produces: `requestFileLocation` finds webhook items (`dir: 'webhooks/requests[/<folder>…]'`); `scanTargets` yields webhook requests (labels prefixed `Webhooks`); `applySecretMoves` rewrites them; `selectRequests` candidates include webhook items as `kind: 'rest'` with a synthetic API (R3); `findStepRequest` answers `{ kind: 'unsupported', reason: 'A webhook cannot be a sequence step' }` for a webhook item.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/webhooks/fixture.ts
import {
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  entry,
} from '../../../src/index.js';
import type { Project } from '../../../src/index.js';

export function hooksProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    webhooks: createWebhookCollection({
      target: 'https://receiver.test/hooks',
      requests: [
        createRestRequest('Ping', {
          id: 'w1',
          slug: 'ping',
          method: 'POST',
          url: '/ping',
          headers: [entry('Authorization', 'Bearer abc123def456ghi789')],
        }),
      ],
      folders: [
        createWebhookFolder('Group', {
          id: 'g1',
          slug: 'group',
          target: 'https://other.test',
          requests: [createRestRequest('Inner', { id: 'w2', slug: 'inner', method: 'POST', url: '/inner' })],
        }),
      ],
    }),
  };
}
```

Cases (add to the named files; read one existing case in each file first and mirror its call shapes — `selectRequests` options, `SecretMove` fields, the finding's `location.kind` for a REST header):

```ts
// request-location.test.ts
it('locates a webhook item under webhooks/requests', () => {
  expect(requestFileLocation(hooksProject(), 'w1')).toEqual({ dir: 'webhooks/requests', slug: 'ping' });
  expect(requestFileLocation(hooksProject(), 'w2')).toEqual({ dir: 'webhooks/requests/group', slug: 'inner' });
});

// scan.test.ts
it('scans webhook items like REST requests', () => {
  const findings = scanProjectForSecrets(hooksProject());
  expect(findings.some((finding) => finding.label.startsWith('Webhooks'))).toBe(true);
});

// apply.test.ts
it('moves a secret out of a webhook item', () => {
  const project = hooksProject();
  const [finding] = scanProjectForSecrets(project).filter((f) => f.label.startsWith('Webhooks'));
  const result = applySecretMoves(project, [{ finding: finding!, name: 'hookToken' }]);
  expect(result.project.webhooks?.requests[0]?.headers[0]?.value).toContain('hookToken');
});

// select.test.ts
it('selects webhook items against their effective target', () => {
  const selected = selectRequests(hooksProject(), {});
  const hooks = selected.filter((item) => item.kind === 'rest' && item.group.startsWith('Webhooks'));
  expect(hooks.map((item) => (item.kind === 'rest' ? [item.request.id, item.api.baseUrl] : []))).toEqual([
    ['w1', 'https://receiver.test/hooks'],
    ['w2', 'https://other.test'],
  ]);
});

it('refuses a webhook item as a sequence step', () => {
  expect(findStepRequest(hooksProject(), 'w1')).toEqual({
    kind: 'unsupported',
    reason: 'A webhook cannot be a sequence step',
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run packages/engine/test/unit/project/request-location.test.ts packages/engine/test/unit/secrets packages/engine/test/unit/run/select.test.ts`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement**

`request-location.ts`, after the `project.apis` loop:

```ts
  if (project.webhooks !== undefined) {
    const base = `${WEBHOOKS_DIR}/${REQUESTS_DIR}`;
    const root = project.webhooks.requests.find((request) => request.id === requestId);
    if (root !== undefined) return { dir: base, slug: root.slug };
    const found = findInFolders(project.webhooks.folders as unknown as readonly RestFolder[], base, requestId);
    if (found !== undefined) return found;
  }
```

`walk.ts` `scanTargets`, after the REST loop:

```ts
  if (project.webhooks !== undefined) yield* tree(project.webhooks, 'Webhooks', restRequest);
```

`apply.ts` `applySecretMoves`, inside the `patch(project, {...})` object:

```ts
    webhooks:
      project.webhooks === undefined
        ? undefined
        : mapTree(project.webhooks, (request: RestRequestDef) => restRequest(rw, request)),
```

`select.ts` — in `candidates()`, after the container loop:

```ts
  if (project.webhooks !== undefined) walkWebhooks(project.webhooks, out);
```

```ts
/**
 * The project's webhook items, as REST items against a synthetic API whose base URL is each item's
 * effective target (plan R3). A run has no history, so a callback uses the target.
 */
function walkWebhooks(collection: WebhookCollection, out: Candidate[]): void {
  const visit = (
    folders: readonly WebhookFolder[],
    requests: readonly RestRequestDef[],
    chain: readonly WebhookFolder[],
  ): void => {
    const group = ['Webhooks', ...chain.map((folder) => folder.name)].join('/');
    const dir = [WEBHOOKS_DIR, REQUESTS_DIR, ...chain.map((folder) => folder.slug)].join('/');
    const api = createApi('Webhooks', {
      id: 'webhooks',
      slug: 'webhooks',
      baseUrl: effectiveTarget(collection, chain),
      ...(collection.auth !== undefined ? { auth: collection.auth } : {}),
    });
    for (const request of [...requests].sort(byOrder)) {
      if (request.orphaned === true) continue;
      out.push({
        item: {
          kind: 'rest',
          path: `${group}/${request.name}`,
          group,
          api,
          chain: chain as unknown as readonly RestFolder[],
          request,
        },
        diskPath: `${dir}/${request.slug}`,
      });
    }
    for (const folder of [...folders].sort(byOrder)) visit(folder.folders, folder.requests, [...chain, folder]);
  };
  visit(collection.folders, collection.requests, []);
}
```

In `findStepRequest`, before the final `missing` return:

```ts
  if (project.webhooks !== undefined && findInTree(project.webhooks, requestId) !== undefined) {
    return { kind: 'unsupported', reason: 'A webhook cannot be a sequence step' };
  }
```

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): walk the webhook collection for location, secrets and runs"
```

---

### Task 4: Runtime expressions

**Files:**
- Create: `packages/engine/src/rest/openapi/runtime-expression.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/rest/openapi/runtime-expression.test.ts`

**Interfaces:**
- Produces:
  - `parseRuntimeExpression(text)`, `parseRuntimeTemplate(key): readonly TemplatePart[] | undefined` (`undefined` = does not parse)
  - `interface RuntimeExchange { url; method; pathTemplate?; request: { headers: [string,string][]; body? }; response?: { status; headers; body? } }`
  - `evaluateRuntimeTemplate(key, exchange): { ok: true; value: string } | { ok: false; reason: string }`
  - `resolveJsonPointer(value, pointer): unknown` (`undefined` when absent)

Grammar (OpenAPI 3.x *Runtime Expressions*): `$url` | `$method` | `$statusCode` | `$request.` source | `$response.` source; source = `header.<token>` | `query.<name>` (request only) | `path.<name>` (request only) | `body` [`#` json-pointer]. A template is literal text with `{expression}` parts.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/rest/openapi/runtime-expression.test.ts
import { describe, expect, it } from 'vitest';
import { evaluateRuntimeTemplate, parseRuntimeTemplate, resolveJsonPointer } from '../../../../src/index.js';
import type { RuntimeExchange } from '../../../../src/index.js';

const exchange: RuntimeExchange = {
  url: 'https://api.test/subscriptions/42?mode=push&email=a%40b.test',
  method: 'POST',
  pathTemplate: '/subscriptions/{id}',
  request: {
    headers: [['X-Callback', 'https://cb.test/h'], ['Content-Type', 'application/json']],
    body: JSON.stringify({ callbackUrl: 'https://my-app.dev/subs/cb-91', 'a/b': { 'c~d': 'x' }, list: ['zero', 'one'] }),
  },
  response: {
    status: 201,
    headers: [['Location', 'https://api.test/subscriptions/42']],
    body: JSON.stringify({ id: 'sub_1', hook: { url: 'https://resp.test/cb' } }),
  },
};

const value = (key: string) => {
  const result = evaluateRuntimeTemplate(key, exchange);
  return result.ok ? result.value : `!${result.reason}`;
};

describe('runtime expressions', () => {
  it('reads the fixed sources', () => {
    expect(value('{$url}')).toBe('https://api.test/subscriptions/42?mode=push&email=a%40b.test');
    expect(value('{$method}')).toBe('POST');
    expect(value('{$statusCode}')).toBe('201');
  });

  it('reads request and response headers, case-insensitively', () => {
    expect(value('{$request.header.x-callback}')).toBe('https://cb.test/h');
    expect(value('{$response.header.location}')).toBe('https://api.test/subscriptions/42');
  });

  it('reads query and path parameters of the request', () => {
    expect(value('{$request.query.email}')).toBe('a@b.test');
    expect(value('{$request.path.id}')).toBe('42');
  });

  it('reads bodies through a JSON pointer, with ~0 and ~1 escapes and array indexes', () => {
    expect(value('{$request.body#/callbackUrl}')).toBe('https://my-app.dev/subs/cb-91');
    expect(value('{$request.body#/a~1b/c~0d}')).toBe('x');
    expect(value('{$request.body#/list/1}')).toBe('one');
    expect(value('{$response.body#/hook/url}')).toBe('https://resp.test/cb');
  });

  it('fills templates that mix text and expressions', () => {
    expect(value('https://notify.test/cb?id={$response.body#/id}&m={$method}')).toBe(
      'https://notify.test/cb?id=sub_1&m=POST',
    );
  });

  it('says why a value is missing', () => {
    expect(value('{$request.body#/nope}')).toBe('!$request.body#/nope has no value');
    expect(value('{$request.header.missing}')).toBe('!$request.header.missing has no value');
    expect(evaluateRuntimeTemplate('{$response.body#/id}', { ...exchange, response: undefined }).ok).toBe(false);
  });

  it('does not parse what the grammar does not allow', () => {
    expect(parseRuntimeTemplate('{$response.query.x}')).toBeUndefined();
    expect(parseRuntimeTemplate('{$request.cookie.x}')).toBeUndefined();
    expect(parseRuntimeTemplate('{unclosed')).toBeUndefined();
    expect(parseRuntimeTemplate('plain text')).toEqual([{ kind: 'text', text: 'plain text' }]);
    expect(evaluateRuntimeTemplate('{nonsense}', exchange)).toEqual({ ok: false, reason: 'not a runtime expression' });
  });

  it('resolves pointers on plain values', () => {
    expect(resolveJsonPointer({ a: [{ b: 1 }] }, '/a/0/b')).toBe(1);
    expect(resolveJsonPointer({ a: 1 }, '')).toEqual({ a: 1 });
    expect(resolveJsonPointer({ a: 1 }, '/b')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi/runtime-expression.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/rest/openapi/runtime-expression.ts
/**
 * OpenAPI runtime expressions: the `{$request.body#/callbackUrl}` in a callback's key. Parsed once,
 * evaluated against one recorded exchange of the parent operation. Anything the grammar does not
 * allow is "not a runtime expression" — never an exception.
 */

export type RuntimeSource =
  | { readonly kind: 'header'; readonly name: string }
  | { readonly kind: 'query'; readonly name: string }
  | { readonly kind: 'path'; readonly name: string }
  | { readonly kind: 'body'; readonly pointer: string };

export type RuntimeExpression =
  | { readonly kind: 'url' }
  | { readonly kind: 'method' }
  | { readonly kind: 'statusCode' }
  | { readonly kind: 'request'; readonly source: RuntimeSource }
  | { readonly kind: 'response'; readonly source: RuntimeSource };

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expression'; readonly source: string; readonly expression: RuntimeExpression };

/** The exchange an expression is evaluated against: the parent operation's last request and reply. */
export interface RuntimeExchange {
  readonly url: string;
  readonly method: string;
  /** The parent's templated path (`/subscriptions/{id}`), for `$request.path.<name>`. */
  readonly pathTemplate?: string;
  readonly request: { readonly headers: readonly (readonly [string, string])[]; readonly body?: string };
  readonly response?: {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body?: string;
  };
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseSource(text: string, request: boolean): RuntimeSource | undefined {
  if (text === 'body') return { kind: 'body', pointer: '' };
  if (text.startsWith('body#')) {
    const pointer = text.slice('body#'.length);
    return pointer === '' || pointer.startsWith('/') ? { kind: 'body', pointer } : undefined;
  }
  const dot = text.indexOf('.');
  if (dot < 0) return undefined;
  const where = text.slice(0, dot);
  const name = text.slice(dot + 1);
  if (name === '') return undefined;
  if (where === 'header') return TOKEN.test(name) ? { kind: 'header', name } : undefined;
  if (request && (where === 'query' || where === 'path')) return { kind: where, name };
  return undefined;
}

/** Parses one expression without its braces: `$url`, `$request.body#/a`… */
export function parseRuntimeExpression(text: string): RuntimeExpression | undefined {
  if (text === '$url') return { kind: 'url' };
  if (text === '$method') return { kind: 'method' };
  if (text === '$statusCode') return { kind: 'statusCode' };
  for (const kind of ['request', 'response'] as const) {
    const prefix = `$${kind}.`;
    if (text.startsWith(prefix)) {
      const source = parseSource(text.slice(prefix.length), kind === 'request');
      return source === undefined ? undefined : { kind, source };
    }
  }
  return undefined;
}

/** Splits a callback key into literal text and `{expression}` parts; `undefined` when it does not parse. */
export function parseRuntimeTemplate(key: string): readonly TemplatePart[] | undefined {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < key.length) {
    const open = key.indexOf('{', index);
    if (open < 0) {
      parts.push({ kind: 'text', text: key.slice(index) });
      break;
    }
    if (open > index) parts.push({ kind: 'text', text: key.slice(index, open) });
    const close = key.indexOf('}', open);
    if (close < 0) return undefined;
    const source = key.slice(open + 1, close);
    const expression = parseRuntimeExpression(source);
    if (expression === undefined) return undefined;
    parts.push({ kind: 'expression', source, expression });
    index = close + 1;
  }
  return parts;
}

/** RFC 6901: `''` is the whole value; `~1` is `/`, `~0` is `~`. `undefined` when there is nothing there. */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function headerOf(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([candidate]) => candidate.toLowerCase() === lower)?.[1];
}

function pathParam(url: string, template: string | undefined, name: string): string | undefined {
  if (template === undefined) return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const names: string[] = [];
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((piece) => {
      const param = /^\{([^}]+)\}$/.exec(piece);
      if (param !== null) {
        names.push(param[1] as string);
        return '([^/]+)';
      }
      return piece.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    })
    .join('');
  const match = new RegExp(`${pattern}$`).exec(path);
  const at = names.indexOf(name);
  const found = match === null || at < 0 ? undefined : match[at + 1];
  return found === undefined ? undefined : decodeURIComponent(found);
}

function bodyValue(body: string | undefined, pointer: string): string | undefined {
  if (body === undefined) return undefined;
  if (pointer === '') return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const found = resolveJsonPointer(parsed, pointer);
  if (found === undefined || found === null) return undefined;
  return typeof found === 'string' ? found : JSON.stringify(found);
}

function evaluate(expression: RuntimeExpression, exchange: RuntimeExchange): string | undefined {
  switch (expression.kind) {
    case 'url':
      return exchange.url;
    case 'method':
      return exchange.method;
    case 'statusCode':
      return exchange.response === undefined ? undefined : String(exchange.response.status);
    case 'request':
    case 'response': {
      const side = expression.kind === 'request' ? exchange.request : exchange.response;
      if (side === undefined) return undefined;
      const source = expression.source;
      switch (source.kind) {
        case 'header':
          return headerOf(side.headers, source.name);
        case 'body':
          return bodyValue(side.body, source.pointer);
        case 'query':
          try {
            return new URL(exchange.url).searchParams.get(source.name) ?? undefined;
          } catch {
            return undefined;
          }
        case 'path':
          return pathParam(exchange.url, exchange.pathTemplate, source.name);
      }
    }
  }
}

/** Fills a callback key from `exchange`. */
export function evaluateRuntimeTemplate(
  key: string,
  exchange: RuntimeExchange,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const parts = parseRuntimeTemplate(key);
  if (parts === undefined) return { ok: false, reason: 'not a runtime expression' };
  let value = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      value += part.text;
      continue;
    }
    const found = evaluate(part.expression, exchange);
    if (found === undefined) return { ok: false, reason: `${part.source} has no value` };
    value += found;
  }
  return { ok: true, value };
}
```

Export from `index.ts`:

```ts
export {
  evaluateRuntimeTemplate,
  parseRuntimeExpression,
  parseRuntimeTemplate,
  resolveJsonPointer,
} from './rest/openapi/runtime-expression.js';
export type {
  RuntimeExchange,
  RuntimeExpression,
  RuntimeSource,
  TemplatePart,
} from './rest/openapi/runtime-expression.js';
```

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): evaluate OpenAPI runtime expressions"
```

---

### Task 5: Parse OpenAPI `webhooks` and `callbacks`

**Files:**
- Modify: `packages/engine/src/rest/openapi/model.ts`, `parse.ts`
- Create: `fixtures/openapi/crafted/webhooks/openapi.yaml`
- Modify: `packages/engine/test/unit/rest/openapi/parse.test.ts` (the `v31` case that asserts webhooks/callbacks are skipped)
- Test: `packages/engine/test/unit/rest/openapi/parse-webhooks.test.ts`

**Interfaces:**
- Produces in `model.ts`:

```ts
/** A root `webhooks` entry (OpenAPI 3.1+): its name and one operation per method. */
export interface OpenApiHook {
  readonly name: string;
  /** Each operation's `path` is the hook's name; `method` is lower-case. */
  readonly operations: readonly OpenApiOperation[];
}

/** One `callbacks` entry of an operation: its name, its path-item key, and that item's operations. */
export interface OpenApiCallback {
  readonly name: string;
  /** The path-item key verbatim, e.g. `{$request.body#/callbackUrl}`. */
  readonly expression: string;
  /** Each operation's `path` is the expression. */
  readonly operations: readonly OpenApiOperation[];
}
```

  `OpenApiDocument.webhooks?: readonly OpenApiHook[]` (optional so every hand-built test document stays valid) and `OpenApiOperation.callbacks?: readonly OpenApiCallback[]`. Export both types from `index.ts` with the other OpenAPI model types.

- [ ] **Step 1: Write the fixture and the failing test**

`fixtures/openapi/crafted/webhooks/openapi.yaml`:

```yaml
openapi: 3.1.0
info: { title: Petstore API, version: 1.0.0 }
servers: [{ url: https://api.petstore.test }]
paths:
  /subscriptions:
    post:
      operationId: createSubscription
      tags: [Subscriptions]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                callbackUrl: { type: string, format: uri }
      responses: { '201': { description: Created } }
      callbacks:
        onPetEvent:
          '{$request.body#/callbackUrl}':
            post:
              requestBody:
                content:
                  application/json:
                    schema:
                      type: object
                      properties:
                        event: { type: string, example: pet.updated }
                        petId: { type: integer, example: 42 }
              responses: { '200': { description: Received } }
        broken:
          '{$nope}':
            post:
              responses: { '200': { description: ok } }
webhooks:
  newPet:
    post:
      summary: A pet was added
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [id, name]
              properties:
                id: { type: integer, example: 7 }
                name: { type: string, example: Rex }
      responses: { '200': { description: Received } }
    put:
      operationId: newPetReplayed
      responses: { '200': { description: Received } }
  x-internal: { post: { responses: { '200': { description: ok } } } }
```

```ts
// packages/engine/test/unit/rest/openapi/parse-webhooks.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocumentText, parseOpenApiDocument } from '../../../../src/index.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));
const parse = (text: string) => parseOpenApiDocument(parseDocumentText(text));
const crafted = (name: string) => parse(readFileSync(`${craftedDir}${name}/openapi.yaml`, 'utf-8'));

describe('webhooks and callbacks', () => {
  const document = crafted('webhooks');

  it('reads root webhooks, one operation per method, named by the hook', () => {
    expect(document.webhooks?.map((hook) => hook.name)).toEqual(['newPet']);
    const [hook] = document.webhooks ?? [];
    expect(hook?.operations.map((op) => [op.method, op.path])).toEqual([
      ['post', 'newPet'],
      ['put', 'newPet'],
    ]);
    expect(hook?.operations[0]?.requestBody?.content['application/json']).toBeDefined();
  });

  it('reads an operation’s callbacks with their expressions verbatim', () => {
    const create = document.operations.find((op) => op.operationId === 'createSubscription');
    expect(create?.callbacks?.map((cb) => [cb.name, cb.expression, cb.operations.map((op) => op.method)])).toEqual([
      ['onPetEvent', '{$request.body#/callbackUrl}', ['post']],
      ['broken', '{$nope}', ['post']],
    ]);
  });

  it('no longer lists webhooks or callbacks as skipped; extensions still are', () => {
    const kinds = document.skipped.map((entry) => entry.kind);
    expect(kinds).not.toContain('webhook');
    expect(kinds).not.toContain('callback');
    expect(document.skipped).toContainEqual({
      kind: 'extension',
      where: '/webhooks/x-internal',
      reason: 'vendor extensions are not imported',
    });
  });

  it('keeps a 3.0 document’s root webhooks skipped, with the reason', () => {
    const old = parse(
      'openapi: 3.0.3\ninfo: { title: T, version: "1" }\npaths: {}\nwebhooks:\n  a: { post: { responses: {} } }\n',
    );
    expect(old.webhooks ?? []).toEqual([]);
    expect(old.skipped).toContainEqual({ kind: 'webhook', where: '/webhooks/a', reason: 'webhooks need OpenAPI 3.1' });
  });

  it('still reports links as skipped', () => {
    const withLinks = parse(
      'openapi: 3.1.0\ninfo: { title: T, version: "1" }\npaths:\n  /a:\n    get:\n      links: { x: {} }\n      responses: {}\n',
    );
    expect(withLinks.skipped.map((entry) => entry.kind)).toContain('link');
  });
});
```

Use the same import of `parseDocumentText` that the existing `parse.test.ts` uses (copy it exactly if it comes from a different path). In `parse.test.ts`'s `v31` case, replace the skipped-kinds assertions with:

```ts
    expect(kinds).not.toContain('webhook');
    expect(kinds).not.toContain('callback');
    expect(kinds).toContain('extension');
    expect(document.webhooks?.map((hook) => hook.name)).toEqual(['petCreated']);
    expect(document.operations[0]?.callbacks?.[0]?.name).toBe('onDone');
```

and drop the `webhook?.where` assertion.

- [ ] **Step 2: Run and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi/parse-webhooks.test.ts packages/engine/test/unit/rest/openapi/parse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`parse.ts`:
- `IGNORED_ROOT_KEYS` loses `webhooks` (keeps `callbacks` — a *root* `callbacks` key is valid in no version — and `links`).
- Extract the per-path-item method loop out of `parseOperations` into `parsePathItemOperations(key: string, item: Record_, skipped: OpenApiSkipped[]): OpenApiOperation[]` (it holds the fixed-method dispatch and the 3.2 `additionalOperations` handling, calling `parseOperation(method, key, operation, shared, skipped)` with `shared` from the item's own `parameters`), and have `parseOperations` call it per path. `parseOperations`' behaviour must not change (the existing parse tests prove it).
- Root webhooks:

```ts
function parseWebhooks(value: unknown, version: OpenApiVersion, skipped: OpenApiSkipped[]): readonly OpenApiHook[] {
  if (!isRecord(value)) return [];
  const hooks: OpenApiHook[] = [];
  for (const [name, item] of Object.entries(value)) {
    if (name.startsWith('x-')) {
      skipped.push({ kind: 'extension', where: `/webhooks/${name}`, reason: 'vendor extensions are not imported' });
      continue;
    }
    if (version === '3.0') {
      skipped.push({ kind: 'webhook', where: `/webhooks/${name}`, reason: 'webhooks need OpenAPI 3.1' });
      continue;
    }
    if (!isRecord(item)) {
      skipped.push({ kind: 'webhook', where: `/webhooks/${name}`, reason: 'not a path item' });
      continue;
    }
    hooks.push({ name, operations: parsePathItemOperations(name, item, skipped) });
  }
  return hooks;
}
```

  In `parseOpenApiDocument` (3.x branch): `const webhooks = parseWebhooks(document['webhooks'], version, skipped);` and in the returned object `...(webhooks.length > 0 ? { webhooks } : {})`.
- In `parseOperation`, the key loop pushes a skipped entry for `links` only. Parse callbacks:

```ts
function parseCallbacks(value: unknown, where: string, skipped: OpenApiSkipped[]): readonly OpenApiCallback[] {
  if (!isRecord(value)) return [];
  const callbacks: OpenApiCallback[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (name.startsWith('x-') || !isRecord(entry)) continue;
    for (const [expression, item] of Object.entries(entry)) {
      if (expression.startsWith('x-')) continue;
      if (!isRecord(item)) {
        skipped.push({ kind: 'callback', where: `${where} ${name}`, reason: 'not a path item' });
        continue;
      }
      callbacks.push({ name, expression, operations: parsePathItemOperations(expression, item, skipped) });
    }
  }
  return callbacks;
}
```

  and in the returned operation `...(callbacks.length > 0 ? { callbacks } : {})` with `const callbacks = parseCallbacks(operation['callbacks'], where, skipped);`. A callback operation's own nested `callbacks` parse the same way and are ignored by the mapper.

- [ ] **Step 4: Run and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi`
Expected: PASS (all OpenAPI tests).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine fixtures/openapi/crafted
git commit -m "feat(engine): parse OpenAPI webhooks and callbacks"
```

---

### Task 6: Map webhooks and callbacks into a webhook group

**Files:**
- Modify: `packages/engine/src/rest/openapi/map.ts`, `import.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/rest/openapi/map-webhooks.test.ts`

**Interfaces:**
- Consumes: Task 1 (`createWebhookFolder`, `HookLink`, `hookKey`), Task 5 (`OpenApiHook`, `OpenApiCallback`).
- Produces:
  - `interface WebhookItemRef { key; kind: 'webhook' | 'callback'; name; method; operation?; expression?; label }` — `key` is `hookKey(...)`; `label` is `newPet`, `newPet (PUT)` for a later method, or `onPetEvent · createSubscription`.
  - `webhookItemsOf(document): WebhookItemRef[]` — root webhooks first, then each operation's callbacks in operation order; one per method.
  - `webhookSourcesOf(document): { ref: WebhookItemRef; operation: OpenApiOperation; link: HookLink }[]` — exported for `update.ts`, doc-commented as internal to the OpenAPI modules.
  - `webhooksFromDocument(document, options: MapWebhooksOptions): { folder: WebhookFolder; items: number } | undefined` where `MapWebhooksOptions extends MapApiOptions { apiId: string; only?: ReadonlySet<string> }` — `undefined` when nothing is chosen. Folder name = `options.name ?? info.title` (the API's rule), `source.apiId = options.apiId`, no `target`.
  - `OpenApiImportSummary.webhooks: number` — set by `apiFromDocument` to `webhookItemsOf(document).length`.
  - `ImportOpenApiOptions` gains `webhooks?: boolean; apiId?: string`; `ImportedOpenApi.webhooks?: WebhookFolder`.

Item rules:
- Built by `requestFromOperation(operation, order, taken, context, overrides?)` — the body of today's `buildRequest` closure moved to module level (`MapContext = { document; options; newId; skipped; counts: { requests: number; deprecated: number } }`). `apiFromDocument` must produce an identical API (the existing map tests prove it).
- With `overrides = { name, url, hook }`: the request's name is `overrides.name`, `url` is `overrides.url`, `hook` is set, `pathParams` is `[]` and there is **no** `contract`.
- Slugs unique within the group via `uniqueSlug`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/rest/openapi/map-webhooks.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  apiFromDocument,
  parseDocumentText,
  parseOpenApiDocument,
  webhookItemsOf,
  webhooksFromDocument,
} from '../../../../src/index.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));
const document = parseOpenApiDocument(
  parseDocumentText(readFileSync(`${craftedDir}webhooks/openapi.yaml`, 'utf-8')),
);
let n = 0;
const newId = () => `id${String((n += 1))}`;

describe('webhook items of a document', () => {
  it('lists every webhook and callback method, in document order', () => {
    expect(webhookItemsOf(document).map((item) => [item.key, item.label])).toEqual([
      ['webhook newPet post', 'newPet'],
      ['webhook newPet put', 'newPet (PUT)'],
      ['callback post /subscriptions onPetEvent post', 'onPetEvent · createSubscription'],
      ['callback post /subscriptions broken post', 'broken · createSubscription'],
    ]);
  });
});

describe('webhooksFromDocument', () => {
  it('builds one group named after the API, linked to it', () => {
    const mapped = webhooksFromDocument(document, { apiId: 'api-1', newId, sampleValues: true });
    expect(mapped?.items).toBe(4);
    const folder = mapped!.folder;
    expect(folder.name).toBe('Petstore API');
    expect(folder.source).toEqual({ apiId: 'api-1' });
    expect(folder.target).toBeUndefined();
    const [newPet, replay, onPetEvent] = folder.requests;
    expect([newPet?.method, newPet?.url, newPet?.hook]).toEqual(['POST', '/newPet', { kind: 'webhook', name: 'newPet' }]);
    expect(newPet?.contract).toBeUndefined();
    expect(newPet?.body.kind).toBe('raw');
    expect(newPet?.body.kind === 'raw' ? JSON.parse(newPet.body.text) : undefined).toMatchObject({ id: 7, name: 'Rex' });
    expect(replay?.name).toBe('newPet (PUT)');
    expect(new Set(folder.requests.map((r) => r.slug)).size).toBe(folder.requests.length);
    expect(onPetEvent?.hook).toEqual({
      kind: 'callback',
      operation: 'post /subscriptions',
      name: 'onPetEvent',
      expression: '{$request.body#/callbackUrl}',
    });
    expect(onPetEvent?.url).toBe('/onPetEvent');
  });

  it('keeps only the selected items', () => {
    const mapped = webhooksFromDocument(document, { apiId: 'api-1', newId, only: new Set(['webhook newPet post']) });
    expect(mapped?.folder.requests.map((r) => r.name)).toEqual(['newPet']);
    expect(webhooksFromDocument(document, { apiId: 'a', newId, only: new Set() })).toBeUndefined();
  });

  it('counts them in the API summary without changing the API', () => {
    const { api, summary } = apiFromDocument(document, { newId });
    expect(summary.webhooks).toBe(4);
    expect(api.folders.flatMap((f) => f.requests).every((r) => r.hook === undefined)).toBe(true);
  });
});
```

(If the sampler does not use `example` values with `sampleValues: true`, read `sample.ts` and use the option that does; the assertion on `{ id: 7, name: 'Rex' }` is the point.)

- [ ] **Step 2: Run and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi/map-webhooks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `map.ts`, after extracting `requestFromOperation` and `MapContext` as described:

```ts
/** One webhook or callback method a document offers, keyed as *Update definition* matches it. */
export interface WebhookItemRef {
  readonly key: string;
  readonly kind: 'webhook' | 'callback';
  readonly name: string;
  readonly method: string;
  readonly operation?: string;
  readonly expression?: string;
  readonly label: string;
}

/** A document's webhook and callback methods with their operations. Internal to the OpenAPI modules. */
export function webhookSourcesOf(
  document: OpenApiDocument,
): { readonly ref: WebhookItemRef; readonly operation: OpenApiOperation; readonly link: HookLink }[] {
  const sources: { ref: WebhookItemRef; operation: OpenApiOperation; link: HookLink }[] = [];
  const named = (name: string, method: string, first: boolean) => (first ? name : `${name} (${method.toUpperCase()})`);
  for (const hook of document.webhooks ?? []) {
    hook.operations.forEach((operation, index) => {
      const link: HookLink = { kind: 'webhook', name: hook.name };
      sources.push({
        operation,
        link,
        ref: {
          key: hookKey(link, operation.method),
          kind: 'webhook',
          name: hook.name,
          method: operation.method,
          label: named(hook.name, operation.method, index === 0),
        },
      });
    });
  }
  for (const parent of document.operations) {
    const parentKey = `${parent.method.toLowerCase()} ${parent.path}`;
    const parentLabel = parent.operationId ?? `${parent.method.toUpperCase()} ${parent.path}`;
    for (const callback of parent.callbacks ?? []) {
      callback.operations.forEach((operation, index) => {
        const link: HookLink = { kind: 'callback', operation: parentKey, name: callback.name, expression: callback.expression };
        sources.push({
          operation,
          link,
          ref: {
            key: hookKey(link, operation.method),
            kind: 'callback',
            name: callback.name,
            method: operation.method,
            operation: parentKey,
            expression: callback.expression,
            label: `${named(callback.name, operation.method, index === 0)} · ${parentLabel}`,
          },
        });
      });
    }
  }
  return sources;
}

/** Every webhook and callback method `document` offers, in document order. */
export function webhookItemsOf(document: OpenApiDocument): WebhookItemRef[] {
  return webhookSourcesOf(document).map((source) => source.ref);
}

export interface MapWebhooksOptions extends MapApiOptions {
  /** The API the group is linked to. */
  readonly apiId: string;
  /** Keys ({@link WebhookItemRef.key}) to keep; all when absent. */
  readonly only?: ReadonlySet<string>;
}

/** The document's webhooks and callbacks as one group for the project's webhook collection. */
export function webhooksFromDocument(
  document: OpenApiDocument,
  options: MapWebhooksOptions,
): { readonly folder: WebhookFolder; readonly items: number } | undefined {
  const chosen = webhookSourcesOf(document).filter((source) => options.only?.has(source.ref.key) ?? true);
  if (chosen.length === 0) return undefined;
  const newId = options.newId ?? generateId;
  const context: MapContext = { document, options, newId, skipped: [], counts: { requests: 0, deprecated: 0 } };
  const taken = new Set<string>();
  const requests = chosen.map((source, index) => {
    const name = source.ref.kind === 'callback' ? (source.ref.label.split(' · ')[0] as string) : source.ref.label;
    const request = requestFromOperation(source.operation, index, taken, context, {
      name,
      url: `/${source.ref.name}`,
      hook: source.link,
    });
    taken.add(request.slug);
    return request;
  });
  const title = document.info.title.trim();
  const name = options.name?.trim() ?? (title.length > 0 ? title : 'API');
  return {
    folder: createWebhookFolder(name, { id: newId(), source: { apiId: options.apiId }, requests }),
    items: requests.length,
  };
}
```

- `OpenApiImportSummary` gains `readonly webhooks: number;`; `apiFromDocument` sets `webhooks: webhookItemsOf(document).length`.
- `import.ts`: after mapping,

```ts
  const hooks =
    options.webhooks === false
      ? undefined
      : webhooksFromDocument(parsed.document, { ...options, apiId: options.apiId ?? mapped.api.id });
```

  and return `...(hooks !== undefined ? { webhooks: hooks.folder } : {})`.
- Export `webhookItemsOf`, `webhookSourcesOf`, `webhooksFromDocument`, and the types `WebhookItemRef`, `MapWebhooksOptions` from `index.ts` in the `rest/openapi/map.js` block.

- [ ] **Step 4: Run and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi`
Expected: PASS (existing map/import tests unchanged; if a test asserts a whole summary with `toEqual`, add `webhooks: 0`).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): map OpenAPI webhooks and callbacks into a webhook group"
```

---

### Task 7: Keep an imported group in step on *Update definition*

**Files:**
- Modify: `packages/engine/src/rest/openapi/update.ts`
- Create: `fixtures/openapi/crafted/update/webhooks-old.yaml`, `webhooks-next.yaml`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/test/unit/rest/openapi/update-plan.test.ts` (whole-plan `toEqual` gains `webhooks`)
- Test: `packages/engine/test/unit/rest/openapi/update-webhooks.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `interface WebhookUpdatePlan { added: WebhookItemRef[]; removed: WebhookItemRef[]; changed: { item: WebhookItemRef; reasons: RestChangeReason[] }[] }`
  - `planWebhookUpdate(old, next): WebhookUpdatePlan`; `RestUpdatePlan.webhooks: WebhookUpdatePlan`, filled by `planRestUpdate`.
  - `applyWebhookUpdate(folder, old, next, options?): { folder: WebhookFolder; added: number; orphaned: number; restored: number; rewritten: number }`.

Rules: `applyRestUpdate`'s inner per-request body moves into `followRequest(request, before, target, counters): RestRequestDef` used by both functions, so the rules are one piece of code (url follows when untouched; `mergeRows` on `pathParams`/`query`/`headers`; body and auth follow when untouched; orphaned set when the target is gone and cleared when it is back). `applyWebhookUpdate` matches by `hookKey(request.hook, request.method)` across the group's whole tree; requests without a `hook` are untouched; an item's `hook` (incl. `expression`) follows the new document; new items are appended to the group root with unique slugs and increasing `order`.

- [ ] **Step 1: Write fixtures and the failing test**

`webhooks-old.yaml`: `openapi: 3.1.0`, `info: { title: Petstore API, version: 1.0.0 }`, the `/subscriptions` `post` with only callback `onPetEvent` (as in Task 5's fixture), and `webhooks.newPet.post` with `id`/`name` properties. `webhooks-next.yaml`: the same but `newPet.post`'s schema adds `tag: { type: string, example: good }` (in `required`), a new `webhooks.petDeleted.post` with `responses: { '200': { description: ok } }`, and **no** `callbacks` on `/subscriptions`.

```ts
// packages/engine/test/unit/rest/openapi/update-webhooks.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyWebhookUpdate,
  createRestRequest,
  parseDocumentText,
  parseOpenApiDocument,
  planRestUpdate,
  planWebhookUpdate,
  webhooksFromDocument,
} from '../../../../src/index.js';

const dir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/update/', import.meta.url));
const load = (name: string) => parseOpenApiDocument(parseDocumentText(readFileSync(`${dir}${name}`, 'utf-8')));
const old = load('webhooks-old.yaml');
const next = load('webhooks-next.yaml');
let n = 0;
const newId = () => `n${String((n += 1))}`;

describe('planWebhookUpdate', () => {
  it('reports added, removed and changed items', () => {
    const plan = planWebhookUpdate(old, next);
    expect(plan.added.map((item) => item.key)).toEqual(['webhook petDeleted post']);
    expect(plan.removed.map((item) => item.key)).toEqual(['callback post /subscriptions onPetEvent post']);
    expect(plan.changed).toEqual([
      { item: expect.objectContaining({ key: 'webhook newPet post' }), reasons: ['request-body'] },
    ]);
    expect(planRestUpdate(old, next).webhooks).toEqual(plan);
  });
});

describe('applyWebhookUpdate', () => {
  it('follows the document where untouched, keeps edits, orphans the removed, adds the new', () => {
    const imported = webhooksFromDocument(old, { apiId: 'api-1', newId, sampleValues: true })!.folder;
    const edited = {
      ...imported,
      requests: [
        ...imported.requests.map((request) =>
          request.hook?.kind === 'callback'
            ? { ...request, headers: [{ name: 'X-Mine', value: '1', enabled: true }] }
            : request,
        ),
        createRestRequest('mine', { id: 'hand', slug: 'mine', method: 'POST', url: '/mine' }),
      ],
    };
    const result = applyWebhookUpdate(edited, old, next, { newId });
    const byName = new Map(result.folder.requests.map((request) => [request.name, request]));
    expect(result.added).toBe(1);
    expect(byName.get('petDeleted')?.hook).toEqual({ kind: 'webhook', name: 'petDeleted' });
    expect(byName.get('onPetEvent')?.orphaned).toBe(true);
    expect(byName.get('onPetEvent')?.headers).toEqual([{ name: 'X-Mine', value: '1', enabled: true }]);
    const body = byName.get('newPet')?.body;
    expect(body?.kind === 'raw' ? JSON.parse(body.text) : undefined).toMatchObject({ tag: 'good' });
    expect(byName.get('mine')).toEqual(edited.requests.at(-1));
    expect(result.orphaned).toBe(1);
  });

  it('keeps a body the user edited', () => {
    const imported = webhooksFromDocument(old, { apiId: 'api-1', newId, sampleValues: true })!.folder;
    const edited = {
      ...imported,
      requests: imported.requests.map((request) =>
        request.name === 'newPet'
          ? { ...request, body: { kind: 'raw' as const, language: 'json' as const, text: '{"mine":true}' } }
          : request,
      ),
    };
    const result = applyWebhookUpdate(edited, old, next, { newId });
    const body = result.folder.requests.find((request) => request.name === 'newPet')?.body;
    expect(body).toEqual({ kind: 'raw', language: 'json', text: '{"mine":true}' });
  });
});
```

(`applyWebhookUpdate` samples bodies with the same options it is given; pass `sampleValues: true` through `options` too if the sampler needs it — make `ApplyRestUpdateOptions` accept `sampleValues?`/`includeOptional?` and forward them, defaulting as the importer does.)

- [ ] **Step 2: Run and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi/update-webhooks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `RestUpdatePlan` gains `readonly webhooks: WebhookUpdatePlan;`; `planRestUpdate` returns `webhooks: planWebhookUpdate(old, next)`.
- `planWebhookUpdate`:

```ts
export function planWebhookUpdate(old: OpenApiDocument, next: OpenApiDocument): WebhookUpdatePlan {
  const before = new Map(webhookSourcesOf(old).map((source) => [source.ref.key, source] as const));
  const after = new Map(webhookSourcesOf(next).map((source) => [source.ref.key, source] as const));
  const added = [...after.values()].filter((source) => !before.has(source.ref.key)).map((source) => source.ref);
  const removed = [...before.values()].filter((source) => !after.has(source.ref.key)).map((source) => source.ref);
  const changed: { item: WebhookItemRef; reasons: RestChangeReason[] }[] = [];
  for (const [key, source] of after) {
    const previous = before.get(key);
    if (previous === undefined) continue;
    const reasons = reasonsFor(previous.operation, source.operation);
    if (reasons.length > 0) changed.push({ item: source.ref, reasons });
  }
  return { added, removed, changed };
}
```

- `followRequest` extracted from `applyRestUpdate` (behaviour unchanged, its tests prove it).
- `applyWebhookUpdate`:

```ts
export function applyWebhookUpdate(
  folder: WebhookFolder,
  old: OpenApiDocument,
  next: OpenApiDocument,
  options: ApplyRestUpdateOptions = {},
): {
  readonly folder: WebhookFolder;
  readonly added: number;
  readonly orphaned: number;
  readonly restored: number;
  readonly rewritten: number;
} {
  const newId = options.newId ?? generateId;
  const index = (document: OpenApiDocument, ids: IdGenerator): Map<string, RestRequestDef> => {
    const mapped = webhooksFromDocument(document, { ...options, apiId: folder.source?.apiId ?? '', newId: ids });
    const map = new Map<string, RestRequestDef>();
    for (const request of mapped?.folder.requests ?? []) {
      if (request.hook !== undefined) map.set(hookKey(request.hook, request.method), request);
    }
    return map;
  };
  const before = index(old, () => 'old');
  const after = index(next, newId);
  const counters = { orphaned: 0, restored: 0, rewritten: 0, rowsAdded: 0, rowsRemoved: 0 };
  const seen = new Set<string>();
  const follow = (request: RestRequestDef): RestRequestDef => {
    if (request.hook === undefined) return request;
    const key = hookKey(request.hook, request.method);
    seen.add(key);
    const target = after.get(key);
    const followed = followRequest(request, before.get(key), target, counters);
    return target?.hook !== undefined ? { ...followed, hook: target.hook } : followed;
  };
  const walk = (node: WebhookFolder): WebhookFolder => ({
    ...node,
    folders: node.folders.map(walk),
    requests: node.requests.map(follow),
  });
  const walked = walk(folder);
  const requests = [...walked.requests];
  const taken = new Set(requests.map((request) => request.slug));
  let order = requests.reduce((max, request) => Math.max(max, request.order + 1), 0);
  let added = 0;
  for (const [key, fresh] of after) {
    if (seen.has(key)) continue;
    const slug = uniqueSlug(fresh.name, taken);
    taken.add(slug);
    requests.push({ ...fresh, slug, order });
    order += 1;
    added += 1;
  }
  return {
    folder: { ...walked, requests },
    added,
    orphaned: counters.orphaned,
    restored: counters.restored,
    rewritten: counters.rewritten,
  };
}
```

- Export `applyWebhookUpdate`, `planWebhookUpdate` and the type `WebhookUpdatePlan` from `index.ts`.
- In `update-plan.test.ts`, whole-plan expectations gain `webhooks: { added: [], removed: [], changed: [] }`.

- [ ] **Step 4: Run and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/rest/openapi`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine fixtures/openapi/crafted/update
git commit -m "feat(engine): keep imported webhooks in step on Update definition"
```

---

### Task 8: Desktop main — wire and mutations

**Files:**
- Create: `apps/desktop/src/main/project-webhook-mutations.ts`
- Modify: `apps/desktop/src/main/project-rest-mutations.ts`, `project-mutations.ts`, `project-wire.ts`
- Modify: `apps/desktop/src/shared/wire-types.ts` (project wire, REST folder/request wire, mutate change union)
- Test: `apps/desktop/test/project-webhook-mutations.test.ts`; extend the project-wire test (find it with `grep -rl "toApiWire\|projectWire" apps/desktop/test`)

**Interfaces:**
- Consumes: engine Tasks 1–2.
- Produces (wire, restated in `wire-types.ts`, no engine imports):
  - `hookLinkWireSchema` (the engine union restated) and `webhookCollectionWireSchema = z.object({ id: z.string(), projectId: z.string(), target: z.string(), auth: authConfigWireSchema.optional() })`
  - `RestFolderWire` gains `target: z.string().optional()`, `source: z.object({ apiId: z.string() }).optional()`; `RestRequestWire` gains `hook: hookLinkWireSchema.optional()`
  - project wire gains `webhooks: webhookCollectionWireSchema.optional()`; webhook folders/requests are appended to the flat `folders`/`requests` arrays with `apiId = 'webhooks:<projectId>'` (R5).
  - `ProjectChange` gains: `{ kind: 'ensure-webhooks' }`, `{ kind: 'update-webhooks'; patch: { target?: string; auth?: AuthConfigWire | null } }`, `{ kind: 'add-webhook-request'; parentId?: string; name?: string; draft?: RestRequestPatchWire }`, `{ kind: 'add-webhook-folder'; parentId?: string; name?: string }`, `{ kind: 'set-webhook-folder-target'; folderId: string; target: string | null }`.
- Produces (main): `ensureWebhooks(project)`, `updateWebhooks(project, patch)`, `addWebhookRequest(project, input)`, `addWebhookFolder(project, input)`, `setWebhookFolderTarget(project, folderId, target)`, `addWebhookGroup(project, folder)`, `webhookCollectionId(projectId)`, `isWebhookCollectionId(id)` — each mutation returns the same `RestMutationResult` shape the REST mutations return.

Rules:
- `ensureWebhooks` creates `createWebhookCollection()` when absent and seeds `properties.webhookTarget = ''` when absent. Every `add-webhook-*` change and `addWebhookGroup` go through it.
- `add-webhook-request` with a `draft` applies it with the same patch logic `updateRestRequest` uses. New requests default to method `POST` and name `nextRequestName`-style `Webhook`, `Webhook 2`, … (use the existing helper, base `Webhook`).
- `addWebhookGroup` appends the folder at the collection root with a unique slug (`uniqueSlug`) and the next `order`.
- The REST mutations `updateRestRequest`, `removeRestRequest`, `cloneRestRequest`, `updateFolder`, `removeFolder`, `moveNode` fall back to the collection when no API owns the id: add `withRestTreeOwning(project, nodeId, edit)` in `project-rest-mutations.ts` that tries each API, then `project.webhooks`, and use it in all six. `moveNode` between an API and the collection throws `ProjectError('invalid-move', 'A webhook moves only within Webhooks')` (use whatever error class/code the existing invalid moves use, keeping this message).
- `removeApi` clears `source` on every webhook folder whose `source.apiId` is the removed API.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/project-webhook-mutations.test.ts
import { describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, createWebhookFolder } from '@wirebench/engine';
import {
  addWebhookFolder,
  addWebhookGroup,
  addWebhookRequest,
  ensureWebhooks,
  setWebhookFolderTarget,
  updateWebhooks,
} from '../src/main/project-webhook-mutations.js';
import { cloneRestRequest, removeApi, removeRestRequest, updateRestRequest } from '../src/main/project-rest-mutations.js';

const bare = () => createProject('P', { id: 'p1' });

describe('webhook mutations', () => {
  it('creates the collection once and seeds webhookTarget', () => {
    const once = ensureWebhooks(bare()).project;
    expect(once.webhooks?.target).toBe('${webhookTarget}');
    expect(once.properties['webhookTarget']).toBe('');
    const kept = ensureWebhooks({ ...once, properties: { webhookTarget: 'https://x.test' } }).project;
    expect(kept.properties['webhookTarget']).toBe('https://x.test');
  });

  it('adds requests and folders, creating the collection on the way', () => {
    const { project, createdId } = addWebhookRequest(bare(), {});
    expect(project.webhooks?.requests.map((r) => [r.id, r.name, r.method])).toEqual([[createdId, 'Webhook', 'POST']]);
    const folder = addWebhookFolder(project, { name: 'Group' });
    const inside = addWebhookRequest(folder.project, { parentId: folder.createdId });
    expect(inside.project.webhooks?.folders[0]?.requests).toHaveLength(1);
  });

  it('adds a request from a full draft', () => {
    const { project, createdId } = addWebhookRequest(bare(), {
      name: 'payment.succeeded',
      draft: { method: 'POST', url: '/payments', body: { kind: 'raw', language: 'json', text: '{"type":"payment.succeeded"}' } },
    });
    const request = project.webhooks?.requests.find((r) => r.id === createdId);
    expect([request?.name, request?.url, request?.body.kind]).toEqual(['payment.succeeded', '/payments', 'raw']);
  });

  it('sets and clears a folder target, and the collection target and auth', () => {
    const folder = addWebhookFolder(bare(), { name: 'G' });
    const set = setWebhookFolderTarget(folder.project, folder.createdId!, 'https://g.test').project;
    expect(set.webhooks?.folders[0]?.target).toBe('https://g.test');
    const cleared = setWebhookFolderTarget(set, folder.createdId!, null).project;
    expect(cleared.webhooks?.folders[0]?.target).toBeUndefined();
    const retarget = updateWebhooks(cleared, { target: 'https://all.test', auth: { type: 'none' } }).project;
    expect([retarget.webhooks?.target, retarget.webhooks?.auth]).toEqual(['https://all.test', { type: 'none' }]);
  });

  it('lets the REST mutations edit, clone and remove webhook items', () => {
    const { project, createdId } = addWebhookRequest(bare(), {});
    const renamed = updateRestRequest(project, createdId!, { name: 'Renamed' }).project;
    expect(renamed.webhooks?.requests[0]?.name).toBe('Renamed');
    const cloned = cloneRestRequest(renamed, createdId!).project;
    expect(cloned.webhooks?.requests).toHaveLength(2);
    const removed = removeRestRequest(cloned, createdId!).project;
    expect(removed.webhooks?.requests).toHaveLength(1);
  });

  it('adds an imported group and unlinks it when its API goes', () => {
    const withApi = { ...bare(), apis: [createApi('Petstore', { id: 'api-1' })] };
    const group = createWebhookFolder('Petstore', {
      id: 'g1',
      source: { apiId: 'api-1' },
      requests: [createRestRequest('newPet', { id: 'r1', hook: { kind: 'webhook', name: 'newPet' } })],
    });
    const grouped = addWebhookGroup(withApi, group).project;
    expect(grouped.webhooks?.folders[0]?.source).toEqual({ apiId: 'api-1' });
    const gone = removeApi(grouped, 'api-1').project;
    expect(gone.webhooks?.folders[0]?.source).toBeUndefined();
    expect(gone.webhooks?.folders[0]?.requests).toHaveLength(1);
  });

  it('gives a second imported group of the same name a unique slug', () => {
    const group = createWebhookFolder('Petstore', { id: 'g1', slug: 'petstore' });
    const twice = addWebhookGroup(addWebhookGroup(bare(), group).project, { ...group, id: 'g2' }).project;
    const slugs = twice.webhooks?.folders.map((f) => f.slug) ?? [];
    expect(slugs[0]).toBe('petstore');
    expect(new Set(slugs).size).toBe(2);
  });
});
```

Adjust `draft` field shapes to the real `RestRequestPatchWire` (read it first). Extend the project-wire test: a project with a collection wires `webhooks: { id: 'webhooks:p1', projectId: 'p1', target: '${webhookTarget}' }` and its folders/requests appear in the flat arrays with `apiId: 'webhooks:p1'`, the folder carrying `target`/`source` and the request `hook`.

- [ ] **Step 2: Run and see it fail**

Run: `nice pnpm vitest run apps/desktop/test/project-webhook-mutations.test.ts` plus the wire test.
Expected: FAIL.

- [ ] **Step 3: Implement** as the rules above; add the five `change.kind` cases to `project-mutations.ts`'s switch next to the REST cases, and the variants to the mutate request schema.

- [ ] **Step 4: Run and see it pass**, then `nice pnpm vitest run apps/desktop/test` (REST mutation and wire tests stay green).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): webhook collection mutations and wire"
```

---

### Task 9: Desktop main — sending a webhook

**Files:**
- Create: `apps/desktop/src/main/webhook-send.ts`
- Modify: `apps/desktop/src/main/history-service.ts` (`newestFor`)
- Modify: `apps/desktop/src/main/project-host.ts` (`restSend`, `restMeta`, the REST auth chain lookup, `restContractFor` → `undefined` for a webhook, preflight)
- Modify: `apps/desktop/src/main/rest-send.ts` (export `withDraft` and the helpers `resolveWebhookSend` reuses; widen `RestSendResolution.baseUrlSource`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (preflight response gains `target?: { source: 'target' | 'callback' | 'callback-fallback'; detail?: string }`)
- Test: `apps/desktop/test/webhook-send.test.ts`; extend the history-service test

**Interfaces:**
- Consumes: engine `webhookPath`, `effectiveTarget`, `evaluateRuntimeTemplate`; Task 8 wire.
- Produces:
  - `HistoryService.newestFor(projectId, requestId): HistoryEntryWire | undefined` — first entry of that project's `file.list()` (already newest-first) with `requestId` and `kind === 'rest'`.
  - `callbackUrlFor(project, request, newest): { url: string; source: 'callback'; detail: string } | { url: undefined; source: 'callback-fallback'; detail: string }` — `detail` is the editor note: `from your last <METHOD> <path> (<HH:MM>)` or `expression unresolved — <reason>`; reasons: `no linked API`, `parent request not found`, `never sent`, the evaluator's reason, `not an absolute http(s) URL`.
  - `resolveWebhookSend(args: ResolveWebhookSendArgs): RestSendResolution | undefined` where `ResolveWebhookSendArgs = { project; projectId; requestId; scopes; newest: (requestId) => HistoryEntryWire | undefined; draft?; preferences?; cookies?; tls?; proxy? }`. `api` in the result is `createApi('Webhooks', { id: 'webhooks:<projectId>', baseUrl })`; `baseUrlSource` is `'target' | 'callback' | 'callback-fallback'`; the resolution also carries `targetDetail?: string`.

Rules:
- Resolution order: callback URL (§6.5) when it resolves; otherwise `effectiveTarget(collection, chain)`.
- A resolved callback URL is sent as the request URL with `baseUrl: ''` (the absolute-URL rule) and must **not** be expanded (ADR-0015). Read `expandRestSendInput`: if it has no way to leave the URL unexpanded, add an option (e.g. `literalUrl: true`) and cover it with a test in `rest-send.test.ts`.
- The target is expanded with the request (it is the `baseUrl` given to `toRestSendInput`). After expansion: empty base with a relative URL → `WirebenchError('webhook-target-missing', 'Set the Webhooks target')`; a base not starting with `http://` or `https://` → `WirebenchError('webhook-target-invalid', 'The Webhooks target must start with http:// or https://')`.
- Auth chain: `[request.auth, ...folders leaf→root auth, collection.auth]` through the existing `resolveAuthChain`.
- `project-host.restSend`: when `findRestRequest` finds nothing and `project.webhooks` holds the id, call `resolveWebhookSend` with the same scopes, preferences and cookies, and `newest = (id) => history.newestFor(projectId, id)`. `restMeta` returns `{ requestName, apiName: 'Webhooks', folderPath }` for a webhook id. The preflight response reports `target` from `baseUrlSource`/`targetDetail`, and maps the two target errors to its existing error field.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/webhook-send.test.ts
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  entry,
} from '@wirebench/engine';
import type { Project, PropertyScopes } from '@wirebench/engine';
import { callbackUrlFor, resolveWebhookSend } from '../src/main/webhook-send.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';

const scopes: PropertyScopes = { project: { webhookTarget: 'https://receiver.test/hooks' }, global: {}, system: {} };

function project(): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    properties: { webhookTarget: 'https://receiver.test/hooks' },
    apis: [
      createApi('Petstore', {
        id: 'api-1',
        baseUrl: 'https://api.test',
        requests: [
          createRestRequest('Subscribe', {
            id: 'parent',
            method: 'POST',
            url: '/subscriptions',
            contract: { method: 'post', path: '/subscriptions' },
          }),
        ],
      }),
    ],
    webhooks: createWebhookCollection({
      requests: [createRestRequest('Ping', { id: 'w1', method: 'POST', url: '/ping', headers: [entry('X-Id', '${webhookTarget}')] })],
      folders: [
        createWebhookFolder('Petstore', {
          id: 'g1',
          target: 'https://group.test',
          source: { apiId: 'api-1' },
          requests: [
            createRestRequest('newPet', { id: 'w2', method: 'POST', url: '/newPet', hook: { kind: 'webhook', name: 'newPet' } }),
            createRestRequest('onPetEvent', {
              id: 'w3',
              method: 'POST',
              url: '/onPetEvent',
              hook: {
                kind: 'callback',
                operation: 'post /subscriptions',
                name: 'onPetEvent',
                expression: '{$request.body#/callbackUrl}',
              },
            }),
          ],
        }),
      ],
    }),
  };
}

function sent(body: string): HistoryEntryWire {
  return {
    id: 'h1', kind: 'rest', at: '2026-09-28T10:42:00.000Z', projectId: 'p1', requestId: 'parent',
    requestName: 'Subscribe', interfaceName: 'Petstore', operationName: '', endpoint: 'https://api.test/subscriptions',
    soapVersion: 'none', method: 'POST', status: 201, durationMs: 5, ok: true,
    request: { envelopeXml: body, headers: [] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 201, statusText: 'Created' },
    sizeBytes: 0,
  } as HistoryEntryWire;
}

const resolve = (p: Project, requestId: string, newest: (id: string) => HistoryEntryWire | undefined = () => undefined) =>
  resolveWebhookSend({ project: p, projectId: 'p1', requestId, scopes, newest });

describe('resolveWebhookSend', () => {
  it('sends a root item to the collection target, expanded', () => {
    const resolution = resolve(project(), 'w1')!;
    expect(resolution.input.baseUrl).toBe('https://receiver.test/hooks');
    expect(resolution.input.request.url).toBe('/ping');
    expect(resolution.input.request.headers[0]?.value).toBe('https://receiver.test/hooks');
    expect(resolution.baseUrlSource).toBe('target');
  });

  it('uses the nearest folder target', () => {
    expect(resolve(project(), 'w2')!.input.baseUrl).toBe('https://group.test');
  });

  it('sends a callback to the URL its parent last sent, unexpanded', () => {
    const body = JSON.stringify({ callbackUrl: 'https://my-app.dev/subs/${notAProperty}' });
    const resolution = resolve(project(), 'w3', (id) => (id === 'parent' ? sent(body) : undefined))!;
    expect(resolution.input.baseUrl).toBe('');
    expect(resolution.input.request.url).toBe('https://my-app.dev/subs/${notAProperty}');
    expect(resolution.baseUrlSource).toBe('callback');
    expect(resolution.unresolved).toEqual([]);
  });

  it('falls back to the target when the parent was never sent', () => {
    const resolution = resolve(project(), 'w3')!;
    expect(resolution.input.baseUrl).toBe('https://group.test');
    expect(resolution.baseUrlSource).toBe('callback-fallback');
  });

  it('refuses an empty target', () => {
    const empty: PropertyScopes = { ...scopes, project: { webhookTarget: '' } };
    const p = { ...project(), properties: { webhookTarget: '' } };
    expect(() => resolveWebhookSend({ project: p, projectId: 'p1', requestId: 'w1', scopes: empty, newest: () => undefined })).toThrow(
      expect.objectContaining({ code: 'webhook-target-missing' }),
    );
  });

  it('refuses a target that is not http(s)', () => {
    const odd: PropertyScopes = { ...scopes, project: { webhookTarget: 'ftp://x' } };
    expect(() => resolveWebhookSend({ project: project(), projectId: 'p1', requestId: 'w1', scopes: odd, newest: () => undefined })).toThrow(
      expect.objectContaining({ code: 'webhook-target-invalid' }),
    );
  });

  it('answers undefined for an id that is not a webhook item', () => {
    expect(resolve(project(), 'parent')).toBeUndefined();
  });
});

describe('callbackUrlFor', () => {
  it('explains each fallback', () => {
    const p = project();
    const request = p.webhooks!.folders[0]!.requests[1]!;
    expect(callbackUrlFor(p, request, () => undefined)).toEqual({
      url: undefined,
      source: 'callback-fallback',
      detail: 'expression unresolved — never sent',
    });
    expect(callbackUrlFor(p, request, () => sent('{}')).detail).toBe(
      'expression unresolved — $request.body#/callbackUrl has no value',
    );
    expect(callbackUrlFor(p, request, () => sent('{"callbackUrl":"relative/path"}')).detail).toBe(
      'expression unresolved — not an absolute http(s) URL',
    );
    const ok = callbackUrlFor(p, request, () => sent('{"callbackUrl":"https://cb.test/x"}'));
    expect(ok.url).toBe('https://cb.test/x');
    expect(ok.detail).toMatch(/^from your last POST \/subscriptions \(\d\d:\d\d\)$/);
  });
});
```

(Fill any `PropertyScopes`/`HistoryEntryWire` required fields the literals omit, the way `rest-send.test.ts` and the history tests do.) History-service test: two REST entries for request `a` and one for `b`; `newestFor('p1', 'a')` is the later `a` entry; `newestFor('p1', 'zzz')` is `undefined`.

- [ ] **Step 2: Run and see it fail**

Run: `nice pnpm vitest run apps/desktop/test/webhook-send.test.ts` plus the history-service test.
Expected: FAIL.

- [ ] **Step 3: Implement** per the rules. The time in `detail` is `new Date(entry.at).toTimeString().slice(0, 5)`; the path is `new URL(entry.endpoint).pathname`. The `RuntimeExchange` follows R4, with `pathTemplate` from the parent's `contract.path` and response headers from `rawHeaders`.

- [ ] **Step 4: Run and see it pass**, then `nice pnpm vitest run apps/desktop/test/rest-send.test.ts` and the IPC request tests (REST sending unchanged).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): send webhook items to their target or callback URL"
```

---

### Task 10: Desktop main — import, *Import webhooks…* and update

**Files:**
- Modify: `apps/desktop/src/main/ipc/api.ts`, `apps/desktop/src/main/project-host.ts` (import and update paths)
- Modify: `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/wire-types.ts`
- Test: extend the main-process tests for `api.importOpenApi` and `api.restPlanUpdate`/apply (`grep -rl "importOpenApi\|restPlanUpdate" apps/desktop/test`); add `apps/desktop/test/import-webhooks.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces:
  - `apiImportOpenApiRequestSchema` gains `webhooks: z.boolean().optional()` (absent = true); the response `summary` gains `webhooks: z.number()`; the response gains `webhookGroup: z.object({ folderId: z.string(), name: z.string(), items: z.array(z.object({ id: z.string(), label: z.string() })) }).optional()`.
  - `WebhookItemWire = { key, kind: 'webhook' | 'callback', name, method, label }`.
  - `api.webhookItems` — request `{ apiId }`, response `{ items: WebhookItemWire[]; imported: string[] }` (`imported` = keys already in the linked group). Fails with `webhook-definition-missing` when the API has no readable cached definition.
  - `api.importWebhooks` — request `{ apiId, keys: string[] }`, response `{ folderId, added }`: creates the linked group with the chosen items, or appends only the keys not already present.
  - `api.restPlanUpdate` response gains `webhooks: { added: WebhookItemWire[]; removed: WebhookItemWire[]; changed: { item: WebhookItemWire; reasons: string[] }[]; linked: boolean }`.
  - The apply path runs `applyWebhookUpdate` on the linked group (when there is one) in the same project change as the API update; its response gains `webhooks: { added, orphaned, restored, rewritten }`.
  - The `api` namespace already exists, so `preload-api.test.ts` needs no change.

- [ ] **Step 1: Write the failing tests.** Seed a project whose API has the Task 5 fixture as its cached definition (copy how the existing `restPlanUpdate` test seeds a cached definition). Assert:
  - import with `webhooks` absent → one group, `source.apiId` = the new API id, response `webhookGroup.items` has 4 entries and `summary.webhooks === 4`; import with `webhooks: false` → no collection;
  - `webhookItems` lists 4 keys with `imported: []` before an import and all 4 after; an API without a cache fails with code `webhook-definition-missing`;
  - `importWebhooks` with one key creates a group with one item; a second call with all four keys adds 3;
  - plan against `webhooks-next.yaml` reports `webhooks.added`/`removed`/`changed` as in Task 7 with `linked: true`; apply marks `onPetEvent` orphaned and adds `petDeleted`.

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement.** The import handler calls `importOpenApi(…, { …, webhooks: request.webhooks !== false, apiId: <the new API's id> })` and, when `imported.webhooks` is set, applies `addWebhookGroup` in the same project change that adds the API (one undo step, one save). `webhookItems` loads the cached document with the helper `restPlanUpdate` uses for the *old* document and calls `webhookItemsOf`. `importWebhooks` calls `webhooksFromDocument(document, { apiId, only: new Set(keys) })`, then either `addWebhookGroup` or appends to the existing group (unique slugs, next orders).

- [ ] **Step 4: Run and see them pass**, plus `nice pnpm vitest run apps/desktop/test`.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): import webhooks and keep them in step on update"
```

---

### Task 11: Renderer — store and Explorer

**Files:**
- Modify: `apps/desktop/src/renderer/state/project.ts` (`webhooks: Record<projectId, WebhookCollectionWire>`; actions `ensureWebhooks`, `addWebhookRequest(projectId, parentId?, name?, draft?)`, `addWebhookFolder(projectId, parentId?, name?)`, `updateWebhooks(projectId, patch)`, `setWebhookFolderTarget(projectId, folderId, target)`; selector `selectWebhooksOf(state, entityId)`)
- Modify: `apps/desktop/src/renderer/features/explorer/tree-nodes.ts`, `context-menu.tsx`, `explorer-actions.ts`
- Modify: `e2e/specs/server-webhooks.spec.ts` only where it matches the visible label *Webhooks* for the inbox root
- Test: `apps/desktop/test/renderer/explorer-context-menu.test.ts`; the existing tree-nodes test (find it under `apps/desktop/test/renderer/`)

**Interfaces:**
- Consumes: Task 8 wire.
- Produces:
  - `ExplorerNodeKind` gains `'webhook-collection' | 'webhook-folder' | 'webhook-request'`. Ids: `webhook-collection:<projectId>`, `webhook-folder:<folderId>`, `webhook-request:<requestId>`. Nodes reuse `projectId`, `folderId`, `requestId`, `method`, `linked` (set when the folder has `source`); `ExplorerNode` gains optional `suffix?: string`, rendered muted after the label (a callback request's `· <operation label>`, taken from `hook.operation` → the parent request's name when found, else the operation key). Orphaned requests render as orphaned REST requests do.
  - The collection node is appended to a project's children after `orderedChildren(...)` and **before** the sequences group, only when `webhooks[projectId]` exists.
  - `webhooksNode()` label becomes `'Webhook inbox'` (R2).
  - Menus:
    - `project`: *New Webhook* right after *New WebSocket API…* → `explorerActions.newWebhook(projectId)`.
    - `webhook-collection`: *New Webhook*, *New Folder* | *Settings…*.
    - `webhook-folder`: *New Webhook*, *New Folder* | *Settings…*, *Rename…*, *Auth…* | *Delete*.
    - `webhook-request`: *Duplicate*, *Rename…* | *Delete*.
    - `api` with `hasDefinition`: *Import webhooks…* right after *Update Definition…*.
  - `explorerActions.newWebhook(projectId, parentId?)`, `newWebhookFolder(projectId, parentId?)`, `openWebhookSettings(projectId, folderId?)` (Task 13 fills the dialog; until then it may be a no-op that Task 13 replaces), `importWebhooks(apiId)` (Task 14 likewise). Rename/delete/duplicate/auth reuse the REST actions with the folder/request id — main routes them (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
// in explorer-context-menu.test.ts
it('offers New Webhook on a project', () => {
  const labels = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' })).map((item) => item.label);
  expect(labels.indexOf('New Webhook')).toBe(labels.indexOf('New WebSocket API…') + 1);
});

it('offers the collection’s own operations', () => {
  const items = explorerMenuItems(node({ kind: 'webhook-collection', id: 'webhook-collection:p1', projectId: 'p1' }));
  expect(items.map((item) => item.label)).toEqual(['New Webhook', 'New Folder', 'Settings…']);
});

it('offers folder and request operations on webhook items', () => {
  expect(
    explorerMenuItems(node({ kind: 'webhook-folder', id: 'webhook-folder:f1', projectId: 'p1', folderId: 'f1' })).map((i) => i.label),
  ).toEqual(['New Webhook', 'New Folder', 'Settings…', 'Rename…', 'Auth…', 'Delete']);
  expect(
    explorerMenuItems(node({ kind: 'webhook-request', id: 'webhook-request:r1', projectId: 'p1', requestId: 'r1' })).map((i) => i.label),
  ).toEqual(['Duplicate', 'Rename…', 'Delete']);
});

it('offers Import webhooks… on an API with a definition', () => {
  const labels = explorerMenuItems(node({ kind: 'api', id: 'api:a1', apiId: 'a1', hasDefinition: true })).map((i) => i.label);
  expect(labels.indexOf('Import webhooks…')).toBe(labels.indexOf('Update Definition…') + 1);
});
```

Update the existing project-menu expectation to include `'New Webhook'` after `'New WebSocket API…'`. Tree test: one project with a collection (a root request, a linked folder holding a callback request) and a workspace inbox → the project's children end with the collection node before the sequences group; ids, kinds, labels, `suffix`, `linked` as specified; the inbox root label is `Webhook inbox`; a project without a collection has no collection node.

- [ ] **Step 2: Run and see them fail.** `nice pnpm vitest run apps/desktop/test/renderer/explorer-context-menu.test.ts` and the tree test.

- [ ] **Step 3: Implement.** Icons: lucide `Forward` for the collection and its requests (`CornerUpRight` if `Forward` is missing from the installed version); the inbox keeps its icon.

- [ ] **Step 4: Run and see them pass**, plus `nice pnpm vitest run apps/desktop/test/renderer`.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop e2e/specs/server-webhooks.spec.ts
git commit -m "feat(desktop): Webhooks node per project; the catch-URL root becomes Webhook inbox"
```

---

### Task 12: Renderer — the webhook editor

**Files:**
- Modify: `apps/desktop/src/renderer/features/rest-editor/url-bar.tsx`, `rest-editor.tsx`
- Create: `apps/desktop/src/renderer/features/webhook-items/webhook-url-note.tsx`
- Test: `apps/desktop/test/renderer/webhook-url-note.test.tsx`; extend or create `apps/desktop/test/renderer/url-bar.test.tsx`

No new tab kind: a webhook item opens in the REST request tab (its id is a REST request id on the wire); the editor recognises it by `request.apiId` starting with `webhooks:`.

**Interfaces:**
- Consumes: Task 9 preflight `target`; Task 11 store.
- Produces:
  - `UrlBarProps.baseLabel?: string` — when set, the greyed prefix renders `<baseLabel> ·` with the resolved base in its `title`, instead of the base URL itself.
  - `UrlBarProps.sendDisabledReason?: string` — disables *Send*; the reason is its `title`.
  - `WebhookUrlNote({ resolvedUrl?, source: 'target' | 'callback' | 'callback-fallback' | 'missing', detail?, onOpenSettings })` — the line under the URL bar: `→ <resolvedUrl>`; for callbacks also `ⓘ <detail>`; for `missing`, `Set the Webhooks target` and a *Settings…* button.
  - A header chip `webhook · <group name>` when the request's folder chain has a `source`, else `webhook`.

Rules:
- For a webhook item the editor passes `baseLabel="Target"`, never reads `api?.baseUrl`, and renders `WebhookUrlNote` from the preflight result.
- Preflight error `webhook-target-missing` → `sendDisabledReason = 'Set the Webhooks target'` and note source `missing`; `webhook-target-invalid` → the inline error `The Webhooks target must start with http:// or https://`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/desktop/test/renderer/webhook-url-note.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebhookUrlNote } from '../../src/renderer/features/webhook-items/webhook-url-note.js';

describe('WebhookUrlNote', () => {
  it('shows where a target send goes', () => {
    render(<WebhookUrlNote resolvedUrl="https://my-app.dev/hooks/newPet" source="target" onOpenSettings={() => undefined} />);
    expect(screen.getByText('→ https://my-app.dev/hooks/newPet')).toBeTruthy();
  });

  it('says where a callback URL came from', () => {
    render(
      <WebhookUrlNote
        resolvedUrl="https://my-app.dev/subs/cb-91"
        source="callback"
        detail="from your last POST /subscriptions (10:42)"
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.getByText(/from your last POST \/subscriptions \(10:42\)/)).toBeTruthy();
  });

  it('offers the settings when the target is missing', () => {
    const open = vi.fn();
    render(<WebhookUrlNote source="missing" onOpenSettings={open} />);
    expect(screen.getByText('Set the Webhooks target')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings…' }));
    expect(open).toHaveBeenCalled();
  });
});
```

URL bar: `baseLabel="Target"` renders `Target ·` and not the raw base URL text; `sendDisabledReason` disables the *Send* button and sets its `title`. (Check the renderer tests' setup — if they do not use `@testing-library/react`, use the render helper they use.)

- [ ] **Step 2–4:** run (`nice pnpm vitest run apps/desktop/test/renderer/webhook-url-note.test.tsx apps/desktop/test/renderer/url-bar.test.tsx`), implement, pass; then `nice pnpm vitest run apps/desktop/test/renderer`.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): edit and send webhook items in the REST editor"
```

---

### Task 13: Renderer — Webhooks settings

**Files:**
- Create: `apps/desktop/src/renderer/features/webhook-items/webhook-settings-dialog.tsx`, `webhook-items-state.ts`
- Modify: `explorer-actions.ts` (`openWebhookSettings`), the shell where dialogs mount (beside where `webhooks-dialogs.tsx` mounts)
- Test: `apps/desktop/test/renderer/webhook-settings-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 11 store actions; `useWebhooksStore` (`server`, `meta`, `hooks`) from `state/webhooks.ts`.
- Produces: `useWebhookItemsDialogs` (zustand) `{ settings?: { projectId; folderId? }; saveAs?: { captureId }; importFor?: { apiId }; openSettings; openSaveAs; openImport; close }`; `WebhookSettingsDialog`.

Rules:
- Collection settings: **Target** field (initial = collection target) with the property autocomplete the REST URL field uses (find it with `grep -rn "autocomplete\|Autocomplete" apps/desktop/src/renderer/features/rest-editor`); a **Catch URLs ▸** menu button listing `useWebhooksStore.hooks` by name, present only when `server !== undefined && meta?.enabled === true`; choosing one writes its `url` into the field. **Auth**: the auth editor the API tab uses, bound to the collection `auth`.
- Folder settings: the Target field has placeholder `inherits: <inherited target>` when the folder has no override; *Reset* clears the override; no Auth block (the folder's *Auth…* item covers it).
- *Save* calls `updateWebhooks` / `setWebhookFolderTarget`; *Cancel* and Escape close.

- [ ] **Step 1: Write the failing test.** Seed the project store with one collection (`target: '${webhookTarget}'`) and `useWebhooksStore` with `{ server: { url: 'https://srv.test', workspaceId: 'w1' }, meta: { enabled: true, bodyLimitBytes: 1, keep: 1, maxAgeDays: 1 }, hooks: [{ id: 'h1', name: 'Petstore dev', url: 'https://srv.test/hooks/abc/', … }] }`:
  - the Target field shows `${webhookTarget}`;
  - choosing *Catch URLs ▸ Petstore dev* puts `https://srv.test/hooks/abc/` in the field, and *Save* calls `updateWebhooks('p1', { target: 'https://srv.test/hooks/abc/' })` (spy on the action);
  - with `meta: null` there is no *Catch URLs* button;
  - for a folder without an override the placeholder is `inherits: ${webhookTarget}`, and *Reset* calls `setWebhookFolderTarget('p1', 'f1', null)`.

- [ ] **Step 2–4:** run, implement, pass.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): Webhooks target and auth settings, with the catch-URL picker"
```

---

### Task 14: Renderer — import section, *Import webhooks…*, update block

**Files:**
- Modify: `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`
- Create: `apps/desktop/src/renderer/features/webhook-items/import-webhooks-dialog.tsx`
- Modify: `apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx`
- Modify: `apps/desktop/src/renderer/state/project.ts` (`importOpenApi` passes `webhooks`)
- Test: `apps/desktop/test/renderer/import-webhooks-dialog.test.tsx`; extend the existing import-dialog and rest-update-dialog tests (under `apps/desktop/test/renderer/`)

**Interfaces:**
- Consumes: Task 10 channels.

Rules (R1):
- Import dialog, OpenAPI format only: a checkbox *Import webhooks & callbacks* (`data-testid="import-openapi-webhooks"`, ticked) above *Import*; its value goes as `webhooks`. When `summary.webhooks > 0` the counts line ends `…, <n> webhooks`. When the response has `webhookGroup`, a block `data-testid="import-openapi-webhooks-result"` reads `<n> webhook(s) & callback(s) → added to <project> ▸ Webhooks ▸ <group name>` with the item labels listed.
- *Import webhooks…* dialog: loads `api.webhookItems`; one row per item `☑ <label>  webhook | callback`, all ticked, an *all* toggle; rows already imported are ticked **and disabled** with *already imported*; *Import* sends the ticked, not-yet-imported keys to `api.importWebhooks`, closes, and toasts `Imported <n> webhook(s)`. On `webhook-definition-missing` it shows `This API has no stored definition to read webhooks from.` and only *Close*.
- Update dialog: when `plan.webhooks` has any entry, a block `data-testid="rest-update-webhooks"` titled `Webhooks +<a> ~<c> −<r>` with three `OpList`s (added, removed, changed with reasons) and the note `Removed webhooks are kept and badged orphaned; hand-made webhooks are never changed.` When `linked` is false and there are added items, the block instead reads `Webhooks not imported — Import webhooks…` with a link that opens the *Import webhooks…* dialog. The dialog's *empty* check includes the webhook lists.

- [ ] **Step 1: Write the failing tests** for the three surfaces (mock `ipc()` as the existing dialog tests do): the checkbox is ticked by default and its value reaches the import call; the result block text; the import-webhooks dialog's rows, disabled already-imported row, the keys sent, the error state; the update dialog's `+1 ~1 −1` title and the not-linked variant.

- [ ] **Step 2–4:** run, implement, pass.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): import webhooks with an API, on demand, and on update"
```

---

### Task 15: Renderer — *Save as webhook*

**Files:**
- Create: `apps/desktop/src/renderer/features/webhook-items/save-as-webhook.ts`, `save-as-webhook-dialog.tsx`
- Modify: `apps/desktop/src/renderer/features/webhooks/capture-viewer.tsx` (a toolbar row above the tabs with the button; `CaptureViewer` gains an optional `onSaveAsWebhook?: () => void` so it stays store-free), `catch-url-tab.tsx` (passes it)
- Test: `apps/desktop/test/renderer/save-as-webhook.test.ts`; extend the capture-viewer test

**Interfaces:**
- Consumes: `CaptureViewWire` (`method`, `subpath`, `query`, `headers: [string, string][]`, `text`, `contentType`, `language`, `truncated`); Task 11 `addWebhookRequest(projectId, parentId, name, draft)`.
- Produces:
  - `saveAsWebhookDraft(capture): { ok: true; name: string; draft: RestRequestPatchWire } | { ok: false; code: 'webhook-save-truncated' | 'webhook-save-binary'; message: string }`
  - `droppedHeader(name: string): boolean` implementing the Global Constraints list.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/renderer/save-as-webhook.test.ts
import { describe, expect, it } from 'vitest';
import { droppedHeader, saveAsWebhookDraft } from '../../src/renderer/features/webhook-items/save-as-webhook.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

function capture(patch: Partial<CaptureViewWire> = {}): CaptureViewWire {
  return {
    id: 'c1', receivedAt: '2026-09-28T10:42:00.000Z', method: 'POST', subpath: '/payments', bodySize: 40,
    truncated: false, sourceIp: '203.0.113.9', query: 'a=1',
    headers: [
      ['Host', 'srv.test'], ['Content-Type', 'application/json'], ['Content-Length', '40'],
      ['X-Forwarded-For', '1.2.3.4'], ['Provider-Signature', 't=1,v1=abc'], ['X-Hub-Signature-256', 'sha256=x'],
      ['X-Event-Id', 'evt_1'], ['Proxy-Authorization', 'x'], ['X-Request-Id', 'r'],
    ],
    bodyBase64: '', contentType: 'application/json', text: '{"type":"payment.succeeded","id":"evt_1"}', language: 'json',
    ...patch,
  };
}

describe('droppedHeader', () => {
  it('drops transport, proxy, forwarding and signature headers', () => {
    for (const name of ['Host', 'content-length', 'Connection', 'Transfer-Encoding', 'Keep-Alive', 'Upgrade', 'TE', 'Trailer', 'Forwarded', 'X-Request-Id', 'Proxy-Authorization', 'X-Forwarded-Proto', 'Provider-Signature']) {
      expect(droppedHeader(name)).toBe(true);
    }
    expect(droppedHeader('Content-Type')).toBe(false);
    expect(droppedHeader('X-Event-Id')).toBe(false);
  });
});

describe('saveAsWebhookDraft', () => {
  it('copies method, sub-path, query, kept headers and body', () => {
    const result = saveAsWebhookDraft(capture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('payment.succeeded');
    expect(result.draft.method).toBe('POST');
    expect(result.draft.url).toBe('/payments?a=1');
    expect(result.draft.headers?.map((h) => h.name)).toEqual(['Content-Type', 'X-Event-Id']);
    expect(result.draft.body).toEqual({ kind: 'raw', language: 'json', text: '{"type":"payment.succeeded","id":"evt_1"}' });
  });

  it('names by method and path without a type field, and reads form bodies as fields', () => {
    const result = saveAsWebhookDraft(
      capture({ contentType: 'application/x-www-form-urlencoded', language: 'text', text: 'a=1&b=two%20words', query: '' }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.name).toBe('POST /payments');
    expect(result.draft.url).toBe('/payments');
    expect(result.draft.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: 'two words', enabled: true },
      ],
    });
  });

  it('keeps XML and plain text as raw bodies of their language, and an empty body as none', () => {
    const xml = saveAsWebhookDraft(capture({ contentType: 'application/xml', language: 'xml', text: '<a/>' }));
    expect(xml.ok && xml.draft.body).toEqual({ kind: 'raw', language: 'xml', text: '<a/>' });
    const text = saveAsWebhookDraft(capture({ contentType: 'text/plain', language: 'text', text: 'hi' }));
    expect(text.ok && text.draft.body).toEqual({ kind: 'raw', language: 'text', text: 'hi' });
    const empty = saveAsWebhookDraft(capture({ text: '', contentType: null, language: 'text' }));
    expect(empty.ok && empty.draft.body).toEqual({ kind: 'none' });
  });

  it('refuses a truncated or binary capture', () => {
    expect(saveAsWebhookDraft(capture({ truncated: true }))).toMatchObject({ ok: false, code: 'webhook-save-truncated' });
    expect(saveAsWebhookDraft(capture({ language: 'binary' }))).toMatchObject({ ok: false, code: 'webhook-save-binary' });
    expect(saveAsWebhookDraft(capture({ language: 'image' }))).toMatchObject({ ok: false, code: 'webhook-save-binary' });
  });
});
```

Adjust header row and body shapes to the real `RestRequestPatchWire` / `RestBodyWire` (read them first; header rows may need `enabled: true`). Capture-viewer test: with `onSaveAsWebhook` given, a *Save as webhook…* button renders and calls it; for a truncated capture it is disabled with title `The body was cut at the server's limit, so it cannot be replayed.`; for a binary capture, `A binary body cannot be saved as a webhook.`.

Dialog: *Project* (the workspace's open projects, first by default), *Folder* (`Webhooks` root plus every webhook folder of that project, shown as a path), *Name* (from `saveAsWebhookDraft`). *Save* → `addWebhookRequest(projectId, folderId, name, draft)` → toast `Saved as webhook` → open the new request's tab.

- [ ] **Step 2–4:** run (`nice pnpm vitest run apps/desktop/test/renderer/save-as-webhook.test.ts` and the capture-viewer test), implement, pass.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): save a captured request as a webhook"
```

---

### Task 16: e2e (CI only)

**Files:**
- Create: `e2e/specs/webhooks-send.spec.ts`
- Modify: `e2e/helpers/fake-server.ts` only if the scenario needs something it lacks

**Do not run it locally** (Global Constraints). Build it from `e2e/specs/server-webhooks.spec.ts` (sign-in, share, catch URL creation) and an OpenAPI import spec (`grep -rl "import-openapi" e2e/specs`).

Scenario:
1. Fake server with `hooks: true`; sign in and share a workspace as `server-webhooks.spec.ts` does; create catch URL *Petstore dev*.
2. Import `fixtures/openapi/crafted/webhooks/openapi.yaml` with *Import webhooks & callbacks* ticked; expect `import-openapi-webhooks-result` to contain `4 webhooks & callbacks`.
3. Explorer: the project's *Webhooks* node holds the *Petstore API* group with `newPet` and `onPetEvent`; the workspace root reads *Webhook inbox*.
4. *Webhooks ▸ Settings…* → *Catch URLs ▸ Petstore dev* → *Save*.
5. Open `newPet`, *Send*; expect a 2xx in the response pane. Open the *Petstore dev* tab; expect a capture `POST /newPet` whose body contains `"name"`.
6. On that capture, *Save as webhook…* into *Webhooks* named `replayed`; expect `replayed` in the tree.
7. *Update Definition…* on the API with `fixtures/openapi/crafted/update/webhooks-next.yaml`; expect `rest-update-webhooks` to read `Webhooks +1 ~1 −1`; apply; expect `petDeleted` in the group and `onPetEvent` shown orphaned.

- [ ] **Step 1:** write the spec; `nice pnpm typecheck`.
- [ ] **Step 2: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e
git commit -m "test(e2e): import, send, save and update webhooks"
```

---

### Task 17: Docs, changelog, spec revisions

**Files:**
- Create: `docs-site/src/content/docs/guides/sending-webhooks.mdx`
- Modify: `docs-site/astro.config.mjs` (sidebar: relabel the `guides/webhooks` entry `Webhook inbox`, add `{ label: 'Sending webhooks', slug: 'guides/sending-webhooks' }` after it)
- Modify: `docs-site/src/content/docs/guides/webhooks.mdx` (the root is now *Webhook inbox*; *Save as webhook…* on a capture; link to the new guide)
- Modify: `docs-site/src/content/docs/guides/importers.mdx` (OpenAPI 3.1 `webhooks` and 3.0+ `callbacks` import into the project's *Webhooks*; `links` still skipped)
- Modify: `CHANGELOG.md` (Unreleased — Added: the per-project webhook collection, OpenAPI webhooks/callbacks import, callback URLs from runtime expressions, *Save as webhook*; Changed: the catch-URL root is now *Webhook inbox*; project format 6)
- Modify: `docs/specs/2026-09-28-wirebench-openapi-webhooks-import-design.md` — append `## Revisions after planning` with R1–R6 from this plan.

`sending-webhooks.mdx` sections: *What a webhook item is* (it plays the provider; the receiver is your app or a catch URL); *Create one* (project → *New Webhook*); *Where it is sent* (the target in *Webhooks ▸ Settings…*, folder overrides, the per-project `${webhookTarget}` property, environments overriding it, the *Catch URLs* picker); *Import from OpenAPI* (3.1 `webhooks`, 3.0+ `callbacks`, the import checkbox, *Import webhooks…*, *Update definition*); *Callback URLs* (evaluated against your last send of the parent request, else the target; the editor note says which); *Replay a real event* (*Save as webhook…*; which headers are dropped; signatures are dropped, and signing comes in a later release); *In a run* (the CLI sends webhook items to their target; callbacks use the target). No product names.

- [ ] **Step 1:** write the docs.
- [ ] **Step 2:** `nice pnpm check:doc-paths && nice pnpm check:banned-terms && nice pnpm docs:commands --check`
- [ ] **Step 3: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs-site CHANGELOG.md docs/specs
git commit -m "docs: sending webhooks, the Webhook inbox, and the spec's revisions after planning"
```

---

## Self-review

- Spec coverage: §3.1 Explorer → T11; §3.2 settings → T13; §3.3 editor → T12 (+T9 preflight); §3.4 import → T10/T14 (R1); §3.5 update → T7/T10/T14; §3.6 save as → T15; §4 model → T1; §5 files and walkers → T2/T3 (+T8 desktop); §6.1 parse → T5; §6.2 expressions → T4; §6.3 mapping → T6; §6.4 update → T7; §6.5 callback URL → T9 (R4); §6.6 sending → T9; §6.7 save-as mapping → T15; §7 errors → T9/T10/T12/T15; §8 testing → each task + T16; docs → T17.
- Names across tasks: `WebhookCollection`, `WebhookFolder`, `HookLink`, `hookKey`, `effectiveTarget`, `webhookPath` (T1) → T2, T3, T7, T8, T9; `WebhookItemRef`, `webhookSourcesOf`, `webhooksFromDocument`, `webhookItemsOf` (T6) → T7, T10; `planWebhookUpdate`, `applyWebhookUpdate` (T7) → T10; `evaluateRuntimeTemplate`, `RuntimeExchange` (T4) → T9; `resolveWebhookSend`, `callbackUrlFor`, `newestFor` (T9) → T12 via preflight; `addWebhookRequest` with `draft` (T8/T11) → T15.
