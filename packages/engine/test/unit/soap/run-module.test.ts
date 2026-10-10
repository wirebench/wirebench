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
import { soapInterfacesOf } from '../../../src/soap/model.js';

const { events, cacheReads } = vi.hoisted(() => ({ events: [] as string[], cacheReads: [] as string[] }));

// Every read of an interface's definition cache, which holds nothing here: the run then has no definition.
vi.mock('../../../src/wsdl/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/wsdl/cache.js')>()),
  readDefinitionCache: (dir: string) => {
    cacheReads.push(dir);
    return Promise.reject(new Error('no cache here'));
  },
}));

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
  containers: {
    soap: [
      iface('Billing', 2, [request('Later', 1), request('Get', 0), request('Ghost', 2, { orphaned: true })]),
      iface('Accounts', 0, [request('List', 0)]),
    ],
    rest: [createApi('Api', { id: 'api-1', order: 1, requests: [createRestRequest('Ping', { id: 'req-ping' })] })],
  },

  sequences: [],
  mocks: [],
  environments: [],
  wss: { outgoing: [], incoming: [], keystores: [] },
};

const items = () => soapRun.groups(project).flatMap((group) => group.candidates.map((candidate) => candidate.item));

beforeEach(() => {
  events.length = 0;
  cacheReads.length = 0;
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

describe('soapRun.open', () => {
  it('resolves, connects, sends once, and reports a SOAP subject with its exchange and origin', async () => {
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
    const scope = createRunScope(context);
    const sent = get && (await soapRun.open(get, scope, context.host, { scope, interactive: false }).result);
    expect(events).toEqual(['secret secret:tenant', 'secret ref-iface', 'send https://soap.example.test/billing']);
    expect(sent?.subject).toMatchObject({ protocol: 'soap', status: 200 });
    expect(sent?.exchange?.kind).toBe('soap');
    expect(sent?.origin).toBe('https://soap.example.test');
    expect(sent?.scriptsOff).toBeUndefined();
  });
});

describe('soapRun.open with a cached definition', () => {
  const cached: Project = {
    ...project,
    containers: {
      ...project.containers,
      soap: soapInterfacesOf(project).map((i) => ({ ...i, cacheDefinition: true })),
    },
  };
  const contextOf = (extra: Partial<RunContext> = {}): RunContext => ({
    project: cached,
    projectDir: '/nowhere',
    overrides: {},
    host: { getSecret: () => Promise.resolve('abc123def456ghi789') },
    ...extra,
  });
  const sendOnce = async (context: RunContext): Promise<void> => {
    const get = soapRun.groups(cached).flatMap((group) => group.candidates)[0]?.item;
    if (get === undefined) throw new Error('No request to send');
    const scope = createRunScope(context);
    await soapRun.open(get, scope, context.host, { scope, interactive: false }).result;
  };

  it('reads the definition cache when the host holds no definition (the CLI)', async () => {
    await sendOnce(contextOf());
    expect(cacheReads).toHaveLength(1);
  });

  it('never reads the definition cache when the host lends the definition it holds', async () => {
    const asked: string[] = [];
    const held = {
      definition: { bindings: [] },
      bundle: {},
      schemaSet: {},
      wsa: { defaultActionByOperation: {} },
    } as unknown as NonNullable<ReturnType<NonNullable<RunContext['loadedDefinitionFor']>>>;
    await sendOnce(
      contextOf({
        loadedDefinitionFor: (selected) => {
          asked.push(selected.iface.id);
          return held;
        },
      }),
    );
    expect(asked).toEqual(['iface-Billing']);
    expect(cacheReads).toEqual([]);
    expect(events.at(-1)).toBe('send https://soap.example.test/billing');
  });

  it('reads the cache after all when the host holds nothing for the interface', async () => {
    await sendOnce(contextOf({ loadedDefinitionFor: () => undefined }));
    expect(cacheReads).toHaveLength(1);
  });
});

describe('soapRun.resolve', () => {
  const resolveIn = (p: Project, path: string): Promise<unknown> => {
    const context: RunContext = {
      project: p,
      projectDir: '/nowhere',
      overrides: {},
      host: {
        getSecret: (ref) => {
          events.push(`secret ${ref}`);
          return Promise.resolve('abc123def456ghi789');
        },
      },
    };
    const item = soapRun
      .groups(p)
      .flatMap((group) => group.candidates)
      .find((candidate) => candidate.item.path === path)?.item;
    if (item === undefined) throw new Error(`No request at ${path}`);
    return soapRun.resolve(item, createRunScope(context), context.host);
  };

  it('returns the input and its scopes, no credentials, and nothing unresolved', async () => {
    const resolved = await resolveIn(project, 'Billing/First/Get');
    expect(resolved).toMatchObject({
      input: { endpoint: 'https://soap.example.test/billing' },
      scopes: { secrets: { tenant: 'abc123def456ghi789' } },
      unresolved: [],
    });
    expect(resolved).not.toHaveProperty('input.auth');
    // The interface's password is asked for in connect, which resolve does not reach.
    expect(events).toEqual(['secret secret:tenant']);
  });

  it('reports a reference nothing resolves, and does not throw it', async () => {
    const withRef: Project = {
      ...project,
      containers: {
        ...project.containers,
        soap: soapInterfacesOf(project).map((i) => ({
          ...i,
          operations: i.operations.map((operation) => ({
            ...operation,
            requests: operation.requests.map((r) => ({ ...r, envelopeXml: '<Envelope>${nope}</Envelope>' })),
          })),
        })),
      },
    };
    expect(await resolveIn(withRef, 'Billing/First/Get')).toMatchObject({ unresolved: [{ expr: '${nope}' }] });
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
