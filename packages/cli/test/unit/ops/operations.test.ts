// packages/cli/test/unit/ops/operations.test.ts
import {
  createGrpcApi,
  createGrpcRequest,
  createWsApi,
  createWsFolder,
  createWsRequest,
  loadProject,
} from '@wirebench/engine';
import type { RestFolder, RestRequestDef } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { operationsOp } from '../../../src/ops/operations.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  PETS_OPENAPI,
  removeTempDirs,
  restItem,
  restProject,
  SECRET,
  SOAP_ITEM,
  soapProject,
  twoBindingWsdl,
  updateProject,
} from './helpers.js';

afterEach(removeTempDirs);

describe('op operations', () => {
  it('lists a SOAP operation with its binding, SOAP action and saved request', async () => {
    const fixture = await soapProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result).toEqual({
      operations: [
        {
          kind: 'soap',
          container: 'CalculatorService',
          binding: 'CalculatorSoap',
          operation: 'Add',
          soapAction: 'urn:wirebench:calculator/Add',
          ref: 'CalculatorService/Add',
          items: [SOAP_ITEM],
        },
      ],
      notes: [],
    });
  });

  it('lists REST endpoints from the cached document, with their operationIds and requests', async () => {
    const fixture = await restProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.operations.map((row) => row.ref)).toEqual([
      'Pets/GET /pets',
      'Pets/POST /pets',
      'Pets/GET /pets/{petId}',
    ]);
    expect(result.operations[0]).toMatchObject({
      kind: 'rest',
      method: 'GET',
      path: '/pets',
      operationId: 'listPets',
      items: [await restItem(fixture.dir, 'GET', '/pets')],
    });
  });

  it('filters by interface or API, and refuses an unknown one', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());

    const soapOnly = await runOp(operationsOp, { container: 'CalculatorService' }, fixture.base());
    expect(soapOnly.operations.map((row) => row.kind)).toEqual(['soap']);
    await expect(runOp(operationsOp, { container: 'Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });

  it('lists saved requests by the operation they belong to when two operations share a name', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    const { project } = await loadProject(fixture.dir);
    const slugs = (project.interfaces[0]?.operations ?? []).map((operation) => operation.slug);

    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.operations.map((row) => row.ref)).toEqual(slugs.map((slug) => `CalculatorService/${slug}`));
    // Each row lists its own operation's one request, not both.
    expect(result.operations.map((row) => row.items)).toEqual([[SOAP_ITEM], [SOAP_ITEM]]);
    expect(result.operations.map((row) => (row.kind === 'soap' ? row.binding : ''))).toEqual([
      'CalculatorSoap',
      'CalculatorSoap12',
    ]);
  });

  it('notes an interface and an API that share a name', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({ ...iface, name: 'Shared' })),
      apis: project.apis.map((api) => ({ ...api, name: 'Shared' })),
    }));
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.notes).toEqual([expect.stringContaining('"Shared"')]);
  });

  it('lists the saved requests instead when an API has no cached definition, masking secret query values', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: PETS_OPENAPI }, fixture.base());
    const retargetRequests = (requests: readonly RestRequestDef[]): RestRequestDef[] =>
      requests.map((request) => {
        if (request.contract?.method === 'get' && request.contract.path === '/pets') {
          return { ...request, url: `http://alice:${SECRET}@127.0.0.1:9/pets?api_key=${SECRET}&limit=2` };
        }
        if (request.contract?.method === 'post' && request.contract.path === '/pets') {
          return { ...request, url: `/pets?api_key=${SECRET}&limit=3` };
        }
        return request;
      });
    const retargetFolder = (folder: RestFolder): RestFolder => ({
      ...folder,
      requests: retargetRequests(folder.requests),
      folders: folder.folders.map(retargetFolder),
    });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      apis: project.apis.map((api) => ({
        ...api,
        requests: retargetRequests(api.requests),
        folders: api.folders.map(retargetFolder),
      })),
    }));

    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.notes).toEqual([expect.stringContaining('Pets: no cached definition')]);
    expect(result.operations.map((row) => row.kind)).toEqual(['rest', 'rest', 'rest']);
    const paths = result.operations.map((row) => (row.kind === 'rest' ? row.path : ''));
    expect(paths[0]).toMatch(/^http:\/\/alice:[^@]*@127\.0\.0\.1:9\/pets\?api_key=[^&]*&limit=2$/);
    expect(paths[1]).toMatch(/^\/pets\?api_key=[^&]*&limit=3$/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('says so when an interface has no cached definition, and still lists its operations', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.notes).toEqual(['CalculatorService: no cached definition, so no SOAP actions']);
    expect(result.operations).toEqual([
      expect.objectContaining({ kind: 'soap', ref: 'CalculatorService/Add', items: [SOAP_ITEM] }),
    ]);
    expect(result.operations[0]).not.toHaveProperty('soapAction');
  });

  it('lists each saved WebSocket request send takes, by its path, and leaves gRPC out', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: [
        createWsApi('Chat', {
          id: 'ws-chat',
          slug: 'chat',
          url: 'ws://127.0.0.1:9',
          requests: [createWsRequest('Echo', { id: 'ws-echo', url: `/echo?token=${SECRET}` })],
          folders: [
            createWsFolder('Rooms', {
              id: 'ws-rooms',
              requests: [createWsRequest('Join', { id: 'ws-join', url: '/join' })],
            }),
          ],
        }),
      ],
      grpcApis: [createGrpcApi('Greeter', { id: 'g', requests: [createGrpcRequest('Hello', { id: 'g-hello' })] })],
    }));

    const result = await runOp(operationsOp, {}, fixture.base());

    const [echo] = result.operations;
    expect(echo?.kind === 'websocket' ? echo.url : '').toMatch(/^\/echo\?token=/);
    expect(result.operations).toEqual([
      {
        kind: 'websocket',
        container: 'Chat',
        url: echo?.kind === 'websocket' ? echo.url : '',
        ref: 'Chat/Echo',
        items: ['Chat/Echo'],
      },
      { kind: 'websocket', container: 'Chat', url: '/join', ref: 'Chat/Rooms/Join', items: ['Chat/Rooms/Join'] },
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((await runOp(operationsOp, { container: 'chat' }, fixture.base())).operations).toHaveLength(2);
    await expect(runOp(operationsOp, { container: 'Greeter' }, fixture.base())).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });
});
