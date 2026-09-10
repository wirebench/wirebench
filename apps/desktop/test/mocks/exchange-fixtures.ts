import type { ExchangeSummary, InterfaceWire } from '../../src/shared/wire-types.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';

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
      timings: { startedAt: '2026-09-10T08:30:05.000Z', totalMs: 143, ttfbMs: 100 },
      redirects: [],
      request: { url: 'https://example.test/calc.asmx', method: 'POST', headers: {} },
    },
    response: { envelopeXml: body, version: '1.1', isSoap: true, attachments: [] },
    problems: [],
    ...overrides,
  };
}

/** The minimal interface the toolbar's endpoint picker and the explorer tree read. */
export function makeInterface(overrides: Partial<InterfaceWire> = {}): InterfaceWire {
  return {
    id: 'if-1',
    slug: 'Calculator',
    cacheDefinition: true,
    hydration: 'ready',
    endpoints: [
      { id: 'ep-1', name: 'Calculator CalculatorSoap', url: 'https://example.test/calc.asmx', authMode: 'override' },
      {
        id: 'ep-2',
        name: 'Calculator CalculatorSoap12',
        url: 'https://example.test/calc12.asmx',
        authMode: 'override',
      },
    ],
    defaultEndpointId: 'ep-1',
    name: 'Calculator',
    definitionUrl: 'https://example.test/calc.asmx?wsdl',
    targetNamespace: 'http://tempuri.org/',
    soapVersions: ['1.1'],
    services: [
      {
        name: 'Calculator',
        ports: [
          {
            name: 'CalculatorSoap',
            address: 'https://example.test/calc.asmx',
            binding: '{http://tempuri.org/}CalculatorSoap',
            soapVersion: '1.1',
          },
          {
            name: 'CalculatorSoap12',
            address: 'https://example.test/calc12.asmx',
            binding: '{http://tempuri.org/}CalculatorSoap12',
            soapVersion: '1.2',
          },
        ],
      },
    ],
    operations: [],
    problems: [],
    documentCount: 1,
    ...overrides,
  };
}

/**
 * A request pointing at the fixture interface's first endpoint. `overrides` is deliberately
 * loose so a test can drop an optional field (`{ endpointId: undefined }`), which
 * `exactOptionalPropertyTypes` forbids through `Partial<RequestDraft>`.
 */
type DraftOverrides = { -readonly [K in keyof RequestDraft]?: RequestDraft[K] | undefined };

export function makeDraft(overrides: DraftOverrides = {}): RequestDraft {
  return {
    id: 'req-1',
    interfaceId: 'if-1',
    bindingName: '{http://tempuri.org/}CalculatorSoap',
    operationName: 'Add',
    name: 'Request 1',
    envelopeXml: '<soap:Envelope><soap:Body><Add/></soap:Body></soap:Envelope>',
    soapVersion: '1.1',
    soapAction: 'http://tempuri.org/Add',
    endpointId: 'ep-1',
    headers: [],
    order: 0,
    ...overrides,
  } as RequestDraft;
}
