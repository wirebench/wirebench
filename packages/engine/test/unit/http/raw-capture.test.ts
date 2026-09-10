import { describe, expect, it } from 'vitest';
import { buildRawRequest, buildRawResponse } from '../../../src/http/raw-capture.js';
import type { HttpRequest } from '../../../src/http/types.js';

function baseRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url: 'http://example.test/soap?x=1',
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    timeoutMs: 5000,
    followRedirects: true,
    ...overrides,
  };
}

describe('buildRawRequest', () => {
  it('reconstructs the request line, headers, and body', () => {
    const body = new TextEncoder().encode('<a/>');
    const raw = buildRawRequest(
      baseRequest(),
      { host: 'example.test', 'content-type': 'text/xml', 'content-length': '4' },
      body,
    );
    const text = Buffer.from(raw).toString('utf-8');

    expect(text.startsWith('POST /soap?x=1 HTTP/1.1\r\n')).toBe(true);
    expect(text).toContain('host: example.test\r\n');
    expect(text).toContain('content-type: text/xml\r\n');
    expect(text).toContain('content-length: 4\r\n');
    expect(text.endsWith('\r\n\r\n<a/>')).toBe(true);
  });

  it('omits a body section when there is no body', () => {
    const raw = buildRawRequest(baseRequest({ method: 'GET' }), { host: 'example.test' });
    const text = Buffer.from(raw).toString('utf-8');
    expect(text).toBe('GET /soap?x=1 HTTP/1.1\r\nhost: example.test\r\n\r\n');
  });

  it('falls back to the raw url as the path when the url cannot be parsed', () => {
    const raw = buildRawRequest(baseRequest({ url: 'not a url' }), { host: 'x' });
    const text = Buffer.from(raw).toString('utf-8');
    expect(text.startsWith('POST not a url HTTP/1.1\r\n')).toBe(true);
  });
});

describe('buildRawResponse', () => {
  it('reconstructs the status line, headers, and body', () => {
    const rawBody = new TextEncoder().encode('hello');
    const raw = buildRawResponse(
      200,
      'OK',
      [
        ['content-type', 'text/plain'],
        ['content-length', '5'],
      ],
      rawBody,
    );
    const text = Buffer.from(raw).toString('utf-8');

    expect(text).toBe('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nhello');
  });

  it('omits a body section when the body is empty', () => {
    const raw = buildRawResponse(204, 'No Content', [], new Uint8Array());
    const text = Buffer.from(raw).toString('utf-8');
    expect(text).toBe('HTTP/1.1 204 No Content\r\n\r\n');
  });
});
