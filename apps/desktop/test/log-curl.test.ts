// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { curlForLogEntry, loggedRequestOf } from '../src/main/log-curl.js';
import type { FailedExchangeWire, RestExchangeSummary, WsHandshakeExchangeSummary } from '../src/shared/wire-types.js';

function makeWsHandshakeExchange(overrides: Partial<WsHandshakeExchangeSummary> = {}): WsHandshakeExchangeSummary {
  return {
    sendId: 'send-1',
    protocol: 'websocket',
    method: 'GET',
    url: 'https://api.test/chat',
    wsUrl: 'wss://api.test/chat',
    requestHeaders: { Authorization: 'Bearer plain-token' },
    status: 101,
    responseHeaders: { 'sec-websocket-accept': 'abc123=' },
    startedAt: '2026-09-19T08:30:05.000Z',
    durationMs: 25,
    ...overrides,
  };
}

// Local fixtures: the shared ones import renderer modules, which this node-side project cannot type.
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

function makeRestExchange(): RestExchangeSummary {
  return {
    sendId: 'send-1',
    durationMs: 12,
    url: 'https://api.test/pet/1',
    method: 'GET',
    text: '{}',
    language: 'json',
    cookies: [],
    methodChanged: false,
    problems: [],
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      rawHeaders: [['content-type', 'application/json']],
      bodyBase64: b64('{}'),
      rawBodyBase64: b64('{}'),
      rawRequestBase64: b64('GET /pet/1 HTTP/1.1\r\nHost: api.test\r\n\r\n'),
      rawResponseBase64: b64('HTTP/1.1 200 OK\r\n\r\n{}'),
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: '2026-09-13T08:30:05.000Z', totalMs: 12, ttfbMs: 8 },
      redirects: [],
      request: { url: 'https://api.test/pet/1', method: 'GET', headers: {} },
    },
  };
}

function makeFailure(overrides: Partial<FailedExchangeWire> = {}): FailedExchangeWire {
  return {
    sendId: 'send-fail-1',
    protocol: 'rest',
    requestId: 'rest-1',
    request: { url: 'http://127.0.0.1:1/nope', method: 'GET', headers: {} },
    startedAt: '2026-09-16T08:30:05.000Z',
    durationMs: 3,
    error: { code: 'connection-refused', message: 'Connection refused.' },
    ...overrides,
  };
}

function restEntry(rawRequest: string, truncated = false) {
  const exchange = makeRestExchange();
  return {
    kind: 'exchange' as const,
    exchange: {
      ...exchange,
      http: {
        ...exchange.http,
        truncated,
        rawRequestBase64: b64(rawRequest),
        request: {
          url: 'https://api.test/pets?page=2',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      },
    },
  };
}

describe('loggedRequestOf', () => {
  it('a WebSocket row reads as a GET with the http(s):// URL and the handshake request headers', () => {
    const entry = { kind: 'exchange' as const, exchange: makeWsHandshakeExchange() };
    expect(loggedRequestOf(entry)).toEqual({
      method: 'GET',
      url: 'https://api.test/chat',
      headers: { Authorization: 'Bearer plain-token' },
      bodyTruncated: false,
    });
  });

  it('reads method, URL, headers and body from the raw request, dropping transport headers', () => {
    const entry = restEntry(
      'POST /pets?page=2 HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\nContent-Length: 11\r\nX-Trace: 1\r\n\r\n{"name":"a"}',
    );
    expect(loggedRequestOf(entry)).toEqual({
      method: 'POST',
      url: 'https://api.test/pets?page=2',
      headers: { 'Content-Type': 'application/json', 'X-Trace': '1' },
      body: '{"name":"a"}',
      bodyTruncated: false,
    });
  });
});

describe('curlForLogEntry', () => {
  it('posix: method, URL, headers and body', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"name":"a"}');
    const { command, notes } = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(command).toContain("--request POST 'https://api.test/pets?page=2'");
    expect(command).toContain("--header 'Content-Type: application/json'");
    expect(command).toContain('{"name":"a"}');
    expect(notes).toBeUndefined();
  });

  it('powershell uses its own program name', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{}');
    expect(curlForLogEntry(entry, { shell: 'powershell', show: false }).command).toMatch(/^curl\.exe /);
  });

  it('a truncated body is omitted with a note', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"na', true);
    const result = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(result.command).not.toContain('{"na');
    expect(result.notes).toEqual(['The request body was truncated in the log and is not included.']);
  });

  it('masks secrets with show off and for failure rows even with show on', () => {
    const secret = restEntry(
      'POST /t HTTP/1.1\r\nAuthorization: Bearer plain-token\r\nContent-Type: application/json\r\n\r\n{"password":"s3cr3t-placeholder"}',
    );
    const masked = curlForLogEntry(secret, { shell: 'posix', show: false }).command;
    expect(masked).not.toContain('plain-token');
    expect(masked).not.toContain('s3cr3t-placeholder');
    expect(curlForLogEntry(secret, { shell: 'posix', show: true }).command).toContain('plain-token');

    const failure = {
      kind: 'failure' as const,
      failure: makeFailure({
        request: { url: 'http://h/x?api_key=k-placeholder', method: 'GET', headers: { Authorization: '<redacted>' } },
      }),
    };
    const fromFailure = curlForLogEntry(failure, { shell: 'posix', show: true }).command;
    expect(fromFailure).not.toContain('k-placeholder');
    expect(fromFailure).toContain('<redacted>');
  });

  it('a WebSocket row uses wsToCommand with the original ws(s):// URL, masked unless shown', () => {
    const entry = { kind: 'exchange' as const, exchange: makeWsHandshakeExchange() };
    const masked = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(masked.command).toContain('websocat');
    expect(masked.command).toContain("'wss://api.test/chat'");
    expect(masked.command).not.toContain('plain-token');

    const shown = curlForLogEntry(entry, { shell: 'posix', show: true });
    expect(shown.command).toContain('plain-token');
  });
});
