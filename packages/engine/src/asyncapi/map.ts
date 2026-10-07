/**
 * An AsyncAPI document as a WebSocket API: one request per WebSocket channel, a saved sample per
 * message Wirebench sends on it, and the server's first mappable security scheme as the API's auth.
 *
 * Pure: the same document and ids give the same API. Everything the mapping cannot carry over is a
 * line in the summary, never an error — except asking for a server the document does not have.
 */

import { AsyncApiError } from '../errors.js';
import { unsupportedKeywordsIn } from '../json/schema-validate.js';
import { escapeExpansions } from '../project/escape-expansions.js';
import type { AuthConfig, IdGenerator } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import { entry, type KeyValueEntry } from '../http/entries.js';
import { sampleFromSchema } from '../json/schema/sample.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
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

/**
 * The names a `{name}` slot may turn into a `${name}` property: the grammar `project/properties.ts`
 * holds a `${secret:name}` name to, so no `#Scope#` prefix, `secret:`, `:`, `#`, brace, space or `$`
 * can make the reference read anything but a plain property (#287).
 */
const PLAIN_NAME = SECRET_NAME_PATTERN;

/** A `{…}` slot as the document writes it: up to the first `}`, so a nested brace is part of the name. */
const SLOT = /\{([^}]+)\}/g;

interface Slots {
  readonly where: string;
  readonly unresolved: Set<string>;
  readonly skipped: AsyncApiSkip[];
}

/**
 * Contract text with `{name}` slots, as Wirebench text. A slot the document gives a value fills in
 * that value as literal text; one it does not, with a plain name, becomes the `${name}` property for
 * the user to define; any other slot stays the literal `{…}` it was written as. Every literal run —
 * the document's own text and the values together — is then escaped with `escapeExpansions`, so a
 * `${…}` the contract wrote is sent as written and never reads a property, a secret or the
 * environment. The `${name}` properties are the only references the result holds.
 */
function withSlots(text: string, valueOf: (name: string) => string | undefined, slots: Slots): string {
  let out = '';
  let literal = '';
  let last = 0;
  for (const match of text.matchAll(SLOT)) {
    literal += text.slice(last, match.index);
    last = match.index + match[0].length;
    const name = match[1]!;
    const value = valueOf(name);
    if (value !== undefined) {
      literal += value;
    } else if (!PLAIN_NAME.test(name)) {
      slots.skipped.push({
        where: slots.where,
        reason: `${match[0]} is not a plain property name: it is kept as literal text`,
      });
      literal += match[0];
    } else if (literal.endsWith('$')) {
      // `$` + `${name}` would read as the `$${` escape: no reference can follow a literal `$`.
      literal += match[0];
    } else {
      out += `${escapeExpansions(literal)}\${${name}}`;
      literal = '';
      slots.unresolved.add(name);
    }
  }
  return out + escapeExpansions(literal + text.slice(last));
}

function serverUrl(server: AsyncApiServer, slots: Slots): string {
  return withSlots(
    server.template,
    (name) => (Object.hasOwn(server.variables, name) ? server.variables[name] : undefined),
    slots,
  );
}

function channelUrl(channel: AsyncApiChannel, slots: Slots): string {
  if (channel.address === null) return '';
  return withSlots(
    channel.address,
    (name) => {
      const p = Object.hasOwn(channel.parameters, name) ? channel.parameters[name] : undefined;
      return p?.default ?? p?.enum?.[0] ?? p?.examples?.[0];
    },
    slots,
  );
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
  // Names and samples are the document's text, escaped: a send expands both (#287).
  const literal = (name: string, schema: unknown) =>
    entry(escapeExpansions(name), escapeExpansions(sampleText(sampleOf(schema))));
  const query = propertiesOf(binding['query']).map(([name, schema]) => literal(name, schema));
  const headers: KeyValueEntry[] = [];
  const subprotocols: string[] = [];
  for (const [name, schema] of propertiesOf(binding['headers'])) {
    if (name.toLowerCase() !== SUBPROTOCOL_HEADER) {
      headers.push(literal(name, schema));
      continue;
    }
    const s = record(schema);
    const offered = typeof s['const'] === 'string' ? [s['const']] : Array.isArray(s['enum']) ? s['enum'] : [];
    const names = offered.filter((v): v is string => typeof v === 'string');
    if (names.length === 0) {
      skipped.push({ where, reason: 'Sec-WebSocket-Protocol has no const or enum to take a subprotocol from' });
    }
    subprotocols.push(...names.map(escapeExpansions));
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

/**
 * The saved-message text for one outgoing message, or undefined when it gets no sample. The
 * document's example or sample, escaped: a send expands a saved message (#287).
 */
function messageText(m: AsyncApiMessage): string | undefined {
  if (!isJsonSchemaFormat(m.schemaFormat)) return undefined;
  const value = m.example !== undefined ? m.example : sampleOf(m.payload);
  if (typeof value === 'string' && record(m.payload)['type'] === 'string') return escapeExpansions(value);
  return escapeExpansions(JSON.stringify(value, null, 2) ?? '');
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
  const url = server !== undefined ? serverUrl(server, { where: `server ${server.key}`, unresolved, skipped }) : '';

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
      url: channelUrl(channel, { where, unresolved, skipped }),
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
