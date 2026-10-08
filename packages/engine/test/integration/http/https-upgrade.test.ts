/**
 * The same-host `http://` → `https://` upgrade (#71), end to end through `sendHttp`.
 *
 * The shape only counts on the default ports, which a test cannot bind, so both origins are an
 * undici `MockAgent` passed as the dispatcher: the client's redirect loop runs exactly as it does
 * against a real server.
 */
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendHttp } from '../../../src/http/client.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import { decodeRestResponse } from '../../../src/rest/send.js';
import { sendSoapRequest } from '../../../src/soap/send.js';

const HTTP = 'http://soap.example';
const HTTPS = 'https://soap.example';
const ENVELOPE = '<Envelope><Body><Add/></Body></Envelope>';

interface Arrival {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

let agent: MockAgent;
let arrivals: Arrival[];

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  arrivals = [];
});

afterEach(async () => {
  await agent.close();
});

function headerMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
  } else if (raw !== null && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) out[name.toLowerCase()] = String(value);
  }
  return out;
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return Buffer.from(body as Uint8Array).toString('utf-8');
}

/** `origin` answers `path` with `status` and a `Location`, once. */
function redirectFrom(origin: string, path: string, status: number, location: string): void {
  agent
    .get(origin)
    .intercept({ path, method: () => true })
    .reply((opts) => {
      arrivals.push({
        method: opts.method,
        path: opts.path,
        body: bodyText(opts.body),
        headers: headerMap(opts.headers),
      });
      return { statusCode: status, data: 'moved', responseOptions: { headers: { location } } };
    });
}

/** `origin` echoes the request body back at `path`, once. */
function echoAt(origin: string, path: string): void {
  agent
    .get(origin)
    .intercept({ path, method: () => true })
    .reply((opts) => {
      const body = bodyText(opts.body);
      arrivals.push({ method: opts.method, path: opts.path, body, headers: headerMap(opts.headers) });
      return { statusCode: 200, data: body, responseOptions: { headers: { 'content-type': 'text/xml' } } };
    });
}

function post(url: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'text/xml', authorization: 'Basic dXNlcjpwYXNz' },
    body: new TextEncoder().encode(ENVELOPE),
    timeoutMs: 2000,
    followRedirects: false,
    ...overrides,
  };
}

describe('sendHttp: the same-host https upgrade', () => {
  it.each([301, 302, 307, 308])(
    'resends a POST with its body and credentials after a %i, with Follow Redirects off',
    async (status) => {
      redirectFrom(HTTP, '/svc?x=1', status, `${HTTPS}/svc?x=1`);
      echoAt(HTTPS, '/svc?x=1');

      const exchange = await sendHttp(post(`${HTTP}/svc?x=1`), { dispatcher: agent });

      expect(exchange.status).toBe(200);
      expect(Buffer.from(exchange.body).toString('utf-8')).toBe(ENVELOPE);
      expect(exchange.request).toMatchObject({ url: `${HTTPS}/svc?x=1`, method: 'POST' });
      expect(exchange.redirects).toEqual([{ url: `${HTTP}/svc?x=1`, status, upgrade: true }]);
      const upgraded = arrivals[1];
      expect(upgraded).toMatchObject({ method: 'POST', body: ENVELOPE });
      expect(upgraded?.headers['authorization']).toBe('Basic dXNlcjpwYXNz');
      expect(upgraded?.headers['content-type']).toBe('text/xml');
    },
  );

  it('keeps the method and body with Follow Redirects on, where a 301 would otherwise become a GET', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc`);
    echoAt(HTTPS, '/svc');

    const exchange = await sendHttp(post(`${HTTP}/svc`, { followRedirects: true }), { dispatcher: agent });

    expect(exchange.request.method).toBe('POST');
    expect(arrivals[1]).toMatchObject({ method: 'POST', body: ENVELOPE });
  });

  it('does not count the upgrade against the redirect cap', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc`);
    echoAt(HTTPS, '/svc');

    const exchange = await sendHttp(post(`${HTTP}/svc`, { followRedirects: true, maxRedirects: 0 }), {
      dispatcher: agent,
    });

    expect(exchange.status).toBe(200);
  });

  it('returns a later redirect as the response when Follow Redirects is off', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc`);
    redirectFrom(HTTPS, '/svc', 302, `${HTTPS}/elsewhere`);

    const exchange = await sendHttp(post(`${HTTP}/svc`), { dispatcher: agent });

    expect(exchange.status).toBe(302);
    expect(exchange.redirects).toEqual([{ url: `${HTTP}/svc`, status: 301, upgrade: true }]);
  });

  it('treats the upgraded origin as the request own for its origin credentials', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc`);
    redirectFrom(HTTPS, '/svc', 307, `${HTTPS}/v2/svc`);
    echoAt(HTTPS, '/v2/svc');

    await sendHttp(
      post(`${HTTP}/svc`, {
        followRedirects: true,
        headers: { 'x-api-key': 'k' },
        originCredentials: { headers: ['x-api-key'] },
      }),
      { dispatcher: agent },
    );

    expect(arrivals.map((arrival) => arrival.headers['x-api-key'])).toEqual(['k', 'k', 'k']);
  });

  it.each([
    ['a 303', 303, `${HTTPS}/svc`],
    ['another path', 301, `${HTTPS}/svc/`],
    ['another host', 301, 'https://www.soap.example/svc'],
  ])('does not follow %s with Follow Redirects off', async (_label, status, location) => {
    redirectFrom(HTTP, '/svc', status, location);

    const exchange = await sendHttp(post(`${HTTP}/svc`), { dispatcher: agent });

    expect(exchange.status).toBe(status);
    expect(exchange.redirects).toEqual([]);
  });

  it('downgrades a 301 to another path as before, with Follow Redirects on', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc/`);
    echoAt(HTTPS, '/svc/');

    const exchange = await sendHttp(post(`${HTTP}/svc`, { followRedirects: true }), { dispatcher: agent });

    expect(exchange.request.method).toBe('GET');
    expect(exchange.redirects).toEqual([{ url: `${HTTP}/svc`, status: 301 }]);
    expect(arrivals[1]?.headers['authorization']).toBeUndefined();
  });
});

describe('what the protocols report about the upgrade', () => {
  it('a SOAP send records an https-upgrade Problem and parses the https response', async () => {
    redirectFrom(HTTP, '/svc', 301, `${HTTPS}/svc`);
    agent
      .get(HTTPS)
      .intercept({ path: '/svc', method: 'POST' })
      .reply(
        200,
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>',
        {
          headers: { 'content-type': 'text/xml' },
        },
      );

    const exchange = await sendSoapRequest(
      { endpoint: `${HTTP}/svc`, envelopeXml: ENVELOPE, soapVersion: '1.1' },
      { dispatcher: agent },
    );

    expect(exchange.response?.isSoap).toBe(true);
    expect(exchange.problems).toEqual([
      {
        code: 'https-upgrade',
        message: `${HTTP}/svc redirected to ${HTTPS}/svc; the request was resent there with its method and body. Change the endpoint to https:// to skip the redirect.`,
      },
    ]);
  });

  it('a REST POST upgraded with a 301 does not report a method change', () => {
    const exchange = {
      request: { url: `${HTTPS}/svc`, method: 'POST', headers: {} },
      status: 200,
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      redirects: [{ url: `${HTTP}/svc`, status: 301, upgrade: true }],
      timings: { totalMs: 1 },
    } as unknown as HttpExchange;

    expect(decodeRestResponse(exchange, 'POST').methodChanged).toBe(false);
  });
});
