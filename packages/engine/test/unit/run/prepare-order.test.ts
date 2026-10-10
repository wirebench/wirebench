/**
 * The prepare order of one send (spec §3.4): resolve, pre-request script, connect, send. Connect is
 * where TLS, the proxy, OAuth2 and signing happen, so the pre-request script runs before any token
 * is fetched and its snapshot never holds one (spec §7). Also the codes a send raises for a request
 * that does not resolve (spec §8).
 *
 * Nothing here reaches the network: the three senders are recorders, the token source hands out a
 * fixed token, and the script session records what it was shown.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import { DEFAULT_REQUEST_PROPERTIES } from '../../../src/soap/model.js';
import type { OAuth2Auth, Project } from '../../../src/project/model.js';
import type { Interface, SoapRequestDef } from '../../../src/soap/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import type { SendFailure, SendHost } from '../../../src/run/host.js';
import type { RunTokenSource } from '../../../src/run/oauth2-token.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunSender } from '../../../src/run/run.js';
import { createRunScope } from '../../../src/run/scope.js';
import type { ScriptSession } from '../../../src/run/script-support.js';
import { selectRequests } from '../../../src/run/select.js';
import type { SelectedRequest } from '../../../src/run/select.js';
import { SecretPlaceholders } from '../../../src/script/send.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const { events, refuse } = vi.hoisted(() => ({ events: [] as string[], refuse: { on: false } }));

vi.mock('../../../src/wsdl/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/wsdl/cache.js')>()),
  readDefinitionCache: () => Promise.reject(new Error('this test has no definition cache')),
}));

vi.mock('../../../src/soap/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/soap/send.js')>()),
  sendSoapRequest: () => {
    events.push('send');
    return Promise.resolve({
      http: {
        request: { url: 'https://soap.example.test/billing', method: 'POST', headers: {} },
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

vi.mock('../../../src/rest/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/rest/send.js')>()),
  sendRest: () => {
    events.push('send');
    if (refuse.on) return Promise.reject(new Error('connection refused'));
    return Promise.resolve({
      request: { url: 'https://api.example.test/invoices', method: 'GET', headers: {} },
      status: 200,
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
        status: 0,
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

const TOKEN = 'tok-0f3c9a7e';

/** A token source that records each fetch and always hands out `TOKEN`. */
const tokens: RunTokenSource = {
  accessTokenFor: () => {
    events.push('token');
    return Promise.resolve(TOKEN);
  },
  reject: () => undefined,
};

const NOTHING = { tests: [], values: [], log: { lines: [], truncated: false } } as const;

let snapshotSeenByScript: unknown;

/** A script session that records when the pre-request script runs and what it was shown. */
const session: ScriptSession = {
  pre: (before) => {
    events.push('pre-request script');
    snapshotSeenByScript = before;
    return Promise.resolve(before);
  },
  post: () => Promise.resolve(NOTHING),
};

interface Shape {
  readonly restUrl?: string;
  readonly restBaseUrl?: string;
  readonly soapEnvelope?: string;
  readonly grpcMessage?: string;
  readonly grpcMethod?: string;
}

/** One request per protocol, each behind the same OAuth2 configuration. */
function project(shape: Shape = {}): Project {
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
    envelopeXml: shape.soapEnvelope ?? '<Envelope/>',
    endpointId: 'ep-1',
    auth: AUTH,
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
    baseUrl: shape.restBaseUrl ?? 'https://api.example.test',
    auth: AUTH,
    requests: [
      createRestRequest('List', { id: 'req-rest', url: shape.restUrl ?? '/invoices', headers: [entry('X-A', 'a')] }),
    ],
  });
  const grpcApi = createGrpcApi('Greeter', {
    id: 'api-greeter',
    slug: 'greeter',
    order: 2,
    target: 'localhost:50051',
    tls: false,
    auth: AUTH,
    requests: [
      createGrpcRequest('Hello', {
        id: 'req-greeter',
        service: 'wirebench.greet.Greeter',
        method: shape.grpcMethod ?? 'SayHello',
        message: shape.grpcMessage ?? '{"name":"x"}',
      }),
    ],
  });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-prepare-order',
    name: 'Prepare order',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    containers: { soap: [iface], rest: [api], grpc: [grpcApi] },

    sequences: [],
    mocks: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-prepare-order-'));
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
  snapshotSeenByScript = undefined;
  refuse.on = false;
});

function contextFor(p: Project): RunContext {
  const host: SendHost = { getSecret: () => Promise.resolve('abc123def456ghi789'), tokens };
  return { project: p, projectDir: dir, overrides: {}, host };
}

function pick(p: Project, path: string): SelectedRequest {
  const [item] = selectRequests(p, [path]).selected;
  if (item === undefined) {
    throw new Error(`No request at ${path}`);
  }
  return item;
}

/** Sends the request at `path` with the recording script session. */
async function sendScripted(path: string): Promise<void> {
  const p = project();
  const context = contextFor(p);
  await openExchange(pick(p, path), context.host, {
    scope: createRunScope(context),
    interactive: false,
    scripts: { session, placeholders: new SecretPlaceholders() },
  }).result;
}

describe('the prepare order: resolve, pre-request script, connect, send', () => {
  it.each(['Invoices/List', 'Billing/Op/Get', 'Greeter/Hello'])(
    'runs the pre-request script of %s before the token is fetched, on a snapshot with no token',
    async (path) => {
      await sendScripted(path);
      expect(events).toEqual(['pre-request script', 'token', 'send']);
      expect(JSON.stringify(snapshotSeenByScript)).not.toContain('Bearer');
      expect(JSON.stringify(snapshotSeenByScript)).not.toContain(TOKEN);
    },
  );
});

describe("the desktop's codes for a request that does not resolve", () => {
  const send = (p: Project, path: string): Promise<unknown> => createRunSender(contextFor(p))(pick(p, path));

  it('raises rest-unresolved-properties before any token or send', async () => {
    await expect(send(project({ restUrl: '/${nope}' }), 'Invoices/List')).rejects.toMatchObject({
      code: 'rest-unresolved-properties',
      details: { path: 'Invoices/List', unresolved: ['${nope}'] },
    });
    expect(events).toEqual([]);
  });

  it('raises grpc-unresolved-properties before any token or send', async () => {
    await expect(send(project({ grpcMessage: '{"name":"${nope}"}' }), 'Greeter/Hello')).rejects.toMatchObject({
      code: 'grpc-unresolved-properties',
    });
    expect(events).toEqual([]);
  });

  it('raises grpc-method-unset for a call with no method chosen', async () => {
    await expect(send(project({ grpcMethod: '' }), 'Greeter/Hello')).rejects.toMatchObject({
      code: 'grpc-method-unset',
      details: { path: 'Greeter/Hello' },
    });
    expect(events).toEqual([]);
  });

  it('keeps unresolved-properties for SOAP', async () => {
    await expect(
      send(project({ soapEnvelope: '<Envelope>${nope}</Envelope>' }), 'Billing/Op/Get'),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
    expect(events).toEqual([]);
  });
});

describe('the failures a REST send reports to the host', () => {
  function sendWith(extra: Partial<SendHost>, shape: Shape = {}): { failures: SendFailure[]; done: Promise<unknown> } {
    const p = project(shape);
    const base = contextFor(p);
    const failures: SendFailure[] = [];
    const host: SendHost = { ...base.host, events: { onFailed: (_item, failure) => failures.push(failure) }, ...extra };
    const done = openExchange(pick(p, 'Invoices/List'), host, {
      scope: createRunScope({ ...base, host }),
      interactive: false,
    }).result;
    return { failures, done };
  }

  it('reports stage prepare when connecting throws', async () => {
    const { failures, done } = sendWith({
      proxyFor: () => Promise.reject(new Error('proxy broke')),
    });
    await expect(done).rejects.toThrow('proxy broke');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      attempted: { url: 'https://api.example.test/invoices', method: 'GET', headers: { 'X-A': 'a' } },
    });
    expect(events).not.toContain('send');
  });

  it('reports stage prepare, with what would have gone, for a reference nothing resolves', async () => {
    const { failures, done } = sendWith({}, { restUrl: '/invoices/${nope}' });
    await expect(done).rejects.toMatchObject({ code: 'rest-unresolved-properties' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      error: { code: 'rest-unresolved-properties' },
      attempted: { method: 'GET', headers: { 'X-A': 'a' } },
    });
    expect(failures[0]?.attempted?.url).toContain('https://api.example.test/invoices/');
    expect(events).not.toContain('send');
  });

  it('reports stage prepare with nothing attempted when resolving itself throws', async () => {
    const { failures, done } = sendWith(
      { getSecret: () => Promise.resolve(undefined) },
      { restUrl: '/invoices/${secret:gone}' },
    );
    await expect(done).rejects.toMatchObject({ code: 'secret-missing' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'prepare', error: { code: 'secret-missing' } });
    expect(failures[0]?.attempted).toBeUndefined();
  });

  it('reports stage prepare when the pre-request script throws', async () => {
    const p = project();
    const base = contextFor(p);
    const failures: SendFailure[] = [];
    const host: SendHost = { ...base.host, events: { onFailed: (_item, failure) => failures.push(failure) } };
    const throwing: ScriptSession = { pre: () => Promise.reject(new Error('script broke')), post: session.post };
    await expect(
      openExchange(pick(p, 'Invoices/List'), host, {
        scope: createRunScope({ ...base, host }),
        interactive: false,
        scripts: { session: throwing, placeholders: new SecretPlaceholders() },
      }).result,
    ).rejects.toThrow('script broke');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      attempted: { url: 'https://api.example.test/invoices', method: 'GET' },
    });
    expect(events).not.toContain('send');
  });

  it('reports stage prepare for a base URL that does not parse, and rethrows the original error', async () => {
    const { failures, done } = sendWith(
      { proxyFor: () => Promise.reject(new Error('proxy broke')) },
      { restBaseUrl: 'not a url' },
    );
    await expect(done).rejects.toThrow('proxy broke');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'prepare', attempted: { url: 'not a url/invoices', method: 'GET' } });
  });

  it("never masks the send's own error with one the host's listener throws", async () => {
    const { done } = sendWith({
      proxyFor: () => Promise.reject(new Error('proxy broke')),
      events: {
        onFailed: () => {
          throw new Error('listener broke');
        },
      },
    });
    await expect(done).rejects.toThrow('proxy broke');
  });

  it('reports stage send when the connection is refused', async () => {
    refuse.on = true;
    const { failures, done } = sendWith({});
    await expect(done).rejects.toThrow('connection refused');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'send', attempted: { url: 'https://api.example.test/invoices' } });
  });
});
