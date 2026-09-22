/**
 * The transport's opt-in stream hook: an accepted response hands its body over as it arrives.
 *
 * Every sink records whether `sendHttp` had already resolved when a chunk reached it, so "the bytes
 * arrived before the call ended" is a fact about ordering, not a guess about timing. Waits are
 * bounded polls against a deadline, never sleeps standing in for an assertion.
 */
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { sendHttp } from '../../../src/http/client.js';
import type { HttpExchange, HttpRequest, HttpStreamHook } from '../../../src/http/types.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

function req(path: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url: `${server.url}${path}`,
    method: 'GET',
    headers: {},
    timeoutMs: 2000,
    followRedirects: true,
    ...overrides,
  };
}

interface Recorder {
  readonly hook: HttpStreamHook;
  readonly chunks: { readonly text: string; readonly afterResolve: boolean }[];
  readonly accepted: { status: number; headers: Readonly<Record<string, string>> }[];
  text(): string;
  markResolved(): void;
}

function recorder(): Recorder {
  let resolved = false;
  const chunks: { text: string; afterResolve: boolean }[] = [];
  const accepted: { status: number; headers: Readonly<Record<string, string>> }[] = [];
  const decoder = new TextDecoder();
  return {
    hook: {
      accept(status, headers) {
        accepted.push({ status, headers });
        return {
          onChunk: (bytes) => chunks.push({ text: decoder.decode(bytes, { stream: true }), afterResolve: resolved }),
        };
      },
    },
    chunks,
    accepted,
    text: () => chunks.map((c) => c.text).join(''),
    markResolved: () => {
      resolved = true;
    },
  };
}

async function until(condition: () => boolean, deadlineMs = 3000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function send(request: HttpRequest, rec: Recorder): Promise<HttpExchange> {
  const exchange = await sendHttp(request);
  rec.markResolved();
  return exchange;
}

/**
 * An exchange ready to compare with another send of the same request: its timings dropped, and the
 * server's `Date` header left out wherever it appears. Two sends can straddle a second, so the date
 * is the one header that may differ; every other header and byte is still compared.
 */
function comparable(exchange: HttpExchange): Record<string, unknown> {
  const isDate = (name: string): boolean => name.toLowerCase() === 'date';
  const raw = Buffer.from(exchange.rawResponse).toString('latin1');
  const end = raw.indexOf('\r\n\r\n');
  const head = end === -1 ? raw : raw.slice(0, end);
  const rawResponse = head.replace(/\r\ndate:[^\r]*/gi, '') + (end === -1 ? '' : raw.slice(end));
  return {
    ...exchange,
    timings: null,
    headers: Object.fromEntries(Object.entries(exchange.headers).filter(([name]) => !isDate(name))),
    rawHeaders: exchange.rawHeaders.filter(([name]) => !isDate(name)),
    rawResponse,
  };
}

describe('sendHttp stream hook', () => {
  it('hands chunks to the sink before the send resolves, and ends by the server', async () => {
    const rec = recorder();
    const exchange = await send(req('/sse/ticks?n=3&every=20', { stream: rec.hook }), rec);
    expect(rec.accepted).toHaveLength(1);
    expect(rec.accepted[0]?.status).toBe(200);
    expect(rec.accepted[0]?.headers['content-type']).toBe('text/event-stream');
    expect(rec.chunks.length).toBeGreaterThan(0);
    expect(rec.chunks.every((c) => !c.afterResolve)).toBe(true);
    expect(rec.text()).toBe('id: 1\ndata: {"tick":1}\n\nid: 2\ndata: {"tick":2}\n\nid: 3\ndata: {"tick":3}\n\n');
    expect(exchange.streamEnd).toEqual({ by: 'server' });
    expect(exchange.body.length).toBe(0);
    expect(exchange.rawBody.length).toBe(0);
    const raw = Buffer.from(exchange.rawResponse).toString('utf8');
    expect(raw.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
    expect(raw.endsWith('\r\n\r\n')).toBe(true);
  });

  it('outlives the request timeout once accepted, and a client abort ends it', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const started = Date.now();
    const pending = send(req('/sse/forever', { stream: rec.hook, timeoutMs: 200, signal: controller.signal }), rec);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Keep-alive comments are still arriving well past the 200 ms deadline.
    await until(() => Date.now() - started >= 600 && rec.chunks.length > 0);
    const countAt600 = rec.chunks.length;
    await until(() => rec.chunks.length > countAt600);
    expect(settled).toBe(false);
    controller.abort();
    const exchange = await pending;
    expect(exchange.streamEnd?.by).toBe('client');
    expect(exchange.body.length).toBe(0);
    expect(rec.text()).toContain(': keep-alive\n\n');
  });

  it('ends by error when the connection drops mid-stream', async () => {
    const rec = recorder();
    const exchange = await send(req('/sse/drop', { stream: rec.hook }), rec);
    expect(exchange.streamEnd?.by).toBe('error');
    expect(typeof exchange.streamEnd?.error).toBe('string');
    expect(rec.text()).toContain('data: {"tick":2}');
  });

  it('hands over decompressed text for a gzip-encoded stream', async () => {
    const rec = recorder();
    const exchange = await send(req('/sse/gzip?n=3&every=20', { stream: rec.hook }), rec);
    expect(rec.text()).toBe('id: 1\ndata: {"tick":1}\n\nid: 2\ndata: {"tick":2}\n\nid: 3\ndata: {"tick":3}\n\n');
    expect(rec.chunks.every((c) => !c.afterResolve)).toBe(true);
    expect(exchange.streamEnd).toEqual({ by: 'server' });
    expect(exchange.headers['content-encoding']).toBe('gzip');
  });

  it('still times out when the headers are late', async () => {
    const rec = recorder();
    const error = await sendHttp(req('/sse/slow-headers', { stream: rec.hook, timeoutMs: 100 })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('timeout');
    expect(rec.accepted).toHaveLength(0);
  });

  it('still throws aborted when aborted before the headers', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const pending = sendHttp(req('/sse/slow-headers', { stream: rec.hook, signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('aborted');
    expect(rec.accepted).toHaveLength(0);
  });

  it.each(['/status/200', '/gzip', '/chunked', '/redirect/302?to=/status/201'])(
    'leaves %s exactly as today when the hook declines or is absent',
    async (path) => {
      let asked = 0;
      const declining: HttpStreamHook = {
        accept: () => {
          asked += 1;
          return undefined;
        },
      };
      // A fresh connection each, so both compared sends go through the same phases and their
      // timings differ only in their numbers.
      const send = async (request: HttpRequest): Promise<HttpExchange> => {
        const dispatcher = new Agent();
        try {
          return await sendHttp(request, { dispatcher });
        } finally {
          await dispatcher.destroy();
        }
      };
      const today = await send(req(path));
      const declined = await send(req(path, { stream: declining }));
      expect(asked).toBe(1);
      expect(comparable(declined)).toEqual(comparable(today));
      expect(declined.streamEnd).toBeUndefined();
      expect(Object.keys(declined.timings).sort()).toEqual(Object.keys(today.timings).sort());
    },
  );

  it('compares two sends that differ only in their Date header as equal, and nothing else', () => {
    const at = (date: string, body = 'ok'): HttpExchange => {
      const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nDate: ${date}\r\n\r\n${body}`;
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain', date },
        rawHeaders: [
          ['Content-Type', 'text/plain'],
          ['Date', date],
        ],
        rawResponse: new Uint8Array(Buffer.from(raw, 'latin1')),
      } as unknown as HttpExchange;
    };
    const first = at('Tue, 22 Sep 2026 19:54:02 GMT');
    expect(comparable(at('Tue, 22 Sep 2026 19:54:03 GMT'))).toEqual(comparable(first));
    // A `date:` in the body is a byte of the body, not a header.
    expect(comparable(at('Tue, 22 Sep 2026 19:54:03 GMT', 'x\r\ndate: y'))).not.toEqual(
      comparable(at('Tue, 22 Sep 2026 19:54:02 GMT', 'x\r\ndate: z')),
    );
    expect(comparable(at('Tue, 22 Sep 2026 19:54:02 GMT', 'changed'))).not.toEqual(comparable(first));
    const other = at('Tue, 22 Sep 2026 19:54:02 GMT');
    expect(comparable({ ...other, headers: { ...other.headers, 'content-type': 'text/html' } })).not.toEqual(
      comparable(first),
    );
  });

  it('is asked only for the final response, not a redirect', async () => {
    const statuses: number[] = [];
    await sendHttp(req('/redirect/302?to=/status/200', { stream: { accept: (s) => void statuses.push(s) } }));
    expect(statuses).toEqual([200]);
  });

  it('rejects when accept throws, and leaves no connection checked out', async () => {
    // One connection per origin: a socket the failed send kept would starve the next one.
    const dispatcher = new Agent({ connections: 1 });
    const error = await sendHttp(
      req('/sse/forever', {
        stream: {
          accept: () => {
            throw new Error('hook failed');
          },
        },
      }),
      { dispatcher },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain('hook failed');
    const next = await sendHttp(req('/status/200', { timeoutMs: 1000 }), { dispatcher });
    expect(next.status).toBe(200);
    await dispatcher.destroy();
  });

  it('ends by error when onChunk throws, and leaves no connection checked out', async () => {
    const dispatcher = new Agent({ connections: 1 });
    const exchange = await sendHttp(
      req('/sse/forever', {
        stream: {
          accept: () => ({
            onChunk: () => {
              throw new Error('sink failed');
            },
          }),
        },
      }),
      { dispatcher },
    );
    expect(exchange.streamEnd).toEqual({ by: 'error', error: 'sink failed' });
    const next = await sendHttp(req('/status/200', { timeoutMs: 1000 }), { dispatcher });
    expect(next.status).toBe(200);
    await dispatcher.destroy();
  });
});
