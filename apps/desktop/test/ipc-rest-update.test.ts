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
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { OpenApiImportService } from '../src/main/openapi-import.js';
import { createDefaultFetchDocument, parseOpenApi, writeApiDefinitionCache } from '@wirebench/engine';
import type { DocumentFetchOptions, FetchDocument } from '@wirebench/engine';
import {
  apiRestApplyUpdateResponseSchema,
  apiRestPlanUpdateResponseSchema,
  type ProjectWire,
} from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

/** Lets one test make the definition-cache rewrite fail *after* the project has been saved. */
const cacheState = vi.hoisted(() => ({ fails: false }));

vi.mock('@wirebench/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wirebench/engine')>();
  return {
    ...actual,
    writeApiDefinitionCache: (...args: Parameters<typeof actual.writeApiDefinitionCache>) =>
      cacheState.fails ? Promise.reject(new Error('disk full')) : actual.writeApiDefinitionCache(...args),
  };
});

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

/** `https://defs.test/<name>` is `<name>` in the project folder: a source read by URL, served offline. */
const DEFS = 'https://defs.test/';
/** Another origin serving the same files, for a chosen URL off the recorded source's origin. */
const MIRROR = 'https://mirror.test/';
/** The keychain, by reference: a test deletes an entry to leave a reference dangling. */
let secrets: Record<string, string>;
/** Every fetcher the import service built, with its options: which credentials each read went with. */
let built: DocumentFetchOptions[];
/** Every location a fetcher was asked for. */
let fetched: string[];

beforeEach(async () => {
  handlers.clear();
  cacheState.fails = false;
  root = mkdtempSync(join(tmpdir(), 'wirebench-rest-update-'));
  projectDir = join(root, 'Pets');
  await mkdir(projectDir, { recursive: true });
  docPath = join(projectDir, 'openapi.yaml');
  await writeFile(docPath, V1);

  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(projectDir, 'project'), name: 'Pets' });

  secrets = { 'ref-p': 'hunter2', 'ref-t': 'tok-123' };
  built = [];
  fetched = [];
  const real = createDefaultFetchDocument();
  const fetchDocument: FetchDocument = (location, signal) => {
    fetched.push(location);
    const origin = [DEFS, MIRROR].find((prefix) => location.startsWith(prefix));
    return origin !== undefined
      ? real(pathToFileURL(join(projectDir, location.slice(origin.length))).href, signal).then((document) => ({
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
    // The caller passed no source, so the plan names the recorded one it read: the dialog has no
    // other way to say what it planned against.
    expect(plan.source).toContain(docPath);
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
    // `source` and `fingerprint` are the preview envelope's, not the plan's: apply carries neither.
    expect({ ...applied.plan, source: plan.source, fingerprint: plan.fingerprint }).toEqual(plan);
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

  it('refuses a file: URL, which would read off disk without the path check', async () => {
    const apiId = await importPets();
    const outside = join(root, 'elsewhere.yaml');
    await writeFile(outside, V2);
    const error = await failure('api.restPlanUpdate', {
      apiId,
      source: { kind: 'url', url: `file://${outside}` },
    });
    expect(error.code).toBe('ipc-invalid-request');
    expect(requests(apiId)).toHaveLength(2);
  });

  it('still answers with the updated project when the cache rewrite fails after the save', async () => {
    const apiId = await importPets();
    await writeFile(docPath, V2);
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId });
    const slug = (host.snapshot() as ProjectWire).apis.find((a) => a.id === apiId)?.slug ?? '';
    cacheState.fails = true;
    const applied = apiRestApplyUpdateResponseSchema.parse(
      await value('api.restApplyUpdate', { apiId, fingerprint: plan.fingerprint }),
    );
    expect(applied.applied.requestsOrphaned).toBe(1);
    expect(applied.project.apis.find((a) => a.id === apiId)?.definition?.version).toBe('3.0.3');
    // Told to the user on the response — a project problem alone is never shown — and recorded.
    expect(applied.warning).toContain('could not be refreshed');
    expect(applied.project.problems.map((p) => p.code)).toContain('definition-cache-write-failed');
    // The cache is untouched, so the next update simply re-runs this one.
    const cached = await readFile(join(projectDir, 'project', 'apis', slug, 'definition', 'openapi.yaml'), 'utf8');
    expect(cached).toBe(V1);
  });

  it('keeps one cache-failure problem however often the write fails, and clears it when it works', async () => {
    const apiId = await importPets();
    const failed = async (): Promise<ProjectWire> => {
      await writeFile(docPath, V2.replace("version: '2'", `version: '${String(Math.random())}'`));
      const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId });
      const applied = await value<{ project: ProjectWire }>('api.restApplyUpdate', {
        apiId,
        fingerprint: plan.fingerprint,
      });
      return applied.project;
    };
    cacheState.fails = true;
    await failed();
    const twice = await failed();
    expect(twice.problems.filter((p) => p.code === 'definition-cache-write-failed')).toHaveLength(1);

    cacheState.fails = false;
    const worked = await failed();
    expect(worked.problems.some((p) => p.code === 'definition-cache-write-failed')).toBe(false);
  });

  it('rejects a fingerprint that is not 64 hex characters', async () => {
    const apiId = await importPets();
    const error = await failure('api.restApplyUpdate', { apiId, fingerprint: 'nope' });
    expect(error.code).not.toBe('definition-changed');
  });
});

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

  it('leaves the stored credentials alone when a chosen URL is only planned', async () => {
    const apiId = await importByUrl();
    await writeFile(docPath, V2);

    await value('api.restPlanUpdate', { apiId, source: { ...URL_SOURCE, auth: BEARER } });

    expect(built.at(-1)?.auth).toEqual({ type: 'bearer', token: 'tok-123' });
    expect(definition(apiId)).toMatchObject({ source: URL_SOURCE.url, auth: BASIC });
  });

  it('leaves the stored credentials alone when the apply is refused as definition-changed', async () => {
    const apiId = await importByUrl();
    await writeFile(docPath, V2);
    const source = { ...URL_SOURCE, auth: BEARER };
    const plan = await value<{ fingerprint: string }>('api.restPlanUpdate', { apiId, source });
    await writeFile(docPath, V2.replace("version: '2'", "version: '3'"));

    const error = await failure('api.restApplyUpdate', { apiId, source, fingerprint: plan.fingerprint });

    expect(error.code).toBe('definition-changed');
    expect(definition(apiId)).toMatchObject({ source: URL_SOURCE.url, auth: BASIC });
  });

  it('reads a chosen URL on another origin with no credentials, though the API has stored ones', async () => {
    const apiId = await importByUrl();
    await writeFile(docPath, V2);
    built = [];
    fetched = [];
    const mirrored = `${MIRROR}openapi.yaml`;

    await value('api.restPlanUpdate', { apiId, source: { kind: 'url', url: mirrored } });

    expect(fetched).toEqual([mirrored]);
    expect(built).toHaveLength(1);
    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
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
