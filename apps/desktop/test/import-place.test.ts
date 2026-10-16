// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApi, createGrpcApi, createWsApi } from '@wirebench/engine';
import type { MappedForPlacing } from '../src/main/import-place.js';
import { placeMappedImport } from '../src/main/import-place.js';
import type { ApiChannelDeps } from '../src/main/ipc/api.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

const PROJECT = { id: 'p1' } as unknown as ProjectWire;

function stubs() {
  const merges: Record<string, string>[] = [];
  const router = {
    addApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'rest-1' }),
    addGrpcApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'grpc-proto-1' }),
    importGrpcApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'grpc-1' }),
    importWsApi: vi.fn().mockResolvedValue({ project: PROJECT, apiId: 'ws-1' }),
    writeImportedScripts: vi.fn().mockResolvedValue({
      written: ['imported-scripts/a/x.pre.js'],
      renamed: [{ from: 'imported-scripts/a/y.pre.js', to: 'imported-scripts/a/y-2.pre.js' }],
      skipped: [],
    }),
  };
  const variablesPorts = vi.fn().mockReturnValue({
    workspace: {
      environmentNames: () => [],
      addEnvironment: () => Promise.resolve(),
      removeEnvironment: () => Promise.resolve(),
      propertyNames: () => [],
      mergeProperties: () => Promise.resolve(),
    },
    globals: { get: () => ({ properties: {}, disabled: [] }), merge: () => Promise.resolve() },
    project: {
      propertyNames: () => [],
      merge: (properties: Record<string, string>) => {
        merges.push(properties);
        return Promise.resolve();
      },
    },
    secrets: { set: () => Promise.resolve('sec_1'), delete: () => Promise.resolve(true) },
  });
  const deps = { router, variablesPorts } as unknown as Pick<ApiChannelDeps, 'router' | 'variablesPorts'>;
  return { deps, router, variablesPorts, merges };
}

const EMPTY_PLAN = { environments: [], report: { warnings: [], notes: [] } };

const mapped = (extra: Partial<MappedForPlacing> = {}): MappedForPlacing => ({
  collections: [
    {
      name: 'One',
      rest: createApi('One'),
      grpc: createGrpcApi('One (gRPC)'),
      websocket: createWsApi('One (WebSocket)'),
    },
    { name: 'Two', rest: createApi('Two') },
  ],
  variables: EMPTY_PLAN,
  report: { warnings: ['w1'], notes: ['n1'] },
  ...extra,
});

describe('placeMappedImport', () => {
  it('places rest, grpc and websocket APIs in order', async () => {
    const { deps, router } = stubs();
    const placed = await placeMappedImport(deps, 'p1', mapped(), { source: '/x.yaml', declaredVersion: 'insomnia' });
    expect(placed.apiIds).toEqual(['rest-1', 'grpc-1', 'ws-1', 'rest-1']);
    expect(router.addApi.mock.calls[0]?.[1]).toMatchObject({
      source: '/x.yaml',
      declaredVersion: 'insomnia',
      cache: false,
    });
    expect(router.addGrpcApi).not.toHaveBeenCalled();
  });

  it('places a gRPC API with its protos through the definition path', async () => {
    const { deps, router } = stubs();
    const grpcProtos = { sources: new Map([['a.proto', 'syntax = "proto3";']]), roots: ['a.proto'] };
    const placed = await placeMappedImport(
      deps,
      'p1',
      mapped({ collections: [{ name: 'G', grpc: createGrpcApi('G'), grpcProtos }] }),
      { source: '/x.json', declaredVersion: 'insomnia' },
    );
    expect(placed.apiIds).toEqual(['grpc-proto-1']);
    expect(router.addGrpcApi.mock.calls[0]?.[1]).toMatchObject({ kind: 'proto', roots: ['a.proto'] });
  });

  it('places a gRPC API with no definition, and says why, when its protos do not load', async () => {
    const { deps, router } = stubs();
    const grpcProtos = { sources: new Map([['a.proto', 'syntax = "proto3"; message {']]), roots: ['a.proto'] };
    const placed = await placeMappedImport(
      deps,
      'p1',
      mapped({ collections: [{ name: 'G', grpc: createGrpcApi('G'), grpcProtos }] }),
      { source: '/x.json', declaredVersion: 'insomnia' },
    );
    expect(router.addGrpcApi).not.toHaveBeenCalled();
    expect(placed.apiIds).toEqual(['grpc-1']);
    expect(placed.warnings.some((warning) => warning.startsWith('G: its .proto files did not load'))).toBe(true);
    expect(placed.notes).toContain('G: needs a definition: import its .proto or use server reflection.');
  });

  it('applies variables only when the plan has some', async () => {
    const quiet = stubs();
    const none = await placeMappedImport(quiet.deps, 'p1', mapped(), { source: 's', declaredVersion: 'v' });
    expect(none.variables).toBeUndefined();
    expect(quiet.variablesPorts).not.toHaveBeenCalled();

    const busy = stubs();
    const plan = {
      environments: [],
      projectProperties: {
        name: 'Project properties',
        variables: [{ name: 'a', value: '1', enabled: true, secret: false }],
      },
      report: { warnings: [], notes: ['plan note'] },
    };
    const some = await placeMappedImport(busy.deps, 'p1', mapped({ variables: plan }), {
      source: 's',
      declaredVersion: 'v',
    });
    expect(some.variables?.projectProperties?.added).toBe(1);
    expect(busy.merges).toEqual([{ a: '1' }]);
    expect(some.notes).toContain('plan note');
  });

  it('writes scripts and reports a renamed one', async () => {
    const { deps, router } = stubs();
    const scripts = [{ path: 'imported-scripts/a/x.pre.js', source: 'x' }];
    const placed = await placeMappedImport(deps, 'p1', mapped({ scripts }), { source: 's', declaredVersion: 'v' });
    expect(router.writeImportedScripts).toHaveBeenCalledWith('p1', scripts);
    expect(placed.scripts).toBe(1);
    expect(placed.notes).toContain(
      'A script already existed at imported-scripts/a/y.pre.js, so this one was saved as imported-scripts/a/y-2.pre.js.',
    );
  });

  it('merges mapped and variable reports', async () => {
    const { deps } = stubs();
    const placed = await placeMappedImport(
      deps,
      'p1',
      mapped({ variables: { environments: [], report: { warnings: ['vw'], notes: ['vn'] } } }),
      { source: 's', declaredVersion: 'v' },
    );
    expect(placed.warnings).toEqual(['w1', 'vw']);
    expect(placed.notes).toEqual(['n1', 'vn']);
    expect(placed.reportText).toBe('Warning: w1\nWarning: vw\nNote: n1\nNote: vn');
  });
});
