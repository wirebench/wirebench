/**
 * The loader reads each container through the module its `kind` names (spec §5.1), and what it
 * returns and reports is what it returned and reported when it branched on the kind itself.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest, grpcApisOf } from '../../../src/grpc/model.js';
import { grpcStorage } from '../../../src/grpc/storage.js';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest, restApisOf } from '../../../src/rest/model.js';
import { restStorage } from '../../../src/rest/storage.js';
import { soapStorage } from '../../../src/soap/storage.js';
import { createWsApi, createWsRequest, wsApisOf } from '../../../src/ws/model.js';
import { wsStorage } from '../../../src/ws/storage.js';
import { sampleProject, tempProjectDir } from './fixture.js';
import { soapInterfacesOf } from '../../../src/soap/model.js';

/** The sample project's two interfaces, plus one API of each other kind. */
function mixedProject(): Project {
  return {
    ...sampleProject(),
    containers: {
      ...sampleProject().containers,
      rest: [
        createApi('Shop', {
          id: 'A1',
          order: 2,
          baseUrl: 'https://shop.test',
          requests: [createRestRequest('List', { id: 'R1', url: '/items' })],
        }),
      ],
      grpc: [
        createGrpcApi('Greeter', {
          id: 'G1',
          order: 3,
          target: 'localhost:50051',
          requests: [createGrpcRequest('Hello', { id: 'GR1', service: 'demo.Greeter', method: 'SayHello' })],
        }),
      ],
      websocket: [
        createWsApi('Chat', {
          id: 'W1',
          order: 4,
          url: 'wss://chat.test',
          requests: [createWsRequest('Feed', { id: 'WR1', url: '/feed' })],
        }),
      ],
    },
  };
}

describe('loading through the protocol modules', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(mixedProject(), dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts every kind in its own list, with the default registry and with one passed in', async () => {
    const byDefault = await loadProject(dir);
    const explicit = await loadProject(dir, { registry: createBuiltinRegistry() });

    expect(byDefault.problems).toEqual([]);
    expect(soapInterfacesOf(byDefault.project).map((iface) => iface.slug)).toEqual(
      soapInterfacesOf(sampleProject()).map((iface) => iface.slug),
    );
    expect(restApisOf(byDefault.project).map((api) => [api.kind, api.slug])).toEqual([['rest', 'Shop']]);
    expect(grpcApisOf(byDefault.project).map((api) => [api.kind, api.slug])).toEqual([['grpc', 'Greeter']]);
    expect(wsApisOf(byDefault.project).map((api) => [api.kind, api.slug])).toEqual([['websocket', 'Chat']]);
    expect(explicit).toEqual(byDefault);
  });

  it('each built-in storage says where its containers live and which list holds them', () => {
    const project = mixedProject();

    expect([soapStorage.dir, restStorage.dir, grpcStorage.dir, wsStorage.dir]).toEqual([
      'interfaces',
      'apis',
      'apis',
      'apis',
    ]);
    expect(soapStorage.containers(project)).toBe(soapInterfacesOf(project));
    expect(restStorage.containers(project)).toBe(restApisOf(project));
    expect(grpcStorage.containers(project)).toBe(grpcApisOf(project));
    expect(wsStorage.containers(project)).toBe(wsApisOf(project));
    expect(soapInterfacesOf(soapStorage.withContainers(project, []))).toEqual([]);
    expect(restApisOf(restStorage.withContainers(project, []))).toEqual([]);
    expect(grpcApisOf(grpcStorage.withContainers(project, []))).toEqual([]);
    expect(wsApisOf(wsStorage.withContainers(project, []))).toEqual([]);
    expect(grpcApisOf(restStorage.withContainers(project, []))).toBe(grpcApisOf(project));
  });

  it('reads an api.yaml without a kind as REST, which its schema then refuses', async () => {
    const file = join(dir, 'apis', 'Shop', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest\n', ''));

    await expect(loadProject(dir)).rejects.toMatchObject({
      code: 'project-file-invalid',
      details: { file: 'apis/Shop/api.yaml' },
    });
  });

  it('reports a container directory with no container file, in either directory', async () => {
    await mkdir(join(dir, 'interfaces', 'Hollow'), { recursive: true });
    await mkdir(join(dir, 'apis', 'Hollow'), { recursive: true });

    const { project, problems } = await loadProject(dir);

    expect([...problems].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      {
        code: 'missing-api-file',
        message: 'Folder "Hollow" has no api.yaml and was skipped',
        file: 'apis/Hollow/api.yaml',
      },
      {
        code: 'missing-interface-file',
        message: 'Folder "Hollow" has no interface.yaml and was skipped',
        file: 'interfaces/Hollow/interface.yaml',
      },
    ]);
    expect(restApisOf(project).map((api) => api.slug)).toEqual(['Shop']);
  });
});
