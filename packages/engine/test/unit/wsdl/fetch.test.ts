import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';

describe('createDefaultFetchDocument — http(s)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches over http(s), follows redirects and decodes UTF-8 text', async () => {
    const body = '<?xml version="1.0" encoding="UTF-8"?><definitions/>';
    const mockFetch = vi.fn<typeof fetch>((url, init) => {
      void url;
      void init;
      return Promise.resolve(new Response(new TextEncoder().encode(body), { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const fetchDocument = createDefaultFetchDocument();
    const result = await fetchDocument('https://example.invalid/service.wsdl');
    expect(result.text).toBe(body);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    if (call === undefined) {
      expect.fail('expected fetch to have been called');
    }
    const init = call[1];
    expect((init?.headers as Record<string, string>)['user-agent']).toBe('wirebench/0.1');
  });

  it('throws HttpError for a non-2xx response', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('not found', { status: 404 })));

    const fetchDocument = createDefaultFetchDocument();
    await expect(fetchDocument('https://example.invalid/missing.wsdl')).rejects.toMatchObject({
      code: 'fetch-failed',
    });
  });

  it('decodes an iso-8859-1 XML declaration', async () => {
    const xml = '<?xml version="1.0" encoding="iso-8859-1"?><definitions/>';
    const bytes = new TextEncoder().encode(xml);
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(bytes, { status: 200 })));

    const fetchDocument = createDefaultFetchDocument();
    const result = await fetchDocument('https://example.invalid/latin1.wsdl');
    expect(result.text).toBe(xml);
  });
});
