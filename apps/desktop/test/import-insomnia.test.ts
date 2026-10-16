// @vitest-environment node
/**
 * `api.importInsomnia` and `api.importClientEnvironments`: an Insomnia export read in main, placed in
 * a project (made for the import when asked for) or, for an environment file, in the workspace.
 */
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../src/main/native-dialogs.js', () => ({
  pickFolder: () => Promise.resolve(undefined),
  pickSaveFile: () => Promise.resolve(undefined),
  pickOpenFile: () => Promise.resolve(undefined),
}));

const { registerApiChannelsWithKinds } = await import('./helpers/kind-channels.js');
type ApiChannelDeps = Parameters<typeof registerApiChannelsWithKinds>[0];
type VariablesPorts = ReturnType<ApiChannelDeps['variablesPorts']>;

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/insomnia/crafted');
const PROJECT: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Imported',
  dir: '/user-data/workspaces/w1/projects/Imported',
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

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };
const invoke = (channel: string, payload: unknown): Promise<Envelope> => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: { isDestroyed: () => false, send: vi.fn() } }, payload) as Promise<Envelope>;
};
async function value<T>(channel: string, payload: unknown): Promise<T> {
  const result = await invoke(channel, payload);
  if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

function fakePorts(withProject: boolean) {
  const environments: {
    name: string;
    properties: Record<string, string>;
    disabled: readonly string[];
    color?: string;
  }[] = [];
  const projectMerges: Record<string, string>[] = [];
  const secrets = new Map<string, string>();
  const ports: VariablesPorts = {
    workspace: {
      environmentNames: () => environments.map((environment) => environment.name),
      addEnvironment: (name, properties, disabled, color) => {
        environments.push({ name, properties, disabled, ...(color !== undefined ? { color } : {}) });
        return Promise.resolve();
      },
      removeEnvironment: () => Promise.resolve(),
      propertyNames: () => [],
      mergeProperties: () => Promise.resolve(),
    },
    globals: { get: () => ({ properties: {}, disabled: [] }), merge: () => Promise.resolve() },
    ...(withProject
      ? {
          project: {
            propertyNames: () => [],
            merge: (properties: Record<string, string>) => {
              projectMerges.push(properties);
              return Promise.resolve();
            },
          },
        }
      : {}),
    secrets: {
      set: (secretValue) => {
        const ref = `sec_${secrets.size + 1}`;
        secrets.set(ref, secretValue);
        return Promise.resolve(ref);
      },
      delete: () => Promise.resolve(true),
    },
  };
  return { ports, environments, projectMerges, secrets };
}

function setup(overrides: Partial<ApiChannelDeps> = {}) {
  const addApi = vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'api-1' });
  const fake = fakePorts(true);
  const variablesPorts = vi.fn(
    (projectId: string | undefined) => (projectId === undefined ? fakePorts(false) : fake).ports,
  );
  const deps = {
    router: {
      addApi,
      addGrpcApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'grpc-1' }),
      writeImportedScripts: vi.fn().mockResolvedValue({ written: [], renamed: [], skipped: [] }),
      importWsApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'ws-1' }),
      importGrpcApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'grpc-2' }),
    },
    imports: { run: vi.fn(), cancel: vi.fn(), readOpenApi: vi.fn() },
    addProject: vi.fn().mockResolvedValue({ projectId: 'p-new' }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    projectDirs: () => [],
    picks: new DialogPicks(),
    variablesPorts,
    history: { open: vi.fn(), recordImportedRestBatch: vi.fn() },
    onHistoryChanged: vi.fn(),
    ...overrides,
  } as unknown as ApiChannelDeps;
  registerApiChannelsWithKinds(deps);
  return { deps, addApi, variablesPorts, fake };
}

type Response = {
  projectId: string;
  apiIds: string[];
  counts: { requests: number };
  reportText: string;
  warnings: string[];
};

describe('api.importInsomnia', () => {
  let dir = '';
  beforeEach(() => {
    handlers.clear();
    dir = mkdtempSync(join(tmpdir(), 'wirebench-insomnia-'));
    cpSync(FIXTURES, dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports a picked v5 file into a new project', async () => {
    const picks = new DialogPicks();
    const file = join(dir, 'v5-collection.yaml');
    picks.rememberRead(file);
    const { deps, addApi } = setup({ picks });

    const response = await value<Response>('api.importInsomnia', {
      target: { newProjectName: 'From Insomnia' },
      source: { kind: 'file', path: file },
    });

    expect(deps.addProject).toHaveBeenCalledWith('From Insomnia');
    expect(response.projectId).toBe('p-new');
    expect(response.apiIds[0]).toBe('api-1');
    expect(response.counts.requests).toBeGreaterThan(0);
    expect(addApi.mock.calls[0]?.[0]).toBe('p-new');
    expect(addApi.mock.calls[0]?.[1]).toMatchObject({ declaredVersion: 'insomnia', source: file, cache: false });
  });

  it('imports pasted v4 JSON', async () => {
    const { addApi, deps } = setup();
    const text = readFileSync(join(dir, 'v4.json'), 'utf8');

    const response = await value<Response>('api.importInsomnia', {
      target: { projectId: 'p1' },
      source: { kind: 'text', text },
    });

    expect(deps.addProject).not.toHaveBeenCalled();
    expect(response.projectId).toBe('p1');
    expect(addApi.mock.calls[0]?.[1]).toMatchObject({ declaredVersion: 'insomnia', source: 'inline:insomnia' });
    expect(response.reportText).not.toBe('');
  });

  it('removes a created project when placing fails', async () => {
    const { deps, addApi } = setup();
    addApi.mockRejectedValue(new Error('disk full'));

    const result = await invoke('api.importInsomnia', {
      target: { newProjectName: 'Doomed' },
      source: { kind: 'text', text: readFileSync(join(dir, 'v4.json'), 'utf8') },
    });

    expect(result.ok).toBe(false);
    expect(deps.removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });

  it('refuses a file that was not picked, before creating a project', async () => {
    const { deps } = setup();
    const result = await invoke('api.importInsomnia', {
      target: { newProjectName: 'X' },
      source: { kind: 'file', path: join(dir, 'v5-collection.yaml') },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
    expect(deps.addProject).not.toHaveBeenCalled();
  });
});

describe('api.importInsomnia: protos', () => {
  beforeEach(() => {
    handlers.clear();
  });

  const GOOD = 'syntax = "proto3"; package a; message M { string id = 1; }';
  const proto = (id: string, parent: string, name: string, protoText: string) => ({
    _id: id,
    parentId: parent,
    _type: 'proto_file',
    name,
    protoText,
  });
  const grpcReq = (id: string, parent: string, protoFileId: string) => ({
    _id: id,
    parentId: parent,
    _type: 'grpc_request',
    name: 'Get',
    url: 'grpc://localhost:50051',
    protoFileId,
    protoMethodName: '/a.S/Get',
    body: { text: '{}' },
    metadata: [],
  });
  const workspace = (id: string, name: string) => ({ _id: id, parentId: null, _type: 'workspace', name });
  const exportOf = (...resources: unknown[]) =>
    JSON.stringify({ _type: 'export', __export_format: 4, __export_date: '2026-01-01', resources });
  const run = (text: string) =>
    value<Response>('api.importInsomnia', { target: { projectId: 'p1' }, source: { kind: 'text', text } });

  it('places a gRPC API with the proto set its requests name', async () => {
    const { deps } = setup();
    await run(
      exportOf(
        workspace('wrk_1', 'W'),
        { _id: 'pd_1', parentId: 'wrk_1', _type: 'proto_directory', name: 'protos' },
        proto('pf_1', 'pd_1', 'a.proto', GOOD),
        grpcReq('greq_1', 'wrk_1', 'pf_1'),
      ),
    );
    const call = vi.mocked(deps.router.addGrpcApi).mock.calls[0];
    expect(call?.[1]).toMatchObject({ kind: 'proto', roots: ['protos/a.proto'] });
    expect(deps.router.importGrpcApi).not.toHaveBeenCalled();
  });

  it('an unparsable proto warns and leaves that API without a definition', async () => {
    const { deps } = setup();
    const response = await run(
      exportOf(
        workspace('wrk_1', 'W'),
        proto('pf_1', 'wrk_1', 'a.proto', 'this is not proto {{'),
        grpcReq('g', 'wrk_1', 'pf_1'),
      ),
    );
    expect(deps.router.addGrpcApi).not.toHaveBeenCalled();
    expect(deps.router.importGrpcApi).toHaveBeenCalledTimes(1);
    expect(response.warnings.join('\n')).toContain('could not be loaded');
  });

  it('two workspaces each holding service.proto keep their own contents', async () => {
    const { deps } = setup();
    await run(
      exportOf(
        workspace('wrk_1', 'One'),
        workspace('wrk_2', 'Two'),
        proto('pf_1', 'wrk_1', 'service.proto', 'syntax = "proto3"; package one; message M {}'),
        proto('pf_2', 'wrk_2', 'service.proto', 'syntax = "proto3"; package two; message M {}'),
        grpcReq('g1', 'wrk_1', 'pf_1'),
        grpcReq('g2', 'wrk_2', 'pf_2'),
      ),
    );
    const calls = vi.mocked(deps.router.addGrpcApi).mock.calls;
    expect(calls).toHaveLength(2);
    const texts = calls.map((call) => {
      const input = call[1];
      return input.kind === 'proto' ? [...input.sources.values()] : [];
    });
    expect(texts[0]).toEqual(['syntax = "proto3"; package one; message M {}']);
    expect(texts[1]).toEqual(['syntax = "proto3"; package two; message M {}']);
  });
});

describe('api.importClientEnvironments', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('an environment file goes to the workspace with no project', async () => {
    const { deps, variablesPorts } = setup();
    const text = readFileSync(join(FIXTURES, 'v5-environment.yaml'), 'utf8');
    const ports = fakePorts(false);
    variablesPorts.mockReturnValue(ports.ports);

    const response = await value<{ summary: { environments: { name: string }[] }; reportText: string }>(
      'api.importClientEnvironments',
      { format: 'insomnia', source: { kind: 'text', text } },
    );

    expect(deps.addProject).not.toHaveBeenCalled();
    expect(variablesPorts).toHaveBeenCalledWith(undefined);
    expect(response.summary.environments.map((environment) => environment.name)).toEqual(['Staging']);
    // The vault secret is a reference to a named secret, never a plain property; the colour is kept.
    expect(ports.environments[0]?.properties['svcPassword']).toMatch(/^\$\{secret:sec_\d+\}$/);
    expect(ports.environments[0]?.color).toBe('#ff8800');
    expect(response.reportText).toContain('svcPassword');
  });
});
