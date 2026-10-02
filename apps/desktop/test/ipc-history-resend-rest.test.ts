// @vitest-environment node
/**
 * `history.resendRest` end to end in main: an entry recorded by a real send is replayed through
 * the engine (`sendThroughEngine`) against the test server. The resend is a new History entry under the same
 * request, the saved request is left as it was, and a query API key goes out exactly once: the
 * recorded (masked) copy is dropped and auth appends the real key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry } from '@wirebench/engine';
import type { GetSecret, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  buildRestHistoryEntry,
  toHistoryEntryWire,
  type HistoryService,
  type RecordRestSendInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { toSendDeps, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';

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
  return handler({ sender: {} }, payload);
}

let server: TestRestServer;
let other: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
  other = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
  await other.close();
});

/** One API whose key travels in the query, holding request `req-1`: `GET /echo?x=1` with a header. */
function seeded(baseUrl: string): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl,
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [
      createRestRequest('Echo', {
        id: 'req-1',
        url: '/echo',
        query: [entry('x', '1')],
        headers: [entry('X-Trace', 'abc')],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

/**
 * Main's send through the engine over `model`, and a History that builds each entry the way
 * `HistoryService.recordRestSend` does, newest first. `secrets` is the project's keychain, which
 * holds the API key too.
 */
function harness(model: Project, secrets: GetSecret = () => Promise.resolve(undefined)) {
  const engine = new EngineService();
  const entries: HistoryEntryWire[] = [];
  const history = {
    recordRestSend: (projectId: string, record: RecordRestSendInput) => {
      const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
      entries.unshift(wire);
      return Promise.resolve(wire);
    },
    get: (id: string) => entries.find((candidate) => candidate.id === id),
  };
  const keychain: GetSecret = (ref) => (ref === 'sec_key' ? Promise.resolve('good-key') : secrets(ref));
  const requestDeps: RequestChannelDeps = {
    project: {
      projectId: () => 'p1',
      restMeta: () => undefined,
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
    } as unknown as RequestChannelDeps['project'],
    history: history as unknown as HistoryService,
    secretsFor: () => keychain,
  };
  const sendDeps = toSendDeps(engine, requestDeps);
  registerHistoryChannels(history as never, {
    project: { projectId: () => 'p1' },
    send: sendDeps,
  });
  /** A fresh send of `requestId`, as the editor sends it. */
  const send = (sendId: string, requestId: string) =>
    sendThroughEngine(sendDeps, sendId, requestId, { draft: { kind: 'rest' } });
  return { send, entries };
}

describe('history.resendRest against the test server', () => {
  it('appends a new entry under the same request, leaves the request alone and sends the key once', async () => {
    const model = seeded(server.url);
    const before = structuredClone(model);
    const { send, entries } = harness(model);

    await send('first', 'req-1');
    expect(entries).toHaveLength(1);
    const original = entries[0]!;
    expect(original.endpoint).toContain('api_key=%3Credacted%3E');

    const result = await invoke('history.resendRest', { id: original.id });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).not.toBe(original.id);
    expect(entries[0]!.requestId).toBe('req-1');
    expect(entries[1]).toEqual(original);
    expect(model).toEqual(before);
    const last = server.requests.at(-1)!;
    const sent = new URL(last.url, server.url);
    expect(sent.searchParams.getAll('api_key')).toEqual(['good-key']);
    expect(sent.searchParams.getAll('x')).toEqual(['1']);
    expect(last.headers['x-trace']).toBe('abc');
  });

  it('refuses an entry recorded on another origin, sending nothing to either host', async () => {
    const model = seeded(server.url);
    const { send, entries } = harness(model);

    await send('first', 'req-1');
    const original = entries[0]!;

    // Stand in for a redirect this build never saw the tail of: History has no trail of hops, so
    // an entry whose last recorded URL is on a different origin — with a key that leaked there —
    // is all a resend would have to go on if it trusted the recorded URL.
    const leaked: HistoryEntryWire = {
      ...original,
      id: 'leaked',
      endpoint: `${other.url}/echo?api_key=leaked-key&x=1`,
    };
    entries.unshift(leaked);
    const toOther = other.requests.length;
    const toServer = server.requests.length;

    const result = await invoke('history.resendRest', { id: 'leaked' });

    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-origin' } });
    expect(other.requests.length).toBe(toOther);
    expect(server.requests.length).toBe(toServer);
    expect(entries).toHaveLength(2);
  });

  it('sends recorded ${…} text literally: no secret is read and the server gets the text as recorded', async () => {
    const model = seeded(server.url);
    const getSecret = vi.fn((ref: string) => Promise.resolve(ref === 's' ? 'THE-SECRET' : undefined));
    const { send, entries } = harness(model, getSecret);

    await send('first', 'req-1');
    const original = entries[0]!;

    // A same-origin redirect to `/cb?x=${secret:s}` is recorded as it went out: WHATWG keeps `${}`
    // in a query. Header and body text recorded with a `${…}` in it are just as literal.
    const recorded: HistoryEntryWire = {
      ...original,
      id: 'literal',
      method: 'POST',
      endpoint: `${server.url}/echo?x=\${secret:s}&y=\${n}`,
      request: {
        envelopeXml: '{"t":"${secret:s}","u":"$${x}"}',
        headers: [{ name: 'X-Echo', value: 'a ${secret:s} b' }],
      },
    };
    entries.unshift(recorded);

    const result = await invoke('history.resendRest', { id: 'literal' });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(getSecret).not.toHaveBeenCalled();
    const last = server.requests.at(-1)!;
    const sent = new URL(last.url, server.url);
    expect(sent.searchParams.get('x')).toBe('${secret:s}');
    expect(sent.searchParams.get('y')).toBe('${n}');
    expect(last.headers['x-echo']).toBe('a ${secret:s} b');
    expect(last.body.toString('utf8')).toBe('{"t":"${secret:s}","u":"$${x}"}');
  });

  it('reuses the recorded URL, with the real resolver, when the entry stayed on the saved origin', async () => {
    const model = seeded(server.url);
    const { send, entries } = harness(model);

    await send('first', 'req-1');
    const original = entries[0]!;

    // Same origin as the saved request, but a different query value than the saved request has —
    // proving the *recorded* URL is what goes out, not just a fallback to the saved one that
    // happens to look right.
    const edited: HistoryEntryWire = {
      ...original,
      id: 'edited',
      endpoint: original.endpoint.replace('x=1', 'x=2'),
    };
    entries.unshift(edited);

    const result = await invoke('history.resendRest', { id: 'edited' });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    const last = server.requests.at(-1)!;
    const sent = new URL(last.url, server.url);
    expect(sent.pathname).toBe('/echo');
    expect(sent.searchParams.getAll('x')).toEqual(['2']);
    expect(sent.searchParams.getAll('api_key')).toEqual(['good-key']);
  });
});
