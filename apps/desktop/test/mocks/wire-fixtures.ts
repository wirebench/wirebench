/**
 * Wire-shape fixtures with no renderer imports, so node-side (main) tests can use them too.
 * `exchange-fixtures.ts` re-exports everything here.
 */
import type {
  ExchangeSummary,
  FailedExchangeWire,
  GrpcExchangeSummary,
  RestExchangeSummary,
} from '../../src/shared/wire-types.js';

/** Base64 of a UTF-8 string, for the `*Base64` fields the wire types carry. */
export function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
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
