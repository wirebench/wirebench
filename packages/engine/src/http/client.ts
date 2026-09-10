import { Agent, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import { decompressBody } from './decompress.js';
import { invalidUrlError, toHttpError, tooManyRedirectsError } from './errors.js';
import { buildRawRequest, buildRawResponse } from './raw-capture.js';
import { TimingTracker } from './timings.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from './types.js';

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Standard reason phrases, used when undici doesn't surface one for us. */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusText(status: number): string {
  return REASON_PHRASES[status] ?? '';
}

/** A lazily-created, shared keep-alive Agent for requests with no custom TLS/proxy options. */
let defaultAgent: Agent | undefined;
function getDefaultAgent(): Agent {
  defaultAgent ??= new Agent({ keepAliveTimeout: 4000, keepAliveMaxTimeout: 10000 });
  return defaultAgent;
}

/**
 * Builds a dispatcher for the given TLS/proxy options. Callers that pass
 * custom `tls`/`proxy` own the returned dispatcher (it is not cached) and
 * should close it when done; callers with no options get the shared default
 * keep-alive agent.
 */
export function createDispatcher(opts: {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly keepAlive?: boolean;
}): Dispatcher {
  if (opts.proxy !== undefined) {
    const proxy = opts.proxy;
    return new ProxyAgent({
      uri: proxy.url,
      ...(proxy.auth !== undefined
        ? { token: `Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}` }
        : {}),
      ...(opts.tls !== undefined ? { connect: tlsConnectOptions(opts.tls) } : {}),
    });
  }
  if (opts.tls !== undefined) {
    return new Agent({ connect: tlsConnectOptions(opts.tls) });
  }
  return getDefaultAgent();
}

function tlsConnectOptions(tls: TlsOptions): Record<string, unknown> {
  return {
    rejectUnauthorized: tls.rejectUnauthorized,
    ca: tls.ca !== undefined ? [...tls.ca] : undefined,
    cert: tls.cert,
    key: tls.key,
    passphrase: tls.passphrase,
    minVersion: tls.minVersion,
    servername: tls.servername,
  };
}

/** Headers dropped when a redirect crosses an origin, per fetch/undici's credential-scoping semantics. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/** Origin as scheme + host + port (host already includes a non-default port). */
function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/** Drops credential headers (case-insensitive) when moving to a different origin. */
function scopeHeadersToOrigin(headers: Record<string, string>, fromUrl: URL, toUrl: URL): Record<string, string> {
  if (originOf(fromUrl) === originOf(toUrl)) return headers;
  const scoped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
    scoped[name] = value;
  }
  return scoped;
}

/** Joins undici's raw header shape (string | string[] per name) into our lower-cased map. */
function joinHeaders(raw: Record<string, string | string[] | undefined>): {
  headers: Record<string, string>;
  rawHeaders: [string, string][];
} {
  const headers: Record<string, string> = {};
  const rawHeaders: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (Array.isArray(value)) {
      for (const v of value) rawHeaders.push([lower, v]);
      headers[lower] = lower === 'set-cookie' ? (value[0] ?? '') : value.join(', ');
    } else {
      rawHeaders.push([lower, value]);
      headers[lower] = value;
    }
  }
  return { headers, rawHeaders };
}

/** Builds the header set as it will be sent, including the `Host` and `Content-Length` undici adds implicitly. */
function buildFinalHeaders(req: HttpRequest, url: URL, body: Uint8Array | undefined): Record<string, string> {
  const final: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(req.headers)) {
    final[name] = value;
  }
  if (body !== undefined) final['content-length'] = String(body.length);
  return final;
}

/** A body stream shape wide enough to cover undici's BodyReadable (has `dump`/`destroy`) and a plain AsyncIterable. */
type ReadableBody = AsyncIterable<Uint8Array> & {
  dump?: () => Promise<void>;
  destroy?: (err?: Error) => void;
};

async function readBody(
  body: ReadableBody,
  maxSizeBytes: number | undefined,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of body) {
    if (maxSizeBytes !== undefined && total + chunk.length > maxSizeBytes) {
      const remaining = maxSizeBytes - total;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      total = maxSizeBytes;
      truncated = true;
      // Tear the connection down explicitly rather than relying on the async
      // iterator's implicit cleanup on `break` — that cleanup is not
      // guaranteed to release the socket back to the pool promptly.
      body.destroy?.();
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { data, truncated };
}

/**
 * Fully consumes a redirect response's body so the underlying connection is
 * returned to the keep-alive pool, without buffering the bytes anywhere.
 * Prefers undici's `dump()` (a body we're discarding, not size-capped);
 * falls back to iterating to completion for any body lacking `dump`.
 */
async function drainBody(body: ReadableBody): Promise<void> {
  if (typeof body.dump === 'function') {
    await body.dump();
    return;
  }
  for await (const chunk of body) {
    void chunk; // discard; just drives the stream to completion
  }
}

interface PhysicalResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly rawHeaders: [string, string][];
  readonly rawBody: Uint8Array;
  readonly body: Uint8Array;
  readonly truncated: boolean;
  readonly decodeError?: string;
  readonly rawRequest: Uint8Array;
  readonly finalUrl: string;
  readonly finalMethod: string;
}

/**
 * Sends one HTTP request and returns the full {@link HttpExchange}, including
 * reconstructed raw wire bytes and best-effort timings. Redirects (301/302/
 * 303/307/308) are followed manually when `req.followRedirects` is set, so we
 * can record the `redirects[]` trail and apply fetch's POST→GET downgrade on
 * 301/302/303.
 *
 * Non-2xx responses are returned as a normal exchange, never thrown — only
 * transport-level failures (timeout, abort, DNS, TLS, refused connection,
 * too many redirects, invalid URL) throw {@link HttpError}.
 *
 * A response exceeding `req.maxSizeBytes` is *not* an error: the exchange is
 * returned with `truncated: true` and `body` cut at the cap, per the product
 * decision that "Max Size" (Task 30) should notify, not fail, the exchange.
 */
export async function sendHttp(
  req: HttpRequest,
  options?: { readonly dispatcher?: Dispatcher; readonly now?: () => number },
): Promise<HttpExchange> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(req.url);
  } catch (err) {
    throw invalidUrlError(req.url, err);
  }

  const ownDispatcher =
    options?.dispatcher === undefined && (req.tls !== undefined || req.proxy !== undefined)
      ? createDispatcher({
          ...(req.tls !== undefined ? { tls: req.tls } : {}),
          ...(req.proxy !== undefined ? { proxy: req.proxy } : {}),
        })
      : undefined;
  const dispatcher = options?.dispatcher ?? ownDispatcher ?? getDefaultAgent();

  const maxRedirects = req.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirects: { url: string; status: number }[] = [];

  const tracker = new TimingTracker(options?.now);
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), req.timeoutMs);
  const signals = [deadlineController.signal, req.signal].filter((s): s is AbortSignal => s !== undefined);
  const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  try {
    let currentUrl = parsedUrl;
    let currentMethod: HttpRequest['method'] = req.method;
    let currentBody = req.body;
    let currentHeaders: Record<string, string> = { ...req.headers };
    let result: PhysicalResult | undefined;

    for (let attempt = 0; attempt <= maxRedirects; attempt++) {
      const finalHeaders = buildFinalHeaders(
        { ...req, headers: currentHeaders, method: currentMethod },
        currentUrl,
        currentBody,
      );
      const rawRequest = buildRawRequest(
        { ...req, url: currentUrl.toString(), method: currentMethod, headers: currentHeaders },
        finalHeaders,
        currentBody,
      );

      let response: Dispatcher.ResponseData;
      try {
        response = await undiciRequest(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          ...(currentBody !== undefined ? { body: currentBody } : {}),
          dispatcher,
          signal: combinedSignal ?? null,
          headersTimeout: req.timeoutMs,
          bodyTimeout: req.timeoutMs,
        });
      } catch (err) {
        throw toHttpError(err, {
          userAborted: req.signal?.aborted === true,
          deadlineHit: deadlineController.signal.aborted,
          hadProxy: req.proxy !== undefined,
        });
      }

      tracker.markHeaders();
      const { headers, rawHeaders } = joinHeaders(response.headers);

      const isRedirect =
        req.followRedirects && REDIRECT_STATUSES.has(response.statusCode) && headers['location'] !== undefined;
      if (isRedirect) {
        if (attempt === maxRedirects) {
          // Fully drain the body so the socket returns to the keep-alive pool, then fail.
          await drainBody(response.body).catch(() => undefined);
          throw tooManyRedirectsError(maxRedirects);
        }
        redirects.push({ url: currentUrl.toString(), status: response.statusCode });
        await drainBody(response.body).catch(() => undefined);

        const nextUrl = new URL(headers['location'] ?? '', currentUrl);
        const downgrade =
          response.statusCode === 303 ||
          ((response.statusCode === 301 || response.statusCode === 302) && currentMethod === 'POST');
        if (downgrade) {
          currentMethod = 'GET';
          currentBody = undefined;
          const rest = { ...currentHeaders };
          delete rest['content-type'];
          currentHeaders = rest;
        }
        // Drop credential headers (Authorization/Proxy-Authorization/Cookie)
        // when the redirect crosses to a different origin.
        currentHeaders = scopeHeadersToOrigin(currentHeaders, currentUrl, nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      const { data: rawBodyRaw, truncated } = await readBody(response.body, req.maxSizeBytes);
      const decompress = req.decompress ?? true;
      let body = rawBodyRaw;
      let decodeError: string | undefined;
      if (decompress) {
        try {
          body = await decompressBody(rawBodyRaw, headers['content-encoding']);
        } catch (err) {
          body = rawBodyRaw;
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }

      result = {
        status: response.statusCode,
        headers,
        rawHeaders,
        rawBody: rawBodyRaw,
        body,
        truncated,
        ...(decodeError !== undefined ? { decodeError } : {}),
        rawRequest,
        finalUrl: currentUrl.toString(),
        finalMethod: currentMethod,
      };
      break;
    }

    if (result === undefined) throw tooManyRedirectsError(maxRedirects);

    const rawResponse = buildRawResponse(result.status, statusText(result.status), result.rawHeaders, result.rawBody);
    const timings = tracker.finish();

    const tlsInfo = tracker.tlsInfo();
    return {
      request: { url: result.finalUrl, method: result.finalMethod, headers: req.headers },
      status: result.status,
      statusText: statusText(result.status),
      headers: result.headers,
      rawHeaders: result.rawHeaders,
      body: result.body,
      rawBody: result.rawBody,
      truncated: result.truncated,
      ...(result.decodeError !== undefined ? { decodeError: result.decodeError } : {}),
      timings,
      rawRequest: result.rawRequest,
      rawResponse,
      redirects,
      ...(tlsInfo !== undefined ? { tls: tlsInfo } : {}),
    };
  } finally {
    clearTimeout(timer);
    tracker.dispose();
    if (ownDispatcher !== undefined) await ownDispatcher.close().catch(() => undefined);
  }
}
