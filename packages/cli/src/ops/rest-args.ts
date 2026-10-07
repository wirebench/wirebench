/**
 * A REST operation's tool arguments (#33 spec §3.2, revision R2): `path`, `query`, `headers` and
 * `body`, each present only when the operation declares something for it. The loaded document's
 * schemas are a `$ref`-inlined, possibly cyclic, graph; a node reached more than once becomes one
 * `$defs` entry, so the published schema is a tree.
 */
import { createRestRequest, entry, escapeExpansions, lexical, NO_BODY } from '@wirebench/engine';
import type {
  JsonSchema,
  JsonSchemaObject,
  KeyValueEntry,
  OpenApiOperation,
  OpenApiParameter,
  RestApi,
  RestBody,
  RestRequestDef,
} from '@wirebench/engine';
import { OpsError } from './errors.js';
import { isRecord } from './records.js';

export interface RestToolSchema {
  readonly schema: JsonSchemaObject;
  /** Required cookie parameters: the tool cannot set them, and its description says so. */
  readonly cookies: readonly string[];
}

/** Headers the container's auth sets, lower-cased: never a tool argument. */
export function authHeaderNames(api: RestApi): ReadonlySet<string> {
  const names = new Set(['accept', 'content-type', 'authorization']);
  if (api.auth?.type === 'api-key' && api.auth.in === 'header') {
    names.add(api.auth.name.toLowerCase());
  }
  return names;
}

/** The JSON media type of the request body: `application/json`, or any `+json` type. */
export function jsonMediaType(operation: OpenApiOperation): string | undefined {
  return Object.keys(operation.requestBody?.content ?? {}).find((type) => {
    const bare = type.split(';')[0]?.trim().toLowerCase() ?? '';
    return bare === 'application/json' || bare.endsWith('+json');
  });
}

function childrenOf(node: JsonSchema): JsonSchema[] {
  return [
    ...Object.values(node.properties ?? {}),
    ...(node.items !== undefined ? [node.items] : []),
    ...(typeof node.additionalProperties === 'object' ? [node.additionalProperties] : []),
    ...(node.allOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.anyOf ?? []),
  ];
}

/** Writes graph nodes as a tree: a node reached twice (shared, or inside itself) as a `$defs` entry. */
class SchemaTree {
  private readonly seen = new Map<JsonSchema, number>();
  private readonly names = new Map<JsonSchema, string>();
  private readonly definitions: Record<string, JsonSchemaObject> = {};
  private next = 1;

  /** The first pass, over every root before anything is written. */
  count(root: JsonSchema): void {
    const stack: JsonSchema[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const times = (this.seen.get(node) ?? 0) + 1;
      this.seen.set(node, times);
      if (times === 1) {
        stack.push(...childrenOf(node));
      }
    }
  }

  write(node: JsonSchema, dropReadOnly: boolean): JsonSchemaObject {
    return (this.seen.get(node) ?? 0) > 1
      ? { $ref: `#/$defs/${this.defName(node, dropReadOnly)}` }
      : this.body(node, dropReadOnly);
  }

  defs(): JsonSchemaObject | undefined {
    return Object.keys(this.definitions).length === 0 ? undefined : this.definitions;
  }

  private defName(node: JsonSchema, dropReadOnly: boolean): string {
    const known = this.names.get(node);
    if (known !== undefined) {
      return known;
    }
    const title = node.title?.replace(/[^A-Za-z0-9_.-]/g, '') ?? '';
    let name = title !== '' ? title : `Schema${String(this.next++)}`;
    for (let n = 2; name in this.definitions; n += 1) {
      name = `${title !== '' ? title : 'Schema'}_${String(n)}`;
    }
    this.names.set(node, name);
    // Taken before it is written, so a recursive reference finds it.
    this.definitions[name] = {};
    this.definitions[name] = this.body(node, dropReadOnly);
    return name;
  }

  private body(node: JsonSchema, dropReadOnly: boolean): JsonSchemaObject {
    const out: JsonSchemaObject = {};
    const declared = node.type === undefined ? undefined : typeof node.type === 'string' ? [node.type] : [...node.type];
    if (declared !== undefined) {
      const types = node.nullable === true && !declared.includes('null') ? [...declared, 'null'] : declared;
      out['type'] = types.length === 1 ? types[0] : types;
    }
    if (node.title !== undefined) out['title'] = node.title;
    if (node.description !== undefined) out['description'] = node.description;
    if (node.format !== undefined) out['format'] = node.format;
    if (node.enum !== undefined) out['enum'] = node.nullable === true ? [...node.enum, null] : [...node.enum];
    if (node.const !== undefined) out['const'] = node.const;
    if (node.properties !== undefined) {
      const kept = Object.entries(node.properties).filter(
        ([, property]) => !(dropReadOnly && property.readOnly === true),
      );
      out['properties'] = Object.fromEntries(kept.map(([key, property]) => [key, this.write(property, dropReadOnly)]));
      const names = new Set(kept.map(([key]) => key));
      const required = (node.required ?? []).filter((key) => names.has(key));
      if (required.length > 0) out['required'] = required;
    } else if (node.required !== undefined && node.required.length > 0) {
      out['required'] = [...node.required];
    }
    if (node.items !== undefined) out['items'] = this.write(node.items, dropReadOnly);
    if (typeof node.additionalProperties === 'boolean') out['additionalProperties'] = node.additionalProperties;
    else if (node.additionalProperties !== undefined)
      out['additionalProperties'] = this.write(node.additionalProperties, dropReadOnly);
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      const list = node[key];
      if (list !== undefined) out[key] = list.map((member) => this.write(member, dropReadOnly));
    }
    return out;
  }
}

const ANY_SCALAR: JsonSchemaObject = { type: ['string', 'number', 'integer', 'boolean'] };

function parametersIn(operation: OpenApiOperation, location: OpenApiParameter['in']): OpenApiParameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location);
}

/** The tool's argument schema for one OpenAPI operation. */
export function restToolSchema(api: RestApi, operation: OpenApiOperation): RestToolSchema {
  const tree = new SchemaTree();
  const excluded = authHeaderNames(api);
  const path = parametersIn(operation, 'path');
  for (const name of [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '')) {
    if (name !== '' && !path.some((parameter) => parameter.name === name)) {
      path.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  const query = parametersIn(operation, 'query');
  const headers = parametersIn(operation, 'header').filter((parameter) => !excluded.has(parameter.name.toLowerCase()));
  const cookies = parametersIn(operation, 'cookie')
    .filter((parameter) => parameter.required === true)
    .map((parameter) => parameter.name);
  const jsonType = jsonMediaType(operation);
  const content = operation.requestBody?.content ?? {};
  const bodyType = jsonType ?? Object.keys(content)[0];
  const bodySchema = jsonType === undefined ? undefined : content[jsonType]?.schema;

  for (const parameter of [...path, ...query, ...headers]) {
    if (parameter.schema !== undefined) tree.count(parameter.schema);
  }
  if (bodySchema !== undefined) tree.count(bodySchema);

  const section = (parameters: readonly OpenApiParameter[], allRequired: boolean): JsonSchemaObject => {
    const required = parameters
      .filter((parameter) => allRequired || parameter.required === true)
      .map((parameter) => parameter.name);
    return {
      type: 'object',
      properties: Object.fromEntries(
        parameters.map((parameter) => [
          parameter.name,
          parameter.schema === undefined ? ANY_SCALAR : tree.write(parameter.schema, false),
        ]),
      ),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  };

  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  if (path.length > 0) {
    properties['path'] = section(path, true);
    required.push('path');
  }
  if (query.length > 0) {
    properties['query'] = section(query, false);
    if (query.some((parameter) => parameter.required === true)) required.push('query');
  }
  if (headers.length > 0) {
    properties['headers'] = section(headers, false);
    if (headers.some((parameter) => parameter.required === true)) required.push('headers');
  }
  if (bodyType !== undefined) {
    properties['body'] =
      jsonType === undefined
        ? { type: 'string', description: `Sent as ${bodyType}` }
        : bodySchema === undefined
          ? {}
          : tree.write(bodySchema, true);
    if (operation.requestBody?.required === true) required.push('body');
  }
  const defs = tree.defs();
  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
      ...(defs !== undefined ? { $defs: defs } : {}),
    },
    cookies,
  };
}

/** OpenAPI's `simple` style: an array joined by `,`, an object as `k=v,k=v`. */
function simpleValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(lexical).join(',');
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, item]) => `${key}=${lexical(item)}`)
      .join(',');
  return lexical(value);
}

/** OpenAPI's `form` style, exploded: an array repeats the name, an object is one row per property. */
function formRows(name: string, value: unknown): KeyValueEntry[] {
  if (Array.isArray(value)) return value.map((item) => entry(name, lexical(item)));
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => entry(key, lexical(item)));
  return [entry(name, lexical(value))];
}

/**
 * A tool value goes out as written. The engine leaves a valid `%XX` escape alone when it encodes (a
 * saved request's pasted escape means what it says), so a tool's `%` is escaped first: `%2e%2e` or
 * `%2F` from an argument is then text, never a dot segment or a path separator.
 */
const literal = (text: string): string => text.replaceAll('%', '%25');

/**
 * The path rows. A value that is empty, `.` or `..` would drop or climb a segment, sending the
 * request (with the API's auth) to a path the operation does not describe, so it is refused.
 *
 * @throws OpsError `invalid-input`, naming the parameter
 */
function pathRows(path: Readonly<Record<string, unknown>>): KeyValueEntry[] {
  return Object.entries(path).map(([key, value]) => {
    const text = simpleValue(value);
    if (text === '' || text === '.' || text === '..') {
      const pointer = `/path/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      throw new OpsError(
        'invalid-input',
        `${pointer}: a path value may not be empty, "." or ".."; it would change which path is called`,
        { paths: [pointer] },
      );
    }
    return entry(key, literal(text));
  });
}

/** A JSON body under the JSON media type; any other media type's body is sent as written. */
function bodyOf(operation: OpenApiOperation, value: unknown): RestBody {
  const jsonType = jsonMediaType(operation);
  const bodyType = jsonType ?? Object.keys(operation.requestBody?.content ?? {})[0];
  if (value === undefined || bodyType === undefined) {
    return NO_BODY;
  }
  return jsonType !== undefined
    ? { kind: 'raw', language: 'json', contentType: jsonType, text: JSON.stringify(value) }
    : {
        kind: 'raw',
        language: 'text',
        contentType: bodyType,
        text: typeof value === 'string' ? value : JSON.stringify(value),
      };
}

/**
 * The temporary request for a REST tool's arguments (spec §4.1, revision R3): the rows hold the
 * values with only `%` escaped, since the engine percent-encodes path and query values when it
 * sends. Headers are not URL-encoded, so they hold the raw values. Auth is inherited from the API,
 * as for a new request.
 *
 * @throws OpsError `invalid-input` for an empty, `.` or `..` path value
 */
export function restRequestOf(
  operation: OpenApiOperation,
  args: Readonly<Record<string, unknown>>,
  name: string,
): RestRequestDef {
  const path = isRecord(args['path']) ? args['path'] : {};
  const query = isRecord(args['query']) ? args['query'] : {};
  const headers = isRecord(args['headers']) ? args['headers'] : {};
  return createRestRequest(name, {
    method: operation.method.toUpperCase(),
    // The document's path, escaped: a `${…}` in it is the document's text, sent literally (#223).
    url: escapeExpansions(operation.path),
    pathParams: pathRows(path),
    query: Object.entries(query)
      .flatMap(([key, value]) => formRows(key, value))
      .map((row) => ({ ...row, name: literal(row.name), value: literal(row.value) })),
    headers: Object.entries(headers).map(([key, value]) => entry(key, simpleValue(value))),
    body: bodyOf(operation, args['body']),
    contract: { method: operation.method.toLowerCase(), path: operation.path },
    // The escapes above assume the values are encoded on send, whatever a request would inherit.
    settings: { encodeUrl: true },
  });
}
