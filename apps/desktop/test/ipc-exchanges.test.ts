// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCHANGE_CACHE_CAP, ExchangeCache } from '../src/main/exchange-cache.js';
import { registerExchangeChannels } from '../src/main/ipc/exchanges.js';
import { ShowSecretsFlag } from '../src/main/secrets.js';
import type { ExchangeSummary } from '../src/shared/wire-types.js';

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

const AUTH = 'Basic YWxpY2U6czNjcmV0IQ==';

function unredactedExchange(sendId: string): ExchangeSummary {
  const rawRequest = `POST /soap HTTP/1.1\r\nAuthorization: ${AUTH}\r\nHost: x\r\n\r\n<a/>`;
  return {
    sendId,
    durationMs: 3,
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'set-cookie': 'sid=abc' },
      rawHeaders: [['Set-Cookie', 'sid=abc']],
      bodyBase64: '',
      rawBodyBase64: '',
      rawRequestBase64: Buffer.from(rawRequest, 'utf8').toString('base64'),
      rawResponseBase64: Buffer.from('HTTP/1.1 200 OK\r\n\r\n<a/>', 'utf8').toString('base64'),
      truncated: false,
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 3 },
      redirects: [],
      request: { url: 'http://dev.test/soap', method: 'POST', headers: { Authorization: AUTH } },
    },
    problems: [],
  };
}

describe('ExchangeCache', () => {
  it('evicts the oldest entry past its cap', () => {
    const cache = new ExchangeCache(2);
    cache.put('a', unredactedExchange('a'));
    cache.put('b', unredactedExchange('b'));
    cache.put('c', unredactedExchange('c'));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.sendId).toBe('b');
    expect(cache.get('c')?.sendId).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('defaults to a 500-entry cap, matching the renderer log', () => {
    expect(EXCHANGE_CACHE_CAP).toBe(500);
  });

  it('keeps the response attachment bytes alongside the summary, evicted with it', () => {
    const cache = new ExchangeCache(1);
    const part = {
      contentId: 'part1@wirebench',
      contentType: 'image/png',
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
      name: 'logo.png',
    };
    cache.put('a', unredactedExchange('a'), [part]);

    expect(cache.getAttachment('a', 0)).toEqual(part);
    expect(cache.getAttachment('a', 1)).toBeUndefined();

    cache.put('b', unredactedExchange('b'));
    expect(cache.getAttachment('a', 0)).toBeUndefined();
    expect(cache.getAttachment('b', 0)).toBeUndefined();
  });
});

describe('exchanges.get', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('redacts per the show-secrets flag as it stands at call time', async () => {
    const cache = new ExchangeCache();
    cache.put('send-1', unredactedExchange('send-1'));
    const flag = new ShowSecretsFlag();
    registerExchangeChannels(cache, flag);

    const hidden = (await invoke('exchanges.get', { sendId: 'send-1' })) as {
      ok: true;
      value: ExchangeSummary;
    };
    expect(hidden.ok).toBe(true);
    expect(hidden.value.http.request.headers['Authorization']).toBe('<redacted>');
    expect(hidden.value.http.rawHeaders).toEqual([['Set-Cookie', '<redacted>']]);
    expect(JSON.stringify(hidden.value)).not.toContain('sid=abc');

    // Flipping the flag makes the *same cached* exchange resolve unredacted — the point of
    // caching it in main rather than redacting once, at send time, and forgetting the rest.
    flag.set(true);
    const shown = (await invoke('exchanges.get', { sendId: 'send-1' })) as { ok: true; value: ExchangeSummary };
    expect(shown.value.http.request.headers['Authorization']).toBe(AUTH);
    expect(Buffer.from(shown.value.http.rawRequestBase64, 'base64').toString('utf8')).toContain(AUTH);
  });

  it('answers unknown-send for an evicted or unknown sendId', async () => {
    registerExchangeChannels(new ExchangeCache(), new ShowSecretsFlag());

    expect(await invoke('exchanges.get', { sendId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'unknown-send' },
    });
  });

  it('rejects a malformed payload', async () => {
    registerExchangeChannels(new ExchangeCache(), new ShowSecretsFlag());

    expect(await invoke('exchanges.get', {})).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });
});
