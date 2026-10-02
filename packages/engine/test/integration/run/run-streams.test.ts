/**
 * `runRequests` over streams (spec §5.2): a server-streaming and a bidi gRPC call, a WebSocket
 * request with saved messages and an event stream each run to their end, with every message they
 * received, in order, as a JSON array under assertion. A stream the run timeout cuts errors with
 * `timeout`, never passes, and no stream is refused a run any more.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcMethodKind } from '../../../src/grpc/model.js';
import { grpcRun } from '../../../src/grpc/run.js';
import { createApi, createProject, createRestRequest } from '../../../src/index.js';
import type { Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import type { RequestResult } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import type { WsSavedMessage } from '../../../src/ws/model.js';
import { startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { testHost } from '../../helpers/send-host.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestWsServer } from '../../helpers/test-ws-server.js';
import type { TestWsServer } from '../../helpers/test-ws-server.js';

const SERVICE = 'wirebench.greet.Greeter';

let grpc: TestGrpcServer;
let rest: TestRestServer;
let ws: TestWsServer;
/** Answers only the text `two`, a little later; never answers anything else. */
let lastOnly: TestWsServer;
/** Never answers a text, nor the client's close. */
let deaf: TestWsServer;
let dir: string;

beforeAll(async () => {
  grpc = await startTestGrpcServer();
  rest = await startTestRestServer();
  ws = await startTestWsServer();
  lastOnly = await startTestWsServer({
    onText: (text, peer) => {
      if (text === 'two') setTimeout(() => peer.sendText('re: two'), 50);
    },
  });
  deaf = await startTestWsServer({ onText: () => undefined, ignoreClose: true });
  dir = mkdtempSync(join(tmpdir(), 'wb-run-streams-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await Promise.all([grpc.close(), rest.close(), ws.close(), lastOnly.close(), deaf.close()]);
  rmSync(dir, { recursive: true, force: true });
});

const match = (expression: string, equals: string): Assertion => ({
  type: 'match',
  language: 'jsonpath',
  expression,
  equals,
});

interface Streams {
  readonly grpc?: readonly {
    name: string;
    method: string;
    kind: GrpcMethodKind;
    message: unknown;
    assertions?: readonly Assertion[];
  }[];
  readonly ws?: { url?: string; path: string; messages: readonly WsSavedMessage[]; assertions?: readonly Assertion[] };
  readonly sse?: { path: string; assertions?: readonly Assertion[] };
}

function makeProject(streams: Streams): Project {
  const base = createProject('Streams', { id: 'p-streams' });
  return {
    ...base,
    grpcApis:
      streams.grpc === undefined
        ? []
        : [
            createGrpcApi('Greeter', {
              id: 'api-greeter',
              slug: 'greeter',
              target: grpc.target,
              tls: false,
              requests: streams.grpc.map((call, order) => ({
                ...createGrpcRequest(call.name, {
                  id: `g-${call.name}`,
                  order,
                  service: SERVICE,
                  method: call.method,
                  methodKind: call.kind,
                  message: JSON.stringify(call.message),
                }),
                assertions: call.assertions ?? [],
              })),
            }),
          ],
    wsApis:
      streams.ws === undefined
        ? []
        : [
            createWsApi('Chat', {
              id: 'api-chat',
              slug: 'chat',
              url: streams.ws.url ?? ws.url,
              requests: [
                createWsRequest('Echo', {
                  id: 'ws-echo',
                  url: streams.ws.path,
                  messages: streams.ws.messages,
                  assertions: streams.ws.assertions ?? [],
                }),
              ],
            }),
          ],
    apis:
      streams.sse === undefined
        ? []
        : [
            {
              ...createApi('Events', { id: 'api-events', slug: 'events', baseUrl: rest.url }),
              requests: [
                {
                  ...createRestRequest('Ticks', { id: 'r-ticks', url: streams.sse.path }),
                  assertions: streams.sse.assertions ?? [],
                },
              ],
            },
          ],
  };
}

async function run(project: Project, extra: Partial<RunContext> = {}): Promise<readonly RequestResult[]> {
  const context: RunContext = { project, projectDir: dir, overrides: {}, host: testHost(), ...extra };
  return (await runRequests(selectRequests(project, []).selected, context)).requests;
}

const TWO = [
  createWsSavedMessage('One', { id: 'm1', content: 'one' }),
  createWsSavedMessage('Two', { id: 'm2', content: 'two' }),
];

describe('runRequests — streams', () => {
  it('runs a server-streaming and a bidi call, a WebSocket request and an event stream to their end', async () => {
    const project = makeProject({
      grpc: [
        {
          name: 'replies',
          method: 'LotsOfReplies',
          kind: 'server-streaming',
          message: { count: 3 },
          assertions: [{ type: 'status', equals: 'OK' }, match('$[2].message', 'Hello #3')],
        },
        {
          name: 'chat',
          method: 'Chat',
          kind: 'bidi-streaming',
          message: [{ name: 'Ada' }, { name: 'Bob' }],
          assertions: [match('$[0].message', 'Hello, Ada'), match('$[1].message', 'Hello, Bob')],
        },
      ],
      ws: { path: '/echo', messages: TWO, assertions: [match('$[0]', 'one')] },
      sse: { path: '/sse/ticks?n=3&every=5', assertions: [match('$[2]', '{"tick":3}')] },
    });
    const results = await run(project);
    expect(results.map((r) => [r.path, r.outcome])).toEqual([
      ['Chat/Echo', 'passed'],
      ['Events/Ticks', 'passed'],
      ['Greeter/replies', 'passed'],
      ['Greeter/chat', 'passed'],
    ]);
  });

  it('waits for the reply that comes after the last WebSocket message, then closes with 1000', async () => {
    const project = makeProject({
      ws: { url: lastOnly.url, path: '/', messages: TWO, assertions: [match('$[0]', 're: two')] },
    });
    const [only] = await run(project);
    expect(only).toMatchObject({ protocol: 'websocket', outcome: 'passed' });
  });

  it('waits for the first reply when a WebSocket request saves no message', async () => {
    const project = makeProject({ ws: { path: '/echo', messages: [], assertions: [match('$[0]', 'hello')] } });
    const before = ws.peers.length;
    const greet = (async () => {
      while (ws.peers.length === before) await new Promise((resolve) => setTimeout(resolve, 5));
      ws.peers[before]?.sendText('hello');
    })();
    const [only] = await run(project);
    await greet;
    expect(only).toMatchObject({ protocol: 'websocket', outcome: 'passed' });
  });

  it.each([
    ['an event stream that never ends', makeProjectLater(() => ({ sse: { path: '/sse/forever?events=1' } }))],
    [
      'a server stream that never ends',
      makeProjectLater(() => ({
        grpc: [
          {
            name: 'endless',
            method: 'LotsOfReplies',
            kind: 'server-streaming' as const,
            message: { count: 1000, delay_ms: 50 },
            assertions: [{ type: 'status', equals: 'OK' } as const],
          },
        ],
      })),
    ],
    [
      'a WebSocket that never replies, nor answers the close',
      makeProjectLater(() => ({ ws: { url: deaf.url, path: '/', messages: [TWO[0]!] } })),
    ],
    [
      'a WebSocket that never replies',
      makeProjectLater(() => ({ ws: { url: lastOnly.url, path: '/', messages: [TWO[0]!] } })),
    ],
  ])('errors %s with timeout when the run timeout cuts it', async (_label, later) => {
    const started = performance.now();
    const [only] = await run(later(), { timeoutMs: 200 });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(only).toMatchObject({ outcome: 'errored', error: { code: 'timeout', message: 'The request timed out.' } });
  });

  it('lets go of the connection when the server never answers the close the timeout sent', async () => {
    const before = deaf.peers.length;
    const [only] = await run(makeProject({ ws: { url: deaf.url, path: '/', messages: [TWO[0]!] } }), {
      timeoutMs: 200,
    });
    expect(only).toMatchObject({ outcome: 'errored', error: { code: 'timeout' } });
    const deadline = Date.now() + 2000;
    while (deaf.peers[before]?.closed !== true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(deaf.peers[before]?.closed).toBe(true);
  });

  it('gives no reason a streaming gRPC call cannot run, and selects it', () => {
    const project = makeProject({
      grpc: [
        { name: 'replies', method: 'LotsOfReplies', kind: 'server-streaming', message: {} },
        { name: 'greetings', method: 'LotsOfGreetings', kind: 'client-streaming', message: [] },
        { name: 'chat', method: 'Chat', kind: 'bidi-streaming', message: [] },
      ],
    });
    for (const id of ['g-replies', 'g-greetings', 'g-chat'])
      expect(grpcRun.whyNotRunnable(project, id)).toBeUndefined();
    expect(selectRequests(project, []).selected.map((item) => item.path)).toEqual([
      'Greeter/replies',
      'Greeter/greetings',
      'Greeter/chat',
    ]);
  });
});

/** Builds the project when the test runs, after the servers it names have started. */
function makeProjectLater(streams: () => Streams): () => Project {
  return () => makeProject(streams());
}
