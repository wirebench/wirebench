/**
 * Update Definition for an OpenAPI-imported REST API: a per-operation report of what a new version of
 * the document changes.
 *
 * An operation is identified by its lower-cased method and its path exactly as the document writes
 * it, the same key a request's contract link uses — so a renamed path is a removal plus an addition,
 * never a guess by `operationId`.
 *
 * Schemas arrive `$ref`-resolved, which means shared and even cyclic object graphs, so nothing here
 * serialises them: {@link sameStructure} walks both sides together and remembers the pairs it is
 * already comparing.
 *
 * Pure: it reads two parsed documents and writes nothing.
 */

import type { OpenApiDocument, OpenApiOperation, OpenApiParameter } from './model.js';

export type RestChangeReason = 'parameters' | 'request-body' | 'responses' | 'security' | 'servers';

export type RestApiChangeReason = 'servers' | 'security' | 'version';

export interface RestOpRef {
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
}

export interface RestUpdatePlan {
  readonly added: readonly RestOpRef[];
  readonly removed: readonly RestOpRef[];
  readonly changed: readonly { readonly op: RestOpRef; readonly reasons: readonly RestChangeReason[] }[];
  readonly api: readonly RestApiChangeReason[];
}

/**
 * Structural equality that terminates on cycles: a pair already under comparison is assumed equal,
 * which is sound because any real difference is found along some other finite path.
 */
export function sameStructure(a: unknown, b: unknown): boolean {
  return compare(a, b, new Map());
}

function compare(a: unknown, b: unknown, seen: Map<object, Set<object>>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  let partners = seen.get(a);
  if (partners?.has(b) === true) return true;
  if (partners === undefined) {
    partners = new Set();
    seen.set(a, partners);
  }
  partners.add(b);
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => compare(item, other[index], seen));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return (
    keys.length === otherKeys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && compare(left[key], right[key], seen))
  );
}

const keyOf = (op: OpenApiOperation): string => `${op.method.toLowerCase()} ${op.path}`;

function opRef(op: OpenApiOperation): RestOpRef {
  const ref = { method: op.method.toLowerCase(), path: op.path };
  return op.summary === undefined ? ref : { ...ref, summary: op.summary };
}

/** Parameters keyed by location and name, so a reordered list is not a change. */
function parametersByKey(parameters: readonly OpenApiParameter[]): Record<string, OpenApiParameter> {
  const byKey: Record<string, OpenApiParameter> = {};
  for (const parameter of parameters) byKey[`${parameter.in}:${parameter.name}`] = parameter;
  return byKey;
}

/**
 * Why one operation differs. `servers` is part of the vocabulary but never produced here: the model
 * keeps no per-operation servers, so a server change is reported once, at the API level.
 */
function reasonsFor(a: OpenApiOperation, b: OpenApiOperation): RestChangeReason[] {
  const reasons: RestChangeReason[] = [];
  if (!sameStructure(parametersByKey(a.parameters), parametersByKey(b.parameters))) reasons.push('parameters');
  if (!sameStructure(a.requestBody, b.requestBody)) reasons.push('request-body');
  if (!sameStructure(a.responses, b.responses)) reasons.push('responses');
  if (!sameStructure(a.security, b.security)) reasons.push('security');
  return reasons;
}

function apiReasons(old: OpenApiDocument, next: OpenApiDocument): RestApiChangeReason[] {
  const reasons: RestApiChangeReason[] = [];
  if (!sameStructure(old.servers, next.servers)) reasons.push('servers');
  if (!sameStructure(old.security, next.security) || !sameStructure(old.securitySchemes, next.securitySchemes)) {
    reasons.push('security');
  }
  if (old.info.version !== next.info.version) reasons.push('version');
  return reasons;
}

/**
 * What moving from `old` to `next` would change: added and changed operations in `next`'s document
 * order, removed ones in `old`'s, and the API-level differences.
 */
export function planRestUpdate(old: OpenApiDocument, next: OpenApiDocument): RestUpdatePlan {
  const before = new Map<string, OpenApiOperation>();
  for (const op of old.operations) if (!before.has(keyOf(op))) before.set(keyOf(op), op);
  const after = new Set(next.operations.map(keyOf));

  const added: RestOpRef[] = [];
  const changed: { op: RestOpRef; reasons: RestChangeReason[] }[] = [];
  const handled = new Set<string>();
  for (const op of next.operations) {
    const key = keyOf(op);
    if (handled.has(key)) continue;
    handled.add(key);
    const previous = before.get(key);
    if (previous === undefined) {
      added.push(opRef(op));
      continue;
    }
    const reasons = reasonsFor(previous, op);
    if (reasons.length > 0) changed.push({ op: opRef(op), reasons });
  }
  const removed = [...before.entries()].filter(([key]) => !after.has(key)).map(([, op]) => opRef(op));

  return { added, removed, changed, api: apiReasons(old, next) };
}
