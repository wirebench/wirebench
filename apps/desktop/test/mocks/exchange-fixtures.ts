import type { InterfaceWire } from '../../src/shared/wire-types.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import type { AnyExchangeSummary } from '../../src/renderer/features/request-editor/response-status.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';

export { b64, makeExchange, makeFailure, makeGrpcExchange, makeRestExchange, makeWsExchange } from './wire-fixtures.js';

/** Wraps an exchange of either protocol as the HTTP Log entry the store keeps; `requestId` names its saved request. */
export function logExchange(exchange: AnyExchangeSummary, requestId?: string): LogEntry {
  return requestId === undefined ? { kind: 'exchange', exchange } : { kind: 'exchange', exchange, requestId };
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
    slug: 'Request 1',
    operationSlug: 'Add',
    envelopeXml: '<soap:Envelope><soap:Body><Add/></soap:Body></soap:Envelope>',
    soapVersion: '1.1',
    soapAction: 'http://tempuri.org/Add',
    endpointId: 'ep-1',
    headers: [],
    order: 0,
    ...overrides,
  } as RequestDraft;
}
