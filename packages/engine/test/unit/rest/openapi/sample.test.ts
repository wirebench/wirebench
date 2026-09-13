/**
 * Golden samples for the crafted schema fixtures.
 *
 * Every expectation here is written out in full rather than computed, because the point of the
 * generator is that its output is predictable enough to paste into a request and read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import type { JsonSchema, OpenApiDocument } from '../../../../src/rest/openapi/model.js';
import { MAX_SAMPLE_DEPTH, sampleFromSchema, sampleXml } from '../../../../src/rest/openapi/sample.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

const fetchDocument = ((location: string) => {
  const text = readFileSync(fileURLToPath(location), 'utf-8');
  return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
}) as FetchDocument;

/** The crafted fixture in `name/openapi.yaml`, parsed and resolved. */
async function fixture(name: string): Promise<OpenApiDocument> {
  const parsed = await parseOpenApi(
    { kind: 'file', path: pathToFileURL(`${craftedDir}${name}/openapi.yaml`).href },
    { fetchDocument },
  );
  return parsed.document;
}

/** The JSON request-body schema of the operation at `path`, which the fixtures all give one. */
function jsonBody(document: OpenApiDocument, path: string): JsonSchema {
  const operation = document.operations.find((candidate) => candidate.path === path);
  const schema = operation?.requestBody?.content['application/json']?.schema;
  if (schema === undefined) {
    throw new Error(`no JSON body schema for ${path}`);
  }
  return schema;
}

describe('sampleFromSchema', () => {
  it('merges an allOf into one object, keeping every branch’s required properties', async () => {
    const schema = jsonBody(await fixture('schemas'), '/all-of');

    expect(sampleFromSchema(schema)).toEqual({ id: 0 });
    expect(sampleFromSchema(schema, { includeOptional: true })).toEqual({ id: 0, name: '' });
  });

  it('takes the first branch of a oneOf, and its stated default', async () => {
    const schema = jsonBody(await fixture('schemas'), '/one-of');

    // Nothing in the first branch is required, so the preference is the whole difference.
    expect(sampleFromSchema(schema)).toEqual({});
    expect(sampleFromSchema(schema, { includeOptional: true })).toEqual({ cat: 'whiskers' });
  });

  it('leaves strings empty unless sample values are asked for, then fills a format in', async () => {
    const schema = jsonBody(await fixture('schemas'), '/formats');

    expect(sampleFromSchema(schema)).toEqual({ when: '', id: '', email: '', home: '' });
    expect(sampleFromSchema(schema, { sampleValues: true })).toEqual({
      when: '2026-01-01T00:00:00Z',
      id: '00000000-0000-4000-8000-000000000000',
      email: 'user@example.com',
      home: 'https://example.com',
    });
  });

  it('generates one array item, and reads an enum as a stated value', async () => {
    const schema = jsonBody(await fixture('schemas'), '/nested');

    expect(sampleFromSchema(schema)).toEqual({ tags: ['red'], pet: { name: '' } });
    expect(sampleFromSchema(schema, { includeOptional: true })).toEqual({
      tags: ['red'],
      pet: { name: '', age: 0, good: false },
    });
  });

  it('understands 3.1’s examples array, nullable type list, and const', async () => {
    const schema = jsonBody(await fixture('v31'), '/pets');

    expect(sampleFromSchema(schema)).toEqual({ name: 'Fido', nickname: '', kind: 'dog' });
  });

  it('ends a self-referencing schema in a finite document', async () => {
    const schema = jsonBody(await fixture('cycle'), '/nodes');

    // The resolver cuts the repeat, leaving a `$ref` the generator has nothing to expand.
    expect(sampleFromSchema(schema)).toEqual({ name: '', child: null });
    expect(sampleFromSchema(schema, { includeOptional: true })).toEqual({ name: '', child: null, peers: [null] });
  });

  it('stops at the depth cap rather than recursing forever', () => {
    const leaf: JsonSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    let nested: JsonSchema = leaf;
    for (let level = 0; level < MAX_SAMPLE_DEPTH + 3; level += 1) {
      nested = { type: 'object', required: ['next'], properties: { next: nested } };
    }

    const sample = sampleFromSchema(nested);

    let depth = 0;
    let cursor: unknown = sample;
    while (typeof cursor === 'object' && cursor !== null && 'next' in cursor) {
      depth += 1;
      cursor = cursor.next;
    }
    expect(depth).toBe(MAX_SAMPLE_DEPTH);
    expect(cursor).toBeNull();
  });

  it('honours a smaller budget when one is given', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['inner'],
      properties: { inner: { type: 'object', required: ['deep'], properties: { deep: { type: 'string' } } } },
    };

    expect(sampleFromSchema(schema, { maxDepth: 2 })).toEqual({ inner: { deep: null } });
  });

  it('leaves a read-only property out, because the client never sends one', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } },
    };

    expect(sampleFromSchema(schema, { includeOptional: true })).toEqual({ name: '' });
  });

  it('says nothing about a value the schema says nothing about', () => {
    expect(sampleFromSchema({})).toBeNull();
    expect(sampleFromSchema({ type: 'object' })).toEqual({});
    expect(sampleFromSchema({ type: 'array' })).toEqual([]);
    // No `type`, but a shape: read as the shape, which is what every reader assumes.
    expect(sampleFromSchema({ properties: { a: { type: 'string' } }, required: ['a'] })).toEqual({ a: '' });
    expect(sampleFromSchema({ items: { type: 'integer' } })).toEqual([0]);
  });

  it('is deterministic, down to property order', async () => {
    const schema = jsonBody(await fixture('schemas'), '/nested');

    const first = JSON.stringify(sampleFromSchema(schema, { includeOptional: true, sampleValues: true }));
    const second = JSON.stringify(sampleFromSchema(schema, { includeOptional: true, sampleValues: true }));

    expect(first).toBe(second);
    expect(first).toBe('{"tags":["red"],"pet":{"name":"","age":0,"good":false}}');
  });
});

describe('sampleXml', () => {
  it('names the root from the schema’s xml object', async () => {
    const schema = xmlBody(await fixture('bodies'));

    expect(sampleXml(schema)).toBe('<pet/>');
    expect(sampleXml(schema, { includeOptional: true })).toBe('<pet>\n  <name>Fido</name>\n</pet>');
  });

  it('falls back to the given root name, then to a plain one', () => {
    expect(sampleXml({ type: 'string', example: 'hi' }, { rootName: 'note' })).toBe('<note>hi</note>');
    expect(sampleXml({ type: 'string' })).toBe('<root></root>');
  });

  it('renders attributes, wrapped arrays and namespaces the way the xml object asks', () => {
    const schema: JsonSchema = {
      type: 'object',
      xml: { name: 'order', namespace: 'urn:orders' },
      required: ['id', 'items'],
      properties: {
        id: { type: 'string', xml: { attribute: true }, example: 'A-1' },
        items: {
          type: 'array',
          xml: { wrapped: true },
          items: {
            type: 'object',
            xml: { name: 'item' },
            required: ['sku'],
            properties: { sku: { type: 'string', example: 'X' } },
          },
        },
        tags: { type: 'array', items: { type: 'string', xml: { name: 'tag' }, example: 't' } },
      },
    };

    expect(sampleXml(schema)).toBe(
      [
        '<order xmlns="urn:orders" id="A-1">',
        '  <items>',
        '    <item>',
        '      <sku>X</sku>',
        '    </item>',
        '  </items>',
        '</order>',
      ].join('\n'),
    );
    // Unwrapped: the items repeat in place under their own name, XML's own default for a list.
    expect(sampleXml(schema, { includeOptional: true })).toContain('\n  <tag>t</tag>\n');
  });

  it('declares a prefixed namespace on the element that carries the prefix', () => {
    const schema: JsonSchema = {
      type: 'object',
      xml: { name: 'pet', prefix: 'p', namespace: 'urn:pets' },
      required: ['name'],
      properties: { name: { type: 'string', example: 'Fido' } },
    };

    expect(sampleXml(schema)).toBe('<p:pet xmlns:p="urn:pets">\n  <name>Fido</name>\n</p:pet>');
  });

  it('escapes text and attribute values', () => {
    const schema: JsonSchema = {
      type: 'object',
      xml: { name: 'note' },
      required: ['body', 'q'],
      properties: {
        q: { type: 'string', xml: { attribute: true }, example: 'a "quoted" value' },
        body: { type: 'string', example: '<b>&</b>' },
      },
    };

    expect(sampleXml(schema)).toBe(
      '<note q="a &quot;quoted&quot; value">\n  <body>&lt;b&gt;&amp;&lt;/b&gt;</body>\n</note>',
    );
  });

  it('closes an element it cannot go deeper into, so the document stays well formed', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['inner'],
      properties: { inner: { type: 'object', required: ['deep'], properties: { deep: { type: 'string' } } } },
    };

    expect(sampleXml(schema, { rootName: 'a', maxDepth: 1 })).toBe('<a>\n  <inner/>\n</a>');
  });

  it('indents by the width asked for', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', example: 'Fido' } },
    };

    expect(sampleXml(schema, { rootName: 'pet', indent: '    ' })).toBe('<pet>\n    <name>Fido</name>\n</pet>');
  });
});

/** The `bodies` fixture's XML operation schema, which is the only fixture carrying an `xml` object. */
function xmlBody(document: OpenApiDocument): JsonSchema {
  const operation = document.operations.find((candidate) => candidate.path === '/xml');
  const schema = operation?.requestBody?.content['application/xml']?.schema;
  if (schema === undefined) {
    throw new Error('no XML body schema');
  }
  return schema;
}
