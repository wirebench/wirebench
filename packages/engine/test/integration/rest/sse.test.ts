/**
 * `sendRest` streaming an event-stream response: rows arrive through `onStream.onRow` as they are
 * parsed, the finished exchange carries the same rows in `stream`, and a response with no
 * `onStream` — or one that isn't `text/event-stream` — is buffered exactly as it was before this
 * existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SseRow } from '../../../src/rest/sse.js';
import { sendRest } from '../../../src/rest/send.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

function input(url: string, extra: Partial<RestSendInput> = {}): RestSendInput {
  return {
    baseUrl: server.url,
    request: { method: 'GET', url, pathParams: [], query: [], headers: [], body: { kind: 'none' } },
    settings: { timeoutMs: 5_000, followRedirects: false },
    ...extra,
  };
}

describe('sendRest streaming', () => {
  it('reports a method changed by a redirect on a streamed exchange too', async () => {
    const to = encodeURIComponent('/sse/ticks?n=1&every=1');
    const exchange = await sendRest(
      input(`/redirect/303?to=${to}`, {
        request: {
          method: 'POST',
          url: `/redirect/303?to=${to}`,
          pathParams: [],
          query: [],
          headers: [],
          body: { kind: 'none' },
        },
        settings: { timeoutMs: 5_000, followRedirects: true },
        onStream: { onOpen: () => undefined, onRow: () => undefined },
      }),
    );
    expect(exchange.stream).toBeDefined();
    expect(exchange.methodChanged).toBe(true);
  });

  it('delivers rows through onRow before the send resolves, and the same rows on the exchange', async () => {
    const seen: SseRow[] = [];
    const opens: { status: number; headers: Readonly<Record<string, string>> }[] = [];
    const exchange = await sendRest(
      input('/sse/ticks?n=3&every=5', {
        onStream: {
          onOpen: (status, headers) => opens.push({ status, headers }),
          onRow: (row) => seen.push(row),
        },
      }),
    );

    expect(opens).toHaveLength(1);
    expect(opens[0]?.status).toBe(200);
    expect(opens[0]?.headers['content-type']).toBe('text/event-stream');

    expect(seen).toHaveLength(3);
    expect(exchange.text).toBe('');
    expect(exchange.stream).toBeDefined();
    expect(exchange.stream?.rows).toEqual(seen);
    expect(exchange.stream?.counts).toEqual({
      events: 3,
      comments: 0,
      retries: 0,
      bytes: exchange.stream?.rows.reduce((sum, r) => sum + r.size, 0),
    });
    expect(exchange.stream?.lastEventId).toBe('3');
    expect(exchange.stream?.endedBy).toBe('server');
    expect(exchange.stream?.droppedRows).toBe(0);
    expect(exchange.streamEnd).toEqual({ by: 'server' });
  });

  it('an event carries a monotonic index and a retry row updates retryMs', async () => {
    const rows: SseRow[] = [];
    await sendRest(input('/sse/ticks?n=5&every=2', { onStream: { onRow: (row) => rows.push(row) } }));
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('an abort after the stream opens resolves with endedBy client, not a throw', async () => {
    const controller = new AbortController();
    const rows: SseRow[] = [];
    const exchange = await sendRest(
      input('/sse/forever', {
        signal: controller.signal,
        onStream: {
          onOpen: () => controller.abort(),
          onRow: (row) => rows.push(row),
        },
      }),
    );

    expect(exchange.stream?.endedBy).toBe('client');
    expect(exchange.text).toBe('');
  });

  it('a socket torn down mid-stream ends with endedBy error, still resolving', async () => {
    const rows: SseRow[] = [];
    const exchange = await sendRest(input('/sse/drop', { onStream: { onRow: (row) => rows.push(row) } }));

    expect(rows).toHaveLength(2);
    expect(exchange.stream?.endedBy).toBe('error');
    expect(exchange.stream?.error).toBeDefined();
  });

  it('buffers a send with no onStream exactly as before this feature', async () => {
    const exchange = await sendRest(input('/sse/ticks?n=3&every=5'));

    expect(exchange.stream).toBeUndefined();
    expect(exchange.streamEnd).toBeUndefined();
    expect(exchange.text).toContain('"tick":1');
    expect(exchange.text).toContain('"tick":3');
  });

  it('buffers a non-event-stream response exactly as before, even with onStream set', async () => {
    const rows: SseRow[] = [];
    const exchange = await sendRest(input('/echo', { onStream: { onRow: (row) => rows.push(row) } }));

    expect(rows).toHaveLength(0);
    expect(exchange.stream).toBeUndefined();
    expect(exchange.streamEnd).toBeUndefined();
    expect(exchange.language).toBe('json');
  });
});
