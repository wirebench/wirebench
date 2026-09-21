// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harFileName, harOf, type HarEntry } from '../src/main/har.js';
import {
  b64,
  makeExchange,
  makeFailure,
  makeGrpcExchange,
  makeRestExchange,
  makeWsHandshakeExchange,
} from './mocks/wire-fixtures.js';

const CREATOR = { name: 'Wirebench', version: '0.0.0-test' } as const;
const golden = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/har/${name}.har.json`, import.meta.url), 'utf8'));

function requiredFieldsPresent(entry: HarEntry): void {
  for (const key of ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings'])
    expect(entry).toHaveProperty(key);
  for (const key of ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize'])
    expect(entry.request).toHaveProperty(key);
  for (const key of [
    'status',
    'statusText',
    'httpVersion',
    'cookies',
    'headers',
    'content',
    'redirectURL',
    'headersSize',
    'bodySize',
  ])
    expect(entry.response).toHaveProperty(key);
  for (const key of ['send', 'wait', 'receive'])
    expect(typeof entry.timings[key as keyof HarEntry['timings']]).toBe('number');
}

describe('harOf', () => {
  it.each([
    ['rest', { kind: 'exchange' as const, exchange: makeRestExchange() }],
    ['soap', { kind: 'exchange' as const, exchange: makeExchange() }],
    ['grpc', { kind: 'exchange' as const, exchange: makeGrpcExchange() }],
    ['failure', { kind: 'failure' as const, failure: makeFailure({ stage: 'prepare' }) }],
  ])('%s matches its golden file and HAR 1.2 required fields', (name, entry) => {
    const har = harOf([entry], CREATOR);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual(CREATOR);
    requiredFieldsPresent(har.log.entries[0]!);
    expect(har).toEqual(golden(name));
  });

  it('a failure is status 0 with an _error and empty content', () => {
    const entry = harOf([{ kind: 'failure', failure: makeFailure({ stage: 'prepare' }) }], CREATOR).log.entries[0]!;
    expect(entry.response.status).toBe(0);
    expect(entry.response.headers).toEqual([]);
    expect(entry.response.content).toEqual({ size: 0, mimeType: 'x-unknown' });
    expect(entry._error).toEqual({
      code: makeFailure().error.code,
      message: makeFailure().error.message,
      stage: 'prepare',
    });
  });

  it('timings: dns/blocked -1, send 0, wait = ttfb, receive = download, unknown = -1', () => {
    const exchange = makeRestExchange();
    const http = {
      ...exchange.http,
      timings: { startedAt: '2026-09-18T10:00:00.000Z', totalMs: 50, ttfbMs: 30, downloadMs: 5 },
    };
    const entry = harOf([{ kind: 'exchange', exchange: { ...exchange, http } }], CREATOR).log.entries[0]!;
    expect(entry.timings).toEqual({ blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 30, receive: 5 });
  });

  it('a truncated body is flagged and carries no text', () => {
    const exchange = makeRestExchange();
    const entry = harOf(
      [{ kind: 'exchange', exchange: { ...exchange, http: { ...exchange.http, truncated: true } } }],
      CREATOR,
    ).log.entries[0]!;
    expect(entry._truncated).toBe(true);
    expect(entry.response.content.text).toBeUndefined();
  });

  it('an event-stream row writes its rows as text/event-stream, flagged when capped', () => {
    const exchange = makeRestExchange({
      stream: {
        rows: [
          { kind: 'event', index: 0, at: 0, size: 20, event: 'message', data: 'hi', lastEventId: '' },
          { kind: 'event', index: 1, at: 1, size: 20, event: 'ping', data: 'pong', lastEventId: '' },
        ],
        counts: { events: 2, comments: 0, retries: 0, bytes: 40 },
        lastEventId: '',
        endedBy: 'server',
        droppedRows: 3,
        truncated: true,
        omittedRows: 2,
      },
    });
    const entry = harOf([{ kind: 'exchange', exchange }], CREATOR).log.entries[0]!;
    expect(entry.response.content).toEqual({
      size: 8,
      mimeType: 'text/event-stream',
      text: 'data: hi\n\nevent: ping\ndata: pong\n\n',
    });
    expect(entry._sseTruncated).toBe(true);
    expect(entry._sseOmittedRows).toBe(2);
  });

  it('an untruncated event stream carries no _sseTruncated/_sseOmittedRows', () => {
    const exchange = makeRestExchange({
      stream: {
        rows: [{ kind: 'event', index: 0, at: 0, size: 20, event: 'message', data: 'hi', lastEventId: '' }],
        counts: { events: 1, comments: 0, retries: 0, bytes: 20 },
        lastEventId: '',
        endedBy: 'client',
        droppedRows: 0,
        truncated: false,
        omittedRows: 0,
      },
    });
    const entry = harOf([{ kind: 'exchange', exchange }], CREATOR).log.entries[0]!;
    expect(entry._sseTruncated).toBeUndefined();
    expect(entry._sseOmittedRows).toBeUndefined();
  });

  it('writes no secret: header, URL param, wsse:Password, JSON body key', () => {
    const exchange = makeRestExchange();
    const secretRaw =
      'POST /t?api_key=k-placeholder HTTP/1.1\r\nAuthorization: Bearer plain-token\r\nContent-Type: application/json\r\n\r\n{"password":"s3cr3t-placeholder"}';
    const http = {
      ...exchange.http,
      rawRequestBase64: b64(secretRaw),
      request: {
        url: 'https://h/t?api_key=k-placeholder',
        method: 'POST',
        headers: { Authorization: 'Bearer plain-token', 'Content-Type': 'application/json' },
      },
      bodyBase64: b64('<s:Envelope><wsse:Password>pw-placeholder</wsse:Password></s:Envelope>'),
      headers: { 'content-type': 'text/xml' },
    };
    const text = JSON.stringify(harOf([{ kind: 'exchange', exchange: { ...exchange, http } }], CREATOR));
    for (const secret of ['k-placeholder', 'plain-token', 's3cr3t-placeholder', 'pw-placeholder'])
      expect(text).not.toContain(secret);
  });
  it('writes no secret on the response side or in a failure row', () => {
    const exchange = makeRestExchange();
    const body = '{"access_token":"at-placeholder","ok":true}';
    const http = {
      ...exchange.http,
      headers: { 'content-type': 'application/json', location: 'https://h/next?token=loc-placeholder' },
      rawHeaders: [
        ['content-type', 'application/json'],
        ['set-cookie', 'sid=cookie-placeholder'],
        ['location', 'https://h/next?token=loc-placeholder'],
      ] as [string, string][],
      bodyBase64: b64(body),
      rawBodyBase64: b64(body),
    };
    const failure = makeFailure({
      request: {
        url: 'https://h/f?api_key=fk-placeholder',
        method: 'POST',
        headers: { 'X-Api-Key': 'xk-placeholder' },
      },
      rawRequestBase64: b64(
        'POST /f HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\npassword=fp-placeholder',
      ),
    });
    const text = JSON.stringify(
      harOf(
        [
          { kind: 'exchange', exchange: { ...exchange, http } },
          { kind: 'failure', failure },
        ],
        CREATOR,
      ),
    );
    for (const secret of [
      'at-placeholder',
      'cookie-placeholder',
      'loc-placeholder',
      'fk-placeholder',
      'xk-placeholder',
      'fp-placeholder',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('harOf — WebSocket', () => {
  it('exports the handshake as an ordinary GET/101 pair, _resourceType: websocket, no _webSocketMessages', () => {
    const entry = harOf([{ kind: 'exchange', exchange: makeWsHandshakeExchange() }], CREATOR).log.entries[0]!;
    expect(entry.request.method).toBe('GET');
    expect(entry.request.url).toBe('https://api.test/chat');
    expect(entry.response.status).toBe(101);
    expect(entry.response.headers).toEqual([{ name: 'sec-websocket-accept', value: 'abc123=' }]);
    expect(entry._resourceType).toBe('websocket');
    expect(entry).not.toHaveProperty('_webSocketMessages');
    requiredFieldsPresent(entry);
  });

  it('masks the handshake headers unless shown; the wsUrl is not part of the HAR (only the masked http(s):// url)', () => {
    const text = JSON.stringify(
      harOf(
        [
          {
            kind: 'exchange',
            exchange: makeWsHandshakeExchange({ requestHeaders: { Authorization: 'Bearer secret-tok' } }),
          },
        ],
        CREATOR,
      ),
    );
    expect(text).not.toContain('secret-tok');
  });

  it('a WebSocket failure row (refused handshake) produces a valid HAR entry', () => {
    const entry = harOf(
      [
        {
          kind: 'failure',
          failure: makeFailure({
            protocol: 'websocket',
            request: { url: 'ws://127.0.0.1:1/refuse', method: 'GET', headers: { Authorization: '<redacted>' } },
          }),
        },
      ],
      CREATOR,
    ).log.entries[0]!;
    expect(entry.request.method).toBe('GET');
    expect(entry.request.url).toBe('ws://127.0.0.1:1/refuse');
    expect(entry.response.status).toBe(0);
    expect(entry._error?.code).toBe('connection-refused');
    requiredFieldsPresent(entry);
  });
});

describe('harFileName', () => {
  it('is wirebench-yyyyMMdd-HHmmss.har in local time', () => {
    expect(harFileName(new Date(2026, 8, 18, 7, 5, 9))).toBe('wirebench-20260918-070509.har');
  });
});
