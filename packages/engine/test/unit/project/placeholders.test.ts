/**
 * A container whose kind has no enabled module in its directory loads as a placeholder with a
 * problem, and its directory survives a save byte for byte (spec §6).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { nodeFs } from '../../../src/project/fs.js';
import type { FsLike } from '../../../src/project/fs.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject, extraContainersOf, takenContainerSlugs, unsupportedOf } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { uniqueSlug } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ContainerBase, ProtocolStorage } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, createBuiltinRegistry, SCRIPTS_FEATURE } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWebhookCollection } from '../../../src/webhooks/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import { sampleProject, tempProjectDir } from './fixture.js';

/** One REST API and one gRPC API, both with a request. */
function baseProject(): Project {
  return {
    ...createProject('Placeholders', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        order: 0,
        baseUrl: 'https://shop.test',
        requests: [createRestRequest('List', { id: 'R1', url: '/items' })],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'G1',
        order: 1,
        target: 'localhost:50051',
        requests: [
          createGrpcRequest('Hello', {
            id: 'GR1',
            service: 'demo.Greeter',
            method: 'SayHello',
            message: '{\n  "name": "abc123def456ghi789"\n}\n',
          }),
        ],
      }),
    ],
  };
}

/** Writes `apis/Graph/`, a container of a kind no built-in module has, with files a loader would choke on. */
async function addGraph(dir: string): Promise<void> {
  const graph = join(dir, 'apis', 'Graph');
  await mkdir(join(graph, 'requests'), { recursive: true });
  await writeFile(
    join(graph, 'api.yaml'),
    'kind: graphql\nid: GQ1\nname: Graph\norder: 7\nendpoint: https://graph.test/\n',
  );
  await writeFile(join(graph, 'requests', 'Query.request.yaml'), 'kind: graphql\nid: Q1\nname: Query\n');
  await writeFile(join(graph, 'requests', 'broken.request.yaml'), ': : not yaml [\n');
  await writeFile(join(graph, 'notes.txt'), 'kept\r\nas it is \r\n');
}

/** Every directory and every file below `dir`, the files as base64 of their bytes. */
async function snapshot(dir: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.set(`${relative}/`, '');
      for (const [path, bytes] of await snapshot(join(dir, entry.name), relative)) {
        out.set(path, bytes);
      }
    } else {
      out.set(relative, (await readFile(join(dir, entry.name))).toString('base64'));
    }
  }
  return out;
}

/** A module for the `graphql` kind that keeps only what every container has, to stand for "the module is back". */
interface GraphApi extends ContainerBase {
  readonly kind: 'graphql';
}

const graphStorage: ProtocolStorage<GraphApi> = {
  dir: 'apis',
  load(_ctx, slug, document) {
    const file = document as { readonly id: string; readonly name: string; readonly order: number };
    return Promise.resolve({ kind: 'graphql', id: file.id, name: file.name, slug, order: file.order });
  },
  files: () => new Map<string, string>(),
  managed: () => Promise.resolve([]),
  containers: (project) => extraContainersOf(project, 'graphql') as readonly GraphApi[],
  withContainers: (project, containers) => ({
    ...project,
    extraContainers: { ...project.extraContainers, graphql: containers },
  }),
};

const withGraph = createProtocolRegistry(
  [
    ...BUILTIN_PROTOCOLS,
    defineProtocol({
      kind: 'graphql',
      feature: { id: 'graphql', title: 'GraphQL', default: true, stage: 'experimental', requires: [] },
      storage: graphStorage,
    }),
  ],
  { features: [SCRIPTS_FEATURE] },
);

describe('a container of an unknown kind', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
    await addGraph(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads as a placeholder with a problem, and the rest of the project loads', async () => {
    const { project, problems } = await loadProject(dir);

    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
    expect(project.grpcApis.map((api) => api.slug)).toEqual(['Greeter']);
    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph', order: 7 },
    ]);
    expect(problems).toEqual([
      {
        code: 'container-unsupported',
        message:
          'apis/Graph/api.yaml is a "graphql" container, and this build has no such protocol for apis/; it was not loaded and is left as it is',
        file: 'apis/Graph/api.yaml',
        details: { kind: 'graphql', reason: 'unknown-kind', dir: 'apis', slug: 'Graph' },
      },
    ]);
  });

  it('reads nothing under the directory but its container file', async () => {
    const touched: string[] = [];
    const graph = join(dir, 'apis', 'Graph');
    const fs: FsLike = {
      ...nodeFs,
      readFile: (path) => {
        touched.push(path);
        return nodeFs.readFile(path);
      },
      readdir: (path) => {
        touched.push(path);
        return nodeFs.readdir(path);
      },
    };

    await loadProject(dir, { fs });

    expect(touched.filter((path) => path.startsWith(graph))).toEqual([join(graph, 'api.yaml')]);
  });

  it('takes the name and the order only when they are a string and a number', async () => {
    await writeFile(join(dir, 'apis', 'Graph', 'api.yaml'), 'kind: graphql\nname: 5\norder: soon\n');

    const { project } = await loadProject(dir);

    expect(unsupportedOf(project)).toEqual([{ dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind' }]);
  });

  it('is left byte-identical by a save that writes elsewhere', async () => {
    const before = await snapshot(join(dir, 'apis', 'Graph'));
    const { project } = await loadProject(dir);

    const result = await saveProject(
      { ...project, apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })) },
      dir,
    );

    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Graph'))).toEqual(before);
  });

  it('refuses a save that would put a container in its directory', async () => {
    const before = await snapshot(dir);
    const { project } = await loadProject(dir);

    for (const name of ['Graph', 'graph']) {
      const clashing = { ...project, apis: [...project.apis, createApi(name, { id: 'A9', order: 9 })] };
      await expect(saveProject(clashing, dir)).rejects.toMatchObject({
        name: 'ProjectError',
        code: 'container-slug-conflict',
        details: { dir: 'apis', slug: name, kind: 'graphql', reason: 'unknown-kind' },
      });
    }
    expect(await snapshot(dir)).toEqual(before);
  });

  it('is a slug the engine’s helper steers a new container around', async () => {
    const { project } = await loadProject(dir);

    expect([...takenContainerSlugs(project, 'apis')].sort()).toEqual(['Graph', 'Greeter', 'Shop']);
    expect([...takenContainerSlugs(project, 'interfaces')]).toEqual([]);
    expect(uniqueSlug('Graph', takenContainerSlugs(project, 'apis'))).toBe('Graph-2');
  });

  it('is a container again once a module for its kind is registered', async () => {
    const { project, problems } = await loadProject(dir, { registry: withGraph });

    expect(problems).toEqual([]);
    expect(unsupportedOf(project)).toEqual([]);
    expect(extraContainersOf(project, 'graphql')).toEqual([
      { kind: 'graphql', id: 'GQ1', name: 'Graph', slug: 'Graph', order: 7 },
    ]);
  });
});

describe('a container whose protocol is switched off', () => {
  const grpcOff = createBuiltinRegistry({ grpc: false });
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads as a placeholder that says so', async () => {
    const { project, problems } = await loadProject(dir, { registry: grpcOff });

    expect(project.grpcApis).toEqual([]);
    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Greeter', kind: 'grpc', reason: 'feature-disabled', name: 'Greeter', order: 1 },
    ]);
    expect(problems).toEqual([
      {
        code: 'container-unsupported',
        message:
          'apis/Greeter/api.yaml is a "grpc" container, and that protocol is switched off; it was not loaded and is left as it is',
        file: 'apis/Greeter/api.yaml',
        details: { kind: 'grpc', reason: 'feature-disabled', dir: 'apis', slug: 'Greeter' },
      },
    ]);
  });

  it('is left byte-identical by a save, and loads whole again with the switch back', async () => {
    const before = await snapshot(join(dir, 'apis', 'Greeter'));
    const { project } = await loadProject(dir, { registry: grpcOff });

    const result = await saveProject(
      { ...project, apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })) },
      dir,
      { registry: grpcOff },
    );

    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Greeter'))).toEqual(before);

    const back = await loadProject(dir);
    expect(back.problems).toEqual([]);
    expect(unsupportedOf(back.project)).toEqual([]);
    expect(back.project.grpcApis).toEqual(baseProject().grpcApis);
  });

  it('is left byte-identical by a save whose registry cannot write it, though the project holds it in memory', async () => {
    const before = await snapshot(join(dir, 'apis', 'Greeter'));
    // Loaded with every protocol on: the gRPC API is a container in memory, not a placeholder.
    const { project } = await loadProject(dir);
    expect(project.grpcApis.map((api) => api.slug)).toEqual(['Greeter']);
    expect(unsupportedOf(project)).toEqual([]);

    const result = await saveProject(
      {
        ...project,
        apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })),
        grpcApis: project.grpcApis.map((api) => ({ ...api, name: 'Greeter, renamed' })),
      },
      dir,
      { registry: grpcOff },
    );

    // A save never deletes what its registry cannot write (spec R6): nothing of the gRPC API is
    // written, managed or removed.
    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Greeter'))).toEqual(before);
  });
});

describe('a kind in the wrong directory', () => {
  it('is a placeholder of an unknown kind, in either directory', async () => {
    const dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
    await mkdir(join(dir, 'interfaces', 'Wrong'), { recursive: true });
    await writeFile(join(dir, 'interfaces', 'Wrong', 'interface.yaml'), 'kind: rest\nid: X1\nname: Wrong\norder: 3\n');
    await mkdir(join(dir, 'apis', 'Soapy'), { recursive: true });
    await writeFile(join(dir, 'apis', 'Soapy', 'api.yaml'), 'kind: soap\nid: X2\nname: Soapy\norder: 4\n');

    const { project, problems } = await loadProject(dir);

    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Soapy', kind: 'soap', reason: 'unknown-kind', name: 'Soapy', order: 4 },
      { dir: 'interfaces', slug: 'Wrong', kind: 'rest', reason: 'unknown-kind', name: 'Wrong', order: 3 },
    ]);
    expect(problems.map((problem) => problem.file).sort()).toEqual([
      'apis/Soapy/api.yaml',
      'interfaces/Wrong/interface.yaml',
    ]);
    expect(project.interfaces).toEqual([]);

    const result = await saveProject(project, dir);
    expect(result.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('the webhook collection with REST switched off', () => {
  it('is not loaded, not written and not deleted, and is back with the switch', async () => {
    const restOff = createBuiltinRegistry({ rest: false });
    const dir = await tempProjectDir();
    const withHooks: Project = {
      ...baseProject(),
      webhooks: createWebhookCollection({
        target: 'https://hooks.test',
        requests: [
          createRestRequest('order.created', {
            id: 'H1',
            slug: 'order-created',
            method: 'POST',
            url: '/orders',
            body: { kind: 'raw', language: 'json', text: '{ "event": "order.created" }' },
          }),
        ],
      }),
    };
    await saveProject(withHooks, dir);
    const before = await snapshot(join(dir, 'webhooks'));

    const { project } = await loadProject(dir, { registry: restOff });
    expect(project.webhooks).toBeUndefined();
    expect(unsupportedOf(project).map((placeholder) => [placeholder.slug, placeholder.reason])).toEqual([
      ['Shop', 'feature-disabled'],
    ]);

    const result = await saveProject(
      { ...project, grpcApis: project.grpcApis.map((api) => ({ ...api, name: 'Greeter, renamed' })) },
      dir,
      { registry: restOff },
    );
    expect(result.written).toEqual(['apis/Greeter/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'webhooks'))).toEqual(before);

    const back = await loadProject(dir);
    expect(back.project.webhooks?.requests.map((request) => request.slug)).toEqual(['order-created']);
    expect(back.project.apis.map((api) => api.slug)).toEqual(['Shop']);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Spec R6, one protocol at a time: with it switched off, a load and a save of an unchanged project
 * touch nothing at all, its containers' directories stay byte for byte, and switching it back on
 * loads them whole again.
 */
describe.each([
  { kind: 'soap', containers: (project: Project) => project.interfaces },
  { kind: 'rest', containers: (project: Project) => project.apis },
  { kind: 'grpc', containers: (project: Project) => project.grpcApis },
  { kind: 'websocket', containers: (project: Project) => project.wsApis },
])('the project with $kind switched off', ({ kind, containers }) => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    const withHooks: Project = {
      ...sampleProject(),
      apis: baseProject().apis,
      grpcApis: baseProject().grpcApis,
      wsApis: [
        createWsApi('Live', {
          id: 'W1',
          order: 2,
          url: 'wss://live.test/feed',
          requests: [
            createWsRequest('Feed', {
              id: 'WR1',
              messages: [createWsSavedMessage('Subscribe', { id: 'WM1', content: '{"op":"sub"}' })],
            }),
          ],
        }),
      ],
      webhooks: createWebhookCollection({
        target: 'https://hooks.test',
        requests: [createRestRequest('order.created', { id: 'H1', slug: 'order-created', url: '/orders' })],
      }),
    };
    await saveProject(withHooks, dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is saved without a byte changed, and loads whole again with the switch back', async () => {
    const off = createBuiltinRegistry({ [kind]: false });
    const whole = await loadProject(dir);
    expect(containers(whole.project).length).toBeGreaterThan(0);
    const before = await snapshot(dir);

    const { project } = await loadProject(dir, { registry: off });
    expect(containers(project)).toEqual([]);
    expect(unsupportedOf(project).map((placeholder) => [placeholder.kind, placeholder.reason])).toEqual(
      containers(whole.project).map(() => [kind, 'feature-disabled']),
    );

    const result = await saveProject(project, dir, { registry: off });

    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(await snapshot(dir)).toEqual(before);
    const back = await loadProject(dir);
    expect(back.problems).toEqual(whole.problems);
    expect(back.project).toEqual(whole.project);
  });
});

describe('a container of a kind the save has no module for, held in memory', () => {
  it('is left byte-identical, its directory kept', async () => {
    const dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
    await addGraph(dir);
    const before = await snapshot(join(dir, 'apis', 'Graph'));
    // Loaded where GraphQL is a protocol: the container is in `extraContainers`, not a placeholder.
    const { project } = await loadProject(dir, { registry: withGraph });
    expect(extraContainersOf(project, 'graphql').map((container) => container.slug)).toEqual(['Graph']);

    const result = await saveProject(
      { ...project, apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })) },
      dir,
    );

    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Graph'))).toEqual(before);
    await rm(dir, { recursive: true, force: true });
  });
});
