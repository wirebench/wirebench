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

/** The longest URL/path an import source may carry — well past any real one, and bounded. */
export const MAX_IMPORT_LOCATION_CHARS = 4096;
/** Longest pasted OpenAPI or Postman document an import accepts, in characters. */
export const MAX_IMPORT_TEXT_CHARS = 50_000_000;
/** Longest name override an OpenAPI or Postman import accepts. */
export const MAX_IMPORT_NAME_CHARS = 200;

/**
 * Where a WSDL definition comes from — mirrors the engine's `ImportSource`.
 *
 * A `file` path is *not* authorized by passing this schema: main additionally requires it to
 * be inside the open project folder or to have been picked through the Browse… dialog this
 * session (see `main/ipc/definition.ts`). The drop zone in the import dialog reads the file in
 * the renderer and sends `text` instead, precisely because a drop is not a pick.
 */
export const importSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    location: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  }),
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
 * A WS-Addressing configuration, at interface or request level. Mirrors the engine's
 * `WsaConfig`; every field past `enabled` is optional so a snapshot from an older build (which
 * only ever carried `{ enabled, version? }`) still parses, and so a request-level override can
 * name only the fields it actually changes.
 */
export const wsaConfigWireSchema = z.object({
  enabled: z.boolean(),
  version: z.enum(['2005/08', '2004/08']).optional(),
  mustUnderstand: z.enum(['none', 'true', 'false']).optional(),
  action: z.string().optional(),
  to: z.string().optional(),
  /** The literal `auto` mints a fresh `urn:uuid:` per send; anything else is sent verbatim. */
  messageId: z.string().optional(),
  replyTo: z.string().optional(),
  from: z.string().optional(),
  faultTo: z.string().optional(),
  relatesTo: z.string().optional(),
  relationshipType: z.string().optional(),
  addDefaultAction: z.boolean().optional(),
  addDefaultTo: z.boolean().optional(),
  generateMessageId: z.boolean().optional(),
});
export type WsaConfigWire = z.infer<typeof wsaConfigWireSchema>;

/** What an import found out about WS-Addressing; mirrors the engine's `WsaSummary`. */
export const wsaSummaryWireSchema = z.object({
  enabled: z.boolean(),
  /** True when no binding requires addressing but at least one only offers it (`wsp:Optional`). */
  optional: z.boolean().optional(),
  version: z.enum(['2005/08', '2004/08']),
  defaultActionByOperation: z.record(z.string(), z.string()),
});
export type WsaSummaryWire = z.infer<typeof wsaSummaryWireSchema>;

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
  /**
   * Epoch milliseconds at which main loaded this definition into memory. Absent for a summary
   * built by a stub or for an interface whose definition has not been hydrated yet; when it
   * changes, every cached projection of the definition in the renderer is stale.
   */
  loadedAt: z.number().optional(),
  /** What the WSDL says about WS-Addressing; absent in a summary built by a stub. */
  wsa: wsaSummaryWireSchema.optional(),
});
export type InterfaceSummary = z.infer<typeof interfaceSummarySchema>;
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;
export type PortSummary = z.infer<typeof portSummarySchema>;
export type OperationSummaryWire = z.infer<typeof operationSummaryWireSchema>;

/** Request/response for `definition.close`. */
export const definitionCloseRequestSchema = z.object({ interfaceId: z.string() });
export const definitionCloseResponseSchema = z.object({ closed: z.boolean() });

/** Request payload for `definition.documents`, `definition.schemaIndex`. */
export const definitionInterfaceRequestSchema = z.object({ interfaceId: z.string() });

/**
 * One document of an imported definition's bundle — its identity and size only. The text is a
 * separate, per-document call (`definition.documentText`) so listing a large import graph never
 * puts every byte of it on the wire at once.
 */
export const definitionDocumentWireSchema = z.object({
  location: z.string(),
  kind: z.enum(['wsdl', 'xsd']),
  /** Byte length of the document as fetched. */
  size: z.number(),
  /** The document's `targetNamespace`, when it declares one. */
  namespace: z.string().optional(),
});
export type DefinitionDocumentWire = z.infer<typeof definitionDocumentWireSchema>;

/** Response payload for `definition.documents`: the bundle in discovery order, root first. */
export const definitionDocumentsResponseSchema = z.object({
  documents: z.array(definitionDocumentWireSchema),
  /** Epoch milliseconds at which main last loaded this definition into memory. */
  loadedAt: z.number(),
});
export type DefinitionDocumentsResponse = z.infer<typeof definitionDocumentsResponseSchema>;

/** The largest document text `definition.documentText` will serialise (8 MiB). */
export const MAX_DOCUMENT_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Request payload for `definition.documentText`. `location` is never a path the renderer made
 * up: main matches it against the bundle's own document locations and rejects anything else.
 */
export const definitionDocumentTextRequestSchema = z.object({
  interfaceId: z.string(),
  location: z.string().max(4096),
});
export type DefinitionDocumentTextRequest = z.infer<typeof definitionDocumentTextRequestSchema>;

/** Response payload for `definition.documentText`: one document's source, from main's cache. */
export const definitionDocumentTextResponseSchema = z.object({ text: z.string() });
export type DefinitionDocumentTextResponse = z.infer<typeof definitionDocumentTextResponseSchema>;

/** How an Update Definition names the definition to update from: a URL, or a user-picked file. */
export const definitionUpdateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
]);
export type DefinitionUpdateSource = z.infer<typeof definitionUpdateSourceSchema>;

/** Request payload for `definition.planUpdate` and `definition.applyUpdate`'s re-import. */
export const definitionPlanUpdateRequestSchema = z.object({
  interfaceId: z.string(),
  source: definitionUpdateSourceSchema,
});
export type DefinitionPlanUpdateRequest = z.infer<typeof definitionPlanUpdateRequestSchema>;

/** One operation of an update plan, as Clark-notation binding plus operation name. */
export const updateOperationWireSchema = z.object({ bindingName: z.string(), operationName: z.string() });

/** Why an operation is listed as changed; see the engine's `OperationChangeReason`. */
export const updateChangeReasonSchema = z.enum(['input-schema', 'output-schema', 'soap-action', 'style', 'binding']);

/** Response payload for `definition.planUpdate`: the preview the dialog shows before applying. */
export const definitionUpdatePlanResponseSchema = z.object({
  newOperations: z.array(updateOperationWireSchema),
  removedOperations: z.array(updateOperationWireSchema),
  changedOperations: z.array(z.object({ ref: updateOperationWireSchema, reason: updateChangeReasonSchema })),
  endpointsAdded: z.array(z.string()),
  endpointsRemoved: z.array(z.string()),
});
export type UpdatePlanWire = z.infer<typeof definitionUpdatePlanResponseSchema>;

/**
 * The checkbox state of the Update Definition dialog. `updateTestRequests` is a literal `false`:
 * the control exists and is disabled, so the wire keeps the field rather than pretending the
 * option is not there.
 */
export const definitionUpdateOptionsSchema = z.object({
  createNewRequests: z.boolean(),
  recreateRequests: z.boolean(),
  recreateOptional: z.boolean(),
  keepExisting: z.boolean(),
  keepSoapHeaders: z.boolean(),
  createBackups: z.boolean(),
  updateTestRequests: z.literal(false),
});
export type DefinitionUpdateOptions = z.infer<typeof definitionUpdateOptionsSchema>;

/** Request payload for `definition.applyUpdate`. */
export const definitionApplyUpdateRequestSchema = z.object({
  interfaceId: z.string(),
  source: definitionUpdateSourceSchema,
  options: definitionUpdateOptionsSchema,
});
export type DefinitionApplyUpdateRequest = z.infer<typeof definitionApplyUpdateRequestSchema>;

/** Request payload for `definition.export`: main runs the folder picker itself. */
export const definitionExportRequestSchema = z.object({ interfaceId: z.string() });

/** Response payload for `definition.export`: the folder written, or a user cancellation. */
export const definitionExportResponseSchema = z.object({
  dir: z.string().optional(),
  files: z.array(z.string()).default([]),
  cancelled: z.boolean(),
});
export type DefinitionExportResponse = z.infer<typeof definitionExportResponseSchema>;

/** Request payload for `definition.generateDocs`; main runs the save dialog and writes the file. */
export const definitionGenerateDocsRequestSchema = z.object({
  interfaceId: z.string(),
  format: z.enum(['html', 'markdown']),
});
export type DefinitionGenerateDocsRequest = z.infer<typeof definitionGenerateDocsRequestSchema>;

/** Response payload for `definition.generateDocs`: the file written, or a user cancellation. */
export const definitionGenerateDocsResponseSchema = z.object({
  path: z.string().optional(),
  cancelled: z.boolean(),
});
export type DefinitionGenerateDocsResponse = z.infer<typeof definitionGenerateDocsResponseSchema>;

/** Which kind of schema component a Schema-browser row (or a declaration lookup) points at. */
export const schemaComponentKindSchema = z.enum(['element', 'complexType', 'simpleType', 'group', 'attributeGroup']);
export type SchemaComponentKind = z.infer<typeof schemaComponentKindSchema>;

/** One named global schema component, with where it was declared. */
export const schemaComponentWireSchema = z.object({
  name: z.string(),
  /** Clark-notation type reference for an element; absent for an anonymous (inline) type. */
  typeName: z.string().optional(),
  /** Document location the component was declared in. */
  document: z.string(),
  line: z.number().optional(),
});
export type SchemaComponentWire = z.infer<typeof schemaComponentWireSchema>;

/** Every global component of one namespace, grouped by kind. */
export const schemaNamespaceWireSchema = z.object({
  uri: z.string(),
  elements: z.array(schemaComponentWireSchema),
  complexTypes: z.array(schemaComponentWireSchema),
  simpleTypes: z.array(schemaComponentWireSchema),
  groups: z.array(schemaComponentWireSchema),
  attributeGroups: z.array(schemaComponentWireSchema),
});
export type SchemaNamespaceWire = z.infer<typeof schemaNamespaceWireSchema>;

/** Response payload for `definition.schemaIndex`. */
export const definitionSchemaIndexResponseSchema = z.object({ namespaces: z.array(schemaNamespaceWireSchema) });
export type DefinitionSchemaIndexResponse = z.infer<typeof definitionSchemaIndexResponseSchema>;

/** The largest envelope `definition.declarationAt` will scan (2 MiB). */
export const MAX_ENVELOPE_XML_CHARS = 2 * 1024 * 1024;

/** Request payload for `definition.declarationAt`: a caret offset into one request envelope. */
export const definitionDeclarationAtRequestSchema = z.object({
  interfaceId: z.string(),
  envelopeXml: z.string().max(MAX_ENVELOPE_XML_CHARS),
  offset: z.number().int().nonnegative(),
});
export type DefinitionDeclarationAtRequest = z.infer<typeof definitionDeclarationAtRequestSchema>;

/** Response payload for `definition.declarationAt`: the declaration found, or `null`. */
export const definitionDeclarationAtResponseSchema = z
  .object({
    namespace: z.string(),
    name: z.string(),
    kind: schemaComponentKindSchema,
    document: z.string(),
    line: z.number().optional(),
  })
  .nullable();
export type DefinitionDeclarationAtResponse = z.infer<typeof definitionDeclarationAtResponseSchema>;

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

export const tlsOptionsSchema = z.object({
  rejectUnauthorized: z.boolean().optional(),
  ca: z.array(z.string()).optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  passphrase: z.string().optional(),
  minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).optional(),
  servername: z.string().optional(),
});

export type TlsOptionsWire = z.infer<typeof tlsOptionsSchema>;

/**
 * The TLS options a *send* may carry on the wire: the minimum protocol version, and nothing
 * else.
 *
 * Everything else about a handshake is main's to decide and the renderer's to never name —
 * trust anchors come from the CA-bundle preference (a file only main can point at, see
 * `ssl.pickCaBundle`), the client identity from the selected keystore, and `rejectUnauthorized`
 * only ever from an endpoint's `trustInvalid` flag. A renderer could otherwise turn
 * verification off for a single send with no trace anywhere in the project.
 *
 * `strictObject`, not a subset: a send naming `rejectUnauthorized` is *rejected* rather than
 * quietly stripped, so a bug on either side of the bridge is loud.
 */
export const sendTlsOptionsSchema = z.strictObject({
  minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).optional(),
});
export type SendTlsOptionsWire = z.infer<typeof sendTlsOptionsSchema>;

/**
 * The resolved proxy one send goes through. Main-only: it is built in `ProjectHost.proxyFor`
 * from the preferences plus the OS keychain and handed straight to the engine, and is NOT part
 * of `soapSendInputWireSchema` — a renderer must never be able to name a proxy, nor see the
 * password that reaching one needs.
 */
export const proxyOptionsSchema = z.object({
  url: z.string(),
  auth: z.object({ username: z.string(), password: z.string() }).optional(),
});
export type ProxyOptionsWire = z.infer<typeof proxyOptionsSchema>;

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
  tls: sendTlsOptionsSchema.optional(),
  /** Offer HTTP/2 in the ALPN handshake (the HTTP preference). Off unless explicitly set. */
  allowH2: z.boolean().optional(),
  /**
   * WS-Addressing for this send, present only when the effective configuration is enabled.
   * Pure data (no secret, no closure), so unlike WS-Security it rides on the send input the
   * renderer sees, and `request.curl`'s `effectiveSendInput` bakes its `wsa:*` headers into the
   * exported envelope the same way a send does (a `messageId: 'auto'` mints a one-off UUID for
   * the export, which will not match any real send's). The cURL export does *not* include
   * WS-Security (it needs secrets and a keystore the export never touches) or attachments (they
   * never travel on this wire shape at all, see `request.curl`'s "not included" note).
   */
  wsa: z.object({ config: wsaConfigWireSchema, defaultAction: z.string() }).optional(),
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
 * What the renderer is told about an OAuth2 token. Never the token itself unless the session's
 * show-secrets flag is on, and never a refresh token or a client secret at all.
 */
export const oauth2StatusSchema = z.object({
  state: z.enum(['none', 'valid', 'expired', 'pending']),
  expiresAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  token: z.string().optional(),
  /** The loopback URI the provider must have registered, for the inspector to show. */
  redirectUri: z.string(),
});
export type OAuth2StatusWire = z.infer<typeof oauth2StatusSchema>;

/**
 * Request payload for every `oauth2.*` call: the entity whose configuration to use — an API, a
 * folder or a request. Main reads the configuration from the model; the renderer never sends one,
 * because it would then be sending a client secret's reference around.
 */
export const oauth2OwnerRequestSchema = z.object({ ownerId: z.string() });

/** Request payload for `request.recreate` — "Recreate Request", applied to a saved request. */
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

/**
 * Where an imported cURL command lands: a SOAP operation, or a REST API and optionally a folder in it.
 *
 * A discriminated union rather than two channels, because the parse and the "what was dropped" report
 * are the same work either way — only the entity created at the end differs.
 */
export const requestImportCurlTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('soap'),
    interfaceId: z.string(),
    /** Clark-notation binding QName: `{namespaceUri}localName`. */
    bindingName: z.string(),
    operationName: z.string(),
  }),
  z.object({ kind: z.literal('rest'), apiId: z.string(), folderId: z.string().optional() }),
]);
export type RequestImportCurlTarget = z.infer<typeof requestImportCurlTargetSchema>;

/** Request payload for `request.importCurl`: a pasted command, and where to put what it describes. */
export const requestImportCurlRequestSchema = z.object({
  command: z.string(),
  target: requestImportCurlTargetSchema,
  name: z.string().optional(),
  /**
   * A keychain reference for a `-u` password the renderer already stored. The value itself never
   * crosses this wire: the dialog stores it through `secrets.set` and sends the reference (ADR-0004).
   */
  passwordRef: z.string().optional(),
});
export type RequestImportCurlRequest = z.infer<typeof requestImportCurlRequestSchema>;

/** Response payload for `request.importCurl`: the new request, and anything the parse dropped. */
export const requestImportCurlResponseSchema = z.object({
  requestId: z.string(),
  problems: z.array(z.string()),
  /**
   * The username a `-u` flag carried, when it had one. The dialog shows it so the user can see which
   * credential the request now expects, and knows to supply the password if they did not paste one.
   */
  basicUsername: z.string().optional(),
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
  /** The client identity this send presented, when a keystore supplied one. DNs only. */
  clientCertificate: z.object({ subject: z.string(), issuer: z.string() }).optional(),
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
  /** The protocol actually negotiated; labels the raw view. */
  httpVersion: z.enum(['1.1', '2']).default('1.1'),
  decodeError: z.string().optional(),
  timings: timingsWireSchema,
  redirects: z.array(redirectWireSchema),
  tls: tlsInfoWireSchema.optional(),
  request: httpRequestSummarySchema,
});
export type HttpExchangeWire = z.infer<typeof httpExchangeWireSchema>;

/**
 * A send that never produced a response, as the console's HTTP Log records it. Built in main
 * (`failed-exchange.ts`) from the same catch block that writes History, with `request.headers`
 * redacted once and for good: a failure is never held in the unredacted `ExchangeCache`, so the
 * show-secrets toggle cannot reveal them later, and the detail pane says so.
 */
export const failedExchangeWireSchema = z.object({
  /** The id the renderer generated for the send — the log dedupes on it. */
  sendId: z.string(),
  protocol: z.enum(['soap', 'rest', 'grpc']),
  /** Absent for an ad-hoc resend of an orphaned History entry. */
  requestId: z.string().optional(),
  /** The same shape as `httpExchangeWireSchema.request`; headers already redacted. */
  request: httpRequestSummarySchema,
  /**
   * The request as it was about to go on the wire, already redacted; absent when the failure came
   * before the transport built it (e.g. `invalid-url`) or from an older build.
   */
  rawRequestBase64: z.string().optional(),
  /** Wall-clock start, ISO 8601 — as `timingsWireSchema.startedAt`. */
  startedAt: z.string(),
  /** Start to failure. */
  durationMs: z.number(),
  /** The engine's `HttpErrorCode`, another `WirebenchError` code, or `internal-error`. */
  error: z.object({ code: z.string(), message: z.string() }),
  /**
   * Where the send failed. `prepare`: before the request was built (bad URL, OAuth2 token fetch,
   * proxy lookup) — it never went on the wire. Absent means `send`, so rows from before this field
   * existed stay valid.
   */
  stage: z.enum(['prepare', 'send']).optional(),
});
export type FailedExchangeWire = z.infer<typeof failedExchangeWireSchema>;

/** Payload for the `exchange.failed` event: one send that failed before a response arrived. */
export const exchangeFailedEventSchema = z.object({ failure: failedExchangeWireSchema });
export type ExchangeFailedEvent = z.infer<typeof exchangeFailedEventSchema>;

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
  'workspace-environment',
  'request-custom',
  'request-endpoint',
  'interface-default',
  'none',
]);
export type EndpointSourceWire = z.infer<typeof endpointSourceSchema>;

/**
 * Where the credentials a send would use come from, and what they look like without the
 * secret: the renderer needs to explain inheritance in the Auth inspector, and a password
 * never crosses IPC (only its `passwordRef` is ever stored, and that stays in main).
 */
export const requestAuthSourceSchema = z.object({
  /** `api` and `folder` are the REST chain's links; the rest are a SOAP request's. */
  source: z.enum(['request', 'endpoint', 'interface', 'folder', 'api', 'none']),
  type: z.enum(['none', 'basic', 'ntlm', 'bearer', 'api-key', 'oauth2']),
  username: z.string().optional(),
  preemptive: z.boolean().optional(),
  /** Name of the endpoint the credentials came from, when `source` is `'endpoint'`. */
  endpointName: z.string().optional(),
  /** The endpoint's auth mode, so the UI can say "override" or "complement". */
  authMode: z.enum(['override', 'complement']).optional(),
});
export type RequestAuthSourceWire = z.infer<typeof requestAuthSourceSchema>;

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
});
export type RequestPreflightResponse = z.infer<typeof requestPreflightResponseSchema>;

/** What authentication did during a send; mirrors the engine's `AuthSummary`. */
export const authSummaryWireSchema = z.object({
  scheme: z.enum(['basic', 'ntlm', 'bearer', 'api-key', 'oauth2']),
  challenged: z.boolean(),
  attempts: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export type AuthSummaryWire = z.infer<typeof authSummaryWireSchema>;

/**
 * One step of incoming WS-Security processing, as the response inspector lists it. Mirrors the
 * engine's `WssAction` exactly — booleans, a human-readable detail and the signer's subject.
 * No key material, no secret reference, nothing that could carry one.
 */
export const wssActionWireSchema = z.object({
  kind: z.enum(['decrypt', 'signature', 'timestamp']),
  ok: z.boolean(),
  detail: z.string(),
  signerSubject: z.string().optional(),
  trusted: z.boolean().optional(),
  created: z.string().optional(),
  expires: z.string().optional(),
  /** Names of the parts a signature covered (`Body`, `Timestamp`, …); signature actions only. */
  references: z.array(z.string()).optional(),
  coversBody: z.boolean().optional(),
});
export type WssActionWire = z.infer<typeof wssActionWireSchema>;

/** What WS-Security did during a send; mirrors the engine's `SoapExchange.wss`. */
export const wssExchangeWireSchema = z.object({
  /** The entry kinds applied to the outgoing envelope, in the order they were applied. */
  applied: z.array(z.string()).optional(),
  /** What incoming processing made of the response. */
  incoming: z
    .object({
      actions: z.array(wssActionWireSchema),
      errors: z.array(z.string()),
    })
    .optional(),
});
export type WssExchangeWire = z.infer<typeof wssExchangeWireSchema>;

/** Response payload for `request.send`: a JSON-serialisable projection of `SoapExchange`. */
export const exchangeSummarySchema = z.object({
  sendId: z.string(),
  durationMs: z.number(),
  http: httpExchangeWireSchema,
  response: soapResponseWireSchema.optional(),
  problems: z.array(exchangeProblemSchema),
  /** Set only when the send carried credentials: what authentication did. */
  auth: authSummaryWireSchema.optional(),
  /** Set only when the send expanded properties: the references that stayed unresolved. */
  unresolved: z.array(unresolvedRefWireSchema).optional(),
  /** Set only when the send was given WS-Security: what it applied, and what it made of the response. */
  wss: wssExchangeWireSchema.optional(),
  /** Set only when the send carried WS-Addressing: the `Action` and `MessageID` it put on the wire. */
  wsa: z.object({ messageId: z.string().optional(), action: z.string().optional() }).optional(),
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
  workstation: z.string().optional(),
  preemptive: z.boolean().optional(),
});
export type EndpointAuthWire = z.infer<typeof endpointAuthSchema>;

/** One addressable endpoint of an interface (credentials referenced by `secretRef`, never on the wire). */
export const endpointWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  auth: endpointAuthSchema.optional(),
  /** `override` replaces request credentials, `complement` only fills in blanks. */
  authMode: z.enum(['override', 'complement']),
  /** Send even when this endpoint's certificate does not verify. Badged in red wherever it shows. */
  trustInvalid: z.boolean().optional(),
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
  /** The interface-level WS-Addressing defaults every request of it inherits. */
  wsaConfig: wsaConfigWireSchema.optional(),
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
  /** Id of a `wss/keystores.yaml` entry: the client identity this request's TLS handshake presents. */
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
  /**
   * The on-disk file-system name (without the `.request.yaml` / `.xml` suffix) — `RequestDef.slug`.
   * Sync conflict matching (Task 11) keys off this, `operationSlug` and the interface/project
   * slugs to rebuild the exact tree path a conflict names, rather than a display name that
   * `uniqueSlug` may have suffixed to stay unique on disk.
   */
  slug: z.string(),
  /** The owning operation's file-system name (`OperationDef.slug`) — see {@link slug}. */
  operationSlug: z.string(),
  envelopeXml: z.string(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  endpointId: z.string().optional(),
  endpointUrl: z.string().optional(),
  headers: z.array(headerEntrySchema),
  order: z.number(),
  auth: endpointAuthSchema.optional(),
  description: z.string().optional(),
  /** This request's own WS-Addressing overrides; absent means "inherit from the interface". */
  wsa: wsaConfigWireSchema.optional(),
  /** Id of a `wss/outgoing/<id>.yaml` configuration applied to the envelope at send time. */
  wssOutgoingRef: z.string().optional(),
  /** Id of a `wss/incoming/<id>.yaml` configuration used to verify/decrypt the response. */
  wssIncomingRef: z.string().optional(),
  /**
   * `.default([])` is parse-time tolerance for a `ProjectWire` snapshot built by an older build
   * (or by a stub in a test) that omits the field; `z.infer` still yields a required array. It
   * is NOT what makes an old project file load — those go through the engine's
   * `requestFileSchema`, which requires the field.
   */
  attachments: z.array(attachmentWireSchema).default([]),
  properties: requestPropertiesSchema,
  /**
   * True when this request's operation is no longer in the interface's definition, after an
   * Update Definition dropped it. Nothing is deleted; the explorer badges the row instead.
   */
  orphaned: z.boolean().optional(),
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
  /** Names in `properties` skipped during resolution, without being deleted. */
  disabled: z.array(z.string()),
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
/**
 * One entry of an outgoing WS-Security configuration, as the renderer edits it. A password is
 * only ever a `passwordRef`: the value itself lives in the secret store and is resolved in main.
 */
export const wssEntryWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('timestamp'),
    /** Seconds between `Created` and `Expires`; `0` omits `Expires`. */
    timeToLiveSeconds: z.number().int().nonnegative(),
    millisecondPrecision: z.boolean(),
  }),
  z.object({
    kind: z.literal('username-token'),
    username: z.string(),
    passwordRef: z.string().optional(),
    passwordType: z.enum(['text', 'digest', 'none']),
    addNonce: z.boolean(),
    addCreated: z.boolean(),
  }),
  z.object({
    kind: z.literal('signature'),
    /** The `wss/keystores.yaml` registry id holding the signing key. */
    keystoreRef: z.string(),
    alias: z.string().optional(),
    /** A `secretRef` for the private key's passphrase; never the passphrase itself. */
    keyPasswordRef: z.string().optional(),
    keyIdentifierType: z.enum([
      'BinarySecurityToken',
      'IssuerSerial',
      'SubjectKeyIdentifier',
      'X509KeyIdentifier',
      'Thumbprint',
    ]),
    signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']),
    digestAlgorithm: z.enum(['sha256', 'sha1']),
    canonicalization: z.literal('exc-c14n'),
    useSingleCertificate: z.boolean(),
    parts: z.array(z.object({ name: z.string(), namespace: z.string(), encode: z.enum(['Content', 'Element']) })),
  }),
  z.object({
    kind: z.literal('encryption'),
    /** The `wss/keystores.yaml` registry id holding the *recipient's* certificate. */
    keystoreRef: z.string(),
    alias: z.string().optional(),
    keyIdentifierType: z.enum([
      'BinarySecurityToken',
      'IssuerSerial',
      'SubjectKeyIdentifier',
      'X509KeyIdentifier',
      'Thumbprint',
    ]),
    symmetricAlgorithm: z.enum(['aes128-cbc', 'aes256-cbc', 'aes128-gcm', 'aes256-gcm']),
    keyTransportAlgorithm: z.enum(['rsa-oaep', 'rsa-1_5']),
    embedKey: z.boolean(),
    encryptSymmetricKey: z.boolean(),
    parts: z.array(z.object({ name: z.string(), namespace: z.string(), encode: z.enum(['Content', 'Element']) })),
  }),
]);
export type WssEntryWire = z.infer<typeof wssEntryWireSchema>;

/** One `wss/outgoing/<id>.yaml` configuration as the renderer mirrors it. */
export const wssOutgoingWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  defaultAlias: z.string().optional(),
  /** A `secretRef` for the default username-token password; never the password itself. */
  defaultPasswordRef: z.string().optional(),
  actor: z.string().optional(),
  mustUnderstand: z.boolean(),
  entries: z.array(wssEntryWireSchema),
});
export type WssOutgoingWire = z.infer<typeof wssOutgoingWireSchema>;

/**
 * The fields of an outgoing configuration the renderer may patch — the whole configuration
 * minus its id. `null` clears an optional one; `entries` REPLACES the whole list, so reordering
 * and removal are expressible.
 */
export const wssOutgoingPatchSchema = z.object({
  name: z.string().optional(),
  defaultAlias: z.string().nullable().optional(),
  defaultPasswordRef: z.string().nullable().optional(),
  actor: z.string().nullable().optional(),
  mustUnderstand: z.boolean().optional(),
  entries: z.array(wssEntryWireSchema).optional(),
});
export type WssOutgoingPatchWire = z.infer<typeof wssOutgoingPatchSchema>;

/**
 * One `wss/incoming/<id>.yaml` configuration as the renderer mirrors it: which keystore opens
 * the response, which truststore its signatures are judged against, and how strict to be.
 * Never key material — only registry ids and a `secretRef`.
 */
export const wssIncomingWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Registry id of the keystore whose private key opens `xenc:EncryptedKey` blocks. */
  decryptKeystoreRef: z.string().optional(),
  decryptAlias: z.string().optional(),
  /** A `secretRef` for that private key's passphrase; never the passphrase itself. */
  decryptKeyPasswordRef: z.string().optional(),
  /** Registry id of the truststore: a keystore whose aliases are the trusted certificates. */
  signatureKeystoreRef: z.string().optional(),
  requireSignature: z.boolean(),
  requireTimestamp: z.boolean(),
  timestampSkewSeconds: z.number().int().nonnegative(),
  verifyChain: z.boolean(),
});
export type WssIncomingWire = z.infer<typeof wssIncomingWireSchema>;

/** The fields of an incoming configuration the renderer may patch; `null` clears an optional one. */
export const wssIncomingPatchSchema = z.object({
  name: z.string().optional(),
  decryptKeystoreRef: z.string().nullable().optional(),
  decryptAlias: z.string().nullable().optional(),
  decryptKeyPasswordRef: z.string().nullable().optional(),
  signatureKeystoreRef: z.string().nullable().optional(),
  requireSignature: z.boolean().optional(),
  requireTimestamp: z.boolean().optional(),
  timestampSkewSeconds: z.number().int().nonnegative().optional(),
  verifyChain: z.boolean().optional(),
});
export type WssIncomingPatchWire = z.infer<typeof wssIncomingPatchSchema>;

/**
 * One `wss/keystores.yaml` entry as the renderer sees it. Deliberately never carries the
 * password, the private key or any certificate PEM — only the registry metadata; the material
 * itself stays in main (see `keystores.inspect` for the alias summaries).
 */
export const keystoreWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute, or relative to the project folder. Shown so the user can tell two files apart. */
  path: z.string(),
  type: z.enum(['pkcs12', 'pem']),
  /** Present when a password was stored; the value itself never crosses the bridge. */
  passwordSecretRef: z.string().optional(),
  defaultAlias: z.string().optional(),
});
export type KeystoreWire = z.infer<typeof keystoreWireSchema>;

/**
 * Authentication as it crosses the bridge: the same seven schemes the engine models, with every
 * credential a `secretRef`. There is no channel that returns a secret *value* (ADR-0004), so a
 * renderer can configure a token it can never read back.
 */
export const authConfigWireSchema = z.object({
  type: z.enum(['inherit', 'none', 'basic', 'ntlm', 'bearer', 'api-key', 'oauth2']),
  username: z.string().optional(),
  passwordRef: z.string().optional(),
  domain: z.string().optional(),
  workstation: z.string().optional(),
  preemptive: z.boolean().optional(),
  tokenRef: z.string().optional(),
  scheme: z.string().optional(),
  name: z.string().optional(),
  valueRef: z.string().optional(),
  in: z.enum(['header', 'query']).optional(),
  grant: z.enum(['client-credentials', 'authorization-code']).optional(),
  tokenUrl: z.string().optional(),
  authorizationUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecretRef: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  clientAuth: z.enum(['basic', 'body']).optional(),
  pkce: z.boolean().optional(),
  refreshTokenRef: z.string().optional(),
});
export type AuthConfigWire = z.infer<typeof authConfigWireSchema>;

/** One params, query, header or form row. */
export const keyValueWireSchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});
export type KeyValueWire = z.infer<typeof keyValueWireSchema>;

/**
 * A request body on the wire. A raw body carries its `text` here, unlike on disk where it lives in
 * a sibling file: the renderer edits the text, and main decides where it is written.
 */
export const restBodyWireSchema = z.union([
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('raw'),
    language: z.enum(['json', 'xml', 'text', 'html', 'javascript']),
    contentType: z.string().optional(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('form'), fields: z.array(keyValueWireSchema) }),
  z.object({
    kind: z.literal('multipart'),
    parts: z.array(
      z.union([
        z.object({
          kind: z.literal('text'),
          name: z.string(),
          value: z.string(),
          enabled: z.boolean(),
          contentType: z.string().optional(),
        }),
        z.object({
          kind: z.literal('file'),
          name: z.string(),
          source: attachmentSourceWireSchema,
          enabled: z.boolean(),
          fileName: z.string().optional(),
          contentType: z.string().optional(),
        }),
      ]),
    ),
  }),
  z.object({ kind: z.literal('binary'), source: attachmentSourceWireSchema, contentType: z.string() }),
]);
export type RestBodyWire = z.infer<typeof restBodyWireSchema>;

/** Per-request transport settings; an absent field means *inherit*, never *off*. */
export const restSettingsWireSchema = z.object({
  timeoutMs: z.number().int().nonnegative().optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  keepBodyOnRedirect: z.boolean().optional(),
  encodeUrl: z.boolean().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  sendCookies: z.boolean().optional(),
  escapeProperties: z.boolean().optional(),
});
export type RestSettingsWire = z.infer<typeof restSettingsWireSchema>;

/** One REST request as the renderer sees it. */
export const restRequestWireSchema = z.object({
  kind: z.literal('rest'),
  id: z.string(),
  apiId: z.string(),
  /** Id of the folder it sits in, absent at the API's root. */
  folderId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  method: z.string(),
  url: z.string(),
  pathParams: z.array(keyValueWireSchema),
  query: z.array(keyValueWireSchema),
  headers: z.array(keyValueWireSchema),
  body: restBodyWireSchema,
  auth: authConfigWireSchema,
  settings: restSettingsWireSchema,
  orphaned: z.boolean().optional(),
});
export type RestRequestWire = z.infer<typeof restRequestWireSchema>;

/** One folder as the renderer sees it; its children arrive as flat lists keyed by `parentId`. */
export const restFolderWireSchema = z.object({
  id: z.string(),
  apiId: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  auth: authConfigWireSchema.optional(),
});
export type RestFolderWire = z.infer<typeof restFolderWireSchema>;

/** One API as the renderer sees it. Its folders and requests are separate flat lists. */
export const restApiWireSchema = z.object({
  kind: z.literal('rest'),
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  baseUrl: z.string(),
  servers: z.array(z.object({ url: z.string(), description: z.string().optional() })),
  auth: authConfigWireSchema.optional(),
  definition: z.object({ source: z.string(), cache: z.boolean(), version: z.string() }).optional(),
});
export type RestApiWire = z.infer<typeof restApiWireSchema>;

/** The fields of an API the renderer may patch; `null` clears an optional one. */
export const apiPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  baseUrl: z.string().optional(),
  servers: z.array(z.object({ url: z.string(), description: z.string().optional() })).optional(),
  auth: authConfigWireSchema.nullable().optional(),
});
export type ApiPatchWire = z.infer<typeof apiPatchSchema>;

/** The fields of a folder the renderer may patch. */
export const restFolderPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  auth: authConfigWireSchema.nullable().optional(),
});
export type RestFolderPatchWire = z.infer<typeof restFolderPatchSchema>;

/**
 * The fields of a REST request the renderer may patch. Tables and settings are replaced wholesale
 * rather than merged: an absent setting means *inherit*, so a merge could never turn one back off.
 */
export const restRequestPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
  pathParams: z.array(keyValueWireSchema).optional(),
  query: z.array(keyValueWireSchema).optional(),
  headers: z.array(keyValueWireSchema).optional(),
  body: restBodyWireSchema.optional(),
  auth: authConfigWireSchema.optional(),
  settings: restSettingsWireSchema.optional(),
});
export type RestRequestPatchWire = z.infer<typeof restRequestPatchSchema>;

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

/** One cookie a response set, as the Cookies tab shows it. */
export const cookieWireSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.string().optional(),
  maxAge: z.number().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  /** The header could not be parsed as a cookie; `name` holds the whole line. */
  malformed: z.boolean().optional(),
});
export type CookieWire = z.infer<typeof cookieWireSchema>;

/**
 * What one REST send produced. The same `http` projection a SOAP exchange carries — so the HTTP
 * log, the raw view and the timing waterfall are one implementation — plus what the body turned out
 * to be.
 */
export const restExchangeSummarySchema = z.object({
  sendId: z.string(),
  durationMs: z.number(),
  http: httpExchangeWireSchema,
  /** The URL actually sent, redacted unless the session shows secrets. */
  url: z.string(),
  method: z.string(),
  /** The response body decoded to text; empty for an image or another binary body. */
  text: z.string(),
  language: z.enum(['json', 'xml', 'html', 'javascript', 'text', 'image', 'binary']),
  /** Set when the declared charset could not be honoured and UTF-8 was used instead. */
  decodeNote: z.string().optional(),
  cookies: z.array(cookieWireSchema),
  /** A redirect turned the request into a `GET`; the HTTP log calls it out. */
  methodChanged: z.boolean(),
  problems: z.array(exchangeProblemSchema),
  auth: authSummaryWireSchema.optional(),
  unresolved: z.array(unresolvedRefWireSchema).optional(),
});
export type RestExchangeSummary = z.infer<typeof restExchangeSummarySchema>;

/**
 * Request payload for `request.sendRest`.
 *
 * The renderer names the request and, when its editor has unsaved edits, hands over the draft it is
 * looking at. It never sends a resolved URL, a base URL or a credential: main owns the environment,
 * the project model and the keychain, so it is main that decides where the request goes.
 */
export const requestSendRestRequestSchema = z.object({
  /** Client-generated id, used to correlate a later `request.cancel`. */
  sendId: z.string(),
  requestId: z.string(),
  /** The editor's unsaved edits, applied to this send only. */
  draft: restRequestPatchSchema.optional(),
});
export type RequestSendRestRequest = z.infer<typeof requestSendRestRequestSchema>;

/** Request payload for `request.preflightRest`: the same pair, with nothing sent. */
export const requestPreflightRestRequestSchema = z.object({
  requestId: z.string(),
  draft: restRequestPatchSchema.optional(),
});

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
});

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
});
export type RequestCurlRequest = z.infer<typeof requestCurlRequestSchema>;

/** Response payload for `request.curl`. Secret-bearing headers are masked unless show-secrets is on. */
export const requestCurlResponseSchema = z.object({
  command: z.string(),
  /**
   * One-line notes about what the command does *not* carry — WS-Security (needs secrets and a
   * keystore the export never touches) and/or attachments (never ride on this wire shape) —
   * present only for the layers this particular request actually has.
   */
  notes: z.array(z.string()).optional(),
});
export type RequestCurlResponse = z.infer<typeof requestCurlResponseSchema>;

/** One HTTP Log row as the renderer holds it — what `log.curl` (and later `log.exportHar`) receive. */
export const logEntryWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exchange'),
    exchange: z.union([grpcExchangeSummarySchema, restExchangeSummarySchema, exchangeSummarySchema]),
    /** The saved request the send came from; absent for an ad-hoc send. */
    requestId: z.string().optional(),
  }),
  z.object({ kind: z.literal('failure'), failure: failedExchangeWireSchema }),
]);
export type LogEntryWire = z.infer<typeof logEntryWireSchema>;

/** Request payload for `log.curl`; the response is `requestCurlResponseSchema`. */
export const logCurlRequestSchema = z.object({ entry: logEntryWireSchema, shell: z.enum(['posix', 'powershell']) });
export type LogCurlRequest = z.infer<typeof logCurlRequestSchema>;

/**
 * Request payload for `log.resend`: the saved request behind a row, replayed as it is now. A
 * logged row's own headers and body are redacted and are never the source of a send.
 */
export const logResendRequestSchema = z.object({ protocol: z.enum(['soap', 'rest', 'grpc']), requestId: z.string() });
export type LogResendRequest = z.infer<typeof logResendRequestSchema>;

/** Response payload for `log.resend`: the new exchange, tagged by protocol. */
export const logResendResponseSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('soap'), exchange: exchangeSummarySchema }),
  z.object({ protocol: z.literal('rest'), exchange: restExchangeSummarySchema }),
  z.object({ protocol: z.literal('grpc'), exchange: grpcExchangeSummarySchema }),
]);
export type LogResendResponse = z.infer<typeof logResendResponseSchema>;

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
  /** Every REST request of every API, flat; `apiId`/`folderId` give its place. */
  restRequests: z.array(restRequestWireSchema),
  /** The project's gRPC APIs; their folders are in `folders`, keyed by `apiId` like a REST API's. */
  grpcApis: z.array(grpcApiWireSchema),
  /** Every gRPC request of every gRPC API, flat. */
  grpcRequests: z.array(grpcRequestWireSchema),
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

/** The fields of a request the renderer may patch through `update-request`. */
export const requestPatchSchema = z.object({
  name: z.string().optional(),
  envelopeXml: z.string().optional(),
  endpointId: z.string().nullable().optional(),
  endpointUrl: z.string().nullable().optional(),
  headers: z.array(headerEntrySchema).optional(),
  soapAction: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  /** Id of a `wss/outgoing/<id>.yaml` configuration applied at send time; `null` clears it. */
  wssOutgoingRef: z.string().nullable().optional(),
  /** Id of a `wss/incoming/<id>.yaml` configuration; `null` clears it. */
  wssIncomingRef: z.string().nullable().optional(),
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
/** The fields of a keystore entry the renderer may patch; `null` clears an optional one. */
export const keystorePatchSchema = z.object({
  name: z.string().optional(),
  passwordSecretRef: z.string().nullable().optional(),
  defaultAlias: z.string().nullable().optional(),
});
export type KeystorePatchWire = z.infer<typeof keystorePatchSchema>;

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
  z.object({ kind: z.literal('update-request-auth'), requestId: z.string(), auth: endpointAuthSchema.nullable() }),
  /** `wsa: null` clears the request's own overrides, putting it back on "inherit". */
  z.object({ kind: z.literal('update-request-wsa'), requestId: z.string(), wsa: wsaConfigWireSchema.nullable() }),
  z.object({ kind: z.literal('update-interface-wsa'), interfaceId: z.string(), wsa: wsaConfigWireSchema }),
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
  z.object({
    kind: z.literal('move-node'),
    nodeId: z.string(),
    /** Absent moves the node to the API's root. */
    parentId: z.string().optional(),
    index: z.number().int().nonnegative(),
  }),
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

/**
 * The project a `project.*` request addresses. Every one of these channels carries it: inside
 * a workspace "the open project" is not a question with one answer, so the renderer names the
 * project it means and main routes the call to that project's host.
 */
export const projectIdRequestSchema = z.object({ projectId: z.string() });

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
});
export type ProjectMutateResponse = z.infer<typeof projectMutateResponseSchema>;

/** Response for `project.save`. */
export const projectSaveResponseSchema = z.object({
  saved: z.boolean(),
  savedAt: z.string().optional(),
  written: z.number(),
  removed: z.number(),
  /** Timestamped `.xml.bak` paths this save actually wrote, when backups were requested. */
  backups: z.array(z.string()).readonly().optional(),
});
export type ProjectSaveResult = z.infer<typeof projectSaveResponseSchema>;

/**
 * Where a `project.addInterface` import lands: an existing project of the open workspace, or a
 * project created for it on the spot. The second arm is what lets "Import WSDL" work from an
 * empty workspace without first asking the user to make a project to put it in.
 */
export const projectAddInterfaceTargetSchema = z.union([
  z.object({ projectId: z.string() }),
  z.object({ newProjectName: z.string() }),
]);
export type ProjectAddInterfaceTarget = z.infer<typeof projectAddInterfaceTargetSchema>;

/** Request/response for `project.addInterface`. */
export const projectAddInterfaceRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: importSourceSchema,
  auth: importAuthSchema.optional(),
  /** When true, the resolved auth is also saved on the interface for reuse when sending requests. */
  useForRequests: z.boolean().optional(),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export const projectAddInterfaceResponseSchema = z.object({
  /** The project the interface landed in — the one that was created, for a `newProjectName`. */
  projectId: z.string(),
  project: projectWireSchema,
  interfaceId: z.string(),
});
export type ProjectAddInterfaceResponse = z.infer<typeof projectAddInterfaceResponseSchema>;

// ---------------------------------------------------------------------------
// OpenAPI import (`api.*`): one API made from a described document, and the
// cached definition it can be read back and exported from.
// ---------------------------------------------------------------------------

/**
 * Where an OpenAPI document comes from. The same three arms a WSDL import has, and the same rule:
 * passing this schema does not authorize a `file` path — main additionally requires it to be inside
 * an open project folder or to have been picked through a dialog this session.
 */
export const openApiSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({
    kind: z.literal('text'),
    text: z.string().max(MAX_IMPORT_TEXT_CHARS),
    location: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  }),
]);
export type OpenApiSourceWire = z.infer<typeof openApiSourceSchema>;

/** One thing the import could not use, and where it was. */
export const openApiSkippedSchema = z.object({
  kind: z.string(),
  where: z.string(),
  reason: z.string(),
});
export type OpenApiSkippedWire = z.infer<typeof openApiSkippedSchema>;

/**
 * One security scheme the document declares, as a candidate for the API's credentials.
 *
 * Every scheme is listed, usable or not: the dialog offers the choice, and one this client cannot
 * use has to say why rather than be missing from the list. `auth` is exactly what picking it sets,
 * computed by the engine so the renderer never has to know how a scheme becomes credentials.
 */
export const openApiSchemeCandidateSchema = z.object({
  name: z.string(),
  type: z.enum(['http', 'apiKey', 'oauth2', 'openIdConnect', 'mutualTLS']),
  description: z.string().optional(),
  auth: authConfigWireSchema.optional(),
  reason: z.string().optional(),
  applied: z.boolean(),
});
export type OpenApiSchemeCandidateWire = z.infer<typeof openApiSchemeCandidateSchema>;

/** What an import made, for the summary the dialog shows when it finishes. */
export const openApiImportSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  /** The `openapi` string the document declared. */
  declaredVersion: z.string(),
  /** `info.version` — the version of the API, not of the specification. */
  apiVersion: z.string().optional(),
  baseUrl: z.string(),
  servers: z.array(z.object({ url: z.string(), description: z.string().optional() })),
  folders: z.number(),
  requests: z.number(),
  deprecated: z.number(),
  auth: z.string().optional(),
  securitySchemes: z.array(openApiSchemeCandidateSchema),
  skipped: z.array(openApiSkippedSchema),
});
export type OpenApiImportSummaryWire = z.infer<typeof openApiImportSummarySchema>;

/** Request/response for `api.importOpenApi`. The target is the same union a WSDL import takes. */
export const apiImportOpenApiRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: openApiSourceSchema,
  /** Overrides `info.title` as the API's name; the dialog offers it for editing. */
  name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
  /** Overrides the first server's URL as the base URL. */
  baseUrl: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  /** The security scheme, by its name in the document, to use as the API's own credentials. */
  securityScheme: z.string().max(200).optional(),
  /** Write the definition cache. Defaults to the definition-caching preference. */
  cache: z.boolean().optional(),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export type ApiImportOpenApiRequest = z.infer<typeof apiImportOpenApiRequestSchema>;

export const apiImportOpenApiResponseSchema = z.object({
  /** The project the API landed in — the one that was created, for a `newProjectName`. */
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: openApiImportSummarySchema,
});
export type ApiImportOpenApiResponse = z.infer<typeof apiImportOpenApiResponseSchema>;

/** Source for Postman collection import: file path or pasted JSON text. */
export const postmanSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({ kind: z.literal('text'), text: z.string().max(MAX_IMPORT_TEXT_CHARS) }),
]);
export type PostmanSourceWire = z.infer<typeof postmanSourceSchema>;

/** Summary of imported Postman collection. */
export const postmanImportSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  folders: z.number(),
  requests: z.number(),
  auth: z.string().optional(),
  warnings: z.array(z.string()).readonly().optional(),
  skipped: z.array(z.string()).readonly().optional(),
});
export type PostmanImportSummaryWire = z.infer<typeof postmanImportSummarySchema>;

/** Request payload for `api.importPostman`. */
export const apiImportPostmanRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: postmanSourceSchema,
  name: z.string().max(MAX_IMPORT_NAME_CHARS).optional(),
  baseUrl: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
});
export type ApiImportPostmanRequest = z.infer<typeof apiImportPostmanRequestSchema>;

/** Response payload for `api.importPostman`. */
export const apiImportPostmanResponseSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: postmanImportSummarySchema,
});
export type ApiImportPostmanResponse = z.infer<typeof apiImportPostmanResponseSchema>;

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

export const apiImportProtoResponseSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema,
  apiId: z.string(),
  summary: protoImportSummarySchema,
});
export type ApiImportProtoResponse = z.infer<typeof apiImportProtoResponseSchema>;

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

/** Request/response for `api.cancelImport`, by the token the import was started with. */
export const apiCancelImportRequestSchema = z.object({ token: z.string() });
export const apiCancelImportResponseSchema = z.object({ cancelled: z.boolean() });

/** Request payload for the channels that address one API's cached definition. */
export const apiIdRequestSchema = z.object({ apiId: z.string() });

/** Response for `api.definitionDocuments`: identity and size only, never text. */
export const apiDefinitionDocumentsResponseSchema = z.object({
  documents: z.array(z.object({ location: z.string(), size: z.number() })),
  rootLocation: z.string(),
  fetchedAt: z.string(),
  declaredVersion: z.string().optional(),
});
export type ApiDefinitionDocumentsResponse = z.infer<typeof apiDefinitionDocumentsResponseSchema>;

/**
 * Request payload for `api.definitionText`. `location` is never a path the renderer made up: main
 * matches it against the manifest's own locations and rejects anything else.
 */
export const apiDefinitionTextRequestSchema = z.object({
  apiId: z.string(),
  location: z.string().max(4096),
});
export const apiDefinitionTextResponseSchema = z.object({ text: z.string() });

/** Response for `api.exportDefinition`: main runs the folder dialog and writes the bytes. */
export const apiExportDefinitionResponseSchema = z.object({
  dir: z.string().optional(),
  files: z.array(z.string()).default([]),
  cancelled: z.boolean(),
});
export type ApiExportDefinitionResponse = z.infer<typeof apiExportDefinitionResponseSchema>;

/** Payload for the `project.changed` event: the renderer replaces its mirror wholesale. */
export const projectChangedEventSchema = z.object({
  projectId: z.string(),
  project: projectWireSchema.nullable(),
});
export type ProjectChangedEvent = z.infer<typeof projectChangedEventSchema>;

/** Payload for the `project.changedOnDisk` event, raised by the folder watcher. */
export const projectChangedOnDiskEventSchema = z.object({ projectId: z.string(), paths: z.array(z.string()) });
export type ProjectChangedOnDiskEvent = z.infer<typeof projectChangedOnDiskEventSchema>;

/** Payload for the `project.hydration` event: one interface's definition finished (re)loading. */
export const projectHydrationEventSchema = z.object({
  projectId: z.string(),
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

/**
 * Response for every `globals.*` channel (and the `globals.changed` event): the whole map, plus
 * which of its names are currently disabled (skipped during resolution, not deleted).
 */
export const globalsStateSchema = z.object({ properties: propertyMapSchema, disabled: z.array(z.string()) });
export type GlobalsState = z.infer<typeof globalsStateSchema>;

/** Request payload for `globals.set`. */
export const globalsSetRequestSchema = z.object({ name: z.string(), value: z.string() });

/** Request payload for `globals.remove`. */
export const globalsRemoveRequestSchema = z.object({ name: z.string() });

/** Request payload for `globals.setEnabled`. */
export const globalsSetEnabledRequestSchema = z.object({ name: z.string(), enabled: z.boolean() });

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

/**
 * Request payload for `exchanges.saveRestBody`: a handle, and deliberately nothing else.
 *
 * There is no `path` field, for the same reason `attachments.saveResponse` has none: these are bytes
 * a remote server sent, so the file they land in is always chosen by the user through the native
 * Save-as dialog. A renderer that could name the target could write server-controlled content
 * anywhere the user can write.
 */
export const exchangesSaveRestBodyRequestSchema = z.object({ sendId: z.string() });

/** Response for `exchanges.saveRestBody`: the file written, or `cancelled` when the user backed out. */
export const exchangesSaveRestBodyResponseSchema = z.union([
  z.object({ path: z.string() }),
  z.object({ cancelled: z.literal(true) }),
]);

// ---------------------------------------------------------------------------
// History (Task 24): a persistent, per-project record of every send, kept in
// `userData` (outside the project folder) and always stored redacted.
// ---------------------------------------------------------------------------

const historyFaultSchema = z.object({ code: z.string(), reason: z.string() });
const historyErrorSchema = z.object({ code: z.string(), message: z.string() });

/** Wire (and on-disk) shape of one recorded send — mirrors the engine's `HistoryEntry`. */
export const historyEntrySchema = z.object({
  id: z.string(),
  /**
   * Which protocol the send used. Optional, and honestly so: a line written before the REST client
   * carries none, and a reader treats its absence as SOAP (`normalizeHistoryEntry`). Every entry
   * main writes from now on names its kind.
   */
  kind: z.enum(['soap', 'rest', 'grpc']).optional(),
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
  sizeBytes: z.number(),
  tags: z.array(z.string()).optional(),
});
export type HistoryEntryWire = z.infer<typeof historyEntrySchema>;

/** Request payload for `history.list`. */
export const historyListRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().optional(),
  before: z.string().optional(),
  /** Narrows the merge to one project of the open workspace; absent means every project. */
  projectId: z.string().optional(),
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
/**
 * `keystores.inspect`: main reads the file (after the same containment check `add-keystore`
 * runs), resolves the password out of the secret store and parses the keystore. Only alias
 * *metadata* comes back — never a key, never a certificate PEM.
 */
export const keystoresInspectRequestSchema = z.object({ keystoreId: z.string() });
export const keystoreAliasWireSchema = z.object({
  alias: z.string(),
  subject: z.string(),
  issuer: z.string(),
  notAfter: z.string(),
  fingerprintSha256: z.string(),
  hasPrivateKey: z.boolean(),
});
export type KeystoreAliasWire = z.infer<typeof keystoreAliasWireSchema>;
export const keystoresInspectResponseSchema = z.object({
  status: z.enum(['ok', 'bad-password', 'invalid', 'not-found', 'outside-project']),
  aliases: z.array(keystoreAliasWireSchema),
  /** The failure's human-readable detail, for the row's tooltip. */
  message: z.string().optional(),
});
export type KeystoresInspectResponse = z.infer<typeof keystoresInspectResponseSchema>;

/**
 * `wss.previewOutgoing` / `wss.insertEntry` / `wss.removeOutgoing`: the three "bake WS-Security
 * into the envelope *text*" operations, as distinct from the request's `wssOutgoingRef`, which
 * is applied at send time and never touches the saved envelope.
 *
 * `envelopeXml` is what the editor currently holds (the saved envelope when omitted). Every
 * response goes through `redact.ts`, so a `wsse:Password` comes back masked: an envelope the
 * renderer may paste into the editor — and therefore into the project file — must never carry
 * a plaintext secret. The real password is substituted only by the send-time path.
 */
export const wssPreviewOutgoingRequestSchema = z.object({
  requestId: z.string(),
  envelopeXml: z.string().optional(),
});
export const wssEnvelopeResponseSchema = z.object({ envelopeXml: z.string() });
export type WssPreviewOutgoingRequest = z.infer<typeof wssPreviewOutgoingRequestSchema>;
export type WssEnvelopeResponse = z.infer<typeof wssEnvelopeResponseSchema>;

/** `wss.insertEntry`: applies one ad-hoc entry, with no configuration involved. */
export const wssInsertEntryRequestSchema = z.object({
  requestId: z.string(),
  envelopeXml: z.string().optional(),
  entry: wssEntryWireSchema,
  /** A `secretRef` for a username token's password; never the password itself. */
  passwordRef: z.string().optional(),
});
export type WssInsertEntryRequest = z.infer<typeof wssInsertEntryRequestSchema>;

/**
 * `wsa.insertHeaders`: bakes the request's effective WS-Addressing headers into the envelope
 * *text*, the editor-action counterpart of applying them on the way to the wire.
 */
export const wsaInsertHeadersRequestSchema = z.object({
  requestId: z.string(),
  envelopeXml: z.string().optional(),
});
export const wsaEnvelopeResponseSchema = z.object({ envelopeXml: z.string() });
export type WsaInsertHeadersRequest = z.infer<typeof wsaInsertHeadersRequestSchema>;
export type WsaEnvelopeResponse = z.infer<typeof wsaEnvelopeResponseSchema>;

/** `wsa.removeHeaders`: strips every `wsa:*` header, of either version, from the envelope text. */
export const wsaRemoveHeadersRequestSchema = z.object({
  requestId: z.string(),
  envelopeXml: z.string().optional(),
});
export type WsaRemoveHeadersRequest = z.infer<typeof wsaRemoveHeadersRequestSchema>;

/** `wss.removeOutgoing`: strips the `wsse:Security` header the request's configuration writes. */
export const wssRemoveOutgoingRequestSchema = z.object({
  requestId: z.string(),
  envelopeXml: z.string().optional(),
});
export type WssRemoveOutgoingRequest = z.infer<typeof wssRemoveOutgoingRequestSchema>;

/** `keystores.pickFile`: an Open dialog filtered to keystore files; records a read pick. */
export const keystoresPickFileRequestSchema = z.object({});
export const keystoresPickFileResponseSchema = z.object({ path: z.string().optional() });

export const attachmentsPickFilesRequestSchema = z.object({});
export const attachmentsPickFilesResponseSchema = z.object({ paths: z.array(z.string()) });

// ---------------------------------------------------------------------------
// XPath 3.1 / XQuery 3.1 scratchpad (Task 28): evaluated in main so the
// renderer never bundles `fontoxpath`.
// ---------------------------------------------------------------------------

/** Request payload for `xpath.evaluate`. Mirrors the engine's `EvaluateOptions`. */
export const xpathEvaluateRequestSchema = z.object({
  /** The document text. Named `xml` since that is what it was; a JSON body travels here too. */
  xml: z.string(),
  expression: z.string(),
  /**
   * The query language. `jsonpath` is JSON-only — main answers an XML document queried with it as an
   * error result rather than guessing — and the Query view only offers it for a JSON response.
   */
  language: z.enum(['xpath', 'xquery', 'jsonpath']),
  namespaces: z.record(z.string(), z.string()).optional(),
  /**
   * Which document `xml` is. Defaults to `xml`.
   *
   * XPath 3.1's maps, arrays and `?` lookup query JSON directly, so a JSON body is the same two
   * languages against a different context item. `jsonpath` is the third, for the syntax REST users
   * already have in their notes.
   */
  kind: z.enum(['xml', 'json']).optional(),
});

/** One node-shaped result item; mirrors the engine's `QueryNodeItem`. */
const xpathQueryNodeItemSchema = z.object({
  text: z.string(),
  nodeKind: z.enum(['element', 'attribute', 'text', 'document', 'comment', 'pi']),
  range: textRangeSchema.optional(),
  path: z.string(),
});

/** One atomic-value result item; mirrors the engine's `QueryValueItem`. `path` is filled in only by
 * JSONPath, which locates a value rather than computing one. */
const xpathQueryValueItemSchema = z.object({ text: z.string(), type: z.string(), path: z.string().optional() });

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
// Message validation (Task 42): XSD + SOAP structure checks, run in main so
// libxml2 (`xmllint-wasm`) and the interface's schema set stay out of the
// renderer bundle.
// ---------------------------------------------------------------------------

/** Request payload for `validate.message`; `xml` overrides the saved envelope (the live editor text). */
export const validateMessageRequestSchema = z.object({
  requestId: z.string(),
  direction: z.enum(['request', 'response']),
  xml: z.string().optional(),
});
export type ValidateMessageRequestWire = z.infer<typeof validateMessageRequestSchema>;

/** One validation finding; mirrors the engine's `ValidationProblem`. */
export const validationProblemSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  endLine: z.number().optional(),
  endColumn: z.number().optional(),
  source: z.enum(['schema', 'structure', 'ws-i']),
  path: z.string().optional(),
});
export type ValidationProblemWire = z.infer<typeof validationProblemSchema>;

/** Response for `validate.message`: every finding, plus how long the run took. */
export const validateMessageResponseSchema = z.object({
  problems: z.array(validationProblemSchema),
  durationMs: z.number(),
});
export type ValidateMessageResponseWire = z.infer<typeof validateMessageResponseSchema>;

// ---------------------------------------------------------------------------
// WS-I Basic Profile 1.1 (Tasks 43/44): conformance reports over a description
// or over one exchange. The catalogue, the runners and the HTML renderer all
// live in the engine, so main answers with a finished report.
// ---------------------------------------------------------------------------

/** Where in a document (or in which half of an exchange) a WS-I finding was raised. */
export const wsiLocationWireSchema = z.object({
  /** A document location for a description report; `request`/`response` for a message report. */
  document: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  xpath: z.string().optional(),
});

/** One concrete violation of a WS-I assertion; mirrors the engine's `WsiFinding`. */
export const wsiFindingWireSchema = z.object({
  message: z.string(),
  location: wsiLocationWireSchema.optional(),
});

/** One assertion's row in a report; mirrors the engine's `WsiAssertionReport`. */
export const wsiAssertionReportWireSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.enum(['REQUIRED', 'RECOMMENDED', 'PERMITTED']),
  section: z.string(),
  result: z.enum(['passed', 'failed', 'warning', 'notApplicable']),
  findings: z.array(wsiFindingWireSchema),
  /** Set when the requirement's number could not be confirmed against the published profile. */
  unverifiedId: z.boolean().optional(),
});

/** A finished WS-I report; mirrors the engine's `WsiReport` exactly. */
export const wsiReportWireSchema = z.object({
  target: z.string(),
  profile: z.literal('BP1.1'),
  summary: z.object({
    passed: z.number(),
    failed: z.number(),
    warning: z.number(),
    notApplicable: z.number(),
  }),
  assertions: z.array(wsiAssertionReportWireSchema),
  /** What the report is about, for the panel heading and the exported file's name. */
  label: z.string(),
  /** Which runner produced it, so the panel can say so without guessing from `target`. */
  scope: z.enum(['wsdl', 'message']),
});
export type WsiReportWire = z.infer<typeof wsiReportWireSchema>;
export type WsiAssertionReportWire = z.infer<typeof wsiAssertionReportWireSchema>;
export type WsiFindingWire = z.infer<typeof wsiFindingWireSchema>;

/** Request payload for `wsi.checkWsdl`: the imported interface to analyse. */
export const wsiCheckWsdlRequestSchema = z.object({ interfaceId: z.string() });

/** Request payload for `wsi.checkExchange`: one cached send, by the id the renderer already holds. */
export const wsiCheckExchangeRequestSchema = z.object({ sendId: z.string() });

/**
 * Request payload for `wsi.exportHtml`. The renderer sends the report back rather than an id:
 * the report it is looking at is the one the user means to export, even if the cache behind it
 * has since been evicted.
 */
export const wsiExportHtmlRequestSchema = z.object({
  report: wsiReportWireSchema,
  suggestedName: z.string(),
  /** Include the passing rows (the `wsi.verbose` preference, as the panel currently shows it). */
  verbose: z.boolean().optional(),
});

/** Response for `wsi.exportHtml`: the path written, or nothing when the user cancelled. */
export const wsiExportHtmlResponseSchema = z.object({
  path: z.string().optional(),
  cancelled: z.boolean(),
});
export type WsiExportHtmlResponse = z.infer<typeof wsiExportHtmlResponseSchema>;

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
    allowH2: z.boolean(),
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
    /** True when main picked `caBundlePath` through a native dialog; see `SslPreferences`. */
    caBundlePickedByMain: z.boolean().optional(),
    clientKeystoreRef: z.string().optional(),
    trustAll: z.literal(false),
  }),
  git: z.object({
    path: z.string().optional(),
    /** True when main set `path` through `git.locate`; see `GitPreferences`. */
    pathPickedByMain: z.boolean().optional(),
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
  rest: z.object({
    followRedirects: z.boolean(),
    maxRedirects: z.number(),
    prettyPrintMaxBytes: z.number(),
    defaultAccept: z.string(),
    oauth2CallbackPort: z.number().optional(),
  }),
  editor: z.object({
    fontFamily: z.string().optional(),
    fontSize: z.number(),
    tabSize: z.number(),
    lineNumbers: z.boolean(),
    wordWrap: z.boolean(),
    autoValidateOnSend: z.boolean(),
    autoFormatResponses: z.boolean(),
    autosave: z.boolean(),
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
  updates: z.object({ checkOnLaunch: z.boolean() }),
  shortcuts: z.record(z.string(), z.string()),
});
export type PreferencesWire = z.infer<typeof preferencesWireSchema>;

/** The section names `preferences.reset` accepts. */
export const preferencesSectionSchema = z.enum([
  'http',
  'proxy',
  'ssl',
  'rest',
  'git',
  'wsdl',
  'wsi',
  'editor',
  'ui',
  'updates',
  'shortcuts',
]);
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
  git: z.record(z.string(), z.unknown()).optional(),
  wsdl: z.record(z.string(), z.unknown()).optional(),
  wsi: z.record(z.string(), z.unknown()).optional(),
  rest: z.record(z.string(), z.unknown()).optional(),
  editor: z.record(z.string(), z.unknown()).optional(),
  ui: z.record(z.string(), z.unknown()).optional(),
  updates: z.record(z.string(), z.unknown()).optional(),
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
 * `ssl.pickCaBundle` / `ssl.clearCaBundle`: the *only* ways the CA bundle preference changes.
 *
 * The renderer cannot name the path — `preferences.update` refuses a patch carrying
 * `ssl.caBundlePath` — because main reads that file on every send, and a path a renderer can
 * write is a path any renderer bug can point at anything. So main runs the picker, records the
 * result as a read pick (the same evidence `keystores.pickFile` produces) and persists the path
 * itself, marked `caBundlePickedByMain`. `ssl.clearCaBundle` is the matching way back.
 */
export const sslPickCaBundleRequestSchema = z.object({});
export const sslPickCaBundleResponseSchema = z.object({
  /** The chosen path, absent when the user cancelled the dialog. */
  path: z.string().optional(),
  preferences: preferencesWireSchema,
});
export type SslPickCaBundleResponse = z.infer<typeof sslPickCaBundleResponseSchema>;
export const sslClearCaBundleRequestSchema = z.object({});
export const sslClearCaBundleResponseSchema = z.object({ preferences: preferencesWireSchema });

/** A located, usable git executable — mirrors `GitLocation` from `main/sync/git-cli.ts`. */
export const gitLocationWireSchema = z.object({ path: z.string(), version: z.string() });
export type GitLocationWire = z.infer<typeof gitLocationWireSchema>;

/**
 * `git.detect` / `git.locate` / `git.clearPath`: like `ssl.pickCaBundle`/`clearCaBundle`, the
 * only ways the `git.path` preference changes. The renderer never names the git executable
 * itself — main runs it — so the path is set only by picking a file through `git.locate`, and
 * `preferences.update` refuses a patch carrying `git.path`/`git.pathPickedByMain`.
 */
export const gitDetectRequestSchema = z.object({});
export const gitDetectResponseSchema = z.object({ location: gitLocationWireSchema.nullable() });
export type GitDetectResponse = z.infer<typeof gitDetectResponseSchema>;

export const gitLocateRequestSchema = z.object({});
export const gitLocateResponseSchema = z.object({
  /** The located git, absent when the user cancelled the dialog (nothing changes then). */
  location: gitLocationWireSchema.optional(),
  preferences: preferencesWireSchema,
});
export type GitLocateResponse = z.infer<typeof gitLocateResponseSchema>;

export const gitClearPathRequestSchema = z.object({});
export const gitClearPathResponseSchema = z.object({ preferences: preferencesWireSchema });

/** Payload for `git.identityNeeded`: the open workspace's sync needs `user.name`/`user.email`. */
export const gitIdentityNeededEventSchema = z.object({ workspaceId: z.string() });
export type GitIdentityNeededEvent = z.infer<typeof gitIdentityNeededEventSchema>;

// ---------------------------------------------------------------------------
// Sync (Task 9). `SyncStatusWire`/`SyncConflictWire`/`SyncLogEntryWire` are defined here
// verbatim from `main/sync/types.ts` (which now re-exports the inferred types below, so no
// main-process import changes). The one path a `sync.*` channel may carry is `revealTree`'s,
// and it is tree-relative and containment-checked in main — never a filesystem path the
// renderer made up.
// ---------------------------------------------------------------------------

/** Where a workspace's sync currently stands relative to its remote (or synced folder). */
export const syncStateSchema = z.enum([
  'clean',
  'ahead',
  'behind',
  'diverged',
  'conflict',
  'syncing',
  'offline',
  'error',
]);
export type SyncState = z.infer<typeof syncStateSchema>;

/** A backend's current status, as reported to the renderer's status-bar badge and Sync panel. */
export const syncStatusWireSchema = z.object({
  kind: z.enum(['local', 'folder', 'git', 'server']),
  gitAvailable: z.boolean(),
  state: syncStateSchema,
  ahead: z.number(),
  behind: z.number(),
  uncommitted: z.number(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  lastSyncAt: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type SyncStatusWire = z.infer<typeof syncStatusWireSchema>;

/** One unresolved conflict, as the conflict resolver lists it. `projectId` is filled in by main. */
export const syncConflictWireSchema = z.object({
  path: z.string(),
  projectId: z.string().optional(),
  entity: z.object({ kind: z.string(), name: z.string() }).optional(),
});
export type SyncConflictWire = z.infer<typeof syncConflictWireSchema>;

/** One entry of a backend's commit history, newest first. */
export const syncLogEntryWireSchema = z.object({
  id: z.string(),
  subject: z.string(),
  author: z.string(),
  at: z.string(),
});
export type SyncLogEntryWire = z.infer<typeof syncLogEntryWireSchema>;

/** A patch over a git share's settings; every field optional (only what the dialog changed). */
export const syncSettingsPatchWireSchema = z.object({
  /** Bounded to a whole number of seconds, at most a day — a fractional or huge value would
   * either busy-loop the fetch timer (`setTimeout` clamps to 1ms) or never fire in practice. */
  autoFetchSeconds: z.number().int().min(0).max(86_400).optional(),
  commitOnSave: z.boolean().optional(),
  pushOnSave: z.boolean().optional(),
  remote: z.string().optional(),
  branch: z.string().optional(),
});
export type SyncSettingsPatchWire = z.infer<typeof syncSettingsPatchWireSchema>;

/** How the open workspace (or a picker row) is shared; `managed` means its tree lives in app data.
 * `autoFetchSeconds`/`commitOnSave`/`pushOnSave` are present only for `kind === 'git'` — the
 * persisted `GitShareSettings`, so the Sync panel can show them without guessing a default. */
export const workspaceShareWireSchema = z.object({
  kind: z.enum(['folder', 'git', 'server']),
  managed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  autoFetchSeconds: z.number().int().min(0).max(86_400).optional(),
  commitOnSave: z.boolean().optional(),
  pushOnSave: z.boolean().optional(),
});
export type WorkspaceShareWire = z.infer<typeof workspaceShareWireSchema>;

/** Raised after a pull (or a finished merge) has been applied to the open workspace. */
export const syncPulledEventSchema = z.object({
  workspaceId: z.string(),
  /** Projects whose files the pull changed (reloaded, or told their files changed on disk). */
  projectIds: z.array(z.string()),
  /** Whether `workspace.yaml` or an `environments/*.yaml` file changed. */
  workspaceChanged: z.boolean(),
  /** Distinct entities changed (a request's `.request.yaml` and `.xml` count once). */
  entityCount: z.number(),
});
export type SyncPulledEvent = z.infer<typeof syncPulledEventSchema>;

/** Request/response for `sync.status`/`sync.fetch`/`sync.pull`/`sync.push`/`sync.abortMerge`. */
export const syncCommitRequestSchema = z.object({ message: z.string().optional() });
export const syncConflictsResponseSchema = z.object({ conflicts: z.array(syncConflictWireSchema) });
export const syncResolveRequestSchema = z.object({ path: z.string(), side: z.enum(['mine', 'theirs']) });
export const syncLogRequestSchema = z.object({ limit: z.number().int().min(1).max(200) });
export const syncLogResponseSchema = z.object({ entries: z.array(syncLogEntryWireSchema) });
export const syncSetIdentityRequestSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().min(1),
});
export const syncSetIdentityResponseSchema = z.object({});
/** `path` is tree-relative and produced by main itself (a conflict entry); absent → the tree root. */
export const syncRevealTreeRequestSchema = z.object({ path: z.string().optional() });
export const syncRevealTreeResponseSchema = z.object({});

/** Payload for `sync.statusChanged`. */
export const syncStatusChangedEventSchema = z.object({ workspaceId: z.string(), status: syncStatusWireSchema });
export type SyncStatusChangedEvent = z.infer<typeof syncStatusChangedEventSchema>;

/** Payload for `sync.conflict`. */
export const syncConflictEventSchema = z.object({
  workspaceId: z.string(),
  conflicts: z.array(syncConflictWireSchema),
});
export type SyncConflictEvent = z.infer<typeof syncConflictEventSchema>;

/** Request/response for `workspace.share` / `workspace.join`. */
export const workspaceShareRequestSchema = z.object({ remote: z.string().optional(), branch: z.string().optional() });
export const workspaceJoinRequestSchema = z.object({ remote: z.string(), branch: z.string().optional() });

/** Request for `project.moveToWorkspace`. */
export const projectMoveToWorkspaceRequestSchema = z.object({ projectId: z.string(), workspaceId: z.string() });

/** Payload for `workspace.changedOnDisk`: a T4 load-failure reported instead of `workspace.changed`. */
export const workspaceChangedOnDiskEventSchema = z.object({
  workspaceId: z.string(),
  paths: z.array(z.string()),
  message: z.string(),
});
export type WorkspaceChangedOnDiskEvent = z.infer<typeof workspaceChangedOnDiskEventSchema>;

/**
 * The largest single file a drag-and-drop may add (32 MiB).
 *
 * Dropped bytes cross IPC base64-encoded and are held in memory on both sides, so an unbounded
 * drop is an easy way to wedge the app. Adding a bigger file through the Add… picker is
 * unaffected: that path streams from disk and never crosses the bridge. This is the single
 * source of truth for the cap — the renderer's drop handler, the `addDropped` request schema,
 * and `ProjectHost.addAttachmentBytes`'s decoded-length check all read it from here.
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

/** How many menu entries `app.registerMenu` accepts — comfortably above the command count. */
const MAX_MENU_ITEMS = 256;

/**
 * One command as the application menu needs it. The renderer owns the command registry, so it
 * is the renderer that sends main the manifest to build a menu from; `accelerator` is already
 * in Electron's own notation (`CmdOrCtrl+Shift+F`), since the chord grammar is the renderer's.
 */
export const menuCommandSchema = z.object({
  id: z.string().max(120),
  label: z.string().max(200),
  category: z.string().max(40),
  accelerator: z.string().max(60).optional(),
});
export type MenuCommandWire = z.infer<typeof menuCommandSchema>;

/** Request payload for `app.registerMenu`. */
export const appRegisterMenuRequestSchema = z.object({ items: z.array(menuCommandSchema).max(MAX_MENU_ITEMS) });
export type AppRegisterMenuRequest = z.infer<typeof appRegisterMenuRequestSchema>;

/**
 * Where an update check got to. Mirrors `main/updater.ts`'s `UpdateStatus` — it is both the
 * `app.checkForUpdates` response and the payload of the `app.updateStatus` event, so the
 * status bar and the toast speak the same vocabulary.
 */
export const updateStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checking') }),
  z.object({ kind: z.literal('busy') }),
  z.object({ kind: z.literal('up-to-date') }),
  z.object({ kind: z.literal('downloading'), percent: z.number() }),
  z.object({ kind: z.literal('declined'), version: z.string() }),
  z.object({ kind: z.literal('downloaded'), version: z.string() }),
  z.object({ kind: z.literal('installing'), version: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type UpdateStatusWire = z.infer<typeof updateStatusSchema>;

/** Response for `app.checkForUpdates`, and the payload of the `app.updateStatus` event. */
export const appUpdateStatusSchema = z.object({ status: updateStatusSchema });
export type AppUpdateStatus = z.infer<typeof appUpdateStatusSchema>;

/** Response for `app.registerMenu`: how many entries the built menu carries. */
export const appRegisterMenuResponseSchema = z.object({ items: z.number() });

/**
 * `command.invoke`: a menu item was clicked. Main knows nothing about a command's `when` gate,
 * so every menu item stays enabled and the renderer decides whether it can run.
 */
export const commandInvokeEventSchema = z.object({ id: z.string().max(120) });
export type CommandInvokeEvent = z.infer<typeof commandInvokeEventSchema>;

/**
 * The OS-level colour scheme, as Electron's `nativeTheme` reports it. This is what the `system`
 * theme preference resolves against — `prefers-color-scheme` inside a sandboxed renderer does
 * not follow a user's per-app macOS appearance override, but `nativeTheme` does.
 */
export const themeOsSchema = z.object({ os: z.enum(['dark', 'light']) });
export type ThemeOsWire = z.infer<typeof themeOsSchema>;

/** Response for `theme.get`, and the payload of the `theme.changed` event. */
export const themeGetResponseSchema = themeOsSchema;
export const themeChangedEventSchema = themeOsSchema;

/** Which corpora `search.query` looks in; at least one must be on or there is nothing to search. */
export const searchScopesSchema = z.object({
  requestBodies: z.boolean(),
  headers: z.boolean(),
  definitions: z.boolean(),
});
export type SearchScopesWire = z.infer<typeof searchScopesSchema>;

/** Request payload for `search.query`. */
export const searchQueryRequestSchema = z.object({
  query: z.string().min(1).max(500),
  regex: z.boolean(),
  caseSensitive: z.boolean(),
  scopes: searchScopesSchema,
  /** Hard cap on returned matches; the response says whether it was hit. */
  limit: z.number().int().min(1).max(1000).optional(),
});
export type SearchQueryRequest = z.infer<typeof searchQueryRequestSchema>;

/**
 * One match. Only the matching line (trimmed and length-capped) crosses the bridge — never the
 * document it came from — so searching a cached definition never ships the definition itself.
 */
export const searchMatchSchema = z.object({
  kind: z.enum(['request-body', 'request-header', 'document']),
  /**
   * Which protocol's request matched. Absent means SOAP, so an entry recorded before REST existed
   * reads as what it was. It decides both the badge in the results list and which editor a click
   * opens — a REST request id in a SOAP tab would open an editor with nothing in it.
   */
  protocol: z.enum(['soap', 'rest', 'grpc']).optional(),
  /**
   * Which project of the open workspace the match came from, and its display name — search
   * spans every open project, so a row has to say where it is before it can be revealed.
   */
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  /** Set for the two request kinds: which request matched, and its display name. */
  requestId: z.string().optional(),
  requestName: z.string().optional(),
  /** Set for every kind: the interface the match belongs to, and its display name. */
  interfaceId: z.string().optional(),
  interfaceName: z.string().optional(),
  /** Set for `document`: the definition document's original location. */
  location: z.string().optional(),
  /** 1-based line and column of the match within its document. */
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  /** UTF-16 offsets of the match within its document, for revealing a range. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /** The matching line, trimmed and capped. */
  snippet: z.string(),
});
export type SearchMatchWire = z.infer<typeof searchMatchSchema>;

/**
 * Response for `search.query`. `truncated` is true when the scan stopped early, and `reason`
 * says why: `limit` when the match cap was hit, `timeout` when the time budget ran out (a
 * pathological user regex is bounded, never left to run).
 */
export const searchQueryResponseSchema = z.object({
  matches: z.array(searchMatchSchema),
  truncated: z.boolean(),
  reason: z.enum(['limit', 'timeout']).optional(),
});
export type SearchQueryResponse = z.infer<typeof searchQueryResponseSchema>;

/**
 * One row of the workspace picker: what a directory scan of `<userData>/workspaces/*` found,
 * without opening anything. `unreadable` marks a folder whose `workspace.yaml` is missing or
 * corrupt — it is still listed (with a Reveal action) rather than silently dropped, and then
 * `name` falls back to the folder name and `createdAt` is empty.
 */
export const workspaceSummaryWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute path of the workspace folder. Shown so two same-named workspaces can be told apart. */
  dir: z.string(),
  projectCount: z.number().int().nonnegative(),
  /**
   * Of `projectCount`, how many are stored *inside* the workspace's own folder (`source ===
   * 'internal'`) and so go to the trash when the workspace is deleted — a linked project's
   * folder lives elsewhere and is never touched. 0 for an unreadable workspace.
   */
  internalProjectCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** From `workspace-state.json`; absent until the workspace has been opened at least once. */
  lastOpenedAt: z.string().optional(),
  unreadable: z.boolean().optional(),
  share: workspaceShareWireSchema.optional(),
});
export type WorkspaceSummaryWire = z.infer<typeof workspaceSummaryWireSchema>;

/**
 * One project of the open workspace, as the explorer's project root node sees it. `status`
 * reports the outcome of opening it: `loading` while its host is still opening, `ready` once
 * the model is in memory, `missing` when the folder is gone, `error` with a `message` when it
 * would not open. A workspace always opens, whatever its projects do.
 */
export const workspaceProjectWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  source: z.enum(['internal', 'linked']),
  /** Absolute: `projects/<slug>` inside the workspace, or the linked folder's own path. */
  dir: z.string(),
  status: z.enum(['loading', 'ready', 'missing', 'error']),
  message: z.string().optional(),
});
export type WorkspaceProjectWire = z.infer<typeof workspaceProjectWireSchema>;

/**
 * One workspace environment. `endpoints` is keyed `<projectSlug>/<interfaceSlug>`, which is
 * what lets one environment address interfaces across every project of the workspace.
 */
export const workspaceEnvironmentWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number().int().nonnegative(),
  properties: z.record(z.string(), z.string()),
  endpoints: z.record(z.string(), z.string()),
  /** Names in `properties` skipped during resolution, without being deleted. */
  disabled: z.array(z.string()),
});
export type WorkspaceEnvironmentWire = z.infer<typeof workspaceEnvironmentWireSchema>;

/** The open workspace as the renderer sees it: the manifest, its environments and its projects. */
export const workspaceWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** Absolute path of the workspace folder. */
  dir: z.string(),
  properties: z.record(z.string(), z.string()),
  /** Names in `properties` skipped during resolution, without being deleted. */
  disabled: z.array(z.string()),
  environments: z.array(workspaceEnvironmentWireSchema),
  /** The environment endpoints/properties resolve against, or absent when none is active. */
  activeEnvironmentId: z.string().optional(),
  projects: z.array(workspaceProjectWireSchema),
  share: workspaceShareWireSchema.optional(),
});
export type WorkspaceWire = z.infer<typeof workspaceWireSchema>;

/**
 * The fields of a workspace environment the renderer may patch. `properties` and `endpoints`
 * replace the whole map when present (like `EnvironmentPatchWire`), so removing a key is
 * sending the map without it rather than inventing a per-key delete.
 */
export const workspaceEnvironmentPatchSchema = z.object({
  name: z.string().optional(),
  properties: z.record(z.string(), z.string()).optional(),
  /** Keyed `<projectSlug>/<interfaceSlug>`; unknown keys are accepted, as for a project environment. */
  endpoints: z.record(z.string(), z.string()).optional(),
  /** Replaces the whole disabled-names list, like `properties`/`endpoints` above. */
  disabled: z.array(z.string()).optional(),
});
export type WorkspaceEnvironmentPatchWire = z.infer<typeof workspaceEnvironmentPatchSchema>;

/**
 * One atomic change to the open workspace's own manifest — its name, its properties and its
 * environments. Project data never travels through here: a change to a project is a
 * `ProjectChange` addressed to that project's host.
 */
export const workspaceChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename-workspace'), name: z.string() }),
  z.object({ kind: z.literal('set-workspace-property'), name: z.string(), value: z.string() }),
  z.object({ kind: z.literal('remove-workspace-property'), name: z.string() }),
  z.object({ kind: z.literal('set-workspace-property-enabled'), name: z.string(), enabled: z.boolean() }),
  z.object({ kind: z.literal('add-workspace-environment'), name: z.string() }),
  z.object({
    kind: z.literal('update-workspace-environment'),
    environmentId: z.string(),
    patch: workspaceEnvironmentPatchSchema,
  }),
  z.object({ kind: z.literal('remove-workspace-environment'), environmentId: z.string() }),
]);
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;

// ---------------------------------------------------------------------------
// Workspace channels and events (Task 8). The renderer never sends a filesystem
// path: link / import / export / locate run their native dialog in main, so the
// request half of those is an id at most.
// ---------------------------------------------------------------------------

/** Response for `workspace.list`. */
export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSummaryWireSchema),
  /**
   * Folders of a leftover pre-workspace `recent-projects.json`, offered on the picker as
   * "you had these projects" rather than silently stranding them. Absent when there are none.
   */
  suggestions: z.array(z.string()).optional(),
  /**
   * Why the workspace reopened at launch would not open (or why the last close failed to
   * save), for the picker's error banner. Absent when nothing went wrong.
   */
  lastError: z.string().optional(),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

/** Request for every channel that names a workspace by id (`open`, `delete`). */
export const workspaceIdRequestSchema = z.object({ workspaceId: z.string() });

/**
 * Request for `workspace.importSuggestion`: the position of a folder in the `suggestions` of the
 * last `workspace.list`. An index, never the folder itself — main resolves it against the list
 * it read, so the renderer cannot name a folder the app did not already hold.
 */
export const workspaceImportSuggestionRequestSchema = z.object({ index: z.number().int().nonnegative() });

/** Response for `workspace.reveal`: nothing to report beyond success. */
export const workspaceRevealResponseSchema = z.object({});

/** Request for `workspace.create`. */
export const workspaceCreateRequestSchema = z.object({ name: z.string() });

/** Request for `workspace.rename`. */
export const workspaceRenameRequestSchema = z.object({ workspaceId: z.string(), name: z.string() });

/** Response for every channel that returns the open workspace. */
export const workspaceResponseSchema = z.object({ workspace: workspaceWireSchema });
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

/**
 * Response for `workspace.importSuggestion`: the workspace, plus the folder that was actually
 * imported — so the renderer can confirm it matches the row that was clicked, not just trust
 * that the index still points at the same folder.
 */
export const workspaceImportSuggestionResponseSchema = z.object({ workspace: workspaceWireSchema, dir: z.string() });
export type WorkspaceImportSuggestionResponse = z.infer<typeof workspaceImportSuggestionResponseSchema>;

/** Response for every channel that may leave no workspace open (`close`) or be cancelled. */
export const workspaceSnapshotResponseSchema = z.object({ workspace: workspaceWireSchema.nullable() });
export type WorkspaceSnapshotResponse = z.infer<typeof workspaceSnapshotResponseSchema>;

/** Response for `workspace.rename` / `workspace.delete`: the refreshed picker list. */
export const workspaceSummariesResponseSchema = z.object({ workspaces: z.array(workspaceSummaryWireSchema) });
export type WorkspaceSummariesResponse = z.infer<typeof workspaceSummariesResponseSchema>;

/** Request for `workspace.addProject`. */
export const workspaceAddProjectRequestSchema = z.object({ name: z.string() });

/** Response for `workspace.addProject`: the workspace, plus the project that was created. */
export const workspaceAddProjectResponseSchema = z.object({
  workspace: workspaceWireSchema,
  projectId: z.string(),
});
export type WorkspaceAddProjectResponse = z.infer<typeof workspaceAddProjectResponseSchema>;

/** Request for `workspace.removeProject`. `deleteFiles` never touches a linked folder. */
export const workspaceRemoveProjectRequestSchema = z.object({
  projectId: z.string(),
  deleteFiles: z.boolean(),
});

/** Request for every channel addressing one project of the open workspace by id. */
export const workspaceProjectIdRequestSchema = z.object({ projectId: z.string() });

/** Response for `workspace.exportProject`: the folder written, or `null` when cancelled. */
export const workspaceExportProjectResponseSchema = z.object({ dir: z.string().nullable() });
export type WorkspaceExportProjectResponse = z.infer<typeof workspaceExportProjectResponseSchema>;

/** Request for `workspace.setActiveEnvironment`; `null` deactivates. */
export const workspaceSetActiveEnvironmentRequestSchema = z.object({ environmentId: z.string().nullable() });

/** Request for `workspace.mutate`. */
export const workspaceMutateRequestSchema = z.object({ change: workspaceChangeSchema });

/** Response for `workspace.mutate`: the new snapshot plus any entity the change created. */
export const workspaceMutateResponseSchema = z.object({
  workspace: workspaceWireSchema,
  /** Set by `add-workspace-environment`: the id of the environment that was created. */
  createdEnvironmentId: z.string().optional(),
});
export type WorkspaceMutateResponse = z.infer<typeof workspaceMutateResponseSchema>;

/** Payload for the `workspace.changed` event: the renderer replaces its mirror wholesale. */
export const workspaceChangedEventSchema = z.object({ workspace: workspaceWireSchema.nullable() });
export type WorkspaceChangedEvent = z.infer<typeof workspaceChangedEventSchema>;

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
});
export type WorkspaceStashDraftsRequest = z.infer<typeof workspaceStashDraftsRequestSchema>;

/** One project whose unsaved changes a previous session left behind, and what became of them. */
export const unsavedRestoreNoticeSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  status: z.enum(['restored', 'failed']),
  /** Changed on disk too; the unsaved version was kept (project-relative file paths). */
  conflicts: z.array(z.string()),
  /** Deleted on disk; the unsaved change was dropped (project-relative file paths). */
  dropped: z.array(z.string()),
  /** Why a `failed` restore failed. */
  message: z.string().optional(),
});
export type UnsavedRestoreNoticeWire = z.infer<typeof unsavedRestoreNoticeSchema>;

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
  notices: z.array(unsavedRestoreNoticeSchema),
});
export type WorkspaceRestoredResponse = z.infer<typeof workspaceRestoredResponseSchema>;

/** Payload for `workspace.flushDrafts`: main is about to close; stash drafts now. */
export const workspaceFlushDraftsEventSchema = z.object({});
