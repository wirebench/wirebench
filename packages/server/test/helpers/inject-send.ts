/**
 * A `ServerClient` `send` that answers through `app.inject`, so the desktop's own client — and the
 * `ServerBackend` over it — talks to an in-process server with no socket and no port (server-sync
 * spec §11, O4). The request goes in as the client built it: method, path and query, headers, body.
 * The answer comes back in the shape `sendHttp` gives. Only what `ServerClient` reads carries meaning
 * here: the status, the lower-cased headers and the body bytes. The wire-level fields (raw request
 * and response, timings, TLS) have no socket behind them and are left empty.
 */
import type { FastifyInstance } from 'fastify';
import type { HttpExchange, HttpRequest } from '@wirebench/engine';

export function injectSend(app: FastifyInstance): (request: HttpRequest) => Promise<HttpExchange> {
  return async (request) => {
    const target = new URL(request.url);
    const response = await app.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      headers: { ...request.headers },
      ...(request.body !== undefined ? { payload: Buffer.from(request.body) } : {}),
    });
    const headers: Record<string, string> = {};
    const rawHeaders: (readonly [string, string])[] = [];
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) {
        continue;
      }
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      const key = name.toLowerCase();
      // `HttpExchange.headers`' rule: multi-values joined with ', ', except `set-cookie` (the first).
      headers[key] = key === 'set-cookie' ? (values[0] ?? '') : values.join(', ');
      for (const one of values) {
        rawHeaders.push([key, one]);
      }
    }
    const body = new Uint8Array(response.rawPayload);
    return {
      request: { url: request.url, method: request.method, headers: { ...request.headers } },
      status: response.statusCode,
      statusText: response.statusMessage,
      headers,
      rawHeaders,
      body,
      rawBody: body,
      httpVersion: '1.1',
      truncated: false,
      timings: { startedAt: new Date().toISOString(), totalMs: 0 },
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      redirects: [],
    };
  };
}
