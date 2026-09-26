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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Registers the channels over stubs, returning the stubs so a test can assert against them. */
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
      apiDefinitionDocuments: vi.fn(),
      apiDefinitionText: vi.fn(),
      exportApiDefinitionTo: vi.fn(),
      grpcDefinition: vi.fn(),
      grpcFields: vi.fn(),
      grpcRefresh: vi.fn(),
      grpcSample: vi.fn(),
    },
    imports: { run, cancel: vi.fn().mockReturnValue({ cancelled: true }), readOpenApi: vi.fn() },
    addProject: vi.fn().mockResolvedValue({ projectId: 'p-new' }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    projectDirs: () => [],
    picks: new DialogPicks(),
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
