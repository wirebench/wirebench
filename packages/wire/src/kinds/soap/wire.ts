/**
 * The wire shapes only SOAP uses (kind modules spec §4.2): WSDL import and definitions, SOAP
 * requests and exchanges, WS-Security, WS-Addressing, WS-I, XML editing, XPath and attachments.
 * Imports `wire-base.ts` and never another kind's file.
 */

import { z } from 'zod';
import {
  MAX_IMPORT_LOCATION_CHARS,
  attachmentSourceWireSchema,
  authConfigWireSchema,
  authSummaryWireSchema,
  exchangeProblemSchema,
  headerEntrySchema,
  httpExchangeWireSchema,
  hydrationStatusSchema,
  importAuthSchema,
  projectAddInterfaceTargetSchema,
  requestAssertionResultWireSchema,
  requestAssertionWireSchema,
  requestScriptsWireSchema,
  scriptResultWireSchema,
  sendTlsOptionsSchema,
  unresolvedRefWireSchema,
  sentFromSchema,
} from '../../wire-base.js';

/**
 * Where a WSDL definition comes from — mirrors the engine's `WsdlImportSource`.
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

/** Request payload for `definition.import`. */
export const definitionImportRequestSchema = z.object({
  source: importSourceSchema,
  options: z.object({ auth: importAuthSchema.optional() }).optional(),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export type DefinitionImportRequest = z.infer<typeof definitionImportRequestSchema>;

export const soapVersionSchema = z.enum(['1.1', '1.2', 'none']);

const portSummarySchema = z.object({
  name: z.string(),
  address: z.string().optional(),
  /**
   * The URL an endpoint made from `address` holds: its `${` escaped as `$${` so the definition's text
   * is sent as written (#223). Main sets it whenever `address` is set.
   */
  endpointUrl: z.string().optional(),
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

const wssPolicyPartWireSchema = z.object({ name: z.string(), namespace: z.string() });

/**
 * An operation's WS-SecurityPolicy, as the import read it; mirrors the engine's `WssPolicy`
 * — main proposes a configuration from it and checks one against it (`wss.policyStatus`).
 */
export const wssPolicyWireSchema = z.object({
  version: z.enum(['1.1', '1.2']),
  soapVersion: z.enum(['1.1', '1.2']),
  binding: z.enum(['transport', 'asymmetric', 'symmetric', 'none']),
  requiresTls: z.boolean(),
  includeTimestamp: z.boolean(),
  encryptBeforeSigning: z.boolean(),
  algorithmSuite: z.string().optional(),
  tokens: z.array(
    z.object({
      kind: z.enum(['username', 'x509', 'issued', 'saml', 'kerberos', 'other']),
      role: z.enum(['initiator', 'recipient', 'supporting', 'signed-supporting', 'endorsing', 'signed-endorsing']),
      password: z.enum(['text', 'digest', 'none']).optional(),
      reference: z
        .enum(['BinarySecurityToken', 'IssuerSerial', 'SubjectKeyIdentifier', 'X509KeyIdentifier', 'Thumbprint'])
        .optional(),
      issuer: z.string().optional(),
      name: z.string().optional(),
    }),
  ),
  signedParts: z.array(wssPolicyPartWireSchema),
  encryptedParts: z.array(wssPolicyPartWireSchema),
  unsupported: z.array(z.string()),
  notes: z.array(z.string()),
});
export type WssPolicyWire = z.infer<typeof wssPolicyWireSchema>;

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
  /** The WS-SecurityPolicy the WSDL attaches to this operation; absent when it attaches none. */
  wssPolicy: wssPolicyWireSchema.optional(),
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

/** Response payload for `definition.import`: a JSON-serialisable projection of `WsdlImportResult`. */
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
  /** When true, build an empty envelope (`generateEmptySoapRequest`) instead of a sample one. */
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
   * renderer sees, and `request.curl` bakes its `wsa:*` headers into the
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
 * Request payload for every `issuedTokens.*` call: one issued-token entry of an outgoing WS-Security
 * configuration, and the request whose endpoint and environment it is fetched for (the first one
 * that selects the configuration when absent). Main reads the entry from the model.
 */
export const issuedTokenLocatorSchema = z.object({
  projectId: z.string(),
  configId: z.string(),
  entryIndex: z.number().int().nonnegative(),
  requestId: z.string().optional(),
});
export type IssuedTokenLocatorWire = z.infer<typeof issuedTokenLocatorSchema>;

/** What the renderer is told about an issued SAML token: never the assertion unless secrets show. */
export const issuedTokenStatusSchema = z.object({
  state: z.enum(['none', 'valid', 'expired']),
  expiresAt: z.string().optional(),
  samlVersion: z.enum(['1.1', '2.0']).optional(),
  keyType: z.enum(['bearer', 'public-key']).optional(),
  stsHost: z.string().optional(),
  lastError: z.string().optional(),
  /** With `state: 'none'`: the last token had no expiry, so it was used once and not kept. */
  singleUse: z.literal(true).optional(),
  /** Only with show-secrets on. */
  assertion: z.string().optional(),
});
export type IssuedTokenStatusWire = z.infer<typeof issuedTokenStatusSchema>;

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
 * One step of incoming WS-Security processing, as the response inspector lists it. Mirrors the
 * engine's `WssAction` exactly — booleans, a human-readable detail and the signer's subject.
 * No key material, no secret reference, nothing that could carry one.
 */
/** One `ds:Reference` as the WS-Security debugger reports it; mirrors the engine's `WssReferenceCheck`. */
export const wssReferenceCheckWireSchema = z.object({
  uri: z.string(),
  element: z.string().optional(),
  ok: z.boolean(),
  transforms: z.array(z.string()),
  inclusivePrefixes: z.array(z.string()),
  digestAlgorithm: z.string(),
  expectedDigest: z.string(),
  computedDigest: z.string().optional(),
  problem: z.string().optional(),
});
export type WssReferenceCheckWire = z.infer<typeof wssReferenceCheckWireSchema>;

/** One `ds:Signature` as the debugger reports it; mirrors the engine's `WssSignatureCheck`. */
export const wssSignatureCheckWireSchema = z.object({
  canonicalization: z.string(),
  signatureMethod: z.string(),
  references: z.array(wssReferenceCheckWireSchema),
  signatureValueOk: z.boolean(),
});
export type WssSignatureCheckWire = z.infer<typeof wssSignatureCheckWireSchema>;

/** One child of a `wsse:Security` header, in header order; mirrors the engine's `WssTimelineStep`. */
export const wssTimelineStepWireSchema = z.object({
  kind: z.enum(['timestamp', 'username-token', 'token', 'signature', 'encryption', 'other']),
  summary: z.string(),
  covers: z.array(z.string()).optional(),
  id: z.string().optional(),
  actor: z.string().optional(),
});
export type WssTimelineStepWire = z.infer<typeof wssTimelineStepWireSchema>;

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
  /** Every reference's expected and computed digest; signature actions only. */
  check: wssSignatureCheckWireSchema.optional(),
  /** This machine's clock minus `wsu:Created`, in seconds; timestamp actions only. */
  skewSeconds: z.number().optional(),
  /** The clock skew tolerated, in seconds; timestamp actions only. */
  toleranceSeconds: z.number().optional(),
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
      /** The response's `wsse:Security` header, in header order, as it arrived. */
      timeline: z.array(wssTimelineStepWireSchema).optional(),
    })
    .optional(),
});
export type WssExchangeWire = z.infer<typeof wssExchangeWireSchema>;

/** Response payload for `request.send`: a JSON-serialisable projection of `SoapExchange`. */
export const exchangeSummarySchema = z.object({
  /** Where the send went out from (spec §18.4); absent on the desktop. */
  sentFrom: sentFromSchema.optional(),
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
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
  /** What the request's scripts did; absent when it has none, or they are switched off. */
  script: scriptResultWireSchema.optional(),
  /** Set when the request has scripts and they are switched off, so none ran. */
  scriptsOff: z.boolean().optional(),
  /** Set on a row that is not the send itself: `sts` is the token request a send made first. */
  auxiliary: z.literal('sts').optional(),
  /** The `sendId` of the send this auxiliary row belongs to. */
  causedBy: z.string().optional(),
});
export type ExchangeSummary = z.infer<typeof exchangeSummarySchema>;

/** Request/response for `definition.cancelImport`. */
export const definitionCancelImportRequestSchema = z.object({ token: z.string() });
export const definitionCancelImportResponseSchema = z.object({ cancelled: z.boolean() });

/**
 * How a request/endpoint/interface authenticates, as mirrored to the renderer. Never a
 * `password` — only a `passwordRef` into the main-process secret store, which the renderer
 * cannot read back (there is no `secrets.get` channel).
 */
export const endpointAuthSchema = z.object({
  type: z.enum(['none', 'basic', 'ntlm']),
  username: z.string().optional(),
  passwordRef: z.string().optional(),
  /** The committed name CI reads this secret under; the desktop never edits it, only preserves it. */
  passwordEnv: z.string().optional(),
  domain: z.string().optional(),
  workstation: z.string().optional(),
  preemptive: z.boolean().optional(),
});
export type EndpointAuthWire = z.infer<typeof endpointAuthSchema>;

/**
 * What a SOAP interface, endpoint or request may hold on the wire: every {@link authConfigWireSchema}
 * scheme except `inherit` — a SOAP owner has nothing above it to inherit from (see
 * `soapOwnerAuthSchema` on the engine side, which this mirrors).
 */
export const soapOwnerAuthWireSchema = authConfigWireSchema.refine((auth) => auth.type !== 'inherit', {
  message: 'a SOAP interface, endpoint or request cannot inherit',
});
export type SoapOwnerAuthWire = z.infer<typeof soapOwnerAuthWireSchema>;

/** One addressable endpoint of an interface (credentials referenced by `secretRef`, never on the wire). */
export const endpointWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  auth: soapOwnerAuthWireSchema.optional(),
  /** `override` replaces request credentials, `complement` only fills in blanks. */
  authMode: z.enum(['override', 'complement']),
  /** Send even when this endpoint's certificate does not verify. Badged in red wherever it shows. */
  trustInvalid: z.boolean().optional(),
});
export type EndpointWire = z.infer<typeof endpointWireSchema>;

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
  auth: soapOwnerAuthWireSchema.optional(),
  /** The interface-level WS-Addressing defaults every request of it inherits. */
  wsaConfig: wsaConfigWireSchema.optional(),
  /** The interface's scripts, run around every request of every operation (#334). */
  scripts: requestScriptsWireSchema.optional(),
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
   * The on-disk file-system name (without the `.request.yaml` / `.xml` suffix) — `SoapRequestDef.slug`.
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
  auth: soapOwnerAuthWireSchema.optional(),
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
  scripts: requestScriptsWireSchema.optional(),
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
  /**
   * True when this request's operation is no longer in the interface's definition, after an
   * Update Definition dropped it. Nothing is deleted; the explorer badges the row instead.
   */
  orphaned: z.boolean().optional(),
});
export type RequestWire = z.infer<typeof requestWireSchema>;

/** The five X.509 token profile forms a key can be referenced by. */
const X509_KEY_IDENTIFIERS = [
  'BinarySecurityToken',
  'IssuerSerial',
  'SubjectKeyIdentifier',
  'X509KeyIdentifier',
  'Thumbprint',
] as const;

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
    keyIdentifierType: z.enum([...X509_KEY_IDENTIFIERS, 'saml-token']),
    signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']),
    digestAlgorithm: z.enum(['sha256', 'sha1']),
    canonicalization: z.literal('exc-c14n'),
    useSingleCertificate: z.boolean(),
    parts: z.array(
      z.object({
        name: z.string(),
        namespace: z.string(),
        encode: z.enum(['Content', 'Element']),
        /** Covers the nearest earlier SAML token through the STR-Transform. */
        token: z.literal(true).optional(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('encryption'),
    /** The `wss/keystores.yaml` registry id holding the *recipient's* certificate. */
    keystoreRef: z.string(),
    alias: z.string().optional(),
    keyIdentifierType: z.enum(X509_KEY_IDENTIFIERS),
    symmetricAlgorithm: z.enum(['aes128-cbc', 'aes256-cbc', 'aes128-gcm', 'aes256-gcm']),
    keyTransportAlgorithm: z.enum(['rsa-oaep', 'rsa-1_5']),
    embedKey: z.boolean(),
    encryptSymmetricKey: z.boolean(),
    parts: z.array(z.object({ name: z.string(), namespace: z.string(), encode: z.enum(['Content', 'Element']) })),
  }),
  z.object({
    kind: z.literal('issued-token'),
    stsUrl: z.string(),
    soapVersion: z.enum(['1.1', '1.2']),
    trustVersion: z.enum(['1.3', '2005-02']),
    appliesTo: z.string().optional(),
    tokenType: z.enum(['1.1', '2.0']),
    keyType: z.enum(['bearer', 'public-key']),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
    credential: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('username'), username: z.string(), passwordRef: z.string().optional() }),
      z.object({
        kind: z.literal('certificate'),
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
      }),
      z.object({
        kind: z.literal('kerberos'),
        spn: z.string(),
        principal: z.string().optional(),
        username: z.string().optional(),
        domain: z.string().optional(),
        passwordRef: z.string().optional(),
      }),
    ]),
    requestedLifetimeSeconds: z.number().int().nonnegative(),
    claims: z.string().optional(),
    tlsKeystoreRef: z.string().optional(),
  }),
  /** One object for both SAML sources: the outer union is discriminated by `kind` alone. */
  z.object({
    kind: z.literal('saml-token'),
    source: z.enum(['form', 'xml']),
    version: z.enum(['1.1', '2.0']).optional(),
    issuer: z.string().optional(),
    subject: z.string().optional(),
    subjectFormat: z.string().optional(),
    confirmation: z.enum(['bearer', 'holder-of-key', 'sender-vouches']).optional(),
    audience: z.string().optional(),
    lifetimeSeconds: z.number().int().positive().optional(),
    authnContext: z.string().optional(),
    attributes: z
      .array(z.object({ name: z.string(), nameFormat: z.string().optional(), values: z.array(z.string()) }))
      .optional(),
    sign: z
      .object({
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
        signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']),
      })
      .optional(),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
    xml: z.string().optional(),
    file: z.string().optional(),
    expandProperties: z.boolean().optional(),
  }),
  /**
   * An entry this build cannot edit: a kind a later build wrote, or a known kind whose stored
   * shape this build does not understand. Opaque and read-only — the renderer only lists it and
   * can reorder or remove it; the entry itself never leaves main. `index` is its position in the
   * stored list, and main puts the stored entry back in its place on write-back (checking that
   * `originalKind` and `fingerprint` still match, so a stale mirror is refused rather than
   * misapplied).
   */
  z.object({
    kind: z.literal('unknown'),
    originalKind: z.string(),
    index: z.number().int().nonnegative(),
    /** A short hash of the stored entry's content; write-back refuses the entry when it differs. */
    fingerprint: z.string(),
    /** `true` for a known kind whose stored shape is unreadable; `false` for a kind only a newer build knows. */
    unreadable: z.boolean(),
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

/**
 * Request for `project.importLegacy`: a legacy single-XML SOAP project file the user picked. Only a
 * `file` source — the format is a whole project, never pasted — and main still requires the path to
 * be inside an open project or picked in a dialog this session. An empty `newProjectName` takes
 * the name the file gives the project.
 */
export const projectImportLegacyRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  /** Echoed back on `engine.progress` events raised while this import is in flight. */
  token: z.string().optional(),
});
export type ProjectImportLegacyRequest = z.infer<typeof projectImportLegacyRequestSchema>;

/** What a legacy project import brought across, and a line for everything it did not. */
export const legacyImportReportSchema = z.object({
  projectName: z.string(),
  counts: z.object({
    interfaces: z.number(),
    operations: z.number(),
    requests: z.number(),
    environments: z.number(),
    properties: z.number(),
    scripts: z.number(),
  }),
  items: z.array(z.object({ severity: z.enum(['info', 'warning']), path: z.string(), message: z.string() })).readonly(),
});
export type LegacyImportReportWire = z.infer<typeof legacyImportReportSchema>;

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
/**
 * `wss.previewOutgoing`: the secured envelope plus its `wsse:Security` timeline (#57), read from
 * the redacted envelope, so the preview shows exactly what the timeline describes.
 */
export const wssPreviewResponseSchema = z.object({
  envelopeXml: z.string(),
  timeline: z.array(wssTimelineStepWireSchema),
});
export type WssPreviewOutgoingRequest = z.infer<typeof wssPreviewOutgoingRequestSchema>;
export type WssEnvelopeResponse = z.infer<typeof wssEnvelopeResponseSchema>;
export type WssPreviewResponse = z.infer<typeof wssPreviewResponseSchema>;

/**
 * `wss.policyStatus`: the WS-SecurityPolicy of a request's operation as the Auth inspector shows it
 * (#58) — its summary lines, whether the request as configured now satisfies it (each requirement
 * met or not, and why), and the entries "Apply policy" would store. `status` is absent when the
 * operation carries no policy. Main runs the engine's check; the renderer only renders it.
 */
export const wssPolicyStatusRequestSchema = z.object({ requestId: z.string() });
export const wssPolicyStatusResponseSchema = z.object({
  status: z
    .object({
      lines: z.array(z.object({ label: z.string(), value: z.string() })),
      satisfied: z.boolean(),
      results: z.array(z.object({ requirement: z.string(), met: z.boolean(), reason: z.string().optional() })),
      proposal: z.array(wssEntryWireSchema),
      notes: z.array(z.string()),
    })
    .optional(),
});
export type WssPolicyStatusResponse = z.infer<typeof wssPolicyStatusResponseSchema>;

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
