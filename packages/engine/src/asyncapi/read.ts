/**
 * Small readers both normalisers share. They take plain objects (the parsed document before and
 * after `$ref` inlining) and never throw: a shape they do not recognise reads as absent.
 */

import type { AsyncApiChannelParameter, AsyncApiMessage, AsyncApiSecurityScheme } from './model.js';

export type Json = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

export function entries(value: unknown): [string, Json][] {
  return Object.entries(record(value)).filter((entry): entry is [string, Json] => isRecord(entry[1]));
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function texts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(scalarText).filter((v): v is string => v !== undefined);
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The pointer tokens of a local `$ref` (`#/a/b` → `['a','b']`), or undefined for any other node. */
export function localRef(node: unknown): string[] | undefined {
  if (!isRecord(node)) return undefined;
  const ref = str(node['$ref']);
  if (ref === undefined || !ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').map(unescapeToken);
}

/** The last pointer token of any `$ref` (local or into another file) — the key the target is filed under. */
export function refKey(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const ref = str(node['$ref']);
  const hash = ref?.indexOf('#') ?? -1;
  if (ref === undefined || hash === -1) return undefined;
  const last = ref
    .slice(hash + 1)
    .split('/')
    .at(-1);
  return last === undefined || last === '' ? undefined : unescapeToken(last);
}

/** Schema formats the contract check can read: JSON Schema, and the AsyncAPI schema that extends it. */
export function isJsonSchemaFormat(format: string | undefined): boolean {
  if (format === undefined) return true;
  return /^application\/(?:schema\+(?:json|yaml)|vnd\.aai\.asyncapi(?:\+(?:json|yaml))?)(?:;|$)/i.test(format.trim());
}

/**
 * A message with its `traits` shallow-merged in. In 2.x a trait is applied onto the message, so a
 * trait's field wins; in 3.0 the message's own field wins over its traits'.
 */
function withTraits(node: Json, traitsWin: boolean): Json {
  const traits = node['traits'];
  if (!Array.isArray(traits)) return node;
  let merged: Record<string, unknown> = traitsWin ? { ...node } : {};
  for (const trait of traits) merged = { ...merged, ...record(trait) };
  merged = traitsWin ? merged : { ...merged, ...node };
  delete merged['traits'];
  return merged;
}

/** Follows local `$ref`s in the raw document, a bounded number of hops, to the node they name. */
export function deref(root: unknown, node: unknown): unknown {
  let current = node;
  for (let hop = 0; hop < 16; hop += 1) {
    const tokens = localRef(current);
    if (tokens === undefined) return current;
    let target: unknown = root;
    for (const token of tokens) target = record(target)[token];
    if (target === undefined) return current;
    current = target;
  }
  return current;
}

/** `{name}` placeholders replaced by each variable's default (else first enum value). */
export function substitute(template: string, variables: unknown): { value: string; unresolved: string[] } {
  const vars = record(variables);
  const unresolved: string[] = [];
  const value = template.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const variable = record(vars[name]);
    const chosen = scalarText(variable['default']) ?? texts(variable['enum'])?.[0];
    if (chosen === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return whole;
    }
    return chosen;
  });
  return { value, unresolved };
}

export function securityScheme(key: string, scheme: Json): AsyncApiSecurityScheme {
  const type = str(scheme['type']) ?? 'unknown';
  const description = str(scheme['description']);
  const httpScheme = str(scheme['scheme']);
  const bearerFormat = str(scheme['bearerFormat']);
  const where = str(scheme['in']);
  const name = str(scheme['name']);
  return {
    key,
    type,
    ...(description !== undefined ? { description } : {}),
    ...(httpScheme !== undefined ? { scheme: httpScheme.toLowerCase() } : {}),
    ...(bearerFormat !== undefined ? { bearerFormat } : {}),
    ...(where !== undefined ? { in: where } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** A channel parameter from where its values live (the 2.x `schema`, or the 3.0 parameter itself). */
export function channelParameter(source: Json): AsyncApiChannelParameter {
  const def = scalarText(source['default']);
  const allowed = texts(source['enum']);
  const examples = texts(source['examples']);
  return {
    ...(def !== undefined ? { default: def } : {}),
    ...(allowed !== undefined ? { enum: allowed } : {}),
    ...(examples !== undefined ? { examples } : {}),
  };
}

export function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => str(record(tag)['name'])).filter((n): n is string => n !== undefined);
}

/**
 * One message, traits merged in. Its name is its `name`, else its `title`, else its key. `payloadOf` pulls the schema (and a schema format carried with it) out of the
 * version's payload shape.
 */
export function message(
  key: string,
  node: Json,
  defaultContentType: string,
  payloadOf: (node: Json) => { payload?: unknown; schemaFormat?: string },
  traitsWin: boolean,
): AsyncApiMessage {
  node = withTraits(node, traitsWin);
  const title = str(node['title']);
  const { payload, schemaFormat } = payloadOf(node);
  const examples = node['examples'];
  const first = Array.isArray(examples) ? record(examples[0]) : {};
  return {
    key,
    name: str(node['name']) ?? title ?? key,
    ...(title !== undefined ? { title } : {}),
    contentType: str(node['contentType']) ?? defaultContentType,
    ...(schemaFormat !== undefined ? { schemaFormat } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...('payload' in first ? { example: first['payload'] } : {}),
  };
}
