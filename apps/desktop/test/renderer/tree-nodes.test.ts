import { describe, expect, it } from 'vitest';
import type { InterfaceSummary } from '../../src/shared/wire-types.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { buildExplorerTree, nodeProjectId, restEntityId } from '../../src/renderer/features/explorer/tree-nodes.js';
import {
  REQUEST_PROPERTIES,
  grpcApiWire,
  grpcRequestWire,
  restApiWire,
  restFolderWire,
  restRequestWire,
  wsApiWire,
  wsRequestWire,
} from '../helpers/wire-defaults.js';

function iface(overrides: Partial<InterfaceSummary> = {}): InterfaceSummary {
  return {
    id: 'iface-1',
    name: 'Calculator',
    definitionUrl: 'http://example.test/service.wsdl',
    targetNamespace: 'http://tempuri.org/',
    soapVersions: ['1.1'],
    services: [
      {
        name: 'Calculator',
        ports: [
          {
            name: 'CalculatorSoap',
            address: 'http://example.test/soap',
            binding: '{tns}CalculatorSoap',
            soapVersion: '1.1',
          },
        ],
      },
    ],
    operations: [
      {
        name: 'Add',
        binding: '{tns}CalculatorSoap',
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [{ service: 'Calculator', port: 'CalculatorSoap', address: 'http://example.test/soap' }],
        inputMimeParts: [],
      },
    ],
    problems: [],
    documentCount: 1,
    ...overrides,
  };
}

function request(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return {
    properties: REQUEST_PROPERTIES,
    attachments: [],
    id: 'req-1',
    interfaceId: 'iface-1',
    bindingName: '{tns}CalculatorSoap',
    operationName: 'Add',
    name: 'Request 1',
    slug: 'Request 1',
    operationSlug: 'Add',
    envelopeXml: '<Envelope/>',
    soapVersion: '1.1',
    headers: [],
    order: 0,
    ...overrides,
  };
}

/** One ready internal project wrapping `summaries`; returns the interface nodes under it. */
function interfacesOf(summaries: readonly InterfaceSummary[], requests: readonly RequestDraft[]): ExplorerNode[] {
  const tree = buildExplorerTree(
    [{ id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/projects/demo', status: 'ready' }],
    [{ projectId: 'p1', interfaceIds: summaries.map((summary) => summary.id) }],
    Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
    requests,
  );
  return tree[0]?.children ?? [];
}

describe('buildExplorerTree', () => {
  it('builds interface -> endpoints/operations -> requests for a single binding', () => {
    const tree = interfacesOf([iface()], [request()]);

    expect(tree).toHaveLength(1);
    const [interfaceNode] = tree;
    expect(interfaceNode?.id).toBe('iface:iface-1');
    expect(interfaceNode?.kind).toBe('interface');
    expect(interfaceNode?.children).toHaveLength(2);

    const [endpoints, operations] = interfaceNode?.children ?? [];
    expect(endpoints?.kind).toBe('endpoints');
    expect(endpoints?.children).toHaveLength(1);
    expect(endpoints?.children?.[0]?.label).toBe('CalculatorSoap — http://example.test/soap');

    // Single binding: the binding-group level collapses, operations sit directly under Operations.
    expect(operations?.kind).toBe('operations');
    expect(operations?.children).toHaveLength(1);
    const [operationNode] = operations?.children ?? [];
    expect(operationNode?.kind).toBe('operation');
    expect(operationNode?.label).toBe('Add');
    expect(operationNode?.children).toHaveLength(1);
    expect(operationNode?.children?.[0]?.id).toBe('req:req-1');
    expect(operationNode?.children?.[0]?.kind).toBe('request');
  });

  it('groups operations by binding when an interface has multiple bindings', () => {
    const summary = iface({
      operations: [
        {
          name: 'Add',
          binding: '{tns}CalculatorSoap',
          bindingLocal: 'CalculatorSoap',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
        {
          name: 'Add',
          binding: '{tns}CalculatorSoap12',
          bindingLocal: 'CalculatorSoap12',
          soapVersion: '1.2',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
      ],
    });
    const tree = interfacesOf([summary], []);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children).toHaveLength(2);
    expect(operations?.children?.map((n) => n.kind)).toEqual(['binding', 'binding']);
    expect(operations?.children?.map((n) => n.label)).toEqual(['CalculatorSoap', 'CalculatorSoap12']);
  });

  it('sorts operations alphabetically and keeps requests in creation order', () => {
    const summary = iface({
      operations: [
        {
          name: 'Subtract',
          binding: '{tns}B',
          bindingLocal: 'B',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
        {
          name: 'Add',
          binding: '{tns}B',
          bindingLocal: 'B',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
      ],
    });
    const requests = [
      request({ id: 'req-2', bindingName: '{tns}B', operationName: 'Add', name: 'Request 2' }),
      request({ id: 'req-1', bindingName: '{tns}B', operationName: 'Add', name: 'Request 1' }),
    ];
    const tree = interfacesOf([summary], requests);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children?.map((n) => n.label)).toEqual(['Add', 'Subtract']);
    const addNode = operations?.children?.find((n) => n.label === 'Add');
    expect(addNode?.children?.map((n) => n.id)).toEqual(['req:req-2', 'req:req-1']);
  });

  it('emits one root per workspace project, in workspace order, with its own interfaces', () => {
    const calculator = iface();
    const billing = iface({ id: 'iface-2', name: 'Billing' });
    const tree = buildExplorerTree(
      [
        { id: 'p2', name: 'Billing', source: 'linked', dir: '/elsewhere/billing', status: 'ready' },
        { id: 'p1', name: 'Calculator', source: 'internal', dir: '/ws/projects/calculator', status: 'loading' },
      ],
      [
        { projectId: 'p1', interfaceIds: [calculator.id] },
        { projectId: 'p2', interfaceIds: [billing.id] },
      ],
      { [calculator.id]: calculator, [billing.id]: billing },
      [],
    );

    // Workspace order wins over the project store's own (name-sorted) order.
    expect(tree.map((node) => node.id)).toEqual(['proj:p2', 'proj:p1']);
    expect(tree.map((node) => node.kind)).toEqual(['project', 'project']);
    expect(tree.map((node) => node.projectId)).toEqual(['p2', 'p1']);

    const [linked, loading] = tree;
    expect(linked?.linked).toBe(true);
    expect(linked?.dir).toBe('/elsewhere/billing');
    expect(linked?.loading).toBeUndefined();
    expect(linked?.children?.map((node) => node.id)).toEqual(['iface:iface-2']);

    // Only the root is prefixed: entity ids below it are ULIDs, already unique workspace-wide.
    expect(loading?.linked).toBeUndefined();
    expect(loading?.loading).toBe(true);
    expect(loading?.children?.map((node) => node.id)).toEqual(['iface:iface-1']);
    expect(loading?.children?.[0]?.children?.map((node) => node.id)).toEqual([
      'endpoints:iface-1',
      'operations:iface-1',
    ]);
  });

  it('gives a missing or unreadable project a single Locate…/Remove row instead of children', () => {
    const summary = iface();
    const tree = buildExplorerTree(
      [
        { id: 'p1', name: 'Gone', source: 'linked', dir: '/gone', status: 'missing' },
        { id: 'p2', name: 'Broken', source: 'internal', dir: '/ws/projects/broken', status: 'error', message: 'boom' },
      ],
      [{ projectId: 'p1', interfaceIds: [summary.id] }],
      { [summary.id]: summary },
      [],
    );

    const [missing, broken] = tree;
    // Its interfaces are not rendered: the folder the app would read them from is not there.
    expect(missing?.children).toHaveLength(1);
    expect(missing?.children?.[0]).toMatchObject({
      id: 'projmissing:p1',
      kind: 'project-missing',
      label: 'This project folder is missing.',
      projectId: 'p1',
    });
    expect(broken?.children?.[0]?.label).toBe('boom');
    expect(broken?.children?.[0]?.message).toBe('boom');
  });

  it('stable ids and a problem-count badge on the interface node', () => {
    const summary = iface({ problems: [{ source: 'wsdl', code: 'x', message: 'bad thing' }] });
    const tree = interfacesOf([summary], []);

    expect(tree[0]?.id).toBe('iface:iface-1');
    expect(tree[0]?.problemCount).toBe(1);

    const again = interfacesOf([summary], []);
    expect(again[0]?.id).toBe(tree[0]?.id);
  });

  it('marks a project root and its conflicted request, leaving everything else unmarked', () => {
    const summary = iface();
    const req1 = request({ id: 'req-1', name: 'Request 1' });
    const req2 = request({ id: 'req-2', name: 'Request 2' });
    const tree = buildExplorerTree(
      [{ id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/projects/demo', status: 'ready' }],
      [{ projectId: 'p1', interfaceIds: [summary.id] }],
      { [summary.id]: summary },
      [req1, req2],
      {},
      { projectIds: new Set(['p1']), requestIds: new Set(['req-1']) },
    );

    expect(tree[0]?.conflicted).toBe(true);
    const interfaceNode = tree[0]?.children?.[0];
    const operations = interfaceNode?.children?.find((node) => node.kind === 'operations');
    const operation = operations?.children?.[0];
    const [conflictedReq, otherReq] = operation?.children ?? [];
    expect(conflictedReq).toMatchObject({ requestId: 'req-1', conflicted: true });
    expect(otherReq).toMatchObject({ requestId: 'req-2' });
    expect(otherReq?.conflicted).toBeUndefined();
  });

  it('leaves conflicted unset when no conflict targets are given', () => {
    const summary = iface();
    const tree = interfacesOf([summary], [request()]);
    const operations = tree[0]?.children?.find((node) => node.kind === 'operations');
    const operation = operations?.children?.[0];
    expect(operation?.children?.[0]?.conflicted).toBeUndefined();
  });
});

/**
 * The REST half of the tree. What matters here is the ordering: an interface and an API share one
 * `order` space, and a folder and a request inside a container share another, so the user's
 * arrangement survives a reload rather than the tree grouping by kind.
 */
describe('buildExplorerTree with APIs', () => {
  const project = { id: 'p1', name: 'Demo', source: 'internal' as const, dir: '/ws/demo', status: 'ready' as const };

  function treeWith(rest: {
    apis?: readonly ReturnType<typeof restApiWire>[];
    folders?: readonly ReturnType<typeof restFolderWire>[];
    requests?: readonly ReturnType<typeof restRequestWire>[];
    interfaces?: readonly InterfaceSummary[];
  }): ExplorerNode[] {
    const summaries = rest.interfaces ?? [];
    return (
      buildExplorerTree(
        [project],
        [{ projectId: 'p1', interfaceIds: summaries.map((summary) => summary.id) }],
        Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
        [],
        { p1: { apis: rest.apis ?? [], folders: rest.folders ?? [], requests: rest.requests ?? [] } },
      )[0]?.children ?? []
    );
  }

  it('puts an API under its project, with a REST request and its method', () => {
    const children = treeWith({ apis: [restApiWire()], requests: [restRequestWire({ method: 'DELETE' })] });

    expect(children).toHaveLength(1);
    const [api] = children;
    expect(api).toMatchObject({ id: 'api:api-1', kind: 'api', label: 'Petstore', apiId: 'api-1' });
    expect(api?.children).toHaveLength(1);
    expect(api?.children?.[0]).toMatchObject({
      id: 'rest:rest-1',
      kind: 'rest-request',
      label: 'Get pet',
      requestId: 'rest-1',
      apiId: 'api-1',
      method: 'DELETE',
    });
  });

  it('nests folders, and a request inside one is not also at the root', () => {
    const children = treeWith({
      apis: [restApiWire()],
      folders: [restFolderWire(), restFolderWire({ id: 'folder-2', parentId: 'folder-1', name: 'Admin', order: 0 })],
      requests: [
        restRequestWire({ id: 'rest-root', name: 'At root', order: 1 }),
        restRequestWire({ id: 'rest-deep', name: 'Deep', folderId: 'folder-2', order: 0 }),
      ],
    });

    const api = children[0];
    expect(api?.children?.map((node) => node.label)).toEqual(['Pets', 'At root']);
    const folder = api?.children?.[0];
    expect(folder).toMatchObject({ kind: 'folder', folderId: 'folder-1', apiId: 'api-1' });
    expect(folder?.children?.[0]).toMatchObject({ kind: 'folder', folderId: 'folder-2' });
    expect(folder?.children?.[0]?.children?.[0]).toMatchObject({ requestId: 'rest-deep', folderId: 'folder-2' });
  });

  it('renders folders first then requests, sorted by order within each kind', () => {
    const children = treeWith({
      apis: [restApiWire()],
      // The folder's order is higher than the first request's, yet it still sorts first.
      folders: [restFolderWire({ name: 'Folder (order 1)', order: 1 })],
      requests: [
        restRequestWire({ id: 'r-late', name: 'Request (order 2)', order: 2 }),
        restRequestWire({ id: 'r-early', name: 'Request (order 0)', order: 0 }),
      ],
    });

    expect(children[0]?.children?.map((node) => node.label)).toEqual([
      'Folder (order 1)',
      'Request (order 0)',
      'Request (order 2)',
    ]);
  });

  it('interleaves interfaces and APIs by order under the project', () => {
    const children = treeWith({
      interfaces: [iface(), iface({ id: 'iface-2', name: 'Second' })],
      apis: [
        restApiWire({ id: 'api-early', name: 'Early', order: 1 }),
        restApiWire({ id: 'api-late', name: 'Late', order: 5 }),
      ],
    });

    // Two interfaces at 0 and 1, an API claiming 1 lands after them (a stable sort keeps
    // interfaces first), and the API at 5 last.
    expect(children.map((node) => node.label)).toEqual(['Calculator', 'Second', 'Early', 'Late']);
  });

  it('badges a REST request whose operation an import dropped', () => {
    const children = treeWith({ apis: [restApiWire()], requests: [restRequestWire({ orphaned: true })] });
    expect(children[0]?.children?.[0]?.orphaned).toBe(true);
  });

  it('shows an API with nothing in it as an empty container rather than a leaf', () => {
    const children = treeWith({ apis: [restApiWire()] });
    expect(children[0]?.children).toEqual([]);
  });

  it('leaves a project with no REST data exactly as it was before APIs existed', () => {
    const withKey = treeWith({ interfaces: [iface()] });
    const without =
      buildExplorerTree([project], [{ projectId: 'p1', interfaceIds: ['iface-1'] }], { 'iface-1': iface() }, [])[0]
        ?.children ?? [];

    expect(withKey).toEqual(without);
  });
});

/** What a drag-and-drop is allowed to commit, and what it addresses. */
describe('restEntityId and nodeProjectId', () => {
  const projectOf = { 'api-1': 'p1', 'folder-1': 'p1', 'rest-1': 'p1', 'iface-1': 'p1', 'api-2': 'p2' };

  it('names the entity a move addresses, per REST kind', () => {
    expect(restEntityId({ id: 'api:api-1', kind: 'api', label: 'a', apiId: 'api-1' })).toBe('api-1');
    expect(
      restEntityId({ id: 'folder:folder-1', kind: 'folder', label: 'f', apiId: 'api-1', folderId: 'folder-1' }),
    ).toBe('folder-1');
    expect(restEntityId({ id: 'rest:rest-1', kind: 'rest-request', label: 'r', requestId: 'rest-1' })).toBe('rest-1');
  });

  it('refuses to move anything that is not a REST node', () => {
    expect(
      restEntityId({ id: 'iface:iface-1', kind: 'interface', label: 'i', interfaceId: 'iface-1' }),
    ).toBeUndefined();
    expect(restEntityId({ id: 'req:req-1', kind: 'request', label: 'q', requestId: 'req-1' })).toBeUndefined();
    expect(restEntityId({ id: 'proj:p1', kind: 'project', label: 'p', projectId: 'p1' })).toBeUndefined();
    expect(restEntityId(undefined)).toBeUndefined();
  });

  it('resolves a row to its project, from the row itself or from the index', () => {
    expect(nodeProjectId({ id: 'proj:p1', kind: 'project', label: 'p', projectId: 'p1' }, projectOf)).toBe('p1');
    expect(nodeProjectId({ id: 'rest:rest-1', kind: 'rest-request', label: 'r', requestId: 'rest-1' }, projectOf)).toBe(
      'p1',
    );
    expect(nodeProjectId({ id: 'api:api-2', kind: 'api', label: 'a', apiId: 'api-2' }, projectOf)).toBe('p2');
    expect(nodeProjectId({ id: 'operations:x', kind: 'operations', label: 'Operations' }, projectOf)).toBeUndefined();
  });
});

describe('buildExplorerTree with gRPC APIs', () => {
  const project = { id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/demo', status: 'ready' } as const;
  const api = grpcApiWire({ order: 1 });
  const folder = restFolderWire({ id: 'folder-g', apiId: api.id, name: 'Greetings', order: 0 });
  const inFolder = grpcRequestWire({ id: 'grpc-2', name: 'Chat', methodKind: 'bidi-streaming', folderId: 'folder-g' });
  const atRoot = grpcRequestWire({ id: 'grpc-1', name: 'SayHello', order: 1 });

  function tree(): ExplorerNode[] {
    return buildExplorerTree(
      [project],
      [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
      { 'iface-1': iface() },
      [],
      { p1: { apis: [restApiWire({ order: 2 })], folders: [folder], requests: [] } },
      undefined,
      { p1: { apis: [api], requests: [atRoot, inFolder] } },
    );
  }

  it('places a gRPC API among the interfaces and REST APIs by order, with its folders and requests', () => {
    const [root] = tree();
    expect(root?.children?.map((child) => child.kind)).toEqual(['interface', 'grpc-api', 'api']);

    const grpcApi = root?.children?.[1];
    expect(grpcApi?.id).toBe('grpc-api:grpc-api-1');
    expect(grpcApi?.apiId).toBe('grpc-api-1');
    expect(grpcApi?.children?.map((child) => child.id)).toEqual(['folder:folder-g', 'grpc:grpc-1']);

    const folderNode = grpcApi?.children?.[0];
    expect(folderNode?.kind).toBe('folder');
    expect(folderNode?.grpc).toBe(true);
    expect(folderNode?.children?.[0]).toMatchObject({
      id: 'grpc:grpc-2',
      kind: 'grpc-request',
      methodKind: 'bidi-streaming',
      folderId: 'folder-g',
      apiId: 'grpc-api-1',
    });
  });

  it('does not hand a gRPC API’s folders to the REST API beside it', () => {
    const [root] = tree();
    const restApi = root?.children?.[2];
    expect(restApi?.children).toEqual([]);
  });

  it('addresses gRPC rows by their entity id for move-node', () => {
    const [root] = tree();
    const grpcApi = root?.children?.[1];
    expect(restEntityId(grpcApi)).toBe('grpc-api-1');
    expect(restEntityId(grpcApi?.children?.[1])).toBe('grpc-1');
    expect(nodeProjectId(grpcApi?.children?.[1], { 'grpc-api-1': 'p1' })).toBe('p1');
  });

  it('builds the tree it always did when no gRPC data is given', () => {
    const before = buildExplorerTree(
      [project],
      [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
      { 'iface-1': iface() },
      [],
    );
    expect(before[0]?.children?.map((child) => child.kind)).toEqual(['interface']);
  });
});

describe('buildExplorerTree with WebSocket APIs', () => {
  const project = { id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/demo', status: 'ready' } as const;
  const api = wsApiWire({ order: 2 });
  const folder = restFolderWire({ id: 'folder-w', apiId: api.id, name: 'Rooms', order: 0 });
  const inFolder = wsRequestWire({ id: 'ws-2', name: 'Room chat', folderId: 'folder-w' });
  const atRoot = wsRequestWire({ id: 'ws-1', name: 'Lobby', order: 1 });

  function tree(): ExplorerNode[] {
    return buildExplorerTree(
      [project],
      [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
      { 'iface-1': iface() },
      [],
      { p1: { apis: [restApiWire({ order: 3 })], folders: [folder], requests: [] } },
      undefined,
      { p1: { apis: [grpcApiWire({ order: 1 })], requests: [] } },
      { p1: { apis: [api], requests: [atRoot, inFolder] } },
    );
  }

  it('places a WebSocket API among interfaces and the other protocols’ APIs, by order', () => {
    const [root] = tree();
    expect(root?.children?.map((child) => child.kind)).toEqual(['interface', 'grpc-api', 'ws-api', 'api']);

    const wsApi = root?.children?.[2];
    expect(wsApi?.id).toBe('ws-api:ws-api-1');
    expect(wsApi?.apiId).toBe('ws-api-1');
    expect(wsApi?.children?.map((child) => child.id)).toEqual(['folder:folder-w', 'ws:ws-1']);

    const folderNode = wsApi?.children?.[0];
    expect(folderNode?.kind).toBe('folder');
    expect(folderNode?.ws).toBe(true);
    expect(folderNode?.children?.[0]).toMatchObject({
      id: 'ws:ws-2',
      kind: 'ws-request',
      folderId: 'folder-w',
      apiId: 'ws-api-1',
    });
  });

  it('addresses WebSocket rows by their entity id for move-node', () => {
    const [root] = tree();
    const wsApi = root?.children?.[2];
    expect(restEntityId(wsApi)).toBe('ws-api-1');
    expect(restEntityId(wsApi?.children?.[1])).toBe('ws-1');
    expect(nodeProjectId(wsApi?.children?.[1], { 'ws-api-1': 'p1' })).toBe('p1');
  });

  it('badges a WebSocket request whose contract channel is gone, as gRPC does', () => {
    const orphan = wsRequestWire({ id: 'ws-9', name: 'Gone', order: 2, orphaned: true });
    const [root] = buildExplorerTree(
      [project],
      [{ projectId: 'p1', interfaceIds: [] }],
      {},
      [],
      undefined,
      undefined,
      undefined,
      { p1: { apis: [api], requests: [atRoot, orphan] } },
    );
    const wsApi = root?.children?.find((child) => child.kind === 'ws-api');
    const rows = wsApi?.children?.filter((child) => child.kind === 'ws-request');
    expect(rows?.find((row) => row.id === 'ws:ws-9')?.orphaned).toBe(true);
    expect(rows?.find((row) => row.id === 'ws:ws-1')?.orphaned).toBeUndefined();
  });

  it('builds the tree it always did when no WebSocket data is given', () => {
    const before = buildExplorerTree(
      [project],
      [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
      { 'iface-1': iface() },
      [],
    );
    expect(before[0]?.children?.map((child) => child.kind)).toEqual(['interface']);
  });
});
