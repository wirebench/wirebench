// @vitest-environment node
/**
 * `request.sendRest` streaming a `text/event-stream` response through main: every row arrives as a
 * `rest.live` event before the invoke resolves, the `open` event's headers are redacted the same
 * way the finished summary's are, `request.cancel` ends a stream as a normal completion rather than
 * a failure, and a plain JSON send emits no `rest.live` event at all. `toRestEventStreamWire`'s own
 * cap to `SSE_SUMMARY_LIMITS` is checked directly, since the test server's `/sse/ticks` caps `n` at
 * 1000 — far short of the 5 000-row window that cap keeps.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import type { RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { toRestEventStreamWire } from '../src/main/engine-wire.js';
import { restApiWire } from './helpers/wire-defaults.js';
import type { FailedExchangeWire, RestExchangeSummary, RestLiveEvent } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(
  channel: string,
  payload: unknown,
  sender: unknown = { isDestroyed: () => false, send: () => undefined },
) {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

/** A fake `WebContents` that just collects every event sent to it, by channel name. */
function fakeSender(): {
  sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  events: RestLiveEvent[];
} {
  const events: RestLiveEvent[] = [];
  return {
    sender: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => {
        events.push(payload as RestLiveEvent);
      },
    },
    events,
  };
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Reads `EngineService`'s private `sends` map; test-only, for "the send has registered". */
function hasSend(service: EngineService, sendId: string): boolean {
  return (service as unknown as { sends: Map<string, unknown> }).sends.has(sendId);
}

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

/** A `RestSendResolution`-shaped object aimed at `baseUrl`/`path`, matching the project fakes elsewhere. */
function resolution(baseUrl: string, path: string) {
  const input: RestSendInput = {
    baseUrl,
    request: { method: 'GET', url: path, pathParams: [], query: [], headers: [], body: { kind: 'none' } },
    settings: { timeoutMs: 5_000, followRedirects: true },
  };
  return { input, unresolved: [], api: restApiWire(), request: {}, baseUrlSource: 'api', auth: { type: 'none' } };
}

function project(restSend: (requestId: string) => ReturnType<typeof resolution> | undefined) {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    preflight: () => undefined as never,
    authFor: () => undefined,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    sendInputFor: () => undefined,
    dumpFileFor: () => undefined,
    restSend,
  } as unknown as RequestChannelDeps['project'];
}

function register(
  overrides: Partial<RequestChannelDeps> = {},
  restSend: (requestId: string) => ReturnType<typeof resolution> | undefined,
) {
  const service = new EngineService();
  registerRequestChannels(service, {
    project: project(restSend),
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    ...overrides,
  });
  return service;
}

describe('request.sendRest streaming an event-stream response', () => {
  it('emits every row as a rest.live event before the invoke resolves', async () => {
    register({}, (requestId) =>
      requestId === 'rest-1' ? resolution(server.url, '/sse/ticks?n=3&every=5') : undefined,
    );
    const { sender, events } = fakeSender();

    let resolved = false;
    const sendPromise = invoke('request.sendRest', { sendId: 'r1', requestId: 'rest-1' }, sender).then((result) => {
      resolved = true;
      return result;
    });

    await waitFor(() => events.filter((e) => e.kind === 'row').length === 3, 'all three rows to arrive live');
    // Not resolved yet: the assertion above raced the invoke and won.
    expect(resolved).toBe(false);

    const summary = unwrap<RestExchangeSummary>(await sendPromise);
    expect(resolved).toBe(true);

    expect(events.filter((e) => e.kind === 'open')).toHaveLength(1);
    const openEvent = events.find((e) => e.kind === 'open');
    expect(openEvent).toMatchObject({ status: 200 });

    const rowEvents = events.filter((e): e is Extract<RestLiveEvent, { kind: 'row' }> => e.kind === 'row');
    expect(rowEvents).toHaveLength(3);
    expect(rowEvents.map((e) => e.row)).toEqual(summary.stream?.rows);
    expect(summary.stream?.endedBy).toBe('server');
    expect(summary.stream?.lastEventId).toBe('3');
  });

  it('emits no rest.live event for an ordinary (non-streamed) JSON send', async () => {
    register({}, (requestId) => (requestId === 'rest-1' ? resolution(server.url, '/echo') : undefined));
    const { sender, events } = fakeSender();

    const summary = unwrap<RestExchangeSummary>(
      await invoke('request.sendRest', { sendId: 'r2', requestId: 'rest-1' }, sender),
    );

    expect(events).toHaveLength(0);
    expect(summary.stream).toBeUndefined();
  });

  it('request.cancel on a stream still in flight resolves as a normal completion, never a failure row', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const service = register({ onSendFailed }, (requestId) =>
      requestId === 'rest-1' ? resolution(server.url, '/sse/forever') : undefined,
    );
    const { sender, events } = fakeSender();

    const sendPromise = invoke('request.sendRest', { sendId: 'r3', requestId: 'rest-1' }, sender);
    await waitFor(() => hasSend(service, 'r3'), 'the send to register');
    unwrap(await invoke('request.cancel', { sendId: 'r3' }));

    const summary = unwrap<RestExchangeSummary>(await sendPromise);
    expect(summary.stream?.endedBy).toBe('client');
    expect(onSendFailed).not.toHaveBeenCalled();
    // At least the "open" event made it out before the cancel landed.
    expect(events.some((e) => e.kind === 'open')).toBe(true);
  });

  it("redacts an open event's response headers unless the session shows secrets", async () => {
    let sensitiveServer!: Server;
    const url = await new Promise<string>((resolvePromise) => {
      sensitiveServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'sid=shh-secret' });
        res.end('id: 1\ndata: {"tick":1}\n\n');
      });
      sensitiveServer.listen(0, '127.0.0.1', () => {
        const address = sensitiveServer.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        resolvePromise(`http://127.0.0.1:${port}`);
      });
    });
    try {
      // Hidden (default show-secrets).
      register({}, (requestId) => (requestId === 'rest-1' ? resolution(url, '/') : undefined));
      const hidden = fakeSender();
      unwrap(await invoke('request.sendRest', { sendId: 'r4', requestId: 'rest-1' }, hidden.sender));
      const hiddenOpen = hidden.events.find((e) => e.kind === 'open') as Extract<RestLiveEvent, { kind: 'open' }>;
      expect(hiddenOpen.headers['set-cookie']).toBe('<redacted>');

      // Shown.
      register({ showSecrets: { get: () => true } }, (requestId) =>
        requestId === 'rest-1' ? resolution(url, '/') : undefined,
      );
      const shown = fakeSender();
      unwrap(await invoke('request.sendRest', { sendId: 'r5', requestId: 'rest-1' }, shown.sender));
      const shownOpen = shown.events.find((e) => e.kind === 'open') as Extract<RestLiveEvent, { kind: 'open' }>;
      expect(shownOpen.headers['set-cookie']).toBe('sid=shh-secret');
    } finally {
      await new Promise((resolveClose) => sensitiveServer.close(() => resolveClose(undefined)));
    }
  });
});

describe('a live event that cannot be delivered', () => {
  it('is guarded so an onLive that always throws never affects the stream or the invoke', async () => {
    const service = new EngineService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const summary = await service.sendRestRequest(
        {
          sendId: 'g1',
          requestId: 'req-1',
          input: {
            baseUrl: server.url,
            request: {
              method: 'GET',
              url: '/sse/ticks?n=3&every=5',
              pathParams: [],
              query: [],
              headers: [],
              body: { kind: 'none' },
            },
            settings: { timeoutMs: 5_000, followRedirects: true },
          },
        },
        {
          onLive: () => {
            throw new Error('renderer window is gone');
          },
        },
      );

      expect(summary.stream?.rows).toHaveLength(3);
      expect(summary.stream?.endedBy).toBe('server');
      expect((service as unknown as { sends: Map<string, unknown> }).sends.has('g1')).toBe(false);

      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('g1');
      // The guard logs that delivery failed, never the row/stream data itself.
      expect(logged).not.toContain('tick');
      expect(logged).not.toContain('"data"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a second request.cancel for the same sendId', () => {
  it('is a no-op once the first has already ended the send', async () => {
    const service = register({}, (requestId) =>
      requestId === 'rest-1' ? resolution(server.url, '/sse/forever') : undefined,
    );
    const { sender } = fakeSender();

    const sendPromise = invoke('request.sendRest', { sendId: 'r6', requestId: 'rest-1' }, sender);
    await waitFor(() => hasSend(service, 'r6'), 'the send to register');

    const first = unwrap<{ cancelled: boolean }>(await invoke('request.cancel', { sendId: 'r6' }));
    expect(first).toEqual({ cancelled: true });
    await sendPromise;

    // The entry is gone once the first cancel ended the send: a second one finds nothing to cancel.
    const second = unwrap<{ cancelled: boolean }>(await invoke('request.cancel', { sendId: 'r6' }));
    expect(second).toEqual({ cancelled: false });
  });
});

describe('/sse/drop, a socket torn down mid-stream', () => {
  it('ends with endedBy error, an error message, and never a failure row', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    register({ onSendFailed }, (requestId) =>
      requestId === 'rest-1' ? resolution(server.url, '/sse/drop') : undefined,
    );
    const { sender, events } = fakeSender();

    const summary = unwrap<RestExchangeSummary>(
      await invoke('request.sendRest', { sendId: 'r7', requestId: 'rest-1' }, sender),
    );

    expect(summary.stream?.endedBy).toBe('error');
    expect(summary.stream?.error).toBeDefined();
    expect(onSendFailed).not.toHaveBeenCalled();
    expect(events.filter((e) => e.kind === 'row')).toHaveLength(2);
  });
});

describe('toRestEventStreamWire', () => {
  it("caps a 12 000-row stream's summary to SSE_SUMMARY_LIMITS' 5 000-row window", () => {
    const rows = Array.from({ length: 12_000 }, (_unused, index) => ({
      kind: 'event' as const,
      index,
      at: index,
      size: 10,
      event: 'message',
      data: `${index}`,
      lastEventId: `${index}`,
    }));
    const wire = toRestEventStreamWire({
      rows,
      counts: { events: 12_000, comments: 0, retries: 0, bytes: 120_000 },
      lastEventId: '11999',
      endedBy: 'server',
      droppedRows: 0,
    });

    expect(wire.rows).toHaveLength(5_000);
    expect(wire.truncated).toBe(true);
    expect(wire.omittedRows).toBe(7_000);
  });
});
