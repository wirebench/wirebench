// @vitest-environment node
/**
 * `request.preflightRest`, `request.preflightGrpc` and `request.preflightWs`: the dry run the editor's
 * badge reads while the user types. Each payload is pinned whole — where the request would go, where
 * that came from, what would not expand and whose credentials apply — and a REST preflight agrees
 * with the send about a webhook callback (sent literally to the URL its parent recorded) and about an
 * orphaned request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  createWsApi,
  createWsRequest,
  entry,
} from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { HistoryService } from '../src/main/history-service.js';
import type { HistoryEntryWire, RestExchangeSummary } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  handlers.clear();
});

const DEV: Environment = {
  id: 'env-dev',
  name: 'dev',
  slug: 'dev',
  order: 0,
  endpoints: { petstore: 'https://dev.example/v1', greeter: 'dev.example:50051', chat: 'wss://dev.example' },
  properties: { tenant: 'alpha' },
  disabledProperties: [],
};

/** One project holding a REST API, a gRPC API and a WebSocket API, each with one request. */
function seeded(active: string | null = 'env-dev'): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { who: 'ada' },
    environments: active !== null ? [DEV] : [],
    ...(active !== null ? { activeEnvironmentId: active } : {}),
    apis: [
      createApi('Petstore', {
        id: 'api-1',
        slug: 'petstore',
        baseUrl: 'https://api.default',
        auth: { type: 'basic', username: 'ada', passwordRef: 'sec_pw' },
        requests: [
          createRestRequest('Get pet', {
            id: 'rest-1',
            url: '/pets/{id}/${tenant}',
            pathParams: [entry('id', '')],
            query: [entry('q', '${nowhere}'), entry('who', '${#Project#who}')],
            headers: [entry('X-Token', '${secret:tok}')],
          }),
          { ...createRestRequest('Legacy', { id: 'rest-orphan', url: '/legacy' }), orphaned: true },
        ],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'grpc-api-1',
        slug: 'greeter',
        target: 'localhost:50051',
        requests: [
          createGrpcRequest('SayHello', {
            id: 'grpc-1',
            service: 'greet.Greeter',
            method: 'SayHello',
            metadata: [entry('x-tenant', '${tenant}'), entry('x-missing', '${nothingHere}')],
            message: '{"name": "${#Project#who}", "token": "${secret:tok}", "x": "${alsoNothing}"}',
            auth: { type: 'bearer', tokenRef: 'sec_tok' },
          }),
        ],
      }),
    ],
    wsApis: [
      createWsApi('Chat', {
        id: 'ws-api-1',
        slug: 'chat',
        url: 'ws://chat.default',
        requests: [
          createWsRequest('Room', {
            id: 'ws-1',
            url: '/rooms/${tenant}',
            query: [entry('k', '${notThere}'), entry('t', '${secret:tok}')],
            auth: { type: 'api-key', name: 'key', in: 'header', valueRef: 'sec_key' },
          }),
        ],
      }),
    ],
  };
}

const PARENT_AT = '2026-09-28T10:42:00.000Z';

/** A project whose webhook collection holds target item `w1` and callback item `w3` of `api-1`'s `parent`. */
function hooks(): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    apis: [
      createApi('Petstore', {
        id: 'api-1',
        baseUrl: 'https://api.test',
        requests: [
          createRestRequest('Subscribe', {
            id: 'parent',
            method: 'POST',
            url: '/subscriptions',
            contract: { method: 'post', path: '/subscriptions' },
          }),
        ],
      }),
    ],
    webhooks: createWebhookCollection({
      target: `${server.url}/in`,
      folders: [
        createWebhookFolder('Petstore', {
          id: 'g1',
          target: `${server.url}/fallback`,
          source: { apiId: 'api-1' },
          requests: [
            createRestRequest('Paid', { id: 'w1', method: 'POST', url: '/paid' }),
            createRestRequest('onEvent', {
              id: 'w3',
              method: 'POST',
              url: '/onEvent',
              hook: {
                kind: 'callback',
                operation: 'post /subscriptions',
                name: 'onEvent',
                expression: '{$request.body#/callbackUrl}',
              },
            }),
          ],
        }),
      ],
    }),
  };
}

/** The parent's newest exchange, whose request body names `callback`. */
function parentEntry(callback: string): HistoryEntryWire {
  return {
    id: 'h1',
    kind: 'rest',
    at: PARENT_AT,
    projectId: 'p1',
    requestId: 'parent',
    requestName: 'Subscribe',
    interfaceName: 'Petstore',
    operationName: '',
    endpoint: 'https://api.test/subscriptions',
    soapVersion: 'none',
    method: 'POST',
    status: 201,
    durationMs: 5,
    ok: true,
    request: { envelopeXml: JSON.stringify({ callbackUrl: callback }), headers: [] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 201, statusText: 'Created' },
    sizeBytes: 0,
  };
}

/**
 * Registers the channels over `model`, as the app's project would answer for it. `parents` are the
 * newest History entries a callback's URL is read from.
 */
function registerOver(model: Project, parents: Record<string, HistoryEntryWire> = {}): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: {
      projectId: () => model.id,
      runContextFor: () => ({
        project: model,
        projectDir: '/tmp/none',
        ...(model.activeEnvironmentId !== undefined ? { environmentId: model.activeEnvironmentId } : {}),
      }),
      restMeta: () => undefined,
      requestMeta: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    history: {
      newestFor: (_projectId: string, id: string) => parents[id],
      recordRestSend: () => Promise.resolve(undefined),
    } as unknown as HistoryService,
  });
}

const preflight = async (channel: string, payload: unknown): Promise<unknown> => unwrap(await invoke(channel, payload));

const NONE = {
  endpointSource: 'none',
  unresolved: [],
  auth: { type: 'none', source: 'none' },
  wsa: { enabled: false },
};

/** A property reference nothing resolves, as the wire reports it. */
const missing = (name: string, start: number) => ({
  expr: `\${${name}}`,
  name,
  code: 'missing',
  start,
  end: start + name.length + 3,
});

/** A `{param}` with no value, reported in the same list. */
const missingParam = (name: string) => ({ expr: `{${name}}`, scope: 'path', name, code: 'missing', start: 0, end: 0 });

describe('request.preflightRest', () => {
  it('pins where a request goes, its source, what does not expand and whose credentials apply', async () => {
    registerOver(seeded());
    // The `${secret:…}` header is not listed: a dry run reads no secret, and a send resolves it.
    expect(await preflight('request.preflightRest', { requestId: 'rest-1' })).toEqual({
      endpoint: 'https://dev.example/v1/pets/{id}/alpha?q=%24%7Bnowhere%7D&who=ada',
      endpointSource: 'environment',
      unresolved: [missing('nowhere', 0), missingParam('id')],
      auth: { type: 'basic', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('pins an unsaved draft laid over the request, through the API default with no environment', async () => {
    registerOver(seeded(null));
    const draft = { url: '/owners/${nowhere}', auth: { type: 'bearer', tokenRef: 'sec_b' } };
    expect(await preflight('request.preflightRest', { requestId: 'rest-1', draft })).toEqual({
      endpoint: 'https://api.default/owners/${nowhere}?q=%24%7Bnowhere%7D&who=ada',
      endpointSource: 'interface-default',
      unresolved: [missing('nowhere', 8), missing('nowhere', 0), missingParam('nowhere')],
      auth: { type: 'bearer', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('pins an orphaned request, and agrees with the send about where it goes', async () => {
    const api = { ...seeded().apis[0]!, baseUrl: server.url, auth: { type: 'none' as const } };
    registerOver({ ...seeded(null), apis: [api] });
    const dry = (await preflight('request.preflightRest', { requestId: 'rest-orphan' })) as { endpoint: string };
    expect(dry).toEqual({
      endpoint: `${server.url}/legacy`,
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'none', source: 'request' },
      wsa: { enabled: false },
    });
    const sent = unwrap<RestExchangeSummary>(
      await invoke('request.sendRest', { sendId: 'o1', requestId: 'rest-orphan' }),
    );
    expect(sent.url).toBe(dry.endpoint);
  });

  it('pins a webhook item sent to its target', async () => {
    registerOver(hooks());
    expect(await preflight('request.preflightRest', { requestId: 'w1' })).toEqual({
      endpoint: `${server.url}/fallback/paid`,
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'none', source: 'request' },
      wsa: { enabled: false },
      target: { source: 'target' },
    });
  });

  it('pins a webhook callback, and agrees with the send: it goes literally to the URL its parent recorded', async () => {
    const callback = `${server.url}/echo?t=abc123&sub=42`;
    registerOver(hooks(), { parent: parentEntry(callback) });
    const dry = (await preflight('request.preflightRest', { requestId: 'w3' })) as { endpoint: string };
    expect(dry).toEqual({
      endpoint: callback,
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'none', source: 'request' },
      wsa: { enabled: false },
      // In the machine's local time, as the editor's note shows it.
      target: {
        source: 'callback',
        detail: `from your last POST /subscriptions (${new Date(PARENT_AT).toTimeString().slice(0, 5)})`,
      },
    });
    const sent = unwrap<RestExchangeSummary>(await invoke('request.sendRest', { sendId: 'c1', requestId: 'w3' }));
    expect(sent.url).toBe(dry.endpoint);
    expect(server.requests.at(-1)?.url).toBe('/echo?t=abc123&sub=42');
  });

  it('pins a callback whose parent was never sent, which falls back to the target', async () => {
    registerOver(hooks());
    expect(await preflight('request.preflightRest', { requestId: 'w3' })).toEqual({
      endpoint: `${server.url}/fallback/onEvent`,
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'none', source: 'request' },
      wsa: { enabled: false },
      target: { source: 'callback-fallback', detail: 'expression unresolved — never sent' },
    });
  });

  it('answers the empty preflight for a request no project holds', async () => {
    registerOver(seeded());
    expect(await preflight('request.preflightRest', { requestId: 'nope' })).toEqual(NONE);
  });
});

describe('request.preflightGrpc', () => {
  it('pins the target, its source, what does not expand and whose credentials apply', async () => {
    registerOver(seeded());
    expect(await preflight('request.preflightGrpc', { requestId: 'grpc-1' })).toEqual({
      endpoint: 'dev.example:50051',
      endpointSource: 'environment',
      unresolved: [missing('nothingHere', 0), missing('alsoNothing', 60)],
      auth: { type: 'bearer', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('pins an unsaved draft, through the API default with no environment', async () => {
    registerOver(seeded(null));
    const draft = { message: '{"who": "${#Project#who}"}', metadata: [] };
    expect(await preflight('request.preflightGrpc', { requestId: 'grpc-1', draft })).toEqual({
      endpoint: 'localhost:50051',
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'bearer', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('answers the empty preflight for a request no project holds', async () => {
    registerOver(seeded());
    expect(await preflight('request.preflightGrpc', { requestId: 'nope' })).toEqual(NONE);
  });
});

describe('request.preflightWs', () => {
  it('pins the URL, its source, what does not expand and whose credentials apply', async () => {
    registerOver(seeded());
    expect(await preflight('request.preflightWs', { requestId: 'ws-1' })).toEqual({
      endpoint: 'wss://dev.example/rooms/alpha?k=%24%7BnotThere%7D&t=%24%7Bsecret%3Atok%7D',
      endpointSource: 'environment',
      unresolved: [missing('notThere', 0)],
      auth: { type: 'api-key', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('pins an unsaved draft, through the API default with no environment', async () => {
    registerOver(seeded(null));
    const draft = { url: '/lobby', query: [] };
    expect(await preflight('request.preflightWs', { requestId: 'ws-1', draft })).toEqual({
      endpoint: 'ws://chat.default/lobby',
      endpointSource: 'interface-default',
      unresolved: [],
      auth: { type: 'api-key', source: 'request' },
      wsa: { enabled: false },
    });
  });

  it('answers the empty preflight for a request no project holds', async () => {
    registerOver(seeded());
    expect(await preflight('request.preflightWs', { requestId: 'nope' })).toEqual(NONE);
  });
});
