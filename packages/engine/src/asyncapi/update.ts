/**
 * Update Definition for an AsyncAPI-imported WebSocket API: a per-operation report of what a new
 * version of the document changes, and applying it without losing anything the user made.
 *
 * The rule is the one gRPC and WSDL keep: **nothing is ever deleted.** A channel the document no
 * longer has keeps its request, flagged `orphaned`; one that came back has the flag cleared. A value
 * the mapping generated (URL, query, headers, subprotocols, a message sample, the API's URL and auth)
 * follows the contract only while it still equals what the old contract generated; an edited one is
 * kept, and for a message the new sample is added beside it as `<name> (updated)`.
 *
 * Pure: it compares through {@link mapAsyncApi}'s output and writes nothing.
 */

import type { IdGenerator } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import {
  createWsFolder,
  wsApiRequests,
  type WsApi,
  type WsFolder,
  type WsRequestDef,
  type WsSavedMessage,
} from '../ws/model.js';
import { mapAsyncApi, type MapAsyncApiOptions } from './map.js';
import type { AsyncApiChannel, AsyncApiDocument, AsyncApiOperation, AsyncApiServer } from './model.js';

export type AsyncApiChangeReason = 'address' | 'payload' | 'bindings' | 'security' | 'messages';

export interface AsyncApiOpRef {
  readonly key: string;
  readonly channel: string;
  readonly direction: 'sent' | 'received';
}

export interface AsyncApiUpdatePlan {
  readonly added: readonly AsyncApiOpRef[];
  readonly removed: readonly AsyncApiOpRef[];
  readonly changed: readonly { readonly op: AsyncApiOpRef; readonly reasons: readonly AsyncApiChangeReason[] }[];
}

export interface ApplyAsyncApiUpdateOptions {
  /** The server both versions are mapped against; defaults to the first WebSocket one. */
  readonly server?: string;
  readonly newId?: IdGenerator;
}

/** What {@link applyAsyncApiUpdate} did, in ids the caller can report or select. */
export interface AsyncApiApplyResult {
  readonly api: WsApi;
  readonly requestsAdded: readonly string[];
  readonly requestsOrphaned: readonly string[];
  readonly requestsRestored: readonly string[];
  /** Requests where at least one generated field followed the contract. */
  readonly requestsRewritten: readonly string[];
  /** Untouched saved messages whose sample was replaced in place. */
  readonly messagesReplaced: readonly string[];
  /** Saved messages created: new outgoing messages and `<name> (updated)` beside edited ones. */
  readonly messagesAdded: readonly string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function opRef(op: AsyncApiOperation): AsyncApiOpRef {
  return { key: op.key, channel: op.channel, direction: op.direction };
}

function channelServers(doc: AsyncApiDocument, channel: AsyncApiChannel | undefined): AsyncApiServer[] {
  if (channel === undefined) return [];
  return channel.servers === 'all'
    ? [...doc.servers]
    : doc.servers.filter((s) => (channel.servers as readonly string[]).includes(s.key));
}

function reasonsFor(
  old: AsyncApiDocument,
  next: AsyncApiDocument,
  a: AsyncApiOperation,
  b: AsyncApiOperation,
): AsyncApiChangeReason[] {
  const ca = old.channels.find((c) => c.key === a.channel);
  const cb = next.channels.find((c) => c.key === b.channel);
  const reasons: AsyncApiChangeReason[] = [];
  if (!same(ca?.address, cb?.address) || !same(ca?.parameters, cb?.parameters)) {
    reasons.push('address');
  }
  const keysA = a.messages.map((m) => m.key);
  const keysB = b.messages.map((m) => m.key);
  const payloadChanged = a.messages.some((m) => {
    const n = b.messages.find((x) => x.key === m.key);
    return n !== undefined && !same(m, n);
  });
  if (payloadChanged) reasons.push('payload');
  if (!same(ca?.bindings, cb?.bindings)) reasons.push('bindings');
  const security = (doc: AsyncApiDocument, c: AsyncApiChannel | undefined) =>
    channelServers(doc, c).map((s) => [s.key, s.security]);
  if (!same(security(old, ca), security(next, cb))) reasons.push('security');
  if (a.direction !== b.direction || !same(keysA, keysB)) reasons.push('messages');
  return reasons;
}

/** Operations added, removed and changed between two versions, keyed by operation id. */
export function planAsyncApiUpdate(old: AsyncApiDocument, next: AsyncApiDocument): AsyncApiUpdatePlan {
  const oldOps = new Map(old.operations.map((o) => [o.key, o]));
  const nextOps = new Map(next.operations.map((o) => [o.key, o]));
  // Requests are linked by channel, so an operation that moved to another channel key is, as applying
  // sees it, removed from the old channel's request and added to the new one's — not an address change.
  const sameChannel = (a: AsyncApiOperation | undefined, b: AsyncApiOperation | undefined) =>
    a !== undefined && b !== undefined && a.channel === b.channel;
  const added = next.operations.filter((o) => !sameChannel(oldOps.get(o.key), o)).map(opRef);
  const removed = old.operations.filter((o) => !sameChannel(o, nextOps.get(o.key))).map(opRef);
  const changed: { op: AsyncApiOpRef; reasons: AsyncApiChangeReason[] }[] = [];
  for (const b of next.operations) {
    const a = oldOps.get(b.key);
    if (a === undefined || !sameChannel(a, b)) continue;
    const reasons = reasonsFor(old, next, a, b);
    if (reasons.length > 0) changed.push({ op: opRef(b), reasons });
  }
  return { added, removed, changed };
}

type ReqPatch = Pick<WsRequestDef, 'url' | 'query' | 'headers' | 'subprotocols'>;
const GENERATED: readonly (keyof ReqPatch)[] = ['url', 'query', 'headers', 'subprotocols'];

function byChannel(api: WsApi): Map<string, WsRequestDef> {
  const map = new Map<string, WsRequestDef>();
  for (const r of wsApiRequests(api)) if (r.contract !== undefined) map.set(r.contract.channel, r);
  return map;
}

/** The folder a mapped request sits in (the mapping makes one level, by tag), or undefined at the root. */
function folderOf(api: WsApi, id: string): string | undefined {
  return api.folders.find((f) => f.requests.some((r) => r.id === id))?.name;
}

/**
 * Applies `next` to an API imported from `old`. Never deletes a request or a saved message.
 */
export function applyAsyncApiUpdate(
  api: WsApi,
  old: AsyncApiDocument,
  next: AsyncApiDocument,
  options: ApplyAsyncApiUpdateOptions = {},
): AsyncApiApplyResult {
  const mapOptions: MapAsyncApiOptions = options.server !== undefined ? { server: options.server } : {};
  // The old mapping's ids are never kept: only its generated values are compared.
  const oldMapped = mapAsyncApi(old, { ...mapOptions, newId: () => 'old' }).api;
  const nextMapped = mapAsyncApi(next, {
    ...mapOptions,
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
  }).api;
  const oldReqs = byChannel(oldMapped);
  const nextReqs = byChannel(nextMapped);

  const requestsOrphaned: string[] = [];
  const requestsRestored: string[] = [];
  const requestsRewritten: string[] = [];
  const messagesReplaced: string[] = [];
  const messagesAdded: string[] = [];

  const update = (req: WsRequestDef): WsRequestDef => {
    const channel = req.contract?.channel;
    if (channel === undefined) return req;
    const target = nextReqs.get(channel);
    if (target === undefined) {
      if (req.orphaned === true) return req;
      requestsOrphaned.push(req.id);
      return { ...req, orphaned: true };
    }
    let out: WsRequestDef = req;
    if (req.orphaned === true) {
      requestsRestored.push(req.id);
      const { orphaned, ...rest } = req;
      void orphaned;
      out = rest;
    }
    const before = oldReqs.get(channel);
    let rewritten = false;
    for (const field of GENERATED) {
      if (before !== undefined && same(out[field], before[field]) && !same(out[field], target[field])) {
        out = { ...out, [field]: target[field] };
        rewritten = true;
      }
    }
    if (rewritten) requestsRewritten.push(req.id);

    const messages: WsSavedMessage[] = [...out.messages];
    let touched = false;
    const slugs = new Set(messages.map((m) => m.slug));
    for (const sample of target.messages) {
      const key = sample.contract!.message;
      const generated = sample.contract!.generated;
      const linked = messages.filter((m) => m.contract?.message === key);
      if (linked.length === 0) {
        const slug = uniqueSlug(sample.name, slugs);
        slugs.add(slug);
        messages.push({ ...sample, slug });
        messagesAdded.push(sample.id);
        touched = true;
        continue;
      }
      if (linked.some((m) => m.content === generated)) continue;
      const untouched = linked.filter((m) => m.content === m.contract!.generated);
      if (untouched.length > 0) {
        for (const m of untouched) {
          messages[messages.indexOf(m)] = { ...m, content: generated, contract: { message: key, generated } };
          messagesReplaced.push(m.id);
        }
        touched = true;
        continue;
      }
      const name = `${sample.name} (updated)`;
      const slug = uniqueSlug(name, slugs);
      slugs.add(slug);
      messages.push({ ...sample, name, slug });
      messagesAdded.push(sample.id);
      touched = true;
    }
    return touched ? { ...out, messages } : out;
  };

  const updateFolder = (f: WsFolder): WsFolder => ({
    ...f,
    folders: f.folders.map(updateFolder),
    requests: f.requests.map(update),
  });
  let result: WsApi = { ...api, folders: api.folders.map(updateFolder), requests: api.requests.map(update) };

  // Channels the API has no request for yet: into the folder their tag names, else the root.
  const have = byChannel(result);
  const requestsAdded: string[] = [];
  const all = wsApiRequests(result);
  let order = all.reduce((n, r) => Math.max(n, r.order + 1), 0);
  for (const [channel, fresh] of nextReqs) {
    if (have.has(channel)) continue;
    const folderName = folderOf(nextMapped, fresh.id);
    const siblings =
      folderName === undefined ? result.requests : (result.folders.find((f) => f.name === folderName)?.requests ?? []);
    const slug = uniqueSlug(fresh.name, new Set(siblings.map((r) => r.slug)));
    const req: WsRequestDef = { ...fresh, slug, order: order++ };
    requestsAdded.push(req.id);
    messagesAdded.push(...req.messages.map((m) => m.id));
    if (folderName === undefined) {
      result = { ...result, requests: [...result.requests, req] };
    } else if (result.folders.some((f) => f.name === folderName)) {
      result = {
        ...result,
        folders: result.folders.map((f) => (f.name === folderName ? { ...f, requests: [...f.requests, req] } : f)),
      };
    } else {
      const folderSlug = uniqueSlug(folderName, new Set(result.folders.map((f) => f.slug)));
      const folder = createWsFolder(folderName, {
        ...(options.newId !== undefined ? { newId: options.newId } : {}),
        slug: folderSlug,
        order: result.folders.length,
        requests: [req],
      });
      result = { ...result, folders: [...result.folders, folder] };
    }
  }

  if (same(result.url, oldMapped.url) && !same(result.url, nextMapped.url)) result = { ...result, url: nextMapped.url };
  if (same(result.auth, oldMapped.auth) && !same(result.auth, nextMapped.auth)) {
    const { auth, ...rest } = result;
    void auth;
    result = nextMapped.auth !== undefined ? { ...rest, auth: nextMapped.auth } : rest;
  }

  return {
    api: result,
    requestsAdded,
    requestsOrphaned,
    requestsRestored,
    requestsRewritten,
    messagesReplaced,
    messagesAdded,
  };
}
