import { describe, expect, it } from 'vitest';
import { prettyPrintBody } from '../../src/renderer/features/history/history-format.js';
import { headerLines, restEntryTexts, restExchangeTexts } from '../../src/renderer/features/history/rest-diff-text.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';
import { b64, makeRestExchange } from '../mocks/wire-fixtures.js';

const XML = '<pet><name>Rex</name></pet>';

function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'a',
    kind: 'rest',
    at: '2026-09-26T10:00:00.000Z',
    projectId: 'p1',
    requestId: 'r-1',
    requestName: 'Pet',
    interfaceName: 'Petstore',
    operationName: '',
    endpoint: 'https://api.test/pets?api_key=%3Credacted%3E',
    method: 'POST',
    soapVersion: 'none',
    durationMs: 5,
    ok: true,
    status: 201,
    request: {
      envelopeXml: '{"name":"Rex","age":3}',
      headers: [
        { name: 'x-b', value: '2' },
        { name: 'Authorization', value: '<redacted>' },
        { name: 'X-A', value: '1' },
      ],
    },
    response: {
      envelopeXml: XML,
      rawHeaders: [
        ['Set-Cookie', 'a=1'],
        ['content-type', 'application/xml'],
        ['set-cookie', 'b=2'],
      ],
      status: 201,
      statusText: 'Created',
    },
    sizeBytes: 10,
    ...overrides,
  };
}

describe('headerLines', () => {
  it('sorts by name without regard to case, keeping the order and spelling of equal names', () => {
    expect(
      headerLines([
        ['Set-Cookie', 'a=1'],
        ['accept', '*/*'],
        ['set-cookie', 'b=2'],
      ]),
    ).toEqual(['accept: */*', 'Set-Cookie: a=1', 'set-cookie: b=2']);
  });
});

describe('restEntryTexts', () => {
  it('starts the response with the status line, then the sorted headers, then the body', () => {
    expect(restEntryTexts(restEntry()).response).toBe(
      [
        '201 Created',
        'content-type: application/xml',
        'Set-Cookie: a=1',
        'set-cookie: b=2',
        '',
        prettyPrintBody(XML),
      ].join('\n'),
    );
    // The XML body is re-indented, not left on one line.
    expect(prettyPrintBody(XML).split('\n').length).toBeGreaterThan(1);
  });

  it('starts the request with the request line and leaves redacted values as recorded', () => {
    expect(restEntryTexts(restEntry()).request).toBe(
      [
        'POST https://api.test/pets?api_key=%3Credacted%3E',
        'Authorization: <redacted>',
        'X-A: 1',
        'x-b: 2',
        '',
        '{',
        '  "name": "Rex",',
        '  "age": 3',
        '}',
      ].join('\n'),
    );
  });

  it('says there was no response, with the error code, for a failed send', () => {
    const failed = restEntry({ error: { code: 'connection-refused', message: 'refused' } });
    delete failed.response;
    expect(restEntryTexts(failed).response).toBe('No response (connection-refused)\n\n');
  });

  it('reads a status with no reason phrase as the bare status, with no trailing space', () => {
    const noReason = restEntry({
      response: { envelopeXml: '', rawHeaders: [], status: 204, statusText: '' },
    });
    expect(restEntryTexts(noReason).response).toBe('204\n\n');
  });
});

describe('restExchangeTexts', () => {
  it('builds the Current side from the exchange, with the headers as sent and the raw request body', () => {
    const exchange = makeRestExchange({
      method: 'POST',
      url: 'https://api.test/pets?api_key=%3Credacted%3E',
      text: '{"id":1}',
      http: {
        ...makeRestExchange().http,
        status: 201,
        statusText: 'Created',
        rawHeaders: [
          ['X-Id', '1'],
          ['content-type', 'application/json'],
        ],
        rawRequestBase64: b64('POST /pets HTTP/1.1\r\nHost: api.test\r\n\r\n{"name":"Rex"}'),
        request: {
          url: 'https://api.test/pets?api_key=%3Credacted%3E',
          method: 'POST',
          headers: { 'User-Agent': 'wirebench', Authorization: '<redacted>', 'Content-Type': 'application/json' },
        },
      },
    });
    expect(restExchangeTexts(exchange)).toEqual({
      response: ['201 Created', 'content-type: application/json', 'X-Id: 1', '', '{', '  "id": 1', '}'].join('\n'),
      request: [
        'POST https://api.test/pets?api_key=%3Credacted%3E',
        'Authorization: <redacted>',
        'Content-Type: application/json',
        'User-Agent: wirebench',
        '',
        '{',
        '  "name": "Rex"',
        '}',
      ].join('\n'),
    });
  });

  it('reads a status with no reason phrase as the bare status, with no trailing space', () => {
    const exchange = makeRestExchange({
      text: '',
      http: { ...makeRestExchange().http, status: 204, statusText: '', rawHeaders: [] },
    });
    expect(restExchangeTexts(exchange).response).toBe('204\n\n');
  });

  it('recovers the raw request body when the head only has an LF-LF separator', () => {
    const exchange = makeRestExchange({
      http: {
        ...makeRestExchange().http,
        rawRequestBase64: b64('POST /pets HTTP/1.1\nHost: api.test\n\n{"name":"Rex"}'),
      },
    });
    expect(restExchangeTexts(exchange).request.endsWith(prettyPrintBody('{"name":"Rex"}'))).toBe(true);
  });

  it('reads an empty body when the raw request has no head/body separator at all', () => {
    const exchange = makeRestExchange({
      http: { ...makeRestExchange().http, rawRequestBase64: b64('GET /pet/1 HTTP/1.1') },
    });
    expect(restExchangeTexts(exchange).request).toBe(`${exchange.method} ${exchange.url}\n\n`);
  });

  it('pretty-prints an XML body from a RestExchangeSummary', () => {
    const exchange = makeRestExchange({ text: XML });
    expect(restExchangeTexts(exchange).response.endsWith(prettyPrintBody(XML))).toBe(true);
    expect(prettyPrintBody(XML).split('\n').length).toBeGreaterThan(1);
  });

  it('builds the same shape as restEntryTexts for the same request and response', () => {
    const entry = restEntry({
      method: 'POST',
      endpoint: 'https://api.test/pets',
      request: {
        envelopeXml: '{"name":"Rex"}',
        headers: [
          { name: 'Authorization', value: '<redacted>' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      response: {
        envelopeXml: '{"id":1}',
        rawHeaders: [
          ['X-Id', '1'],
          ['content-type', 'application/json'],
        ],
        status: 201,
        statusText: 'Created',
      },
    });
    const exchange = makeRestExchange({
      method: 'POST',
      url: 'https://api.test/pets',
      text: '{"id":1}',
      http: {
        ...makeRestExchange().http,
        status: 201,
        statusText: 'Created',
        rawHeaders: [
          ['X-Id', '1'],
          ['content-type', 'application/json'],
        ],
        rawRequestBase64: b64('POST /pets HTTP/1.1\r\nHost: api.test\r\n\r\n{"name":"Rex"}'),
        request: {
          url: 'https://api.test/pets',
          method: 'POST',
          headers: { Authorization: '<redacted>', 'Content-Type': 'application/json' },
        },
      },
    });
    expect(restExchangeTexts(exchange)).toEqual(restEntryTexts(entry));
  });
});
