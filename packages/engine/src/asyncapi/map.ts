/**
 * An AsyncAPI document as a WebSocket API: one request per WebSocket channel, a saved sample per
 * message Wirebench sends on it, and the server's first mappable security scheme as the API's auth.
 *
 * Pure: the same document and ids give the same API. Everything the mapping cannot carry over is a
 * line in the summary, never an error — except asking for a server the document does not have.
 */

import { AsyncApiError } from '../errors.js';
import { unsupportedKeywordsIn } from '../json/schema-validate.js';
import type { AuthConfig, IdGenerator } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import { entry, type KeyValueEntry } from '../rest/model.js';
import { sampleFromSchema } from '../rest/openapi/sample.js';
import {
  createWsApi,
  createWsFolder,
  createWsRequest,
  createWsSavedMessage,
  type WsApi,
  type WsFolder,
  type WsRequestDef,
  type WsSavedMessage,
} from '../ws/model.js';
import type { AsyncApiChannel, AsyncApiDocument, AsyncApiMessage, AsyncApiServer, AsyncApiSkip } from './model.js';
import { isJsonSchemaFormat, isRecord, record, str } from './read.js';
import { authFromScheme, isSkip } from './security.js';

export interface MapAsyncApiOptions {
  /** The server key to dial; defaults to the first `ws`/`wss` server. */
  readonly server?: string;
  readonly newId?: IdGenerator;
}

export interface AsyncApiImportSummary {
  readonly declaredVersion: string;
  readonly title: string;
  /** The server the API's URL came from, when there was a WebSocket one. */
  readonly server?: string;
  /** Every server key the document lists, WebSocket or not. */
  readonly servers: readonly string[];
  readonly requests: number;
  readonly messages: number;
  readonly skipped: readonly AsyncApiSkip[];
  /** Parameters and server variables left as `${name}` for the user to define. */
  readonly unresolved: readonly string[];
  /** JSON Schema keywords the contract check will not assert. */
  readonly unsupportedKeywords: readonly string[];
}

export interface MappedAsyncApi {
  readonly api: WsApi;
  readonly summary: AsyncApiImportSummary;
}

const WS_PROTOCOLS: ReadonlySet<string> = new Set(['ws', 'wss']);
const SUBPROTOCOL_HEADER = 'sec-websocket-protocol';

function isWsServer(server: AsyncApiServer): boolean {
  return WS_PROTOCOLS.has(server.protocol.toLowerCase());
}

/** `{name}` placeholders as Wirebench properties, the names collected. */
function asProperties(text: string, unresolved: Set<string>): string {
  return text.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    unresolved.add(name);
    return `\${${name}}`;
  });
}

function channelUrl(channel: AsyncApiChannel, unresolved: Set<string>): string {
  if (channel.address === null) return '';
  return channel.address.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    const p = channel.parameters[name];
    const chosen = p?.default ?? p?.enum?.[0] ?? p?.examples?.[0];
    if (chosen !== undefined) return chosen;
    unresolved.add(name);
    return `\${${name}}`;
  });
}

function sampleText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

function sampleOf(schema: unknown): unknown {
  return isRecord(schema) ? sampleFromSchema(schema, { includeOptional: false, sampleValues: true }) : '';
}

interface WsBinding {
  readonly query: KeyValueEntry[];
  readonly headers: KeyValueEntry[];
  readonly subprotocols: string[];
}

/** `bindings.ws`: query and header properties as entries, `Sec-WebSocket-Protocol` as subprotocols. */
function wsBinding(channel: AsyncApiChannel, skipped: AsyncApiSkip[]): WsBinding {
  const binding = record(channel.bindings['ws']);
  const where = `channel ${channel.key}`;
  const method = str(binding['method']);
  if (method !== undefined && method.toUpperCase() !== 'GET') {
    skipped.push({ where, reason: `ws binding method ${method} is ignored: a handshake is always GET` });
  }
  const propertiesOf = (schema: unknown) => Object.entries(record(record(schema)['properties']));
  const query = propertiesOf(binding['query']).map(([name, schema]) => entry(name, sampleText(sampleOf(schema))));
  const headers: KeyValueEntry[] = [];
  const subprotocols: string[] = [];
  for (const [name, schema] of propertiesOf(binding['headers'])) {
    if (name.toLowerCase() !== SUBPROTOCOL_HEADER) {
      headers.push(entry(name, sampleText(sampleOf(schema))));
      continue;
    }
    const s = record(schema);
    const offered = typeof s['const'] === 'string' ? [s['const']] : Array.isArray(s['enum']) ? s['enum'] : [];
    const names = offered.filter((v): v is string => typeof v === 'string');
    if (names.length === 0) {
      skipped.push({ where, reason: 'Sec-WebSocket-Protocol has no const or enum to take a subprotocol from' });
    }
    subprotocols.push(...names);
  }
  return { query, headers, subprotocols };
}

/** Why a channel is not a WebSocket one, or undefined when it is. */
function notWebSocket(channel: AsyncApiChannel, servers: readonly AsyncApiServer[]): string | undefined {
  if (isRecord(channel.bindings['ws'])) return undefined;
  const on =
    channel.servers === 'all' ? servers : servers.filter((s) => (channel.servers as readonly string[]).includes(s.key));
  if (on.some(isWsServer)) return undefined;
  const bindings = Object.keys(channel.bindings);
  if (bindings.length > 0) return `${bindings.join(', ')} binding: only WebSocket is imported`;
  const protocols = [...new Set(on.map((s) => s.protocol))];
  return protocols.length > 0
    ? `served over ${protocols.join(', ')}: only WebSocket is imported`
    : 'no WebSocket server carries it';
}

/** The saved-message text for one outgoing message, or undefined when it gets no sample. */
function messageText(m: AsyncApiMessage): string | undefined {
  if (!isJsonSchemaFormat(m.schemaFormat)) return undefined;
  const value = m.example !== undefined ? m.example : sampleOf(m.payload);
  if (typeof value === 'string' && record(m.payload)['type'] === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function chooseServer(document: AsyncApiDocument, wanted: string | undefined): AsyncApiServer | undefined {
  if (wanted === undefined) return document.servers.find(isWsServer);
  const server = document.servers.find((s) => s.key === wanted);
  if (server === undefined || !isWsServer(server)) {
    throw new AsyncApiError('asyncapi-server-unknown', `The document has no WebSocket server named ${wanted}`, {
      details: { server: wanted },
    });
  }
  return server;
}

/**
 * Maps a parsed document to a WebSocket API.
 *
 * @throws AsyncApiError `asyncapi-server-unknown` when `options.server` names no WebSocket server
 */
export function mapAsyncApi(document: AsyncApiDocument, options: MapAsyncApiOptions = {}): MappedAsyncApi {
  const newId = options.newId;
  const ids = newId !== undefined ? { newId } : {};
  const skipped: AsyncApiSkip[] = [...document.notes];
  const unresolved = new Set<string>();
  const unsupported = new Set<string>();

  const server = chooseServer(document, options.server);
  for (const s of document.servers) {
    if (!isWsServer(s))
      skipped.push({ where: `server ${s.key}`, reason: `${s.protocol} server: only WebSocket is imported` });
  }
  if (server === undefined) skipped.push({ where: 'servers', reason: 'no ws or wss server: the API has no URL' });
  const url = server !== undefined ? asProperties(server.url, unresolved) : '';

  let auth: AuthConfig | undefined;
  for (const scheme of server?.security ?? []) {
    const mapped = authFromScheme(scheme);
    if (isSkip(mapped)) {
      skipped.push(mapped);
    } else if (auth === undefined) {
      auth = mapped;
    } else {
      skipped.push({ where: `security ${scheme.key}`, reason: `only the first scheme becomes the API's auth` });
    }
  }

  const rootRequests: WsRequestDef[] = [];
  const folders = new Map<string, WsRequestDef[]>();
  const requestSlugs = new Map<string, Set<string>>();
  let messageCount = 0;
  let order = 0;

  for (const channel of document.channels) {
    const where = `channel ${channel.key}`;
    const why = notWebSocket(channel, document.servers);
    if (why !== undefined) {
      skipped.push({ where, reason: why });
      continue;
    }
    for (const key of Object.keys(channel.bindings)) {
      if (key !== 'ws') skipped.push({ where, reason: `${key} binding is ignored on a WebSocket channel` });
    }
    const binding = wsBinding(channel, skipped);
    const operations = document.operations.filter((o) => o.channel === channel.key);

    const messages: WsSavedMessage[] = [];
    const messageSlugs = new Set<string>();
    const seen = new Set<string>();
    for (const op of operations) {
      for (const m of op.messages) {
        if (isJsonSchemaFormat(m.schemaFormat)) for (const k of unsupportedKeywordsIn(m.payload)) unsupported.add(k);
        if (op.direction !== 'sent' || seen.has(m.key)) continue;
        seen.add(m.key);
        const content = messageText(m);
        if (content === undefined) continue;
        const slug = uniqueSlug(m.name, messageSlugs);
        messageSlugs.add(slug);
        messages.push(
          createWsSavedMessage(m.name, { ...ids, slug, content, contract: { message: m.key, generated: content } }),
        );
      }
    }
    messageCount += messages.length;

    const tag = channel.tags[0];
    const bucket = tag ?? '';
    const slugs = requestSlugs.get(bucket) ?? new Set<string>();
    requestSlugs.set(bucket, slugs);
    const slug = uniqueSlug(channel.key, slugs);
    slugs.add(slug);
    const request = createWsRequest(channel.key, {
      ...ids,
      slug,
      order: order++,
      url: channelUrl(channel, unresolved),
      query: binding.query,
      headers: binding.headers,
      subprotocols: binding.subprotocols,
      messages,
      contract: { channel: channel.key },
    });
    if (tag === undefined) rootRequests.push(request);
    else folders.set(tag, [...(folders.get(tag) ?? []), request]);
  }

  const folderSlugs = new Set<string>();
  const folderList: WsFolder[] = [...folders].map(([name, requests], index) => {
    const slug = uniqueSlug(name, folderSlugs);
    folderSlugs.add(slug);
    return createWsFolder(name, { ...ids, slug, order: index, requests });
  });

  const requestCount = rootRequests.length + folderList.reduce((n, f) => n + f.requests.length, 0);
  const api = createWsApi(document.title, {
    ...ids,
    url,
    ...(auth !== undefined ? { auth } : {}),
    folders: folderList,
    requests: rootRequests,
  });
  return {
    api,
    summary: {
      declaredVersion: document.declaredVersion,
      title: document.title,
      ...(server !== undefined ? { server: server.key } : {}),
      servers: document.servers.map((s) => s.key),
      requests: requestCount,
      messages: messageCount,
      skipped,
      unresolved: [...unresolved],
      unsupportedKeywords: [...unsupported].sort(),
    },
  };
}
