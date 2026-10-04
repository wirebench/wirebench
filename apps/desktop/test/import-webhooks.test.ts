// @vitest-environment node
/**
 * `api.importOpenApi`'s webhook mapping, `api.webhookItems` and `api.importWebhooks`: importing an
 * OpenAPI document's webhooks and callbacks into the project's webhook collection in the same change
 * as the API, offering them again for an API that skipped them, and topping up a group that already
 * has some.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { OpenApiImportService } from '../src/main/openapi-import.js';
import { createDefaultFetchDocument } from '@wirebench/engine';
import type { ProjectWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerApiChannels } = await import('../src/main/ipc/api.js');
type ApiChannelDeps = Parameters<typeof registerApiChannels>[0];

const sender = { isDestroyed: () => false, send: vi.fn() };

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

async function value<T>(channel: string, payload: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  const result = (await handler({ sender }, payload)) as Envelope;
  if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

async function failure(channel: string, payload: unknown): Promise<{ code?: string }> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  const result = (await handler({ sender }, payload)) as Envelope;
  if (result.ok) throw new Error(`${channel} unexpectedly succeeded`);
  return result.error as { code?: string };
}

const fixture = fileURLToPath(new URL('../../../fixtures/openapi/crafted/webhooks/openapi.yaml', import.meta.url));

/** In document order — see `packages/engine/test/unit/rest/openapi/map-webhooks.test.ts`. */
const KEYS = [
  'webhook newPet post',
  'webhook newPet put',
  'callback post /subscriptions onPetEvent post',
  'callback post /subscriptions broken post',
];

let root: string;
let projectDir: string;
let docPath: string;
let host: ProjectHost;

beforeEach(async () => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'wirebench-import-webhooks-'));
  projectDir = join(root, 'Pets');
  await mkdir(projectDir, { recursive: true });
  docPath = join(projectDir, 'openapi.yaml');
  await writeFile(docPath, await readFile(fixture, 'utf8'));

  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(projectDir, 'project'), name: 'Pets' });

  const imports = new OpenApiImportService({ createFetchDocument: () => createDefaultFetchDocument() });
  const unused = vi.fn();
  const deps: ApiChannelDeps = {
    router: {
      addApi: (_projectId, input) => host.addApi(input),
      addGrpcApi: unused,
      importAsyncApi: unused,
      asyncApiSource: unused,
      asyncApiPlanUpdate: unused,
      asyncApiApplyUpdate: unused,
      restSource: (apiId) => host.restSource(apiId),
      restPlanUpdate: (apiId, next) => host.planRestUpdate(apiId, next),
      restApplyUpdate: (apiId, next, options) => host.applyRestUpdate(apiId, next, options),
      webhookItems: (apiId) => host.webhookItems(apiId),
      importWebhooks: (apiId, keys) => host.importWebhooks(apiId, keys),
      apiDefinitionDocuments: unused,
      apiDefinitionText: unused,
      exportApiDefinitionTo: unused,
      grpcDefinition: unused,
      grpcFields: unused,
      grpcRefresh: unused,
      grpcSample: unused,
    },
    imports,
    addProject: unused,
    removeProject: unused,
    projectDirs: () => [projectDir],
    picks: new DialogPicks(),
    variablesPorts: unused,
    history: { open: unused, recordImportedRestBatch: unused },
    onHistoryChanged: unused,
  };
  registerApiChannels(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Imported {
  readonly apiId: string;
  readonly summary: { readonly webhooks: number };
  readonly webhookGroup?: {
    readonly folderId: string;
    readonly name: string;
    readonly items: { id: string; label: string }[];
  };
}

async function importApi(options: { readonly cache?: boolean; readonly webhooks?: boolean } = {}): Promise<Imported> {
  return value<Imported>('api.importOpenApi', {
    source: { kind: 'file', path: docPath },
    target: { projectId: 'p1' },
    cache: options.cache ?? true,
    ...(options.webhooks !== undefined ? { webhooks: options.webhooks } : {}),
  });
}

function project(): ProjectWire {
  return host.snapshot() as ProjectWire;
}

describe('api.importOpenApi webhook mapping', () => {
  it('places one linked group with every webhook and callback, in the same change as the API', async () => {
    const imported = await importApi();

    expect(imported.summary.webhooks).toBe(4);
    expect(imported.webhookGroup?.items).toHaveLength(4);
    expect(imported.webhookGroup?.items.map((item) => item.label)).toEqual([
      'newPet',
      'newPet (PUT)',
      'onPetEvent · createSubscription',
      'broken · createSubscription',
    ]);

    const wire = project();
    const folder = wire.folders.find((candidate) => candidate.id === imported.webhookGroup?.folderId);
    expect(folder?.source).toEqual({ apiId: imported.apiId });
    expect(wire.restRequests.filter((request) => request.folderId === folder?.id)).toHaveLength(4);
    // One undo step, one save: the API and its group both landed on the very first snapshot.
    expect(wire.apis.some((api) => api.id === imported.apiId)).toBe(true);
  });

  it('imports nothing into the collection when `webhooks` is false, though the summary still counts them', async () => {
    const imported = await importApi({ webhooks: false });

    expect(imported.summary.webhooks).toBe(4);
    expect(imported.webhookGroup).toBeUndefined();
    expect(project().webhooks).toBeUndefined();
  });
});

describe('api.webhookItems', () => {
  it('lists every key, none imported before an import and all four after', async () => {
    const imported = await importApi({ webhooks: false });

    const before = await value<{ items: { key: string }[]; imported: string[] }>('api.webhookItems', {
      apiId: imported.apiId,
    });
    expect(before.items.map((item) => item.key)).toEqual(KEYS);
    expect(before.imported).toEqual([]);

    await value('api.importWebhooks', { apiId: imported.apiId, keys: KEYS });

    const after = await value<{ items: { key: string }[]; imported: string[] }>('api.webhookItems', {
      apiId: imported.apiId,
    });
    expect(new Set(after.imported)).toEqual(new Set(KEYS));
  });

  it('fails with webhook-definition-missing for an API with no readable cached definition', async () => {
    const imported = await importApi({ cache: false, webhooks: false });

    const error = await failure('api.webhookItems', { apiId: imported.apiId });
    expect(error.code).toBe('webhook-definition-missing');
  });
});

describe('api.importWebhooks', () => {
  it('creates a group with one item, then a second call adds the rest', async () => {
    const imported = await importApi({ webhooks: false });

    const first = await value<{ folderId: string; added: number }>('api.importWebhooks', {
      apiId: imported.apiId,
      keys: [KEYS[0] ?? ''],
    });
    expect(first.added).toBe(1);
    expect(project().restRequests.filter((request) => request.folderId === first.folderId)).toHaveLength(1);

    const second = await value<{ folderId: string; added: number }>('api.importWebhooks', {
      apiId: imported.apiId,
      keys: KEYS,
    });
    expect(second.folderId).toBe(first.folderId);
    expect(second.added).toBe(3);
    const items = project().restRequests.filter((request) => request.folderId === first.folderId);
    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.name))).toEqual(
      new Set(['newPet', 'newPet (PUT)', 'onPetEvent', 'broken']),
    );
  });

  it('fails with webhook-definition-missing for an API with no readable cached definition', async () => {
    const imported = await importApi({ cache: false, webhooks: false });

    const error = await failure('api.importWebhooks', { apiId: imported.apiId, keys: [KEYS[0] ?? ''] });
    expect(error.code).toBe('webhook-definition-missing');
  });
});
