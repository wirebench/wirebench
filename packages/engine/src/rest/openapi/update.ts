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
import type { WebhookFolder } from '../../webhooks/model.js';
import { hookKey } from '../../webhooks/model.js';
import type { KeyValueEntry, RestApi, RestFolder, RestRequestDef } from '../model.js';
import { createFolder } from '../model.js';
import type { WebhookItemRef } from './map.js';
import { apiFromDocument, webhookSourcesOf, webhooksFromDocument } from './map.js';
import type { OpenApiDocument, OpenApiOperation, OpenApiParameter } from './model.js';

export type RestChangeReason = 'parameters' | 'request-body' | 'responses' | 'security' | 'servers';

export type RestApiChangeReason = 'servers' | 'security' | 'version';

export interface RestOpRef {
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
}

/** What moving from one document to the next would do to its webhooks and callbacks. */
export interface WebhookUpdatePlan {
  readonly added: readonly WebhookItemRef[];
  readonly removed: readonly WebhookItemRef[];
  readonly changed: readonly { readonly item: WebhookItemRef; readonly reasons: readonly RestChangeReason[] }[];
}

export interface RestUpdatePlan {
  readonly added: readonly RestOpRef[];
  readonly removed: readonly RestOpRef[];
  readonly changed: readonly { readonly op: RestOpRef; readonly reasons: readonly RestChangeReason[] }[];
  readonly api: readonly RestApiChangeReason[];
  readonly webhooks: WebhookUpdatePlan;
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

  return { added, removed, changed, api: apiReasons(old, next), webhooks: planWebhookUpdate(old, next) };
}

/**
 * What moving from `old` to `next` would change among webhooks and callbacks: added and changed
 * items keyed as {@link hookKey} matches them, removed ones the same way. Mirrors
 * {@link planRestUpdate}'s per-operation comparison, over {@link webhookSourcesOf} instead of
 * `document.operations`.
 */
export function planWebhookUpdate(old: OpenApiDocument, next: OpenApiDocument): WebhookUpdatePlan {
  const before = new Map(webhookSourcesOf(old).map((source) => [source.ref.key, source] as const));
  const after = new Map(webhookSourcesOf(next).map((source) => [source.ref.key, source] as const));
  const added = [...after.values()].filter((source) => !before.has(source.ref.key)).map((source) => source.ref);
  const removed = [...before.values()].filter((source) => !after.has(source.ref.key)).map((source) => source.ref);
  const changed: { item: WebhookItemRef; reasons: RestChangeReason[] }[] = [];
  for (const [key, source] of after) {
    const previous = before.get(key);
    if (previous === undefined) continue;
    const reasons = reasonsFor(previous.operation, source.operation);
    if (reasons.length > 0) changed.push({ item: source.ref, reasons });
  }
  return { added, removed, changed };
}

/** What {@link applyRestUpdate} changed, counted for the toast. */
export interface RestApplyResult {
  readonly api: RestApi;
  readonly requestsAdded: number;
  /**
   * Operations the plan lists under Added that a request already claims by contract, so no request
   * was made for them. The plan compares documents alone and cannot see them; this is the difference.
   */
  readonly requestsAlreadyPresent: number;
  readonly requestsOrphaned: number;
  readonly requestsRestored: number;
  /** Requests where at least one generated field followed the new document. */
  readonly requestsRewritten: number;
  readonly rowsAdded: number;
  readonly rowsRemoved: number;
}

export interface ApplyRestUpdateOptions {
  readonly newId?: IdGenerator;
  /** Passed to the sampler for a body a generated field follows into, as the importer would. */
  readonly includeOptional?: boolean;
  /** Passed to the sampler for a body a generated field follows into, as the importer would. */
  readonly sampleValues?: boolean;
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
 *
 * With one exception, {@link promoteRequired}: a row the user edited still follows the document from
 * optional to required.
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
  /**
   * The one thing a kept row still follows: a parameter the new document made required turns its
   * row on, so the request stays sendable as the document now demands. Only the box changes — the
   * user's value is kept — and a row the user added by hand has no generated counterpart and is
   * left alone, since the document never claimed it. In practice this is a query parameter: a path
   * row is always on and a header row never is, so neither can make this crossing.
   */
  const promoteRequired = (row: KeyValueEntry, generated: KeyValueEntry | undefined): KeyValueEntry => {
    if (generated === undefined || generated.enabled || row.enabled) return row;
    return newRows.get(rowKey(row, caseless))?.enabled === true ? { ...row, enabled: true } : row;
  };
  // Only the first untouched row of a name follows; a duplicate of it is the user's and stays.
  const replaced = new Set<string>();
  for (const row of current) {
    const key = rowKey(row, caseless);
    const generated = oldRows.get(key);
    if (generated === undefined || !sameRow(row, generated) || replaced.has(key)) {
      const kept = promoteRequired(row, generated);
      if (kept !== row) changed = true;
      rows.push(kept);
      continue;
    }
    replaced.add(key);
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

/** Running counts {@link followRequest} adds to as it follows requests, shared across a whole apply. */
interface FollowCounters {
  orphaned: number;
  restored: number;
  rewritten: number;
  rowsAdded: number;
  rowsRemoved: number;
}

/**
 * One request as *Update definition* follows it: orphaned when `target` is gone, restored when it
 * came back, and otherwise the per-row and whole-field follow rule against `before` (what the old
 * document mapped it to) and `target` (what the new one does) — untouched url/body/auth follow the
 * new document, `pathParams`/`query`/`headers` merge row by row. Shared by an API's own requests and
 * a webhook group's, which is why `before` may be absent (an API row with no operation to compare
 * against) as well as `target` (an orphan).
 */
function followRequest(
  request: RestRequestDef,
  before: RestRequestDef | undefined,
  target: RestRequestDef | undefined,
  counters: FollowCounters,
): RestRequestDef {
  if (target === undefined) {
    if (request.orphaned === true) return request;
    counters.orphaned += 1;
    return { ...request, orphaned: true };
  }
  let out: RestRequestDef = request;
  if (request.orphaned === true) {
    counters.restored += 1;
    const { orphaned, ...rest } = request;
    void orphaned;
    out = rest;
  }
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
    counters.rowsAdded += merged.added;
    counters.rowsRemoved += merged.removed;
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
  if (rewritten) counters.rewritten += 1;
  return out;
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
  const oldMapped = apiFromDocument(old, { ...options, newId: () => 'old' }).api;
  const nextMapped = apiFromDocument(next, { ...options, newId }).api;
  const oldReqs = byContract(oldMapped);
  const nextReqs = byContract(nextMapped);

  const counters: FollowCounters = { orphaned: 0, restored: 0, rewritten: 0, rowsAdded: 0, rowsRemoved: 0 };

  const update = (request: RestRequestDef): RestRequestDef => {
    const key = contractKey(request);
    if (key === undefined) return request;
    return followRequest(request, oldReqs.get(key), nextReqs.get(key), counters);
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
  let requestsAlreadyPresent = 0;
  for (const [key, fresh] of nextReqs) {
    if (have.has(key)) {
      // A request the user made by hand already claims this contract; the plan still lists it as
      // added, so it is counted here rather than silently dropped.
      if (!oldReqs.has(key)) requestsAlreadyPresent += 1;
      continue;
    }
    const home = nextMapped.folders.find((folder) => folder.requests.some((r) => r.id === fresh.id));
    const place = (siblings: readonly RestRequestDef[]): RestRequestDef => ({
      ...fresh,
      slug: uniqueSlug(fresh.name, new Set(siblings.map((r) => r.slug))),
      order: siblings.reduce((n, r) => Math.max(n, r.order + 1), 0),
    });
    requestsAdded += 1;
    // Which existing folder is this tag's? The one with the tag's name, else — for a folder the
    // user renamed — the one already holding a request for another of the tag's operations.
    const existing = home === undefined ? undefined : folderFor(result, home);
    if (home === undefined) {
      result = { ...result, requests: [...result.requests, place(result.requests)] };
    } else if (existing !== undefined) {
      result = {
        ...result,
        folders: result.folders.map((folder) =>
          folder.id === existing.id ? { ...folder, requests: [...folder.requests, place(folder.requests)] } : folder,
        ),
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
  // A value absent on both sides stays absent rather than coming back as an `undefined` key.
  if (result.baseUrl === oldMapped.baseUrl && (nextMapped.baseUrl as string | undefined) !== undefined) {
    result = { ...result, baseUrl: nextMapped.baseUrl };
  }
  if (
    sameStructure(result.servers, oldMapped.servers) &&
    (nextMapped.servers as RestApi['servers'] | undefined) !== undefined
  ) {
    result = { ...result, servers: nextMapped.servers };
  }
  if (sameStructure(result.auth, oldMapped.auth) && !sameStructure(result.auth, nextMapped.auth)) {
    const { auth, ...rest } = result;
    void auth;
    result = nextMapped.auth === undefined ? rest : { ...rest, auth: nextMapped.auth };
  }
  if (result.definition !== undefined) {
    result = { ...result, definition: { ...result.definition, version: next.declaredVersion } };
  }

  return {
    api: result,
    requestsAdded,
    requestsAlreadyPresent,
    requestsOrphaned: counters.orphaned,
    requestsRestored: counters.restored,
    requestsRewritten: counters.rewritten,
    rowsAdded: counters.rowsAdded,
    rowsRemoved: counters.rowsRemoved,
  };
}

/**
 * The folder in `api` that stands for the new document's tag folder `home`: the one with the tag's
 * name, else — for a folder the user renamed — the one already holding a request for another of the
 * tag's operations. Name first: a request the user *moved* out of the tag folder would otherwise
 * make its new home look like the tag's, and put the new operation somewhere the user did not mean.
 */
function folderFor(api: RestApi, home: RestFolder): RestFolder | undefined {
  const byName = api.folders.find((folder) => folder.name === home.name);
  if (byName !== undefined) return byName;
  const keys = new Set(home.requests.map(contractKey).filter((key): key is string => key !== undefined));
  return api.folders.find((folder) =>
    folder.requests.some((request) => {
      const key = contractKey(request);
      return key !== undefined && keys.has(key);
    }),
  );
}

/** What {@link applyWebhookUpdate} changed, counted for the toast. */
export interface WebhookApplyResult {
  readonly folder: WebhookFolder;
  readonly added: number;
  readonly orphaned: number;
  readonly restored: number;
  readonly rewritten: number;
}

/**
 * Applies `next` to a webhook group imported from `old`: the same follow rule as
 * {@link applyRestUpdate}, matched by {@link hookKey} across the group's whole tree instead of by
 * contract. A request with no `hook` (added by hand) is left untouched; an item's `hook` — including
 * a callback's `expression` — follows the new document, since a renamed expression is not a new
 * item. A new webhook or callback method is appended to the group root with a unique slug and an
 * increasing `order`. Never deletes a request or a folder.
 */
export function applyWebhookUpdate(
  folder: WebhookFolder,
  old: OpenApiDocument,
  next: OpenApiDocument,
  options: ApplyRestUpdateOptions = {},
): WebhookApplyResult {
  const newId = options.newId ?? generateId;
  const index = (document: OpenApiDocument, ids: IdGenerator): Map<string, RestRequestDef> => {
    const mapped = webhooksFromDocument(document, { ...options, apiId: folder.source?.apiId ?? '', newId: ids });
    const map = new Map<string, RestRequestDef>();
    for (const request of mapped?.folder.requests ?? []) {
      if (request.hook !== undefined) map.set(hookKey(request.hook, request.method), request);
    }
    return map;
  };
  // The old mapping's ids are never kept: only its generated values are compared.
  const before = index(old, () => 'old');
  const after = index(next, newId);
  const counters: FollowCounters = { orphaned: 0, restored: 0, rewritten: 0, rowsAdded: 0, rowsRemoved: 0 };
  const seen = new Set<string>();

  const follow = (request: RestRequestDef): RestRequestDef => {
    if (request.hook === undefined) return request;
    const key = hookKey(request.hook, request.method);
    seen.add(key);
    const target = after.get(key);
    const followed = followRequest(request, before.get(key), target, counters);
    return target?.hook !== undefined ? { ...followed, hook: target.hook } : followed;
  };
  const walk = (node: WebhookFolder): WebhookFolder => ({
    ...node,
    folders: node.folders.map(walk),
    requests: node.requests.map(follow),
  });
  const walked = walk(folder);

  const requests = [...walked.requests];
  const taken = new Set(requests.map((request) => request.slug));
  let order = requests.reduce((max, request) => Math.max(max, request.order + 1), 0);
  let added = 0;
  for (const [key, fresh] of after) {
    if (seen.has(key)) continue;
    const slug = uniqueSlug(fresh.name, taken);
    taken.add(slug);
    requests.push({ ...fresh, slug, order });
    order += 1;
    added += 1;
  }

  return {
    folder: { ...walked, requests },
    added,
    orphaned: counters.orphaned,
    restored: counters.restored,
    rewritten: counters.rewritten,
  };
}
