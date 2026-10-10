import { describe, expect, it } from 'vitest';
import { findStepRequest, selectRequests } from '../../../src/run/select.js';
import { hooksProject } from '../webhooks/fixture.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import { DEFAULT_REQUEST_PROPERTIES } from '../../../src/soap/model.js';
import type { Project } from '../../../src/project/model.js';
import type { Interface, OperationDef, SoapRequestDef } from '../../../src/soap/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import { createApi, createFolder, createRestRequest } from '../../../src/rest/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';

function soapRequest(name: string, order: number, extra: Partial<SoapRequestDef> = {}): SoapRequestDef {
  return {
    kind: 'soap',
    id: `req-${name}`,
    name,
    slug: name,
    order,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '',
    ...extra,
  };
}

function operation(name: string, order: number, requests: readonly SoapRequestDef[]): OperationDef {
  return { name, bindingName: `{urn:test}${name}`, slug: name, order, requests };
}

function iface(name: string, order: number, operations: readonly OperationDef[]): Interface {
  return {
    kind: 'soap',
    id: `iface-${name}`,
    name,
    slug: name,
    order,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: [],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    operations,
  };
}

function makeProject(): Project {
  const alpha = iface('Alpha', 0, [
    operation('OpA', 0, [soapRequest('Request 1', 0), soapRequest('Ghost', 1, { orphaned: true })]),
  ]);
  const beta = iface('Beta', 2, [operation('OpB', 0, [soapRequest('Request 1', 0)])]);

  const billing = createApi('Billing API', {
    id: 'api-billing',
    order: 1,
    requests: [createRestRequest('Get invoice', { id: 'req-get-invoice', order: 0 })],
    folders: [
      createFolder('invoices', {
        id: 'folder-invoices',
        order: 0,
        requests: [createRestRequest('List', { id: 'req-list', order: 0 })],
      }),
    ],
  });

  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-1',
    name: 'Test project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    containers: { soap: [alpha, beta], rest: [billing] },

    sequences: [],
    mocks: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

describe('selectRequests', () => {
  it('orders by container, then operation or folder, then request, skipping orphans', () => {
    const { selected, unmatched } = selectRequests(makeProject(), []);
    expect(unmatched).toEqual([]);
    expect(selected.map((s) => s.path)).toEqual([
      'Alpha/OpA/Request 1',
      'Billing API/Get invoice',
      'Billing API/invoices/List',
      'Beta/OpB/Request 1',
    ]);
    expect(selected[2]).toMatchObject({ kind: 'rest', group: 'Billing API/invoices' });
  });

  it('narrows to a prefix at a segment boundary and reports what matched nothing', () => {
    const { selected, unmatched } = selectRequests(makeProject(), ['Billing API/invoices', 'Alph', 'Nope']);
    expect(selected.map((s) => s.path)).toEqual(['Billing API/invoices/List']);
    expect(unmatched).toEqual(['Alph', 'Nope']);
  });

  it('accepts the on-disk path of a request file too', () => {
    const { selected } = selectRequests(makeProject(), ['./interfaces/Alpha/operations/OpA/Request 1.request.yaml']);
    expect(selected.map((s) => s.path)).toEqual(['Alpha/OpA/Request 1']);
  });
});

describe('selectRequests — gRPC', () => {
  function withGrpc(): Project {
    const greeter = createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      order: 1.5,
      target: 'localhost:50051',
      requests: [
        createGrpcRequest('Say hello', { id: 'g-hello', order: 1, service: 's.G', method: 'SayHello' }),
        createGrpcRequest('Chat', { id: 'g-chat', order: 0, methodKind: 'bidi-streaming' }),
        createGrpcRequest('Replies', { id: 'g-replies', order: 2, methodKind: 'server-streaming' }),
        { ...createGrpcRequest('Gone', { id: 'g-gone', order: 3 }), orphaned: true },
      ],
      folders: [
        createGrpcFolder('Admin', {
          id: 'g-admin',
          slug: 'admin',
          order: 0,
          requests: [createGrpcRequest('Fail', { id: 'g-fail', slug: 'fail', order: 0 })],
        }),
      ],
    });
    return { ...makeProject(), containers: { ...makeProject().containers, grpc: [greeter] } };
  }

  it('walks a gRPC API in the shared order, non-orphaned requests of every method kind', () => {
    const { selected } = selectRequests(withGrpc(), []);
    expect(selected.map((s) => s.path)).toEqual([
      'Alpha/OpA/Request 1',
      'Billing API/Get invoice',
      'Billing API/invoices/List',
      'Greeter/Admin/Fail',
      'Greeter/Chat',
      'Greeter/Say hello',
      'Greeter/Replies',
      'Beta/OpB/Request 1',
    ]);
    const fail = selected[3];
    expect(fail).toMatchObject({ kind: 'grpc', group: 'Greeter/Admin' });
    expect(fail?.kind === 'grpc' && fail.chain.map((f) => f.name)).toEqual(['Admin']);
  });

  it('accepts display and on-disk paths, and a streaming request matches; an orphan matches nothing', () => {
    const project = withGrpc();
    expect(
      selectRequests(project, ['apis/greeter/requests/admin/fail.request.yaml']).selected.map((s) => s.path),
    ).toEqual(['Greeter/Admin/Fail']);
    expect(selectRequests(project, ['Greeter/Say hello']).selected).toHaveLength(1);
    expect(selectRequests(project, ['Greeter/Chat', 'Greeter/Gone'])).toMatchObject({
      selected: [{ path: 'Greeter/Chat' }],
      unmatched: ['Greeter/Gone'],
    });
  });
});

describe('selectRequests — webhooks', () => {
  it('leaves webhook items out of a run that names no selector', () => {
    const selected = selectRequests(hooksProject(), []).selected;
    expect(selected.filter((item) => item.group.startsWith('Webhooks'))).toEqual([]);
  });

  it('selects webhook items by item path or disk path', () => {
    expect(selectRequests(hooksProject(), ['Webhooks/Group']).selected.map((s) => s.path)).toEqual([
      'Webhooks/Group/Inner',
    ]);
    expect(selectRequests(hooksProject(), ['webhooks/requests/ping.request.yaml']).selected.map((s) => s.path)).toEqual(
      ['Webhooks/Ping'],
    );
  });

  it('selects webhook items against their effective target', () => {
    const selected = selectRequests(hooksProject(), ['Webhooks']).selected;
    const hooks = selected.filter((item) => item.kind === 'rest' && item.group.startsWith('Webhooks'));
    expect(hooks.map((item) => (item.kind === 'rest' ? [item.request.id, item.api.baseUrl] : []))).toEqual([
      ['w1', 'https://receiver.test/hooks'],
      ['w2', 'https://other.test'],
    ]);
  });

  it('refuses a webhook item as a sequence step', () => {
    expect(findStepRequest(hooksProject(), 'w1')).toEqual({
      kind: 'unsupported',
      reason: 'A webhook cannot be a sequence step',
    });
  });
});
