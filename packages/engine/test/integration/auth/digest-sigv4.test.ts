/**
 * Digest and AWS Signature v4 on the wire, REST and SOAP, against servers that check them.
 *
 * The Digest server verifies each response with its own hashing, issues a new nonce or a stale one on
 * demand, and refuses a nonce count that does not go up. The SigV4 server rebuilds the signature from
 * the request it received — the path, query, headers and body as they arrived — so a signer that
 * signed something other than what the transport sent fails here even if it passes the vectors.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendWithAuth } from '#core/http/auth/apply';
import { DigestNonceCache } from '#core/http/auth/digest';
import type { SendAuth } from '#core/http/auth/send-auth';
import { signSigV4 } from '#core/http/auth/sigv4';
import { sendRest } from '#protocol-rest/rest/send';
import { sendSoapRequest } from '#protocol-soap/soap/send';

const USER = 'admin';
const PASSWORD = 'Circle of Life';
const KEY = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly headers: IncomingMessage['headers'];
}

let server: Server;
let base: string;
const seen: Seen[] = [];
const digestState = { nonce: 'n-1', stale: false, lastNc: new Map<string, number>(), algorithm: 'SHA-256' };

function hash(algorithm: string, text: string): string {
  return createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5')
    .update(text)
    .digest('hex');
}

/** The `name=value` pairs of a Digest header, unquoted; a linear scan, since the header is the client's. */
function params(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < header.length) {
    while (header[at] === ' ' || header[at] === ',') at += 1;
    const equals = header.indexOf('=', at);
    if (equals === -1) break;
    const name = header.slice(at, equals).trim();
    at = equals + 1;
    let value = '';
    if (header[at] === '"') {
      at += 1;
      while (at < header.length && header[at] !== '"') {
        if (header[at] === '\\') at += 1;
        value += header[at] ?? '';
        at += 1;
      }
      at += 1;
    } else {
      const end = header.indexOf(',', at);
      value = header.slice(at, end === -1 ? header.length : end).trim();
      at = end === -1 ? header.length : end;
    }
    out[name] = value;
  }
  return out;
}

/** True when `authorization` answers the current nonce correctly with a count higher than the last. */
function digestOk(method: string, url: string, authorization: string | undefined): boolean {
  if (authorization?.startsWith('Digest ') !== true) return false;
  const p = params(authorization.slice('Digest '.length));
  if (p.nonce !== digestState.nonce || p.uri !== url || p.username !== USER) return false;
  const nc = Number.parseInt(p.nc ?? '', 16);
  if (!(nc > (digestState.lastNc.get(p.nonce) ?? 0))) return false;
  const ha1 = hash(digestState.algorithm, `${USER}:wb:${PASSWORD}`);
  const ha2 = hash(digestState.algorithm, `${method}:${url}`);
  const expected = hash(digestState.algorithm, `${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`);
  if (p.response !== expected) return false;
  digestState.lastNc.set(p.nonce, nc);
  return true;
}

/** The signature the server would compute for what it received, given the client's signed header list. */
function sigv4Ok(request: IncomingMessage, body: Buffer): boolean {
  const url = new URL(request.url ?? '/', 'http://placeholder');
  const presigned = url.searchParams.get('X-Amz-Signature');
  const authorization = request.headers.authorization;
  const signedHeaders =
    presigned !== null
      ? (url.searchParams.get('X-Amz-SignedHeaders') ?? '')
      : (/SignedHeaders=([^,]+)/.exec(authorization ?? '')?.[1] ?? '');
  const names = signedHeaders.split(';');
  const amzDate = presigned !== null ? url.searchParams.get('X-Amz-Date') : (request.headers['x-amz-date'] as string);
  if (amzDate === null || amzDate === undefined) return false;
  const at = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  const headers: Record<string, string> = {};
  for (const name of names) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  let target = `http://${request.headers.host ?? ''}${request.url ?? '/'}`;
  if (presigned !== null) {
    // Rebuild the URL without the presign parameters; the signer appends them again.
    const stripped = new URL(target);
    for (const name of [...stripped.searchParams.keys()])
      if (name.startsWith('X-Amz-')) stripped.searchParams.delete(name);
    target = stripped.href.replace(/\?$/, '');
  }
  const signed = signSigV4(
    { method: request.method ?? 'GET', url: target, headers, body },
    {
      ...KEY,
      region: 'eu-west-1',
      service: 'execute-api',
      ...(typeof request.headers['x-amz-security-token'] === 'string'
        ? { sessionToken: request.headers['x-amz-security-token'] }
        : {}),
      ...(url.searchParams.get('X-Amz-Security-Token') !== null
        ? { sessionToken: url.searchParams.get('X-Amz-Security-Token') ?? '' }
        : {}),
    },
    {
      now: at,
      signHeader: (name) => names.includes(name),
      ...(presigned !== null
        ? { placement: 'query' as const, expiresSeconds: Number(url.searchParams.get('X-Amz-Expires')) }
        : {}),
    },
  );
  return presigned !== null
    ? new URL(signed.url).searchParams.get('X-Amz-Signature') === presigned
    : signed.headers['Authorization'] === authorization;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}),
      });
      if (request.url?.startsWith('/digest') === true) {
        if (digestOk(request.method ?? '', request.url, request.headers.authorization)) {
          response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
          return;
        }
        response
          .writeHead(401, {
            'www-authenticate': `Digest realm="wb", qop="auth", algorithm=${digestState.algorithm}, nonce="${digestState.nonce}", opaque="o"${digestState.stale ? ', stale=true' : ''}`,
          })
          .end();
        return;
      }
      response.writeHead(sigv4Ok(request, body) ? 200 : 403, { 'content-type': 'text/plain' }).end('done');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  digestState.nonce = `n-${randomBytes(4).toString('hex')}`;
  digestState.stale = false;
  digestState.algorithm = 'SHA-256';
});

const DIGEST: SendAuth = { type: 'digest', username: USER, password: PASSWORD };

function rest(url: string, auth: SendAuth, method: 'GET' | 'POST' = 'GET', body = '') {
  return {
    baseUrl: base,
    request: {
      method,
      url,
      pathParams: [],
      query: [],
      headers: [],
      body: body === '' ? ({ kind: 'none' } as const) : ({ kind: 'raw', language: 'json', text: body } as const),
    },
    settings: { timeoutMs: 5_000, followRedirects: false },
    auth,
  } as const;
}

describe('Digest on the wire', () => {
  it('answers the challenge, then sends the remembered nonce with a higher count', async () => {
    const nonces = new DigestNonceCache();
    const first = await sendWithAuth(
      { url: `${base}/digest/a?x=1`, method: 'GET', headers: {}, timeoutMs: 5_000, followRedirects: false },
      DIGEST,
      { digestNonces: nonces },
    );
    expect(first.http.status).toBe(200);
    expect(first.auth).toEqual({ scheme: 'digest', challenged: true, attempts: 2 });
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[1]?.authorization).toContain('nc=00000001');

    const second = await sendWithAuth(
      {
        url: `${base}/digest/b`,
        method: 'POST',
        headers: {},
        body: new Uint8Array([1]),
        timeoutMs: 5_000,
        followRedirects: false,
      },
      DIGEST,
      { digestNonces: nonces },
    );
    expect(second.http.status).toBe(200);
    expect(second.auth).toEqual({ scheme: 'digest', challenged: false, attempts: 1 });
    expect(seen[2]?.authorization).toContain('nc=00000002');
  });

  it('answers a stale nonce once with the new one', async () => {
    const nonces = new DigestNonceCache();
    const send = () =>
      sendWithAuth(
        { url: `${base}/digest/s`, method: 'GET', headers: {}, timeoutMs: 5_000, followRedirects: false },
        DIGEST,
        { digestNonces: nonces },
      );
    await send();
    digestState.nonce = 'rotated';
    digestState.stale = true;
    const exchange = await send();
    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'digest', challenged: true, attempts: 2 });
    expect(seen.at(-1)?.authorization).toContain('nonce="rotated"');
    expect(seen.at(-1)?.authorization).toContain('nc=00000001');
  });

  it('reports a wrong password as the 401 it is, without a loop', async () => {
    const nonces = new DigestNonceCache();
    const wrong: SendAuth = { type: 'digest', username: USER, password: 'nope' };
    const exchange = await sendWithAuth(
      { url: `${base}/digest/w`, method: 'GET', headers: {}, timeoutMs: 5_000, followRedirects: false },
      wrong,
      { digestNonces: nonces },
    );
    expect(exchange.http.status).toBe(401);
    expect(seen).toHaveLength(2);
    // A remembered nonce refused for itself is not answered again.
    const again = await sendWithAuth(
      { url: `${base}/digest/w`, method: 'GET', headers: {}, timeoutMs: 5_000, followRedirects: false },
      wrong,
      { digestNonces: nonces },
    );
    expect(again.http.status).toBe(401);
    expect(again.auth?.attempts).toBe(1);
  });

  it('works through the REST send and answers MD5 too', async () => {
    digestState.algorithm = 'MD5';
    const exchange = await sendRest(rest('/digest/rest', DIGEST));
    expect(exchange.status).toBe(200);
    expect(seen.at(-1)?.authorization).toContain('algorithm=MD5');
  });

  it('works through the SOAP send', async () => {
    const exchange = await sendSoapRequest({
      endpoint: `${base}/digest/soap`,
      envelopeXml:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
      soapVersion: '1.1',
      auth: DIGEST,
    });
    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.scheme).toBe('digest');
  });

  it('leaves a typed Authorization alone', async () => {
    const exchange = await sendWithAuth(
      {
        url: `${base}/digest/t`,
        method: 'GET',
        headers: { Authorization: 'Bearer x' },
        timeoutMs: 5_000,
        followRedirects: false,
      },
      DIGEST,
      { digestNonces: new DigestNonceCache() },
    );
    expect(exchange.http.status).toBe(401);
    expect(seen).toHaveLength(1);
  });
});

describe('AWS Signature v4 on the wire', () => {
  const SIGV4: SendAuth = {
    type: 'aws-sigv4',
    region: 'eu-west-1',
    service: 'execute-api',
    ...KEY,
    placement: 'header',
  };

  it('signs a REST POST with a body, an encoded path and a query', async () => {
    const exchange = await sendRest({
      ...rest('/sig/a%20b/items', SIGV4, 'POST', '{"a":1}'),
      request: {
        ...rest('/sig/a%20b/items', SIGV4, 'POST', '{"a":1}').request,
        query: [
          { name: 'b', value: 'two words', enabled: true },
          { name: 'a', value: '1', enabled: true },
        ],
      },
    });
    expect(exchange.status).toBe(200);
    expect(exchange.auth?.scheme).toBe('aws-sigv4');
    expect(exchange.auth?.signature?.canonicalRequest).toContain('/sig/a%2520b/items');
    expect(exchange.request.headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('signs the session token and fails when the secret is wrong', async () => {
    const ok = await sendRest(rest('/sig/t', { ...SIGV4, sessionToken: 'TOKEN' }));
    expect(ok.status).toBe(200);
    expect(seen.at(-1)?.headers['x-amz-security-token']).toBe('TOKEN');
    const bad = await sendRest(rest('/sig/t', { ...SIGV4, secretAccessKey: 'wrong' }));
    expect(bad.status).toBe(403);
  });

  it('presigns the URL instead of adding an Authorization header', async () => {
    const exchange = await sendRest(rest('/sig/p?keep=1', { ...SIGV4, placement: 'query', expiresSeconds: 120 }));
    expect(exchange.status).toBe(200);
    expect(seen.at(-1)?.authorization).toBeUndefined();
    expect(seen.at(-1)?.url).toContain('X-Amz-Expires=120');
    expect(seen.at(-1)?.url).toContain('keep=1');
  });

  it('signs a SOAP envelope', async () => {
    const exchange = await sendSoapRequest({
      endpoint: `${base}/sig/soap`,
      envelopeXml:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ping/></soapenv:Body></soapenv:Envelope>',
      soapVersion: '1.1',
      soapAction: 'urn:ping',
      auth: SIGV4,
    });
    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.signature?.stringToSign.startsWith('AWS4-HMAC-SHA256\n')).toBe(true);
  });
});
