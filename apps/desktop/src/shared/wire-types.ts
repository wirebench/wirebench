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

/**
 * One `mime:content` an operation's `mime:multipartRelated` input declares — mirrors the
 * engine's `MimePartInfo`. Drives the "Part" column of the attachments table.
 */
export const mimePartWireSchema = z.object({ part: z.string(), type: z.string().optional() });
export type MimePartWire = z.infer<typeof mimePartWireSchema>;

const operationSummaryWireSchema = z.object({
  name: z.string(),
  binding: z.string(),
  bindingLocal: z.string(),
  soapVersion: soapVersionSchema,
  soapAction: z.string().optional(),
  style: z.enum(['document', 'rpc']),
  documentation: z.string().optional(),
  ports: z.array(operationPortRefSchema),
  /**
   * The attachment slots the binding declares for this operation's input; empty for a plain
   * `soap:body`. `.default([])` is parse-time tolerance only — a summary payload produced by an
   * older build (or a stub in a test) that omits the field parses as `[]` instead of failing —
   * and `z.infer` still yields a required array, so every reader can index it unconditionally.
   */
  inputMimeParts: z.array(mimePartWireSchema).default([]),
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
  encoding: z.string().optional(),
  followRedirects: z.boolean().optional(),
  maxSizeBytes: z.number().optional(),
  skipSoapAction: z.boolean().optional(),
  /** Local interface address to bind the outgoing socket to (the request's "Bind Address"). */
  localAddress: z.string().optional(),
  /** Compress the request body before sending it. */
  compressBody: z.literal('gzip').optional(),
  /** XML-escape substituted property values inside the envelope. */
  entitize: z.boolean().optional(),
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

/** Request payload for `request.recreate` — SoapUI's "Recreate Request", applied to a saved request. */
export const requestRecreateRequestSchema = z.object({
  requestId: z.string(),
  /** Copy matching leaf values out of the current envelope into the regenerated structure. */
  keepValues: z.boolean(),
  /** Keep the current `<soapenv:Header>` block verbatim. */
  keepHeaders: z.boolean(),
  /** Build an empty envelope instead of a sample one; skips the merge entirely. */
  empty: z.boolean(),
});
export type RequestRecreateRequest = z.infer<typeof requestRecreateRequestSchema>;

/** Response payload for `request.recreate`: the saved envelope plus what the merge did. */
export const requestRecreateResponseSchema = z.object({
  envelopeXml: z.string(),
  kept: z.number(),
  added: z.number(),
  removed: z.number(),
});
export type RequestRecreateResponse = z.infer<typeof requestRecreateResponseSchema>;

/** Request payload for `request.curl`: which saved request, and which shell's quoting. */
export const requestCurlRequestSchema = z.object({
  requestId: z.string(),
  shell: z.enum(['posix', 'powershell']),
});
export type RequestCurlRequest = z.infer<typeof requestCurlRequestSchema>;

/** Response payload for `request.curl`. Secret-bearing headers are masked unless show-secrets is on. */
export const requestCurlResponseSchema = z.object({ command: z.string() });
export type RequestCurlResponse = z.infer<typeof requestCurlResponseSchema>;

/** Request payload for `request.importCurl`: a pasted command, and the operation to hang it off. */
export const requestImportCurlRequestSchema = z.object({
  command: z.string(),
  interfaceId: z.string(),
  /** Clark-notation binding QName: `{namespaceUri}localName`. */
  bindingName: z.string(),
  operationName: z.string(),
  name: z.string().optional(),
});
export type RequestImportCurlRequest = z.infer<typeof requestImportCurlRequestSchema>;

/** Response payload for `request.importCurl`: the new request, and anything the parse dropped. */
export const requestImportCurlResponseSchema = z.object({
  requestId: z.string(),
  problems: z.array(z.string()),
});
export type RequestImportCurlResponse = z.infer<typeof requestImportCurlResponseSchema>;

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

/** Wire projection of one certificate in the peer chain — see the engine's `PeerCert`. */
export const peerCertWireSchema = z.object({
  /** Distinguished name, rendered `CN=…, O=…`. */
  subject: z.string(),
  issuer: z.string(),
  /** ISO 8601, or the certificate's own text when it could not be parsed. */
  validFrom: z.string(),
  validTo: z.string(),
  serialNumber: z.string().optional(),
  /** Subject alternative names, type prefix (`DNS:`/`IP Address:`) stripped. */
  sans: z.array(z.string()),
  /** SHA-256 fingerprint as 64 lower-case hex characters. */
  fingerprint256: z.string(),
  isCA: z.boolean().optional(),
});
export type PeerCertWire = z.infer<typeof peerCertWireSchema>;

/** Wire projection of the engine's `SslInfo`: everything the SSL Info inspector shows. */
export const tlsInfoWireSchema = z.object({
  protocol: z.string().optional(),
  cipher: z.string().optional(),
  authorized: z.boolean().optional(),
  authorizationError: z.string().optional(),
  servername: z.string().optional(),
  peerChain: z.array(peerCertWireSchema),
  alpn: z.string().optional(),
});
export type SslInfoWire = z.infer<typeof tlsInfoWireSchema>;

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

/**
 * One attachment part of a response, as listed for the renderer. The bytes NEVER cross IPC:
 * they stay in main's `ExchangeCache`, addressed by `sendId` + `index`, and reach disk only
 * through `attachments.saveResponse` / `attachments.openResponse`.
 */
export const responseAttachmentWireSchema = z.object({
  /** Position in `SoapExchange.response.attachments`; the handle the `attachments.*` channels take. */
  index: z.number(),
  /** MIME Content-ID, without the angle brackets. */
  contentId: z.string(),
  contentType: z.string(),
  size: z.number(),
  name: z.string().optional(),
});
export type ResponseAttachmentWire = z.infer<typeof responseAttachmentWireSchema>;

const soapResponseWireSchema = z.object({
  envelopeXml: z.string(),
  version: z.enum(['1.1', '1.2']).optional(),
  isSoap: z.boolean(),
  fault: faultWireSchema.optional(),
  /**
   * `.default([])` is parse-time tolerance for a response payload written by an older build;
   * `z.infer` still yields a required array. It is NOT what makes an old history entry load —
   * a history row has its own response shape (see `historyEntrySchema`), which has no
   * attachments field at all.
   */
  attachments: z.array(responseAttachmentWireSchema).default([]),
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

/** Request/response for `dialogs.saveFile`: a native Save-as picker returning the chosen path. */
export const dialogsSaveFileRequestSchema = z.object({
  filters: z.array(dialogFilterSchema).optional(),
  title: z.string().optional(),
  defaultPath: z.string().optional(),
});
export const dialogsSaveFileResponseSchema = z.object({ path: z.string().optional() });

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

/**
 * The per-request knobs of the Details panel (§6.3): transport, envelope transforms, MTOM
 * flags and the WS-Security defaults. Mirrors the engine's `RequestProperties` one for one.
 */
export const requestPropertiesSchema = z.object({
  encoding: z.string(),
  timeoutMs: z.number().optional(),
  bindAddress: z.string().optional(),
  followRedirects: z.boolean(),
  skipSoapAction: z.boolean(),
  enableMtom: z.boolean(),
  forceMtom: z.boolean(),
  inlineResponseAttachments: z.boolean(),
  expandMtomAttachments: z.boolean(),
  disableMultiparts: z.boolean(),
  encodeAttachments: z.boolean(),
  enableInlineFiles: z.boolean(),
  removeEmptyContent: z.boolean(),
  entitizeProperties: z.boolean(),
  prettyPrint: z.boolean(),
  stripWhitespaces: z.boolean(),
  dumpFile: z.string().optional(),
  maxSizeBytes: z.number().optional(),
  wssPasswordType: z.enum(['text', 'digest']).optional(),
  wssTimeToLive: z.number().optional(),
  /** Name of a `wss/keystores/<name>.yaml` client keystore. Stored only; selection arrives with Task 36. */
  sslKeystoreRef: z.string().optional(),
});
export type RequestPropertiesWire = z.infer<typeof requestPropertiesSchema>;

/**
 * A patch over {@link requestPropertiesSchema}: every field optional, and every optional field
 * additionally nullable so "clear this back to inherit" is expressible (a `null` removes it).
 */
export const requestPropertiesPatchSchema = z.object({
  encoding: z.string().optional(),
  timeoutMs: z.number().nullable().optional(),
  bindAddress: z.string().nullable().optional(),
  followRedirects: z.boolean().optional(),
  skipSoapAction: z.boolean().optional(),
  enableMtom: z.boolean().optional(),
  forceMtom: z.boolean().optional(),
  inlineResponseAttachments: z.boolean().optional(),
  expandMtomAttachments: z.boolean().optional(),
  disableMultiparts: z.boolean().optional(),
  encodeAttachments: z.boolean().optional(),
  enableInlineFiles: z.boolean().optional(),
  removeEmptyContent: z.boolean().optional(),
  entitizeProperties: z.boolean().optional(),
  prettyPrint: z.boolean().optional(),
  stripWhitespaces: z.boolean().optional(),
  dumpFile: z.string().nullable().optional(),
  maxSizeBytes: z.number().nullable().optional(),
  wssPasswordType: z.enum(['text', 'digest']).nullable().optional(),
  wssTimeToLive: z.number().nullable().optional(),
  sslKeystoreRef: z.string().nullable().optional(),
});
export type RequestPropertiesPatchWire = z.infer<typeof requestPropertiesPatchSchema>;

/** Project-wide settings, as mirrored by the renderer. */
export const projectSettingsSchema = z.object({
  cacheDefinitions: z.boolean(),
  defaultTimeoutMs: z.number(),
  resourceRoot: z.string().optional(),
  prettyPrintResponses: z.boolean(),
});
export type ProjectSettingsWire = z.infer<typeof projectSettingsSchema>;

/** The fields of {@link projectSettingsSchema} the renderer may patch. */
export const projectSettingsPatchSchema = z.object({
  cacheDefinitions: z.boolean().optional(),
  defaultTimeoutMs: z.number().optional(),
  resourceRoot: z.string().nullable().optional(),
  prettyPrintResponses: z.boolean().optional(),
});
export type ProjectSettingsPatchWire = z.infer<typeof projectSettingsPatchSchema>;

/** Where an attachment's bytes live — mirrors the engine's `AttachmentSource` exactly. */
export const attachmentSourceWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cache'), sha256: z.string() }),
  z.object({ kind: z.literal('path'), path: z.string() }),
]);
export type AttachmentSourceWire = z.infer<typeof attachmentSourceWireSchema>;

/** How an attachment is carried on the wire — mirrors the engine's `AttachmentType`. */
export const attachmentTypeSchema = z.enum(['XOP', 'MIME', 'SWAREF', 'CONTENT', 'UNKNOWN']);
export type AttachmentTypeWire = z.infer<typeof attachmentTypeSchema>;

/**
 * One attachment of a saved request — mirrors the engine's `Attachment` field for field. Bytes
 * are never held here (nor anywhere in the renderer): `source` says where main can read them.
 */
export const attachmentWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  /** The WSDL `mime:part` this attachment fills, when the binding names one. */
  part: z.string().optional(),
  type: attachmentTypeSchema,
  /** MIME Content-ID, without the angle brackets. */
  contentId: z.string(),
  cached: z.boolean(),
  source: attachmentSourceWireSchema,
});
export type AttachmentWire = z.infer<typeof attachmentWireSchema>;

/**
 * The fields of an attachment the renderer may patch through `update-attachment`. `part: null`
 * clears the WSDL part binding back to "none" (the codebase's "unset this" convention).
 */
export const attachmentPatchSchema = z.object({
  name: z.string().optional(),
  contentType: z.string().optional(),
  contentId: z.string().optional(),
  type: attachmentTypeSchema.optional(),
  part: z.string().nullable().optional(),
});
export type AttachmentPatchWire = z.infer<typeof attachmentPatchSchema>;

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
  description: z.string().optional(),
  /** Read-only until Task 41 wires up editing; `enabled` is the only field the Details grid shows. */
  wsa: z.object({ enabled: z.boolean(), version: z.enum(['2005/08', '2004/08']).optional() }).optional(),
  /**
   * `.default([])` is parse-time tolerance for a `ProjectWire` snapshot built by an older build
   * (or by a stub in a test) that omits the field; `z.infer` still yields a required array. It
   * is NOT what makes an old project file load — those go through the engine's
   * `requestFileSchema`, which requires the field.
   */
  attachments: z.array(attachmentWireSchema).default([]),
  properties: requestPropertiesSchema,
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
  settings: projectSettingsSchema,
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
  description: z.string().nullable().optional(),
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
  z.object({
    kind: z.literal('update-request-properties'),
    requestId: z.string(),
    patch: requestPropertiesPatchSchema,
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
  /** Set by `add-attachment`: the id of the attachment that was created. */
  createdAttachmentId: z.string().optional(),
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

// ---------------------------------------------------------------------------
// History (Task 24): a persistent, per-project record of every send, kept in
// `userData` (outside the project folder) and always stored redacted.
// ---------------------------------------------------------------------------

const historyFaultSchema = z.object({ code: z.string(), reason: z.string() });
const historyErrorSchema = z.object({ code: z.string(), message: z.string() });

/** Wire (and on-disk) shape of one recorded send — mirrors the engine's `HistoryEntry`. */
export const historyEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  projectId: z.string(),
  requestId: z.string().optional(),
  requestName: z.string(),
  interfaceName: z.string(),
  operationName: z.string(),
  endpoint: z.string(),
  soapVersion: soapVersionSchema,
  soapAction: z.string().optional(),
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
  sizeBytes: z.number(),
  tags: z.array(z.string()).optional(),
});
export type HistoryEntryWire = z.infer<typeof historyEntrySchema>;

/** Request payload for `history.list`. */
export const historyListRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().optional(),
  before: z.string().optional(),
});
export const historyListResponseSchema = z.object({ entries: z.array(historyEntrySchema), total: z.number() });

/** Request/response for `history.get`. */
export const historyGetRequestSchema = z.object({ id: z.string() });
export const historyGetResponseSchema = z.object({ entry: historyEntrySchema.optional() });

/** Response for `history.clear`. */
export const historyClearResponseSchema = z.object({ cleared: z.number() });

/** Request payload for `history.resend`: re-sends a past entry through the normal send path. */
export const historyResendRequestSchema = z.object({ id: z.string() });

/** Payload for the `history.appended` event: one new entry, for the History view to prepend. */
export const historyAppendedEventSchema = z.object({ entry: historyEntrySchema });
export type HistoryAppendedEvent = z.infer<typeof historyAppendedEventSchema>;

// ---------------------------------------------------------------------------
// XML editor (Task 25): schema-driven completion and "go to declaration",
// backed by the interface's in-memory `SchemaSet`.
// ---------------------------------------------------------------------------

/** Request payload shared by `xml.completions` and `xml.declaration`: a path of Clark-notation QNames. */
export const xmlPathRequestSchema = z.object({
  interfaceId: z.string(),
  path: z.array(z.string()),
});

/** Request payload for `xml.completions`: the ancestor path plus what the user has typed so far. */
export const xmlCompletionsRequestSchema = xmlPathRequestSchema.extend({
  partial: z.string().optional(),
});

/** One candidate child element for the completion provider. */
export const xmlCompletionItemSchema = z.object({
  name: z.string(),
  namespaceUri: z.string(),
  documentation: z.string().optional(),
});
export const xmlCompletionsResponseSchema = z.object({ items: z.array(xmlCompletionItemSchema) });

/** Response for `xml.declaration`: where the element was declared in the schema, or `null` when unresolvable. */
export const xmlDeclarationResponseSchema = z
  .object({
    location: z.string(),
    line: z.number().optional(),
    column: z.number().optional(),
  })
  .nullable();

/**
 * Request payload for `xml.describeMany` (Task 26): a batch of ancestor paths — each a chain of
 * Clark-notation QNames identifying one outline element — resolved together to avoid one IPC
 * round trip per visible tree row.
 */
export const xmlDescribeManyRequestSchema = z.object({
  interfaceId: z.string(),
  paths: z.array(z.array(z.string())),
});

/** One resolved schema description for the outline's Type column, or `null` when unresolvable. */
export const xmlDescribeItemSchema = z
  .object({
    typeName: z.string(),
    kind: z.enum(['element', 'attribute']),
    nillable: z.boolean().optional(),
    documentation: z.string().optional(),
  })
  .nullable();

/** Response for `xml.describeMany`: one result per input path, in the same order. */
export const xmlDescribeManyResponseSchema = z.object({
  results: z.array(xmlDescribeItemSchema),
});

// ---------------------------------------------------------------------------
// Form view (Task 27): the schema-driven form tree for a request's Body, plus
// the structural edits the view asks main to apply (a value edit never comes
// here — the renderer splices it into the text itself).
// ---------------------------------------------------------------------------

/** A half-open UTF-16 character range in the envelope text. */
export const textRangeSchema = z.object({ start: z.number(), end: z.number() });
export type TextRangeWire = z.infer<typeof textRangeSchema>;

/** How a form leaf should be edited; mirrors the engine's `FormValueBase`. */
export const formValueBaseSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'time',
  'dateTime',
  'binary',
  'other',
]);

/** A leaf's type, with the facets the view turns into an editor and hints. */
export interface FormTypeWire {
  readonly name: string;
  readonly base: z.infer<typeof formValueBaseSchema>;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly min?: string;
  readonly max?: string;
}

export const formTypeSchema = z.object({
  name: z.string(),
  base: formValueBaseSchema,
  enum: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  min: z.string().optional(),
  max: z.string().optional(),
});

/**
 * One node of the form tree. Recursive, so the shape is declared up front and
 * tied together with `z.lazy`; it mirrors the engine's `FormNode` exactly.
 */
export interface FormNodeWire {
  readonly id: string;
  readonly kind: 'field' | 'group' | 'choice' | 'repeat' | 'attribute' | 'any';
  readonly name: { readonly namespaceUri: string; readonly localName: string };
  readonly label: string;
  readonly required: boolean;
  readonly occurs: { readonly min: number; readonly max: number | 'unbounded' };
  readonly type?: FormTypeWire;
  readonly value?: string;
  readonly valueRange?: TextRangeWire;
  readonly present: boolean;
  readonly nillable?: boolean;
  readonly documentation?: string;
  readonly fixed?: string;
  readonly xsiType?: string;
  readonly namespaces?: Readonly<Record<string, string>>;
  readonly extraAttributes?: readonly { readonly name: string; readonly value: string }[];
  readonly comments?: readonly string[];
  readonly trailingComments?: readonly string[];
  readonly truncated?: boolean;
  readonly raw?: string;
  readonly children: readonly FormNodeWire[];
  readonly choice?: { readonly selected?: number };
  readonly repeat?: {
    readonly instances: readonly FormNodeWire[];
    readonly template: FormNodeWire;
    readonly canAdd: boolean;
    readonly canRemove: boolean;
  };
}

export const formNodeSchema: z.ZodType<FormNodeWire> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.enum(['field', 'group', 'choice', 'repeat', 'attribute', 'any']),
    name: z.object({ namespaceUri: z.string(), localName: z.string() }),
    label: z.string(),
    required: z.boolean(),
    occurs: z.object({ min: z.number(), max: z.union([z.number(), z.literal('unbounded')]) }),
    type: formTypeSchema.optional(),
    value: z.string().optional(),
    valueRange: textRangeSchema.optional(),
    present: z.boolean(),
    nillable: z.boolean().optional(),
    documentation: z.string().optional(),
    fixed: z.string().optional(),
    xsiType: z.string().optional(),
    namespaces: z.record(z.string(), z.string()).optional(),
    extraAttributes: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    comments: z.array(z.string()).optional(),
    trailingComments: z.array(z.string()).optional(),
    truncated: z.boolean().optional(),
    raw: z.string().optional(),
    children: z.array(formNodeSchema),
    choice: z.object({ selected: z.number().optional() }).optional(),
    repeat: z
      .object({
        instances: z.array(formNodeSchema),
        template: formNodeSchema,
        canAdd: z.boolean(),
        canRemove: z.boolean(),
      })
      .optional(),
  }),
) as z.ZodType<FormNodeWire>;

/** Which operation of which interface a form belongs to, plus the envelope it models. */
export const xmlFormRequestSchema = z.object({
  interfaceId: z.string(),
  /** Clark-notation binding QName. */
  bindingName: z.string(),
  operationName: z.string(),
  envelopeXml: z.string(),
});

/** Response for `xml.form`: the tree, the Body range to splice over, and what could not be modelled. */
export const xmlFormResponseSchema = z.object({
  root: formNodeSchema,
  bodyRange: textRangeSchema,
  problems: z.array(z.string()),
});

/** One structural change the Form view asks main to apply; mirrors the engine's `FormEdit`. */
export const formEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert-optional'), nodeId: z.string() }),
  z.object({ kind: z.literal('remove-optional'), nodeId: z.string() }),
  z.object({ kind: z.literal('add-repeat'), nodeId: z.string() }),
  z.object({ kind: z.literal('remove-repeat'), nodeId: z.string(), index: z.number() }),
  z.object({ kind: z.literal('select-choice'), nodeId: z.string(), index: z.number() }),
  z.object({ kind: z.literal('set-value'), nodeId: z.string(), value: z.string() }),
]);
export type FormEditWire = z.infer<typeof formEditSchema>;

export const xmlApplyFormEditRequestSchema = xmlFormRequestSchema.extend({ edit: formEditSchema });

/** Response for `xml.applyFormEdit`: the whole new envelope plus the range that changed. */
export const xmlApplyFormEditResponseSchema = z.object({
  envelopeXml: z.string(),
  changedRange: textRangeSchema,
});

// ---------------------------------------------------------------------------
// File dialogs for arbitrary text (Task 25): Save as… / Load from… on the
// request editor, separate from `dialogs.*`'s open-file/open-folder pickers
// because these round-trip file *content*, not just a chosen path.
// ---------------------------------------------------------------------------

/** Request payload for `fs.saveText`. */
export const fsSaveTextRequestSchema = z.object({
  defaultName: z.string().optional(),
  text: z.string(),
});
export const fsSaveTextResponseSchema = z.object({ path: z.string().optional() });

/** Request payload for `fs.openText`. */
export const fsOpenTextRequestSchema = z.object({
  filters: z.array(dialogFilterSchema).optional(),
});
export const fsOpenTextResponseSchema = z.object({ path: z.string().optional(), text: z.string().optional() });

// ---------------------------------------------------------------------------
// Attachments (Task 33a): the file-side operations the attachments inspector
// needs. Bytes never cross IPC — every one of these moves them within main.
// ---------------------------------------------------------------------------

/**
 * Request payload for `attachments.saveResponse`: a handle, and deliberately nothing else.
 *
 * There is no `path` field on purpose. These are bytes a remote server sent, so the file they
 * land in is always chosen by the user through the native Save-as dialog (or by
 * `WIREBENCH_E2E_SAVE_PATH` in a test build) — exactly as `fs.saveText` works. A renderer that
 * could name the target could write server-controlled content anywhere the user can write.
 */
export const attachmentsSaveResponseRequestSchema = z.object({
  sendId: z.string(),
  index: z.number(),
});
/** Response for `attachments.saveResponse`: the file written, or `cancelled` when the user backed out. */
export const attachmentsSaveResponseResponseSchema = z.object({
  path: z.string().optional(),
  cancelled: z.boolean().optional(),
});
export type AttachmentsSaveResponseResult = z.infer<typeof attachmentsSaveResponseResponseSchema>;

/** Request payload for `attachments.openResponse`. */
export const attachmentsOpenResponseRequestSchema = z.object({ sendId: z.string(), index: z.number() });

/** Request payload for `attachments.openRequest`. */
export const attachmentsOpenRequestRequestSchema = z.object({ requestId: z.string(), attachmentId: z.string() });

/** Response for both `attachments.openResponse` and `attachments.openRequest`: the path handed to the OS. */
export const attachmentsOpenResponseSchema = z.object({ path: z.string() });

/** Request/response for `attachments.pickFiles`: a multi-select Add-attachments dialog. */
export const attachmentsPickFilesRequestSchema = z.object({});
export const attachmentsPickFilesResponseSchema = z.object({ paths: z.array(z.string()) });

// ---------------------------------------------------------------------------
// XPath 3.1 / XQuery 3.1 scratchpad (Task 28): evaluated in main so the
// renderer never bundles `fontoxpath`.
// ---------------------------------------------------------------------------

/** Request payload for `xpath.evaluate`. Mirrors the engine's `EvaluateOptions`. */
export const xpathEvaluateRequestSchema = z.object({
  xml: z.string(),
  expression: z.string(),
  language: z.enum(['xpath', 'xquery']),
  namespaces: z.record(z.string(), z.string()).optional(),
});

/** One node-shaped result item; mirrors the engine's `QueryNodeItem`. */
const xpathQueryNodeItemSchema = z.object({
  text: z.string(),
  nodeKind: z.enum(['element', 'attribute', 'text', 'document', 'comment', 'pi']),
  range: textRangeSchema.optional(),
  path: z.string(),
});

/** One atomic-value result item; mirrors the engine's `QueryValueItem`. */
const xpathQueryValueItemSchema = z.object({ text: z.string(), type: z.string() });

/** Response for `xpath.evaluate`; mirrors the engine's `QueryResult`. */
export const xpathEvaluateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nodes'), items: z.array(xpathQueryNodeItemSchema), truncated: z.boolean() }),
  z.object({ kind: z.literal('values'), items: z.array(xpathQueryValueItemSchema), truncated: z.boolean() }),
  z.object({ kind: z.literal('empty') }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
    position: z.object({ line: z.number(), column: z.number() }).optional(),
  }),
]);
export type XpathEvaluateResponseWire = z.infer<typeof xpathEvaluateResponseSchema>;

/** Request payload for `xpath.namespaces`. */
export const xpathNamespacesRequestSchema = z.object({ xml: z.string() });

/** Response for `xpath.namespaces`: in-scope bindings, plus suggestions for unbound URIs. */
export const xpathNamespacesResponseSchema = z.object({
  namespaces: z.record(z.string(), z.string()),
  suggestions: z.record(z.string(), z.string()),
});

// ---------------------------------------------------------------------------
// Preferences (Task 30): user-scoped settings, persisted in `userData`.
// ---------------------------------------------------------------------------

/**
 * The whole preferences document, mirroring the engine's `Preferences`. Sections whose
 * behaviour lands in a later task (`proxy`, `ssl`, `shortcuts`) are still carried here, so a
 * file written today survives those tasks unchanged.
 */
export const preferencesWireSchema = z.object({
  http: z.object({
    version: z.literal('1.1'),
    userAgent: z.string(),
    requestCompression: z.enum(['none', 'gzip']),
    responseCompression: z.boolean(),
    closeConnections: z.boolean(),
    chunkingThreshold: z.number(),
    socketTimeoutMs: z.number(),
    maxConnections: z.number(),
  }),
  proxy: z.object({
    mode: z.enum(['none', 'system', 'manual']),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    passwordRef: z.string().optional(),
    excludes: z.array(z.string()),
  }),
  ssl: z.object({
    minVersion: z.enum(['TLSv1.2', 'TLSv1.3']),
    caBundlePath: z.string().optional(),
    clientKeystoreRef: z.string().optional(),
    trustAll: z.literal(false),
  }),
  wsdl: z.object({
    cacheDefinitions: z.boolean(),
    prettyPrint: z.boolean(),
    sampleValues: z.boolean(),
    typeComments: z.boolean(),
    includeOptional: z.boolean(),
    strictSchema: z.boolean(),
    compression: z.boolean(),
    nameWithBinding: z.boolean(),
  }),
  wsi: z.object({ verbose: z.boolean(), profile: z.literal('BP1.1') }),
  editor: z.object({
    fontFamily: z.string().optional(),
    fontSize: z.number(),
    tabSize: z.number(),
    lineNumbers: z.boolean(),
    wordWrap: z.boolean(),
    autoValidateOnSend: z.boolean(),
    autoFormatResponses: z.boolean(),
  }),
  ui: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    defaultLayout: z.object({
      orientation: z.enum(['side-by-side', 'stacked']),
      mode: z.enum(['split', 'tabs']),
    }),
    confirmOnDelete: z.boolean(),
    historyCap: z.number(),
  }),
  shortcuts: z.record(z.string(), z.string()),
});
export type PreferencesWire = z.infer<typeof preferencesWireSchema>;

/** The section names `preferences.reset` accepts. */
export const preferencesSectionSchema = z.enum(['http', 'proxy', 'ssl', 'wsdl', 'wsi', 'editor', 'ui', 'shortcuts']);
export type PreferencesSectionWire = z.infer<typeof preferencesSectionSchema>;

/**
 * A partial preferences document. Deliberately loose (`z.unknown()` per section, merged and
 * validated by the engine's `mergePreferences`) so the renderer can send one field without
 * restating a whole section, and so an unknown key is ignored rather than rejected.
 */
export const preferencesPatchWireSchema = z.object({
  http: z.record(z.string(), z.unknown()).optional(),
  proxy: z.record(z.string(), z.unknown()).optional(),
  ssl: z.record(z.string(), z.unknown()).optional(),
  wsdl: z.record(z.string(), z.unknown()).optional(),
  wsi: z.record(z.string(), z.unknown()).optional(),
  editor: z.record(z.string(), z.unknown()).optional(),
  ui: z.record(z.string(), z.unknown()).optional(),
  shortcuts: z.record(z.string(), z.string()).optional(),
});
export type PreferencesPatchWire = z.infer<typeof preferencesPatchWireSchema>;

/** Response for every `preferences.*` channel, and the payload of `preferences.changed`. */
export const preferencesResponseSchema = z.object({ preferences: preferencesWireSchema });
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

/** Request payload for `preferences.update`. */
export const preferencesUpdateRequestSchema = z.object({ patch: preferencesPatchWireSchema });
/** Request payload for `preferences.reset`. */
export const preferencesResetRequestSchema = z.object({ section: preferencesSectionSchema.optional() });

/**
 * The largest single file a drag-and-drop may add (32 MiB).
 *
 * Dropped bytes cross IPC base64-encoded and are held in memory on both sides, so an unbounded
 * drop is an easy way to wedge the app. Adding a bigger file through the Add… picker is
 * unaffected: that path streams from disk and never crosses the bridge. This is the single
 * source of truth for the cap — the renderer's drop handler, the `addDropped` request schema,
 * and `ProjectService.addAttachmentBytes`'s decoded-length check all read it from here.
 */
export const MAX_DROPPED_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/**
 * The longest a dropped file's base64 payload may be: `MAX_DROPPED_ATTACHMENT_BYTES` encoded,
 * plus the few bytes of padding base64 can add. Bounding this in the request schema means an
 * oversized drop is refused before `addDropped` ever decodes it.
 */
export const MAX_DROPPED_BASE64_LENGTH = Math.ceil((MAX_DROPPED_ATTACHMENT_BYTES * 4) / 3) + 4;

/** The most files a single drop may add — an editing-sanity bound, not a product limit. */
export const MAX_DROPPED_FILES = 32;

/**
 * Request payload for `attachments.addDropped`: the *bytes* of files dropped onto the
 * attachments inspector, never their paths.
 *
 * An OS drag-and-drop leaves no evidence in main that the user picked those files, so a channel
 * that accepted a path would let any renderer name any file and have main read it. The browser
 * sandbox, by contrast, only hands the page the bytes of files the user actually dropped — so
 * those bytes are the evidence, and they are what crosses the bridge (base64, since the IPC
 * contract is JSON-shaped).
 */
export const attachmentsAddDroppedRequestSchema = z.object({
  requestId: z.string(),
  files: z
    .array(
      z.object({
        name: z.string(),
        /** The browser's sniffed media type; empty when it could not tell, so main falls back. */
        contentType: z.string(),
        bytesBase64: z.string().max(MAX_DROPPED_BASE64_LENGTH),
      }),
    )
    .max(MAX_DROPPED_FILES),
});
export type AttachmentsAddDroppedRequest = z.infer<typeof attachmentsAddDroppedRequestSchema>;

/** Response for `attachments.addDropped`: the new attachment ids, in the order dropped. */
export const attachmentsAddDroppedResponseSchema = z.object({ attachmentIds: z.array(z.string()) });
