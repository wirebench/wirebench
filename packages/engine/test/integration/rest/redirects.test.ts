/**
 * The redirect matrix: which statuses keep a method and a body, which downgrade to `GET`, what the
 * *keep body* setting changes, and that credentials never follow a redirect to another origin.
 *
 * This is the behaviour most worth pinning with a real server, because a client that silently turns
 * a `POST` into a `GET` loses the body without saying so, and one that keeps an `Authorization`
 * header across origins leaks a credential.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendRest } from '../../../src/rest/send.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import type { SendAuth } from '../../../src/types.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;
let other: TestRestServer;

beforeAll(async () => {
  // `other` first: the redirecting server is told which second origin it may send a client to.
  // `other` may send one back, once `server` has an origin: the list is read on every request.
  const back: string[] = [];
  other = await startTestRestServer({ redirectOrigins: back });
  server = await startTestRestServer({ redirectOrigins: [other.url] });
  back.push(server.url);
});

afterAll(async () => {
  await server.close();
  await other.close();
});

function input(overrides: {
  readonly method?: string;
  readonly url: string;
  readonly followRedirects?: boolean;
  readonly keepBodyOnRedirect?: boolean;
  readonly maxRedirects?: number;
  readonly headers?: readonly { name: string; value: string; enabled: boolean }[];
  readonly auth?: SendAuth;
}): RestSendInput {
  return {
    baseUrl: server.url,
    request: {
      method: overrides.method ?? 'GET',
      url: overrides.url,
      pathParams: [],
      query: [],
      headers: overrides.headers ?? [],
      body:
        overrides.method !== undefined && overrides.method !== 'GET'
          ? { kind: 'raw', language: 'json', text: '{"sent":true}' }
          : { kind: 'none' },
    },
    settings: {
      timeoutMs: 5_000,
      followRedirects: overrides.followRedirects ?? true,
      ...(overrides.keepBodyOnRedirect !== undefined ? { keepBodyOnRedirect: overrides.keepBodyOnRedirect } : {}),
      ...(overrides.maxRedirects !== undefined ? { maxRedirects: overrides.maxRedirects } : {}),
    },
    ...(overrides.auth !== undefined ? { auth: overrides.auth } : {}),
  };
}

interface Echo {
  readonly method: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

describe('following a redirect', () => {
  it('does not follow one at all when the setting is off', async () => {
    const exchange = await sendRest(input({ url: '/redirect/302', followRedirects: false }));

    expect(exchange.status).toBe(302);
    expect(exchange.redirects).toEqual([]);
  });

  it('records every hop it followed', async () => {
    const exchange = await sendRest(input({ url: '/redirect/302?to=/echo' }));

    expect(exchange.status).toBe(200);
    expect(exchange.redirects).toHaveLength(1);
    expect(exchange.redirects[0]).toMatchObject({ status: 302 });
  });

  it.each([
    [307, 'POST', '{"sent":true}'],
    [308, 'POST', '{"sent":true}'],
    [303, 'GET', ''],
    [301, 'GET', ''],
    [302, 'GET', ''],
  ])('a %i turns a POST into %s', async (status, method, body) => {
    const exchange = await sendRest(input({ method: 'POST', url: `/redirect/${String(status)}?to=/echo` }));

    const received = JSON.parse(exchange.text) as Echo;
    expect(received.method).toBe(method);
    expect(received.body).toBe(body);
    expect(exchange.methodChanged).toBe(method === 'GET');
  });

  it.each([301, 302, 307, 308])('a %i keeps a PUT, which was never downgraded', async (status) => {
    const exchange = await sendRest(input({ method: 'PUT', url: `/redirect/${String(status)}?to=/echo` }));

    expect((JSON.parse(exchange.text) as Echo).method).toBe('PUT');
  });

  it.each([301, 302])('keeps a POST across a %i when the request asks to', async (status) => {
    const exchange = await sendRest(
      input({ method: 'POST', url: `/redirect/${String(status)}?to=/echo`, keepBodyOnRedirect: true }),
    );

    const received = JSON.parse(exchange.text) as Echo;
    expect(received.method).toBe('POST');
    expect(received.body).toBe('{"sent":true}');
  });

  it('still turns a 303 into a GET, because that is what the status means', async () => {
    const exchange = await sendRest(input({ method: 'POST', url: '/redirect/303?to=/echo', keepBodyOnRedirect: true }));
    expect((JSON.parse(exchange.text) as Echo).method).toBe('GET');
  });

  it('fails when there are more hops than allowed', async () => {
    await expect(
      sendRest(input({ url: '/redirect/302?to=/redirect/302%3Fto=/redirect/302', maxRedirects: 1 })),
    ).rejects.toMatchObject({ code: 'too-many-redirects' });
  });
});

describe('credentials across a redirect', () => {
  it('keeps the Authorization header on a same-origin hop', async () => {
    const exchange = await sendRest(
      input({
        url: '/redirect/302?to=/echo',
        headers: [{ name: 'Authorization', value: 'Bearer keep', enabled: true }],
      }),
    );

    expect((JSON.parse(exchange.text) as Echo).headers.authorization).toBe('Bearer keep');
  });

  it('drops it when the redirect crosses to another origin', async () => {
    const exchange = await sendRest(
      input({
        url: `/redirect/302?to=${encodeURIComponent(`${other.url}/echo`)}`,
        headers: [{ name: 'Authorization', value: 'Bearer secret', enabled: true }],
      }),
    );

    const received = JSON.parse(exchange.text) as Echo;
    expect(received.headers.authorization).toBeUndefined();
    expect(exchange.redirects).toHaveLength(1);
  });

  it('drops a Cookie header across origins too', async () => {
    const exchange = await sendRest(
      input({
        url: `/redirect/302?to=${encodeURIComponent(`${other.url}/cookies/read`)}`,
        headers: [{ name: 'Cookie', value: 'session=abc', enabled: true }],
      }),
    );

    expect(JSON.parse(exchange.text)).toEqual({ cookie: null });
  });
});

describe('a configured API key across a redirect', () => {
  const headerKey: SendAuth = { type: 'api-key', name: 'X-Api-Key', value: 'k-secret', in: 'header' };
  const queryKey: SendAuth = { type: 'api-key', name: 'api_key', value: 'q-secret', in: 'query' };

  /** A `to=` target on `other`, as `/redirect/<code>` reads it. */
  const toOther = (path: string): string => encodeURIComponent(`${other.url}${path}`);

  /** Every request `other` recorded since `from`. */
  const reachedOther = (from: number) => other.requests.slice(from);

  it('keeps a header key on a same-origin hop', async () => {
    const exchange = await sendRest(input({ url: '/redirect/302?to=/echo', auth: headerKey }));

    expect((JSON.parse(exchange.text) as Echo).headers['x-api-key']).toBe('k-secret');
  });

  it('drops a header key when the redirect crosses to another origin', async () => {
    const from = other.requests.length;
    const exchange = await sendRest(input({ url: `/redirect/302?to=${toOther('/echo')}`, auth: headerKey }));

    expect(exchange.redirects).toHaveLength(1);
    const reached = reachedOther(from);
    expect(reached).toHaveLength(1);
    expect(reached[0]?.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(reached[0])).not.toContain('k-secret');
  });

  it('drops the key whatever case the request header that carries it was typed in', async () => {
    const from = other.requests.length;
    await sendRest(
      input({
        url: `/redirect/307?to=${toOther('/echo')}`,
        auth: headerKey,
        headers: [{ name: 'x-api-KEY', value: 'typed-secret', enabled: true }],
      }),
    );

    expect(JSON.stringify(reachedOther(from))).not.toContain('secret');
  });

  it('puts a header key back when a later hop returns to the original origin', async () => {
    const back = encodeURIComponent(`${server.url}/echo`);
    const from = other.requests.length;
    const exchange = await sendRest(
      input({ url: `/redirect/302?to=${toOther(`/redirect/302?to=${back}`)}`, auth: headerKey }),
    );

    expect(exchange.redirects).toHaveLength(2);
    expect(exchange.request.url).toBe(`${server.url}/echo`);
    expect(reachedOther(from)[0]?.headers['x-api-key']).toBeUndefined();
    expect((JSON.parse(exchange.text) as Echo).headers['x-api-key']).toBe('k-secret');
  });

  it('does not append a query key to a cross-origin hop', async () => {
    const from = other.requests.length;
    await sendRest(input({ url: `/redirect/302?to=${toOther('/echo')}`, auth: queryKey }));

    const reached = reachedOther(from);
    expect(reached).toHaveLength(1);
    expect(reached[0]?.url).toBe('/echo');
  });

  it('strips a query key a server echoed into a cross-origin Location', async () => {
    const from = other.requests.length;
    const exchange = await sendRest(
      input({ url: `/redirect/302?to=${toOther('/echo?page=2&api_key=q-secret')}`, auth: queryKey }),
    );

    const reached = reachedOther(from);
    expect(reached).toHaveLength(1);
    expect(reached[0]?.url).toBe('/echo?page=2');
    expect(exchange.request.url).not.toContain('q-secret');
  });

  it('leaves a parameter of the same name but another value alone on a cross-origin hop', async () => {
    const from = other.requests.length;
    await sendRest(input({ url: `/redirect/302?to=${toOther('/echo?api_key=theirs')}`, auth: queryKey }));

    expect(reachedOther(from)[0]?.url).toBe('/echo?api_key=theirs');
  });

  it('sends the query key on a same-origin hop, even when the Location leaves it out', async () => {
    const exchange = await sendRest(input({ url: '/redirect/302?to=/echo', auth: queryKey }));

    expect(server.requests.at(-1)?.url).toBe('/echo?api_key=q-secret');
    expect(exchange.status).toBe(200);
  });

  it('does not send the query key twice on a same-origin hop whose Location keeps it', async () => {
    await sendRest(input({ url: `/redirect/302?to=${encodeURIComponent('/echo?api_key=q-secret')}`, auth: queryKey }));

    expect(server.requests.at(-1)?.url).toBe('/echo?api_key=q-secret');
  });
});
