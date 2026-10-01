/** SOAP's run facet on its own: what it offers a run, why a request cannot run, its needs, one send. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, Project, SoapRequestDef } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { soapProtocol } from '../../../src/soap/module.js';
import { soapRun } from '../../../src/soap/run.js';
import { normalizeWsa } from '../../../src/wsa/model.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/soap/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/soap/send.js')>()),
  sendSoapRequest: (input: { readonly endpoint: string }) => {
    events.push(`send ${input.endpoint}`);
    return Promise.resolve({
      http: {
        request: { url: input.endpoint, method: 'POST', headers: {} },
        status: 200,
        statusText: '',
        headers: {},
        rawHeaders: [],
        body: new Uint8Array(),
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
      },
      durationMs: 1,
      problems: [],
    });
  },
}));

function request(name: string, order: number, extra: Partial<SoapRequestDef> = {}): SoapRequestDef {
  return {
    kind: 'soap',
    id: `req-${name}`,
    name,
    slug: name.toLowerCase(),
    order,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope>${secret:tenant}</Envelope>',
    endpointId: 'ep-1',
    ...extra,
  };
}

function iface(name: string, order: number, requests: readonly SoapRequestDef[]): Interface {
  return {
    kind: 'soap',
    id: `iface-${name}`,
    name,
    slug: name,
    order,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: [{ id: 'ep-1', name: 'default', url: 'https://soap.example.test/billing', authMode: 'override' }],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    auth: { type: 'basic', username: 'svc', passwordRef: 'ref-iface', passwordEnv: 'BILLING_PASSWORD' },
    operations: [
      { name: 'Second', bindingName: '{urn:t}B', slug: 'second', order: 1, requests: [] },
      { name: 'First', bindingName: '{urn:t}B', slug: 'first', order: 0, requests },
    ],
  };
}

const project: Project = {
  formatVersion: FORMAT_VERSION,
  id: 'proj-soap',
  name: 'SOAP module',
  settings: DEFAULT_PROJECT_SETTINGS,
  properties: {},
  disabledProperties: [],
  interfaces: [
    iface('Billing', 2, [request('Later', 1), request('Get', 0), request('Ghost', 2, { orphaned: true })]),
    iface('Accounts', 0, [request('List', 0)]),
  ],
  apis: [createApi('Api', { id: 'api-1', order: 1, requests: [createRestRequest('Ping', { id: 'req-ping' })] })],
  grpcApis: [],
  wsApis: [],
  sequences: [],
  environments: [],
  wss: { outgoing: [], incoming: [], keystores: [] },
};

const items = () => soapRun.groups(project).flatMap((group) => group.candidates.map((candidate) => candidate.item));

beforeEach(() => {
  events.length = 0;
});

describe('soapRun.groups', () => {
  it('offers one group per interface, in the project’s list order, with its own order and name', () => {
    expect(soapRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [2, 'Billing', undefined],
      [0, 'Accounts', undefined],
    ]);
  });

  it('orders operations, then requests, and leaves orphans out', () => {
    expect(items().map((item) => item.path)).toEqual([
      'Billing/First/Get',
      'Billing/First/Later',
      'Accounts/First/List',
    ]);
  });

  it('offers exactly what a run selects of SOAP, under the same disk paths', () => {
    const selected = selectRequests(project, []).selected.filter((item) => item.kind === 'soap');
    expect(selected.map((item) => item.path)).toEqual([
      'Accounts/First/List',
      'Billing/First/Get',
      'Billing/First/Later',
    ]);
    expect(selected).toEqual(expect.arrayContaining(items()));
    const [first] = soapRun.groups(project)[0]?.candidates ?? [];
    expect(first?.diskPath).toBe('interfaces/Billing/operations/first/get');
    expect(selectRequests(project, [first?.diskPath ?? '']).selected).toEqual([first?.item]);
  });
});

describe('soapRun.whyNotRunnable', () => {
  it('says why an orphaned request cannot run, and nothing for a runnable or a foreign one', () => {
    expect(soapRun.whyNotRunnable(project, 'req-Ghost')).toBe('The request is no longer in its contract (orphaned)');
    expect(soapRun.whyNotRunnable(project, 'req-Get')).toBeUndefined();
    expect(soapRun.whyNotRunnable(project, 'req-ping')).toBeUndefined();
  });
});

describe('soapRun.secretNeeds', () => {
  it('lists what the request’s configuration needs, and not its secret tokens', () => {
    const [get] = items();
    expect(get && soapRun.secretNeeds(get, project)).toEqual([
      { ref: 'ref-iface', envName: 'BILLING_PASSWORD', purpose: 'basic password for "svc"' },
    ]);
  });
});

describe('soapRun.send', () => {
  it('prepares, sends once, and reports a SOAP subject with its exchange and origin', async () => {
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      host: {
        getSecret: (ref) => {
          events.push(`secret ${ref}`);
          return Promise.resolve('abc123def456ghi789');
        },
      },
    };
    const [get] = items();
    const sent = get && (await soapRun.send(get, createRunScope(context)));
    expect(events).toEqual(['secret ref-iface', 'secret secret:tenant', 'send https://soap.example.test/billing']);
    expect(sent?.subject).toMatchObject({ protocol: 'soap', status: 200 });
    expect(sent?.exchange?.kind).toBe('soap');
    expect(sent?.origin).toBe('https://soap.example.test');
    expect(sent?.scriptsOff).toBeUndefined();
  });
});

describe('soapProtocol', () => {
  it('is the soap kind behind the soap feature, with a run facet', () => {
    expect(soapProtocol.kind).toBe('soap');
    expect(soapProtocol.feature).toEqual({ id: 'soap', title: 'SOAP', default: true, stage: 'stable', requires: [] });
    expect(soapProtocol.run?.groups(project)).toHaveLength(2);
  });

  it('refuses a request of another kind', () => {
    const [rest] = selectRequests(project, ['Api/Ping']).selected;
    expect(() => rest && soapProtocol.run?.secretNeeds(rest, project)).toThrow(
      'The "soap" protocol was handed a "rest" request',
    );
  });
});
