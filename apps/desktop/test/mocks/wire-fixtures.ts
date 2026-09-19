/**
 * Wire-shape fixtures with no renderer imports, so node-side (main) tests can use them too.
 * `exchange-fixtures.ts` re-exports everything here.
 */
import type {
  ExchangeSummary,
  FailedExchangeWire,
  GrpcExchangeSummary,
  RestExchangeSummary,
  WsExchangeSummary,
  WsHandshakeExchangeSummary,
} from '../../src/shared/wire-types.js';

/** Base64 of a UTF-8 string, for the `*Base64` fields the wire types carry. */
export function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // In chunks: spreading a large body into one call overflows the stack.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

const ENVELOPE =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><AddResponse><AddResult>7</AddResult></AddResponse></soap:Body></soap:Envelope>';

/** A successful 200 exchange; every field can be overridden per test. */
export function makeExchange(overrides: Partial<ExchangeSummary> = {}): ExchangeSummary {
  const body = overrides.response?.envelopeXml ?? ENVELOPE;
  return {
    sendId: 'send-1',
    durationMs: 143,
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/xml' },
      rawHeaders: [['content-type', 'text/xml']],
      bodyBase64: b64(body),
      rawBodyBase64: b64(body),
      rawRequestBase64: b64('POST /calc HTTP/1.1\r\nHost: example.test\r\n\r\n<request/>'),
      rawResponseBase64: b64(`HTTP/1.1 200 OK\r\n\r\n${body}`),
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: '2026-09-10T08:30:05.000Z', totalMs: 143, ttfbMs: 100 },
      redirects: [],
      request: { url: 'https://example.test/calc.asmx', method: 'POST', headers: {} },
    },
    response: { envelopeXml: body, version: '1.1', isSoap: true, attachments: [] },
    problems: [],
    ...overrides,
  };
}

/** A send refused at the socket: the failure row the log shows; every field can be overridden. */
export function makeFailure(overrides: Partial<FailedExchangeWire> = {}): FailedExchangeWire {
  return {
    sendId: 'send-fail-1',
    protocol: 'rest',
    requestId: 'rest-1',
    request: {
      url: 'http://127.0.0.1:1/nope',
      method: 'GET',
      headers: { Authorization: '<redacted>', 'X-Trace': 'abc' },
    },
    startedAt: '2026-09-16T08:30:05.000Z',
    durationMs: 3,
    error: { code: 'connection-refused', message: 'Connection refused.' },
    ...overrides,
  };
}

/** A successful REST exchange, with a small JSON body; every field can be overridden per test. */
export function makeRestExchange(overrides: Partial<RestExchangeSummary> = {}): RestExchangeSummary {
  const body = overrides.text ?? '{"id":1}';
  return {
    sendId: 'send-1',
    durationMs: 12,
    url: 'https://api.test/pet/1',
    method: 'GET',
    text: body,
    language: 'json',
    cookies: [],
    methodChanged: false,
    problems: [],
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      rawHeaders: [['content-type', 'application/json']],
      bodyBase64: b64(body),
      rawBodyBase64: b64(body),
      rawRequestBase64: b64('GET /pet/1 HTTP/1.1\r\nHost: api.test\r\n\r\n'),
      rawResponseBase64: b64(`HTTP/1.1 200 OK\r\n\r\n${body}`),
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: '2026-09-13T08:30:05.000Z', totalMs: 12, ttfbMs: 8 },
      redirects: [],
      request: { url: 'https://api.test/pet/1', method: 'GET', headers: {} },
    },
    ...overrides,
  };
}

/** The HTTP Log's row for a successful WebSocket handshake; every field can be overridden per test. */
export function makeWsHandshakeExchange(
  overrides: Partial<WsHandshakeExchangeSummary> = {},
): WsHandshakeExchangeSummary {
  return {
    sendId: 'send-1',
    protocol: 'websocket',
    method: 'GET',
    url: 'https://api.test/chat',
    wsUrl: 'wss://api.test/chat',
    requestHeaders: { Authorization: '<redacted>' },
    status: 101,
    responseHeaders: { 'sec-websocket-accept': 'abc123=' },
    startedAt: '2026-09-19T08:30:05.000Z',
    durationMs: 25,
    ...overrides,
  };
}

/** A finished WebSocket session, as `HistoryService.recordWsSession` records it; overridable per test. */
export function makeWsExchange(overrides: Partial<WsExchangeSummary> = {}): WsExchangeSummary {
  return {
    sendId: 'send-1',
    url: 'wss://api.test/chat',
    handshake: {
      url: 'wss://api.test/chat',
      requestHeaders: { Authorization: 'Bearer plain-token' },
      requestedSubprotocols: [],
      status: 101,
      responseHeaders: { 'sec-websocket-accept': 'abc123=' },
      startedAt: '2026-09-19T08:30:05.000Z',
      durationMs: 25,
    },
    frames: [
      { index: 0, direction: 'sent', opcode: 'text', at: 5, size: 2, text: 'hi' },
      { index: 1, direction: 'received', opcode: 'text', at: 8, size: 2, text: 'hi' },
    ],
    closed: { code: 1000, reason: 'normal', by: 'client' },
    counts: { sent: 1, received: 1, bytesSent: 2, bytesReceived: 2 },
    durationMs: 120,
    ...overrides,
  };
}

/** A successful unary gRPC exchange with one decoded reply; every field can be overridden per test. */
export function makeGrpcExchange(overrides: Partial<GrpcExchangeSummary> = {}): GrpcExchangeSummary {
  const reply = '{\n  "message": "Hello, Ada"\n}';
  return {
    sendId: 'send-1',
    durationMs: 9,
    target: '127.0.0.1:50051',
    service: 'wirebench.greet.Greeter',
    method: 'SayHello',
    methodKind: 'unary',
    status: 0,
    statusName: 'OK',
    statusSource: 'trailers',
    headers: { 'content-type': 'application/grpc+proto', 'x-served-by': 'test-grpc-server' },
    trailers: { 'grpc-status': '0' },
    requestMessages: ['{"name":"Ada"}'],
    responseMessages: [{ json: reply, base64: b64(reply), bytes: 12 }],
    truncated: false,
    problems: [],
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/grpc+proto' },
      rawHeaders: [['content-type', 'application/grpc+proto']],
      bodyBase64: b64(reply),
      rawBodyBase64: b64(reply),
      rawRequestBase64: b64('POST /wirebench.greet.Greeter/SayHello HTTP/2\r\n\r\n'),
      rawResponseBase64: b64(`HTTP/2 200\r\n\r\n${reply}`),
      truncated: false,
      httpVersion: '2',
      timings: { startedAt: '2026-09-16T08:30:05.000Z', totalMs: 9, ttfbMs: 6 },
      redirects: [],
      request: { url: 'http://127.0.0.1:50051/wirebench.greet.Greeter/SayHello', method: 'POST', headers: {} },
    },
    ...overrides,
  };
}
