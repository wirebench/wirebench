import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateJsonSchema } from '../../../src/json/schema-validate.js';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { createJsonSchemaWriter, jsonSchemaOf } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';
const XSD = 'http://www.w3.org/2001/XMLSchema';

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

const element = (localName: string, namespaceUri = BRIDGE) => ({ element: { namespaceUri, localName } });

describe('jsonSchemaOf', () => {
  it('maps a sequence, its attributes, occurrences, facets and named types', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Order'));

    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['@channel', 'id', 'customer', 'line', 'priority', 'placed', 'paid', 'total'],
      properties: {
        '@channel': { type: 'string' },
        id: { type: 'integer', minimum: -2147483648, maximum: 2147483647, description: 'The order number.' },
        customer: { $ref: '#/$defs/Customer' },
        line: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Line' } },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        card: { type: 'string' },
        invoice: {
          type: 'object',
          properties: { '@days': { type: 'integer' } },
          required: ['@days'],
          additionalProperties: false,
        },
        priority: { type: 'string', enum: ['LOW', 'HIGH'] },
        placed: { type: 'string', format: 'date' },
        paid: { type: 'boolean' },
        total: { type: 'number' },
        blob: { type: 'string', contentEncoding: 'base64' },
        '#any': { type: 'string' },
      },
      $defs: {
        Customer: {
          type: 'object',
          properties: { name: { type: 'string' }, email: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        Line: {
          type: 'object',
          properties: {
            sku: { type: 'string', pattern: '^(?:[A-Z]{3}-\\d+)$' },
            qty: { type: 'integer', minimum: 1, maximum: 99 },
          },
          required: ['sku', 'qty'],
        },
      },
    });
    expect(Object.keys(schema['properties'] as object)).toEqual([
      '@channel',
      'id',
      'customer',
      'line',
      'note',
      'card',
      'invoice',
      'priority',
      'placed',
      'paid',
      'total',
      'blob',
      '#any',
    ]);
  });

  it('turns a choice into one oneOf option per branch, each forbidding the others', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Order'));
    expect(schema['allOf']).toEqual([
      {
        oneOf: [
          { required: ['card'], not: { anyOf: [{ required: ['invoice'] }] } },
          { required: ['invoice'], not: { anyOf: [{ required: ['card'] }] } },
        ],
      },
    ]);
    const valid = {
      '@channel': 'web',
      id: 1,
      customer: { name: 'Ann' },
      line: [{ sku: 'ABC-1', qty: 1 }],
      card: 'x',
      priority: 'LOW',
      placed: '2026-10-03',
      paid: true,
      total: 1,
    };
    expect(validateJsonSchema(valid, schema)).toEqual([]);
    expect(validateJsonSchema({ ...valid, invoice: { '@days': 3 } }, schema).map((p) => p.keyword)).toContain('oneOf');
    const neither = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'card'));
    expect(validateJsonSchema(neither, schema).map((p) => p.keyword)).toContain('oneOf');
  });

  it('handles recursion through $defs, and inlines the root even when its type is named', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Root'));
    expect(schema).toMatchObject({
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        child: { type: 'array', items: { $ref: '#/$defs/Tree' } },
      },
      $defs: {
        Tree: {
          type: 'object',
          properties: { label: { type: 'string' }, child: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
        },
      },
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it('maps simple content with attributes, and mixed content, to #text beside the @ properties', () => {
    expect(jsonSchemaOf(wsdl.schemaSet, element('Price')).schema).toEqual({
      type: 'object',
      properties: { '@currency': { type: 'string' }, '#text': { type: 'number' } },
      required: ['@currency'],
      additionalProperties: false,
    });
    expect(jsonSchemaOf(wsdl.schemaSet, element('Remark')).schema).toEqual({
      type: 'object',
      properties: { '#text': { type: 'string' }, em: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('maps the built-in families, leaves out a pattern JSON Schema cannot say, and notes it', () => {
    const { schema, notes } = jsonSchemaOf(wsdl.schemaSet, element('Tagged'));
    expect(schema['properties']).toEqual({
      code: { type: 'string' },
      small: { type: 'integer', minimum: -32768, maximum: 32767 },
      hex: { type: 'string', contentEncoding: 'base16' },
      at: { type: 'string', format: 'date-time' },
      token: { type: 'string' },
      free: { type: 'string', description: 'An XML fragment, inserted as written' },
    });
    expect(notes).toEqual([expect.stringContaining('\\i\\c*')]);
  });

  it('maps a repeating compositor to an array under #sequence', () => {
    expect(jsonSchemaOf(wsdl.schemaSet, element('Steps')).schema).toEqual({
      type: 'object',
      properties: {
        '#sequence': {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              wait: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
            },
            required: ['name', 'wait'],
            additionalProperties: false,
          },
        },
      },
      required: ['#sequence'],
      additionalProperties: false,
    });
  });

  it('keeps two children of one local name from two namespaces, the second prefixed', () => {
    const keys = Object.keys(jsonSchemaOf(wsdl.schemaSet, element('Pair')).schema['properties'] as object);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('id');
    expect(keys[1]).toMatch(/^[A-Za-z][\w.-]*:id$/);
  });

  it('maps xs:all, exclusive bounds, length, anyURI, time and float/double, and leaves out a \\p{} pattern', () => {
    const { schema, notes } = jsonSchemaOf(wsdl.schemaSet, element('Facets'));
    expect(schema).toEqual({
      type: 'object',
      properties: {
        open: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 },
        fixed: { type: 'string', minLength: 4, maxLength: 4 },
        link: { type: 'string' },
        at: { type: 'string', format: 'time' },
        ratio: { type: 'number' },
        big: { type: 'number' },
        letters: { type: 'string' },
      },
      required: ['open', 'fixed', 'link', 'at', 'ratio', 'big'],
      additionalProperties: false,
    });
    expect(notes).toEqual([expect.stringContaining('\\p{L}+')]);
    const valid = { open: 5, fixed: 'abcd', link: 'urn:x', at: '10:00:00', ratio: 1.5, big: 2 };
    expect(validateJsonSchema(valid, schema)).toEqual([]);
    expect(validateJsonSchema({ ...valid, open: 10 }, schema)).not.toEqual([]);
    expect(validateJsonSchema({ ...valid, fixed: 'abc' }, schema)).not.toEqual([]);
  });

  it('maps a type target (an rpc part), and shares $defs across targets of one writer', () => {
    expect(
      jsonSchemaOf(wsdl.schemaSet, {
        name: { namespaceUri: '', localName: 'count' },
        type: { namespaceUri: XSD, localName: 'int' },
      }).schema,
    ).toEqual({ type: 'integer', minimum: -2147483648, maximum: 2147483647 });

    const writer = createJsonSchemaWriter(wsdl.schemaSet);
    writer.schemaOf(element('Order'));
    writer.schemaOf(element('Root'));
    expect(Object.keys(writer.defs() ?? {})).toEqual(['Customer', 'Line', 'Tree']);
  });
});
