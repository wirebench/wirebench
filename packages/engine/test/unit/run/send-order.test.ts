/**
 * Pins the order of operations inside one send, per protocol: which secret is asked for when, when
 * the OAuth2 token is fetched, when the contract is loaded, when the scripts run, and what a refused
 * token does to the run's token source. Written against the run module before the protocols became
 * modules, and unchanged by that move.
 *
 * Nothing here reaches the network: the three senders and the three contract loaders are replaced by
 * recorders, so the only thing under test is the order of the calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { HttpExchange } from '../../../src/http/types.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, OAuth2Auth, Project, SoapRequestDef } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { createRunSender } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import type { SelectedRequest } from '../../../src/run/select.js';
import type { RequestScripts, ScriptOutcome } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import type { ScriptSandbox } from '../../../src/script/sandbox/host.js';
import { createWebhookCollection } from '../../../src/webhooks/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const { events, wire } = vi.hoisted(() => ({
  events: [] as string[],
  /** What the recorded senders answer with. */
  wire: { httpStatus: 200, grpcStatus: 0 },
}));

vi.mock('../../../src/wsdl/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/wsdl/cache.js')>()),
  readDefinitionCache: () => {
    events.push('load definition');
    return Promise.reject(new Error('this test has no definition cache'));
  },
}));

vi.mock('../../../src/grpc/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/grpc/cache.js')>();
  return {
    ...actual,
    readGrpcDefinitionCache: (...args: Parameters<typeof actual.readGrpcDefinitionCache>) => {
      events.push('load proto set');
      return actual.readGrpcDefinitionCache(...args);
    },
  };
});

vi.mock('../../../src/script/contracts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/script/contracts.js')>()),
  loadOpenApiDocument: () => {
    events.push('load openapi');
    return Promise.resolve(undefined);
  },
}));

vi.mock('../../../src/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/send.js')>()),
  sendSoapRequest: () => {
    events.push('send');
    return Promise.resolve({
      http: {
        request: { url: 'https://soap.example.test/billing', method: 'POST', headers: {} },
        status: wire.httpStatus,
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

vi.mock('../../../src/rest/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/rest/send.js')>()),
  sendRest: () => {
    events.push('send');
    return Promise.resolve({
      request: { url: 'https://api.example.test/invoices', method: 'GET', headers: {} },
      status: wire.httpStatus,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      text: '{}',
      language: 'json',
      cookies: [],
      methodChanged: false,
      durationMs: 1,
    });
  },
}));

vi.mock('../../../src/grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/grpc/call.js')>()),
  callGrpc: () => {
    events.push('send');
    return Promise.resolve({
      exchange: {
        status: wire.grpcStatus,
        statusName: '',
        headers: {},
        trailers: {},
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
        durationMs: 1,
      },
      methodKind: 'unary',
      requestType: '',
      responseType: '',
      requestMessages: [],
      responseMessages: [{ json: { message: 'Hello' } }],
    });
  },
}));

const AUTH: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://auth.example.test/token',
  clientId: 'client',
  clientSecretRef: 'ref-client',
  scopes: [],
  clientAuth: 'basic',
  pkce: false,
};

const SECRETS: Readonly<Record<string, string>> = {
  'ref-client': 'abc123def456ghi789',
  'ref-hooks': 'abc123def456ghi789',
  'secret:tenant': 'abc123def456ghi789',
  'secret:signing': 'abc123def456ghi789',
};

/** Both scripts, and one secret the scripts list for `secrets.get`. */
const SCRIPTS: RequestScripts = {
  api: 'wirebench',
  enabled: true,
  secrets: ['signing'],
  pre: { text: '' },
  post: { text: '' },
};

const NOTHING = { tests: [], values: [], log: { lines: [], truncated: false } } as const;

/** A script host that records when it is asked to check and to run, and runs nothing. */
class RecordingScripting extends RequestScripting {
  constructor() {
    super({ sandbox: {} as ScriptSandbox });
  }

  override check(): Promise<void> {
    events.push('check');
    return Promise.resolve();
  }

  override pre(): Promise<Extract<ScriptOutcome, { ok: true }>> {
    events.push('pre');
    return Promise.resolve({ ok: true, ...NOTHING });
  }

  override post(): Promise<ScriptOutcome> {
    events.push('post');
    return Promise.resolve({ ok: true, ...NOTHING });
  }
}

/** One request per protocol, each behind the same OAuth2 configuration and holding one secret token. */
function project(scripts?: RequestScripts): Project {
  const withScripts = scripts !== undefined ? { scripts } : {};
  const soapRequest: SoapRequestDef = {
    kind: 'soap',
    id: 'req-soap',
    name: 'Get',
    slug: 'get',
    order: 0,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope>${secret:tenant}</Envelope>',
    endpointId: 'ep-1',
    auth: AUTH,
    ...withScripts,
  };
  const iface: Interface = {
    kind: 'soap',
    id: 'iface-billing',
    name: 'Billing',
    slug: 'Billing',
    order: 0,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: true,
    endpoints: [{ id: 'ep-1', name: 'default', url: 'https://soap.example.test/billing', authMode: 'override' }],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [soapRequest] }],
  };
  const api = createApi('Invoices', {
    id: 'api-invoices',
    slug: 'invoices',
    order: 1,
    baseUrl: 'https://api.example.test',
    auth: AUTH,
    requests: [
      {
        ...createRestRequest('List', {
          id: 'req-rest',
          url: '/invoices',
          headers: [entry('X-Tenant', '${secret:tenant}')],
        }),
        ...withScripts,
      },
    ],
  });
  const grpcApi = (name: string, slug: string, order: number) =>
    createGrpcApi(name, {
      id: `api-${slug}`,
      slug,
      order,
      target: 'localhost:50051',
      tls: false,
      auth: AUTH,
      requests: [
        {
          ...createGrpcRequest('Hello', {
            id: `req-${slug}`,
            service: 'wirebench.greet.Greeter',
            method: 'SayHello',
            message: '{"name":"${secret:tenant}"}',
          }),
          ...withScripts,
        },
      ],
    });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-order',
    name: 'Order',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [iface],
    apis: [api],
    grpcApis: [grpcApi('Greeter', 'greeter', 2), grpcApi('Uncached', 'uncached', 3)],
    wsApis: [],
    sequences: [],
    webhooks: createWebhookCollection({
      target: 'https://receiver.example.test/hooks',
      signing: {
        mode: 'sign',
        scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
        secretRef: 'ref-hooks',
      },
      requests: [
        createRestRequest('Ping', {
          id: 'req-hook',
          slug: 'ping',
          method: 'POST',
          url: '/ping',
          headers: [entry('X-Tenant', '${secret:tenant}')],
        }),
      ],
    }),
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

let dir: string;
let issued = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-send-order-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  events.length = 0;
  issued = 0;
  wire.httpStatus = 200;
  wire.grpcStatus = 0;
});

/** A token endpoint that hands out `tok-1`, `tok-2`, … and records each request. */
const fetchToken: NonNullable<RunContext['fetchToken']> = (request) => {
  events.push('fetch token');
  issued += 1;
  const body = new TextEncoder().encode(
    JSON.stringify({ access_token: `tok-${String(issued)}`, token_type: 'Bearer', expires_in: 3600 }),
  );
  return Promise.resolve({
    request: { url: request.url, method: 'POST', headers: {} },
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body,
    rawBody: body,
  } as unknown as HttpExchange);
};

function contextFor(p: Project, scripting: boolean): RunContext {
  return {
    project: p,
    projectDir: dir,
    overrides: {},
    getSecret: (ref) => {
      events.push(`secret ${ref}`);
      return Promise.resolve(SECRETS[ref]);
    },
    fetchToken,
    ...(scripting ? { scripting: new RecordingScripting() } : {}),
  };
}

function pick(p: Project, path: string): SelectedRequest {
  const [item] = selectRequests(p, [path]).selected;
  if (item === undefined) {
    throw new Error(`No request at ${path}`);
  }
  return item;
}

/** What one send of the request at `path` did, in order. */
async function orderOf(path: string, scripts?: RequestScripts): Promise<readonly string[]> {
  const p = project(scripts);
  await createRunSender(contextFor(p, scripts !== undefined))(pick(p, path));
  return [...events];
}

/** Sends the request at `path` twice through one sender, the first answered as `refuse` sets it. */
async function tokensFetched(path: string, refuse: () => void): Promise<number> {
  const p = project();
  const send = createRunSender(contextFor(p, false));
  refuse();
  await send(pick(p, path));
  wire.httpStatus = 200;
  wire.grpcStatus = 0;
  await send(pick(p, path));
  return events.filter((event) => event === 'fetch token').length;
}

const PLAIN = ['secret ref-client', 'fetch token', 'secret secret:tenant', 'send'];
const SCRIPTED = [
  'check',
  'secret ref-client',
  'fetch token',
  'secret secret:signing',
  'pre',
  'secret secret:tenant',
  'send',
  'post',
];

describe('the order of operations in a SOAP send', () => {
  it('loads the definition, fetches the token, resolves the secret tokens, then sends', async () => {
    expect(await orderOf('Billing/Op/Get')).toEqual(['load definition', ...PLAIN]);
  });

  it('checks the scripts before anything is asked for, and puts the secrets back after the pre-request script', async () => {
    expect(await orderOf('Billing/Op/Get', SCRIPTS)).toEqual(['load definition', ...SCRIPTED]);
  });

  it('drops the token after a 401, and keeps it after a 403', async () => {
    expect(await tokensFetched('Billing/Op/Get', () => (wire.httpStatus = 401))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Billing/Op/Get', () => (wire.httpStatus = 403))).toBe(1);
  });
});

describe('the order of operations in a REST send', () => {
  it('fetches the token, resolves the secret tokens, then sends, and loads no contract', async () => {
    expect(await orderOf('Invoices/List')).toEqual(PLAIN);
  });

  it('loads the OpenAPI document only for a request with scripts, before the check', async () => {
    expect(await orderOf('Invoices/List', SCRIPTS)).toEqual(['load openapi', ...SCRIPTED]);
  });

  it('reads a webhook item’s signing secret after its secret tokens', async () => {
    expect(await orderOf('Webhooks/Ping')).toEqual(['secret secret:tenant', 'secret ref-hooks', 'send']);
  });

  it('sends a request whose scripts are switched off as one without scripts, and says so', async () => {
    const p = project({ ...SCRIPTS, enabled: false });
    const sent = await createRunSender(contextFor(p, true))(pick(p, 'Invoices/List'));
    expect(sent.scriptsOff).toBe(true);
    expect(sent.script).toBeUndefined();
    expect(events).toEqual(PLAIN);
  });

  it('drops the token after a 401, and keeps it after a 403', async () => {
    expect(await tokensFetched('Invoices/List', () => (wire.httpStatus = 401))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Invoices/List', () => (wire.httpStatus = 403))).toBe(1);
  });
});

describe('the order of operations in a gRPC send', () => {
  it('loads the schema before it fetches the token', async () => {
    expect(await orderOf('Greeter/Hello')).toEqual(['load proto set', ...PLAIN]);
  });

  it('loads the schema once for the check and the send', async () => {
    expect(await orderOf('Greeter/Hello', SCRIPTS)).toEqual(['load proto set', ...SCRIPTED]);
  });

  it('remembers a schema that did not load, and asks for nothing', async () => {
    const p = project();
    const send = createRunSender(contextFor(p, false));
    await expect(send(pick(p, 'Uncached/Hello'))).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(send(pick(p, 'Uncached/Hello'))).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    expect(events).toEqual(['load proto set']);
  });

  it('drops the token after UNAUTHENTICATED, and keeps it after PERMISSION_DENIED', async () => {
    expect(await tokensFetched('Greeter/Hello', () => (wire.grpcStatus = 16))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Greeter/Hello', () => (wire.grpcStatus = 7))).toBe(1);
  });
});

describe('a request with scripts in a run that cannot run them', () => {
  it.each(['Billing/Op/Get', 'Invoices/List', 'Greeter/Hello'])(
    'refuses %s before any secret, token or send',
    async (path) => {
      const p = project(SCRIPTS);
      await expect(createRunSender(contextFor(p, false))(pick(p, path))).rejects.toMatchObject({
        code: 'script-unavailable',
      });
      expect(events.filter((event) => !event.startsWith('load '))).toEqual([]);
    },
  );
});
