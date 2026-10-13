/**
 * The wire shapes only REST uses (kind modules spec §4.2): APIs, requests and exchanges, event
 * streams, the webhook collection, and the OpenAPI, Postman, HAR, `.http` and cURL imports.
 * Imports `wire-base.ts` and never another kind's file.
 */

import { z } from 'zod';
import { MAX_SEND_ENVIRONMENTS } from '../../multi-env-limits.js';
import {
  MAX_IMPORT_LOCATION_CHARS,
  MAX_IMPORT_NAME_CHARS,
  MAX_IMPORT_TEXT_CHARS,
  MAX_REST_UPDATE_ID_CHARS,
  attachmentSourceWireSchema,
  authConfigWireSchema,
  authSummaryWireSchema,
  cookieWireSchema,
  definitionAuthWireSchema,
  exchangeProblemSchema,
  hasFetchableAuthSource,
  httpExchangeWireSchema,
  keyValueWireSchema,
  onlyWithAUrl,
  openApiSourceSchema,
  projectAddInterfaceTargetSchema,
  requestAssertionResultWireSchema,
  requestAssertionWireSchema,
  requestScriptsWireSchema,
  scriptResultWireSchema,
  unresolvedRefWireSchema,
  webhookSigningWireSchema,
} from '../../wire-base.js';

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
  /** Whether the request's Basic auth has a password: the command's, stored in the keychain, or the dialog's. */
  passwordStored: z.boolean().optional(),
});
export type RequestImportCurlResponse = z.infer<typeof requestImportCurlResponseSchema>;

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
  /** A GraphQL operation (#77): its query, its variables as JSON text (`''` for none), the operation to run. */
  z.object({
    kind: z.literal('graphql'),
    query: z.string(),
    variables: z.string(),
    operationName: z.string().optional(),
  }),
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
  /** Generated headers the request leaves out, by name (`omitHeaders` in the request file). */
  omitHeaders: z.array(z.string()).optional(),
});
export type RestSettingsWire = z.infer<typeof restSettingsWireSchema>;

/**
 * The engine's `HookLink` restated: which OpenAPI `webhooks` or `callbacks` entry a webhook
 * collection item was imported from, so *Update definition* can keep it in step.
 */
export const hookLinkWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('webhook'), name: z.string() }),
  z.object({
    kind: z.literal('callback'),
    /** The parent operation's contract key, e.g. `post /subscriptions`. */
    operation: z.string(),
    name: z.string(),
    /** The callback's path-item key, verbatim, e.g. `{$request.body#/callbackUrl}`. */
    expression: z.string(),
  }),
]);
export type HookLinkWire = z.infer<typeof hookLinkWireSchema>;

/** One project's webhook collection, as the renderer sees it; its tree travels with the REST one. */
export const webhookCollectionWireSchema = z.object({
  /** Synthetic: `webhooks:<projectId>`, never a real API id. */
  id: z.string(),
  projectId: z.string(),
  target: z.string(),
  auth: authConfigWireSchema.optional(),
  signing: webhookSigningWireSchema.optional(),
});
export type WebhookCollectionWire = z.infer<typeof webhookCollectionWireSchema>;

/** A response kept beside a REST request (#64): what came back once, shown read-only, never sent. */
export const restResponseExampleWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.number(),
  statusText: z.string(),
  headers: z.array(keyValueWireSchema),
  contentType: z.string().optional(),
  body: z.string().optional(),
});
export type RestResponseExampleWire = z.infer<typeof restResponseExampleWireSchema>;

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
  scripts: requestScriptsWireSchema.optional(),
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
  orphaned: z.boolean().optional(),
  /** Set only on a webhook collection item imported from an OpenAPI definition. */
  hook: hookLinkWireSchema.optional(),
  /** Webhook items only: overrides the inherited signing. */
  signing: webhookSigningWireSchema.optional(),
  /** Recorded responses; absent when there are none. Only `remove-rest-example` changes them. */
  examples: z.array(restResponseExampleWireSchema).optional(),
});
export type RestRequestWire = z.infer<typeof restRequestWireSchema>;

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
  /** The API's scripts, run around every request in it (#334). */
  scripts: requestScriptsWireSchema.optional(),
  definition: z
    .object({
      source: z.string(),
      cache: z.boolean(),
      version: z.string(),
      /** How the definition document is fetched, as references; separate from the API's own `auth`. */
      auth: authConfigWireSchema.optional(),
    })
    .optional(),
  /** Where the API's GraphQL schema came from, when it has one (#77). */
  graphqlSchema: z.object({ source: z.string(), fetchedAt: z.string() }).optional(),
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
  /** Webhook items only; `null` removes the item's own signing, back to inherit (§5.1). */
  signing: webhookSigningWireSchema.nullable().optional(),
});
export type RestRequestPatchWire = z.infer<typeof restRequestPatchSchema>;

/**
 * One row of a `text/event-stream` response, as the engine's `SseRow` parses it. Mirrors that type
 * field for field; `payloadTruncated` is set only when `capSseRows` stripped an event row's `data`
 * to fit the summary's byte budget.
 */
export const sseRowWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    index: z.number(),
    at: z.number(),
    size: z.number(),
    event: z.string(),
    data: z.string(),
    id: z.string().optional(),
    lastEventId: z.string(),
    payloadTruncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal('comment'),
    index: z.number(),
    at: z.number(),
    size: z.number(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('retry'),
    index: z.number(),
    at: z.number(),
    size: z.number(),
    ms: z.number(),
  }),
]);
export type SseRowWire = z.infer<typeof sseRowWireSchema>;

/**
 * The rows and outcome of an event-stream REST response, once the send resolved — the engine's
 * `RestEventStream` plus `capSseRows(SSE_SUMMARY_LIMITS)`'s own verdict, so a long-running stream's
 * summary never puts every row on the wire at once (the live `rest.live` `row` events already told
 * the renderer about the ones this cap drops).
 */
export const restEventStreamWireSchema = z.object({
  rows: z.array(sseRowWireSchema),
  counts: z.object({
    events: z.number(),
    comments: z.number(),
    retries: z.number(),
    bytes: z.number(),
  }),
  lastEventId: z.string(),
  retryMs: z.number().optional(),
  endedBy: z.enum(['server', 'client', 'error']),
  error: z.string().optional(),
  /** Rows the engine's in-memory store had already evicted before the summary was built. */
  droppedRows: z.number(),
  /** `capSseRows` cut further rows to fit the summary's own byte budget. */
  truncated: z.boolean(),
  /** How many rows `capSseRows` omitted, on top of `droppedRows`. */
  omittedRows: z.number(),
  // The total number of rows missing from `rows` compared to the live stream is `droppedRows +
  // omittedRows`: the former left the in-memory store before this summary was ever built, the
  // latter were in it but didn't fit this summary's own cap.
});
export type RestEventStreamWire = z.infer<typeof restEventStreamWireSchema>;

/**
 * What one REST send produced. The same `http` projection a SOAP exchange carries — so the HTTP
 * log, the raw view and the timing waterfall are one implementation — plus what the body turned out
 * to be.
 */
/**
 * How a REST response compared with the OpenAPI contract of the operation it answered — the engine's
 * `RestContractResult`. Problems carry a JSON Pointer and a message. A pointer does contain the body's
 * property names (keys are structure); the body's values are never copied — messages name only the
 * schema's side ("below the minimum 0").
 */
export const restContractResultSchema = z.object({
  status: z.enum(['ok', 'violation', 'unmatched', 'no-schema', 'no-contract', 'skipped', 'not-checked']),
  operation: z.object({ method: z.string(), path: z.string() }).optional(),
  responseKey: z.string().optional(),
  mediaType: z.string().optional(),
  problems: z.array(z.object({ path: z.string(), keyword: z.string(), message: z.string() })),
  notes: z.array(z.string()),
});
export type RestContractResultWire = z.infer<typeof restContractResultSchema>;

/**
 * A GraphQL response checked (#77), the engine's `GraphqlCheckResult`: every entry of its `errors`
 * array, and where its `data` does not match the operation and the API's schema. `schema` says how
 * far the data check got.
 */
export const graphqlCheckWireSchema = z.object({
  schema: z.enum(['checked', 'no-schema', 'no-query', 'skipped', 'not-graphql']),
  errors: z.array(
    z.object({
      message: z.string(),
      path: z.array(z.union([z.string(), z.number()])).optional(),
      pointer: z.string(),
    }),
  ),
  problems: z.array(z.object({ pointer: z.string(), message: z.string() })),
});
export type GraphqlCheckWire = z.infer<typeof graphqlCheckWireSchema>;

export const restExchangeSummarySchema = z.object({
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
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
  /** Present only when the response was a `text/event-stream` and the send asked to parse it as one. */
  stream: restEventStreamWireSchema.optional(),
  /**
   * The response checked against its operation's contract. Absent when nothing could be checked:
   * a stream, a non-JSON body, or a request whose API has no cached definition.
   */
  contract: restContractResultSchema.optional(),
  /** A GraphQL request's response, checked; absent for any other request (#77). */
  graphql: graphqlCheckWireSchema.optional(),
  /** What the request's scripts did; absent when it has none, or they are switched off. */
  script: scriptResultWireSchema.optional(),
  /** Set when the request has scripts and they are switched off, so none ran. */
  scriptsOff: z.boolean().optional(),
});
export type RestExchangeSummary = z.infer<typeof restExchangeSummarySchema>;

/**
 * One report from a REST send whose response is a `text/event-stream`, correlated to the invoke by
 * `sendId`. `request.sendRest` stays open for the life of the stream and still resolves with the
 * whole exchange (`stream` on its summary); these say what has arrived so far, the same
 * relationship `grpcLiveEventSchema` and `wsLiveEventSchema` have to their own invokes. A renderer
 * that ignores them sees exactly the behaviour it saw before streaming existed.
 */
export const restLiveEventSchema = z.discriminatedUnion('kind', [
  /** The response's status and headers, the moment they arrive — before any row. */
  z.object({
    kind: z.literal('open'),
    sendId: z.string(),
    status: z.number(),
    headers: z.record(z.string(), z.string()),
  }),
  /** One row, in arrival order. */
  z.object({ kind: z.literal('row'), sendId: z.string(), row: sseRowWireSchema }),
]);
export type RestLiveEvent = z.infer<typeof restLiveEventSchema>;

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

/**
 * Request payload for `request.sendToEnvironments`: one saved request sent under several of the
 * project's environments at once, the active environment left as it is. Strict, and with no
 * endpoint field: main resolves the endpoint (or base URL) per environment, never the renderer.
 * `batchId` names the whole fan-out for `request.cancel`; each child send is `${batchId}:${envId}`.
 */
export const requestSendToEnvironmentsRequestSchema = z
  .object({
    batchId: z.string(),
    requestId: z.string(),
    environmentIds: z.array(z.string()).min(2).max(MAX_SEND_ENVIRONMENTS),
    /** The SOAP editor's unsaved envelope and headers, used for every environment. */
    soap: z.object({ envelopeXml: z.string(), headers: z.record(z.string(), z.string()).optional() }).optional(),
    /** The REST editor's unsaved edits, used for every environment. */
    restDraft: restRequestPatchSchema.optional(),
  })
  .strict();
export type RequestSendToEnvironmentsRequest = z.infer<typeof requestSendToEnvironmentsRequestSchema>;

/** Request payload for `request.preflightRest`: the same pair, with nothing sent. */
export const requestPreflightRestRequestSchema = z.object({
  requestId: z.string(),
  draft: restRequestPatchSchema.optional(),
  /**
   * The caller wants the secret-source warnings only, as a send does beside itself. Main then answers
   * the empty preflight, without resolving the request, when no `${secret:name}` is mapped.
   */
  secretsOnly: z.boolean().optional(),
});

/** Request payload for `request.restHeaders`: which REST request, and the editor's unsaved edits. */
export const requestRestHeadersRequestSchema = z.object({
  requestId: z.string(),
  draft: restRequestPatchSchema.optional(),
});
export type RequestRestHeadersRequest = z.infer<typeof requestRestHeadersRequestSchema>;

/**
 * One header a REST send would put on the wire: the engine's `RestHeaderRow`, its value masked unless
 * the session shows secrets (`masked` says so).
 */
export const restHeaderRowWireSchema = z.object({
  name: z.string(),
  value: z.string(),
  source: z.enum(['preference', 'auth', 'body', 'cookie', 'typed', 'transport', 'handshake']),
  state: z.enum(['sent', 'overridden', 'omitted', 'merged']),
  masked: z.boolean().optional(),
});
export type RestHeaderRowWire = z.infer<typeof restHeaderRowWireSchema>;

/** Response payload for `request.restHeaders`: every header, and what the preview could not know. */
export const requestRestHeadersResponseSchema = z.object({
  headers: z.array(restHeaderRowWireSchema),
  notes: z.array(z.string()).optional(),
});
export type RequestRestHeadersResponse = z.infer<typeof requestRestHeadersResponseSchema>;

/**
 * Request payload for `request.restBodySchema`: which REST request, and the editor's unsaved edits,
 * so the operation is looked up by the method and URL the tab shows rather than the saved ones.
 */
export const requestRestBodySchemaRequestSchema = z.object({
  requestId: z.string(),
  draft: restRequestPatchSchema.optional(),
});
export type RequestRestBodySchemaRequest = z.infer<typeof requestRestBodySchemaRequestSchema>;

/**
 * Response payload for `request.restBodySchema`: the JSON media type and the (acyclic) schema of the
 * body the request's operation declares, or `null` when there is none. The schema is kept as plain
 * JSON data; the engine's `JsonSchema` type is what the renderer reads it as.
 */
export const requestRestBodySchemaResponseSchema = z
  .object({ mediaType: z.string(), schema: z.record(z.string(), z.unknown()) })
  .nullable();
export type RequestRestBodySchemaResponse = z.infer<typeof requestRestBodySchemaResponseSchema>;

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
  /** Webhook and callback methods the document offered, mapped into the project's webhook group. */
  webhooks: z.number(),
});
export type OpenApiImportSummaryWire = z.infer<typeof openApiImportSummarySchema>;

/** One webhook or callback method of an OpenAPI document, restated for the wire. */
export const webhookItemWireSchema = z.object({
  key: z.string(),
  kind: z.enum(['webhook', 'callback']),
  name: z.string(),
  method: z.string(),
  label: z.string(),
});
export type WebhookItemWire = z.infer<typeof webhookItemWireSchema>;

/** Request/response for `api.importOpenApi`. The target is the same union a WSDL import takes. */
export const apiImportOpenApiRequestSchema = z
  .object({
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
    /** Credentials for fetching the document, recorded on the API for Update Definition. URL sources only. */
    auth: definitionAuthWireSchema.optional(),
    /** Also import the document's webhooks and callbacks into the project's webhook group. Defaults to `true`. */
    webhooks: z.boolean().optional(),
  })
  .refine(hasFetchableAuthSource, onlyWithAUrl);
export type ApiImportOpenApiRequest = z.infer<typeof apiImportOpenApiRequestSchema>;

/**
 * Where a REST update reads the new definition from: a URL, or a file that passes the same path check
 * an import does. Absent, the API's recorded `definition.source` is read again.
 */
export const restUpdateSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    // Only http(s): a `file:` location would be read straight off disk by the fetcher, skipping the
    // path check that guards `kind: 'file'`.
    url: z
      .string()
      .max(MAX_IMPORT_LOCATION_CHARS)
      .regex(/^https?:\/\//i, 'Only http and https URLs can be read'),
    /** Credentials for this URL; an apply records them on the API, and none clears the stored ones. */
    auth: definitionAuthWireSchema.optional(),
  }),
  z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
]);
export type RestUpdateSourceWire = z.infer<typeof restUpdateSourceSchema>;

const restOpRefSchema = z.object({ method: z.string(), path: z.string(), summary: z.string().optional() });

/** The reasons a REST or webhook operation's contract is reported as changed. */
const restChangeReasonSchema = z.enum(['parameters', 'request-body', 'responses', 'security', 'servers']);

/**
 * What updating an OpenAPI-imported API's webhooks and callbacks would change, mirroring
 * {@link restUpdatePlanSchema} over `WebhookItemWire` instead of an operation ref. `linked` says
 * whether the project currently has a webhook group linked to this API at all — the added/removed/
 * changed lists compare the *document*, not the project, so a plan can list items to add even when
 * there is nothing linked yet to add them to.
 */
export const webhookUpdatePlanSchema = z.object({
  added: z.array(webhookItemWireSchema),
  removed: z.array(webhookItemWireSchema),
  changed: z.array(z.object({ item: webhookItemWireSchema, reasons: z.array(restChangeReasonSchema) })),
  linked: z.boolean(),
});
export type WebhookUpdatePlanWire = z.infer<typeof webhookUpdatePlanSchema>;

/** What updating an OpenAPI-imported REST API would change, per operation and API-wide (`api.restPlanUpdate`). */
export const restUpdatePlanSchema = z.object({
  added: z.array(restOpRefSchema),
  removed: z.array(restOpRefSchema),
  changed: z.array(z.object({ op: restOpRefSchema, reasons: z.array(restChangeReasonSchema) })),
  api: z.array(z.enum(['servers', 'security', 'version'])),
  webhooks: webhookUpdatePlanSchema,
});
export type RestUpdatePlanWire = z.infer<typeof restUpdatePlanSchema>;

export const apiRestPlanUpdateRequestSchema = z.object({
  apiId: z.string().max(MAX_REST_UPDATE_ID_CHARS),
  source: restUpdateSourceSchema.optional(),
});
export type ApiRestPlanUpdateRequest = z.infer<typeof apiRestPlanUpdateRequestSchema>;

/**
 * `api.restPlanUpdate`'s answer: the plan, and a sha256 of the documents it was made from, which
 * `api.restApplyUpdate` must be handed back so it never applies a source that changed since.
 */
export const apiRestPlanUpdateResponseSchema = restUpdatePlanSchema.extend({
  /** What the preview actually read, so the dialog can name a recorded source it never chose. */
  source: z.string(),
  fingerprint: z.string(),
});
export type ApiRestPlanUpdateResponse = z.infer<typeof apiRestPlanUpdateResponseSchema>;

export const apiRestApplyUpdateRequestSchema = apiRestPlanUpdateRequestSchema.extend({
  /** The plan's SHA-256 fingerprint, 64 lower-case hex characters. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApiRestApplyUpdateRequest = z.infer<typeof apiRestApplyUpdateRequestSchema>;

/** Request/response for `api.webhookItems`: an API's webhooks and callbacks, for the import picker. */
export const apiWebhookItemsRequestSchema = z.object({ apiId: z.string().max(MAX_REST_UPDATE_ID_CHARS) });
export type ApiWebhookItemsRequest = z.infer<typeof apiWebhookItemsRequestSchema>;

export const apiWebhookItemsResponseSchema = z.object({
  items: z.array(webhookItemWireSchema),
  /** Keys ({@link WebhookItemWire.key}) already present in the group linked to this API. */
  imported: z.array(z.string()),
});
export type ApiWebhookItemsResponse = z.infer<typeof apiWebhookItemsResponseSchema>;

/** Request for `api.restLint`: lint one REST API's cached definition with the project's rule sets. */
export const apiRestLintRequestSchema = z.object({ apiId: z.string().max(MAX_REST_UPDATE_ID_CHARS) });
export type ApiRestLintRequest = z.infer<typeof apiRestLintRequestSchema>;

const lintPositionWireSchema = z.object({ line: z.number().int(), column: z.number().int() });

/** One lint finding as Problems shows it; `source` is the cached document's location. */
export const lintFindingWireSchema = z.object({
  rule: z.string().max(200),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  message: z.string().max(4000),
  path: z.string().max(4000),
  source: z.string().max(4000),
  range: z.object({ start: lintPositionWireSchema, end: lintPositionWireSchema }).optional(),
});
export type LintFindingWire = z.infer<typeof lintFindingWireSchema>;

export const apiRestLintResponseSchema = z.object({ findings: z.array(lintFindingWireSchema).max(10_000) });
export type ApiRestLintResponse = z.infer<typeof apiRestLintResponseSchema>;

/** Request/response for `api.importWebhooks`: places the chosen items into the linked webhook group. */
export const apiImportWebhooksRequestSchema = z.object({
  apiId: z.string().max(MAX_REST_UPDATE_ID_CHARS),
  /** Keys ({@link WebhookItemWire.key}) to import; already-present ones are ignored. */
  keys: z.array(z.string().max(500)).min(1).max(500),
});
export type ApiImportWebhooksRequest = z.infer<typeof apiImportWebhooksRequestSchema>;

export const apiImportWebhooksResponseSchema = z.object({
  folderId: z.string(),
  /** How many of the requested keys were newly placed — already-present ones are not counted. */
  added: z.number(),
});
export type ApiImportWebhooksResponse = z.infer<typeof apiImportWebhooksResponseSchema>;

/**
 * Source for Postman collection import: file path or pasted JSON text. A dropped file is text too,
 * with `location` `dropped:<file name>` as for {@link importSourceSchema}; only the file name is
 * read from it, never a path.
 */
export const postmanSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().max(MAX_IMPORT_LOCATION_CHARS) }),
  z.object({
    kind: z.literal('text'),
    text: z.string().max(MAX_IMPORT_TEXT_CHARS),
    location: z.string().max(MAX_IMPORT_LOCATION_CHARS).optional(),
  }),
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
  /** How many collection variables became project properties. */
  projectProperties: z.number().optional(),
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

/** How many names a merge added, and the ones it left alone because they already existed. */
const mergeOutcomeSchema = z.object({ added: z.number(), skipped: z.array(z.string()).readonly() });

/** What an import of variables did: environments created, properties merged, secrets stored. */
export const importVariablesSummarySchema = z.object({
  environments: z
    .array(z.object({ name: z.string(), renamedFrom: z.string().optional(), variables: z.number() }))
    .readonly(),
  globals: mergeOutcomeSchema.optional(),
  workspaceProperties: mergeOutcomeSchema.optional(),
  projectProperties: mergeOutcomeSchema.optional(),
  secretsStored: z.number(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
});
export type ImportVariablesSummaryWire = z.infer<typeof importVariablesSummarySchema>;

/** Request payload for `api.importHar`: a browser capture, read as REST APIs. */
export const apiImportHarRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: postmanSourceSchema,
  /** Keep images, fonts, scripts and stylesheets as requests too. */
  includeStaticAssets: z.boolean().default(false),
  /** What becomes of the recorded responses: nothing, History entries, or saved examples. */
  responses: z.enum(['drop', 'history', 'examples']).default('drop'),
});
export type ApiImportHarRequest = z.infer<typeof apiImportHarRequestSchema>;

/** Request payload for `api.inspectHttpFile`: a `.http` file whose environment files are looked for beside it. */
export const apiInspectHttpFileRequestSchema = z.object({ path: z.string().max(MAX_IMPORT_LOCATION_CHARS) });
export type ApiInspectHttpFileRequest = z.infer<typeof apiInspectHttpFileRequestSchema>;

/** Response payload for `api.inspectHttpFile`: the environment names beside the file, never a value. */
export const apiInspectHttpFileResponseSchema = z.object({ environments: z.array(z.string()).readonly() });
export type ApiInspectHttpFileResponse = z.infer<typeof apiInspectHttpFileResponseSchema>;

/** Request payload for `api.importHttpFile`: a `.http` request file, read as a REST API (and a WebSocket one). */
export const apiImportHttpFileRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema,
  source: postmanSourceSchema,
  /** For a file source, also import the environment files beside it. */
  includeEnvironments: z.boolean().default(true),
});
export type ApiImportHttpFileRequest = z.infer<typeof apiImportHttpFileRequestSchema>;

/**
 * Request payload for `api.importHttpEnv`: a `.http` environment file on its own, applied to the
 * workspace. A picked file brings its public or private partner beside it; text is the public file,
 * unless it was dropped from a file named `http-client.private.env.json`.
 */
export const apiImportHttpEnvRequestSchema = z.object({ source: postmanSourceSchema });
export type ApiImportHttpEnvRequest = z.infer<typeof apiImportHttpEnvRequestSchema>;

/** Request payload for `api.importPostmanEnvironment` and `api.importPostmanGlobals`. */
export const apiImportPostmanVariablesRequestSchema = z.object({ source: postmanSourceSchema });
export type ApiImportPostmanVariablesRequest = z.infer<typeof apiImportPostmanVariablesRequestSchema>;

/** Response payload for `api.importPostmanEnvironment` and `api.importPostmanGlobals`. */
export const apiImportPostmanVariablesResponseSchema = z.object({
  summary: importVariablesSummarySchema,
  /** The import report as plain text, for the copy button; empty when there is nothing to say. */
  reportText: z.string(),
});
export type ApiImportPostmanVariablesResponse = z.infer<typeof apiImportPostmanVariablesResponseSchema>;

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

/** Request payload for `history.resendRest`: sends a past REST entry through its saved request. */
export const historyResendRestRequestSchema = z.object({ id: z.string() });
