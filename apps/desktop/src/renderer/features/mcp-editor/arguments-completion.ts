/**
 * Field completion for a `tools/call`'s arguments (#79), from the tool's `inputSchema` as the
 * server's catalogue lists it.
 *
 * The JSON editor's completion provider (`editor/json-completion.ts`) asks a source for the fields
 * of the object at a path. The gRPC message editor's source asks main, which holds the parsed
 * `.proto`; an MCP tool's schema is already in the renderer's mirror, so this one walks it here and
 * answers at once. Only what completion needs is read: `properties`, `items`, `enum`, `required`,
 * `description`, and a `$ref` into the schema's own `$defs` or `definitions`.
 */
import type { JsonCompletionSource } from '../../editor/json-completion.js';
import type { GrpcMessageFieldWire } from '@shared/kinds/grpc/wire.js';

type Schema = Readonly<Record<string, unknown>>;

/** How many `$ref` hops one lookup follows, so a schema that refers to itself cannot loop. */
const MAX_REF_HOPS = 32;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The node a local `$ref` (`#/$defs/x`, `#/definitions/x`) names; the node itself when it has none. */
function deref(root: Schema, node: Schema): Schema | undefined {
  let current: Schema = node;
  for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
    const ref = current.$ref;
    if (typeof ref !== 'string') {
      return current;
    }
    if (!ref.startsWith('#/')) {
      return undefined;
    }
    let target: unknown = root;
    for (const segment of ref.slice(2).split('/')) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      target = isSchema(target) ? target[key] : undefined;
    }
    if (!isSchema(target)) {
      return undefined;
    }
    current = target;
  }
  return undefined;
}

/** The first `type` a node names: `"string"`, or the first of `["string", "null"]`. */
function typeOf(node: Schema): string | undefined {
  const { type } = node;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === 'string' && entry !== 'null');
  return undefined;
}

/** An array's items as one schema, followed through refs: array indices are not path segments. */
function unwrapArrays(root: Schema, node: Schema): Schema | undefined {
  let current: Schema | undefined = node;
  for (let depth = 0; current !== undefined && typeOf(current) === 'array' && depth < MAX_REF_HOPS; depth += 1) {
    current = isSchema(current.items) ? deref(root, current.items) : undefined;
  }
  return current;
}

/** The object schema at `path`, or `undefined` when the path names nothing in the schema. */
function objectAt(root: Schema, path: readonly string[]): Schema | undefined {
  let node: Schema | undefined = deref(root, root);
  for (const segment of path) {
    if (node === undefined) return undefined;
    const properties: unknown = node.properties;
    const child: unknown = isSchema(properties) ? properties[segment] : undefined;
    node = isSchema(child) ? deref(root, child) : undefined;
    node = node === undefined ? undefined : unwrapArrays(root, node);
  }
  return node;
}

/** One property as the completion list shows it. */
function fieldOf(root: Schema, name: string, raw: Schema, required: ReadonlySet<string>): GrpcMessageFieldWire {
  const node = deref(root, raw) ?? raw;
  const repeated = typeOf(node) === 'array';
  const element = repeated ? (unwrapArrays(root, node) ?? {}) : node;
  const enumValues = Array.isArray(element.enum) ? element.enum.map((value) => JSON.stringify(value)) : undefined;
  const type = typeOf(element) ?? 'any';
  const lines = [
    ...(typeof node.description === 'string' ? [node.description] : []),
    ...(required.has(name) ? ['Required.'] : []),
  ];
  return {
    name,
    // `string` is what the provider writes quoted; every other JSON type is written bare.
    type,
    valueKind: enumValues !== undefined ? 'enum' : type === 'object' ? 'message' : 'scalar',
    repeated,
    ...(enumValues !== undefined ? { enumValues } : {}),
    ...(lines.length > 0 ? { comment: lines.join('\n\n') } : {}),
  };
}

/** The fields of the object at `path` in `schema`, in the order the schema lists them. */
export function schemaFieldsAt(
  schema: Readonly<Record<string, unknown>>,
  path: readonly string[],
): GrpcMessageFieldWire[] {
  const node = objectAt(schema, path);
  if (node === undefined || !isSchema(node.properties)) {
    return [];
  }
  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((entry): entry is string => typeof entry === 'string') : [],
  );
  return Object.entries(node.properties)
    .filter((entry): entry is [string, Schema] => isSchema(entry[1]))
    .map(([name, child]) => fieldOf(schema, name, child, required));
}

/** A {@link JsonCompletionSource} over one tool's `inputSchema`. */
export function toolArgumentsSource(inputSchema: Readonly<Record<string, unknown>>): JsonCompletionSource {
  return {
    fetchFields: (path) => Promise.resolve(schemaFieldsAt(inputSchema, path)),
  };
}
