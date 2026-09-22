/**
 * The WebSocket fourth of the project model: a *WebSocket API* — a target, a set of saved
 * messages, and a tree of folders and requests, one request per socket connection the user wants
 * to keep.
 *
 * A WebSocket API is the fourth sibling container beside a SOAP interface, a REST API and a gRPC
 * API (ADR-0007). It identifies itself with `kind: websocket` at the top of every file it writes,
 * so a file says what it is without anyone having to know which directory implies which protocol.
 * In memory it is kept in its own list on the project so the compiler points at every surface that
 * needs a fourth branch rather than letting a WebSocket API fall through a REST- or gRPC-shaped
 * `if`.
 *
 * The same rules as the other models apply: every field is `readonly`, ids are ULIDs so an entity
 * survives a rename, `slug` is the file-system name derived from `name`, and nothing here ever
 * holds a secret — credentials are `secretRef`s resolved from the OS keychain at send time.
 */

import type { AuthConfig, CreateOptions, IdGenerator } from '../project/model.js';
import { generateId } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { JsonSchemaProblem } from '../json/schema-validate.js';
import type { KeyValueEntry } from '../rest/model.js';
import type { SslInfo } from '../http/tls.js';

// The pure tree and naming rules live in `shape.ts`, which imports nothing but `pretty.ts`, so the
// renderer can have them without `node:path` coming along; they are re-exported here because this
// is where callers expect a ws model rule to be.
export { wsApiFolders, wsApiRequests, wsFolderRequests, wsMessageFileName } from './shape.js';

/**
 * Per-request transport settings. Every field is optional and an absent one means *inherit*, not
 * *off*: the send resolves request → API → project → preference, exactly as a REST request does.
 */
export interface WsRequestSettings {
  readonly handshakeTimeoutMs?: number;
  readonly trustInvalid?: boolean;
  readonly sslKeystoreRef?: string;
  readonly bindAddress?: string;
  /** Close the session when a received message is larger than this. */
  readonly maxMessageBytes?: number;
  readonly escapeProperties?: boolean;
}

/** Which channel of the API's contract a request was imported from: the channel key in the document. */
export interface WsContractLink {
  readonly channel: string;
}

/** Which contract message a saved message was generated from, and the text it was generated as. */
export interface WsMessageContractLink {
  readonly message: string;
  /** The sample as imported — what Update Definition compares against to tell an untouched message. */
  readonly generated: string;
}

/** A message saved under a request, ready to send without retyping it. */
export interface WsSavedMessage {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly format: 'text' | 'binary';
  /** The text as edited; for `binary`, base64. Stored in `<request-slug>.msg-<slug>.<ext>`. */
  readonly content: string;
  readonly contract?: WsMessageContractLink;
}

/** A saved WebSocket request: a URL to dial, headers and query to send, and saved messages. */
export interface WsRequestDef {
  readonly kind: 'websocket';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** A path joined to the API's server URL, or an absolute `ws(s)://` / `http(s)://` URL. */
  readonly url: string;
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly subprotocols: readonly string[];
  readonly auth: AuthConfig;
  readonly settings: WsRequestSettings;
  readonly messages: readonly WsSavedMessage[];
  /** Set when the request was imported from the API's contract. */
  readonly contract?: WsContractLink;
  /** The contract no longer has the channel this request was imported from. */
  readonly orphaned?: boolean;
}

/** A named node in a WebSocket API's tree. */
export interface WsFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** Default credentials for everything inside, unless a child says otherwise. */
  readonly auth?: AuthConfig;
  readonly folders: readonly WsFolder[];
  readonly requests: readonly WsRequestDef[];
}

/** Reserved for the contract import (#100); nothing in this plan reads it. */
export interface WsDefinitionRef {
  readonly kind: 'asyncapi';
  readonly source: string;
  readonly cache: boolean;
}

/** A WebSocket API: a server URL and a tree of folders and requests. */
export interface WsApi {
  readonly kind: 'websocket';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** The server URL; may hold `${…}`; an environment overrides it under the API's slug. */
  readonly url: string;
  readonly headers: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
  readonly definition?: WsDefinitionRef;
  readonly folders: readonly WsFolder[];
  readonly requests: readonly WsRequestDef[];
}

/** How a frame fared against its channel's contract. `not-checked` means the check ran out of
 *  time and stopped: it says nothing either way about the frame. */
export type WsFrameContractStatus = 'ok' | 'violation' | 'unmatched' | 'skipped' | 'not-checked';

/** One frame's contract check result: plain data, so it can cross a worker boundary. */
export interface WsFrameContract {
  readonly status: WsFrameContractStatus;
  /** The matched message's name, or the closest one's on a violation. */
  readonly message?: string;
  readonly problems?: readonly JsonSchemaProblem[];
  /** Why a frame is a violation without schema problems, unmatched, skipped or not checked. */
  readonly reason?: string;
}

export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';

/** One frame sent or received during a WebSocket session, as shown in the log. */
export interface WsFrame {
  readonly index: number;
  readonly direction: 'sent' | 'received';
  readonly opcode: WsOpcode;
  /** Milliseconds since the session started. */
  readonly at: number;
  /** Payload bytes. */
  readonly size: number;
  readonly text?: string;
  readonly base64?: string;
  readonly close?: { readonly code: number; readonly reason: string };
  readonly payloadTruncated?: boolean;
  /** Set when the session's request is linked to a contract channel. */
  readonly contract?: WsFrameContract;
}

/** The handshake that opened (or failed to open) a WebSocket session. */
export interface WsHandshake {
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestedSubprotocols: readonly string[];
  readonly rawRequestHead?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly protocol?: string;
  readonly extensions?: string;
  readonly remoteAddress?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly tls?: SslInfo;
  readonly error?: string;
}

/** A completed (or in-progress) WebSocket session: the handshake, its frames, and how it closed. */
export interface WsExchange {
  readonly kind: 'websocket';
  readonly url: string;
  readonly handshake: WsHandshake;
  readonly frames: readonly WsFrame[];
  readonly closed: { readonly code: number; readonly reason: string; readonly by: 'client' | 'server' | 'error' };
  readonly counts: {
    readonly sent: number;
    readonly received: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
  };
  readonly durationMs: number;
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Input to {@link createWsApi} beyond the name. */
export interface CreateWsApiInput extends CreateOptions {
  readonly url?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly headers?: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
  readonly definition?: WsDefinitionRef;
  readonly folders?: readonly WsFolder[];
  readonly requests?: readonly WsRequestDef[];
}

/** Creates an empty WebSocket API. */
export function createWsApi(name: string, input: CreateWsApiInput = {}): WsApi {
  return {
    kind: 'websocket',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    url: input.url ?? '',
    headers: input.headers ?? [],
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.definition !== undefined ? { definition: input.definition } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createWsFolder} beyond the name. */
export interface CreateWsFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders?: readonly WsFolder[];
  readonly requests?: readonly WsRequestDef[];
}

/** Creates an empty folder. */
export function createWsFolder(name: string, input: CreateWsFolderInput = {}): WsFolder {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createWsRequest} beyond the name. */
export interface CreateWsRequestInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly url?: string;
  readonly query?: readonly KeyValueEntry[];
  readonly headers?: readonly KeyValueEntry[];
  readonly subprotocols?: readonly string[];
  readonly auth?: AuthConfig;
  readonly settings?: WsRequestSettings;
  readonly messages?: readonly WsSavedMessage[];
  readonly contract?: WsContractLink;
}

/** Creates a request with an empty URL and inherited credentials, and nothing saved. */
export function createWsRequest(name: string, input: CreateWsRequestInput = {}): WsRequestDef {
  return {
    kind: 'websocket',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    url: input.url ?? '',
    query: input.query ?? [],
    headers: input.headers ?? [],
    subprotocols: input.subprotocols ?? [],
    auth: input.auth ?? { type: 'inherit' },
    settings: input.settings ?? {},
    messages: input.messages ?? [],
    ...(input.contract !== undefined ? { contract: input.contract } : {}),
  };
}

/** Creates a saved message, text and empty by default. */
export function createWsSavedMessage(
  name: string,
  input?: CreateOptions & {
    readonly slug?: string;
    readonly format?: 'text' | 'binary';
    readonly content?: string;
    readonly contract?: WsMessageContractLink;
  },
): WsSavedMessage {
  return {
    id: idOf(input),
    name,
    slug: input?.slug ?? slugify(name),
    format: input?.format ?? 'text',
    content: input?.content ?? '',
    ...(input?.contract !== undefined ? { contract: input.contract } : {}),
  };
}

export type { IdGenerator };
