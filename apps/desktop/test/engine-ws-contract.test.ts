// @vitest-environment node
/**
 * Live contract checks on a WebSocket session sent through the engine: every frame reaches `onLive`
 * at once, unchecked, and its result follows as a `contract` event computed on a worker thread — so
 * a runaway check can never stall the main process. A check past its deadline is `not-checked` and
 * the next frame gets a fresh worker; the worker ends with the session, on a close and on quit (the
 * registry's `endWhere`) alike.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import {
  asyncApiChannelMessages,
  createDefaultFetchDocument,
  createProject,
  createWsApi,
  createWsRequest,
  parseAsyncApi,
  type ChannelMessages,
  type Project,
  type WorkerFrameChecker,
  type WsFrame,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { ExchangeRegistry, sendThroughEngine } from '../src/main/send/exchange.js';
import { wsLiveEventSchema, type WsLiveEvent } from '../src/shared/wire-types.js';

let server: TestWsServer;
let messages: ChannelMessages;
const hanging = new URL('../../../packages/engine/test/fixtures/asyncapi/hanging-frame-worker.mjs', import.meta.url);

beforeAll(async () => {
  server = await startTestWsServer();
  const fixture = new URL('../../../packages/engine/test/fixtures/asyncapi/chat-3.0.yaml', import.meta.url);
  const parsed = await parseAsyncApi(
    { kind: 'file', path: fixture.href },
    { fetchDocument: createDefaultFetchDocument() },
  );
  messages = asyncApiChannelMessages(parsed.document, 'userChat');
});

afterAll(async () => {
  await server.close();
});

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function checkers(registry: ExchangeRegistry): Map<string, WorkerFrameChecker> {
  return registry.frameCheckers;
}

type ContractEvent = Extract<WsLiveEvent, { kind: 'contract' }>;

/** A project whose request `r1` dials `/chat` on the test server. */
function chatProject(): Project {
  return {
    ...createProject('Chat', { id: 'p1' }),
    wsApis: [
      createWsApi('Chat', {
        id: 'w-1',
        url: server.url,
        requests: [createWsRequest('Chat', { id: 'r1', url: '/chat' })],
      }),
    ],
  };
}

/** Opens `r1` as `request.openWs` does, its contract the one given. */
function session(
  registry: ExchangeRegistry,
  sendId: string,
  contract: Promise<ChannelMessages | undefined> | undefined,
  checkerOptions?: { workerUrl?: URL; deadlineMs?: number },
) {
  const project = chatProject();
  const events: WsLiveEvent[] = [];
  const done = sendThroughEngine(
    {
      project: {
        projectId: () => project.id,
        runContextFor: () => ({ project, projectDir: '/tmp/none' }),
        wsContractFor: () => contract,
        wsMeta: () => undefined,
      } as unknown as RequestChannelDeps['project'],
      service: new EngineService(),
      registry,
      ...(checkerOptions !== undefined ? { wsFrameChecker: checkerOptions } : {}),
    },
    sendId,
    'r1',
    {
      draft: { kind: 'websocket' },
      interactive: true,
      onLive: (event) => {
        // Every event must survive the IPC schema, the `contract` follow-up included.
        events.push(wsLiveEventSchema.parse(event));
      },
    },
  );
  const contracts = () => events.filter((e): e is ContractEvent => e.kind === 'contract');
  return { events, done, contracts };
}

/** One message on the session `sendId`, as `request.wsSend` pushes it; answers the frame it went as. */
async function send(registry: ExchangeRegistry, sendId: string, text: string): Promise<WsFrame> {
  const handle = registry.get(sendId);
  if (handle === undefined) throw new Error(`no session "${sendId}"`);
  return (await handle.push({ text })) as WsFrame;
}

describe('EngineService WebSocket contract checks', () => {
  it('reports each frame at once and its check as a follow-up event', async () => {
    const registry = new ExchangeRegistry();
    const s = session(registry, 'c1', Promise.resolve(messages));
    await waitFor(() => s.events.some((e) => e.kind === 'handshake'), 'the handshake');

    const sample = await send(registry, 'c1', JSON.stringify({ type: 'message', text: 'Hello' }));
    const broken = await send(registry, 'c1', '{"type":1}');
    expect(sample.contract).toBeUndefined();
    await waitFor(() => s.contracts().length >= 4, 'four checks (two sent, two echoed)');

    const frames = s.events.filter((e) => e.kind === 'frame');
    expect(frames.every((e) => e.kind === 'frame' && e.frame.contract === undefined)).toBe(true);
    const byIndex = new Map(s.contracts().map((e) => [e.index, e.contract]));
    expect(byIndex.get(sample.index)).toEqual({ status: 'ok', message: 'sendChat' });
    expect(byIndex.get(broken.index)?.status).toBe('violation');
    expect(checkers(registry).get('c1')?.running).toBe(true);
    const checker = checkers(registry).get('c1');

    registry.closeWs('c1');
    const summary = await s.done;
    // History keeps the results: the summary's frames carry them.
    expect(summary.frames.find((f) => f.index === sample.index)?.contract?.status).toBe('ok');
    expect(summary.frames.find((f) => f.index === broken.index)?.contract?.status).toBe('violation');
    expect(checkers(registry).size).toBe(0);
    expect(checker?.running).toBe(false);
  });

  it('a session without a contract emits no checks and starts no worker', async () => {
    const registry = new ExchangeRegistry();
    const s = session(registry, 'c2', undefined);
    await waitFor(() => s.events.some((e) => e.kind === 'handshake'), 'the handshake');
    await send(registry, 'c2', '{"type":1}');
    await waitFor(() => s.events.filter((e) => e.kind === 'frame').length >= 2, 'the echo');
    expect(checkers(registry).size).toBe(0);
    registry.closeWs('c2');
    const summary = await s.done;
    expect(s.contracts()).toHaveLength(0);
    expect(summary.frames.every((f) => f.contract === undefined)).toBe(true);
  });

  it('a contract that fails to load leaves frames unchecked and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = new ExchangeRegistry();
      const s = session(registry, 'c3', Promise.reject(new Error('cache is corrupt')));
      await waitFor(() => s.events.some((e) => e.kind === 'handshake'), 'the handshake');
      await send(registry, 'c3', '{"type":1}');
      await send(registry, 'c3', '{"type":2}');
      await waitFor(() => s.events.filter((e) => e.kind === 'frame').length >= 4, 'the echoes');
      registry.closeWs('c3');
      await s.done;
      expect(s.contracts()).toHaveLength(0);
      const lines = warn.mock.calls.filter((call) => String(call[0]).includes('contract'));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]?.[0])).toContain('cache is corrupt');
    } finally {
      warn.mockRestore();
    }
  });

  it('a check that hangs is not-checked, and the next frame is checked by a fresh worker', async () => {
    const registry = new ExchangeRegistry();
    const s = session(registry, 'c4', Promise.resolve(messages), { workerUrl: hanging, deadlineMs: 600 });
    await waitFor(() => s.events.some((e) => e.kind === 'handshake'), 'the handshake');
    const stuck = await send(registry, 'c4', 'hang');
    // The frame itself is out at once, while its check is still spinning.
    await waitFor(() => s.events.some((e) => e.kind === 'frame' && e.frame.index === stuck.index), 'the frame');
    expect(s.contracts().some((e) => e.index === stuck.index)).toBe(false);
    await waitFor(() => s.contracts().some((e) => e.index === stuck.index), 'the stuck check to give up');
    expect(s.contracts().find((e) => e.index === stuck.index)?.contract.status).toBe('not-checked');

    const next = await send(registry, 'c4', '{}');
    await waitFor(() => s.contracts().some((e) => e.index === next.index), 'the next check');
    expect(s.contracts().find((e) => e.index === next.index)?.contract).toEqual({ status: 'ok', message: 'stub' });
    expect(checkers(registry).get('c4')?.spawned).toBeGreaterThanOrEqual(2);
    registry.closeWs('c4');
    await s.done;
  });

  it('closing waits at most one deadline for checks backed up behind a stuck one', async () => {
    const registry = new ExchangeRegistry();
    const s = session(registry, 'c5', Promise.resolve(messages), { workerUrl: hanging, deadlineMs: 400 });
    await waitFor(() => s.events.some((e) => e.kind === 'handshake'), 'the handshake');
    // Each `hang` (and its echo) takes a whole deadline, so the queue holds seconds of work.
    for (let i = 0; i < 6; i += 1) await send(registry, 'c5', 'hang');
    await waitFor(() => s.events.filter((e) => e.kind === 'frame').length >= 12, 'the echoes');
    const started = Date.now();
    registry.closeWs('c5');
    const summary = await s.done;
    expect(Date.now() - started).toBeLessThan(1500);
    const texts = summary.frames.filter((f) => f.opcode === 'text');
    expect(texts).toHaveLength(12);
    expect(texts.every((f) => f.contract?.status === 'not-checked')).toBe(true);
    expect(checkers(registry).size).toBe(0);
  });

  it('quitting (closeAllWs) tears every session’s worker down', async () => {
    const registry = new ExchangeRegistry();
    const a = session(registry, 'q1', Promise.resolve(messages));
    const b = session(registry, 'q2', Promise.resolve(messages));
    await waitFor(() => checkers(registry).size === 2, 'both checkers');
    await waitFor(() => [a, b].every((s) => s.events.some((e) => e.kind === 'handshake')), 'both handshakes');
    await send(registry, 'q1', '{}');
    await send(registry, 'q2', '{}');
    await waitFor(() => [...checkers(registry).values()].every((c) => c.running), 'both workers');
    const held = [...checkers(registry).values()];
    expect(registry.endWhere(() => true, 'websocket')).toBe(2);
    await Promise.all([a.done, b.done]);
    expect(checkers(registry).size).toBe(0);
    expect(held.every((c) => !c.running)).toBe(true);
  });
});
