/**
 * The server host's `HostOptions.server.send` (hosted edition spec §17.3): a call the host makes to this
 * server runs through `app.inject`, the whole route pipeline and no socket, as the user whose device token
 * the instance holds now. Only the tenant's URL is reachable; the host holds its transport to it already,
 * and this side refuses any other on its own. Each call carries that URL's `Host`, so that in hosted mode
 * it resolves to the same tenant (spec §19.5); self-hosted mode never reads it.
 *
 * The answer comes back in the shape `sendHttp` gives. Only what the host's `ServerClient` reads carries
 * meaning: the status, the lower-cased headers and the body. There is no wire behind it, so the raw views
 * are empty and the timings are a start time and a duration.
 */
import { WirebenchError, type HttpExchange, type HttpRequest } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';

/**
 * Request headers the host may not set: the session is the credential's, never a cookie or a caller's,
 * and the address is the socket's, never a forwarding header (which `trustProxy` would believe).
 */
const DROPPED = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A `401` body that says the token itself is no longer a session. */
function refusedSession(body: string): boolean {
  try {
    return (JSON.parse(body) as { code?: unknown }).code === 'identity-unauthenticated';
  } catch {
    return false;
  }
}

/**
 * @param session the instance's current token and its id, and the address of the socket it came from:
 *   the call reaches the routes from there, so it is audited and rate-limited as the browser's, not as
 *   the server's own loopback
 * @param onRefused told the token's id when the server answered `identity-unauthenticated` for it: the
 *   session expired or was revoked without an announcement reaching this side first
 */
export function injectSend(
  app: Pick<FastifyInstance, 'inject'>,
  serverUrl: string,
  session: () => { readonly token: string; readonly tokenId: string; readonly ip?: string } | undefined,
  onRefused: (tokenId: string) => void,
): (request: HttpRequest) => Promise<HttpExchange> {
  return async (request) => {
    if (originOf(request.url) !== serverUrl) {
      throw new WirebenchError('server-url-invalid', `This host reaches ${serverUrl} only`);
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
    headers.host = target.host;
    const startedAt = new Date();
    const started = performance.now();
    const response = await app.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      ...(current?.ip !== undefined ? { remoteAddress: current.ip } : {}),
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
