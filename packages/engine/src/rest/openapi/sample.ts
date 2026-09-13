/**
 * Turning a JSON Schema into a body a user can send.
 *
 * The generator is deliberately dull and deterministic: the same schema always produces the same
 * sample, so an imported request is reviewable and a golden test means something. It answers one
 * question per node — "what is the most specific thing this schema says a value looks like?" — and
 * takes the first answer it finds: an `example`, then a `default`, then a `const`, then the first
 * `enum` member, then the type's own empty value.
 *
 * Three rules keep the output usable rather than merely correct:
 *
 * - **Required properties are always present, optional ones follow the preference.** A body missing a
 *   required field is a request that cannot succeed, so it is never generated that way.
 * - **A composition is not a puzzle to solve.** `allOf` is merged (its whole point), and `oneOf` and
 *   `anyOf` take their first branch — picking "the right one" needs an intent the document does not
 *   carry, and a body from the first branch is one the user can see and change.
 * - **Depth is capped**, and a `$ref` the resolver left in place is a cut. A self-referencing schema
 *   is normal in a description, so it has to end in a finite document rather than a stack overflow.
 */

import type { JsonSchema, JsonValue, OpenApiXml } from './model.js';

/** How deep generation goes before it stops and emits `null`. */
export const MAX_SAMPLE_DEPTH = 8;

/**
 * How many values one sample may contain before generation stops adding to it.
 *
 * The depth cap alone is not a bound: a resolved description is a *graph*, not a tree — a `$ref` to a
 * shared schema is one object reachable from many places — so a document whose schemas reference each
 * other reaches `breadth ^ depth` nodes, which for a realistic 20-property schema is billions at
 * depth 8. A total budget makes generation linear in the size of what it produces, whatever shape the
 * schema graph has. Required properties are still emitted first, so what a truncated sample keeps is
 * the part a request cannot go without.
 */
export const MAX_SAMPLE_NODES = 2_000;

/* Every value a sample holds costs one node, so this is an exact upper bound on its size. */

export interface SampleOptions {
  /** Emit properties the schema does not require. Mirrors the WSDL generator's preference. */
  readonly includeOptional?: boolean;
  /**
   * Emit format-appropriate placeholders (`2026-01-01T00:00:00Z` for a `date-time`) instead of the
   * type's empty value. The same preference the WSDL sample generator has.
   */
  readonly sampleValues?: boolean;
  /** Where to stop. Defaults to {@link MAX_SAMPLE_DEPTH}. */
  readonly maxDepth?: number;
  /** How many values the sample may hold. Defaults to {@link MAX_SAMPLE_NODES}. */
  readonly maxNodes?: number;
}

/** The generation budget, shared by every node of one sample so the total is what is bounded. */
interface Budget {
  remaining: number;
}

/** The placeholder values a `format` maps to, used only when `sampleValues` is on. */
const FORMAT_VALUES: Readonly<Record<string, string>> = {
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00Z',
  duration: 'P1D',
  uuid: '00000000-0000-4000-8000-000000000000',
  email: 'user@example.com',
  hostname: 'example.com',
  uri: 'https://example.com',
  'uri-reference': '/path',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  password: 'secret',
  byte: 'AA==',
  binary: '',
};

/** Every type a schema declares, as a set — 3.1 allows a list, which is how it spells nullable. */
function typesOf(schema: JsonSchema): ReadonlySet<string> {
  const declared = schema.type;
  if (declared === undefined) {
    return new Set();
  }
  return new Set(typeof declared === 'string' ? [declared] : declared);
}

/** Whether the schema says a value may be `null`, in either specification's spelling. */
function isNullable(schema: JsonSchema): boolean {
  return schema.nullable === true || typesOf(schema).has('null');
}

/** The type to generate for, ignoring `null` — which is an alternative, not a shape. */
function effectiveType(schema: JsonSchema): string | undefined {
  for (const type of typesOf(schema)) {
    if (type !== 'null') {
      return type;
    }
  }
  // No `type` at all: a schema with properties is an object, one with items an array. This is what
  // a reader would assume, and documents in the wild leave `type` out constantly.
  if (schema.properties !== undefined || schema.additionalProperties !== undefined) {
    return 'object';
  }
  if (schema.items !== undefined) {
    return 'array';
  }
  return undefined;
}

/**
 * The value a schema states outright, if any: `example`, `default`, `const`, or its first `enum`.
 *
 * 3.1's `examples` array is read too, first entry first, because that is the only spelling a 3.1
 * document has.
 */
function statedValue(schema: JsonSchema): JsonValue | undefined {
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.examples !== undefined && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum[0];
  }
  return undefined;
}

/** A copy of a schema without the keywords the caller has already accounted for. */
function without(schema: JsonSchema, ...keys: readonly (keyof JsonSchema)[]): JsonSchema {
  const copy: Record<string, unknown> = { ...schema };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

/** The schema an `allOf` amounts to: every branch merged, later branches filling in blanks. */
function mergeAllOf(schema: JsonSchema): JsonSchema {
  if (schema.allOf === undefined || schema.allOf.length === 0) {
    return schema;
  }
  let properties: Record<string, JsonSchema> = { ...schema.properties };
  let required: string[] = [...(schema.required ?? [])];
  let merged: JsonSchema = { ...schema };
  for (const branch of schema.allOf) {
    const flattened = mergeAllOf(branch);
    properties = { ...properties, ...flattened.properties };
    required = [...required, ...(flattened.required ?? [])];
    merged = { ...flattened, ...merged };
  }
  return {
    ...without(merged, 'allOf'),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };
}

/** The branch a `oneOf`/`anyOf` generates from: the first, merged with whatever sits beside it. */
function firstBranch(schema: JsonSchema): JsonSchema {
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch === undefined) {
    return schema;
  }
  return mergeAllOf({
    ...branch,
    ...without(schema, 'oneOf', 'anyOf'),
    ...(branch.properties !== undefined ? { properties: branch.properties } : {}),
  });
}

/**
 * A sample value for one schema.
 *
 * @param schema the schema, with its references already inlined (see `refs.ts`)
 * @returns a JSON value — `null` where generation had to stop
 */
export function sampleFromSchema(schema: JsonSchema, options: SampleOptions = {}): JsonValue {
  return generate(schema, options, options.maxDepth ?? MAX_SAMPLE_DEPTH, {
    remaining: options.maxNodes ?? MAX_SAMPLE_NODES,
  });
}

function generate(input: JsonSchema, options: SampleOptions, depth: number, nodes: Budget): JsonValue {
  // A reference the resolver could not follow, or cut as a cycle: there is nothing to generate from,
  // and `null` is the honest answer. The same answer the depth cap gives, for the same reason.
  if (input.$ref !== undefined && input.type === undefined && input.properties === undefined) {
    return null;
  }
  if (nodes.remaining <= 0) {
    return null;
  }
  // Charged before the depth check as well, so *every* value this function returns costs exactly one
  // — including the `null` the depth cap emits. That is what makes the budget an exact bound on the
  // size of the sample rather than a bound on its objects alone.
  nodes.remaining -= 1;
  if (depth <= 0) {
    return null;
  }

  const schema = firstBranch(mergeAllOf(input));
  const stated = statedValue(schema);
  if (stated !== undefined) {
    return stated;
  }

  switch (effectiveType(schema)) {
    case 'object':
      return generateObject(schema, options, depth, nodes);
    case 'array':
      return generateArray(schema, options, depth, nodes);
    case 'string':
      return generateString(schema, options);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      // A schema with no type and no shape says nothing at all about its value. `null` says that,
      // where `{}` or `""` would claim something the document never did.
      return isNullable(schema) ? null : null;
  }
}

function generateObject(schema: JsonSchema, options: SampleOptions, depth: number, nodes: Budget): JsonValue {
  const required = new Set(schema.required ?? []);
  const out: Record<string, JsonValue> = {};
  // Required properties first, so a sample cut short by the budget still carries what a request
  // cannot be sent without.
  const names = Object.keys(schema.properties ?? {}).sort(
    (left, right) => Number(required.has(right)) - Number(required.has(left)),
  );
  for (const name of names) {
    const property = schema.properties?.[name];
    if (property === undefined) {
      continue;
    }
    // A read-only property is one the server sends back, never one the client sends, so a generated
    // request body leaves it out even when the schema requires it in a response.
    if (property.readOnly === true) {
      continue;
    }
    if (!required.has(name) && options.includeOptional !== true) {
      continue;
    }
    if (nodes.remaining <= 0) {
      break;
    }
    out[name] = generate(property, options, depth - 1, nodes);
  }
  // A free-form object (`additionalProperties` with no `properties`) has nothing nameable in it, so
  // it stays empty rather than inventing a key.
  return out;
}

function generateArray(schema: JsonSchema, options: SampleOptions, depth: number, nodes: Budget): JsonValue {
  if (schema.items === undefined) {
    return [];
  }
  // One item: enough to show the shape, few enough to edit. More would only be guessing.
  return [generate(schema.items, options, depth - 1, nodes)];
}

function generateString(schema: JsonSchema, options: SampleOptions): JsonValue {
  if (options.sampleValues === true && schema.format !== undefined) {
    return FORMAT_VALUES[schema.format] ?? '';
  }
  return '';
}

/** Options for {@link sampleXml}. */
export interface SampleXmlOptions extends SampleOptions {
  /** The root element's name, when the schema's own `xml.name` does not give one. */
  readonly rootName?: string;
  /** Indent per level. Defaults to two spaces, matching a REST body's own formatting. */
  readonly indent?: string;
}

/**
 * A sample XML body for a schema, honouring its `xml` object: `name`, `attribute`, `wrapped`, and a
 * `prefix`/`namespace` pair.
 *
 * Written here rather than through the XSD sample generator because the shape comes from JSON Schema,
 * not from an XSD: there is no schema set to resolve against, and the `xml` object is OpenAPI's own.
 */
export function sampleXml(schema: JsonSchema, options: SampleXmlOptions = {}): string {
  const indent = options.indent ?? '  ';
  const merged = firstBranch(mergeAllOf(schema));
  const name = merged.xml?.name ?? options.rootName ?? 'root';
  const nodes: Budget = { remaining: options.maxNodes ?? MAX_SAMPLE_NODES };
  return renderElement(merged, name, options, options.maxDepth ?? MAX_SAMPLE_DEPTH, indent, 0, nodes).join('\n');
}

/** The tag name for an element, with its `xml.prefix` when it has one. */
function tagOf(schema: JsonSchema, name: string): string {
  const local = schema.xml?.name ?? name;
  return schema.xml?.prefix !== undefined ? `${schema.xml.prefix}:${local}` : local;
}

/** The `xmlns` attribute a namespace declaration needs, if any. */
function namespaceAttribute(xml: OpenApiXml | undefined): string {
  if (xml?.namespace === undefined) {
    return '';
  }
  return xml.prefix !== undefined
    ? ` xmlns:${xml.prefix}="${escape(xml.namespace)}"`
    : ` xmlns="${escape(xml.namespace)}"`;
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One element and everything inside it, as lines at `depth`. */
function renderElement(
  input: JsonSchema,
  name: string,
  options: SampleXmlOptions,
  remainingDepth: number,
  indent: string,
  depth: number,
  nodes: Budget,
): string[] {
  const pad = indent.repeat(depth);
  const schema = firstBranch(mergeAllOf(input));
  const tag = tagOf(schema, name);
  // The same two bounds the JSON generator has, and for the same reason: a resolved description is a
  // graph, so depth alone does not bound the work.
  if (remainingDepth <= 0 || nodes.remaining <= 0) {
    return [`${pad}<${tag}/>`];
  }
  nodes.remaining -= 1;

  const type = effectiveType(schema);
  if (type === 'object') {
    const required = new Set(schema.required ?? []);
    const attributes: string[] = [];
    const children: string[] = [];
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (propertySchema.readOnly === true) {
        continue;
      }
      if (!required.has(property) && options.includeOptional !== true) {
        continue;
      }
      // An `xml.attribute` property is an attribute of *this* element, not a child of it.
      if (propertySchema.xml?.attribute === true) {
        const attributeName = tagOf(propertySchema, property);
        attributes.push(`${attributeName}="${escape(scalarText(propertySchema, options))}"`);
        continue;
      }
      if (nodes.remaining <= 0) {
        break;
      }
      children.push(...renderProperty(propertySchema, property, options, remainingDepth - 1, indent, depth + 1, nodes));
    }
    const open = `<${tag}${namespaceAttribute(schema.xml)}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}`;
    if (children.length === 0) {
      return [`${pad}${open}/>`];
    }
    return [`${pad}${open}>`, ...children, `${pad}</${tag}>`];
  }

  if (type === 'array') {
    return renderProperty(schema, name, options, remainingDepth, indent, depth, nodes);
  }

  return [`${pad}<${tag}${namespaceAttribute(schema.xml)}>${escape(scalarText(schema, options))}</${tag}>`];
}

/** One property, which for an array is either wrapped or repeated in place. */
function renderProperty(
  schema: JsonSchema,
  name: string,
  options: SampleXmlOptions,
  remainingDepth: number,
  indent: string,
  depth: number,
  nodes: Budget,
): string[] {
  if (effectiveType(schema) !== 'array' || schema.items === undefined) {
    return renderElement(schema, name, options, remainingDepth, indent, depth, nodes);
  }
  // `wrapped` puts the items inside an element named for the property; without it they repeat in
  // place under the item's own name, which is XML's own default for a list.
  const itemName = schema.items.xml?.name ?? name;
  const item = renderElement(
    schema.items,
    itemName,
    options,
    remainingDepth - 1,
    indent,
    schema.xml?.wrapped === true ? depth + 1 : depth,
    nodes,
  );
  if (schema.xml?.wrapped !== true) {
    return item;
  }
  const pad = indent.repeat(depth);
  const tag = tagOf(schema, name);
  return [`${pad}<${tag}${namespaceAttribute(schema.xml)}>`, ...item, `${pad}</${tag}>`];
}

/** The text a scalar schema renders as — the same precedence `sampleFromSchema` uses. */
function scalarText(schema: JsonSchema, options: SampleOptions): string {
  const value = generate(schema, options, 1, { remaining: 1 });
  if (value === null) {
    return '';
  }
  // Only scalars reach here in practice; a composite says so as JSON rather than `[object Object]`.
  return typeof value === 'string' ? value : JSON.stringify(value);
}
