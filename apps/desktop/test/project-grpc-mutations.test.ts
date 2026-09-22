/**
 * The gRPC mutations: what each `ProjectChange` does to the model, and the rules the file layout
 * depends on — unique slugs inside a container, a rename that moves files, and a move that stays
 * inside its own API.
 */
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcFolder, createGrpcRequest, createProject, ProjectError } from '@wirebench/engine';
import type { GrpcApi, GrpcRequestDef, Project } from '@wirebench/engine';
import {
  addGrpcApi,
  addGrpcFolder,
  addGrpcRequest,
  cloneGrpcRequest,
  findGrpcRequest,
  grpcAuthChainFor,
  locateGrpcRequest,
  moveGrpcNode,
  removeGrpcApi,
  removeGrpcFolder,
  removeGrpcRequest,
  updateGrpcApi,
  updateGrpcFolder,
  updateGrpcRequest,
  withGrpcPatch,
} from '../src/main/project-grpc-mutations.js';
import { applyChange } from '../src/main/project-mutations.js';

/** A project with one gRPC API: a root request and a `Greeter` folder with two requests. */
function seeded(): Project {
  const api: GrpcApi = createGrpcApi('Greeter API', {
    id: 'g-1',
    target: 'localhost:50051',
    auth: { type: 'bearer', tokenRef: 'sec_t' },
    requests: [createGrpcRequest('Health', { id: 'q-root', order: 0, service: 'a.Health', method: 'Check' })],
    folders: [
      createGrpcFolder('Greeter', {
        id: 'f-greet',
        order: 0,
        auth: { type: 'none' },
        requests: [
          createGrpcRequest('SayHello', { id: 'q-hello', order: 0, service: 'a.Greeter', method: 'SayHello' }),
          createGrpcRequest('Chat', {
            id: 'q-chat',
            order: 1,
            service: 'a.Greeter',
            method: 'Chat',
            methodKind: 'bidi-streaming',
          }),
        ],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), grpcApis: [api] };
}

const api = (project: Project): GrpcApi => project.grpcApis[0]!;

describe('add-grpc-api', () => {
  it('adds an API ordered after everything already there, TLS from the target', () => {
    const { project, createdId } = addGrpcApi(seeded(), { name: 'Orders', target: 'orders.test:443' });
    const added = project.grpcApis.find((candidate) => candidate.id === createdId)!;
    expect(added).toMatchObject({ kind: 'grpc', name: 'Orders', target: 'orders.test:443', tls: true, order: 1 });
  });

  it('never gives an API a slug a REST API or interface already uses', () => {
    const { project } = addGrpcApi(seeded(), { name: 'Greeter API', target: 'x:1' });
    expect(project.grpcApis.map((candidate) => candidate.slug)).toEqual(['Greeter API', 'Greeter API-2']);
  });
});

describe('update-grpc-api', () => {
  it('patches the fields it names, moves the folder on a rename, and clears on null', () => {
    const { project } = updateGrpcApi(seeded(), 'g-1', {
      name: 'Hello',
      target: 'grpcs://hello.test',
      metadata: [{ name: 'x-tenant', value: 'acme', enabled: true }],
      auth: null,
      description: null,
    });
    expect(api(project)).toMatchObject({ name: 'Hello', slug: 'Hello', target: 'grpcs://hello.test', tls: true });
    expect(api(project).metadata).toEqual([{ name: 'x-tenant', value: 'acme', enabled: true }]);
    expect(api(project).auth).toBeUndefined();
    expect(api(project).folders).toHaveLength(1);
  });

  it('refuses an unknown API by id', () => {
    expect(() => updateGrpcApi(seeded(), 'nope', { name: 'x' })).toThrow(ProjectError);
  });
});

describe('folders', () => {
  it('adds at the root and inside a folder, with distinct slugs', () => {
    let { project, createdId } = addGrpcFolder(seeded(), { apiId: 'g-1', name: 'Greeter' });
    expect(api(project).folders.map((folder) => folder.slug)).toEqual(['Greeter', 'Greeter-2']);
    ({ project, createdId } = addGrpcFolder(project, { apiId: 'g-1', parentId: 'f-greet', name: 'Inner' }));
    expect(api(project).folders[0]?.folders[0]?.id).toBe(createdId);
  });

  it('renames a folder and removes one with everything under it', () => {
    const renamed = updateGrpcFolder(seeded(), 'f-greet', { name: 'Greetings' }).project;
    expect(api(renamed).folders[0]).toMatchObject({ name: 'Greetings', slug: 'Greetings' });
    const removed = removeGrpcFolder(seeded(), 'f-greet').project;
    expect(api(removed).folders).toEqual([]);
    expect(findGrpcRequest(removed, 'q-hello')).toBeUndefined();
    expect(() => removeGrpcFolder(seeded(), 'nope')).toThrow(ProjectError);
  });
});

describe('requests', () => {
  it('adds one named after its method, or after the next free Request N', () => {
    const named = addGrpcRequest(seeded(), {
      apiId: 'g-1',
      parentId: 'f-greet',
      service: 'a.Greeter',
      method: 'Slow',
      message: '{}',
    });
    const request = findGrpcRequest(named.project, named.createdId!)!;
    expect(request).toMatchObject({ name: 'Slow', slug: 'Slow', service: 'a.Greeter', method: 'Slow', message: '{}' });
    const anonymous = addGrpcRequest(seeded(), { apiId: 'g-1' });
    expect(findGrpcRequest(anonymous.project, anonymous.createdId!)?.name).toBe('Request 1');
  });

  it('patches only the fields the patch names and replaces settings wholesale', () => {
    const patched = updateGrpcRequest(seeded(), 'q-hello', {
      message: '{"name":"Ada"}',
      settings: { timeoutMs: 5 },
      metadata: [{ name: 'x-a', value: '1', enabled: true }],
    }).project;
    expect(findGrpcRequest(patched, 'q-hello')).toMatchObject({
      service: 'a.Greeter',
      message: '{"name":"Ada"}',
      settings: { timeoutMs: 5 },
    });
    const cleared = updateGrpcRequest(patched, 'q-hello', { settings: {} }).project;
    expect(findGrpcRequest(cleared, 'q-hello')?.settings).toEqual({});
    expect(withGrpcPatch(findGrpcRequest(cleared, 'q-hello')!, { description: null }).description).toBeUndefined();
  });

  it('renames with a unique slug, clones beside the original, and removes with renumbering', () => {
    const renamed = updateGrpcRequest(seeded(), 'q-chat', { name: 'SayHello' }).project;
    expect(findGrpcRequest(renamed, 'q-chat')).toMatchObject({ name: 'SayHello', slug: 'SayHello-2' });
    const cloned = cloneGrpcRequest(seeded(), 'q-hello');
    expect(api(cloned.project).folders[0]?.requests.map((request) => request.name)).toEqual([
      'SayHello',
      'SayHello copy',
      'Chat',
    ]);
    expect(findGrpcRequest(cloned.project, cloned.createdId!)?.methodKind).toBe('unary');
    const removed = removeGrpcRequest(seeded(), 'q-hello').project;
    expect(api(removed).folders[0]?.requests.map((request) => [request.id, request.order])).toEqual([['q-chat', 0]]);
  });

  it("carries the original's assertions into its copy", () => {
    const assertions = [{ type: 'status' as const, equals: 'OK' }];
    const withChecks = updateGrpcRequestAssertions(seeded(), assertions);
    const cloned = cloneGrpcRequest(withChecks, 'q-root');
    expect(findGrpcRequest(cloned.project, cloned.createdId!)?.assertions).toEqual(assertions);
    const plain = cloneGrpcRequest(seeded(), 'q-root');
    expect(findGrpcRequest(plain.project, plain.createdId!)).not.toHaveProperty('assertions');
  });

  it('answers the auth chain and the location of a request', () => {
    expect(grpcAuthChainFor(seeded(), 'q-hello')).toEqual([
      { type: 'inherit' },
      { type: 'none' },
      { type: 'bearer', tokenRef: 'sec_t' },
    ]);
    expect(locateGrpcRequest(seeded(), 'q-hello')?.folders.map((folder) => folder.name)).toEqual(['Greeter']);
    expect(grpcAuthChainFor(seeded(), 'nope')).toBeUndefined();
  });
});

describe('move', () => {
  it('moves a request to the root and a folder into a folder, refusing a cycle', () => {
    const moved = moveGrpcNode(seeded(), { nodeId: 'q-hello', index: 0 }).project;
    expect(api(moved).requests.map((request) => request.id)).toEqual(['q-hello', 'q-root']);
    const withInner = addGrpcFolder(seeded(), { apiId: 'g-1', name: 'Inner' });
    const nested = moveGrpcNode(withInner.project, {
      nodeId: withInner.createdId!,
      parentId: 'f-greet',
      index: 0,
    }).project;
    expect(api(nested).folders[0]?.folders[0]?.id).toBe(withInner.createdId);
    expect(() => moveGrpcNode(nested, { nodeId: 'f-greet', parentId: withInner.createdId!, index: 0 })).toThrow(
      /inside itself/,
    );
  });
});

describe('applyChange dispatch', () => {
  const deps = {
    addAttachmentFile: () => Promise.reject(new Error('unused')),
    allowsKeystorePath: () => Promise.resolve(false),
    generate: () => Promise.reject(new Error('unused')),
  };

  it('routes the shared folder and move changes to the gRPC tree when the id names one', async () => {
    const folder = await applyChange(seeded(), { kind: 'add-folder', apiId: 'g-1', name: 'More' }, deps);
    expect(api(folder.project).folders.map((candidate) => candidate.name)).toEqual(['Greeter', 'More']);
    const renamed = await applyChange(
      folder.project,
      { kind: 'update-folder', folderId: folder.createdId!, patch: { name: 'Most' } },
      deps,
    );
    expect(api(renamed.project).folders[1]?.name).toBe('Most');
    const moved = await applyChange(renamed.project, { kind: 'move-node', nodeId: 'q-hello', index: 0 }, deps);
    expect(api(moved.project).requests[0]?.id).toBe('q-hello');
    const gone = await applyChange(moved.project, { kind: 'remove-folder', folderId: folder.createdId! }, deps);
    expect(api(gone.project).folders).toHaveLength(1);
  });

  it('applies the gRPC-only changes', async () => {
    const added = await applyChange(
      seeded(),
      { kind: 'add-grpc-request', apiId: 'g-1', method: 'Ping', service: 's.P' },
      deps,
    );
    expect(findGrpcRequest(added.project, added.createdId!)?.method).toBe('Ping');
    const removed = await applyChange(added.project, { kind: 'remove-grpc-api', apiId: 'g-1' }, deps);
    expect(removed.project.grpcApis).toEqual([]);
    expect(removeGrpcApi(seeded(), 'g-1').project.grpcApis).toEqual([]);
    expect(() => removeGrpcApi(seeded(), 'nope')).toThrow(ProjectError);
  });
});

/** The seeded project with its root request given `assertions`: there is no mutation that sets them. */
function updateGrpcRequestAssertions(project: Project, assertions: NonNullable<GrpcRequestDef['assertions']>): Project {
  const [first, ...rest] = project.grpcApis;
  return {
    ...project,
    grpcApis: [
      { ...first!, requests: first!.requests.map((r) => (r.id === 'q-root' ? { ...r, assertions } : r)) },
      ...rest,
    ],
  };
}
