// @vitest-environment node
/**
 * The REST send path end to end in main: the engine service against a real server, credentials
 * resolved from the store, the URL and headers redacted on the way back, the response cached, and a
 * history line written.
 *
 * The redaction assertions are the ones that matter most. An API key that travels in the query
 * string is in the URL of every request that uses it, and the URL reaches the HTTP log, history and
 * the cURL export — so "the key never crosses the bridge in the clear" has to be checked where the
 * URL is built, not only where headers are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { entry } from '@wirebench/engine';
import type { RestSendInput } from '@wirebench/engine';
import type { LogEntryWire } from '../src/shared/wire-types.js';
import { EngineService } from '../src/main/engine-service.js';
import { harOf } from '../src/main/har.js';
import { buildRestHistoryEntry } from '../src/main/history-service.js';
import { curlForLogEntry } from '../src/main/log-curl.js';
import { redactUrl } from '../src/main/redact.js';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

/** An engine service whose secret store answers a fixed map. */
function service(secrets: Record<string, string> = {}): EngineService {
  return new EngineService((ref) => Promise.resolve(secrets[ref]));
}

function input(overrides: Partial<RestSendInput['request']> = {}): RestSendInput {
  return {
    baseUrl: server.url,
    request: {
      method: 'GET',
      url: '/echo',
      pathParams: [],
      query: [],
      headers: [],
      body: { kind: 'none' },
      ...overrides,
    },
    settings: { timeoutMs: 5_000, followRedirects: true },
  };
}

describe('EngineService.sendRestRequest', () => {
  it('sends, decodes the body and reports the language', async () => {
    const summary = await service().sendRestRequest({ sendId: 's1', requestId: 'r1', input: input() });

    expect(summary.http.status).toBe(200);
    expect(summary.language).toBe('json');
    expect(summary.method).toBe('GET');
    expect(JSON.parse(summary.text)).toMatchObject({ method: 'GET', path: '/echo' });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves a bearer token from the store and redacts it on the way back', async () => {
    const engine = service({ sec_token: 'good-token' });

    const summary = await engine.sendRestRequest(
      { sendId: 's2', requestId: 'r1', input: input({ url: '/auth/bearer' }) },
      { auth: { type: 'bearer', tokenRef: 'sec_token' } },
    );

    expect(summary.http.status).toBe(200);
    const headers = summary.http.request.headers;
    expect(headers['Authorization'] ?? headers['authorization']).toBe('<redacted>');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain('good-token');
  });

  it('shows the token when the session says to show secrets', async () => {
    const engine = service({ sec_token: 'good-token' });

    const summary = await engine.sendRestRequest(
      { sendId: 's3', requestId: 'r1', input: input({ url: '/auth/bearer' }) },
      { auth: { type: 'bearer', tokenRef: 'sec_token' }, showSecrets: true },
    );

    const headers = summary.http.request.headers;
    expect(headers['Authorization'] ?? headers['authorization']).toBe('Bearer good-token');
  });

  it('masks an API key that travels in the query string, in the URL it reports', async () => {
    const engine = service({ sec_key: 'good-key' });

    const summary = await engine.sendRestRequest(
      { sendId: 's4', requestId: 'r1', input: input({ url: '/auth/apikey' }) },
      { auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' }, keyParams: ['api_key'] },
    );

    expect(summary.http.status).toBe(200);
    expect(summary.url).toContain('api_key=%3Credacted%3E');
    expect(summary.url).not.toContain('good-key');
    // The server did receive the real key: it is the *report* that is masked, not the request.
    expect(JSON.parse(summary.text)).toMatchObject({ in: 'query' });
  });

  it('masks the key in a redirect hop too, on the send and on a later re-render', async () => {
    const engine = service({ sec_key: 'good key' });
    const auth = { type: 'api-key', name: 'api key', in: 'query', valueRef: 'sec_key' } as const;
    const key = /good(%20|\+| )key/;

    const summary = await engine.sendRestRequest(
      { sendId: 's4r', requestId: 'r1', input: input({ url: '/redirect/302?to=/echo' }) },
      { auth, keyParams: ['api key'] },
    );

    expect(summary.http.redirects).toHaveLength(1);
    const [hop] = summary.http.redirects;
    expect(hop!.url).toContain('/redirect/302');
    expect(hop!.url).toContain('redacted');
    expect(hop!.url).not.toMatch(key);
    // `exchanges.get` re-renders from the cache: masked with show-secrets off, as sent with it on.
    expect(engine.exchanges.getRestView('s4r', false)?.http.redirects[0]!.url).not.toMatch(key);
    expect(engine.exchanges.getRestView('s4r', true)?.http.redirects[0]!.url).toMatch(key);
  });

  it('masks a header API key under a custom name, on the send, a re-render, a HAR and a row cURL', async () => {
    const engine = service({ sec_key: 'good-key' });
    const auth = { type: 'api-key', name: 'Ocp-Apim-Subscription-Key', in: 'header', valueRef: 'sec_key' } as const;
    const raw = (base64: string): string => Buffer.from(base64, 'base64').toString('latin1');

    const summary = await engine.sendRestRequest(
      { sendId: 's4h', requestId: 'r1', input: input() },
      { auth, keyHeaders: ['Ocp-Apim-Subscription-Key'] },
    );

    // The server got the key; the report masks it by the header's own name.
    expect(summary.text).toContain('good-key');
    const sent = Object.entries(summary.http.request.headers).find(
      ([name]) => name.toLowerCase() === 'ocp-apim-subscription-key',
    );
    expect(sent?.[1]).toBe('<redacted>');
    expect(raw(summary.http.rawRequestBase64)).toMatch(/ocp-apim-subscription-key: <redacted>/i);
    expect(JSON.stringify(summary.http) + raw(summary.http.rawRequestBase64)).not.toContain('good-key');
    expect(summary.http.keyNames).toEqual({ params: [], headers: ['Ocp-Apim-Subscription-Key'] });
    // `exchanges.get` re-renders with the same names.
    const hidden = engine.exchanges.getRestView('s4h', false)!;
    expect(raw(hidden.http.rawRequestBase64)).not.toContain('good-key');
    const shown = engine.exchanges.getRestView('s4h', true)!;
    expect(raw(shown.http.rawRequestBase64)).toContain('good-key');
    // A row held unmasked is masked again by its names on the way out.
    const row = { kind: 'exchange', protocol: 'rest', exchange: shown } as unknown as LogEntryWire;
    const har = harOf([row], { name: 'Wirebench', version: '0' });
    expect(JSON.stringify(har.log.entries[0]!.request)).not.toContain('good-key');
    expect(curlForLogEntry(row, { shell: 'posix', show: false }).command).not.toContain('good-key');
  });

  it('fails loudly when a reference has no secret behind it', async () => {
    await expect(
      service().sendRestRequest(
        { sendId: 's5', requestId: 'r1', input: input({ url: '/auth/bearer' }) },
        { auth: { type: 'bearer', tokenRef: 'sec_gone' } },
      ),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('keeps the unredacted summary and the body bytes in main, for a later re-render', async () => {
    const engine = service({ sec_token: 'good-token' });

    await engine.sendRestRequest(
      { sendId: 's6', requestId: 'r1', input: input({ url: '/auth/bearer' }) },
      { auth: { type: 'bearer', tokenRef: 'sec_token' } },
    );

    const cached = engine.exchanges.getRest('s6');
    const headers = cached?.http.request.headers ?? {};
    expect(headers['Authorization'] ?? headers['authorization']).toBe('Bearer good-token');
    expect(engine.exchanges.getRestBody('s6')?.byteLength).toBeGreaterThan(0);
  });

  it('parses the cookies a response set', async () => {
    const summary = await service().sendRestRequest({
      sendId: 's7',
      requestId: 'r1',
      input: input({ url: '/cookies/set' }),
    });

    expect(summary.cookies.map((cookie) => cookie.name)).toEqual(['session', 'tracking']);
  });

  it('is cancellable by its send id', async () => {
    const engine = service();
    const pending = engine.sendRestRequest({
      sendId: 's8',
      requestId: 'r1',
      input: input({ url: '/slow?ms=500' }),
    });
    expect(engine.cancel('s8')).toEqual({ cancelled: true });

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('sends a body and reports the method a redirect changed', async () => {
    const summary = await service().sendRestRequest({
      sendId: 's9',
      requestId: 'r1',
      input: input({
        method: 'POST',
        url: '/redirect/302?to=/echo',
        body: { kind: 'raw', language: 'json', text: '{"a":1}' },
      }),
    });

    expect(summary.methodChanged).toBe(true);
    expect(JSON.parse(summary.text)).toMatchObject({ method: 'GET' });
  });
});

describe('a REST history line', () => {
  it('records the method, the API and the folder path, with bodies and headers redacted', async () => {
    const summary = await service().sendRestRequest({
      sendId: 's10',
      requestId: 'req-1',
      input: input({ method: 'POST', url: '/echo', headers: [entry('Authorization', 'Bearer leak')] }),
    });

    const line = buildRestHistoryEntry('p1', {
      requestId: 'req-1',
      requestName: 'Create pet',
      apiName: 'Petstore',
      folderPath: 'Pets / Admin',
      method: 'POST',
      url: summary.url,
      requestHeaders: { Authorization: 'Bearer leak', Accept: 'application/json' },
      requestBody: '{"name":"Fido"}',
      exchange: summary,
      durationMs: 12,
    });

    expect(line).toMatchObject({
      kind: 'rest',
      method: 'POST',
      requestName: 'Create pet',
      interfaceName: 'Petstore',
      operationName: 'Pets / Admin',
      soapVersion: 'none',
      ok: true,
      status: 200,
    });
    expect(line.request.headers).toEqual([
      { name: 'Authorization', value: '<redacted>' },
      { name: 'Accept', value: 'application/json' },
    ]);
    expect(line.response?.status).toBe(200);
    expect(line.sizeBytes).toBeGreaterThan(0);
  });

  it('records a failed send with no response, and is not ok', () => {
    const line = buildRestHistoryEntry('p1', {
      requestId: 'req-1',
      requestName: 'Create pet',
      apiName: 'Petstore',
      folderPath: '',
      method: 'POST',
      url: 'https://unreachable.test/x',
      requestHeaders: {},
      requestBody: '{}',
      error: { code: 'dns', message: 'not found' },
      durationMs: 3,
    });

    expect(line).toMatchObject({ ok: false, error: { code: 'dns' } });
    expect(line.status).toBeUndefined();
    expect(line.response).toBeUndefined();
  });

  it('counts a 3xx that was not followed as an answer, and a 4xx as not ok', async () => {
    const redirect = await service().sendRestRequest({
      sendId: 's11',
      requestId: 'req-1',
      input: { ...input({ url: '/redirect/302' }), settings: { timeoutMs: 5_000, followRedirects: false } },
    });
    const notFound = await service().sendRestRequest({
      sendId: 's12',
      requestId: 'req-1',
      input: input({ url: '/status/404' }),
    });

    const line = (exchange: typeof redirect) =>
      buildRestHistoryEntry('p1', {
        requestId: 'req-1',
        requestName: 'x',
        apiName: 'a',
        folderPath: '',
        method: 'GET',
        url: exchange.url,
        requestHeaders: {},
        requestBody: '',
        exchange,
        durationMs: 1,
      });

    expect(line(redirect).ok).toBe(true);
    expect(line(notFound).ok).toBe(false);
  });

  it('truncates a body too large to keep whole', () => {
    const line = buildRestHistoryEntry('p1', {
      requestId: 'req-1',
      requestName: 'x',
      apiName: 'a',
      folderPath: '',
      method: 'POST',
      url: 'https://x.test',
      requestHeaders: {},
      requestBody: 'a'.repeat(300 * 1024),
      durationMs: 1,
    });

    expect(line.request.envelopeXml.length).toBeLessThan(300 * 1024);
    expect(line.request.envelopeXml).toContain('truncated');
  });

  it('a stopped stream writes one rest entry with sse, ok decided by status same as any other', async () => {
    const summary = await service().sendRestRequest(
      { sendId: 's13', requestId: 'req-1', input: input({ url: '/sse/ticks?n=3&every=1' }) },
      { onLive: () => undefined },
    );
    expect(summary.stream).toBeDefined();

    const line = buildRestHistoryEntry('p1', {
      requestId: 'req-1',
      requestName: 'Watch ticks',
      apiName: 'Petstore',
      folderPath: '',
      method: 'GET',
      url: summary.url,
      requestHeaders: {},
      requestBody: '',
      exchange: summary,
      durationMs: 12,
    });

    expect(line.kind).toBe('rest');
    expect(line.ok).toBe(true);
    expect(line.status).toBe(200);
    expect(line.sse).toBeDefined();
    expect(line.sse?.counts.events).toBe(3);
    expect(line.sse?.endedBy).toBe('server');
  });
});

describe('redactUrl', () => {
  it('masks the credential-shaped parameters by name', () => {
    expect(redactUrl('https://h/x?api_key=abc&page=2')).toBe('https://h/x?api_key=%3Credacted%3E&page=2');
    expect(redactUrl('https://h/x?access_token=abc')).toContain('%3Credacted%3E');
  });

  it('masks a parameter the caller names, whatever it is called', () => {
    expect(redactUrl('https://h/x?my_secret=abc', { extraParams: ['my_secret'] })).toContain('%3Credacted%3E');
    expect(redactUrl('https://h/x?my_secret=abc')).toContain('my_secret=abc');
  });

  it('leaves a URL alone when nothing matched, and when secrets are shown', () => {
    expect(redactUrl('https://h/x?page=2')).toBe('https://h/x?page=2');
    expect(redactUrl('https://h/x?api_key=abc', { show: true })).toBe('https://h/x?api_key=abc');
  });

  it('returns something it cannot parse unchanged rather than mangling it', () => {
    expect(redactUrl('/relative?api_key=abc')).toBe('/relative?api_key=abc');
  });
});
