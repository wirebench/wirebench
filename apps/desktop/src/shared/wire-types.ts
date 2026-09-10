/**
 * Zod schemas (and their inferred types) for the `definition.*`/`request.*` IPC channels
 * and the `engine.progress` event. Kept separate from `ipc.ts` because these shapes — the
 * JSON-serialisable projection of the engine's `ImportResult`/`SoapExchange` types — are
 * large enough to crowd the channel registry.
 *
 * Every shape here must be plain JSON: no DOM nodes, no `Uint8Array` (bytes cross the wire
 * as base64 strings), no functions.
 */

import { z } from 'zod';

/** Where a WSDL definition comes from — mirrors the engine's `ImportSource`. */
export const importSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string(), location: z.string().optional() }),
]);
export type ImportSourceWire = z.infer<typeof importSourceSchema>;

/**
 * Basic-auth credentials for fetching a definition (and any of its imports). The password NEVER
 * crosses the wire as plaintext: the caller stores it via `secrets.set` first and sends the
 * resulting `secretRef`, which main resolves at send/fetch time. `password` is deliberately
 * absent from this schema — zod strips/rejects it, so a plaintext password sent by mistake
 * fails validation rather than silently reaching a project file or a log.
 */
export const importAuthSchema = z
  .object({ username: z.string(), passwordRef: z.string() })
  // `.strict()`: an unknown key is a hard error, not silently stripped — so a caller that
  // sends a plaintext `password` fails validation loudly instead of having it quietly dropped
  // (or, worse, one day passed through to a project file).
  .strict();

/** Request payload for `definition.import`. */
export const definitionImportRequestSchema = z.object({
  source: importSourceSchema,
  options: z.object({ auth: importAuthSchema.optional() }).optional(),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export type DefinitionImportRequest = z.infer<typeof definitionImportRequestSchema>;

const soapVersionSchema = z.enum(['1.1', '1.2', 'none']);

const portSummarySchema = z.object({
  name: z.string(),
  address: z.string().optional(),
  binding: z.string(),
  soapVersion: soapVersionSchema,
});

const serviceSummarySchema = z.object({
  name: z.string(),
  ports: z.array(portSummarySchema),
});

const operationPortRefSchema = z.object({
  service: z.string(),
  port: z.string(),
  address: z.string().optional(),
});

const operationSummaryWireSchema = z.object({
  name: z.string(),
  binding: z.string(),
  bindingLocal: z.string(),
  soapVersion: soapVersionSchema,
  soapAction: z.string().optional(),
  style: z.enum(['document', 'rpc']),
  documentation: z.string().optional(),
  ports: z.array(operationPortRefSchema),
});

const importProblemSchema = z.object({
  source: z.enum(['resolve', 'wsdl', 'schema']),
  code: z.string(),
  message: z.string(),
  location: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});
export type ImportProblemWire = z.infer<typeof importProblemSchema>;

/** Response payload for `definition.import`: a JSON-serialisable projection of `ImportResult`. */
export const interfaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  definitionUrl: z.string(),
  targetNamespace: z.string(),
  soapVersions: z.array(soapVersionSchema),
  services: z.array(serviceSummarySchema),
  operations: z.array(operationSummaryWireSchema),
  problems: z.array(importProblemSchema),
  documentCount: z.number(),
});
export type InterfaceSummary = z.infer<typeof interfaceSummarySchema>;
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;
export type PortSummary = z.infer<typeof portSummarySchema>;
export type OperationSummaryWire = z.infer<typeof operationSummaryWireSchema>;

/** Request/response for `definition.close`. */
export const definitionCloseRequestSchema = z.object({ interfaceId: z.string() });
export const definitionCloseResponseSchema = z.object({ closed: z.boolean() });

const generateOptionsSchema = z.object({
  includeOptional: z.boolean().optional(),
  sampleValues: z.boolean().optional(),
  typeComments: z.boolean().optional(),
});

/** Request payload for `request.generate`. */
export const requestGenerateRequestSchema = z.object({
  interfaceId: z.string(),
  /** Clark-notation binding QName: `{namespaceUri}localName`. */
  bindingName: z.string(),
  operationName: z.string(),
  options: generateOptionsSchema.optional(),
  /** When true, build an empty envelope (`generateEmptyRequest`) instead of a sample one. */
  empty: z.boolean().optional(),
});
export type RequestGenerateRequest = z.infer<typeof requestGenerateRequestSchema>;

const buildProblemSchema = z.object({ code: z.string(), message: z.string() });

/** Response payload for `request.generate`: a JSON-serialisable `GeneratedRequest`. */
export const requestGenerateResponseSchema = z.object({
  envelopeXml: z.string(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  contentType: z.string(),
  headers: z.record(z.string(), z.string()),
  problems: z.array(buildProblemSchema),
});
export type RequestGenerateResponse = z.infer<typeof requestGenerateResponseSchema>;

const tlsOptionsSchema = z.object({
  rejectUnauthorized: z.boolean().optional(),
  ca: z.array(z.string()).optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  passphrase: z.string().optional(),
  minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).optional(),
  servername: z.string().optional(),
});

const soapSendInputWireSchema = z.object({
  endpoint: z.string(),
  envelopeXml: z.string(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().optional(),
  followRedirects: z.boolean().optional(),
  maxSizeBytes: z.number().optional(),
  skipSoapAction: z.boolean().optional(),
  tls: tlsOptionsSchema.optional(),
});
export type SoapSendInputWire = z.infer<typeof soapSendInputWireSchema>;

/** Request payload for `request.send`. */
export const requestSendRequestSchema = z.object({
  /** Client-generated id (`crypto.randomUUID()`), used to correlate a later `request.cancel`. */
  sendId: z.string(),
  input: soapSendInputWireSchema,
  /** The saved request this send came from, if any — used to resolve its effective auth. */
  requestId: z.string().optional(),
});
export type RequestSendRequest = z.infer<typeof requestSendRequestSchema>;

const httpRequestSummarySchema = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
});

const timingsWireSchema = z.object({
  startedAt: z.string(),
  totalMs: z.number(),
  dnsMs: z.number().optional(),
  connectMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

const redirectWireSchema = z.object({ url: z.string(), status: z.number() });

const tlsInfoWireSchema = z.object({
  protocol: z.string().optional(),
  cipher: z.string().optional(),
  authorized: z.boolean().optional(),
});

/** Wire projection of `HttpExchange`: `Uint8Array` bodies become base64 strings. */
const httpExchangeWireSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  rawHeaders: z.array(z.tuple([z.string(), z.string()])),
  bodyBase64: z.string(),
  rawBodyBase64: z.string(),
  rawRequestBase64: z.string(),
  rawResponseBase64: z.string(),
  truncated: z.boolean(),
  decodeError: z.string().optional(),
  timings: timingsWireSchema,
  redirects: z.array(redirectWireSchema),
  tls: tlsInfoWireSchema.optional(),
  request: httpRequestSummarySchema,
});
export type HttpExchangeWire = z.infer<typeof httpExchangeWireSchema>;

/** Wire projection of `SoapFault`: the DOM `element` is dropped (not serialisable). */
const faultWireSchema = z.object({
  version: z.enum(['1.1', '1.2']),
  code: z.string(),
  subcodes: z.array(z.string()),
  reason: z.string(),
  actor: z.string().optional(),
  role: z.string().optional(),
  node: z.string().optional(),
  detailXml: z.string().optional(),
});
export type FaultWire = z.infer<typeof faultWireSchema>;

const soapResponseWireSchema = z.object({
  envelopeXml: z.string(),
  version: z.enum(['1.1', '1.2']).optional(),
  isSoap: z.boolean(),
  fault: faultWireSchema.optional(),
});

const exchangeProblemSchema = z.object({ code: z.string(), message: z.string() });

/** Which part of a send input an {@link UnresolvedRefWire} was found in. */
export const expansionFieldSchema = z.enum(['endpoint', 'envelopeXml', 'soapAction', 'header']);
export type ExpansionField = z.infer<typeof expansionFieldSchema>;

/**
 * Wire projection of the engine's `UnresolvedRef`: one `${...}` property expansion that could
 * not be resolved. `field`/`headerName` are added by the main process's preflight so the UI can
 * name *where* in the request the reference sits; the engine itself reports neither, so both are
 * absent on the refs echoed back with a completed exchange.
 */
export const unresolvedRefWireSchema = z.object({
  expr: z.string(),
  scope: z.string().optional(),
  name: z.string().optional(),
  code: z.enum(['missing', 'unknown-scope', 'cycle', 'too-deep', 'malformed']),
  start: z.number(),
  end: z.number(),
  via: z.array(z.string()).optional(),
  field: expansionFieldSchema.optional(),
  /** Set only when `field` is `'header'`: the (unexpanded) name of the header it was found in. */
  headerName: z.string().optional(),
});
export type UnresolvedRefWire = z.infer<typeof unresolvedRefWireSchema>;

/** Where the URL a request will actually be sent to came from — mirrors the engine's `EndpointSource`. */
export const endpointSourceSchema = z.enum([
  'environment',
  'request-custom',
  'request-endpoint',
  'interface-default',
  'none',
]);
export type EndpointSourceWire = z.infer<typeof endpointSourceSchema>;

/** Request payload for `request.preflight`. */
export const requestPreflightRequestSchema = z.object({ requestId: z.string() });

/**
 * Response payload for `request.preflight`: the endpoint the saved request resolves to under
 * the active environment, plus every property reference in it that would not expand. Purely
 * a dry run — nothing is sent.
 */
export const requestPreflightResponseSchema = z.object({
  endpoint: z.string().optional(),
  endpointSource: endpointSourceSchema,
  unresolved: z.array(unresolvedRefWireSchema),
});
export type RequestPreflightResponse = z.infer<typeof requestPreflightResponseSchema>;

/** Response payload for `request.send`: a JSON-serialisable projection of `SoapExchange`. */
export const exchangeSummarySchema = z.object({
  sendId: z.string(),
  durationMs: z.number(),
  http: httpExchangeWireSchema,
  response: soapResponseWireSchema.optional(),
  problems: z.array(exchangeProblemSchema),
  /** Set only when the send expanded properties: the references that stayed unresolved. */
  unresolved: z.array(unresolvedRefWireSchema).optional(),
});
export type ExchangeSummary = z.infer<typeof exchangeSummarySchema>;

/** Request/response for `request.cancel`. */
export const requestCancelRequestSchema = z.object({ sendId: z.string() });
export const requestCancelResponseSchema = z.object({ cancelled: z.boolean() });

/** Request/response for `definition.cancelImport`. */
export const definitionCancelImportRequestSchema = z.object({ token: z.string() });
export const definitionCancelImportResponseSchema = z.object({ cancelled: z.boolean() });

/** A file-open filter group, mirroring Electron's `dialog.showOpenDialog` `filters` option. */
const dialogFilterSchema = z.object({ name: z.string(), extensions: z.array(z.string()) });

/** Request/response for `dialogs.openFile`. */
export const dialogsOpenFileRequestSchema = z.object({
  filters: z.array(dialogFilterSchema).optional(),
  title: z.string().optional(),
});
export const dialogsOpenFileResponseSchema = z.object({ path: z.string().optional() });

/** Request/response for `dialogs.openFolder`. */
export const dialogsOpenFolderRequestSchema = z.object({ title: z.string().optional() });
export const dialogsOpenFolderResponseSchema = z.object({ path: z.string().optional() });

/** Payload for the `engine.progress` event. */
export const engineProgressEventSchema = z.object({
  kind: z.literal('import'),
  /** Unknown until the import finishes; use `token` to correlate while it is in flight. */
  interfaceId: z.string().optional(),
  token: z.string().optional(),
  phase: z.enum(['fetch', 'parse', 'schema', 'done']),
  message: z.string(),
  pct: z.number().optional(),
});
export type EngineProgressEvent = z.infer<typeof engineProgressEventSchema>;

// ---------------------------------------------------------------------------
// Project (Task 21): the main process owns the authoritative engine `Project`;
// the renderer holds a read-only mirror of the shapes below.
// ---------------------------------------------------------------------------

/** One HTTP header of a saved request, in author-defined order (duplicates allowed). */
export const headerEntrySchema = z.object({ name: z.string(), value: z.string() });
export type HeaderEntryWire = z.infer<typeof headerEntrySchema>;

/**
 * How a request/endpoint/interface authenticates, as mirrored to the renderer. Never a
 * `password` — only a `passwordRef` into the main-process secret store, which the renderer
 * cannot read back (there is no `secrets.get` channel).
 */
export const endpointAuthSchema = z.object({
  type: z.enum(['none', 'basic', 'ntlm']),
  username: z.string().optional(),
  passwordRef: z.string().optional(),
  domain: z.string().optional(),
  preemptive: z.boolean().optional(),
});
export type EndpointAuthWire = z.infer<typeof endpointAuthSchema>;

/** One addressable endpoint of an interface (credentials referenced by `secretRef`, never on the wire). */
export const endpointWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  auth: endpointAuthSchema.optional(),
});
export type EndpointWire = z.infer<typeof endpointWireSchema>;

/** Whether the definition behind an interface has been (re)loaded into the engine yet. */
export const hydrationStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type HydrationStatus = z.infer<typeof hydrationStatusSchema>;

/**
 * An interface as the renderer sees it: the {@link InterfaceSummary} fields the explorer and
 * request editor already read, plus the on-disk identity (`slug`, endpoints) and the
 * background hydration state of its definition.
 */
export const interfaceWireSchema = interfaceSummarySchema.extend({
  slug: z.string(),
  cacheDefinition: z.boolean(),
  endpoints: z.array(endpointWireSchema),
  defaultEndpointId: z.string().optional(),
  hydration: hydrationStatusSchema,
  auth: endpointAuthSchema.optional(),
});
export type InterfaceWire = z.infer<typeof interfaceWireSchema>;

/** A saved request, flattened out of its owning operation so the renderer can index it by id. */
export const requestWireSchema = z.object({
  id: z.string(),
  interfaceId: z.string(),
  /** Clark-notation binding QName: `{namespaceUri}localName`. */
  bindingName: z.string(),
  operationName: z.string(),
  name: z.string(),
  envelopeXml: z.string(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  endpointId: z.string().optional(),
  endpointUrl: z.string().optional(),
  headers: z.array(headerEntrySchema),
  order: z.number(),
  auth: endpointAuthSchema.optional(),
});
export type RequestWire = z.infer<typeof requestWireSchema>;

/**
 * A named set of per-interface endpoint overrides (keyed by interface *slug*) plus environment
 * properties, which take precedence over project properties in shorthand `${name}` lookups.
 */
export const environmentWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  endpoints: z.record(z.string(), z.string()),
  properties: z.record(z.string(), z.string()),
});
export type EnvironmentWire = z.infer<typeof environmentWireSchema>;

/** A recoverable inconsistency found while loading (or hydrating) a project folder. */
export const projectProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Path relative to the project root, or the interface id for a hydration failure. */
  file: z.string(),
});
export type ProjectProblemWire = z.infer<typeof projectProblemSchema>;

/** The whole open project, as mirrored by the renderer. Always a complete replacement. */
export const projectWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  dir: z.string(),
  dirty: z.boolean(),
  lastSavedAt: z.string().optional(),
  interfaces: z.array(interfaceWireSchema),
  requests: z.array(requestWireSchema),
  properties: z.record(z.string(), z.string()),
  environments: z.array(environmentWireSchema),
  /** The environment endpoints/properties resolve against, or absent when none is active. */
  activeEnvironmentId: z.string().optional(),
  problems: z.array(projectProblemSchema),
});
export type ProjectWire = z.infer<typeof projectWireSchema>;

/** The fields of a request the renderer may patch through `update-request`. */
export const requestPatchSchema = z.object({
  name: z.string().optional(),
  envelopeXml: z.string().optional(),
  endpointId: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional(),
  headers: z.array(headerEntrySchema).optional(),
  soapAction: z.string().nullable().optional(),
});
export type RequestPatchWire = z.infer<typeof requestPatchSchema>;

/**
 * The fields of an environment the renderer may patch through `update-environment`.
 *
 * `endpoints` and `properties` REPLACE the whole map rather than merging into it, so removing
 * a key is expressible; send the complete map you want the environment to end up with.
 * Endpoint keys are interface *slugs*; unknown slugs are accepted (an environment may name a
 * deployment for an interface that has not been imported yet).
 */
export const environmentPatchSchema = z.object({
  name: z.string().optional(),
  endpoints: z.record(z.string(), z.string()).optional(),
  properties: z.record(z.string(), z.string()).optional(),
});
export type EnvironmentPatchWire = z.infer<typeof environmentPatchSchema>;

/**
 * One atomic change to the open project. Every mutation the renderer can make goes through
 * this union, so main stays the single writer of the model and of the folder on disk.
 */
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
    patch: z.object({ name: z.string().optional(), url: z.string().optional() }),
  }),
  z.object({ kind: z.literal('remove-endpoint'), interfaceId: z.string(), endpointId: z.string() }),
  z.object({ kind: z.literal('update-request-auth'), requestId: z.string(), auth: endpointAuthSchema.nullable() }),
  z.object({
    kind: z.literal('update-interface-auth'),
    interfaceId: z.string(),
    auth: endpointAuthSchema.nullable(),
  }),
  z.object({
    kind: z.literal('update-endpoint-auth'),
    interfaceId: z.string(),
    endpointId: z.string(),
    auth: endpointAuthSchema.nullable(),
  }),
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
]);
export type ProjectChange = z.infer<typeof projectChangeSchema>;

/** Request/response for `project.create`. */
export const projectCreateRequestSchema = z.object({ dir: z.string(), name: z.string() });
/** Request/response for `project.open`. */
export const projectOpenRequestSchema = z.object({ dir: z.string() });
/** Response for every channel that returns the whole project (or `null` when none is open). */
export const projectSnapshotResponseSchema = z.object({ project: projectWireSchema.nullable() });
export type ProjectSnapshotResponse = z.infer<typeof projectSnapshotResponseSchema>;

/** Request/response for `project.mutate`: the new snapshot plus any entity the change created. */
export const projectMutateRequestSchema = z.object({ change: projectChangeSchema });
export const projectMutateResponseSchema = z.object({
  project: projectWireSchema,
  /** Set by `add-request` and `clone-request`: the id of the request that was created. */
  createdRequestId: z.string().optional(),
  /** Set by `add-environment`: the id of the environment that was created. */
  createdEnvironmentId: z.string().optional(),
});
export type ProjectMutateResponse = z.infer<typeof projectMutateResponseSchema>;

/** Response for `project.save`. */
export const projectSaveResponseSchema = z.object({
  saved: z.boolean(),
  savedAt: z.string().optional(),
  written: z.number(),
  removed: z.number(),
});
export type ProjectSaveResult = z.infer<typeof projectSaveResponseSchema>;

/** One entry of the recent-projects list, most recent first. */
export const recentProjectSchema = z.object({
  dir: z.string(),
  name: z.string(),
  lastOpenedAt: z.string(),
  /** False when the folder no longer exists — shown disabled rather than silently dropped. */
  exists: z.boolean(),
});
export type RecentProject = z.infer<typeof recentProjectSchema>;

/** Response for `project.recent`. */
export const projectRecentResponseSchema = z.object({ recent: z.array(recentProjectSchema) });

/** Request/response for `project.addInterface`. */
export const projectAddInterfaceRequestSchema = z.object({
  source: importSourceSchema,
  auth: importAuthSchema.optional(),
  /** When true, the resolved auth is also saved on the interface for reuse when sending requests. */
  useForRequests: z.boolean().optional(),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export const projectAddInterfaceResponseSchema = z.object({
  project: projectWireSchema,
  interfaceId: z.string(),
});
export type ProjectAddInterfaceResponse = z.infer<typeof projectAddInterfaceResponseSchema>;

/** Payload for the `project.changed` event: the renderer replaces its mirror wholesale. */
export const projectChangedEventSchema = z.object({ project: projectWireSchema.nullable() });
export type ProjectChangedEvent = z.infer<typeof projectChangedEventSchema>;

/** Payload for the `project.changedOnDisk` event, raised by the folder watcher. */
export const projectChangedOnDiskEventSchema = z.object({ paths: z.array(z.string()) });
export type ProjectChangedOnDiskEvent = z.infer<typeof projectChangedOnDiskEventSchema>;

/** Payload for the `project.hydration` event: one interface's definition finished (re)loading. */
export const projectHydrationEventSchema = z.object({
  interfaceId: z.string(),
  status: hydrationStatusSchema,
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Global properties (Task 22): user-scoped `${#Global#name}` values, stored in
// Electron's `userData` rather than in any project folder.
// ---------------------------------------------------------------------------

/** A flat name -> value property map, as every property scope crosses the wire. */
export const propertyMapSchema = z.record(z.string(), z.string());
export type PropertyMapWire = z.infer<typeof propertyMapSchema>;

/** Response for every `globals.*` channel (and the `globals.changed` event): the whole map. */
export const globalsPropertiesResponseSchema = z.object({ properties: propertyMapSchema });
export type GlobalsPropertiesResponse = z.infer<typeof globalsPropertiesResponseSchema>;

/** Request payload for `globals.set`. */
export const globalsSetRequestSchema = z.object({ name: z.string(), value: z.string() });

/** Request payload for `globals.remove`. */
export const globalsRemoveRequestSchema = z.object({ name: z.string() });

// ---------------------------------------------------------------------------
// Secrets (Task 23): keychain-backed store. There is deliberately no `secrets.get`
// channel — the renderer can create/replace/check/delete/list refs, but can never
// read a value back; resolution happens only in main (`secret-resolver.ts`).
// ---------------------------------------------------------------------------

/** Request payload for `secrets.set`. */
export const secretsSetRequestSchema = z.object({ value: z.string(), label: z.string().optional() });
/** Response for `secrets.set` and `secrets.replace`: the ref the value is stored under. */
export const secretsRefResponseSchema = z.object({ ref: z.string() });

/** Request payload for `secrets.replace`. */
export const secretsReplaceRequestSchema = z.object({ ref: z.string(), value: z.string() });

/** Request payload for `secrets.exists`. */
export const secretsExistsRequestSchema = z.object({ ref: z.string() });
export const secretsExistsResponseSchema = z.object({ exists: z.boolean() });

/** Request payload for `secrets.delete`. */
export const secretsDeleteRequestSchema = z.object({ ref: z.string() });
export const secretsDeleteResponseSchema = z.object({ deleted: z.boolean() });

/** One entry as listed by `secrets.list` — never a value. */
export const secretListEntrySchema = z.object({ ref: z.string(), label: z.string().optional(), createdAt: z.string() });
export const secretsListResponseSchema = z.object({ entries: z.array(secretListEntrySchema) });
export type SecretListEntryWire = z.infer<typeof secretListEntrySchema>;

/** Request/response for `secrets.setShowSecrets` — a session-only, unpersisted flag. */
export const secretsSetShowSecretsRequestSchema = z.object({ show: z.boolean() });
export const secretsShowSecretsResponseSchema = z.object({ show: z.boolean() });

/** Request payload for `exchanges.get`: the send whose cached exchange to re-read. */
export const exchangesGetRequestSchema = z.object({ sendId: z.string() });
