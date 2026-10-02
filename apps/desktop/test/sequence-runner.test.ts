// @vitest-environment node
/**
 * The desktop sequence runner end to end in main: the steps sent through the engine, as a single
 * send is, against real servers, History entries tagged with the run, streams run as a run runs
 * them, and the security properties that only hold if the order of events is right:
 * - a transfer reads the unredacted response, not the redacted summary;
 * - a value marked secret is recorded for masking before its own step's History entry is written;
 * - nothing that crosses to the renderer carries it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startTestGrpcServer,
  startTestWsServer,
  type TestGrpcServer,
  type TestWsServer,
} from '@wirebench/engine/test-helpers';
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createRestRequest,
  createSequence,
  createSequenceStep,
  createWsApi,
  createWsRequest,
  createWsSavedMessage,
  entry,
} from '@wirebench/engine';
import type {
  Assertion,
  CallbackAssertion,
  CaptureSource,
  Project,
  RestSendInput,
  SequenceSettings,
  SequenceStep,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { SequenceRunner } from '../src/main/sequence-runner.js';
import type {
  HistoryEntryWire,
  LogEntryWire,
  RestExchangeSummary,
  SequenceProgressEvent,
  SequenceWaitingEvent,
} from '../src/shared/wire-types.js';

/** Under a JSON key no redaction rule knows, so only the recorded value can mask it. */
const JWT = 'jwt-value-long-7e21c0';

let url = '';
let userDataDir = '';
let meCalls: (string | undefined)[] = [];
let release: (() => void) | undefined;
let grpc: TestGrpcServer;
/** Answers only the text `two`, a little later; never answers anything else. */
let lastOnly: TestWsServer;
/** Never answers a text. */
let deaf: TestWsServer;
const server = createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jwt: JWT, user: 'ada' }));
  } else if (req.url === '/me') {
    meCalls.push(req.headers.authorization);
    res.writeHead(req.headers.authorization === `Bearer ${JWT}` ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'Ada', token: req.headers.authorization }));
  } else if (req.url === '/hang') {
    release = () => res.end('{}');
  } else {
    res.writeHead(404).end();
  }
});

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-sequence-runner-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  grpc = await startTestGrpcServer();
  deaf = await startTestWsServer({ onText: () => undefined });
  lastOnly = await startTestWsServer({
    onText: (text, peer) => {
      if (text === 'two') setTimeout(() => peer.sendText('re: two'), 50);
    },
  });
});

afterAll(async () => {
  await Promise.all([grpc.close(), lastOnly.close(), deaf.close()]);
  await rm(userDataDir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const TEMPLATES: Record<string, Pick<RestSendInput['request'], 'method' | 'url' | 'headers'>> = {
  login: { method: 'POST', url: '/login', headers: [] },
  me: { method: 'GET', url: '/me', headers: [entry('Authorization', 'Bearer ${#Sequence#jwt}')] },
  hang: { method: 'GET', url: '/hang', headers: [] },
};

/** Every request of the steps below, saved as a send reads them: the REST templates, a stream of each kind. */
function project(steps: SequenceStep[], settings?: SequenceSettings): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        baseUrl: url,
        requests: Object.entries(TEMPLATES).map(([id, template]) =>
          createRestRequest(id, { id, method: template.method, url: template.url, headers: [...template.headers] }),
        ),
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'G1',
        target: grpc.target,
        tls: false,
        requests: [
          createGrpcRequest('replies', {
            id: 'replies',
            service: 'wirebench.greet.Greeter',
            method: 'LotsOfReplies',
            methodKind: 'server-streaming',
            message: '{"count": 3}',
          }),
          createGrpcRequest('endless', {
            id: 'endless',
            service: 'wirebench.greet.Greeter',
            method: 'LotsOfReplies',
            methodKind: 'server-streaming',
            message: '{"count": 1000, "delay_ms": 50}',
          }),
        ],
      }),
    ],
    wsApis: [
      createWsApi('Chat', {
        id: 'W1',
        url: lastOnly.url,
        requests: [
          createWsRequest('deaf', {
            id: 'deaf',
            url: deaf.url,
            messages: [createWsSavedMessage('One', { id: 'm3', content: 'one' })],
          }),
          createWsRequest('chat', {
            id: 'chat',
            url: '/',
            messages: [
              createWsSavedMessage('One', { id: 'm1', content: 'one' }),
              createWsSavedMessage('Two', { id: 'm2', content: 'two' }),
            ],
          }),
        ],
      }),
    ],
    sequences: [createSequence('Checkout', { id: 'S1', steps, ...(settings !== undefined ? { settings } : {}) })],
  };
}

/** The request surface a send reads: the project the steps' requests live in, and their names. */
function surface(projectId: string, model: Project) {
  return {
    runContextFor: () => ({ project: model, projectDir: '/tmp/none' }),
    grpcProtoSetFor: () => Promise.resolve(grpc.set),
    // What a step's callback assertions expand against.
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    projectId: () => projectId,
    requestMeta: () => undefined,
    restMeta: (id: string) => ({ requestName: id, apiName: 'Shop', folderPath: '' }),
    grpcMeta: (id: string) => ({ requestName: id, apiName: 'Greeter', folderPath: '' }),
    wsMeta: (id: string) => ({ requestName: id, apiName: 'Chat', folderPath: '' }),
  } as unknown as RequestChannelDeps['project'];
}

async function harness(steps: SequenceStep[], projectId: string, settings?: SequenceSettings) {
  meCalls = [];
  const service = new EngineService();
  const history = new HistoryService(userDataDir);
  await history.open(projectId);
  const logged: { exchange: RestExchangeSummary }[] = [];
  const rows: LogEntryWire[] = [];
  const appended: HistoryEntryWire[] = [];
  const events: SequenceProgressEvent[] = [];
  const model = project(steps, settings);
  const requests = {
    project: surface(projectId, model),
    history,
    onHistoryAppended: (entry: HistoryEntryWire) => appended.push(entry),
    onExchange: (row: LogEntryWire) => {
      rows.push(row);
      if (row.kind === 'exchange' && 'cookies' in row.exchange) logged.push(row as { exchange: RestExchangeSummary });
    },
  } as unknown as RequestChannelDeps;
  const runner = new SequenceRunner();
  const deps = { service, requests, modelOf: () => model, emit: (event: SequenceProgressEvent) => events.push(event) };
  const historyLines = async (): Promise<string[]> =>
    (await readFile(historyFilePath(userDataDir, projectId), 'utf8')).trim().split('\n');
  return { runner, deps, logged, rows, appended, events, historyLines };
}

/** The raw response as the HTTP log shows it. */
function rawResponse(summary: RestExchangeSummary): string {
  return Buffer.from(summary.http.rawResponseBase64, 'base64').toString('utf8');
}

const LOGIN = createSequenceStep('login', {
  id: 'T1',
  transfers: [{ name: 'jwt', from: 'body', language: 'jsonpath', expression: '$.jwt', secret: true }],
});
const ME = createSequenceStep('me', {
  id: 'T2',
  transfers: [{ name: 'user', from: 'body', language: 'jsonpath', expression: '$.name' }],
  assertions: [{ type: 'status', equals: 200 }],
});
const match = (expression: string, equals: string): Assertion => ({
  type: 'match',
  language: 'jsonpath',
  expression,
  equals,
});

describe('SequenceRunner', () => {
  it('carries a secret from one step to the next and never lets it out of main', async () => {
    const { runner, deps, logged, events, historyLines } = await harness([LOGIN, ME], 'P-secret');
    const result = await runner.run({ sequenceId: 'S1', runId: 'R1' }, deps);

    expect(result.outcome).toBe('passed');
    expect(meCalls).toEqual([`Bearer ${JWT}`]);
    expect(result.steps[0]?.transfers).toEqual([{ name: 'jwt', outcome: 'set', secret: true }]);
    expect(result.steps[1]?.transfers).toEqual([{ name: 'user', outcome: 'set', secret: false, value: 'Ada' }]);
    expect(events.map((e) => e.step.index)).toEqual([0, 1]);

    // History, on disk: both steps tagged with the run, and the login step's own entry already masked,
    // because the value was recorded before that entry was written.
    const lines = await historyLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ tags: ['sequence:S1', 'run:R1'] });
      expect(line).not.toContain(JWT);
    }
    // The HTTP Log's rows: the raw response is masked, as for any recorded credential.
    expect(logged).toHaveLength(2);
    for (const row of logged) {
      expect(rawResponse(row.exchange)).not.toContain(JWT);
    }
    // What the run panel is sent carries no value of it at all.
    expect(JSON.stringify(events)).not.toContain(JWT);
    expect(JSON.stringify(result)).not.toContain(JWT);
  });

  it('refuses a second run of the same sequence while one is running, and cancels the step in flight', async () => {
    const hang = createSequenceStep('hang', { id: 'T3' });
    const { runner, deps, appended } = await harness([hang, ME], 'P-cancel');
    const running = runner.run({ sequenceId: 'S1', runId: 'R2' }, deps);
    await vi.waitFor(() => expect(release).toBeDefined());

    await expect(runner.run({ sequenceId: 'S1', runId: 'R3' }, deps)).rejects.toMatchObject({
      code: 'sequence-already-running',
    });
    // Through the step's own signal: the run's cancel needs nothing but the run.
    expect(runner.cancel('R2')).toEqual({ cancelled: true });
    const result = await running;
    release?.();
    release = undefined;

    expect(result.steps.map((s) => s.outcome)).toEqual(['errored', 'skipped']);
    expect(result.steps[0]?.error?.code).toBe('aborted');
    expect(result.steps[1]?.skipped).toBe('cancelled');
    // The cancelled step went out, so History keeps it, tagged with the run, as a cancelled send.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ ok: false, tags: ['sequence:S1', 'run:R2'] });
    expect(runner.cancel('R2')).toEqual({ cancelled: false });
  });

  it('refuses a sequence the project does not have', async () => {
    const { runner, deps } = await harness([], 'P-none');
    await expect(runner.run({ sequenceId: 'nope', runId: 'R4' }, deps)).rejects.toMatchObject({
      code: 'unknown-entity',
    });
  });
});

describe('callback assertions (callback-assertion §5)', () => {
  const CALLBACK: CallbackAssertion = {
    type: 'callback',
    catchUrl: 'orders-hook',
    withinMs: 5_000,
    match: { method: 'POST' },
    expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
  };
  const CAPTURE = {
    id: '01K00000000000000000000002',
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/events',
    signature: null,
    headers: [],
    bodyText: '{"status":"paid"}',
    truncated: false,
  } as const;

  it('waits through the capture source it is given, and says so first', async () => {
    const source: CaptureSource = {
      resolve: () => Promise.resolve({ hookId: '01K000000000000000000000H1' }),
      cursor: () => Promise.resolve(null),
      after: (_hook, cursor) => Promise.resolve(cursor === null ? [CAPTURE] : []),
      detail: () => Promise.resolve(CAPTURE),
    };
    const { runner, deps } = await harness(
      [createSequenceStep('login', { id: 'T1', assertions: [CALLBACK] })],
      'P-callback',
    );
    const waiting: SequenceWaitingEvent[] = [];
    const result = await runner.run(
      { sequenceId: 'S1', runId: 'R-callback' },
      { ...deps, captures: () => source, emitWaiting: (event: SequenceWaitingEvent) => waiting.push(event) },
    );
    expect(waiting).toEqual([
      {
        runId: 'R-callback',
        sequenceId: 'S1',
        index: 0,
        stepId: 'T1',
        waiting: [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 5_000 }],
      },
    ]);
    expect(result.steps[0]?.assertions[0]).toMatchObject({
      type: 'callback',
      outcome: 'passed',
      message: expect.stringMatching(/^matched capture 01K00000000000000000000002 after \d+\.\d s$/) as unknown,
      capture: { hookId: '01K000000000000000000000H1', captureId: '01K00000000000000000000002' },
    });
  });

  it('errors the callback in a workspace with no server', async () => {
    const { runner, deps } = await harness(
      [createSequenceStep('login', { id: 'T1', assertions: [CALLBACK] })],
      'P-callback-2',
    );
    const result = await runner.run({ sequenceId: 'S1', runId: 'R-unlinked' }, deps);
    expect(result.steps[0]?.assertions[0]).toMatchObject({
      outcome: 'errored',
      message: 'this workspace is not linked to a Wirebench Server',
    });
  });
});

describe('streaming steps (a sequence is a run)', () => {
  it('waits for the reply a WebSocket step gets after its last message, and tags its History', async () => {
    const { runner, deps, rows, appended } = await harness(
      [createSequenceStep('chat', { id: 'T1', assertions: [match('$[0]', 're: two')] })],
      'P-ws',
    );
    const result = await runner.run({ sequenceId: 'S1', runId: 'R-ws' }, deps);

    expect(result.steps[0]).toMatchObject({
      outcome: 'passed',
      origin: expect.stringContaining(new URL(lastOnly.url).host) as unknown,
    });
    expect(result.steps[0]).not.toHaveProperty('protocol');
    // The handshake's own row is the session's one row in the HTTP Log.
    expect(rows.map((row) => row.kind === 'exchange' && 'protocol' in row.exchange && row.exchange.protocol)).toEqual([
      'websocket',
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: 'websocket', tags: ['sequence:S1', 'run:R-ws'] });
  });

  it('runs a server-streaming gRPC step to its end, every reply under assertion', async () => {
    const { runner, deps, appended } = await harness(
      [createSequenceStep('replies', { id: 'T1', assertions: [match('$[2].message', 'Hello #3')] })],
      'P-grpc',
    );
    const result = await runner.run({ sequenceId: 'S1', runId: 'R-grpc' }, deps);

    expect(result.steps[0]).toMatchObject({ outcome: 'passed', protocol: 'grpc' });
    expect(appended[0]).toMatchObject({ kind: 'grpc', tags: ['sequence:S1', 'run:R-grpc'] });
  });

  it('errors a gRPC stream the step timeout cuts with timeout', async () => {
    const { runner, deps } = await harness([createSequenceStep('endless', { id: 'T1' })], 'P-cut', {
      stopOnFailure: true,
      stepTimeoutMs: 200,
    });
    const started = performance.now();
    const result = await runner.run({ sequenceId: 'S1', runId: 'R-cut' }, deps);

    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.steps[0]).toMatchObject({ outcome: 'errored', error: { code: 'timeout' } });
  });

  it('closes an open WebSocket step when the run is cancelled, rather than waiting out its timeout', async () => {
    const { runner, deps, rows } = await harness(
      [createSequenceStep('deaf', { id: 'T1' }), createSequenceStep('chat', { id: 'T2' })],
      'P-ws-cancel',
    );
    const started = performance.now();
    const running = runner.run({ sequenceId: 'S1', runId: 'R-ws-cancel' }, deps);
    await vi.waitFor(() => expect(rows).toHaveLength(1));

    expect(runner.cancel('R-ws-cancel')).toEqual({ cancelled: true });
    const result = await running;

    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.steps.map((step) => step.skipped)).toEqual([undefined, 'cancelled']);
  });
});
