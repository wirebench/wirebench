/**
 * `sendRest` against a real HTTP server in this process: every method, every body kind, the header
 * precedence rules, compression, sizes, timeouts, cancellation and charsets.
 *
 * These are the assertions a unit test cannot make, because they depend on what a server actually
 * receives and sends rather than on what the client believes it built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, WirebenchError } from '../../../src/errors.js';
import { entry } from '../../../src/rest/model.js';
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

/** An input with the defaults a send needs, overridable per test. */
function input(
  overrides: Omit<Partial<RestSendInput>, 'request' | 'settings'> & {
    readonly request?: Partial<RestSendInput['request']>;
    readonly settings?: Partial<RestSendInput['settings']>;
  } = {},
): RestSendInput {
  const { request, settings, ...rest } = overrides;
  return {
    baseUrl: server.url,
    request: {
      method: 'GET',
      url: '/echo',
      pathParams: [],
      query: [],
      headers: [],
      body: { kind: 'none' },
      ...request,
    },
    settings: { timeoutMs: 5_000, followRedirects: true, ...settings },
    ...rest,
  };
}

/** The `/echo` route's answer, parsed. */
interface Echo {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly contentType: string | null;
}

function echo(text: string): Echo {
  return JSON.parse(text) as Echo;
}

describe('methods and URLs', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('sends a %s', async (method) => {
    const exchange = await sendRest(input({ request: { method, url: '/echo' } }));

    expect(exchange.status).toBe(200);
    expect(echo(exchange.text).method).toBe(method);
  });

  it('sends a HEAD, which has a status but no body', async () => {
    const exchange = await sendRest(input({ request: { method: 'HEAD', url: '/echo' } }));
    expect(exchange.status).toBe(200);
    expect(exchange.body.byteLength).toBe(0);
  });

  it('sends a custom method the server sees verbatim', async () => {
    const exchange = await sendRest(input({ request: { method: 'PURGE', url: '/echo' } }));
    expect(echo(exchange.text).method).toBe('PURGE');
  });

  it('fills path parameters and appends query rows', async () => {
    const exchange = await sendRest(
      input({
        request: {
          url: '/echo?fixed=1',
          pathParams: [],
          query: [entry('tag', 'a b'), entry('off', 'x', { enabled: false })],
        },
      }),
    );

    expect(echo(exchange.text).query).toEqual({ fixed: '1', tag: 'a b' });
  });

  it('refuses to send a URL that still has an unfilled parameter', async () => {
    const error = (await sendRest(input({ request: { url: '/pet/{petId}' } })).catch(
      (e: unknown) => e,
    )) as WirebenchError;

    expect(error.code).toBe('rest-url-incomplete');
    expect(error.message).toContain('{petId}');
  });

  it('sends an absolute request URL, ignoring the base', async () => {
    const exchange = await sendRest(
      input({ baseUrl: 'https://never.invalid', request: { url: `${server.url}/echo` } }),
    );
    expect(exchange.status).toBe(200);
  });
});

describe('bodies', () => {
  it('sends a raw JSON body with its content type', async () => {
    const exchange = await sendRest(
      input({ request: { method: 'POST', body: { kind: 'raw', language: 'json', text: '{"a":1}' } } }),
    );

    const received = echo(exchange.text);
    expect(received.body).toBe('{"a":1}');
    expect(received.contentType).toBe('application/json');
  });

  it('lets a typed header override the body content type', async () => {
    const exchange = await sendRest(
      input({
        request: {
          method: 'POST',
          headers: [entry('Content-Type', 'application/vnd.custom+json')],
          body: { kind: 'raw', language: 'json', text: '{}' },
        },
      }),
    );

    expect(echo(exchange.text).contentType).toBe('application/vnd.custom+json');
  });

  it('sends a form body', async () => {
    const exchange = await sendRest(
      input({ request: { method: 'POST', body: { kind: 'form', fields: [entry('a', '1'), entry('b', 'x y')] } } }),
    );

    const received = echo(exchange.text);
    expect(received.body).toBe('a=1&b=x+y');
    expect(received.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('sends a multipart body with a file read through the resolver', async () => {
    const exchange = await sendRest(
      input({
        request: {
          method: 'POST',
          body: {
            kind: 'multipart',
            parts: [
              { kind: 'text', name: 'caption', value: 'hi', enabled: true },
              { kind: 'file', name: 'file', source: { kind: 'path', path: 'a.txt' }, enabled: true },
            ],
          },
        },
        resolveFile: () => Promise.resolve(new TextEncoder().encode('BYTES')),
        boundary: '----X',
      }),
    );

    const received = echo(exchange.text);
    expect(received.contentType).toBe('multipart/form-data; boundary=----X');
    expect(received.body).toContain('name="caption"');
    expect(received.body).toContain('BYTES');
  });

  it('sends a binary body', async () => {
    const exchange = await sendRest(
      input({
        request: {
          method: 'PUT',
          body: { kind: 'binary', source: { kind: 'cache', sha256: 'abc' }, contentType: 'application/pdf' },
        },
        resolveFile: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      }),
    );

    const received = echo(exchange.text);
    expect(received.contentType).toBe('application/pdf');
    expect(received.body).toBe('%PDF');
  });

  it('sends a GET body when one is set, rather than dropping it silently', async () => {
    const exchange = await sendRest(
      input({ request: { method: 'GET', body: { kind: 'raw', language: 'json', text: '{"q":1}' } } }),
    );
    expect(echo(exchange.text).body).toBe('{"q":1}');
  });

  it('invents no content type and sends nothing for a none body', async () => {
    const exchange = await sendRest(input({ request: { method: 'POST', url: '/echo' } }));

    const received = echo(exchange.text);
    expect(received.body).toBe('');
    expect(received.contentType).toBeNull();
    // `content-length: 0` is the transport's, not ours: a POST with no body does declare zero
    // length. What matters is that no body and no type were invented for it.
    expect(server.requests.at(-1)!.body.byteLength).toBe(0);
  });
});

describe('headers', () => {
  it('merges host defaults below the request own headers', async () => {
    const exchange = await sendRest(
      input({
        defaultHeaders: { 'User-Agent': 'wirebench-test', Accept: 'application/json' },
        request: { headers: [entry('Accept', 'text/plain'), entry('X-Extra', '1')] },
      }),
    );

    const received = echo(exchange.text).headers;
    expect(received['user-agent']).toBe('wirebench-test');
    expect(received.accept).toBe('text/plain');
    expect(received['x-extra']).toBe('1');
  });

  it('joins a repeated header name, which is what a recipient must treat as two', async () => {
    const exchange = await sendRest(
      input({ request: { headers: [entry('X-Trace', 'on'), entry('X-Trace', 'verbose')] } }),
    );
    expect(echo(exchange.text).headers['x-trace']).toBe('on, verbose');
  });

  it('skips a disabled header row', async () => {
    const exchange = await sendRest(input({ request: { headers: [entry('X-Off', '1', { enabled: false })] } }));
    expect(echo(exchange.text).headers['x-off']).toBeUndefined();
  });
});

describe('responses', () => {
  it('reports a non-2xx status as a response, not a failure', async () => {
    const exchange = await sendRest(input({ request: { url: '/status/418' } }));
    expect(exchange.status).toBe(418);
    expect(exchange.language).toBe('json');
  });

  it('decompresses gzip, deflate and brotli', async () => {
    for (const route of ['/gzip', '/deflate', '/brotli']) {
      const exchange = await sendRest(input({ request: { url: route } }));
      expect(JSON.parse(exchange.text)).toEqual({ compressed: route.slice(1) });
    }
  });

  it('reads a chunked response with no content length', async () => {
    const exchange = await sendRest(input({ request: { url: '/chunked' } }));
    expect(JSON.parse(exchange.text)).toEqual({ parts: [1, 2] });
  });

  it('detects an image and leaves its bytes alone', async () => {
    const exchange = await sendRest(input({ request: { url: '/image.png' } }));
    expect(exchange.language).toBe('image');
    expect(exchange.text).toBe('');
    expect(exchange.body.byteLength).toBeGreaterThan(60);
  });

  it('sniffs JSON labelled text/plain', async () => {
    const exchange = await sendRest(input({ request: { url: '/text-plain-json' } }));
    expect(exchange.language).toBe('json');
  });

  it('decodes a declared latin-1 body', async () => {
    const exchange = await sendRest(input({ request: { url: '/latin1' } }));
    expect(exchange.text).toBe('café');
  });

  it('truncates a body over the size cap and says so', async () => {
    const exchange = await sendRest(
      input({
        request: { url: '/large?bytes=4096' },
        settings: { timeoutMs: 5_000, followRedirects: true, maxSizeBytes: 100 },
      }),
    );
    expect(exchange.truncated).toBe(true);
    expect(exchange.body.byteLength).toBeLessThanOrEqual(100);
  });

  it('captures the raw request and response bytes', async () => {
    const exchange = await sendRest(
      input({ request: { method: 'POST', body: { kind: 'raw', language: 'json', text: '{"a":1}' } } }),
    );
    const rawRequest = Buffer.from(exchange.rawRequest).toString('utf8');
    expect(rawRequest.startsWith('POST /echo HTTP/1.1')).toBe(true);
    expect(rawRequest).toContain('{"a":1}');
    expect(Buffer.from(exchange.rawResponse).toString('utf8').startsWith('HTTP/1.1 200')).toBe(true);
  });

  it('reports a duration and a timing breakdown', async () => {
    const exchange = await sendRest(input({ request: { url: '/slow?ms=30' } }));
    expect(exchange.durationMs).toBeGreaterThan(0);
    expect(exchange.timings.totalMs).toBeGreaterThan(0);
  });
});

describe('failures', () => {
  it('times out with a readable error', async () => {
    const error = (await sendRest(
      input({ request: { url: '/slow?ms=500' }, settings: { timeoutMs: 50, followRedirects: true } }),
    ).catch((e: unknown) => e)) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(error.code).toBe('timeout');
  });

  it('reports a cancelled send as aborted', async () => {
    const controller = new AbortController();
    const promise = sendRest(input({ request: { url: '/slow?ms=500' }, signal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  it('reports a refused connection', async () => {
    // Port 1 on loopback: nothing listens there, and the attempt fails immediately.
    const error = (await sendRest(input({ baseUrl: 'http://127.0.0.1:1', request: { url: '/echo' } })).catch(
      (e: unknown) => e,
    )) as HttpError;

    expect(error).toBeInstanceOf(HttpError);
    expect(['connection-refused', 'network']).toContain(error.code);
  });
});
