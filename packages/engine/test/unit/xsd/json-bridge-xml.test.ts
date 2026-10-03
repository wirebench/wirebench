import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import type { BridgeTarget } from '../../../src/xsd/json-bridge.js';
import { jsonFromXml, jsonSchemaOf, xmlFromJson } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';
const LOOSE = 'urn:wb:bridge:loose';

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

const element = (localName: string, namespaceUri = BRIDGE): BridgeTarget => ({
  element: { namespaceUri, localName },
});

function roundTrip(
  localName: string | BridgeTarget,
  value: unknown,
): { xml: string; back: unknown; notes: readonly string[] } {
  const target = typeof localName === 'string' ? element(localName) : localName;
  const written = xmlFromJson(wsdl.schemaSet, target, value);
  expect(written.problems).toEqual([]);
  const read = jsonFromXml(wsdl.schemaSet, target, written.xml);
  return { xml: written.xml, back: read.value, notes: [...written.notes, ...read.notes] };
}

const ORDER = {
  '@channel': 'web',
  id: 7,
  customer: { name: 'Ada', email: 'ada@example.com' },
  line: [
    { sku: 'ABC-1', qty: 2 },
    { sku: 'XYZ-22', qty: 1 },
  ],
  note: null,
  invoice: { '@days': 30 },
  priority: 'HIGH',
  placed: '2026-10-03',
  paid: false,
  total: 12.5,
  '#any': '<x:extra xmlns:x="urn:other">kept</x:extra>',
};

/** `{ label, child: [{ label, child: [...] }] }`, `depth` levels deep. */
function tree(depth: number): unknown {
  return depth === 0 ? { label: '0' } : { label: String(depth), child: [tree(depth - 1)] };
}

/** `{ label, Node: { label, Node: ... } }`, `depth` levels deep: an anonymous type reaching itself. */
function chain(depth: number): unknown {
  return depth === 0 ? { label: '0' } : { label: String(depth), Node: chain(depth - 1) };
}

describe('xmlFromJson and jsonFromXml', () => {
  it('round-trips a sequence with attributes, a choice, a nil, repeats and a wildcard', () => {
    const { xml, back, notes } = roundTrip('Order', ORDER);
    expect(back).toEqual(ORDER);
    expect(notes).toEqual([]);
    // Element order follows the XSD, not the JSON.
    expect(xml.indexOf(':customer')).toBeLessThan(xml.indexOf(':priority'));
    expect(xml).toContain('xsi:nil="true"');
    expect(xml).toContain('days="30"');
    expect(xml).toContain('<x:extra xmlns:x="urn:other">kept</x:extra>');
    expect(xml).not.toContain(':card');
  });

  it('writes recursion deeper than the form cuts it, rebuilding from its own XML', () => {
    const value = tree(9);
    expect(roundTrip('Root', value).back).toEqual(value);
  });

  it('writes a self-recursive anonymous type deeper than the form cuts it', () => {
    const value = chain(8);
    const { xml, back } = roundTrip('Node', value);
    expect(back).toEqual(value);
    expect(xml.match(/<\/[a-z0-9]+:Node>/g)).toHaveLength(9);
  });

  it('round-trips simple content, mixed content, a repeating sequence and a prefixed key', () => {
    expect(roundTrip('Price', { '@currency': 'EUR', '#text': 9.99 }).back).toEqual({
      '@currency': 'EUR',
      '#text': 9.99,
    });
    expect(roundTrip('Remark', { '#text': 'hello world', em: 'there' }).back).toEqual({
      '#text': 'hello world',
      em: 'there',
    });
    const steps = {
      '#sequence': [
        { name: 'a', wait: 1 },
        { name: 'b', wait: 2 },
      ],
    };
    expect(roundTrip('Steps', steps).back).toEqual(steps);
    const keys = Object.keys(jsonSchemaOf(wsdl.schemaSet, element('Pair')).schema['properties'] as object);
    const pair = { id: 1, [keys[1] ?? '']: 'loose' };
    expect(roundTrip('Pair', pair).back).toEqual(pair);
  });

  it('round-trips an element of an unqualified schema, its children unqualified', () => {
    const value = { a: 'x', b: 3 };
    const { xml, back } = roundTrip(element('Loose', LOOSE), value);
    expect(back).toEqual(value);
    expect(xml).toMatch(/<a>x<\/a>/);
    expect(xml).toMatch(/<b>3<\/b>/);
  });

  it('round-trips an element named here whose content is a type', () => {
    const target: BridgeTarget = {
      name: { namespaceUri: '', localName: 'tree' },
      type: { namespaceUri: BRIDGE, localName: 'Tree' },
    };
    const value = tree(2);
    const { xml, back } = roundTrip(target, value);
    expect(back).toEqual(value);
    expect(xml.startsWith('<tree')).toBe(true);
  });

  it('writes an anyType value as text or as a fragment', () => {
    const base = { code: 'a1', small: 1, hex: 'FF', at: '2026-10-03T10:00:00Z', token: 't' };
    expect(roundTrip('Tagged', { ...base, free: 'plain &amp; simple' }).back).toEqual({
      ...base,
      free: 'plain &amp; simple',
    });
    expect(roundTrip('Tagged', { ...base, free: '<a>b</a>' }).back).toEqual({ ...base, free: '<a>b</a>' });
  });

  it('keeps a multi-line string exactly', () => {
    const value = { ...ORDER, customer: { name: 'line one\n   line two' } };
    expect(roundTrip('Order', value).back).toEqual(value);
  });

  it('refuses a wildcard fragment that is not well formed', () => {
    const written = xmlFromJson(wsdl.schemaSet, element('Order'), { ...ORDER, '#any': '<a><b></a>' });
    expect(written.problems).toEqual([expect.stringContaining('#any')]);
    expect(written.xml).toBe('');
  });

  it('notes a null for an element that is not nillable', () => {
    const written = xmlFromJson(wsdl.schemaSet, element('Order'), { ...ORDER, total: null });
    expect(written.problems).toEqual([]);
    expect(written.notes).toEqual([expect.stringContaining('total')]);
    expect(written.xml).not.toContain(':total');
  });

  it('reports an element the schema does not have', () => {
    const written = xmlFromJson(wsdl.schemaSet, element('Missing'), {});
    expect(written.problems).toEqual([expect.stringContaining('Missing')]);
  });

  it('reads arrays from maxOccurs, keeps untyped values as strings, and notes what the schema lacks', () => {
    const xml =
      '<r:OrderResult xmlns:r="urn:wb:bridge"><r:orderId>x7</r:orderId><r:status>ok</r:status>' +
      '<r:tags>a</r:tags><r:surprise>1</r:surprise></r:OrderResult>';
    const { value, notes } = jsonFromXml(wsdl.schemaSet, element('OrderResult'), xml);
    expect(value).toEqual({
      orderId: 'x7',
      status: 'ok',
      tags: ['a'],
      surprise: '<r:surprise>1</r:surprise>',
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('orderId');
    expect(notes[1]).toContain('surprise');
  });

  it('reads booleans from 1 and 0, and keeps an unsafe integer as a string', () => {
    const xml =
      '<r:Order xmlns:r="urn:wb:bridge" channel="c"><r:id>99999999999999999999</r:id>' + '<r:paid>1</r:paid></r:Order>';
    const { value, notes } = jsonFromXml(wsdl.schemaSet, element('Order'), xml);
    expect(value).toMatchObject({ '@channel': 'c', id: '99999999999999999999', paid: true });
    expect(notes).toEqual([expect.stringContaining('id')]);
  });
});
