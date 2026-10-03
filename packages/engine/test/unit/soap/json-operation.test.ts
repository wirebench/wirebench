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

const SHAPES_FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/shapes.wsdl', import.meta.url));
const SHAPES = 'urn:wb:shapes';
const shapesOp = (binding: string, operationName: string) => ({
  bindingName: { namespaceUri: SHAPES, localName: binding },
  operationName,
});
const GROW = shapesOp('ShapesSoap', 'Grow');
const SAY = shapesOp('ShapesSoap', 'Say');
const CARRY = shapesOp('ShapesSoap', 'Carry');
const BOTH = shapesOp('ShapesSoap', 'Both');
const ASK = shapesOp('ShapesRpc', 'Ask');

const envelope = (body: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  body +
  '</soapenv:Body></soapenv:Envelope>';

describe('the shapes of a SOAP body as JSON', () => {
  let shapes: WsdlImportResult;

  beforeAll(async () => {
    shapes = await importWsdl({ kind: 'file', path: SHAPES_FIXTURE });
  });

  it('takes a self-referencing body element as an object of its own content', () => {
    const { schema } = operationJsonSchema(shapes, GROW);
    expect(schema['type']).toBe('object');
    expect(schema['properties']).toHaveProperty('label');
    expect(schema['properties']).not.toHaveProperty('#text');
    const args = { label: 'a', Tree: [{ label: 'b' }] };
    const built = envelopeFromJson(shapes, GROW, args);
    expect(built.problems).toEqual([]);
    expect(jsonFromEnvelope(shapes, GROW, built.envelopeXml, 'request')).toEqual({ value: args, notes: [] });
  });

  it('takes a simple-type body element as #text, and reads it back', () => {
    expect(operationJsonSchema(shapes, SAY).schema).toEqual({
      type: 'object',
      properties: { '#text': { type: 'integer', minimum: -2147483648, maximum: 2147483647 } },
      required: ['#text'],
      additionalProperties: false,
    });
    const built = envelopeFromJson(shapes, SAY, { '#text': 5 });
    expect(built.problems).toEqual([]);
    expect(built.envelopeXml).toMatch(/<([A-Za-z][\w.-]*):Note xmlns:\1="urn:wb:shapes">5<\/\1:Note>/);
    expect(jsonFromEnvelope(shapes, SAY, built.envelopeXml, 'request')).toEqual({ value: { '#text': 5 }, notes: [] });
  });

  it('takes an anyType body element as #text holding its fragment', () => {
    const { schema } = operationJsonSchema(shapes, CARRY);
    expect(schema['required']).toEqual(['#text']);
    const built = envelopeFromJson(shapes, CARRY, { '#text': '<x>1</x>' });
    expect(built.problems).toEqual([]);
    expect(built.envelopeXml).toMatch(/:Blob xmlns:[\w.-]+="urn:wb:shapes">\s*<x>1<\/x>\s*<\//);
    expect(jsonFromEnvelope(shapes, CARRY, built.envelopeXml, 'request').value).toEqual({ '#text': '<x>1</x>' });
  });

  it('keeps a body element of another name as its XML, with a note', () => {
    const wrong = '<t:Wrong xmlns:t="urn:wb:shapes"><t:label>a</t:label></t:Wrong>';
    expect(jsonFromEnvelope(shapes, GROW, envelope(wrong))).toEqual({
      value: wrong,
      notes: ['the SOAP Body holds {urn:wb:shapes}Wrong, not {urn:wb:shapes}Tree; kept as its XML'],
    });
  });

  it('notes a second body element it does not read', () => {
    const tree = '<t:Tree xmlns:t="urn:wb:shapes"><t:label>a</t:label></t:Tree>';
    expect(jsonFromEnvelope(shapes, GROW, envelope(tree + '<t:Extra xmlns:t="urn:wb:shapes"/>'))).toEqual({
      value: { label: 'a' },
      notes: ['the SOAP Body holds {urn:wb:shapes}Extra after the body element; not read'],
    });
  });

  it('keeps an rpc wrapper of another name as its XML, with a note', () => {
    const wrong = '<r:Other xmlns:r="urn:wb:shapes:rpc"><item>tea</item></r:Other>';
    expect(jsonFromEnvelope(shapes, ASK, envelope(wrong), 'request')).toEqual({
      value: wrong,
      notes: ['the SOAP Body holds {urn:wb:shapes:rpc}Other, not {urn:wb:shapes:rpc}Ask; kept as its XML'],
    });
  });

  it('notes a missing part and keeps an undeclared child as its XML', () => {
    const body = '<r:Ask xmlns:r="urn:wb:shapes:rpc"><item>tea</item><extra>1</extra></r:Ask>';
    expect(jsonFromEnvelope(shapes, ASK, envelope(body), 'request')).toEqual({
      value: { item: 'tea', extra: '<extra>1</extra>' },
      notes: ['count: the message has no element for this part', 'extra: not a part of Ask; kept as its XML'],
    });
  });

  it('reads document parts by element name and keeps the rest as XML', () => {
    const body =
      '<t:Note xmlns:t="urn:wb:shapes">5</t:Note>' +
      '<t:Tree xmlns:t="urn:wb:shapes"><t:label>a</t:label></t:Tree>' +
      '<t:Stray xmlns:t="urn:wb:shapes">x</t:Stray>';
    expect(jsonFromEnvelope(shapes, BOTH, envelope(body))).toEqual({
      value: { note: 5, tree: { label: 'a' }, Stray: '<t:Stray xmlns:t="urn:wb:shapes">x</t:Stray>' },
      notes: ['Stray: not a part of Both; kept as its XML'],
    });
  });
});
