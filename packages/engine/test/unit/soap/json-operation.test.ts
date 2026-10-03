import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importWsdl } from '../../../src/soap/import.js';
import {
  envelopeFromJson,
  faultDetailJson,
  jsonFromEnvelope,
  operationJsonSchema,
} from '../../../src/soap/json-operation.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { bindingContextFor, validateMessage } from '../../../src/validate/index.js';
import { jsonSchemaOf } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';
const PLACE = { bindingName: { namespaceUri: BRIDGE, localName: 'BridgeSoap' }, operationName: 'PlaceOrder' };
const QUOTE = { bindingName: { namespaceUri: BRIDGE, localName: 'BridgeRpc' }, operationName: 'Quote' };

const ORDER = {
  '@channel': 'web',
  id: 7,
  customer: { name: 'Ada' },
  line: [{ sku: 'ABC-1', qty: 2 }],
  card: '4000',
  priority: 'LOW',
  placed: '2026-10-03',
  paid: true,
  total: 3,
};

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

describe('a SOAP operation as JSON', () => {
  it("takes a document/literal operation's arguments as its body element's content", () => {
    const { schema } = operationJsonSchema(wsdl, PLACE);
    const element = jsonSchemaOf(wsdl.schemaSet, { element: { namespaceUri: BRIDGE, localName: 'Order' } }).schema;
    expect(schema).toEqual(element);
  });

  it("takes an rpc operation's arguments as one property per part", () => {
    expect(operationJsonSchema(wsdl, QUOTE).schema).toEqual({
      type: 'object',
      properties: {
        item: { type: 'string' },
        count: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
      },
      required: ['item', 'count'],
      additionalProperties: false,
    });
  });

  it('builds an envelope the XSD check passes, with the binding transport', async () => {
    const built = envelopeFromJson(wsdl, PLACE, ORDER);
    expect(built.problems).toEqual([]);
    expect(built.soapVersion).toBe('1.1');
    expect(built.soapAction).toBe('urn:wb:bridge/PlaceOrder');
    const binding = bindingContextFor(wsdl.definition, PLACE, 'request');
    if (binding === undefined) throw new Error('no binding');
    const { problems } = await validateMessage({
      xml: built.envelopeXml,
      direction: 'request',
      schemaSet: wsdl.schemaSet,
      bundle: wsdl.bundle,
      binding,
    });
    expect(problems.filter((problem) => problem.severity === 'error')).toEqual([]);
    expect(jsonFromEnvelope(wsdl, PLACE, built.envelopeXml, 'request').value).toEqual(ORDER);
  });

  it('keeps a multi-line value exactly inside the envelope', () => {
    const built = envelopeFromJson(wsdl, PLACE, { ...ORDER, customer: { name: 'one\n  two' } });
    expect(built.envelopeXml).toContain('one\n  two');
  });

  it('refuses to build an envelope when a value cannot be written', () => {
    const built = envelopeFromJson(wsdl, PLACE, { ...ORDER, '#any': '<x>a & b</x>' });
    expect(built.problems).not.toEqual([]);
    expect(built.envelopeXml).toBe('');
    expect(built.soapAction).toBe('urn:wb:bridge/PlaceOrder');
  });

  it('wraps rpc parts in the operation element, in the binding namespace', () => {
    const built = envelopeFromJson(wsdl, QUOTE, { item: 'tea', count: 2 });
    expect(built.envelopeXml).toMatch(/<([A-Za-z][\w.-]*):Quote xmlns:\1="urn:wb:bridge:rpc">/);
    expect(jsonFromEnvelope(wsdl, QUOTE, built.envelopeXml, 'request').value).toEqual({ item: 'tea', count: 2 });
  });

  it('reads a response body as JSON', () => {
    const response =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
      '<r:OrderResult xmlns:r="urn:wb:bridge"><r:orderId>9</r:orderId><r:status>ok</r:status></r:OrderResult>' +
      '</soapenv:Body></soapenv:Envelope>';
    expect(jsonFromEnvelope(wsdl, PLACE, response)).toEqual({ value: { orderId: 9, status: 'ok' }, notes: [] });
  });

  it('reads a declared fault detail as JSON, and nothing else', () => {
    const detail =
      '<b:OrderFault xmlns:b="urn:wb:bridge"><b:reason>no stock</b:reason><b:code>4</b:code></b:OrderFault>';
    expect(faultDetailJson(wsdl, PLACE, detail)).toEqual({ value: { reason: 'no stock', code: 4 }, notes: [] });
    expect(faultDetailJson(wsdl, PLACE, '<other>1</other>')).toBeUndefined();
  });
});
