// @vitest-environment node
/**
 * The `api.*` channels.
 *
 * Three properties matter more than the plumbing: a `file` source is checked for containment or a
 * dialog pick *before* anything is created, so a refusal changes nothing; a project created for a
 * `newProjectName` import is taken back when placing the API fails; and `definitionText` answers only
 * for a location the API's own manifest lists, so the channel can never be turned into a read of an
 * arbitrary file.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import type { ProjectWire } from '../src/shared/wire-types.js';
import { NO_REST, PROJECT_SETTINGS } from './helpers/wire-defaults.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const pickFolder = vi.fn<() => Promise<string | undefined>>();
vi.mock('../src/main/native-dialogs.js', () => ({
  pickFolder: () => pickFolder(),
  pickSaveFile: () => Promise.resolve(undefined),
  pickOpenFile: () => Promise.resolve(undefined),
}));

const { registerApiChannels } = await import('../src/main/ipc/api.js');
type ApiChannelDeps = Parameters<typeof registerApiChannels>[0];

/** A valid reply body, so an accepted import's envelope passes the response schema. */
const PROJECT: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Pets',
  dir: '/user-data/workspaces/w1/projects/Pets',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

/** What a successful `imports.run` answers with: enough of an import for the channel to place it. */
function imported(): unknown {
  return {
    api: {
      kind: 'rest',
      id: 'api-1',
      name: 'Pets',
      slug: 'Pets',
      order: 0,
      baseUrl: '',
      servers: [],
      folders: [],
      requests: [],
    },
    documents: [
      {
        location: 'https://api.test/openapi.yaml',
        requestedLocation: 'https://api.test/openapi.yaml',
        bytes: new Uint8Array(),
        text: '',
      },
    ],
    document: { declaredVersion: '3.0.3' },
    refProblems: [],
    summary: {
      name: 'Pets',
      title: 'Pets',
      declaredVersion: '3.0.3',
      baseUrl: 'https://api.test',
      servers: [{ url: 'https://api.test' }],
      folders: 1,
      requests: 2,
      deprecated: 0,
      securitySchemes: [
        { name: 'api_key', type: 'apiKey', auth: { type: 'api-key', name: 'api_key', in: 'header' }, applied: false },
      ],
      skipped: [],
      webhooks: 0,
    },
  };
}

const sender = { isDestroyed: () => false, send: vi.fn() };

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

function invoke(channel: string, payload: unknown): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload) as Promise<Envelope>;
}

async function value<T>(channel: string, payload: unknown): Promise<T> {
  const result = await invoke(channel, payload);
  if (!result.ok) {
    throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

async function failure(channel: string, payload: unknown): Promise<{ code?: string }> {
  const result = await invoke(channel, payload);
  if (result.ok) {
    throw new Error(`${channel} unexpectedly succeeded`);
  }
  return result.error as { code?: string };
}

type VariablesPorts = ReturnType<ApiChannelDeps['variablesPorts']>;

/**
 * In-memory ports for the variable importers: what each save received, so a test can assert on it.
 * `project` is present only when `withProject` is, as main gives one only for a collection import.
 */
function fakeVariablesPorts(withProject?: { readonly fail?: boolean }): {
  readonly ports: VariablesPorts;
  readonly environments: { name: string; properties: Record<string, string>; disabled: readonly string[] }[];
  readonly projectMerges: { properties: Record<string, string>; disabled: readonly string[] }[];
  readonly deletedSecrets: string[];
} {
  const environments: { name: string; properties: Record<string, string>; disabled: readonly string[] }[] = [];
  const projectMerges: { properties: Record<string, string>; disabled: readonly string[] }[] = [];
  const deletedSecrets: string[] = [];
  let secrets = 0;
  const ports: VariablesPorts = {
    workspace: {
      environmentNames: () => environments.map((environment) => environment.name),
      addEnvironment: (name, properties, disabled) => {
        environments.push({ name, properties, disabled });
        return Promise.resolve();
      },
      removeEnvironment: (name) => {
        const index = environments.findIndex((environment) => environment.name === name);
        if (index !== -1) environments.splice(index, 1);
        return Promise.resolve();
      },
      propertyNames: () => [],
      mergeProperties: () => Promise.resolve(),
    },
    globals: { get: () => ({ properties: {}, disabled: [] }), merge: () => Promise.resolve() },
    ...(withProject !== undefined
      ? {
          project: {
            propertyNames: () => [],
            merge: (properties: Record<string, string>, disabled: readonly string[]) => {
              if (withProject.fail === true) {
                return Promise.reject(new Error('disk full'));
              }
              projectMerges.push({ properties, disabled });
              return Promise.resolve();
            },
          },
        }
      : {}),
    secrets: {
      set: () => Promise.resolve(`sec_${++secrets}`),
      delete: (ref) => {
        deletedSecrets.push(ref);
        return Promise.resolve(true);
      },
    },
  };
  return { ports, environments, projectMerges, deletedSecrets };
}

/** Registers the channels over stubs, returning the stubs so a test can assert against them. */
/** What a History batch answers when it wrote nothing. */
const NOTHING_RECORDED = { recorded: 0, invalidTime: 0, droppedOlder: 0, droppedImported: 0 };

function setup(overrides: Partial<ApiChannelDeps> = {}): {
  readonly deps: ApiChannelDeps;
  readonly addApi: ReturnType<typeof vi.fn>;
  readonly run: ReturnType<typeof vi.fn>;
} {
  const addApi = vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'api-1' });
  const run = vi.fn().mockResolvedValue(imported());
  const deps: ApiChannelDeps = {
    router: {
      addApi,
      addGrpcApi: vi.fn(),
      importAsyncApi: vi.fn(),
      asyncApiSource: vi.fn(),
      asyncApiPlanUpdate: vi.fn(),
      asyncApiApplyUpdate: vi.fn(),
      restSource: vi.fn(),
      restPlanUpdate: vi.fn(),
      restApplyUpdate: vi.fn(),
      webhookItems: vi.fn(),
      importWebhooks: vi.fn(),
      apiDefinitionDocuments: vi.fn(),
      apiDefinitionText: vi.fn(),
      exportApiDefinitionTo: vi.fn(),
      grpcDefinition: vi.fn(),
      grpcFields: vi.fn(),
      grpcRefresh: vi.fn(),
      grpcSample: vi.fn(),
      writeImportedScripts: vi.fn().mockResolvedValue({ written: [], renamed: [], skipped: [] }),
      importWsApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'ws-1' }),
    },
    imports: { run, cancel: vi.fn().mockReturnValue({ cancelled: true }), readOpenApi: vi.fn() },
    addProject: vi.fn().mockResolvedValue({ projectId: 'p-new' }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    projectDirs: () => [],
    picks: new DialogPicks(),
    variablesPorts: () => fakeVariablesPorts().ports,
    history: {
      open: vi.fn().mockResolvedValue(undefined),
      recordImportedRestBatch: vi.fn().mockResolvedValue(NOTHING_RECORDED),
    },
    onHistoryChanged: vi.fn(),
    ...overrides,
  };
  registerApiChannels(deps);
  return { deps, addApi, run };
}

beforeEach(() => {
  handlers.clear();
  pickFolder.mockReset();
  sender.send.mockReset();
});

describe('api.importOpenApi', () => {
  it('places the imported API in the named project and answers with its summary', async () => {
    const { addApi } = setup();

    const response = await value<{ projectId: string; apiId: string; summary: { requests: number } }>(
      'api.importOpenApi',
      { target: { projectId: 'p1' }, source: { kind: 'url', url: 'https://api.test/openapi.yaml' } },
    );

    expect(response.projectId).toBe('p1');
    expect(response.apiId).toBe('api-1');
    expect(response.summary.requests).toBe(2);
    expect(addApi).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ source: 'https://api.test/openapi.yaml', declaredVersion: '3.0.3' }),
    );
  });

  it('forwards the name, base URL, scheme choice and caching flag it was given', async () => {
    const { addApi, run } = setup();

    await value('api.importOpenApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
      name: 'Pet Store',
      baseUrl: 'https://staging.api.test',
      securityScheme: 'oauthCode',
      cache: false,
      token: 'tok-1',
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pet Store',
        baseUrl: 'https://staging.api.test',
        securityScheme: 'oauthCode',
        token: 'tok-1',
      }),
      expect.anything(),
    );
    expect(addApi).toHaveBeenCalledWith('p1', expect.objectContaining({ cache: false }));
  });

  it('reports progress to the window that asked for the import', async () => {
    setup({
      imports: {
        run: vi.fn((_input: unknown, hooks: { onProgress?: (event: unknown) => void }) => {
          hooks.onProgress?.({ kind: 'import', phase: 'fetch', message: 'Fetching', token: 'tok-1' });
          return Promise.resolve(imported());
        }),
        cancel: vi.fn(),
      } as unknown as ApiChannelDeps['imports'],
    });

    await value('api.importOpenApi', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
      token: 'tok-1',
    });

    expect(sender.send).toHaveBeenCalledWith('engine.progress', expect.objectContaining({ phase: 'fetch' }));
  });

  it('creates a project for a newProjectName target, and takes it back when placing fails', async () => {
    const addApi = vi.fn().mockRejectedValue(new WirebenchError('project-save-failed', 'Disk full'));
    const addProject = vi.fn().mockResolvedValue({ projectId: 'p-new' });
    const removeProject = vi.fn().mockResolvedValue(undefined);
    setup({
      router: { addApi } as unknown as ApiChannelDeps['router'],
      addProject,
      removeProject,
    });

    const error = await failure('api.importOpenApi', {
      target: { newProjectName: 'Pets' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
    });

    expect(error.code).toBe('project-save-failed');
    expect(addProject).toHaveBeenCalledWith('Pets');
    expect(removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });

  it('never creates a project for a document it could not read', async () => {
    const addProject = vi.fn();
    setup({
      imports: {
        run: vi.fn().mockRejectedValue(new WirebenchError('fetch-failed', 'Not found')),
        cancel: vi.fn(),
      } as unknown as ApiChannelDeps['imports'],
      addProject,
    });

    await failure('api.importOpenApi', {
      target: { newProjectName: 'Pets' },
      source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
    });

    expect(addProject).not.toHaveBeenCalled();
  });
});

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

describe('api.importOpenApi with a file source', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempFile(): Promise<{ dir: string; path: string }> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'wirebench-openapi-')));
    dirs.push(dir);
    const path = join(dir, 'openapi.yaml');
    await writeFile(path, 'openapi: 3.0.3\n');
    return { dir, path };
  }

  it('refuses a path that is neither inside a project nor picked, before importing anything', async () => {
    const { path } = await tempFile();
    const { run } = setup();

    const error = await failure('api.importOpenApi', {
      target: { newProjectName: 'Pets' },
      source: { kind: 'file', path },
    });

    expect(error.code).toBe('import-path-refused');
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts a path inside an open project, as a file: URL the engine can resolve against', async () => {
    const { dir, path } = await tempFile();
    const { run } = setup({ projectDirs: () => [dir] });

    await value('api.importOpenApi', { target: { projectId: 'p1' }, source: { kind: 'file', path } });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'file', path: expect.stringMatching(/^file:\/\//) as unknown } }),
      expect.anything(),
    );
  });
});

describe('api.cancelImport', () => {
  it('cancels by token', async () => {
    const cancel = vi.fn().mockReturnValue({ cancelled: true });
    setup({ imports: { run: vi.fn(), cancel } as unknown as ApiChannelDeps['imports'] });

    const response = await value<{ cancelled: boolean }>('api.cancelImport', { token: 'tok-1' });

    expect(response.cancelled).toBe(true);
    expect(cancel).toHaveBeenCalledWith('tok-1');
  });
});

describe("an API's cached definition", () => {
  it('lists its documents by identity and size, never text', async () => {
    const apiDefinitionDocuments = vi.fn().mockResolvedValue({
      documents: [{ location: 'https://api.test/openapi.yaml', size: 120 }],
      rootLocation: 'https://api.test/openapi.yaml',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      declaredVersion: '3.1.0',
    });
    setup({ router: { apiDefinitionDocuments } as unknown as ApiChannelDeps['router'] });

    const response = await value<{ documents: { location: string }[]; declaredVersion?: string }>(
      'api.definitionDocuments',
      { apiId: 'api-1' },
    );

    expect(response.documents).toEqual([{ location: 'https://api.test/openapi.yaml', size: 120 }]);
    expect(response.declaredVersion).toBe('3.1.0');
  });

  it('answers one document’s text, and refuses a location the manifest does not list', async () => {
    const apiDefinitionText = vi.fn((_apiId: string, location: string) => {
      if (location !== 'https://api.test/openapi.yaml') {
        return Promise.reject(new WirebenchError('not-found', 'No such document'));
      }
      return Promise.resolve('openapi: 3.0.3\n');
    });
    setup({ router: { apiDefinitionText } as unknown as ApiChannelDeps['router'] });

    const response = await value<{ text: string }>('api.definitionText', {
      apiId: 'api-1',
      location: 'https://api.test/openapi.yaml',
    });
    expect(response.text).toBe('openapi: 3.0.3\n');

    const error = await failure('api.definitionText', { apiId: 'api-1', location: '/etc/passwd' });
    expect(error.code).toBe('not-found');
  });

  it('refuses to serialise a document too large to show', async () => {
    const apiDefinitionText = vi.fn().mockResolvedValue('x'.repeat(9 * 1024 * 1024));
    setup({ router: { apiDefinitionText } as unknown as ApiChannelDeps['router'] });

    const error = await failure('api.definitionText', { apiId: 'api-1', location: 'https://api.test/openapi.yaml' });

    expect(error.code).toBe('document-too-large');
  });

  it('exports into a folder main’s own dialog named, and does nothing when it is dismissed', async () => {
    const exportApiDefinitionTo = vi.fn().mockResolvedValue(['openapi.yaml', 'schemas.yaml']);
    setup({ router: { exportApiDefinitionTo } as unknown as ApiChannelDeps['router'] });

    pickFolder.mockResolvedValue(undefined);
    const cancelled = await value<{ cancelled: boolean; files: string[] }>('api.exportDefinition', { apiId: 'api-1' });
    expect(cancelled).toEqual({ cancelled: true, files: [] });
    expect(exportApiDefinitionTo).not.toHaveBeenCalled();

    pickFolder.mockResolvedValue('/picked/out');
    const exported = await value<{ cancelled: boolean; dir?: string; files: string[] }>('api.exportDefinition', {
      apiId: 'api-1',
    });
    expect(exported).toEqual({ cancelled: false, dir: '/picked/out', files: ['openapi.yaml', 'schemas.yaml'] });
  });
});

describe('api.grpcRefresh', () => {
  it('asks the router to re-discover, and reports what changed as counts', async () => {
    const grpcRefresh = vi.fn().mockResolvedValue({
      project: {
        ...PROJECT,
        grpcApis: [
          {
            kind: 'grpc',
            id: 'g-1',
            name: 'Greeter',
            slug: 'Greeter',
            order: 0,
            target: 'localhost:50051',
            tls: false,
            metadata: [],
            definition: { kind: 'reflection', source: 'localhost:50051', cache: true, roots: ['greeter.proto'] },
          },
        ],
      },
      summary: { name: 'Greeter', target: 'localhost:50051', files: 3, services: 1, methods: 6, deprecated: 0 },
      reconciled: {
        requestsAdded: ['r-1'],
        requestsOrphaned: ['r-2', 'r-3'],
        requestsRestored: [],
        requestsRetyped: [],
        foldersAdded: ['f-1'],
      },
      version: 'v1alpha',
    });
    setup({ router: { grpcRefresh } as unknown as ApiChannelDeps['router'] });

    const response = await value<{
      projectId: string;
      summary: { kind: string; reflectionVersion: string; roots: string[]; methods: number };
      requestsAdded: number;
      requestsOrphaned: number;
      foldersAdded: number;
    }>('api.grpcRefresh', { apiId: 'g-1', version: 'auto' });

    expect(grpcRefresh).toHaveBeenCalledWith('g-1', { version: 'auto' });
    expect(response.summary).toMatchObject({
      kind: 'reflection',
      reflectionVersion: 'v1alpha',
      roots: ['greeter.proto'],
      methods: 6,
    });
    expect(response.requestsAdded).toBe(1);
    expect(response.requestsOrphaned).toBe(2);
    expect(response.foldersAdded).toBe(1);
  });
});

describe('api.grpcFields', () => {
  it('answers the fields of the message the path resolved to', async () => {
    const grpcFields = vi.fn().mockResolvedValue({
      fullName: 'wirebench.greet.HelloRequest',
      fields: [
        { name: 'name', id: 1, type: 'string', valueKind: 'scalar', repeated: false, optional: false },
        {
          name: 'mood',
          id: 5,
          type: 'wirebench.greet.Mood',
          valueKind: 'enum',
          repeated: false,
          optional: false,
          enumValues: ['MOOD_UNSPECIFIED', 'CHEERFUL'],
          comment: 'The mood.',
        },
      ],
      oneofs: [],
    });
    setup({ router: { grpcFields } as unknown as ApiChannelDeps['router'] });

    const response = await value<{
      fullName?: string;
      fields: { name: string; enumValues?: string[]; comment?: string }[];
    }>('api.grpcFields', { apiId: 'g-1', type: 'wirebench.greet.HelloRequest', path: ['echo'] });

    expect(grpcFields).toHaveBeenCalledWith('g-1', 'wirebench.greet.HelloRequest', ['echo']);
    expect(response.fullName).toBe('wirebench.greet.HelloRequest');
    expect(response.fields.map((field) => field.name)).toEqual(['name', 'mood']);
    expect(response.fields[1]).toMatchObject({ enumValues: ['MOOD_UNSPECIFIED', 'CHEERFUL'], comment: 'The mood.' });
  });

  it('answers no fields for a path that resolves to nothing, rather than failing', async () => {
    // The provider asks about a document mid-edit, where a key naming nothing is the normal case.
    const grpcFields = vi.fn().mockResolvedValue(undefined);
    setup({ router: { grpcFields } as unknown as ApiChannelDeps['router'] });

    const response = await value<{ fullName?: string; fields: unknown[] }>('api.grpcFields', {
      apiId: 'g-1',
      type: 'wirebench.greet.HelloRequest',
      path: ['nope'],
    });

    expect(response).toEqual({ fields: [] });
  });
});

const ENVIRONMENT_EXPORT =
  '{"name":"Staging","values":[{"key":"a","value":"1"}],"_postman_variable_scope":"environment"}';
const GLOBALS_EXPORT = '{"name":"Globals","values":[{"key":"g","value":"2"}],"_postman_variable_scope":"globals"}';

describe('api.importPostmanEnvironment and api.importPostmanGlobals', () => {
  it('api.importPostmanEnvironment applies the plan and returns the summary and report text', async () => {
    const fake = fakeVariablesPorts();
    const variablesPorts = vi.fn().mockReturnValue(fake.ports);
    setup({ variablesPorts });

    const res = await invoke('api.importPostmanEnvironment', { source: { kind: 'text', text: ENVIRONMENT_EXPORT } });

    expect(fake.environments).toEqual([{ name: 'Staging', properties: { a: '1' }, disabled: [] }]);
    expect(variablesPorts).toHaveBeenCalledWith(undefined);
    expect(res).toMatchObject({
      ok: true,
      value: { summary: { environments: [{ name: 'Staging', variables: 1 }], secretsStored: 0 }, reportText: '' },
    });
  });

  it('api.importPostmanGlobals refuses an environment export', async () => {
    const fake = fakeVariablesPorts();
    setup({ variablesPorts: () => fake.ports });

    const res = await invoke('api.importPostmanGlobals', {
      source: { kind: 'text', text: '{"name":"S","values":[],"_postman_variable_scope":"environment"}' },
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'postman-not-globals' } });
    expect(fake.environments).toEqual([]);
  });

  it('api.importPostmanEnvironment refuses a globals export', async () => {
    setup();

    expect(
      await failure('api.importPostmanEnvironment', { source: { kind: 'text', text: GLOBALS_EXPORT } }),
    ).toMatchObject({ code: 'postman-not-environment' });
  });

  it('api.importPostmanGlobals merges a globals export into Globals', async () => {
    const merged: Record<string, string>[] = [];
    const fake = fakeVariablesPorts();
    setup({
      variablesPorts: () => ({
        ...fake.ports,
        globals: {
          get: () => ({ properties: {}, disabled: [] }),
          merge: (properties) => {
            merged.push(properties);
            return Promise.resolve();
          },
        },
      }),
    });

    const response = await value<{ summary: { globals?: { added: number } } }>('api.importPostmanGlobals', {
      source: { kind: 'text', text: GLOBALS_EXPORT },
    });

    expect(merged).toEqual([{ g: '2' }]);
    expect(response.summary.globals).toEqual({ added: 1, skipped: [] });
  });

  it('refuses a file the user neither picked nor keeps in a project, before reading it', async () => {
    const fake = fakeVariablesPorts();
    setup({ variablesPorts: () => fake.ports });

    expect(
      await failure('api.importPostmanEnvironment', { source: { kind: 'file', path: '/etc/staging.json' } }),
    ).toMatchObject({ code: 'import-path-refused' });
    expect(fake.environments).toEqual([]);
  });
});

const COLLECTION_WITH_VARIABLES = JSON.stringify({
  info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [],
  variable: [{ key: 'tenant', value: 'acme' }],
});

describe("api.importPostman and the collection's variables", () => {
  it("adds the collection's variables to the target project as project properties", async () => {
    const fake = fakeVariablesPorts({});
    const variablesPorts = vi.fn().mockReturnValue(fake.ports);
    setup({ variablesPorts });

    const response = await value<{
      summary: { projectProperties?: number };
      variables?: { projectProperties?: { added: number } };
    }>('api.importPostman', { target: { projectId: 'p1' }, source: { kind: 'text', text: COLLECTION_WITH_VARIABLES } });

    expect(variablesPorts).toHaveBeenCalledWith('p1');
    expect(fake.projectMerges).toEqual([{ properties: { tenant: 'acme' }, disabled: [] }]);
    expect(response.summary.projectProperties).toBe(1);
    expect(response.variables?.projectProperties).toEqual({ added: 1, skipped: [] });
  });

  it('answers without a variables summary when the collection has no variables', async () => {
    const variablesPorts = vi.fn();
    setup({ variablesPorts });

    const response = await value<{ variables?: unknown }>('api.importPostman', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: JSON.stringify({ ...JSON.parse(COLLECTION_WITH_VARIABLES), variable: [] }) },
    });

    expect(variablesPorts).not.toHaveBeenCalled();
    expect(response.variables).toBeUndefined();
  });

  it('takes back a project it created when saving the properties fails', async () => {
    const fake = fakeVariablesPorts({ fail: true });
    const { deps } = setup({ variablesPorts: () => fake.ports });

    await failure('api.importPostman', {
      target: { newProjectName: 'Pets' },
      source: { kind: 'text', text: COLLECTION_WITH_VARIABLES },
    });

    expect(deps.removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });
});

/** The crafted capture the engine's HAR tests use: two origins, six recorded exchanges. */
const SESSION_HAR = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/har/crafted/session.har'),
  'utf8',
);

type HarResponse = {
  projectId: string;
  apiIds: string[];
  summary: { apis: number; historyRecorded: number };
  reportText: string;
};

describe('api.importHar', () => {
  it('adds one API per origin and writes the recorded exchanges to History in one batch, tagged', async () => {
    const recordImportedRestBatch = vi.fn().mockResolvedValue({ ...NOTHING_RECORDED, recorded: 6 });
    const open = vi.fn().mockResolvedValue(undefined);
    const onHistoryChanged = vi.fn();
    const { addApi } = setup({ history: { open, recordImportedRestBatch }, onHistoryChanged });

    const response = await value<HarResponse>('api.importHar', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: SESSION_HAR },
      responses: 'history',
    });

    expect(response.apiIds).toHaveLength(2);
    expect(addApi).toHaveBeenCalledTimes(2);
    expect(addApi.mock.calls[0]?.[1]).toMatchObject({ documents: [], source: 'inline:har', cache: false });
    expect(open).toHaveBeenCalledWith('p1');
    expect(recordImportedRestBatch).toHaveBeenCalledTimes(1);
    expect(recordImportedRestBatch.mock.calls[0]?.[0]).toBe('p1');
    const records = recordImportedRestBatch.mock.calls[0]?.[1] as { tags: string[] }[];
    expect(records).toHaveLength(6);
    expect(records.every((record) => record.tags.join() === 'imported:har')).toBe(true);
    expect(response.summary.historyRecorded).toBe(6);
    expect(onHistoryChanged).toHaveBeenCalledWith('p1');
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('reports exchanges with no valid time, and what the History cap dropped', async () => {
    const recordImportedRestBatch = vi
      .fn()
      .mockResolvedValue({ recorded: 3, invalidTime: 2, droppedOlder: 4, droppedImported: 1 });
    setup({ history: { open: vi.fn(), recordImportedRestBatch } });

    const response = await value<HarResponse & { warnings: string[] }>('api.importHar', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: SESSION_HAR },
      responses: 'history',
    });

    expect(response.warnings).toEqual(
      expect.arrayContaining([
        '2 recorded exchanges had no valid time and were not written to History.',
        'History keeps a limited number of entries per project: 4 older History entries were dropped to make room for the import.',
        "1 recorded exchange, the earliest, did not fit under History's per-project limit and was not written.",
      ]),
    );
    expect(response.reportText).toContain('2 recorded exchanges had no valid time');
  });

  it('tells no window History changed when nothing was recorded', async () => {
    const onHistoryChanged = vi.fn();
    setup({
      history: { open: vi.fn(), recordImportedRestBatch: vi.fn().mockResolvedValue(NOTHING_RECORDED) },
      onHistoryChanged,
    });

    const response = await value<HarResponse>('api.importHar', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: SESSION_HAR },
      responses: 'history',
    });

    expect(response.summary.historyRecorded).toBe(0);
    expect(onHistoryChanged).not.toHaveBeenCalled();
  });

  it('writes nothing to History by default', async () => {
    const recordImportedRestBatch = vi.fn();
    setup({ history: { open: vi.fn(), recordImportedRestBatch } });

    const response = await value<HarResponse>('api.importHar', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: SESSION_HAR },
    });

    expect(recordImportedRestBatch).not.toHaveBeenCalled();
    expect(response.summary.historyRecorded).toBe(0);
  });
  it('refuses a capture with nothing left to import, before creating a project', async () => {
    const { deps } = setup();
    const empty = JSON.stringify({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [] } });

    expect(
      await failure('api.importHar', { target: { newProjectName: 'Cap' }, source: { kind: 'text', text: empty } }),
    ).toMatchObject({ code: 'har-nothing-to-import' });
    expect(deps.addProject).not.toHaveBeenCalled();
  });

  it('takes back a project it created when placing an API fails', async () => {
    const { deps, addApi } = setup();
    addApi.mockRejectedValueOnce(new WirebenchError('project-save-failed', 'disk full'));

    await failure('api.importHar', { target: { newProjectName: 'Cap' }, source: { kind: 'text', text: SESSION_HAR } });

    expect(deps.removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });
});

/** The crafted `.http` fixture and its two environment files; the private one holds the password `pw`. */
const HTTP_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/http-file/crafted');

describe('the .http channels', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'wirebench-http-ipc-')));
    for (const name of ['api.http', 'http-client.env.json', 'http-client.private.env.json']) {
      copyFileSync(join(HTTP_FIXTURES, name), join(dir, name));
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Channels over stubs with the `.http` file (or `picked`) remembered as an Open-dialog pick. */
  const setupPicked = (picked = 'api.http', overrides: Partial<ApiChannelDeps> = {}) => {
    const picks = new DialogPicks();
    picks.rememberRead(join(dir, picked));
    const fake = fakeVariablesPorts({});
    const variablesPorts = vi.fn().mockReturnValue(fake.ports);
    const stubs = setup({ picks, variablesPorts, ...overrides });
    return { ...stubs, fake, variablesPorts };
  };

  it('api.inspectHttpFile answers with the environment names beside the file, and no value', async () => {
    setupPicked();

    const res = await invoke('api.inspectHttpFile', { path: join(dir, 'api.http') });

    expect(res).toEqual({ ok: true, value: { environments: ['dev', 'prod'] } });
    expect(JSON.stringify(res)).not.toContain('pw');
  });

  it('api.inspectHttpFile answers with no environments when there are no files beside it', async () => {
    await rm(join(dir, 'http-client.env.json'));
    await rm(join(dir, 'http-client.private.env.json'));
    setupPicked();

    expect(await value('api.inspectHttpFile', { path: join(dir, 'api.http') })).toEqual({ environments: [] });
  });

  it('api.inspectHttpFile refuses a file the user neither picked nor keeps in a project', async () => {
    setup();

    expect(await failure('api.inspectHttpFile', { path: join(dir, 'api.http') })).toMatchObject({
      code: 'import-path-refused',
    });
  });

  it('api.importHttpFile places both APIs, writes the scripts, and imports the environments beside it', async () => {
    const { addApi, deps, fake, variablesPorts } = setupPicked();
    vi.mocked(deps.router.writeImportedScripts).mockResolvedValueOnce({
      written: ['imported-scripts/api/createpet.handler.js'],
      renamed: [],
      skipped: [],
    });

    const res = await invoke('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: join(dir, 'api.http') },
    });

    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('pw');
    const response = (res as { value: { apiIds: string[]; counts: unknown; variables?: { secretsStored: number } } })
      .value;
    expect(addApi.mock.calls[0]?.[1]).toMatchObject({
      source: join(dir, 'api.http'),
      declaredVersion: 'http-file',
      cache: false,
      documents: [],
    });
    const wsCall = vi.mocked(deps.router.importWsApi).mock.calls[0];
    expect(wsCall?.[0]).toBe('p1');
    expect(wsCall?.[1].api.name).toBe('api (WebSocket)');
    expect(response.apiIds).toEqual(['api-1', 'ws-1']);
    expect(response.counts).toEqual({ requests: 4, websocket: 1, skipped: 1, scripts: 1 });
    expect(deps.router.writeImportedScripts).toHaveBeenCalledWith('p1', [
      { path: 'imported-scripts/api/createpet.handler.js', source: 'client.global.set("petId", response.body.id);' },
    ]);
    expect(variablesPorts).toHaveBeenCalledWith('p1');
    expect(fake.environments.map((environment) => environment.name)).toEqual(['dev', 'prod']);
    // Every private value (dev password and user, prod token) went to the secret store, behind a reference.
    expect(fake.environments[0]?.properties['password']).toBe('${secret:sec_1}');
    expect(response.variables?.secretsStored).toBe(3);
    // `@vars` first, then the environment files' `$shared`.
    expect(fake.projectMerges).toEqual([
      { properties: { host: '${baseUrl}/v1', user: 'alice', version: 'v1' }, disabled: [] },
    ]);
  });

  it('api.importHttpFile with includeEnvironments: false adds no environment', async () => {
    const addEnvironment = vi.fn();
    const fake = fakeVariablesPorts({});
    setupPicked('api.http', {
      variablesPorts: () => ({ ...fake.ports, workspace: { ...fake.ports.workspace, addEnvironment } }),
    });

    const res = await invoke('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: join(dir, 'api.http') },
      includeEnvironments: false,
    });

    expect(res.ok).toBe(true);
    expect(addEnvironment).toHaveBeenCalledTimes(0);
    expect(fake.projectMerges).toEqual([{ properties: { host: '${baseUrl}/v1', user: 'alice' }, disabled: [] }]);
  });

  it('api.importHttpFile notes a script it had to save under another name', async () => {
    const { deps } = setupPicked();
    vi.mocked(deps.router.writeImportedScripts).mockResolvedValueOnce({
      written: ['imported-scripts/api/createpet-2.handler.js'],
      renamed: [
        { from: 'imported-scripts/api/createpet.handler.js', to: 'imported-scripts/api/createpet-2.handler.js' },
      ],
      skipped: [],
    });

    const response = await value<{ notes: string[]; reportText: string }>('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: join(dir, 'api.http') },
    });

    const note =
      'A script already existed at imported-scripts/api/createpet.handler.js, so this one was saved as imported-scripts/api/createpet-2.handler.js.';
    expect(response.notes).toContain(note);
    expect(response.reportText).toContain(note);
  });

  it('api.importHttpFile counts only the scripts it wrote, and warns about one it skipped', async () => {
    const { deps } = setupPicked();
    vi.mocked(deps.router.writeImportedScripts).mockResolvedValueOnce({
      written: [],
      renamed: [],
      skipped: ['imported-scripts/api/createpet.handler.js'],
    });

    const response = await value<{ counts: { scripts: number }; warnings: string[] }>('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: join(dir, 'api.http') },
    });

    expect(response.counts.scripts).toBe(0);
    expect(response.warnings).toContain(
      'The script imported-scripts/api/createpet.handler.js would have been saved outside imported-scripts/ and was not written.',
    );
  });

  it("api.importHttpFile names the private file for a private $shared value the file's @variable outranks", async () => {
    await writeFile(join(dir, 'http-client.private.env.json'), '{ "$shared": { "user": "shh" } }');
    await writeFile(join(dir, 'http-client.env.json'), '{ "$shared": { "host": "h" } }');
    setupPicked();

    const response = await value<{ notes: string[] }>('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path: join(dir, 'api.http') },
    });

    expect(response.notes).toContain(
      'Project properties: "user" is defined more than once (http-client.private.env.json); the first value was kept.',
    );
    expect(response.notes).toContain(
      'Project properties: "host" is defined more than once (http-client.env.json); the first value was kept.',
    );
  });

  it('api.importHttpFile takes back a project it created when writing the scripts fails', async () => {
    const { deps } = setupPicked();
    vi.mocked(deps.router.writeImportedScripts).mockRejectedValueOnce(
      new WirebenchError('project-save-failed', 'disk full'),
    );

    expect(
      await failure('api.importHttpFile', {
        target: { newProjectName: 'Pets' },
        source: { kind: 'file', path: join(dir, 'api.http') },
      }),
    ).toMatchObject({ code: 'project-save-failed' });
    expect(deps.removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });

  it('api.importHttpFile refuses an unpicked file before creating a project', async () => {
    const { deps } = setup();

    expect(
      await failure('api.importHttpFile', {
        target: { newProjectName: 'Pets' },
        source: { kind: 'file', path: join(dir, 'api.http') },
      }),
    ).toMatchObject({ code: 'import-path-refused' });
    expect(deps.addProject).not.toHaveBeenCalled();
  });

  it('api.importHttpFile reads a pasted file with no environments', async () => {
    const { variablesPorts } = setupPicked();

    const response = await value<{ apiIds: string[] }>('api.importHttpFile', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text: 'GET https://example.com/a' },
    });

    expect(response.apiIds).toEqual(['api-1']);
    expect(variablesPorts).not.toHaveBeenCalled();
  });

  it('api.importHttpEnv applies a picked private file with its public partner to the workspace', async () => {
    const { fake, variablesPorts } = setupPicked('http-client.private.env.json');

    const res = await invoke('api.importHttpEnv', {
      source: { kind: 'file', path: join(dir, 'http-client.private.env.json') },
    });

    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('pw');
    expect(variablesPorts).toHaveBeenCalledWith(undefined);
    expect(fake.environments.map((environment) => environment.name)).toEqual(['dev', 'prod']);
    expect(fake.environments[0]?.properties).toMatchObject({
      host: 'http://localhost:8080',
      password: '${secret:sec_1}',
      user: '${secret:sec_2}',
    });
  });

  it('api.importHttpEnv reads pasted text as the public file', async () => {
    const { fake } = setupPicked();

    const response = await value<{ summary: { environments: { name: string }[] } }>('api.importHttpEnv', {
      source: { kind: 'text', text: '{"local": {"host": "http://localhost"}}' },
    });

    expect(response.summary.environments.map((environment) => environment.name)).toEqual(['local']);
    expect(fake.environments).toEqual([{ name: 'local', properties: { host: 'http://localhost' }, disabled: [] }]);
  });
});
