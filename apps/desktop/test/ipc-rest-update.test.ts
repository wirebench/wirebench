// @vitest-environment node
/**
 * `api.restPlanUpdate` and `api.restApplyUpdate`, end to end over a real project host: the plan is
 * made against the API's cached definition, the apply is refused if the source changed since, and a
 * successful apply rewrites the cache, drops the parsed-document memo and saves — or, when the save
 * fails, leaves the project exactly as it was.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { OpenApiImportService } from '../src/main/openapi-import.js';
import { createDefaultFetchDocument, parseOpenApi, writeApiDefinitionCache } from '@wirebench/engine';
import {
  apiRestApplyUpdateResponseSchema,
  apiRestPlanUpdateResponseSchema,
  type ProjectWire,
} from '../src/shared/wire-types.js';

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

const V1 = `openapi: 3.0.3
info:
  title: Pets
  version: '1'
servers:
  - url: https://pets.example.test
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  type: string
  /pets/{id}:
    delete:
      operationId: deletePet
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: gone
`;

const V2 = `openapi: 3.0.3
info:
  title: Pets
  version: '2'
servers:
  - url: https://pets.example.test
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    name:
                      type: string
    post:
      operationId: addPet
      responses:
        '201':
          description: made
`;

let root: string;
let projectDir: string;
let docPath: string;
let host: ProjectHost;

beforeEach(async () => {
  handlers.clear();
  root = mkdtempSync(join(tmpdir(), 'wirebench-rest-update-'));
  projectDir = join(root, 'Pets');
  await mkdir(projectDir, { recursive: true });
  docPath = join(projectDir, 'openapi.yaml');
  await writeFile(docPath, V1);

  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(projectDir, 'project'), name: 'Pets' });

  const imports = new OpenApiImportService();
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
  };
  registerApiChannels(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function importPets(cache = true): Promise<string> {
  const imported = await value<{ apiId: string }>('api.importOpenApi', {
    source: { kind: 'file', path: docPath },
    target: { projectId: 'p1' },
    cache,
  });
  return imported.apiId;
}

function requests(apiId: string) {
  return (host.snapshot() as ProjectWire).restRequests.filter((request) => request.apiId === apiId);
}

describe('api.restPlanUpdate / api.restApplyUpdate', () => {
  it('plans against the cache, then applies: orphans, adds, rewrites the cache, drops the memo, saves', async () => {
    const apiId = await importPets();
    const get = requests(apiId).find((r) => r.method === 'GET');
    const before = await host.restContractFor(get?.id ?? '', { method: 'GET', url: 'https://pets.example.test/pets' });
    expect(JSON.stringify(before?.responses)).not.toContain('"object"');

    await writeFile(docPath, V2);
    const plan = apiRestPlanUpdateResponseSchema.parse(await value('api.restPlanUpdate', { apiId }));
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.added.map((op) => `${op.method} ${op.path}`)).toEqual(['post /pets']);
    expect(plan.removed.map((op) => `${op.method} ${op.path}`)).toEqual(['delete /pets/{id}']);
    expect(plan.changed.find((c) => c.op.path === '/pets')?.reasons).toContain('responses');
    // Planning changed nothing.
    expect(requests(apiId).some((r) => r.orphaned === true)).toBe(false);

    const save = vi.spyOn(host, 'save');
    const applied = apiRestApplyUpdateResponseSchema.parse(
      await value('api.restApplyUpdate', { apiId, fingerprint: plan.fingerprint }),
    );
    expect(save).toHaveBeenCalledWith({ reason: 'update-definition' });
    expect(applied.applied.requestsOrphaned).toBe(1);
    expect(applied.applied.requestsAdded).toBe(1);
    expect({ ...applied.plan, fingerprint: plan.fingerprint }).toEqual(plan);
    expect(requests(apiId).find((r) => r.method === 'DELETE')?.orphaned).toBe(true);

    const slug = applied.project.apis.find((a) => a.id === apiId)?.slug ?? '';
    const cached = await readFile(join(projectDir, 'project', 'apis', slug, 'definition', 'openapi.yaml'), 'utf8');
    expect(cached).toBe(V2);
    const after = await host.restContractFor(get?.id ?? '', { method: 'GET', url: 'https://pets.example.test/pets' });
    expect(JSON.stringify(after?.responses)).toContain('"object"');
  });

  it('refuses to apply when the source changed after it was planned, applying nothing', async () => {
    const apiId = await importPets();
    await writeFile(docPath, V2);
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId });
    await writeFile(docPath, V2.replace("version: '2'", "version: '3'"));
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: plan.fingerprint });
    expect(error.code).toBe('definition-changed');
    expect(requests(apiId).some((r) => r.orphaned === true)).toBe(false);
    expect(requests(apiId)).toHaveLength(2);
  });

  it('refuses a chosen source outside every project that was not picked', async () => {
    const apiId = await importPets();
    const outside = join(root, 'elsewhere.yaml');
    await writeFile(outside, V2);
    const error = await failure('api.restPlanUpdate', { apiId, source: { kind: 'file', path: outside } });
    expect(error.code).toBe('import-path-refused');
  });

  it('reads a chosen source and records it as the definition source after apply', async () => {
    const apiId = await importPets();
    const chosen = join(projectDir, 'v2.yaml');
    await writeFile(chosen, V2);
    const source = { kind: 'file', path: chosen };
    const plan = await value<{ fingerprint: string; added: unknown[] }>('api.restPlanUpdate', { apiId, source });
    expect(plan.added).toHaveLength(1);
    const applied = apiRestApplyUpdateResponseSchema.parse(
      await value('api.restApplyUpdate', { apiId, source, fingerprint: plan.fingerprint }),
    );
    expect(applied.project.apis.find((a) => a.id === apiId)?.definition?.source).toBe(chosen);
  });

  it('rolls the project back when the save fails', async () => {
    const apiId = await importPets();
    await writeFile(docPath, V2);
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId });
    const snapshot = JSON.stringify(host.snapshot());
    const slug = (host.snapshot() as ProjectWire).apis.find((a) => a.id === apiId)?.slug ?? '';
    vi.spyOn(host, 'save').mockRejectedValueOnce(new Error('disk full'));
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: plan.fingerprint });
    expect(error).toBeDefined();
    expect(JSON.stringify(host.snapshot())).toBe(snapshot);
    const cached = await readFile(join(projectDir, 'project', 'apis', slug, 'definition', 'openapi.yaml'), 'utf8');
    expect(cached).toBe(V1);
  });

  it('refuses to plan for an API that did not cache its definition', async () => {
    const apiId = await importPets(false);
    await writeFile(docPath, V2);
    const error = await failure('api.restPlanUpdate', { apiId });
    expect(error.code).toBe('definition-not-cached');
  });

  it('refuses to apply when the cache changed after the plan was made', async () => {
    const apiId = await importPets();
    await writeFile(docPath, V2);
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId });
    const slug = (host.snapshot() as ProjectWire).apis.find((a) => a.id === apiId)?.slug ?? '';
    const other = await parseOpenApi(
      { kind: 'text', text: V1.replace("version: '1'", "version: '1.1'") },
      {
        fetchDocument: createDefaultFetchDocument(),
      },
    );
    await writeApiDefinitionCache(other.documents, join(projectDir, 'project', 'apis', slug, 'definition'), {
      declaredVersion: '3.0.3',
    });
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: plan.fingerprint });
    expect(error.code).toBe('definition-changed');
    expect(requests(apiId).some((r) => r.orphaned === true)).toBe(false);
  });

  it('applies onto an edit made while the cache was being read', async () => {
    const apiId = await importPets();
    await writeFile(docPath, V2);
    const next = await parseOpenApi({ kind: 'text', text: V2 }, { fetchDocument: createDefaultFetchDocument() });
    await host.applyRestUpdate(apiId, next, {
      check: async () => {
        await host.mutate({ kind: 'update-api', apiId, patch: { name: 'Renamed meanwhile' } });
      },
    });
    const api = (host.snapshot() as ProjectWire).apis.find((a) => a.id === apiId);
    expect(api?.name).toBe('Renamed meanwhile');
    expect(requests(apiId).find((r) => r.method === 'DELETE')?.orphaned).toBe(true);
  });

  it('refuses to apply for an API that did not cache its definition', async () => {
    const apiId = await importPets(false);
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: '0'.repeat(64) });
    expect(error.code).toBe('definition-not-cached');
  });

  it('refuses without a source when the API was imported from pasted text', async () => {
    const imported = await value<{ apiId: string }>('api.importOpenApi', {
      source: { kind: 'text', text: V1 },
      target: { projectId: 'p1' },
      cache: true,
    });
    const error = await failure('api.restPlanUpdate', { apiId: imported.apiId });
    expect(error.code).toBe('definition-source-unavailable');
  });

  it('rejects a fingerprint that is not 64 hex characters', async () => {
    const apiId = await importPets();
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: 'nope' });
    expect(error.code).not.toBe('definition-changed');
  });
});
