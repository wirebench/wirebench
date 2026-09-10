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

/** Basic-auth credentials for fetching a definition (and any of its imports). */
export const importAuthSchema = z.object({ username: z.string(), password: z.string() });

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

/** Response payload for `request.send`: a JSON-serialisable projection of `SoapExchange`. */
export const exchangeSummarySchema = z.object({
  sendId: z.string(),
  durationMs: z.number(),
  http: httpExchangeWireSchema,
  response: soapResponseWireSchema.optional(),
  problems: z.array(exchangeProblemSchema),
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
