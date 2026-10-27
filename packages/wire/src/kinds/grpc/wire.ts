/**
 * The wire shapes only gRPC uses (kind modules spec §4.2): APIs, requests, calls in flight and
 * `.proto` import. Imports `wire-base.ts` and never another kind's file.
 */

import { z } from 'zod';
import {
  MAX_IMPORT_LOCATION_CHARS,
  MAX_IMPORT_NAME_CHARS,
  MAX_IMPORT_TEXT_CHARS,
  authConfigWireSchema,
  exchangeProblemSchema,
  httpExchangeWireSchema,
  keyValueWireSchema,
  projectAddInterfaceTargetSchema,
  requestAssertionResultWireSchema,
  requestAssertionWireSchema,
  requestScriptsWireSchema,
  scriptResultWireSchema,
  unresolvedRefWireSchema,
} from '../../wire-base.js';

/** The four shapes a gRPC method can take; mirrors the engine's `GrpcMethodKind`. */
export const grpcMethodKindWireSchema = z.enum(['unary', 'server-streaming', 'client-streaming', 'bidi-streaming']);
export type GrpcMethodKindWire = z.infer<typeof grpcMethodKindWireSchema>;

/** Per-request gRPC transport settings; an absent field means *inherit*, never *off*. */
export const grpcSettingsWireSchema = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  escapeProperties: z.boolean().optional(),
});
export type GrpcSettingsWire = z.infer<typeof grpcSettingsWireSchema>;

/** One gRPC request as the renderer sees it. The message text travels here, as a REST raw body does. */
export const grpcRequestWireSchema = z.object({
  kind: z.literal('grpc'),
  id: z.string(),
  apiId: z.string(),
  /** Id of the folder it sits in, absent at the API's root. */
  folderId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  service: z.string(),
  method: z.string(),
  methodKind: grpcMethodKindWireSchema,
  metadata: z.array(keyValueWireSchema),
  message: z.string(),
  auth: authConfigWireSchema,
  settings: grpcSettingsWireSchema,
  scripts: requestScriptsWireSchema.optional(),
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
  orphaned: z.boolean().optional(),
});
export type GrpcRequestWire = z.infer<typeof grpcRequestWireSchema>;

/** One gRPC API as the renderer sees it. Its folders share the project's `folders` list with REST. */
/** Which reflection protocol version to ask a server with; `auto` tries v1 then v1alpha. */
export const grpcReflectionVersionWireSchema = z.enum(['auto', 'v1', 'v1alpha']);
export type GrpcReflectionVersionWire = z.infer<typeof grpcReflectionVersionWireSchema>;

export const grpcApiWireSchema = z.object({
  kind: z.literal('grpc'),
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  target: z.string(),
  tls: z.boolean(),
  metadata: z.array(keyValueWireSchema),
  auth: authConfigWireSchema.optional(),
  /** The API's scripts, run around every request in it (#334). */
  scripts: requestScriptsWireSchema.optional(),
  definition: z
    .object({
      /** How the schema was obtained: imported `.proto` files, or a server that described itself. */
      kind: z.enum(['proto', 'reflection']).default('proto'),
      source: z.string(),
      cache: z.boolean(),
      roots: z.array(z.string()),
      /** For a discovered definition, the version a refresh asks with. */
      reflectionVersion: grpcReflectionVersionWireSchema.optional(),
    })
    .optional(),
});
export type GrpcApiWire = z.infer<typeof grpcApiWireSchema>;

/** The fields of a gRPC API the renderer may patch; `null` clears an optional one. */
export const grpcApiPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  target: z.string().optional(),
  tls: z.boolean().optional(),
  metadata: z.array(keyValueWireSchema).optional(),
  auth: authConfigWireSchema.nullable().optional(),
});
export type GrpcApiPatchWire = z.infer<typeof grpcApiPatchSchema>;

/**
 * The fields of a gRPC request the renderer may patch. The metadata table and the settings are
 * replaced wholesale, as a REST request's are: an absent setting means *inherit*.
 */
export const grpcRequestPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  service: z.string().optional(),
  method: z.string().optional(),
  methodKind: grpcMethodKindWireSchema.optional(),
  metadata: z.array(keyValueWireSchema).optional(),
  message: z.string().optional(),
  auth: authConfigWireSchema.optional(),
  settings: grpcSettingsWireSchema.optional(),
});
export type GrpcRequestPatchWire = z.infer<typeof grpcRequestPatchSchema>;

/** One response message of a gRPC call: decoded JSON text when it decoded, its bytes as base64 always. */
export const grpcResponseMessageWireSchema = z.object({
  /** The message as canonical JSON text; absent when the bytes did not decode as the response type. */
  json: z.string().optional(),
  base64: z.string(),
  bytes: z.number(),
  problem: z.string().optional(),
});
export type GrpcResponseMessageWire = z.infer<typeof grpcResponseMessageWireSchema>;

/**
 * What one gRPC call produced. It carries the same `http` projection the other two protocols'
 * exchanges do — an HTTP/2 exchange is what a gRPC call is on the wire — so the HTTP log, the
 * status bar, the timing waterfall and the TLS inspector serve it unchanged; the gRPC status, the
 * metadata both ways and the decoded messages are what the gRPC response pane adds.
 */
export const grpcExchangeSummarySchema = z.object({
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
  sendId: z.string(),
  durationMs: z.number(),
  http: httpExchangeWireSchema,
  target: z.string(),
  service: z.string(),
  method: z.string(),
  methodKind: grpcMethodKindWireSchema,
  status: z.number(),
  statusName: z.string(),
  statusMessage: z.string().optional(),
  statusSource: z.enum(['trailers', 'headers', 'http', 'local']),
  /** Response headers (initial metadata), redacted unless the session shows secrets. */
  headers: z.record(z.string(), z.string()),
  trailers: z.record(z.string(), z.string()),
  /** The request messages as sent, canonical JSON text each. */
  requestMessages: z.array(z.string()),
  responseMessages: z.array(grpcResponseMessageWireSchema),
  encoding: z.string().optional(),
  truncated: z.boolean(),
  problems: z.array(exchangeProblemSchema),
  unresolved: z.array(unresolvedRefWireSchema).optional(),
  /** What the request's scripts did; absent when it has none, or they are switched off. */
  script: scriptResultWireSchema.optional(),
  /** Set when the request has scripts and they are switched off, so none ran. */
  scriptsOff: z.boolean().optional(),
});
export type GrpcExchangeSummary = z.infer<typeof grpcExchangeSummarySchema>;

/** Request payload for `request.sendGrpc`: the request and its unsaved draft, never a target or a credential. */
export const requestSendGrpcRequestSchema = z.object({
  sendId: z.string(),
  requestId: z.string(),
  draft: grpcRequestPatchSchema.optional(),
  /**
   * Keeps the request side open once the message text has been written, so `request.grpcPush` can
   * add more messages and `request.grpcHalfClose` ends them. Absent — every send until now — the
   * call is written and half-closed at once, exactly as before.
   */
  interactive: z.boolean().optional(),
});
export type RequestSendGrpcRequest = z.infer<typeof requestSendGrpcRequestSchema>;

/**
 * One report from a gRPC call that is still running, correlated to the invoke by `sendId`.
 *
 * `request.sendGrpc` stays open and still resolves with the whole exchange; these say what has
 * happened so far, so a server stream fills in as it arrives instead of appearing at the end.
 * A renderer that ignores them sees exactly the behaviour it saw before.
 */
export const grpcLiveEventSchema = z.discriminatedUnion('kind', [
  /** The request side is open for pushing. Only an interactive call reports it. */
  z.object({ kind: z.literal('open'), sendId: z.string() }),
  /** The server's initial metadata, the moment it arrives. */
  z.object({
    kind: z.literal('headers'),
    sendId: z.string(),
    httpStatus: z.number(),
    headers: z.record(z.string(), z.string()),
  }),
  /** One response message, decoded, in arrival order. */
  z.object({
    kind: z.literal('message'),
    sendId: z.string(),
    index: z.number(),
    message: grpcResponseMessageWireSchema,
  }),
  /** The request side has been half-closed; the server may still be answering. */
  z.object({ kind: z.literal('closed'), sendId: z.string() }),
]);
export type GrpcLiveEvent = z.infer<typeof grpcLiveEventSchema>;

/** Request payload for `request.grpcPush`: one more message on an open interactive call. */
export const requestGrpcPushRequestSchema = z.object({
  sendId: z.string(),
  /** The message as JSON text, encoded against the method's request type by main. */
  messageText: z.string(),
});
export type RequestGrpcPushRequest = z.infer<typeof requestGrpcPushRequestSchema>;

/** What `request.grpcPush` answers: the message as it went, so the pane echoes what was sent. */
export const requestGrpcPushResponseSchema = z.object({
  /** The message in canonical JSON text, as encoded against the request type. */
  json: z.string(),
});
export type RequestGrpcPushResponse = z.infer<typeof requestGrpcPushResponseSchema>;

/** Request payload for `request.grpcHalfClose`: which open call to stop sending on. */
export const requestGrpcHalfCloseRequestSchema = z.object({ sendId: z.string() });

/** What `request.grpcHalfClose` answers. `false` when no such call is open. */
export const requestGrpcHalfCloseResponseSchema = z.object({ closed: z.boolean() });
export type RequestGrpcHalfCloseResponse = z.infer<typeof requestGrpcHalfCloseResponseSchema>;

/** Request payload for `request.preflightGrpc`: the same pair, with nothing sent. */
export const requestPreflightGrpcRequestSchema = z.object({
  requestId: z.string(),
  draft: grpcRequestPatchSchema.optional(),
  /**
   * The caller wants the secret-source warnings only, as a send does beside itself. Main then answers
   * the empty preflight, without resolving the request, when no `${secret:name}` is mapped.
   */
  secretsOnly: z.boolean().optional(),
});

/**
 * Where a gRPC API's schema comes from. `folder` and `files` are paths the user picked in a native
 * dialog (main refuses one that was neither picked nor inside a project folder); `text` is a paste
 * or a drop; `url` is one file fetched over HTTP, its relative imports fetched beside it;
 * `reflection` is a running server asked to describe itself, so a user with no files can start.
 */
export const protoSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({ kind: z.literal('files'), paths: z.array(z.string().max(MAX_IMPORT_LOCATION_CHARS)).min(1).max(500) }),
  z.object({
    kind: z.literal('text'),
    text: z.string().max(MAX_IMPORT_TEXT_CHARS),
    /** The file name the text came from, which is the import path other files would reach it by. */
    filename: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  }),
  z.object({ kind: z.literal('url'), url: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({
    kind: z.literal('reflection'),
    /** The server to ask, as `host:port` or a `grpc://`/`grpcs://` URL whose scheme decides TLS. */
    target: z.string().max(MAX_IMPORT_LOCATION_CHARS),
    /** Speak TLS to it. Absent lets the target's spelling decide, as a new API's does. */
    tls: z.boolean().optional(),
    version: grpcReflectionVersionWireSchema.optional(),
    /** Ask even when the server's certificate does not verify, for a development server. */
    trustInvalid: z.boolean().optional(),
  }),
]);
export type ProtoSourceWire = z.infer<typeof protoSourceSchema>;

/** One method of a service, as the definition describes it; mirrors the engine's descriptor. */
export const grpcMethodDescriptorWireSchema = z.object({
  name: z.string(),
  service: z.string(),
  kind: grpcMethodKindWireSchema,
  requestType: z.string(),
  responseType: z.string(),
  comment: z.string().optional(),
  deprecated: z.boolean().optional(),
});
export type GrpcMethodDescriptorWire = z.infer<typeof grpcMethodDescriptorWireSchema>;

/** One service of a `.proto` set. */
export const grpcServiceDescriptorWireSchema = z.object({
  name: z.string(),
  fullName: z.string(),
  package: z.string(),
  comment: z.string().optional(),
  methods: z.array(grpcMethodDescriptorWireSchema),
});
export type GrpcServiceDescriptorWire = z.infer<typeof grpcServiceDescriptorWireSchema>;

/** What a `.proto` import or a reflection discovery produced, for the summary step. */
export const protoImportSummarySchema = z.object({
  name: z.string(),
  target: z.string(),
  files: z.number(),
  services: z.number(),
  methods: z.number(),
  deprecated: z.number(),
  roots: z.array(z.string()),
  /** How the definition was obtained. */
  kind: z.enum(['proto', 'reflection']).default('proto'),
  /** The reflection protocol version that answered, for a discovered definition. */
  reflectionVersion: z.enum(['v1', 'v1alpha']).optional(),
});
export type ProtoImportSummaryWire = z.infer<typeof protoImportSummarySchema>;

/** Request/response for `api.importProto`. */
export const apiImportProtoRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: protoSourceSchema,
  name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
  /** The server to call, as `host:port`; empty leaves the API's target for the user to fill in. */
  grpcTarget: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  tls: z.boolean().optional(),
  cache: z.boolean().optional(),
  token: z.string().optional(),
});
export type ApiImportProtoRequest = z.infer<typeof apiImportProtoRequestSchema>;

/**
 * Response for `api.grpcDefinition`: the services a gRPC API's cached `.proto` set declares — what
 * the editor's method picker offers — and the files, identity only.
 */
export const apiGrpcDefinitionResponseSchema = z.object({
  services: z.array(grpcServiceDescriptorWireSchema),
  files: z.array(z.object({ path: z.string(), size: z.number() })),
  source: z.string(),
  fetchedAt: z.string(),
  roots: z.array(z.string()),
  /** Which cache the definition is in: imported `.proto` files, or a discovered descriptor set. */
  kind: z.enum(['proto', 'reflection']).default('proto'),
  /** The reflection version that answered, for a discovered definition. */
  reflectionVersion: z.enum(['v1', 'v1alpha']).optional(),
});
export type ApiGrpcDefinitionResponse = z.infer<typeof apiGrpcDefinitionResponseSchema>;

/**
 * Request/response for `api.grpcRefresh`: ask a reflection-sourced API's server to describe itself
 * again. Nothing is deleted — a method the server no longer declares keeps its request, badged
 * orphaned, and a method it has gained gets one.
 */
export const apiGrpcRefreshRequestSchema = z.object({
  apiId: z.string(),
  /** Overrides the version recorded on the API for this refresh, and is remembered.  */
  version: grpcReflectionVersionWireSchema.optional(),
  token: z.string().optional(),
});
export type ApiGrpcRefreshRequest = z.infer<typeof apiGrpcRefreshRequestSchema>;

/** Request/response for `api.grpcSample`: a sample message for one type of a gRPC API's definition. */
export const apiGrpcSampleRequestSchema = z.object({ apiId: z.string(), type: z.string().max(1024) });
export const apiGrpcSampleResponseSchema = z.object({ text: z.string() });

/**
 * Request/response for `api.grpcFields`: the fields of the message reached by walking `path` — a
 * chain of JSON object keys — down from `type`. The message editor's completion provider asks it
 * for the object the cursor is in, so a path that names nothing simply answers no fields rather
 * than failing: a half-typed document is the normal case, not an error.
 */
export const apiGrpcFieldsRequestSchema = z.object({
  apiId: z.string(),
  type: z.string().max(1024),
  path: z.array(z.string().max(256)).max(64),
});

/** One field of a message, as the completion provider needs it. */
export const grpcMessageFieldSchema = z.object({
  name: z.string(),
  /** The declared type: a scalar name, or a fully qualified message or enum name. */
  type: z.string(),
  valueKind: z.enum(['scalar', 'enum', 'message', 'map']),
  repeated: z.boolean(),
  oneof: z.string().optional(),
  /** For an enum field: the value names, in declaration order. */
  enumValues: z.array(z.string()).optional(),
  comment: z.string().optional(),
});
export type GrpcMessageFieldWire = z.infer<typeof grpcMessageFieldSchema>;

export const apiGrpcFieldsResponseSchema = z.object({
  /** The message the path resolved to, absent when it resolved to nothing. */
  fullName: z.string().optional(),
  fields: z.array(grpcMessageFieldSchema),
});

/** Request payload for `history.resendGrpc`: calls a past gRPC entry's saved request with its recorded messages. */
export const historyResendGrpcRequestSchema = z.object({ id: z.string() });
