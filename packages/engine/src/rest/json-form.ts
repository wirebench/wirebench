/**
 * The JSON form model: a request body seen through its schema, as a tree of labelled nodes the form
 * view can render, and the structural edits that view can ask for.
 *
 * Everything here is pure and renderer-safe. Nodes are addressed by RFC 6901 JSON pointer (`''` for
 * the root, `/a/0/b` below it), so an edit names a place in the *value*, not in the schema, and is
 * applied to the current value every time — an edit can never act on a stale tree.
 *
 * The schema has already been dereferenced and may be a cyclic graph. Two bounds keep that finite:
 * the tree only descends where the value has something (an absent property is one node with no
 * children), and it stops at a depth limit with an `any` node, which the view shows as raw JSON.
 * New values come from {@link sampleFromSchema}, so the form and "generate body" agree.
 */

import type { JsonSchema, JsonValue } from './openapi/model.js';
import { effectiveType, MAX_SAMPLE_DEPTH, MAX_SAMPLE_NODES, mergeAllOf, sampleFromSchema } from './openapi/sample.js';

/** What a node renders as. */
export type JsonFormKind = 'field' | 'object' | 'array' | 'choice' | 'any';

/** The scalar type a `field` edits. */
export type JsonFormValueType = 'string' | 'number' | 'integer' | 'boolean' | 'null';

/** One node of the form: a place in the value, with what the schema says about it. */
export interface JsonFormNode {
  /** JSON pointer of the value, `''` for the root. */
  readonly id: string;
  readonly kind: JsonFormKind;
  /** Property name, array index, or `''` for the root. */
  readonly name: string;
  /** The schema's `title`, else the name. */
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  /** Whether the value exists in the document. */
  readonly present: boolean;
  /** `field` only. */
  readonly valueType?: JsonFormValueType;
  readonly format?: string;
  readonly enum?: readonly JsonValue[];
  /** `field` and `any`, when present. */
  readonly value?: JsonValue;
  /** Object properties, array items, or a choice's chosen branch. */
  readonly children: readonly JsonFormNode[];
  /** `choice`: one label per branch. */
  readonly choices?: readonly string[];
  /** `choice`: the index of the branch the value matches. */
  readonly chosen?: number;
  readonly readOnly?: boolean;
  readonly deprecated?: boolean;
}

/** One structural change the form view can ask for, addressed by JSON pointer. */
export type JsonFormEdit =
  | { readonly kind: 'set-value'; readonly id: string; readonly value: JsonValue }
  /** Make an absent property exist, filled from `sampleFromSchema`. */
  | { readonly kind: 'insert-optional'; readonly id: string }
  /** Remove an optional property or an array item. */
  | { readonly kind: 'remove'; readonly id: string }
  /** Append one item to the array at `id`. */
  | { readonly kind: 'add-item'; readonly id: string }
  /** Replace the value at `id` with a sample of branch `index` of its `oneOf`/`anyOf`. */
  | { readonly kind: 'select-choice'; readonly id: string; readonly index: number };

/** Options for {@link buildJsonForm}. */
export interface JsonFormOptions {
  /** Where the tree stops with an `any` node. Defaults to `MAX_SAMPLE_DEPTH`. */
  readonly maxDepth?: number;
}

type JsonObject = { readonly [key: string]: JsonValue };

const VALUE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'null']);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The branches of a `oneOf`/`anyOf`, or none. */
function branchesOf(schema: JsonSchema): readonly JsonSchema[] {
  return schema.oneOf ?? schema.anyOf ?? [];
}

/** Branch `index` merged with whatever sits beside the `oneOf` — the way `sampleFromSchema` merges its first. */
function branchSchema(schema: JsonSchema, index: number): JsonSchema {
  const branch = branchesOf(schema)[index];
  if (branch === undefined) {
    return schema;
  }
  const siblings: Record<string, unknown> = { ...schema };
  delete siblings.oneOf;
  delete siblings.anyOf;
  return mergeAllOf({
    ...branch,
    ...(siblings as JsonSchema),
    ...(branch.properties !== undefined ? { properties: branch.properties } : {}),
  });
}

/** Whether a value has the JSON type a schema type names. */
function typeMatches(type: string | undefined, value: JsonValue | undefined): boolean {
  if (type === undefined || value === undefined) {
    return true;
  }
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** The first branch whose type and required properties the value satisfies, else 0. */
function chosenBranch(schema: JsonSchema, value: JsonValue | undefined): number {
  const branches = branchesOf(schema);
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branchSchema(schema, index);
    if (!typeMatches(effectiveType(branch), value)) {
      continue;
    }
    const required = branch.required ?? [];
    if (required.length > 0 && !(isObject(value) && required.every((name) => name in value))) {
      continue;
    }
    return index;
  }
  return 0;
}

interface Place {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly depth: number;
}

/**
 * The form tree for a value under a schema.
 *
 * @param schema the dereferenced schema (it may be cyclic)
 * @param value the current body value, `undefined` when there is none
 */
export function buildJsonForm(
  schema: JsonSchema,
  value: JsonValue | undefined,
  options: JsonFormOptions = {},
): JsonFormNode {
  return build(schema, value, { id: '', name: '', required: true, depth: 0 }, options.maxDepth ?? MAX_SAMPLE_DEPTH);
}

function anyNode(place: Place, value: JsonValue | undefined, schema?: JsonSchema): JsonFormNode {
  return {
    ...common(schema ?? {}, place, value),
    kind: 'any',
    ...(value !== undefined ? { value } : {}),
    children: [],
  };
}

function common(schema: JsonSchema, place: Place, value: JsonValue | undefined) {
  return {
    id: place.id,
    name: place.name,
    label: schema.title ?? place.name,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    required: place.required,
    present: value !== undefined,
    ...(schema.readOnly === true ? { readOnly: true } : {}),
    ...(schema.deprecated === true ? { deprecated: true } : {}),
  };
}

function build(input: JsonSchema, value: JsonValue | undefined, place: Place, maxDepth: number): JsonFormNode {
  if (place.depth >= maxDepth) {
    return anyNode(place, value, input);
  }
  const schema = mergeAllOf(input);
  const branches = branchesOf(schema);
  if (branches.length > 0) {
    const chosen = chosenBranch(schema, value);
    return {
      ...common(schema, place, value),
      kind: 'choice',
      choices: branches.map((branch, index) => branch.title ?? `Option ${index + 1}`),
      chosen,
      children: [build(branchSchema(schema, chosen), value, { ...place, depth: place.depth + 1 }, maxDepth)],
    };
  }

  const type = effectiveType(schema) ?? inferredEnumType(schema);
  if (type === 'object') {
    return value === undefined || isObject(value)
      ? { ...common(schema, place, value), kind: 'object', children: objectChildren(schema, value, place, maxDepth) }
      : anyNode(place, value, schema);
  }
  if (type === 'array') {
    if (value !== undefined && !Array.isArray(value)) {
      return anyNode(place, value, schema);
    }
    const items = (value as readonly JsonValue[] | undefined) ?? [];
    return {
      ...common(schema, place, value),
      kind: 'array',
      children: items.map((item, index) =>
        build(
          schema.items ?? {},
          item,
          { id: `${place.id}/${index}`, name: String(index), required: false, depth: place.depth + 1 },
          maxDepth,
        ),
      ),
    };
  }
  if (type !== undefined && VALUE_TYPES.has(type)) {
    return {
      ...common(schema, place, value),
      kind: 'field',
      valueType: type as JsonFormValueType,
      ...(schema.format !== undefined ? { format: schema.format } : {}),
      ...(schema.enum !== undefined ? { enum: schema.enum } : {}),
      ...(value !== undefined ? { value } : {}),
      children: [],
    };
  }
  return anyNode(place, value, schema);
}

/** A type-less enum still reads as a field of its members' type. */
function inferredEnumType(schema: JsonSchema): string | undefined {
  const first = schema.enum?.[0];
  if (first === undefined) {
    return undefined;
  }
  if (first === null) {
    return 'null';
  }
  return typeof first === 'object' ? undefined : typeof first;
}

function objectChildren(
  schema: JsonSchema,
  value: JsonObject | undefined,
  place: Place,
  maxDepth: number,
): JsonFormNode[] {
  // An absent object has nothing to show inside it; descending anyway would walk a cyclic schema
  // breadth-first to the depth limit.
  if (value === undefined) {
    return [];
  }
  const required = new Set(schema.required ?? []);
  const declared = schema.properties ?? {};
  const childPlace = (name: string): Place => ({
    id: `${place.id}/${escapeSegment(name)}`,
    name,
    required: required.has(name),
    depth: place.depth + 1,
  });
  const children = Object.entries(declared).map(([name, property]) =>
    build(property, value[name], childPlace(name), maxDepth),
  );
  const additional = schema.additionalProperties;
  if (additional !== false) {
    for (const [name, extra] of Object.entries(value)) {
      if (Object.hasOwn(declared, name)) {
        continue;
      }
      children.push(
        typeof additional === 'object'
          ? build(additional, extra, childPlace(name), maxDepth)
          : anyNode(childPlace(name), extra),
      );
    }
  }
  return children;
}

/** The schema that describes the value at `segments`, following the value through choices. */
function schemaAt(root: JsonSchema, value: JsonValue | undefined, segments: readonly string[]): JsonSchema {
  let schema = root;
  let current = value;
  for (const segment of segments) {
    let resolved = mergeAllOf(schema);
    if (branchesOf(resolved).length > 0) {
      resolved = branchSchema(resolved, chosenBranch(resolved, current));
    }
    if (Array.isArray(current) || (current === undefined && effectiveType(resolved) === 'array')) {
      schema = resolved.items ?? {};
      current = Array.isArray(current) ? (current as readonly JsonValue[])[Number(segment)] : undefined;
      continue;
    }
    const additional = resolved.additionalProperties;
    schema = resolved.properties?.[segment] ?? (typeof additional === 'object' ? additional : {});
    current = isObject(current) ? current[segment] : undefined;
  }
  return schema;
}

function getAt(value: JsonValue | undefined, segments: readonly string[]): JsonValue | undefined {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = (current as readonly JsonValue[])[Number(segment)];
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A copy of `value` with `replacement` at `segments`; `undefined` removes. Missing parents become objects. */
function updateAt(
  value: JsonValue | undefined,
  segments: readonly string[],
  replacement: JsonValue | undefined,
): JsonValue | undefined {
  if (segments.length === 0) {
    return replacement;
  }
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(value)) {
    const items = [...(value as readonly JsonValue[])];
    const index = head === '-' ? items.length : Number(head);
    const next = updateAt(items[index], rest, replacement);
    if (next === undefined) {
      items.splice(index, 1);
    } else {
      items[index] = next;
    }
    return items;
  }
  const object: Record<string, JsonValue> = isObject(value) ? { ...value } : {};
  const next = updateAt(object[head], rest, replacement);
  if (next === undefined) {
    delete object[head];
  } else {
    object[head] = next;
  }
  return object;
}

/**
 * The body value after one form edit. Nothing is mutated; properties the schema does not declare
 * are carried over untouched.
 */
export function applyJsonFormEdit(schema: JsonSchema, value: JsonValue | undefined, edit: JsonFormEdit): JsonValue {
  const segments = parsePointer(edit.id);
  const put = (replacement: JsonValue | undefined): JsonValue => updateAt(value, segments, replacement) ?? null;
  switch (edit.kind) {
    case 'set-value':
      return put(edit.value);
    case 'insert-optional':
      return put(sampleFromSchema(schemaAt(schema, value, segments)));
    case 'remove':
      return segments.length === 0 ? null : put(undefined);
    case 'add-item': {
      const existing = getAt(value, segments);
      const items = Array.isArray(existing) ? (existing as readonly JsonValue[]) : [];
      let arraySchema = mergeAllOf(schemaAt(schema, value, segments));
      if (branchesOf(arraySchema).length > 0) {
        arraySchema = branchSchema(arraySchema, chosenBranch(arraySchema, existing));
      }
      return put([...items, sampleFromSchema(arraySchema.items ?? {})]);
    }
    case 'select-choice':
      return put(sampleFromSchema(branchSchema(mergeAllOf(schemaAt(schema, value, segments)), edit.index)));
  }
}

/**
 * An acyclic copy of a schema, cut at `maxDepth` (and at a total node budget) with `{}` — "any
 * value". What crosses a structured-clone or JSON boundary to the renderer.
 */
export function toWireSchema(schema: JsonSchema, maxDepth: number = MAX_SAMPLE_DEPTH): JsonSchema {
  return copySchema(schema, maxDepth, { remaining: MAX_SAMPLE_NODES });
}

function copySchema(schema: JsonSchema, depth: number, budget: { remaining: number }): JsonSchema {
  if (depth <= 0 || budget.remaining <= 0) {
    return {};
  }
  budget.remaining -= 1;
  const copy: Record<string, unknown> = { ...schema };
  const next = (child: JsonSchema): JsonSchema => copySchema(child, depth - 1, budget);
  if (schema.properties !== undefined) {
    copy.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, next(child)]));
  }
  if (schema.items !== undefined) {
    copy.items = next(schema.items);
  }
  if (typeof schema.additionalProperties === 'object') {
    copy.additionalProperties = next(schema.additionalProperties);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const branches = schema[key];
    if (branches !== undefined) {
      copy[key] = branches.map(next);
    }
  }
  return copy;
}
