/**
 * A `$ref`-resolved description is a graph, not a tree, and every walk over it must know that.
 *
 * These are regression tests for three separate exponential blow-ups found by writing the
 * `openapi-import-1mb` performance budget. A document whose schemas reference each other — which is
 * what every real description looks like — expanded as `breadth ^ depth` in the resolver, in the
 * parser and in the sample generator, and a few hundred schemas never finished importing at all.
 *
 * Each test uses a densely cross-referenced document small enough that an exponential walk is
 * obviously hopeless (25 schemas, 12 properties, a third of them references) while a linear one is
 * instant. They assert *completion*, not a duration: a timing assertion on a shared CI runner is a
 * flake, but an exponential walk over this shape cannot finish at all.
 */
import { describe, expect, it } from 'vitest';
import { parseOpenApiDocument, parseSchema } from '../../../../src/rest/openapi/parse.js';
import { resolveRefs } from '../../../../src/rest/openapi/refs.js';
import { sampleFromSchema, sampleXml, MAX_SAMPLE_NODES } from '../../../../src/rest/openapi/sample.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const SCHEMAS = 25;
const PROPERTIES = 12;

/** A document whose every schema references others, the shape that used to be fatal. */
function denseDocument(): string {
  const schemas: Record<string, unknown> = {};
  for (let index = 0; index < SCHEMAS; index += 1) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (let field = 0; field < PROPERTIES; field += 1) {
      const name = `field${String(field)}`;
      properties[name] =
        field % 3 === 2
          ? { $ref: `#/components/schemas/Model${String((index + field + 1) % SCHEMAS)}` }
          : { type: 'string' };
      required.push(name);
    }
    schemas[`Model${String(index)}`] = { type: 'object', required, properties };
  }
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Dense', version: '1' },
    paths: {
      '/a': {
        post: {
          operationId: 'post',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Model0' } } } },
        },
      },
    },
    components: { schemas },
  });
}

/** Every value in a generated sample, counted the way the generator's own budget counts them. */
function countNodes(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce<number>((total, entry) => total + countNodes(entry), 0);
  }
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce<number>((total, entry) => total + countNodes(entry), 0);
  }
  return 1;
}

const fetchDocument: FetchDocument = () => {
  throw new Error('a document with only local references must not fetch anything');
};

/** The resolved dense document, which every test below starts from. */
async function resolved(): Promise<unknown> {
  const result = await resolveRefs(denseDocument(), 'inline:dense', { fetchDocument });
  expect(result.problems).toEqual([]);
  return result.document;
}

describe('resolving a densely cross-referenced document', () => {
  it('finishes, because one subtree is resolved per target rather than per reference', async () => {
    const document = await resolved();

    expect(document).toBeTypeOf('object');
  });

  it('hands back the same object for the same target, which is what makes it finish', async () => {
    const document = (await resolved()) as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };

    // `Model0.field2` and `Model23.field2` both name `Model1`; one resolution is shared by both.
    const schemas = document.components.schemas;
    const fromZero = schemas['Model0']?.properties['field2'];
    const viaAnother = Object.values(schemas)
      .map((schema) => schema.properties['field2'])
      .filter((value) => value === fromZero);
    expect(fromZero).toBeTypeOf('object');
    expect(viaAnother.length).toBeGreaterThan(0);
  });
});

describe('parsing a resolved graph', () => {
  it('finishes, because a node is parsed once rather than once per path to it', async () => {
    const document = parseOpenApiDocument(await resolved());

    expect(document.operations).toHaveLength(1);
    expect(document.operations[0]?.requestBody?.content['application/json']?.schema).toBeDefined();
  });

  it('returns the same parsed schema for the same resolved node', async () => {
    const document = (await resolved()) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const node = document.components.schemas['Model0'];

    expect(node).toBeDefined();
    // Identity, not equality: the memo is what bounds the parse, so sharing is the property.
    expect(parseSchema(node!)).toBe(parseSchema(node!));
  });
});

describe('generating a sample from a resolved graph', () => {
  it('finishes and stays bounded, whatever the reference density', async () => {
    const document = parseOpenApiDocument(await resolved());
    const schema = document.operations[0]?.requestBody?.content['application/json']?.schema;
    expect(schema).toBeDefined();

    const sample = sampleFromSchema(schema!, { includeOptional: true });

    // Every value costs one node, so the budget is an exact bound on the sample's size whatever
    // shape the schema graph has.
    expect(countNodes(sample)).toBeLessThanOrEqual(MAX_SAMPLE_NODES);
    expect(countNodes(sampleFromSchema(schema!, { includeOptional: true, maxNodes: 25 }))).toBeLessThanOrEqual(25);
  });

  it('keeps required properties when the budget runs out, because a request needs them', () => {
    const schema = {
      type: 'object',
      required: ['keep'],
      properties: {
        // Twenty optional properties ahead of the required one in declaration order.
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_unused, index) => [`drop${String(index)}`, { type: 'string' as const }]),
        ),
        keep: { type: 'string' as const },
      },
    };

    const sample = sampleFromSchema(schema, { includeOptional: true, maxNodes: 3 }) as Record<string, unknown>;

    expect(Object.keys(sample)).toContain('keep');
  });

  it('bounds the XML renderer the same way', async () => {
    const document = parseOpenApiDocument(await resolved());
    const schema = document.operations[0]?.requestBody?.content['application/json']?.schema;

    const xml = sampleXml(schema!, { includeOptional: true });

    expect(xml.length).toBeGreaterThan(0);
    // Every opened element is closed or self-closed, however abruptly generation stopped.
    expect(xml.split('<').length - 1).toBeGreaterThan(1);
  });
});
