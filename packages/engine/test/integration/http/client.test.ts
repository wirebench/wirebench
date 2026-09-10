import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { sendHttp } from '../../../src/http/client.js';
import type { HttpRequest } from '../../../src/http/types.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

let server: TestSoapServer;

beforeEach(async () => {
  server = await startTestSoapServer();
});

afterEach(async () => {
  await server.close();
});

function req(overrides: Partial<HttpRequest> & { url: string }): HttpRequest {
  return {
    method: 'POST',
    headers: {},
    timeoutMs: 2000,
    followRedirects: true,
    ...overrides,
  };
}

describe('sendHttp', () => {
  it('echoes a SOAP request round-trip and captures raw wire bytes', async () => {
    const body = new TextEncoder().encode('<Envelope><Body><Add/></Body></Envelope>');
    const exchange = await sendHttp(
      req({
        url: `${server.url}/soap`,
        headers: { 'content-type': 'text/xml', soapaction: '"http://tempuri.org/Add"' },
        body,
      }),
    );

    expect(exchange.status).toBe(200);
    expect(Buffer.from(exchange.body).toString('utf-8')).toBe(Buffer.from(body).toString('utf-8'));

    const rawReqText = Buffer.from(exchange.rawRequest).toString('utf-8');
    expect(rawReqText.startsWith('POST /soap HTTP/1.1\r\n')).toBe(true);
    expect(rawReqText).toContain('soapaction: "http://tempuri.org/Add"');

    const rawResText = Buffer.from(exchange.rawResponse).toString('utf-8');
    expect(rawResText.startsWith('HTTP/1.1 200')).toBe(true);
  });

  it('reports custom request headers and lower-cases response headers', async () => {
    const exchange = await sendHttp(req({ url: `${server.url}/headers`, headers: { 'x-custom': 'yes' } }));
    expect(exchange.status).toBe(200);
    const received = JSON.parse(Buffer.from(exchange.body).toString('utf-8')) as Record<string, string>;
    expect(received['x-custom']).toBe('yes');
    expect(exchange.headers['content-type']).toBe('application/json');
  });

  it('returns a SOAP fault as a normal (non-thrown) 500 exchange', async () => {
    const exchange = await sendHttp(req({ url: `${server.url}/fault`, body: new Uint8Array() }));
    expect(exchange.status).toBe(500);
    expect(Buffer.from(exchange.body).toString('utf-8')).toContain('Simulated fault');
  });

  it('throws HttpError(timeout) when the server is slower than the deadline', async () => {
    await expect(
      sendHttp(req({ url: `${server.url}/delay/300`, timeoutMs: 100, body: new Uint8Array() })),
    ).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<HttpError>);
  });

  it('throws HttpError(aborted) when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const promise = sendHttp(
      req({ url: `${server.url}/delay/500`, signal: controller.signal, body: new Uint8Array(), timeoutMs: 5000 }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  it('decodes a gzip response while keeping rawBody compressed', async () => {
    const plaintext = new TextEncoder().encode('<Envelope>plain</Envelope>');
    const exchange = await sendHttp(req({ url: `${server.url}/gzip`, body: plaintext }));
    expect(Buffer.from(exchange.body).toString('utf-8')).toBe(Buffer.from(plaintext).toString('utf-8'));
    expect(Buffer.compare(Buffer.from(exchange.rawBody), Buffer.from(exchange.body))).not.toBe(0);
    expect(exchange.headers['content-encoding']).toBe('gzip');
  });

  it('follows a 307 redirect and records the trail', async () => {
    const body = new TextEncoder().encode('<x/>');
    const exchange = await sendHttp(req({ url: `${server.url}/redirect`, body }));
    expect(exchange.redirects).toHaveLength(1);
    expect(exchange.status).toBe(200);
    expect(Buffer.from(exchange.body).toString('utf-8')).toBe(Buffer.from(body).toString('utf-8'));
  });

  it('does not follow redirects when followRedirects is false', async () => {
    const exchange = await sendHttp(
      req({ url: `${server.url}/redirect`, body: new Uint8Array(), followRedirects: false }),
    );
    expect(exchange.status).toBe(307);
    expect(exchange.redirects).toHaveLength(0);
  });

  it('downgrades POST to GET on a 302 redirect, per fetch semantics', async () => {
    await sendHttp(req({ url: `${server.url}/redirect-get`, body: new Uint8Array(), method: 'POST' }));
    const finalRequest = server.requests.at(-1);
    expect(finalRequest?.method).toBe('GET');
    expect(finalRequest?.url).toBe('/headers');
  });

  it('truncates a response larger than maxSizeBytes without throwing', async () => {
    const exchange = await sendHttp(
      req({ url: `${server.url}/big/3`, body: new Uint8Array(), maxSizeBytes: 1024 * 1024, timeoutMs: 5000 }),
    );
    expect(exchange.truncated).toBe(true);
    expect(exchange.body.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('throws HttpError(connection-refused) for a closed port', async () => {
    await expect(
      sendHttp(req({ url: 'http://127.0.0.1:1', body: new Uint8Array(), timeoutMs: 1000 })),
    ).rejects.toMatchObject({
      code: 'connection-refused',
    });
  });

  it('throws HttpError(invalid-url) for a malformed URL', async () => {
    await expect(sendHttp(req({ url: 'not a url', body: new Uint8Array() }))).rejects.toMatchObject({
      code: 'invalid-url',
    });
  });

  it('records totalMs and ttfbMs for a successful exchange', async () => {
    const exchange = await sendHttp(req({ url: `${server.url}/soap`, body: new Uint8Array() }));
    expect(exchange.timings.totalMs).toBeGreaterThan(0);
    expect(exchange.timings.ttfbMs).toBeDefined();
  });

  it('throws HttpError(too-many-redirects) on a redirect loop', async () => {
    await expect(
      sendHttp(req({ url: `${server.url}/loop`, body: new Uint8Array(), maxRedirects: 3 })),
    ).rejects.toMatchObject({
      code: 'too-many-redirects',
    });
  });
});
