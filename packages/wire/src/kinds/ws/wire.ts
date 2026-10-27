/**
 * The wire shapes only WebSocket uses (kind modules spec §4.2): APIs, requests, sessions in flight
 * and AsyncAPI import. Imports `wire-base.ts` and never another kind's file.
 */

import { z } from 'zod';
import {
  MAX_IMPORT_NAME_CHARS,
  authConfigWireSchema,
  definitionAuthWireSchema,
  hasFetchableAuthSource,
  keyValueWireSchema,
  onlyWithAUrl,
  openApiSourceSchema,
  projectAddInterfaceTargetSchema,
  requestAssertionResultWireSchema,
  requestAssertionWireSchema,
  restFolderWireSchema,
  tlsInfoWireSchema,
} from '../../wire-base.js';

/** A WebSocket folder, sharing the project's `folders` list with REST and gRPC. */
export const wsFolderWireSchema = restFolderWireSchema;
export type WsFolderWire = z.infer<typeof wsFolderWireSchema>;

/** Per-request WebSocket transport settings; an absent field means *inherit*, never *off*. */
export const wsSettingsWireSchema = z.object({
  handshakeTimeoutMs: z.number().int().nonnegative().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxMessageBytes: z.number().int().nonnegative().optional(),
  escapeProperties: z.boolean().optional(),
});
export type WsSettingsWire = z.infer<typeof wsSettingsWireSchema>;

/** One message saved under a WebSocket request, ready to send without retyping it. */
export const wsSavedMessageWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  format: z.enum(['text', 'binary']),
  content: z.string(),
  /**
   * The contract message it was generated from, and the text it was generated as. Main keeps the
   * one it already has on a patch: the renderer can carry it back, never invent it.
   */
  contract: z.object({ message: z.string(), generated: z.string() }).optional(),
});
export type WsSavedMessageWire = z.infer<typeof wsSavedMessageWireSchema>;

/** One WebSocket request as the renderer sees it. */
export const wsRequestWireSchema = z.object({
  kind: z.literal('websocket'),
  id: z.string(),
  apiId: z.string(),
  /** Id of the folder it sits in, absent at the API's root. */
  folderId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  url: z.string(),
  query: z.array(keyValueWireSchema),
  headers: z.array(keyValueWireSchema),
  subprotocols: z.array(z.string()),
  auth: authConfigWireSchema,
  settings: wsSettingsWireSchema,
  messages: z.array(wsSavedMessageWireSchema),
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
  /** The contract channel it was imported from, by its key in the document. */
  contract: z.object({ channel: z.string() }).optional(),
  /** The contract no longer has that channel. */
  orphaned: z.boolean().optional(),
});
export type WsRequestWire = z.infer<typeof wsRequestWireSchema>;

/** One WebSocket API as the renderer sees it. Its folders share the project's `folders` list. */
export const wsApiWireSchema = z.object({
  kind: z.literal('websocket'),
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  url: z.string(),
  headers: z.array(keyValueWireSchema),
  auth: authConfigWireSchema.optional(),
  definition: z
    .object({
      kind: z.literal('asyncapi'),
      source: z.string(),
      cache: z.boolean(),
      /** The server key the API was mapped against; absent means the first WebSocket one. */
      server: z.string().optional(),
      /** The `asyncapi` version the cached document declares, once main has read the cache. */
      version: z.string().optional(),
      /** The cached document's WebSocket (`ws`/`wss`) server keys, in document order. */
      servers: z.array(z.string()).optional(),
      /** How the definition document is fetched, as references; separate from the API's own `auth`. */
      auth: authConfigWireSchema.optional(),
    })
    .optional(),
});
export type WsApiWire = z.infer<typeof wsApiWireSchema>;

/** The fields of a WebSocket API the renderer may patch; `null` clears an optional one. */
export const wsApiPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  url: z.string().optional(),
  headers: z.array(keyValueWireSchema).optional(),
  auth: authConfigWireSchema.nullable().optional(),
});
export type WsApiPatchWire = z.infer<typeof wsApiPatchSchema>;

/**
 * The fields of a WebSocket request the renderer may patch. Tables and settings are replaced
 * wholesale, as a REST request's are: an absent setting means *inherit*. `messages` REPLACES the
 * whole saved-message list, which is how reordering is expressed.
 */
export const wsRequestPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  url: z.string().optional(),
  query: z.array(keyValueWireSchema).optional(),
  headers: z.array(keyValueWireSchema).optional(),
  subprotocols: z.array(z.string()).optional(),
  auth: authConfigWireSchema.optional(),
  settings: wsSettingsWireSchema.optional(),
  messages: z.array(wsSavedMessageWireSchema).optional(),
});
export type WsRequestPatchWire = z.infer<typeof wsRequestPatchSchema>;

// ——— WebSocket session channels ————————————————————————————————————————————————————————————

/**
 * How a frame fared against its channel's contract. `not-checked` means the check ran out of time:
 * it says nothing either way about the frame.
 */
export const wsFrameContractWireSchema = z.object({
  status: z.enum(['ok', 'violation', 'unmatched', 'skipped', 'not-checked']),
  message: z.string().optional(),
  problems: z.array(z.object({ path: z.string(), keyword: z.string(), message: z.string() })).optional(),
  reason: z.string().optional(),
});
export type WsFrameContractWire = z.infer<typeof wsFrameContractWireSchema>;

/** One frame sent or received during a WebSocket session, as the log/live pane shows it. */
export const wsFrameWireSchema = z.object({
  index: z.number(),
  direction: z.enum(['sent', 'received']),
  opcode: z.enum(['text', 'binary', 'ping', 'pong', 'close']),
  /** Milliseconds since the session started. */
  at: z.number(),
  size: z.number(),
  text: z.string().optional(),
  base64: z.string().optional(),
  close: z.object({ code: z.number(), reason: z.string() }).optional(),
  payloadTruncated: z.boolean().optional(),
  /** Set when the session's request is linked to a contract channel. */
  contract: wsFrameContractWireSchema.optional(),
});
export type WsFrameWire = z.infer<typeof wsFrameWireSchema>;

/** The handshake that opened (or failed to open) a WebSocket session, redacted like every other header set. */
export const wsHandshakeWireSchema = z.object({
  url: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  requestedSubprotocols: z.array(z.string()),
  rawRequestHead: z.string().optional(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  protocol: z.string().optional(),
  extensions: z.string().optional(),
  remoteAddress: z.string().optional(),
  startedAt: z.string(),
  durationMs: z.number(),
  tls: tlsInfoWireSchema.optional(),
  error: z.string().optional(),
});
export type WsHandshakeWire = z.infer<typeof wsHandshakeWireSchema>;

/** What one WebSocket session produced (so far, or in whole): the handshake, its frames, how it closed. */
export const wsExchangeSummarySchema = z.object({
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
  sendId: z.string(),
  url: z.string(),
  handshake: wsHandshakeWireSchema,
  frames: z.array(wsFrameWireSchema),
  closed: z.object({ code: z.number(), reason: z.string(), by: z.enum(['client', 'server', 'error']) }),
  counts: z.object({
    sent: z.number(),
    received: z.number(),
    bytesSent: z.number(),
    bytesReceived: z.number(),
  }),
  durationMs: z.number(),
});
export type WsExchangeSummary = z.infer<typeof wsExchangeSummarySchema>;

/**
 * The HTTP Log's row for a WebSocket session: the handshake, and only the handshake — written the
 * moment it settles, not when the session closes (the frames live in History, via
 * {@link WsExchangeSummary}). `url` is `http(s)://` so the row filters and searches like every
 * other, `wsUrl` keeps the original `ws(s)://` form for display. Discriminated from the other
 * `logEntryWireSchema` exchange shapes by `protocol` (they carry none).
 */
export const wsHandshakeExchangeSummarySchema = z.object({
  sendId: z.string(),
  protocol: z.literal('websocket'),
  method: z.literal('GET'),
  url: z.string(),
  wsUrl: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  rawRequestHead: z.string().optional(),
  status: z.literal(101),
  responseHeaders: z.record(z.string(), z.string()),
  startedAt: z.string(),
  durationMs: z.number(),
  tls: tlsInfoWireSchema.optional(),
});
export type WsHandshakeExchangeSummary = z.infer<typeof wsHandshakeExchangeSummarySchema>;

/**
 * One report from a WebSocket session that is still open, correlated to the invoke by `sendId`.
 *
 * `request.openWs` stays open for the life of the session and resolves with the whole exchange;
 * these say what has happened so far, the same relationship `grpcLiveEventSchema` has to
 * `request.sendGrpc`.
 */
export const wsLiveEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('handshake'), sendId: z.string(), handshake: wsHandshakeWireSchema }),
  z.object({ kind: z.literal('frame'), sendId: z.string(), frame: wsFrameWireSchema }),
  /**
   * A frame's contract check, which follows its `frame` event: the check runs on a worker thread,
   * so the frame is never held back waiting for it. `index` names the frame.
   */
  z.object({
    kind: z.literal('contract'),
    sendId: z.string(),
    index: z.number(),
    contract: wsFrameContractWireSchema,
  }),
  z.object({ kind: z.literal('closed'), sendId: z.string() }),
]);
export type WsLiveEvent = z.infer<typeof wsLiveEventSchema>;

/** Request payload for `request.openWs`: which saved request to dial, and the editor's unsaved edits. */
export const requestOpenWsRequestSchema = z.object({
  sendId: z.string(),
  requestId: z.string(),
  draft: wsRequestPatchSchema.optional(),
});
export type RequestOpenWsRequest = z.infer<typeof requestOpenWsRequestSchema>;

/** Request payload for `request.wsSend`: one message on an open session, named by its `sendId`. */
export const requestWsSendRequestSchema = z.object({
  sendId: z.string(),
  requestId: z.string(),
  format: z.enum(['text', 'binary']),
  /** Text as typed for `format: 'text'`; base64 for `format: 'binary'`. */
  content: z.string(),
  /** Property-expand `content` (text only) against the request's scopes before sending. */
  expand: z.boolean(),
});
export type RequestWsSendRequest = z.infer<typeof requestWsSendRequestSchema>;

/** What `request.wsSend` answers: the frame as it went, so the pane echoes what was sent. */
export const requestWsSendResponseSchema = wsFrameWireSchema;
export type RequestWsSendResponse = z.infer<typeof requestWsSendResponseSchema>;

/** Request payload for `request.wsClose`: which open session to close, and how. */
export const requestWsCloseRequestSchema = z.object({
  sendId: z.string(),
  code: z.number().optional(),
  reason: z.string().optional(),
});
export type RequestWsCloseRequest = z.infer<typeof requestWsCloseRequestSchema>;

/** What `request.wsClose` answers. `false` when no such session is open. */
export const requestWsCloseResponseSchema = z.object({ closed: z.boolean() });
export type RequestWsCloseResponse = z.infer<typeof requestWsCloseResponseSchema>;

/** Request payload for `request.preflightWs`: the same pair, with nothing sent. */
export const requestPreflightWsRequestSchema = z.object({
  requestId: z.string(),
  draft: wsRequestPatchSchema.optional(),
  /**
   * The caller wants the secret-source warnings only, as a send does beside itself. Main then answers
   * the empty preflight, without resolving the request, when no `${secret:name}` is mapped.
   */
  secretsOnly: z.boolean().optional(),
});

/** What an AsyncAPI import made, for the summary the dialog shows when it finishes. */
export const asyncApiImportSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  /** The `asyncapi` string the document declared. */
  declaredVersion: z.string(),
  /** The server the API's URL came from, when there was a WebSocket one. */
  server: z.string().optional(),
  /** Every server key the document lists, WebSocket or not: what the server picker offers. */
  servers: z.array(z.string()),
  requests: z.number(),
  messages: z.number(),
  /** Channels, operations and schemes the import left out, each with the reason. */
  skipped: z.array(z.object({ where: z.string(), reason: z.string() })),
  unresolved: z.array(z.string()),
  unsupportedKeywords: z.array(z.string()),
});
export type AsyncApiImportSummaryWire = z.infer<typeof asyncApiImportSummarySchema>;

/** Request/response for `api.importAsyncApi`. The target is the union an OpenAPI import takes. */
export const apiImportAsyncApiRequestSchema = z
  .object({
    target: projectAddInterfaceTargetSchema,
    source: openApiSourceSchema,
    /** The `ws`/`wss` server to dial, by its key in the document; absent picks the first one. */
    server: z.string().max(200).optional(),
    /** Overrides `info.title` as the API's name; empty or whitespace-only falls back to the title. */
    name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
    /** Write the definition cache. Defaults to the definition-caching preference. */
    cache: z.boolean().optional(),
    /** Echoed back on `engine.progress` events raised while this import is in flight. */
    token: z.string().optional(),
    /** Credentials for fetching the document, recorded on the API for Update Definition. URL sources only. */
    auth: definitionAuthWireSchema.optional(),
  })
  .refine(hasFetchableAuthSource, onlyWithAUrl);
export type ApiImportAsyncApiRequest = z.infer<typeof apiImportAsyncApiRequestSchema>;

/**
 * Request/response for `api.asyncApiServers`: the document's `ws`/`wss` servers, read before an
 * import so the dialog can offer a choice of server when there is more than one.
 */
export const apiAsyncApiServersRequestSchema = z
  .object({ source: openApiSourceSchema, auth: definitionAuthWireSchema.optional() })
  .refine(hasFetchableAuthSource, onlyWithAUrl);
export type ApiAsyncApiServersRequest = z.infer<typeof apiAsyncApiServersRequestSchema>;

export const apiAsyncApiServersResponseSchema = z.object({
  /** In document order; the first is the one an import picks when none is named. */
  servers: z.array(z.object({ key: z.string(), url: z.string() })),
});
export type ApiAsyncApiServersResponse = z.infer<typeof apiAsyncApiServersResponseSchema>;

const asyncApiOpRefSchema = z.object({
  key: z.string(),
  channel: z.string(),
  direction: z.enum(['sent', 'received']),
});

/** What updating an AsyncAPI-imported API would change, per operation (`api.asyncApiPlanUpdate`). */
export const asyncApiUpdatePlanSchema = z.object({
  added: z.array(asyncApiOpRefSchema),
  removed: z.array(asyncApiOpRefSchema),
  changed: z.array(
    z.object({
      op: asyncApiOpRefSchema,
      reasons: z.array(z.enum(['address', 'payload', 'bindings', 'security', 'messages'])),
    }),
  ),
});
export type AsyncApiUpdatePlanWire = z.infer<typeof asyncApiUpdatePlanSchema>;

/**
 * `api.asyncApiPlanUpdate`'s answer: the plan, and a sha256 of the documents it was made from, which
 * `api.asyncApiApplyUpdate` must be handed back so it never applies a source that changed since.
 */
export const apiAsyncApiPlanUpdateResponseSchema = asyncApiUpdatePlanSchema.extend({ fingerprint: z.string() });
export type ApiAsyncApiPlanUpdateResponse = z.infer<typeof apiAsyncApiPlanUpdateResponseSchema>;

export const apiAsyncApiApplyUpdateRequestSchema = z.object({ apiId: z.string(), fingerprint: z.string() });
export type ApiAsyncApiApplyUpdateRequest = z.infer<typeof apiAsyncApiApplyUpdateRequestSchema>;
