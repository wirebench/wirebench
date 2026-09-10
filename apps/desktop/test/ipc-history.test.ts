import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
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

function makeEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T00:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'http://dev.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope/>', headers: [] },
    sizeBytes: 10,
    ...overrides,
  };
}

/** A fake `HistoryService` — only the surface `ipc/history.ts` calls. */
function fakeHistory(entries: HistoryEntryWire[]) {
  return {
    list: vi.fn((query?: { query?: string }) => {
      const filtered =
        query?.query !== undefined
          ? entries.filter((e) => e.requestName.toLowerCase().includes(query.query!.toLowerCase()))
          : entries;
      return { entries: filtered, total: filtered.length };
    }),
    get: vi.fn((id: string) => entries.find((e) => e.id === id)),
    recordSend: vi.fn(() => Promise.resolve(undefined)),
    clear: vi.fn(() => {
      const n = entries.length;
      entries.length = 0;
      return Promise.resolve(n);
    }),
  };
}

describe('registerHistoryChannels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('history.list returns entries and total from the history service', async () => {
    const entries = [makeEntry({ id: 'a', requestName: 'Alpha' }), makeEntry({ id: 'b', requestName: 'Beta' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(new EngineService(), history as never, {
      project: {
        scopesFor: () => ({ project: {}, global: {}, system: {} }),
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => 'proj-1',
      },
    });

    const result = await invoke('history.list', {});
    expect(result).toEqual({ ok: true, value: { entries, total: 2 } });

    const filtered = await invoke('history.list', { query: 'alpha' });
    expect(filtered).toEqual({ ok: true, value: { entries: [entries[0]], total: 1 } });
  });

  it('history.get returns the entry or undefined', async () => {
    const entries = [makeEntry({ id: 'a' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(new EngineService(), history as never, {
      project: {
        scopesFor: () => ({ project: {}, global: {}, system: {} }),
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => 'proj-1',
      },
    });

    expect(await invoke('history.get', { id: 'a' })).toEqual({ ok: true, value: { entry: entries[0] } });
    expect(await invoke('history.get', { id: 'nope' })).toEqual({ ok: true, value: { entry: undefined } });
  });

  it('history.clear empties the store and reports how many were cleared', async () => {
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(new EngineService(), history as never, {
      project: {
        scopesFor: () => ({ project: {}, global: {}, system: {} }),
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => 'proj-1',
      },
    });

    const result = await invoke('history.clear', undefined);
    expect(result).toEqual({ ok: true, value: { cleared: 2 } });
  });

  it('history.resend rejects an unknown id with unknown-history-entry', async () => {
    const history = fakeHistory([]);
    registerHistoryChannels(new EngineService(), history as never, {
      project: {
        scopesFor: () => ({ project: {}, global: {}, system: {} }),
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => 'proj-1',
      },
    });

    const result = await invoke('history.resend', { id: 'missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-history-entry' } });
  });

  it('history.resend sends the entry through the engine using its endpoint and envelope', async () => {
    const entries = [
      makeEntry({
        id: 'a',
        endpoint: 'http://dev.test/resend',
        request: {
          envelopeXml: '<Envelope>resend-me</Envelope>',
          headers: [{ name: 'Authorization', value: '<redacted>' }],
        },
      }),
    ];
    const history = fakeHistory(entries);
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send').mockResolvedValue({
      sendId: 'ignored',
      durationMs: 1,
      http: {
        status: 200,
        statusText: 'OK',
        headers: {},
        rawHeaders: [],
        bodyBase64: '',
        rawBodyBase64: '',
        rawRequestBase64: '',
        rawResponseBase64: '',
        truncated: false,
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
        redirects: [],
        request: { url: 'http://dev.test/resend', method: 'POST', headers: {} },
      },
      problems: [],
    });
    registerHistoryChannels(engine, history as never, {
      project: {
        scopesFor: () => ({ project: {}, global: {}, system: {} }),
        authFor: () => undefined,
        requestMeta: () => undefined,
        projectId: () => 'proj-1',
      },
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [sentRequest] = send.mock.calls[0]!;
    expect(sentRequest.input.endpoint).toBe('http://dev.test/resend');
    expect(sentRequest.input.envelopeXml).toBe('<Envelope>resend-me</Envelope>');
    // A `<redacted>` header must never be resent verbatim.
    expect(sentRequest.input.headers).toEqual({});
  });
});
