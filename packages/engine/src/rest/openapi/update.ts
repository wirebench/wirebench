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
 * Applying one follows the AsyncAPI rule: both documents are re-mapped with the importer's own
 * {@link apiFromDocument}, and a generated value follows the new document only while it still equals
 * what the old document generated. Nothing is ever deleted: a request whose operation is gone is
 * flagged `orphaned`, and one whose operation came back has the flag cleared.
 *
 * Pure: it reads two parsed documents and writes nothing.
 */

import type { IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { uniqueSlug } from '../../project/paths.js';
import type { KeyValueEntry, RestApi, RestFolder, RestRequestDef } from '../model.js';
import { createFolder } from '../model.js';
import { apiFromDocument } from './map.js';
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

/** What {@link applyRestUpdate} changed, counted for the toast. */
export interface RestApplyResult {
  readonly api: RestApi;
  readonly requestsAdded: number;
  readonly requestsOrphaned: number;
  readonly requestsRestored: number;
  /** Requests where at least one generated field followed the new document. */
  readonly requestsRewritten: number;
  readonly rowsAdded: number;
  readonly rowsRemoved: number;
}

export interface ApplyRestUpdateOptions {
  readonly newId?: IdGenerator;
}

const contractKey = (request: RestRequestDef): string | undefined =>
  request.contract === undefined ? undefined : `${request.contract.method} ${request.contract.path}`;

function requestsOf(api: RestApi): RestRequestDef[] {
  const walk = (folder: RestFolder): RestRequestDef[] => [...folder.requests, ...folder.folders.flatMap(walk)];
  return [...api.requests, ...api.folders.flatMap(walk)];
}

function byContract(api: RestApi): Map<string, RestRequestDef> {
  const map = new Map<string, RestRequestDef>();
  for (const request of requestsOf(api)) {
    const key = contractKey(request);
    if (key !== undefined && !map.has(key)) map.set(key, request);
  }
  return map;
}

/** A row's identity within its table: headers are case-insensitive, path and query names are not. */
const rowKey = (row: KeyValueEntry, caseless: boolean): string => (caseless ? row.name.toLowerCase() : row.name);

const sameRow = (a: KeyValueEntry, b: KeyValueEntry): boolean => a.value === b.value && a.enabled === b.enabled;

/**
 * One parameter table under the per-row rule: an untouched generated row follows (or goes, when the
 * new document dropped it), an edited or user-added row stays, and a row new to the document is
 * appended.
 */
function mergeRows(
  current: readonly KeyValueEntry[],
  before: readonly KeyValueEntry[],
  after: readonly KeyValueEntry[],
  caseless: boolean,
): { rows: KeyValueEntry[]; added: number; removed: number; changed: boolean } {
  const index = (rows: readonly KeyValueEntry[]): Map<string, KeyValueEntry> => {
    const map = new Map<string, KeyValueEntry>();
    for (const row of rows) if (!map.has(rowKey(row, caseless))) map.set(rowKey(row, caseless), row);
    return map;
  };
  const oldRows = index(before);
  const newRows = index(after);
  const rows: KeyValueEntry[] = [];
  let removed = 0;
  let changed = false;
  for (const row of current) {
    const key = rowKey(row, caseless);
    const generated = oldRows.get(key);
    if (generated === undefined || !sameRow(row, generated)) {
      rows.push(row);
      continue;
    }
    const replacement = newRows.get(key);
    if (replacement === undefined) {
      removed += 1;
      changed = true;
      continue;
    }
    if (!sameStructure(row, replacement)) changed = true;
    rows.push(replacement);
  }
  const present = new Set(current.map((row) => rowKey(row, caseless)));
  let added = 0;
  for (const [key, row] of newRows) {
    if (oldRows.has(key) || present.has(key)) continue;
    rows.push(row);
    added += 1;
    changed = true;
  }
  return { rows, added, removed, changed };
}

/**
 * Applies `next` to an API imported from `old`: the request of every operation still in `next`
 * follows it where untouched, the request of every operation gone is orphaned, and every new
 * operation gets a request in the folder the importer would have put it in. Never deletes a request
 * or a folder.
 */
export function applyRestUpdate(
  api: RestApi,
  old: OpenApiDocument,
  next: OpenApiDocument,
  options: ApplyRestUpdateOptions = {},
): RestApplyResult {
  const newId = options.newId ?? generateId;
  // The old mapping's ids are never kept: only its generated values are compared.
  const oldMapped = apiFromDocument(old, { newId: () => 'old' }).api;
  const nextMapped = apiFromDocument(next, { newId }).api;
  const oldReqs = byContract(oldMapped);
  const nextReqs = byContract(nextMapped);

  let requestsOrphaned = 0;
  let requestsRestored = 0;
  let requestsRewritten = 0;
  let rowsAdded = 0;
  let rowsRemoved = 0;

  const update = (request: RestRequestDef): RestRequestDef => {
    const key = contractKey(request);
    if (key === undefined) return request;
    const target = nextReqs.get(key);
    if (target === undefined) {
      if (request.orphaned === true) return request;
      requestsOrphaned += 1;
      return { ...request, orphaned: true };
    }
    let out: RestRequestDef = request;
    if (request.orphaned === true) {
      requestsRestored += 1;
      const { orphaned, ...rest } = request;
      void orphaned;
      out = rest;
    }
    const before = oldReqs.get(key);
    if (before === undefined) return out;
    let rewritten = false;
    if (out.url === before.url && out.url !== target.url) {
      out = { ...out, url: target.url };
      rewritten = true;
    }
    for (const table of ['pathParams', 'query', 'headers'] as const) {
      const merged = mergeRows(out[table], before[table], target[table], table === 'headers');
      if (!merged.changed) continue;
      out = { ...out, [table]: merged.rows };
      rowsAdded += merged.added;
      rowsRemoved += merged.removed;
      rewritten = true;
    }
    if (sameStructure(out.body, before.body) && !sameStructure(out.body, target.body)) {
      out = { ...out, body: target.body };
      rewritten = true;
    }
    if (sameStructure(out.auth, before.auth) && !sameStructure(out.auth, target.auth)) {
      out = { ...out, auth: target.auth };
      rewritten = true;
    }
    if (rewritten) requestsRewritten += 1;
    return out;
  };

  const updateFolder = (folder: RestFolder): RestFolder => ({
    ...folder,
    folders: folder.folders.map(updateFolder),
    requests: folder.requests.map(update),
  });
  let result: RestApi = { ...api, folders: api.folders.map(updateFolder), requests: api.requests.map(update) };

  // Operations the API has no request for yet: into the folder the importer names, else the root.
  const have = byContract(result);
  let requestsAdded = 0;
  for (const [key, fresh] of nextReqs) {
    if (have.has(key)) continue;
    const home = nextMapped.folders.find((folder) => folder.requests.some((r) => r.id === fresh.id));
    const place = (siblings: readonly RestRequestDef[]): RestRequestDef => ({
      ...fresh,
      slug: uniqueSlug(fresh.name, new Set(siblings.map((r) => r.slug))),
      order: siblings.reduce((n, r) => Math.max(n, r.order + 1), 0),
    });
    requestsAdded += 1;
    if (home === undefined) {
      result = { ...result, requests: [...result.requests, place(result.requests)] };
    } else if (result.folders.some((folder) => folder.name === home.name)) {
      let placed = false;
      result = {
        ...result,
        folders: result.folders.map((folder) => {
          if (placed || folder.name !== home.name) return folder;
          placed = true;
          return { ...folder, requests: [...folder.requests, place(folder.requests)] };
        }),
      };
    } else {
      const folder = createFolder(home.name, {
        id: newId(),
        slug: uniqueSlug(home.name, new Set(result.folders.map((f) => f.slug))),
        order: result.folders.reduce((n, f) => Math.max(n, f.order + 1), 0),
        ...(home.description !== undefined ? { description: home.description } : {}),
        requests: [place([])],
      });
      result = { ...result, folders: [...result.folders, folder] };
    }
  }

  // API level: the same follow rule, against what the old document mapped to.
  const followed: { baseUrl?: string; servers?: RestApi['servers'] } = {};
  if (result.baseUrl === oldMapped.baseUrl) followed.baseUrl = nextMapped.baseUrl;
  if (sameStructure(result.servers, oldMapped.servers)) followed.servers = nextMapped.servers;
  result = { ...result, ...followed };
  if (sameStructure(result.auth, oldMapped.auth) && !sameStructure(result.auth, nextMapped.auth)) {
    const { auth, ...rest } = result;
    void auth;
    result = nextMapped.auth === undefined ? rest : { ...rest, auth: nextMapped.auth };
  }
  if (result.definition !== undefined) {
    result = { ...result, definition: { ...result.definition, version: next.declaredVersion } };
  }

  return { api: result, requestsAdded, requestsOrphaned, requestsRestored, requestsRewritten, rowsAdded, rowsRemoved };
}
