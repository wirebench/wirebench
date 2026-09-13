// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCHANGE_CACHE_CAP, ExchangeCache } from '../src/main/exchange-cache.js';
import { registerExchangeChannels } from '../src/main/ipc/exchanges.js';
import { ShowSecretsFlag } from '../src/main/secrets.js';
import type { ExchangeSummary, RestExchangeSummary } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

/** The native Save-as dialog, stubbed: the channel must be the thing that chooses nothing itself. */
const showSaveDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  dialog: {
    showSaveDialog: (...args: unknown[]): unknown => showSaveDialog(...args) as unknown,
  },
  BrowserWindow: { fromWebContents: () => undefined },
  shell: { openPath: () => Promise.resolve('') },
  app: { getPath: () => '/tmp' },
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
      httpVersion: '1.1',
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

/**
 * Saving a REST response body.
 *
 * The channel takes a send id and nothing else, for the reason `attachments.saveResponse` does: these
 * are bytes a remote server sent, so the file they land in is chosen by the *user*. The test pins the
 * two halves of that — the write goes where the dialog said, and the bytes are the cached ones.
 */
describe('exchanges.saveRestBody', () => {
  const restExchange = (sendId: string): RestExchangeSummary => ({
    sendId,
    durationMs: 5,
    url: 'https://api.test/pet/1',
    method: 'GET',
    text: '{"id":1}',
    language: 'json',
    cookies: [],
    methodChanged: false,
    problems: [],
    http: { ...unredactedExchange(sendId).http, headers: { 'content-type': 'application/json' } },
  });

  let dir: string;

  beforeEach(() => {
    handlers.clear();
    dir = mkdtempSync(join(tmpdir(), 'wirebench-save-rest-'));
    delete process.env['WIREBENCH_E2E_SAVE_PATH'];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['WIREBENCH_E2E_SAVE_PATH'];
    showSaveDialog.mockReset();
  });

  it('writes the cached bytes to the file the dialog returned', async () => {
    const target = join(dir, 'picked.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    const cache = new ExchangeCache();
    cache.putRest('send-1', restExchange('send-1'), new TextEncoder().encode('{"id":1}'));
    registerExchangeChannels(cache, new ShowSecretsFlag());

    const result = await invoke('exchanges.saveRestBody', { sendId: 'send-1' });

    expect(result).toMatchObject({ ok: true, value: { path: target } });
    expect(readFileSync(target, 'utf8')).toBe('{"id":1}');
    // The default name carries the extension the content type implies, so the OS can open it.
    expect(showSaveDialog.mock.calls[0]?.[1]).toMatchObject({ defaultPath: 'response.json' });
  });

  it('writes nothing when the user cancels', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });
    const cache = new ExchangeCache();
    cache.putRest('send-1', restExchange('send-1'), new TextEncoder().encode('{}'));
    registerExchangeChannels(cache, new ShowSecretsFlag());

    expect(await invoke('exchanges.saveRestBody', { sendId: 'send-1' })).toMatchObject({
      ok: true,
      value: { cancelled: true },
    });
  });

  it('answers unknown-send for an exchange the cache has evicted', async () => {
    registerExchangeChannels(new ExchangeCache(), new ShowSecretsFlag());

    expect(await invoke('exchanges.saveRestBody', { sendId: 'gone' })).toMatchObject({
      ok: false,
      error: { code: 'unknown-send' },
    });
  });

  it('takes no path from the renderer: an extra field is rejected outright', async () => {
    registerExchangeChannels(new ExchangeCache(), new ShowSecretsFlag());

    // The schema is strict, so a renderer cannot smuggle a target past it.
    expect(await invoke('exchanges.saveRestBody', {})).toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
  });
});
