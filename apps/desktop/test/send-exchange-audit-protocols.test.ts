// @vitest-environment node
/**
 * What a send reports to the audit log (desktop audit events spec §2.2) beyond REST: a SOAP, gRPC and
 * WebSocket send each report `desktop.request_sent` with their own URL (masked), a failed one reports
 * `failed`, a History resend and an HTTP Log resend report through the same hook, and sends made under
 * different environments each name their own.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startTestGrpcServer,
  startTestRestServer,
  startTestWsServer,
  type TestGrpcServer,
  type TestRestServer,
  type TestWsServer,
} from '@wirebench/engine/test-helpers';
import {
  createApi,
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  createWsApi,
  createWsRequest,
  entry,
} from '@wirebench/engine';
import type { DesktopAuditEvent, Environment, GetSecret, Project, SoapRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  buildRestHistoryEntry,
  toHistoryEntryWire,
  type HistoryService,
  type RecordRestSendInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { registerLogChannels } from '../src/main/ipc/log.js';
import { toSendDeps, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

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
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: {} }, payload);
}

const KEY = 'proto-key-9d2c41';
const secrets: GetSecret = (ref) => Promise.resolve(ref === 'sec_key' ? KEY : undefined);

let rest: TestRestServer;
let grpc: TestGrpcServer;
let ws: TestWsServer;
let soapServer: Server;
let soapUrl: string;

beforeAll(async () => {
  rest = await startTestRestServer();
  grpc = await startTestGrpcServer();
  ws = await startTestWsServer();
  soapServer = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<soap:Envelope><soap:Body/></soap:Envelope>');
  });
  await new Promise<void>((resolve) => soapServer.listen(0, '127.0.0.1', resolve));
  const address = soapServer.address();
  soapUrl = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
});

afterAll(async () => {
  await rest.close();
  await grpc.close();
  await ws.close();
  await new Promise<void>((resolve) => soapServer.close(() => resolve()));
});

beforeEach(() => handlers.clear());

const env = (id: string, name: string): Environment => ({
  id,
  name,
  slug: name.toLowerCase(),
  order: 0,
  endpoints: {},
  properties: {},
  disabledProperties: [],
});
const QA = env('env-qa', 'QA');
const PROD = env('env-prod', 'Prod');

function soapModel(endpointUrl: string): Project {
  const request: SoapRequestDef = {
    ...createRequest('Add', {
      id: 'soap-1',
      envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
      soapVersion: '1.1',
      soapAction: 'urn:calc:Add',
    }),
    endpointUrl,
  };
  const iface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
  });
  return { ...createProject('Demo', { id: 'p1' }), interfaces: [iface], environments: [QA, PROD] };
}

function grpcModel(target: string): Project {
  const call = createGrpcRequest('SayHello', {
    id: 'grpc-1',
    service: 'wirebench.greet.Greeter',
    method: 'SayHello',
    methodKind: 'unary',
    message: '{"name": "Ada"}',
  });
  return {
    ...createProject('Demo', { id: 'p1' }),
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'g-1',
        target,
        tls: false,
        folders: [createGrpcFolder('Greeter', { id: 'f-1', requests: [call] })],
      }),
    ],
    environments: [QA, PROD],
  };
}

function wsModel(path: string): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    wsApis: [
      createWsApi('Chat', {
        id: 'w-1',
        url: ws.url,
        requests: [createWsRequest('Echo', { id: 'ws-1', url: path })],
      }),
    ],
    environments: [QA, PROD],
  };
}

function restModel(baseUrl: string): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl,
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo', query: [entry('x', '1')] })],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api], environments: [QA, PROD] };
}

function audited(model: Project, environmentId?: string, extraProject: Record<string, unknown> = {}) {
  const events: DesktopAuditEvent[] = [];
  const deps = sendDepsFor(model, {
    getSecret: secrets,
    audit: (event) => events.push(event),
    project: {
      runContextFor: () => ({
        project: model,
        projectDir: '/tmp/none',
        globals: {},
        ...(environmentId !== undefined ? { environmentId } : {}),
      }),
      ...extraProject,
    },
  });
  return { deps, events };
}

describe('a SOAP send', () => {
  it('reports its endpoint URL and the environment', async () => {
    const { deps, events } = audited(soapModel(`${soapUrl}/calc?token=${KEY}`), 'env-qa');
    await sendThroughEngine(deps, 's1', 'soap-1', { draft: { kind: 'soap', override: {} }, envId: 'env-qa' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'soap', method: 'POST', status: 200, outcome: 'ok', environment: 'QA', requestId: 'soap-1' },
    });
    const { url } = events[0]!.details as { url: string };
    expect(url.startsWith(`${soapUrl}/calc?token=`)).toBe(true);
    expect(url).not.toContain(KEY);
  });

  it('reports a send that failed on the wire as failed, with where it was going', async () => {
    const { deps, events } = audited(soapModel('http://127.0.0.1:1/calc'), 'env-qa');
    await expect(
      sendThroughEngine(deps, 's1', 'soap-1', { draft: { kind: 'soap', override: {} }, envId: 'env-qa' }),
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: {
        protocol: 'soap',
        method: 'POST',
        status: null,
        outcome: 'failed',
        environment: 'QA',
        url: 'http://127.0.0.1:1/calc',
      },
    });
  });
});

describe('a gRPC send', () => {
  it('reports its target', async () => {
    const { deps, events } = audited(grpcModel(grpc.target), 'env-qa', {
      grpcProtoSetFor: () => Promise.resolve(grpc.set),
    });
    await sendThroughEngine(deps, 's1', 'grpc-1', { draft: { kind: 'grpc' }, envId: 'env-qa' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: {
        protocol: 'grpc',
        method: 'wirebench.greet.Greeter/SayHello',
        outcome: 'ok',
        environment: 'QA',
        url: grpc.target,
      },
    });
  });

  it('reports a call that failed on the wire as failed, with its target', async () => {
    const { deps, events } = audited(grpcModel('127.0.0.1:1'), 'env-qa', {
      grpcProtoSetFor: () => Promise.resolve(grpc.set),
    });
    await expect(
      sendThroughEngine(deps, 's1', 'grpc-1', { draft: { kind: 'grpc' }, envId: 'env-qa' }),
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'grpc', status: null, outcome: 'failed', environment: 'QA', url: '127.0.0.1:1' },
    });
  });
});

describe('a WebSocket send', () => {
  it('reports the URL it connected to', async () => {
    const { deps, events } = audited(wsModel('/echo'), 'env-qa');
    const opened = sendThroughEngine(deps, 's1', 'ws-1', {
      draft: { kind: 'websocket' },
      envId: 'env-qa',
      interactive: true,
      onLive: (live) => {
        if (live.kind === 'handshake') deps.registry.closeWs('s1');
      },
    });
    await opened;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: {
        protocol: 'websocket',
        method: null,
        status: 101,
        outcome: 'ok',
        environment: 'QA',
        url: `${ws.url}/echo`,
      },
    });
  });

  it('reports a refused handshake as failed, with the URL it dialled', async () => {
    const { deps, events } = audited(wsModel('/refuse'), 'env-qa');
    await sendThroughEngine(deps, 's1', 'ws-1', { draft: { kind: 'websocket' }, envId: 'env-qa', interactive: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'websocket', outcome: 'failed', environment: 'QA', url: `${ws.url}/refuse` },
    });
  });

  it('reports a handshake cancelled while it hangs as failed, with the URL', async () => {
    const { deps, events } = audited(wsModel('/hang'), 'env-qa');
    const sending = sendThroughEngine(deps, 's1', 'ws-1', {
      draft: { kind: 'websocket' },
      envId: 'env-qa',
      interactive: true,
    });
    await vi.waitFor(() => expect(deps.registry.has('s1')).toBe(true));
    deps.registry.cancel('s1');
    await expect(sending).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'websocket', status: null, outcome: 'failed', environment: 'QA', url: `${ws.url}/hang` },
    });
  });
});

describe('a send under one environment, then another', () => {
  it('reports each with its own environment name', async () => {
    const model = restModel(rest.url);
    const events: DesktopAuditEvent[] = [];
    let active = 'env-qa';
    const deps = sendDepsFor(model, {
      getSecret: secrets,
      audit: (event) => events.push(event),
      project: {
        runContextFor: () => ({ project: model, projectDir: '/tmp/none', environmentId: active, globals: {} }),
      },
    });

    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' }, envId: 'env-qa' });
    active = 'env-prod';
    await sendThroughEngine(deps, 's2', 'req-1', { draft: { kind: 'rest' }, envId: 'env-prod' });

    expect(events.map((event) => (event.details as { environment: string }).environment)).toEqual(['QA', 'Prod']);
    expect(events.map((event) => event.action)).toEqual(['desktop.request_sent', 'desktop.request_sent']);
  });
});

describe('a resend', () => {
  /** Main's request-channel deps over `model`, a History that records REST sends, and the audit hook. */
  function harness(model: Project) {
    const entries: HistoryEntryWire[] = [];
    const history = {
      recordRestSend: (projectId: string, record: RecordRestSendInput) => {
        const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
        entries.unshift(wire);
        return Promise.resolve(wire);
      },
      get: (id: string) => entries.find((candidate) => candidate.id === id),
    };
    const events: DesktopAuditEvent[] = [];
    const workspaces: (string | undefined)[] = [];
    const requestDeps: RequestChannelDeps = {
      project: {
        projectId: () => 'p1',
        restMeta: () => undefined,
        endpointFor: () => undefined,
        runContextFor: () => ({ project: model, projectDir: '/tmp/none', environmentId: 'env-qa', globals: {} }),
      } as unknown as RequestChannelDeps['project'],
      history: history as unknown as HistoryService,
      secretsFor: () => secrets,
      audit: (event, workspaceId) => {
        events.push(event);
        workspaces.push(workspaceId);
      },
      auditWorkspace: () => 'ws-A',
    };
    const engine = new EngineService();
    const sendDeps = toSendDeps(engine, requestDeps);
    registerHistoryChannels(history as never, {
      project: { projectId: () => 'p1', endpointFor: () => undefined },
      send: sendDeps,
    });
    registerLogChannels({
      showSecrets: { get: () => false },
      service: engine,
      request: requestDeps,
      picks: { rememberWrite: () => undefined },
      appVersion: '0.0.0-test',
    });
    return { sendDeps, entries, events, workspaces };
  }

  function expectEcho(event: DesktopAuditEvent | undefined): void {
    expect(event).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'rest', method: 'GET', status: 200, outcome: 'ok', environment: 'QA', requestId: 'req-1' },
    });
    const { url } = event!.details as { url: string };
    expect(url.startsWith(`${rest.url}/echo?x=1&api_key=`)).toBe(true);
    expect(url).not.toContain(KEY);
  }

  it('from History reports request.sent like the send it repeats', async () => {
    const { sendDeps, entries, events, workspaces } = harness(restModel(rest.url));
    await sendThroughEngine(sendDeps, 'first', 'req-1', { draft: { kind: 'rest' } });
    expect(events).toHaveLength(1);

    const reply = await invoke('history.resendRest', { id: entries[0]!.id });

    expect(reply).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(events).toHaveLength(2);
    expectEcho(events[1]);
    expect(workspaces).toEqual(['ws-A', 'ws-A']);
  });

  it('from the HTTP Log reports request.sent through the same hook', async () => {
    const { events, workspaces } = harness(restModel(rest.url));

    const reply = await invoke('log.resend', { protocol: 'rest', requestId: 'req-1' });

    expect(reply).toMatchObject({ ok: true, value: { protocol: 'rest' } });
    expect(events).toHaveLength(1);
    expectEcho(events[0]);
    expect(workspaces).toEqual(['ws-A']);
  });
});
