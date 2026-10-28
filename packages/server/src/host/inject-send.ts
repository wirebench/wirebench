/**
 * The server host's `HostOptions.server.send` (hosted edition spec §17.3): a call the host makes to this
 * server runs through `app.inject`, the whole route pipeline and no socket, as the user whose device token
 * the instance holds now. Only `publicUrl`'s origin is reachable; the host holds its transport to it
 * already, and this side refuses any other on its own.
 *
 * The answer comes back in the shape `sendHttp` gives. Only what the host's `ServerClient` reads carries
 * meaning: the status, the lower-cased headers and the body. There is no wire behind it, so the raw views
 * are empty and the timings are a start time and a duration.
 */
import { WirebenchError, type HttpExchange, type HttpRequest } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';

/** Request headers the host may not set: the session is the credential's, never a cookie or a caller's. */
const DROPPED = new Set(['authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding']);

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * @param session the instance's current token and its id
 * @param onRefused told the token's id when the server answered `identity-unauthenticated` for it: the
 *   session expired or was revoked without an announcement reaching this side first
 */
/** A `401` body that says the token itself is no longer a session. */
function refusedSession(body: string): boolean {
  try {
    return (JSON.parse(body) as { code?: unknown }).code === 'identity-unauthenticated';
  } catch {
    return false;
  }
}

export function injectSend(
  app: Pick<FastifyInstance, 'inject'>,
  publicUrl: string,
  session: () => { readonly token: string; readonly tokenId: string } | undefined,
  onRefused: (tokenId: string) => void,
): (request: HttpRequest) => Promise<HttpExchange> {
  return async (request) => {
    if (originOf(request.url) !== publicUrl) {
      throw new WirebenchError('server-url-invalid', `This host reaches ${publicUrl} only`);
    }
    const target = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!DROPPED.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    // What the exchange reports as sent: never the token.
    const sent = { ...headers };
    const current = session();
    if (current !== undefined) headers.authorization = `Bearer ${current.token}`;
    const startedAt = new Date();
    const started = performance.now();
    const response = await app.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      headers,
      ...(request.body !== undefined ? { payload: Buffer.from(request.body) } : {}),
    });
    if (current !== undefined && response.statusCode === 401 && refusedSession(response.body)) {
      onRefused(current.tokenId);
    }
    const answered: Record<string, string> = {};
    const rawHeaders: (readonly [string, string])[] = [];
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      const key = name.toLowerCase();
      // `HttpExchange.headers`' rule: multi-values joined with ', ', except `set-cookie` (the first).
      answered[key] = key === 'set-cookie' ? (values[0] ?? '') : values.join(', ');
      for (const one of values) rawHeaders.push([key, one]);
    }
    const body = new Uint8Array(response.rawPayload);
    return {
      request: { url: request.url, method: request.method, headers: sent },
      status: response.statusCode,
      statusText: response.statusMessage,
      headers: answered,
      rawHeaders,
      body,
      rawBody: body,
      httpVersion: '1.1',
      truncated: false,
      timings: { startedAt: startedAt.toISOString(), totalMs: performance.now() - started },
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      redirects: [],
    };
  };
}
