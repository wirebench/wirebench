/**
 * Zod schemas (and their inferred types) for the `definition.*`/`request.*` IPC channels
 * and the `engine.progress` event. Kept separate from `ipc.ts` because these shapes — the
 * JSON-serialisable projection of the engine's `WsdlImportResult`/`SoapExchange` types — are
 * large enough to crowd the channel registry.
 *
 * Every shape here must be plain JSON: no DOM nodes, no `Uint8Array` (bytes cross the wire
 * as base64 strings), no functions.
 */

import { z } from 'zod';
import { CODE_TARGET_IDS } from './code-targets.js';
import { PLUGIN_CONTRIBUTION_ID } from './plugins-wire.js';
import { MAX_SEND_ENVIRONMENTS } from './multi-env-limits.js';
import {
  authConfigWireSchema,
  environmentPatchSchema,
  environmentWireSchema,
  failedExchangeWireSchema,
  headerEntrySchema,
  historyErrorSchema,
  historyFaultSchema,
  keystorePatchSchema,
  keystoreWireSchema,
  mockOperationPatchSchema,
  mockPatchSchema,
  mockResponsePatchSchema,
  mockWireSchema,
  MAX_IMPORT_LOCATION_CHARS,
  projectAddInterfaceTargetSchema,
  projectProblemSchema,
  unsupportedContainerWireSchema,
  projectSettingsPatchSchema,
  projectSettingsSchema,
  requestAssertionWireSchema,
  requestAuthSourceSchema,
  requestScriptsPatchSchema,
  restFolderWireSchema,
  scriptConversionsResultWireSchema,
  sequencePatchSchema,
  sequenceWireSchema,
  unresolvedRefWireSchema,
  unsavedRestoreNoticeSchema,
  webhookSigningWireSchema,
} from './wire-base.js';
import type { AssertTrue, TlsOptionsWire, TypesEqual } from './wire-base.js';
import {
  attachmentPatchSchema,
  definitionUpdatePlanResponseSchema,
  endpointSourceSchema,
  exchangeSummarySchema,
  interfaceWireSchema,
  legacyImportReportSchema,
  requestPatchSchema,
  requestPropertiesPatchSchema,
  requestWireSchema,
  soapOwnerAuthWireSchema,
  soapVersionSchema,
  wsaConfigWireSchema,
  wssIncomingPatchSchema,
  wssIncomingWireSchema,
  wssOutgoingPatchSchema,
  wssOutgoingWireSchema,
} from './kinds/soap/wire.js';
import type { RequestSendRequest, SoapSendInputWire } from './kinds/soap/wire.js';
import {
  apiPatchSchema,
  importVariablesSummarySchema,
  openApiImportSummarySchema,
  postmanImportSummarySchema,
  postmanSourceSchema,
  restApiWireSchema,
  restContractResultSchema,
  restExchangeSummarySchema,
  restFolderPatchSchema,
  restRequestPatchSchema,
  restRequestWireSchema,
  restUpdatePlanSchema,
  sseRowWireSchema,
  webhookCollectionWireSchema,
} from './kinds/rest/wire.js';
import type { ImportVariablesSummaryWire, PostmanImportSummaryWire } from './kinds/rest/wire.js';
import {
  grpcApiPatchSchema,
  grpcApiWireSchema,
  grpcExchangeSummarySchema,
  grpcMethodKindWireSchema,
  grpcRequestPatchSchema,
  grpcRequestWireSchema,
  protoImportSummarySchema,
} from './kinds/grpc/wire.js';
import {
  asyncApiImportSummarySchema,
  asyncApiUpdatePlanSchema,
  wsApiPatchSchema,
  wsApiWireSchema,
  wsFrameWireSchema,
  wsHandshakeExchangeSummarySchema,
  wsRequestPatchSchema,
  wsRequestWireSchema,
} from './kinds/ws/wire.js';
import {
  historyMcpWireSchema,
  mcpOperationWireSchema,
  mcpRequestPatchSchema,
  mcpRequestWireSchema,
  mcpServerPatchSchema,
  mcpServerWireSchema,
  mcpTransportWireSchema,
} from './kinds/mcp/wire.js';

/**
 * A send input after main has folded in the TLS material the renderer may never name (see
 * {@link sendTlsOptionsSchema}): the CA bundle's anchors, the client identity, and an
 * endpoint's `trustInvalid`. Main-only by construction — there is no schema for it, because it
 * never travels *towards* main.
 */
export type ResolvedSendInputWire = Omit<SoapSendInputWire, 'tls'> & { readonly tls?: TlsOptionsWire | undefined };

/** A {@link RequestSendRequest} whose input has been through that same resolution. */
export type ResolvedSendRequest = Omit<RequestSendRequest, 'input'> & { readonly input: ResolvedSendInputWire };

/**
 * Response payload for `request.preflight`: the endpoint the saved request resolves to under
 * the active environment, plus every property reference in it that would not expand. Purely
 * a dry run — nothing is sent.
 */
export const requestPreflightResponseSchema = z.object({
  endpoint: z.string().optional(),
  endpointSource: endpointSourceSchema,
  unresolved: z.array(unresolvedRefWireSchema),
  auth: requestAuthSourceSchema,
  /**
   * The WS-Addressing this request would actually send, after the interface/request merge and
   * the Action/To/MessageID fallbacks — what the WS-A inspector shows greyed while inheriting.
   * `.default(...)` is tolerance for a stub; `z.infer` still yields a required object.
   */
  wsa: z
    .object({
      enabled: z.boolean(),
      action: z.string().optional(),
      to: z.string().optional(),
      messageId: z.string().optional(),
    })
    .default({ enabled: false }),
  /**
   * A webhook item's URL: its target, the callback URL its parent's last exchange named, or the
   * target standing in for a callback URL that did not resolve — `detail` says which and why.
   */
  target: z
    .object({ source: z.enum(['target', 'callback', 'callback-fallback']), detail: z.string().optional() })
    .optional(),
});
export type RequestPreflightResponse = z.infer<typeof requestPreflightResponseSchema>;

/**
 * Response payload for `exchanges.get`: one cached exchange, re-redacted for the show-secrets flag
 * as it stands. REST is tried first: a REST summary also satisfies the looser SOAP shape, which would
 * strip its `url`, `method` and `text`; a SOAP summary lacks those, so it falls through to its own.
 */
export const exchangesGetResponseSchema = z.union([restExchangeSummarySchema, exchangeSummarySchema]);
export type ExchangesGetResponse = z.infer<typeof exchangesGetResponseSchema>;

export { MAX_SEND_ENVIRONMENTS };

/** How one environment of a `request.sendToEnvironments` settled; one never cancels another. */
export const envSendResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    environmentId: z.string(),
    environmentName: z.string(),
    kind: z.enum(['soap', 'rest']),
    soap: exchangeSummarySchema.optional(),
    rest: restExchangeSummarySchema.optional(),
  }),
  z.object({
    outcome: z.literal('error'),
    environmentId: z.string(),
    environmentName: z.string(),
    code: z.string(),
    message: z.string(),
  }),
]);
export type EnvSendResult = z.infer<typeof envSendResultSchema>;

/** Response payload for `request.sendToEnvironments`: one result per id, in the order asked. */
export const requestSendToEnvironmentsResponseSchema = z.object({ results: z.array(envSendResultSchema) });
export type RequestSendToEnvironmentsResponse = z.infer<typeof requestSendToEnvironmentsResponseSchema>;

/** Request payload for `request.curl`: which saved request, and which shell's quoting. */
export const requestCurlRequestSchema = z.object({
  requestId: z.string(),
  shell: z.enum(['posix', 'powershell']),
  /**
   * The editor's unsaved edits, applied to this export only — the same draft a send carries.
   *
   * Without it the command would describe what is *saved* rather than what the user is looking at,
   * which is the one thing a "copy this request as curl" must never do. REST only: a SOAP draft
   * already reaches main through its own staged-edit path.
   */
  draft: restRequestPatchSchema.optional(),
  /** The same, for a gRPC request's editor. */
  grpcDraft: grpcRequestPatchSchema.optional(),
  /** The same, for a WebSocket request's editor. */
  wsDraft: wsRequestPatchSchema.optional(),
});
export type RequestCurlRequest = z.infer<typeof requestCurlRequestSchema>;

/** A language's layout choices for `request.code`; an absent field takes the request's own value. */
export const codeSettingsSchema = z.object({
  indent: z.union([z.number().int().min(0).max(8), z.literal('tab')]).optional(),
  followRedirects: z.boolean().optional(),
  /** Milliseconds; 0 means no timeout. */
  timeoutMs: z.number().int().min(0).optional(),
});

/**
 * Request payload for `request.code`: one REST or SOAP request as code in `target`, or as the
 * `wirebench run` line that sends it from a terminal. `draft` is the REST editor's unsaved edits, as
 * for `request.curl`.
 */
export const requestCodeRequestSchema = z.object({
  requestId: z.string(),
  // A built-in language, or a plugin's generator, `<plugin>/<generator>` (phase 7 §3.3).
  target: z.union([z.enum(CODE_TARGET_IDS), z.string().regex(PLUGIN_CONTRIBUTION_ID)]),
  settings: codeSettingsSchema.optional(),
  draft: restRequestPatchSchema.optional(),
});
export type RequestCodeRequest = z.infer<typeof requestCodeRequestSchema>;

/** One HTTP Log row as the renderer holds it — what `log.curl` (and later `log.exportHar`) receive. */
export const logEntryWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exchange'),
    exchange: z.union([
      grpcExchangeSummarySchema,
      restExchangeSummarySchema,
      exchangeSummarySchema,
      wsHandshakeExchangeSummarySchema,
    ]),
    /** The saved request the send came from; absent for an ad-hoc send. */
    requestId: z.string().optional(),
  }),
  z.object({ kind: z.literal('failure'), failure: failedExchangeWireSchema }),
]);
export type LogEntryWire = z.infer<typeof logEntryWireSchema>;

/**
 * Payload for the `exchange.logged` event: a row for the HTTP Log that exists before its send's
 * own invoke resolves — currently only a WebSocket handshake (`request.openWs` stays pending for
 * the life of the session, so this is the log row's only way to appear while it is still open).
 */
export const exchangeLoggedEventSchema = z.object({ entry: logEntryWireSchema });
export type ExchangeLoggedEvent = z.infer<typeof exchangeLoggedEventSchema>;

/** Request payload for `log.curl`; the response is `requestCurlResponseSchema`. */
export const logCurlRequestSchema = z.object({ entry: logEntryWireSchema, shell: z.enum(['posix', 'powershell']) });
export type LogCurlRequest = z.infer<typeof logCurlRequestSchema>;

/** Response payload for `log.resend`: the new exchange, tagged by protocol. */
export const logResendResponseSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('soap'), exchange: exchangeSummarySchema }),
  z.object({ protocol: z.literal('rest'), exchange: restExchangeSummarySchema }),
  z.object({ protocol: z.literal('grpc'), exchange: grpcExchangeSummarySchema }),
]);
export type LogResendResponse = z.infer<typeof logResendResponseSchema>;

/**
 * Request payload for `log.exportHar`: the rows the log shows, in display order. Main redacts
 * them with `show: false` whatever the toggle says and picks the path itself.
 */
export const logExportHarRequestSchema = z.object({ entries: z.array(logEntryWireSchema) });
export type LogExportHarRequest = z.infer<typeof logExportHarRequestSchema>;

/** The whole open project, as mirrored by the renderer. Always a complete replacement. */
export const projectWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  dir: z.string(),
  dirty: z.boolean(),
  lastSavedAt: z.string().optional(),
  interfaces: z.array(interfaceWireSchema),
  requests: z.array(requestWireSchema),
  /** The project's REST APIs; `order` is shared with `interfaces`, so the two interleave. */
  apis: z.array(restApiWireSchema),
  /** Every folder of every API, flat; `parentId` gives the tree. */
  folders: z.array(restFolderWireSchema),
  /**
   * Every REST request of every API, flat; `apiId`/`folderId` give its place. A webhook
   * collection's own requests join this list too, under `webhooks.id`.
   */
  restRequests: z.array(restRequestWireSchema),
  /** The project's webhook collection, absent until the first webhook is created or imported. */
  webhooks: webhookCollectionWireSchema.optional(),
  /** The project's gRPC APIs; their folders are in `folders`, keyed by `apiId` like a REST API's. */
  grpcApis: z.array(grpcApiWireSchema),
  /** Every gRPC request of every gRPC API, flat. */
  grpcRequests: z.array(grpcRequestWireSchema),
  /** The project's WebSocket APIs; their folders are in `folders`, keyed by `apiId` like the rest. */
  wsApis: z.array(wsApiWireSchema),
  /** Every WebSocket request of every WebSocket API, flat. */
  wsRequests: z.array(wsRequestWireSchema),
  /** The project's MCP servers; their folders are in `folders`, keyed by `apiId` like the rest. */
  mcpServers: z.array(mcpServerWireSchema),
  /** Every MCP request of every MCP server, flat. */
  mcpRequests: z.array(mcpRequestWireSchema),
  /** The project's sequences (`sequences/`), in `order`. */
  sequences: z.array(sequenceWireSchema),
  /** The project's mocks (`mocks/`), in `order`. */
  mocks: z.array(mockWireSchema),
  properties: z.record(z.string(), z.string()),
  /** Names in `properties` skipped during resolution, without being deleted. */
  disabledProperties: z.array(z.string()),
  environments: z.array(environmentWireSchema),
  /** The environment endpoints/properties resolve against, or absent when none is active. */
  activeEnvironmentId: z.string().optional(),
  problems: z.array(projectProblemSchema),
  settings: projectSettingsSchema,
  /** The project's client keystore registry; empty when it has none. */
  keystores: z.array(keystoreWireSchema),
  /** The project's outgoing WS-Security configurations; empty when it has none. */
  wssOutgoing: z.array(wssOutgoingWireSchema),
  /** The project's incoming WS-Security configurations; empty when it has none. */
  wssIncoming: z.array(wssIncomingWireSchema),
  /** Containers shown as placeholders: a kind that is off, or one this version does not know. Absent when none. */
  unsupported: z.array(unsupportedContainerWireSchema).optional(),
});
export type ProjectWire = z.infer<typeof projectWireSchema>;

/** Response payload for `definition.applyUpdate`: what changed, plus the fresh project snapshot. */
export const definitionApplyUpdateResponseSchema = z.object({
  plan: definitionUpdatePlanResponseSchema,
  requestsCreated: z.array(z.string()),
  requestsRecreated: z.array(z.string()),
  requestsOrphaned: z.array(z.string()),
  backups: z.array(z.string()),
  project: projectWireSchema,
});
export type ApplyUpdateWire = z.infer<typeof definitionApplyUpdateResponseSchema>;

export const projectChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename-project'), name: z.string() }),
  z.object({
    kind: z.literal('add-request'),
    interfaceId: z.string(),
    bindingName: z.string(),
    operationName: z.string(),
  }),
  z.object({ kind: z.literal('clone-request'), requestId: z.string() }),
  z.object({ kind: z.literal('remove-request'), requestId: z.string() }),
  z.object({ kind: z.literal('update-request'), requestId: z.string(), patch: requestPatchSchema }),
  z.object({ kind: z.literal('remove-interface'), interfaceId: z.string() }),
  z.object({ kind: z.literal('set-default-endpoint'), interfaceId: z.string(), endpointId: z.string() }),
  z.object({ kind: z.literal('add-endpoint'), interfaceId: z.string(), name: z.string(), url: z.string() }),
  z.object({
    kind: z.literal('update-endpoint'),
    interfaceId: z.string(),
    endpointId: z.string(),
    patch: z.object({
      name: z.string().optional(),
      url: z.string().optional(),
      authMode: z.enum(['override', 'complement']).optional(),
      trustInvalid: z.boolean().optional(),
    }),
  }),
  z.object({ kind: z.literal('remove-endpoint'), interfaceId: z.string(), endpointId: z.string() }),
  z.object({ kind: z.literal('update-request-auth'), requestId: z.string(), auth: soapOwnerAuthWireSchema.nullable() }),
  /** `wsa: null` clears the request's own overrides, putting it back on "inherit". */
  z.object({ kind: z.literal('update-request-wsa'), requestId: z.string(), wsa: wsaConfigWireSchema.nullable() }),
  z.object({ kind: z.literal('update-interface-wsa'), interfaceId: z.string(), wsa: wsaConfigWireSchema }),
  z.object({
    kind: z.literal('update-interface-auth'),
    interfaceId: z.string(),
    auth: soapOwnerAuthWireSchema.nullable(),
  }),
  z.object({
    kind: z.literal('update-endpoint-auth'),
    interfaceId: z.string(),
    endpointId: z.string(),
    auth: soapOwnerAuthWireSchema.nullable(),
  }),
  z.object({ kind: z.literal('add-api'), name: z.string(), baseUrl: z.string() }),
  z.object({ kind: z.literal('update-api'), apiId: z.string(), patch: apiPatchSchema }),
  z.object({ kind: z.literal('remove-api'), apiId: z.string() }),
  z.object({
    kind: z.literal('add-folder'),
    apiId: z.string(),
    /** Absent adds the folder at the API's root. */
    parentId: z.string().optional(),
    name: z.string(),
  }),
  z.object({ kind: z.literal('update-folder'), folderId: z.string(), patch: restFolderPatchSchema }),
  z.object({ kind: z.literal('remove-folder'), folderId: z.string() }),
  z.object({
    kind: z.literal('add-rest-request'),
    apiId: z.string(),
    parentId: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal('update-rest-request'), requestId: z.string(), patch: restRequestPatchSchema }),
  z.object({ kind: z.literal('remove-rest-request'), requestId: z.string() }),
  z.object({ kind: z.literal('clone-rest-request'), requestId: z.string() }),
  /** Deletes one recorded response; its body file goes on the next save. */
  z.object({ kind: z.literal('remove-rest-example'), requestId: z.string(), exampleId: z.string() }),
  /** Creates the project's webhook collection if it does not have one yet. A no-op once it does. */
  z.object({ kind: z.literal('ensure-webhooks') }),
  z.object({
    kind: z.literal('update-webhooks'),
    patch: z.object({
      target: z.string().optional(),
      /** `null` clears the collection's own credentials, back to `inherit` having nothing above it. */
      auth: authConfigWireSchema.nullable().optional(),
      /** `null` clears the collection's signing: nothing inherits any. */
      signing: webhookSigningWireSchema.nullable().optional(),
    }),
  }),
  z.object({
    kind: z.literal('add-webhook-request'),
    /** Absent adds the request at the collection's root. */
    parentId: z.string().optional(),
    name: z.string().optional(),
    /** A full request body, applied with the same patch logic as `update-rest-request`. */
    draft: restRequestPatchSchema.optional(),
  }),
  z.object({
    kind: z.literal('add-webhook-folder'),
    /** Absent adds the folder at the collection's root. */
    parentId: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    kind: z.literal('set-webhook-folder-target'),
    folderId: z.string(),
    /** `null` clears the folder's own target, back to inheriting the collection's (or a parent's). */
    target: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('set-webhook-folder-signing'),
    folderId: z.string(),
    /** `null` clears the folder's own signing, back to inheriting. */
    signing: webhookSigningWireSchema.nullable(),
  }),
  z.object({
    kind: z.literal('move-node'),
    nodeId: z.string(),
    /** Absent moves the node to the API's root. */
    parentId: z.string().optional(),
    index: z.number().int().nonnegative(),
  }),
  /**
   * Reorders an API of any kind among its project's APIs (#701): before `beforeApiId`, or after the
   * last one when that is absent. Interfaces keep their places.
   */
  z.object({ kind: z.literal('move-container'), apiId: z.string(), beforeApiId: z.string().optional() }),
  z.object({ kind: z.literal('add-grpc-api'), name: z.string(), target: z.string(), tls: z.boolean().optional() }),
  z.object({ kind: z.literal('update-grpc-api'), apiId: z.string(), patch: grpcApiPatchSchema }),
  z.object({ kind: z.literal('remove-grpc-api'), apiId: z.string() }),
  z.object({
    kind: z.literal('add-grpc-request'),
    apiId: z.string(),
    parentId: z.string().optional(),
    name: z.string().optional(),
    service: z.string().optional(),
    method: z.string().optional(),
    methodKind: grpcMethodKindWireSchema.optional(),
    message: z.string().optional(),
  }),
  z.object({ kind: z.literal('update-grpc-request'), requestId: z.string(), patch: grpcRequestPatchSchema }),
  z.object({ kind: z.literal('remove-grpc-request'), requestId: z.string() }),
  z.object({ kind: z.literal('clone-grpc-request'), requestId: z.string() }),
  z.object({ kind: z.literal('add-ws-api'), name: z.string(), url: z.string().optional() }),
  z.object({ kind: z.literal('update-ws-api'), apiId: z.string(), patch: wsApiPatchSchema }),
  z.object({ kind: z.literal('remove-ws-api'), apiId: z.string() }),
  z.object({ kind: z.literal('add-sequence'), name: z.string().min(1) }),
  z.object({ kind: z.literal('update-sequence'), sequenceId: z.string(), patch: sequencePatchSchema }),
  z.object({ kind: z.literal('remove-sequence'), sequenceId: z.string() }),
  z.object({ kind: z.literal('duplicate-sequence'), sequenceId: z.string() }),
  z.object({
    kind: z.literal('add-mock'),
    containerId: z.string(),
    name: z.string().min(1),
    /** SOAP: the binding the mock speaks, in Clark notation; the first SOAP 1.1 binding when absent. */
    binding: z.string().optional(),
  }),
  z.object({ kind: z.literal('update-mock'), mockId: z.string(), patch: mockPatchSchema }),
  z.object({
    kind: z.literal('update-mock-operation'),
    mockId: z.string(),
    operationId: z.string(),
    patch: mockOperationPatchSchema,
  }),
  z.object({
    kind: z.literal('add-mock-response'),
    mockId: z.string(),
    operationId: z.string(),
    /** Copy this response rather than start from an empty 200. */
    copyOf: z.string().optional(),
  }),
  z.object({
    kind: z.literal('update-mock-response'),
    mockId: z.string(),
    operationId: z.string(),
    responseId: z.string(),
    patch: mockResponsePatchSchema,
  }),
  z.object({
    kind: z.literal('remove-mock-response'),
    mockId: z.string(),
    operationId: z.string(),
    responseId: z.string(),
  }),
  z.object({
    kind: z.literal('move-mock-response'),
    mockId: z.string(),
    operationId: z.string(),
    responseId: z.string(),
    to: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('remove-mock'), mockId: z.string() }),
  z.object({ kind: z.literal('duplicate-mock'), mockId: z.string() }),
  z.object({
    kind: z.literal('add-ws-request'),
    apiId: z.string(),
    parentId: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
  }),
  z.object({ kind: z.literal('update-ws-request'), requestId: z.string(), patch: wsRequestPatchSchema }),
  z.object({ kind: z.literal('remove-ws-request'), requestId: z.string() }),
  z.object({ kind: z.literal('clone-ws-request'), requestId: z.string() }),
  z.object({
    kind: z.literal('add-ws-message'),
    requestId: z.string(),
    name: z.string(),
    format: z.enum(['text', 'binary']).optional(),
    content: z.string().optional(),
  }),
  z.object({
    kind: z.literal('update-ws-message'),
    requestId: z.string(),
    messageId: z.string(),
    patch: z.object({
      name: z.string().optional(),
      format: z.enum(['text', 'binary']).optional(),
      content: z.string().optional(),
    }),
  }),
  z.object({ kind: z.literal('remove-ws-message'), requestId: z.string(), messageId: z.string() }),
  // An MCP server's folders go through `add-folder`, `update-folder` and `remove-folder`, and its
  // folders and requests move through `move-node`, as every other kind's do.
  z.object({
    kind: z.literal('add-mcp-server'),
    name: z.string(),
    /** Absent makes a stdio server with no command yet. */
    transport: mcpTransportWireSchema.optional(),
  }),
  z.object({ kind: z.literal('update-mcp-server'), apiId: z.string(), patch: mcpServerPatchSchema }),
  z.object({ kind: z.literal('remove-mcp-server'), apiId: z.string() }),
  z.object({
    kind: z.literal('add-mcp-request'),
    apiId: z.string(),
    parentId: z.string().optional(),
    name: z.string().optional(),
    /** Absent lists the server's tools; *New request from tool…* passes a `tools/call`. */
    operation: mcpOperationWireSchema.optional(),
  }),
  z.object({ kind: z.literal('update-mcp-request'), requestId: z.string(), patch: mcpRequestPatchSchema }),
  z.object({ kind: z.literal('remove-mcp-request'), requestId: z.string() }),
  z.object({ kind: z.literal('clone-mcp-request'), requestId: z.string() }),
  z.object({ kind: z.literal('add-environment'), name: z.string() }),
  z.object({
    kind: z.literal('update-environment'),
    environmentId: z.string(),
    patch: environmentPatchSchema,
  }),
  z.object({ kind: z.literal('remove-environment'), environmentId: z.string() }),
  z.object({ kind: z.literal('set-active-environment'), environmentId: z.string().nullable() }),
  z.object({ kind: z.literal('set-project-property'), name: z.string(), value: z.string() }),
  z.object({ kind: z.literal('remove-project-property'), name: z.string() }),
  z.object({ kind: z.literal('set-project-property-enabled'), name: z.string(), enabled: z.boolean() }),
  z.object({
    kind: z.literal('update-request-properties'),
    requestId: z.string(),
    patch: requestPropertiesPatchSchema,
  }),
  // A SOAP, REST, gRPC or WebSocket request's own assertions, replaced whole (request-assertions §5.2).
  z.object({
    kind: z.literal('set-request-assertions'),
    requestId: z.string(),
    assertions: z.array(requestAssertionWireSchema),
  }),
  // A SOAP, REST or gRPC request's scripts (#63); `null` removes them, and their files, altogether.
  z.object({
    kind: z.literal('update-request-scripts'),
    requestId: z.string(),
    scripts: requestScriptsPatchSchema.nullable(),
  }),
  // **Switch on scripts…**: switches on the scripts of many requests at once, each one a reviewable
  // change to its request file. A request without scripts is left as it is.
  z.object({ kind: z.literal('enable-scripts'), requestIds: z.array(z.string()).min(1).max(10_000) }),
  // **Convert to Wirebench script**: switches each named layered level to the typed API. Only the
  // fingerprint the review showed crosses: main works the conversion out again from its own model,
  // and refuses a level whose texts changed since (convert-imported-scripts spec §4.2, §7).
  z.object({
    kind: z.literal('convert-scripts'),
    levels: z
      .array(z.object({ ownerId: z.string(), fingerprint: z.string().max(128) }))
      .min(1)
      .max(10_000),
  }),
  z.object({ kind: z.literal('update-project-settings'), patch: projectSettingsPatchSchema }),
  z.object({
    kind: z.literal('update-interface'),
    interfaceId: z.string(),
    patch: z.object({ cacheDefinition: z.boolean().optional() }),
  }),
  // Only a path crosses the wire: main stats, reads and (when `copyToCache`) content-addresses
  // the file, so the renderer never touches the file system.
  z.object({
    kind: z.literal('add-attachment'),
    requestId: z.string(),
    /** Absolute path of the file to attach, as returned by `attachments.pickFiles` or a drop. */
    path: z.string(),
    /** Copy the bytes into `attachments/<sha256>` rather than referencing the file in place. */
    copyToCache: z.boolean(),
    /** Overrides the extension-sniffed media type. */
    contentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('update-attachment'),
    requestId: z.string(),
    attachmentId: z.string(),
    patch: attachmentPatchSchema,
  }),
  // Deliberately does NOT prune the cache: a blob whose last reference was just removed must
  // survive an undo, so pruning stays an explicit, separate action.
  z.object({ kind: z.literal('remove-attachment'), requestId: z.string(), attachmentId: z.string() }),
  // Only a path crosses the wire, and main refuses one that is neither inside the project
  // folder nor picked through `keystores.pickFile` this session (`keystore-outside-project`).
  z.object({
    kind: z.literal('add-keystore'),
    /** Defaults to the file's stem. */
    name: z.string().optional(),
    path: z.string(),
    /** A `secretRef` for the keystore password; never the password itself. */
    passwordSecretRef: z.string().optional(),
  }),
  z.object({
    kind: z.literal('update-keystore'),
    keystoreId: z.string(),
    patch: keystorePatchSchema,
  }),
  z.object({ kind: z.literal('remove-keystore'), keystoreId: z.string() }),
  z.object({ kind: z.literal('add-wss-outgoing'), name: z.string().optional() }),
  z.object({
    kind: z.literal('update-wss-outgoing'),
    configId: z.string(),
    patch: wssOutgoingPatchSchema,
  }),
  z.object({ kind: z.literal('remove-wss-outgoing'), configId: z.string() }),
  z.object({ kind: z.literal('add-wss-incoming'), name: z.string().optional() }),
  z.object({
    kind: z.literal('update-wss-incoming'),
    configId: z.string(),
    patch: wssIncomingPatchSchema,
  }),
  z.object({ kind: z.literal('remove-wss-incoming'), configId: z.string() }),
]);
export type ProjectChange = z.infer<typeof projectChangeSchema>;

/** Response for every channel that returns the whole project (or `null` when it is not open). */
export const projectSnapshotResponseSchema = z.object({ project: projectWireSchema.nullable() });
export type ProjectSnapshotResponse = z.infer<typeof projectSnapshotResponseSchema>;

/** Request/response for `project.mutate`: the new snapshot plus any entity the change created. */
export const projectMutateRequestSchema = z.object({ projectId: z.string(), change: projectChangeSchema });
export const projectMutateResponseSchema = z.object({
  project: projectWireSchema,
  /** Set by `add-request` and `clone-request`: the id of the request that was created. */
  createdRequestId: z.string().optional(),
  /**
   * Set by every REST change that creates something — `add-api`, `add-folder`, `add-rest-request`
   * and `clone-rest-request`: the id of the entity created, so the renderer can select or open it.
   */
  createdId: z.string().optional(),
  /** Set by `add-environment`: the id of the environment that was created. */
  createdEnvironmentId: z.string().optional(),
  /** Set by `add-attachment`: the id of the attachment that was created. */
  createdAttachmentId: z.string().optional(),
  /** Set by `add-keystore`: the id of the keystore that was registered. */
  createdKeystoreId: z.string().optional(),
  /** Set by `add-wss-outgoing`: the id of the configuration that was created. */
  createdWssOutgoingId: z.string().optional(),
  /** Set by `add-wss-incoming`: the id of the configuration that was created. */
  createdWssIncomingId: z.string().optional(),
  /** Set by `convert-scripts`: the levels switched (their backups written, then saved) and those refused. */
  converted: scriptConversionsResultWireSchema.optional(),
});
export type ProjectMutateResponse = z.infer<typeof projectMutateResponseSchema>;

/** Request for `project.planApiMove`: what moving an API to another project would copy and leave (#701). */
export const projectPlanApiMoveRequestSchema = z.object({ apiId: z.string(), targetProjectId: z.string() });
export const projectApiMovePlanSchema = z.object({
  apiName: z.string(),
  targetName: z.string(),
  /** Project variables the API reads that the target cannot resolve: copied with their values. */
  copiedVariables: z.array(z.string()),
  /** `${secret:…}` names with a value on this machine that the target lacks: copied. */
  copiedSecrets: z.array(z.string()),
  /** Variables that resolve in the source only through its environments: not copied. */
  unresolvedVariables: z.array(z.string()),
  /** `${secret:…}` names with no value on this machine: not copied. */
  unresolvedSecrets: z.array(z.string()),
  /** Keystores the API names: project-level, they stay behind. */
  keystores: z.array(z.string()),
  /** Source sequences with steps that run the API's requests. */
  sequences: z.array(z.string()),
});
export type ProjectApiMovePlan = z.infer<typeof projectApiMovePlanSchema>;

/** Request/response for `project.moveApi`: the move, then both projects as they are now (#701). */
export const projectMoveApiRequestSchema = z.object({
  apiId: z.string(),
  targetProjectId: z.string(),
  /** The target API it lands before; absent, after the target's last API. */
  beforeApiId: z.string().optional(),
});
export const projectMoveApiResponseSchema = z.object({
  sourceProjectId: z.string(),
  /** The API that followed it in the source, where an undo puts it back; absent, it was the last. */
  sourceBeforeApiId: z.string().optional(),
  source: projectWireSchema,
  target: projectWireSchema,
});
export type ProjectMoveApiResponse = z.infer<typeof projectMoveApiResponseSchema>;
export const projectAddInterfaceResponseSchema = z.object({
  /** The project the interface landed in — the one that was created, for a `newProjectName`. */
  projectId: z.string(),
  project: projectWireSchema,
  interfaceId: z.string(),
});
export type ProjectAddInterfaceResponse = z.infer<typeof projectAddInterfaceResponseSchema>;

export const projectImportLegacyResponseSchema = z.object({
  /** The project the import landed in — the one that was created, for a `newProjectName`. */
  projectId: z.string(),
  project: projectWireSchema,
  report: legacyImportReportSchema,
  /** The same report as plain text, one line per item, for the dialog's Copy button. */
  reportText: z.string(),
});
export type ProjectImportLegacyResponse = z.infer<typeof projectImportLegacyResponseSchema>;

export const apiImportOpenApiResponseSchema = z.object({
  /** The project the API landed in — the one that was created, for a `newProjectName`. */
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: openApiImportSummarySchema,
  /** The webhook group the import placed, when the document offered anything and `webhooks` was not `false`. */
  webhookGroup: z
    .object({
      folderId: z.string(),
      name: z.string(),
      items: z.array(z.object({ id: z.string(), label: z.string() })),
    })
    .optional(),
});
export type ApiImportOpenApiResponse = z.infer<typeof apiImportOpenApiResponseSchema>;

export const apiImportAsyncApiResponseSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: asyncApiImportSummarySchema,
});
export type ApiImportAsyncApiResponse = z.infer<typeof apiImportAsyncApiResponseSchema>;

/** What `api.asyncApiApplyUpdate` did: the saved project, the plan it applied, and the ids it touched. */
export const apiAsyncApiApplyUpdateResponseSchema = z.object({
  project: projectWireSchema,
  plan: asyncApiUpdatePlanSchema,
  applied: z.object({
    requestsAdded: z.array(z.string()),
    requestsOrphaned: z.array(z.string()),
    requestsRestored: z.array(z.string()),
    requestsRewritten: z.array(z.string()),
    messagesReplaced: z.array(z.string()),
    messagesAdded: z.array(z.string()),
  }),
});
export type ApiAsyncApiApplyUpdateResponse = z.infer<typeof apiAsyncApiApplyUpdateResponseSchema>;

/** What `api.restApplyUpdate` did: the saved project, the plan it applied, and counts for the toast. */
export const apiRestApplyUpdateResponseSchema = z.object({
  project: projectWireSchema,
  plan: restUpdatePlanSchema,
  /**
   * Present when the update was saved but something after the save went wrong — today, the stored
   * definition could not be refreshed. The toast must say so: the update itself stands.
   */
  warning: z.string().optional(),
  applied: z.object({
    requestsAdded: z.number(),
    /** Operations the plan lists as added that a hand-made request already claims, so apply skipped them. */
    requestsAlreadyPresent: z.number(),
    requestsOrphaned: z.number(),
    requestsRestored: z.number(),
    requestsRewritten: z.number(),
    rowsAdded: z.number(),
    rowsRemoved: z.number(),
    /**
     * What the same update did to the webhook group linked to this API, applied in the same
     * project change. Every count is `0` when no group is linked — nothing to update.
     */
    webhooks: z.object({
      added: z.number(),
      orphaned: z.number(),
      restored: z.number(),
      rewritten: z.number(),
    }),
  }),
});
export type ApiRestApplyUpdateResponse = z.infer<typeof apiRestApplyUpdateResponseSchema>;

/** Response payload for `api.importPostman`. */
const apiImportPostmanResponseObject = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: postmanImportSummarySchema,
  /** What became of the collection's variables; absent when it had none. */
  variables: importVariablesSummarySchema.optional(),
});
/** Spelled out as an interface for the same reason as {@link ApiImportHarResponse}. */
export interface ApiImportPostmanResponse {
  projectId: string;
  project: ProjectWire;
  apiId: string;
  summary: PostmanImportSummaryWire;
  variables?: ImportVariablesSummaryWire | undefined;
}
/** Response payload for `api.importPostman`. */
export const apiImportPostmanResponseSchema: z.ZodType<ApiImportPostmanResponse> = apiImportPostmanResponseObject;

const apiImportHarResponseObject = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  /** One API per origin the capture called, in the order they were first seen. */
  apiIds: z.array(z.string()).readonly(),
  summary: z.object({
    entries: z.number(),
    kept: z.number(),
    requests: z.number(),
    apis: z.number(),
    statuses: z.record(z.string(), z.number()),
    /** How many recorded exchanges were written to History; zero unless `responses` was `history`. */
    historyRecorded: z.number(),
  }),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
/**
 * Spelled out as an interface rather than `z.infer`, so the IPC channel registry's inferred type
 * names it instead of expanding a whole project. The type-equality check after it fails to compile
 * when the interface and the schema drift apart in either direction.
 */
export interface ApiImportHarResponse {
  projectId: string;
  project: ProjectWire;
  apiIds: readonly string[];
  summary: {
    entries: number;
    kept: number;
    requests: number;
    apis: number;
    statuses: Record<string, number>;
    historyRecorded: number;
  };
  warnings: readonly string[];
  notes: readonly string[];
  reportText: string;
}
/**
 * Response payload for `api.importHar`. Annotated with its named type so the IPC channel registry's
 * inferred type stays serialisable.
 */
export const apiImportHarResponseSchema: z.ZodType<ApiImportHarResponse> = apiImportHarResponseObject;
export type ApiImportHarResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportHarResponseObject>, ApiImportHarResponse>
>;
export type ApiImportPostmanResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportPostmanResponseObject>, ApiImportPostmanResponse>
>;

const apiImportHttpFileResponseObject = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  /** The REST API, then the WebSocket API when the file had a `WEBSOCKET` request. */
  apiIds: z.array(z.string()).readonly(),
  counts: z.object({ requests: z.number(), websocket: z.number(), skipped: z.number(), scripts: z.number() }),
  /** What became of the file's variables and its environment files; absent when there were none. */
  variables: importVariablesSummarySchema.optional(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
/** Spelled out as an interface for the same reason as {@link ApiImportHarResponse}. */
export interface ApiImportHttpFileResponse {
  projectId: string;
  project: ProjectWire;
  apiIds: readonly string[];
  counts: { requests: number; websocket: number; skipped: number; scripts: number };
  variables?: ImportVariablesSummaryWire | undefined;
  warnings: readonly string[];
  notes: readonly string[];
  reportText: string;
}
/** Response payload for `api.importHttpFile`. */
export const apiImportHttpFileResponseSchema: z.ZodType<ApiImportHttpFileResponse> = apiImportHttpFileResponseObject;
export type ApiImportHttpFileResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportHttpFileResponseObject>, ApiImportHttpFileResponse>
>;

/**
 * Request payload for `api.importOpenCollection`: an OpenCollection, as a picked file or as text. A
 * picked `opencollection.yml` with no `items` is the directory form: main reads every YAML file
 * under its folder. A collection with no request and no environment — one holding only project
 * properties or scripts — is refused before any project is created.
 */
export const apiImportOpenCollectionRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: postmanSourceSchema,
});
export type ApiImportOpenCollectionRequest = z.infer<typeof apiImportOpenCollectionRequestSchema>;

const apiImportOpenCollectionResponseObject = z.object({
  projectId: z.string(),
  /** Absent when the collection held only environments, so no API was placed in the project. */
  project: projectWireSchema.optional(),
  /** The REST API, then the gRPC API, then the WebSocket API, each only when the collection had its items. */
  apiIds: z.array(z.string()).readonly(),
  counts: z.object({
    requests: z.number(),
    folders: z.number(),
    assertions: z.number(),
    assertionsSkipped: z.number(),
    scripts: z.number(),
  }),
  /** What became of the collection's environments and variables; absent when there were none. Never a value. */
  variables: importVariablesSummarySchema.optional(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
/** Spelled out as an interface for the same reason as {@link ApiImportHarResponse}. */
export interface ApiImportOpenCollectionResponse {
  projectId: string;
  project?: ProjectWire | undefined;
  apiIds: readonly string[];
  counts: { requests: number; folders: number; assertions: number; assertionsSkipped: number; scripts: number };
  variables?: ImportVariablesSummaryWire | undefined;
  warnings: readonly string[];
  notes: readonly string[];
  reportText: string;
}
/** Response payload for `api.importOpenCollection`. */
export const apiImportOpenCollectionResponseSchema: z.ZodType<ApiImportOpenCollectionResponse> =
  apiImportOpenCollectionResponseObject;
export type ApiImportOpenCollectionResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportOpenCollectionResponseObject>, ApiImportOpenCollectionResponse>
>;

/**
 * Request payload for `api.importPostmanFolder`: a folder (v3) collection, as a picked folder or a
 * picked `.resources/definition.yaml`, which stands for the folder above it. A workspace folder
 * imports every collection under its `collections/`, with its environments and globals. `name`
 * names the API(s) of a folder holding one collection.
 */
export const apiImportPostmanFolderRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  path: z.string().min(1).max(MAX_IMPORT_LOCATION_CHARS),
  name: z.string().max(200).optional(),
});
export type ApiImportPostmanFolderRequest = z.infer<typeof apiImportPostmanFolderRequestSchema>;

const apiImportPostmanFolderResponseObject = z.object({
  projectId: z.string(),
  /** Absent when the folder held only environments, so no API was placed in the project. */
  project: projectWireSchema.optional(),
  /** Each collection's REST, gRPC and WebSocket API, in that order, each only when it had requests of its kind. */
  apiIds: z.array(z.string()).readonly(),
  counts: z.object({
    collections: z.number(),
    requests: z.number(),
    folders: z.number(),
    examples: z.number(),
  }),
  /** What became of the variables, environments and globals; absent when there were none. Never a value. */
  variables: importVariablesSummarySchema.optional(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
/** Spelled out as an interface for the same reason as {@link ApiImportHarResponse}. */
export interface ApiImportPostmanFolderResponse {
  projectId: string;
  project?: ProjectWire | undefined;
  apiIds: readonly string[];
  counts: { collections: number; requests: number; folders: number; examples: number };
  variables?: ImportVariablesSummaryWire | undefined;
  warnings: readonly string[];
  notes: readonly string[];
  reportText: string;
}
/** Response payload for `api.importPostmanFolder`. */
export const apiImportPostmanFolderResponseSchema: z.ZodType<ApiImportPostmanFolderResponse> =
  apiImportPostmanFolderResponseObject;
export type ApiImportPostmanFolderResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportPostmanFolderResponseObject>, ApiImportPostmanFolderResponse>
>;

/**
 * Request payload for `api.importInsomnia` (and the other request clients' importers that follow):
 * an export as a picked file or as text. `name` names the API(s) of an export holding one
 * collection. An export holding only environments is refused: it is imported with
 * `api.importClientEnvironments`.
 */
export const apiImportClientRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: postmanSourceSchema,
  name: z.string().max(200).optional(),
});
export type ApiImportClientRequest = z.infer<typeof apiImportClientRequestSchema>;

/** `api.importPlugin`: a file or text through a plugin's importer, placed as a client export is. */
export const apiImportPluginRequestSchema = apiImportClientRequestSchema.extend({
  importer: z.string().regex(PLUGIN_CONTRIBUTION_ID),
});
export type ApiImportPluginRequest = z.infer<typeof apiImportPluginRequestSchema>;

const apiImportClientResponseObject = z.object({
  projectId: z.string(),
  /** Absent when the export held only project properties, so no API was placed in the project. */
  project: projectWireSchema.optional(),
  /** Each collection's REST, gRPC and WebSocket API, in that order, each only when it had requests of its kind. */
  apiIds: z.array(z.string()).readonly(),
  counts: z.object({
    collections: z.number(),
    requests: z.number(),
    folders: z.number(),
    examples: z.number(),
    assertions: z.number(),
    /** Script files kept as text under `imported-scripts/`; attached scripts are not counted here. */
    scripts: z.number(),
  }),
  /** What became of the environments and variables; absent when there were none. Never a value. */
  variables: importVariablesSummarySchema.optional(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
/** Spelled out as an interface for the same reason as {@link ApiImportHarResponse}. */
export interface ApiImportClientResponse {
  projectId: string;
  project?: ProjectWire | undefined;
  apiIds: readonly string[];
  counts: {
    collections: number;
    requests: number;
    folders: number;
    examples: number;
    assertions: number;
    scripts: number;
  };
  variables?: ImportVariablesSummaryWire | undefined;
  warnings: readonly string[];
  notes: readonly string[];
  reportText: string;
}
/** Response payload for `api.importInsomnia`. */
export const apiImportClientResponseSchema: z.ZodType<ApiImportClientResponse> = apiImportClientResponseObject;
export type ApiImportClientResponseInSync = AssertTrue<
  TypesEqual<z.infer<typeof apiImportClientResponseObject>, ApiImportClientResponse>
>;

/**
 * Request payload for `api.importClientEnvironments`: another request client's environments file,
 * applied to the open workspace. An export holding requests is refused.
 */
export const apiImportClientEnvironmentsRequestSchema = z.object({
  format: z.enum(['insomnia', 'hoppscotch', 'thunder-client']),
  source: postmanSourceSchema,
});
export type ApiImportClientEnvironmentsRequest = z.infer<typeof apiImportClientEnvironmentsRequestSchema>;

export const apiImportProtoResponseSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: protoImportSummarySchema,
});
export type ApiImportProtoResponse = z.infer<typeof apiImportProtoResponseSchema>;

export const apiGrpcRefreshResponseSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  summary: protoImportSummarySchema,
  /** How many requests were created, badged orphaned, and un-badged. */
  requestsAdded: z.number(),
  requestsOrphaned: z.number(),
  requestsRestored: z.number(),
  foldersAdded: z.number(),
});
export type ApiGrpcRefreshResponse = z.infer<typeof apiGrpcRefreshResponseSchema>;

/** Payload for the `project.changed` event: the renderer replaces its mirror wholesale. */
export const projectChangedEventSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema.nullable(),
});
export type ProjectChangedEvent = z.infer<typeof projectChangedEventSchema>;

/** Wire (and on-disk) shape of one recorded send — mirrors the engine's `HistoryEntry`. */
export const historyEntrySchema = z.object({
  id: z.string(),
  /**
   * Which protocol the send used. Optional, and honestly so: a line written before the REST client
   * carries none, and a reader treats its absence as SOAP (`normalizeHistoryEntry`). Every entry
   * main writes from now on names its kind.
   */
  kind: z.enum(['soap', 'rest', 'grpc', 'websocket', 'mcp']).optional(),
  at: z.string(),
  projectId: z.string(),
  requestId: z.string().optional(),
  requestName: z.string(),
  interfaceName: z.string(),
  operationName: z.string(),
  endpoint: z.string(),
  soapVersion: soapVersionSchema,
  soapAction: z.string().optional(),
  /** The HTTP method, for a REST send. A SOAP send is always a POST and records none. */
  method: z.string().optional(),
  status: z.number().optional(),
  durationMs: z.number(),
  ok: z.boolean(),
  fault: historyFaultSchema.optional(),
  request: z.object({ envelopeXml: z.string(), headers: z.array(headerEntrySchema) }),
  response: z
    .object({
      envelopeXml: z.string().optional(),
      rawHeaders: z.array(z.tuple([z.string(), z.string()])),
      status: z.number(),
      statusText: z.string(),
    })
    .optional(),
  error: historyErrorSchema.optional(),
  /** The call record of a gRPC send: the method, the status and every message on both sides. */
  grpc: z
    .object({
      service: z.string(),
      method: z.string(),
      methodKind: grpcMethodKindWireSchema,
      status: z.number().optional(),
      statusName: z.string().optional(),
      statusMessage: z.string().optional(),
      requestMessages: z.array(z.string()),
      responseMessages: z.array(z.string()),
      trailers: z.array(headerEntrySchema),
    })
    .optional(),
  /** The session record of a WebSocket send: the handshake outcome, how it closed, its frames. */
  ws: z
    .object({
      url: z.string(),
      status: z.number().optional(),
      protocol: z.string().optional(),
      closeCode: z.number(),
      closeReason: z.string(),
      closedBy: z.enum(['client', 'server', 'error']),
      counts: z.object({
        sent: z.number(),
        received: z.number(),
        bytesSent: z.number(),
        bytesReceived: z.number(),
      }),
      frames: z.array(wsFrameWireSchema),
      /** Set only when the cap actually trimmed something (frames, or just a payload). */
      truncated: z.boolean().optional(),
      omittedFrames: z.number().optional(),
      /** The handshake's transport error, absent when the handshake succeeded (or never ran). */
      error: z.string().optional(),
    })
    .optional(),
  /** The session record of an MCP send: the operation, how the server answered, its capped messages. */
  mcp: historyMcpWireSchema.optional(),
  /**
   * The event-stream record of a REST send whose response was `text/event-stream`: the engine's
   * `HistorySse`, capped the way a WebSocket session's frames are.
   */
  sse: z
    .object({
      rows: z.array(sseRowWireSchema),
      counts: z.object({ events: z.number(), comments: z.number(), retries: z.number(), bytes: z.number() }),
      lastEventId: z.string(),
      endedBy: z.enum(['server', 'client', 'error']),
      error: z.string().optional(),
      /** Set only when the cap actually trimmed something (rows, or just a payload). */
      truncated: z.boolean().optional(),
      /** Every row missing from `rows` compared to the live stream. */
      omittedRows: z.number().optional(),
    })
    .optional(),
  /** A REST response's contract result, capped as the live one is (`historyContractOf`). */
  contract: restContractResultSchema.optional(),
  sizeBytes: z.number(),
  tags: z.array(z.string()).optional(),
});
export type HistoryEntryWire = z.infer<typeof historyEntrySchema>;
export const historyListResponseSchema = z.object({ entries: z.array(historyEntrySchema), total: z.number() });
export const historyGetResponseSchema = z.object({ entry: historyEntrySchema.optional() });

/** Payload for the `history.appended` event: one new entry, for the History view to prepend. */
export const historyAppendedEventSchema = z.object({ entry: historyEntrySchema });
export type HistoryAppendedEvent = z.infer<typeof historyAppendedEventSchema>;

/**
 * Request for `workspace.stashDrafts`: every request edit the renderer holds unsaved for the named
 * workspace, replacing whatever was stashed before. Main ignores a stash for a workspace that is
 * no longer the open one, so a late write can never land in the next workspace.
 */
export const workspaceStashDraftsRequestSchema = z.object({
  workspaceId: z.string(),
  requests: z.record(z.string(), requestPatchSchema),
  /**
   * The REST editor's unsaved edits, by REST request id. Optional so a stash written by an older
   * build still loads: absent means the session had none.
   */
  restRequests: z.record(z.string(), restRequestPatchSchema).optional(),
  /** The gRPC editor's unsaved edits, by gRPC request id; absent in a stash from an older build. */
  grpcRequests: z.record(z.string(), grpcRequestPatchSchema).optional(),
  /** The WebSocket editor's unsaved edits, by ws request id; absent in a stash from an older build. */
  wsRequests: z.record(z.string(), wsRequestPatchSchema).optional(),
  /** The MCP editor's unsaved edits, by MCP request id; absent in a stash from an older build. */
  mcpRequests: z.record(z.string(), mcpRequestPatchSchema).optional(),
});
export type WorkspaceStashDraftsRequest = z.infer<typeof workspaceStashDraftsRequestSchema>;

/**
 * Response for `workspace.takeRestored`: the request drafts and per-project notices the last open
 * restored, handed over once. `workspaceId` is `null` when nothing is open.
 */
export const workspaceRestoredResponseSchema = z.object({
  workspaceId: z.string().nullable(),
  drafts: z.record(z.string(), requestPatchSchema),
  /** The REST drafts the last session left unsaved, by REST request id. */
  restDrafts: z.record(z.string(), restRequestPatchSchema),
  grpcDrafts: z.record(z.string(), grpcRequestPatchSchema).default({}),
  /** The WebSocket drafts the last session left unsaved, by WebSocket request id. */
  wsDrafts: z.record(z.string(), wsRequestPatchSchema).default({}),
  /** The MCP drafts the last session left unsaved, by MCP request id. */
  mcpDrafts: z.record(z.string(), mcpRequestPatchSchema).default({}),
  notices: z.array(unsavedRestoreNoticeSchema),
});
export type WorkspaceRestoredResponse = z.infer<typeof workspaceRestoredResponseSchema>;
