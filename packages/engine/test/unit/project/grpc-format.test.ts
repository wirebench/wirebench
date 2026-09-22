/**
 * The gRPC third of the `apis/` folder: a gRPC API shares the directory with REST ones and says
 * so with `kind: grpc`; its requests keep their message in a `.body.json` sibling; and loading
 * back produces the same model, byte-stably.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcApi } from '../../../src/grpc/model.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { APIS_DIR } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import { listTree, tempProjectDir } from './fixture.js';

function greeter(): GrpcApi {
  return createGrpcApi('Greeter', {
    id: 'G1',
    order: 1,
    description: 'The greeting service.',
    target: 'localhost:50051',
    tls: false,
    metadata: [entry('x-tenant', 'acme'), entry('x-debug', '1', { enabled: false })],
    auth: { type: 'bearer', tokenRef: 'sec_tok' },
    definition: { kind: 'proto', source: '/home/me/protos', cache: true, roots: ['greeter.proto'] },
    requests: [
      {
        ...createGrpcRequest('Health', {
          id: 'Q0',
          order: 0,
          service: 'wirebench.greet.Greeter',
          method: 'SayHello',
          message: '{\n  "name": "health"\n}\n',
          settings: { timeoutMs: 1_000 },
        }),
        // What `wirebench run` checks; carried through a save and a load like a REST request's.
        assertions: [
          { type: 'status', equals: 'OK' },
          { type: 'match', language: 'jsonpath', expression: '$.message', equals: 'Hello, health' },
        ],
      },
    ],
    folders: [
      createGrpcFolder('Greeter', {
        id: 'GF1',
        order: 0,
        description: 'Package `wirebench.greet`.',
        auth: { type: 'none' },
        requests: [
          createGrpcRequest('SayHello', {
            id: 'Q1',
            order: 0,
            description: 'Says hello once.',
            service: 'wirebench.greet.Greeter',
            method: 'SayHello',
            message: '{\n  "name": ""\n}\n',
            metadata: [entry('x-trace', 'abc')],
            settings: { trustInvalid: true, escapeProperties: true },
          }),
          createGrpcRequest('Chat', {
            id: 'Q2',
            order: 1,
            service: 'wirebench.greet.Greeter',
            method: 'Chat',
            methodKind: 'bidi-streaming',
            message: '[\n  {\n    "name": "a"\n  }\n]\n',
            auth: { type: 'inherit' },
          }),
        ],
      }),
    ],
  });
}

function project(): Project {
  const petstore = createApi('Petstore', {
    id: 'A1',
    order: 0,
    baseUrl: 'https://petstore.test',
    requests: [createRestRequest('Health', { id: 'R0', url: '/health' })],
  });
  return { ...createProject('Mixed', { id: 'P1' }), apis: [petstore], grpcApis: [greeter()] };
}

describe('the apis/ layout for a gRPC API', () => {
  it('puts the API beside the REST one, with kind: grpc at the top of every file it owns', () => {
    const files = projectFiles(project());
    expect([...files.keys()].filter((path) => path.startsWith(`${APIS_DIR}/Greeter/`)).sort()).toEqual([
      'apis/Greeter/api.yaml',
      'apis/Greeter/requests/Greeter/Chat.body.json',
      'apis/Greeter/requests/Greeter/Chat.request.yaml',
      'apis/Greeter/requests/Greeter/SayHello.body.json',
      'apis/Greeter/requests/Greeter/SayHello.request.yaml',
      'apis/Greeter/requests/Greeter/folder.yaml',
      'apis/Greeter/requests/Health.body.json',
      'apis/Greeter/requests/Health.request.yaml',
    ]);
    expect(files.get('apis/Greeter/api.yaml')).toBe(
      [
        'auth:',
        '  tokenRef: sec_tok',
        '  type: bearer',
        'definition:',
        '  cache: true',
        '  kind: proto',
        '  roots:',
        '    - greeter.proto',
        '  source: /home/me/protos',
        'description: The greeting service.',
        'id: G1',
        'kind: grpc',
        'metadata:',
        '  - name: x-tenant',
        '    value: acme',
        '  - enabled: false',
        '    name: x-debug',
        '    value: "1"',
        'name: Greeter',
        'order: 1',
        'target: localhost:50051',
        'tls: false',
        '',
      ].join('\n'),
    );
    expect(files.get('apis/Greeter/requests/Greeter/Chat.request.yaml')).toBe(
      [
        'auth:',
        '  type: inherit',
        'id: Q2',
        'kind: grpc',
        'message: Chat.body.json',
        'method: Chat',
        'methodKind: bidi-streaming',
        'name: Chat',
        'order: 1',
        'service: wirebench.greet.Greeter',
        '',
      ].join('\n'),
    );
    expect(files.get('apis/Greeter/requests/Greeter/Chat.body.json')).toBe('[\n  {\n    "name": "a"\n  }\n]\n');
    expect(files.get('apis/Petstore/api.yaml')).toContain('kind: rest');
  });
});

describe('round trip through a folder', () => {
  it('loads back into the same model, in its own list, with no problems', async () => {
    const dir = await tempProjectDir();
    await saveProject(project(), dir);
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.grpcApis).toEqual([greeter()]);
    expect(loaded.apis.map((api) => api.id)).toEqual(['A1']);
    await rm(dir, { recursive: true, force: true });
  });

  it('is byte-stable: saving what was loaded changes nothing', async () => {
    const dir = await tempProjectDir();
    await saveProject(project(), dir);
    const before = await listTree(dir);
    const { project: loaded } = await loadProject(dir);
    const result = await saveProject(loaded, dir);
    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(await listTree(dir)).toEqual(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('renaming a request touches exactly its two files', async () => {
    const dir = await tempProjectDir();
    const original = project();
    await saveProject(original, dir);
    const api = original.grpcApis[0]!;
    const folder = api.folders[0]!;
    const renamed: Project = {
      ...original,
      grpcApis: [
        {
          ...api,
          folders: [
            {
              ...folder,
              requests: folder.requests.map((request) =>
                request.id === 'Q1' ? { ...request, name: 'Greet', slug: 'Greet' } : request,
              ),
            },
          ],
        },
      ],
    };
    const result = await saveProject(renamed, dir);
    expect([...result.written].sort()).toEqual([
      'apis/Greeter/requests/Greeter/Greet.body.json',
      'apis/Greeter/requests/Greeter/Greet.request.yaml',
    ]);
    expect([...result.removed].sort()).toEqual([
      'apis/Greeter/requests/Greeter/SayHello.body.json',
      'apis/Greeter/requests/Greeter/SayHello.request.yaml',
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('deleting the API takes its whole folder, definition cache included', async () => {
    const dir = await tempProjectDir();
    await saveProject(project(), dir);
    await mkdir(join(dir, APIS_DIR, 'Greeter', 'definition', 'protos'), { recursive: true });
    await writeFile(join(dir, APIS_DIR, 'Greeter', 'definition', 'manifest.yaml'), 'kind: proto\n');
    await writeFile(join(dir, APIS_DIR, 'Greeter', 'definition', 'protos', 'greeter.proto'), 'syntax = "proto3";\n');
    await saveProject({ ...project(), grpcApis: [] }, dir);
    expect((await listTree(dir)).some((path) => path.startsWith('apis/Greeter/'))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('problems a damaged gRPC API reports', () => {
  it('loads a request whose message file is gone with an empty message', async () => {
    const dir = await tempProjectDir();
    await saveProject(project(), dir);
    await rm(join(dir, APIS_DIR, 'Greeter', 'requests', 'Health.body.json'));
    const { project: loaded, problems } = await loadProject(dir);
    expect(loaded.grpcApis[0]?.requests[0]?.message).toBe('');
    expect(problems).toEqual([
      {
        code: 'missing-body',
        message: 'Request "Health" has no message file; loaded with an empty message',
        file: 'apis/Greeter/requests/Health.body.json',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults an older request file without a methodKind to unary', async () => {
    const dir = await tempProjectDir();
    await saveProject(project(), dir);
    const file = join(dir, APIS_DIR, 'Greeter', 'requests', 'Health.request.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/methodKind: .*\n/, ''));
    const { project: loaded } = await loadProject(dir);
    expect(loaded.grpcApis[0]?.requests[0]?.methodKind).toBe('unary');
    await rm(dir, { recursive: true, force: true });
  });
});
