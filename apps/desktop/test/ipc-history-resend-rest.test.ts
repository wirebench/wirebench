// @vitest-environment node
/**
 * `history.resendRest` end to end in main: an entry recorded by a real send is replayed through
 * `sendRestRequest` against the test server. The resend is a new History entry under the same
 * request, the saved request is left as it was, and a query API key goes out exactly once: the
 * recorded (masked) copy is dropped and auth appends the real key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry, resolveApiBaseUrl } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  buildRestHistoryEntry,
  toHistoryEntryWire,
  type HistoryService,
  type RecordRestSendInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { sendRestRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { resolveRestSend } from '../src/main/rest-send.js';
import type { HistoryEntryWire, RestRequestPatchWire } from '../src/shared/wire-types.js';

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
 * Main's REST send path over `model`: the real resolver and sender, and a History that builds each
 * entry the way `HistoryService.recordRestSend` does, newest first.
 */
function harness(model: Project) {
  const engine = new EngineService((ref) => Promise.resolve(ref === 'sec_key' ? 'good-key' : undefined));
  const entries: HistoryEntryWire[] = [];
  const history = {
    recordRestSend: (projectId: string, record: RecordRestSendInput) => {
      const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
      entries.unshift(wire);
      return Promise.resolve(wire);
    },
    get: (id: string) => entries.find((candidate) => candidate.id === id),
  };
  const restSend = (requestId: string, draft?: RestRequestPatchWire) =>
    resolveRestSend({
      project: model,
      requestId,
      ...(draft !== undefined ? { draft } : {}),
      scopes: { project: {}, global: {}, system: {} },
      resolveBaseUrl: (api) => resolveApiBaseUrl(model, undefined, api),
    });
  const requestDeps: RequestChannelDeps = {
    project: { projectId: () => 'p1', restSend } as unknown as RequestChannelDeps['project'],
    history: history as unknown as HistoryService,
  };
  registerHistoryChannels(engine, history as never, {
    project: {
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
      authFor: () => undefined,
      requestMeta: () => undefined,
      projectId: () => 'p1',
      buildLiveSendInput: () => undefined,
      restSend,
    },
    rest: { send: (request) => sendRestRequest(engine, requestDeps, request) },
  });
  return { engine, requestDeps, entries };
}

describe('history.resendRest against the test server', () => {
  it('appends a new entry under the same request, leaves the request alone and sends the key once', async () => {
    const model = seeded(server.url);
    const before = structuredClone(model);
    const { engine, requestDeps, entries } = harness(model);

    await sendRestRequest(engine, requestDeps, { sendId: 'first', requestId: 'req-1' });
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

  it('never sends the saved key to another origin, even when the entry records one recorded there', async () => {
    const model = seeded(server.url);
    const { engine, requestDeps, entries } = harness(model);

    await sendRestRequest(engine, requestDeps, { sendId: 'first', requestId: 'req-1' });
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
    const before = other.requests.length;

    const result = await invoke('history.resendRest', { id: 'leaked' });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    // The other origin was never contacted at all.
    expect(other.requests.length).toBe(before);
    // The real send landed on the saved request's own origin and path, with the real key.
    const last = server.requests.at(-1)!;
    const sent = new URL(last.url, server.url);
    expect(sent.pathname).toBe('/echo');
    expect(sent.searchParams.getAll('api_key')).toEqual(['good-key']);
    expect(sent.searchParams.getAll('x')).toEqual(['1']);
  });
});
