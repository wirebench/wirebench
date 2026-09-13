/**
 * An in-process HTTP server for the REST tests: echo, status, redirect, auth, compression,
 * cookies, charsets, sizes, and a stub OAuth2 authorization server.
 *
 * Hermetic by design — every REST test but the opt-in interop suite talks to this — and
 * deliberately a little rude where real services are: it answers JSON labelled `text/plain` on one
 * route, sends two `Set-Cookie` headers on another, and lets a test ask for any status. Shared with
 * the desktop app's e2e suite through `@wirebench/engine/test-helpers`.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import type { Socket } from 'node:net';

/** One request the server recorded, for assertions the response cannot carry. */
export interface RecordedRestRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** TLS options, for the certificate and client-certificate tests. */
export interface TestRestServerTls {
  readonly cert: string;
  readonly key: string;
  readonly ca?: string | readonly string[];
  readonly requestCert?: boolean;
}

/** One document the server serves verbatim at a path of its own. */
export interface TestRestServerDocument {
  readonly body: string;
  /** Defaults to `application/octet-stream`, so a served document is never sniffed by accident. */
  readonly contentType?: string;
}

/** Options for {@link startTestRestServer}. */
export interface TestRestServerOptions {
  readonly tls?: TestRestServerTls;
  /**
   * Static documents by pathname, e.g. `{ '/openapi.yaml': { body, contentType: 'application/yaml' } }`.
   *
   * Served before every built-in route, so a document may take any path. Here because an OpenAPI
   * import has to fetch a document over HTTP like any other client, and a fixture on disk cannot
   * answer that; the alternative would be a second server in every spec that needs one.
   *
   * Read on every request rather than copied at startup, so a caller may pass an object it fills in
   * afterwards. That is what lets a document name the very server serving it: start the server, then
   * add the document with the URL it just learned.
   */
  readonly documents?: Record<string, TestRestServerDocument>;
  /** Credentials `/auth/basic` accepts. Default `u` / `p`. */
  readonly basic?: { readonly username: string; readonly password: string };
  /** Token `/auth/bearer` accepts. Default `good-token`. */
  readonly bearerToken?: string;
  /** Key `/auth/apikey` accepts, in the `X-Api-Key` header or the `api_key` query. Default `good-key`. */
  readonly apiKey?: string;
  /** Client credentials the stub `/oauth2/token` accepts. Default `app` / `s3cret`. */
  readonly oauthClient?: { readonly id: string; readonly secret: string };
}

/** A running {@link startTestRestServer}. */
export interface TestRestServer {
  readonly url: string;
  readonly requests: RecordedRestRequest[];
  /** Access tokens the stub authorization server has issued, newest last. */
  readonly issuedTokens: string[];
  /** Refresh tokens it has issued, newest last. */
  readonly issuedRefreshTokens: string[];
  close(): Promise<void>;
}

const JSON_TYPE = 'application/json';

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown, contentType = JSON_TYPE): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'content-type': contentType, 'content-length': String(body.byteLength) });
  response.end(body);
}

/** Every header as a plain map, joining a repeated one the way a recipient may. */
function headerMap(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    out[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
  }
  return out;
}

/**
 * Starts the server on an ephemeral port.
 *
 * Routes:
 * - `/echo` — the request back as JSON: method, path, query, headers, body text, cookies
 * - `/status/:code` — that status, with a JSON body describing it
 * - `/redirect/:code?to=` — a redirect of that status to `to` (default `/echo`)
 * - `/auth/basic`, `/auth/bearer`, `/auth/apikey` — 200 when the credential is right, else 401/403
 * - `/gzip`, `/deflate`, `/brotli` — a compressed JSON body
 * - `/slow?ms=` — a JSON body after that delay
 * - `/chunked` — a body in several chunks with no `Content-Length`
 * - `/image.png` — a 1×1 PNG
 * - `/large?bytes=` — that many bytes of `a`
 * - `/text-plain-json` — JSON labelled `text/plain`, for sniffing
 * - `/latin1` — `café` as ISO-8859-1, declared
 * - `/cookies/set` — two `Set-Cookie` headers
 * - `/cookies/read` — the `Cookie` header it received, as JSON
 * - `/oauth2/authorize` — redirects to `redirect_uri` with a code, validating `state` and PKCE
 * - `/oauth2/token` — the token endpoint: client credentials, code exchange and refresh
 */
export async function startTestRestServer(options: TestRestServerOptions = {}): Promise<TestRestServer> {
  const requests: RecordedRestRequest[] = [];
  const issuedTokens: string[] = [];
  const issuedRefreshTokens: string[] = [];
  const codes = new Map<string, { readonly challenge?: string; readonly redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const basic = options.basic ?? { username: 'u', password: 'p' };
  const bearerToken = options.bearerToken ?? 'good-token';
  const apiKey = options.apiKey ?? 'good-key';
  const oauthClient = options.oauthClient ?? { id: 'app', secret: 's3cret' };

  const sockets = new Set<Socket>();
  let counter = 0;

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const body = await readBody(request);
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      const document = options.documents?.[path];
      if (document !== undefined) {
        const bytes = Buffer.from(document.body, 'utf8');
        response.writeHead(200, {
          'content-type': document.contentType ?? 'application/octet-stream',
          'content-length': String(bytes.byteLength),
        });
        response.end(bytes);
        return;
      }

      if (path === '/echo') {
        sendJson(response, 200, {
          method: request.method,
          path,
          query: Object.fromEntries(url.searchParams),
          headers: headerMap(request),
          body: body.toString('utf8'),
          contentType: request.headers['content-type'] ?? null,
        });
        return;
      }

      const status = /^\/status\/(\d{3})$/.exec(path);
      if (status !== null) {
        sendJson(response, Number(status[1]), { status: Number(status[1]) });
        return;
      }

      const redirect = /^\/redirect\/(\d{3})$/.exec(path);
      if (redirect !== null) {
        response.writeHead(Number(redirect[1]), { location: url.searchParams.get('to') ?? '/echo' });
        response.end();
        return;
      }

      if (path === '/auth/basic') {
        const header = request.headers.authorization;
        const expected = `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString('base64')}`;
        if (header !== expected) {
          response.writeHead(401, { 'www-authenticate': 'Basic realm="test"', 'content-length': '0' });
          response.end();
          return;
        }
        sendJson(response, 200, { authenticated: 'basic' });
        return;
      }

      if (path === '/auth/bearer') {
        const header = request.headers.authorization ?? '';
        const [scheme, token] = header.split(' ');
        if (scheme !== 'Bearer' || token !== bearerToken) {
          response.writeHead(401, { 'www-authenticate': 'Bearer', 'content-length': '0' });
          response.end();
          return;
        }
        sendJson(response, 200, { authenticated: 'bearer' });
        return;
      }

      if (path === '/auth/apikey') {
        const fromHeader = request.headers['x-api-key'];
        const fromQuery = url.searchParams.get('api_key');
        if (fromHeader !== apiKey && fromQuery !== apiKey) {
          sendJson(response, 403, { error: 'bad key' });
          return;
        }
        sendJson(response, 200, { authenticated: 'api-key', in: fromHeader === apiKey ? 'header' : 'query' });
        return;
      }

      if (path === '/gzip' || path === '/deflate' || path === '/brotli') {
        const raw = Buffer.from(JSON.stringify({ compressed: path.slice(1) }), 'utf8');
        const encoded =
          path === '/gzip' ? gzipSync(raw) : path === '/deflate' ? deflateSync(raw) : brotliCompressSync(raw);
        response.writeHead(200, {
          'content-type': JSON_TYPE,
          'content-encoding': path === '/brotli' ? 'br' : path.slice(1),
          'content-length': String(encoded.byteLength),
        });
        response.end(encoded);
        return;
      }

      if (path === '/slow') {
        const ms = Number(url.searchParams.get('ms') ?? '50');
        setTimeout(() => sendJson(response, 200, { slept: ms }), ms);
        return;
      }

      if (path === '/chunked') {
        response.writeHead(200, { 'content-type': JSON_TYPE, 'transfer-encoding': 'chunked' });
        response.write('{"parts":[1');
        setTimeout(() => {
          response.write(',2');
          response.end(']}');
        }, 10);
        return;
      }

      if (path === '/image.png') {
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        );
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.byteLength) });
        response.end(png);
        return;
      }

      if (path === '/large') {
        const size = Number(url.searchParams.get('bytes') ?? '1024');
        const payload = Buffer.alloc(size, 'a');
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(size) });
        response.end(payload);
        return;
      }

      if (path === '/text-plain-json') {
        sendJson(response, 200, { labelled: 'text/plain' }, 'text/plain');
        return;
      }

      if (path === '/latin1') {
        const payload = Buffer.from('café', 'latin1');
        response.writeHead(200, {
          'content-type': 'text/plain; charset=iso-8859-1',
          'content-length': String(payload.byteLength),
        });
        response.end(payload);
        return;
      }

      if (path === '/cookies/set') {
        response.writeHead(200, {
          'content-type': JSON_TYPE,
          'set-cookie': ['session=abc; Path=/; HttpOnly', 'tracking=xyz; Path=/deep'],
        });
        response.end(JSON.stringify({ set: 2 }));
        return;
      }

      if (path === '/cookies/read') {
        sendJson(response, 200, { cookie: request.headers.cookie ?? null });
        return;
      }

      if (path === '/oauth2/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (redirectUri === null || state === null) {
          sendJson(response, 400, { error: 'invalid_request' });
          return;
        }
        const code = `code-${String((counter += 1))}`;
        const challenge = url.searchParams.get('code_challenge');
        codes.set(code, { ...(challenge !== null ? { challenge } : {}), redirectUri });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }

      if (path === '/oauth2/token') {
        handleToken({
          request,
          response,
          body,
          codes,
          refreshTokens,
          issuedTokens,
          issuedRefreshTokens,
          client: oauthClient,
          next: () => (counter += 1),
        });
        return;
      }

      sendJson(response, 404, { error: 'no such route', path });
    })();
  };

  const server: Server =
    options.tls !== undefined
      ? createHttpsServer(
          {
            cert: options.tls.cert,
            key: options.tls.key,
            ...(options.tls.ca !== undefined ? { ca: options.tls.ca as string | string[] } : {}),
            ...(options.tls.requestCert === true ? { requestCert: true, rejectUnauthorized: false } : {}),
          },
          handler,
        )
      : createServer(handler);

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const scheme = options.tls !== undefined ? 'https' : 'http';

  return {
    url: `${scheme}://127.0.0.1:${String(port)}`,
    requests,
    issuedTokens,
    issuedRefreshTokens,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/** The stub token endpoint: enough of RFC 6749 §4.1.3, §4.4 and §6 to exercise a real client. */
function handleToken(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly body: Buffer;
  readonly codes: Map<string, { readonly challenge?: string; readonly redirectUri: string }>;
  readonly refreshTokens: Set<string>;
  readonly issuedTokens: string[];
  readonly issuedRefreshTokens: string[];
  readonly client: { readonly id: string; readonly secret: string };
  readonly next: () => number;
}): void {
  const { request, response, codes, refreshTokens, issuedTokens, issuedRefreshTokens, client } = input;
  const form = new URLSearchParams(input.body.toString('utf8'));

  const header = request.headers.authorization;
  let clientId = form.get('client_id');
  let clientSecret = form.get('client_secret');
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    clientId = decodeURIComponent(id ?? '');
    clientSecret = decodeURIComponent(secret ?? '');
  }
  if (clientId !== client.id || clientSecret !== client.secret) {
    sendJson(response, 401, { error: 'invalid_client', error_description: 'Client authentication failed' });
    return;
  }

  const issue = (withRefresh: boolean): void => {
    const n = input.next();
    const accessToken = `access-${String(n)}`;
    issuedTokens.push(accessToken);
    const refreshToken = `refresh-${String(n)}`;
    if (withRefresh) {
      refreshTokens.add(refreshToken);
      issuedRefreshTokens.push(refreshToken);
    }
    sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: form.get('scope') ?? 'read',
      ...(withRefresh ? { refresh_token: refreshToken } : {}),
    });
  };

  switch (form.get('grant_type')) {
    case 'client_credentials':
      issue(false);
      return;
    case 'authorization_code': {
      const code = form.get('code') ?? '';
      const record = codes.get(code);
      if (record === undefined) {
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'Unknown or used code' });
        return;
      }
      codes.delete(code);
      if (record.challenge !== undefined) {
        const verifier = form.get('code_verifier');
        if (verifier === null || pkceChallenge(verifier) !== record.challenge) {
          sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }
      if (form.get('redirect_uri') !== record.redirectUri) {
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
        return;
      }
      issue(true);
      return;
    }
    case 'refresh_token': {
      const token = form.get('refresh_token') ?? '';
      if (!refreshTokens.has(token)) {
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'Unknown refresh token' });
        return;
      }
      refreshTokens.delete(token);
      issue(true);
      return;
    }
    default:
      sendJson(response, 400, { error: 'unsupported_grant_type' });
  }
}

/** The S256 challenge for a verifier, so the stub can check PKCE the way a provider does. */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
