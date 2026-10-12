/**
 * The wire shapes no protocol kind owns (kind modules spec §4.2): what core channels carry, and the
 * pieces two kinds share (key/value rows, the HTTP exchange, TLS details, the folder REST, gRPC and
 * WebSocket use, definition auth). A kind's own shapes are in `kinds/<kind>/wire.ts`, which import
 * this file and never another kind's; `wire-types.ts` composes them.
 *
 * Every shape here must be plain JSON: no DOM nodes, no `Uint8Array` (bytes cross the wire
 * as base64 strings), no functions.
 */

import { z } from 'zod';
import { isEnvironmentColor } from './environment-colors.js';

/** The longest URL/path an import source may carry — well past any real one, and bounded. */
export const MAX_IMPORT_LOCATION_CHARS = 4096;
/** Longest pasted OpenAPI or Postman document an import accepts, in characters. */
export const MAX_IMPORT_TEXT_CHARS = 50_000_000;
/** Longest name override an OpenAPI or Postman import accepts. */
export const MAX_IMPORT_NAME_CHARS = 200;

/**
 * Basic-auth credentials for fetching a definition (and any of its imports). The password NEVER
 * crosses the wire as plaintext: the caller stores it via `secrets.set` first and sends the
 * resulting `secretRef`, which main resolves at send/fetch time. `password` is deliberately
 * absent from this schema — zod strips/rejects it, so a plaintext password sent by mistake
 * fails validation rather than silently reaching a project file or a log.
 */
export const importAuthSchema = z.union([
  // `.strict()`: an unknown key is a hard error, not silently stripped — so a caller that
  // sends a plaintext `password` fails validation loudly instead of having it quietly dropped
  // (or, worse, one day passed through to a project file).
  z.object({ username: z.string(), passwordRef: z.string() }).strict(),
  // Kerberos with the signed-in ticket; an explicit account is set on the interface afterwards.
  z.object({ type: z.literal('kerberos'), spn: z.string().optional() }).strict(),
]);
export type ImportAuthWire = z.infer<typeof importAuthSchema>;

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

/** One redirect hop; `upgrade` marks the same-host `http://` → `https://` hop, resent as written (#71). */
const redirectWireSchema = z.object({ url: z.string(), status: z.number(), upgrade: z.literal(true).optional() });

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
export const httpExchangeWireSchema = z.object({
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
  /**
   * The query parameter and header names an API key travelled under, whatever they are called, so
   * a later redaction of this exchange (a HAR export, a log row's cURL) masks them as the send did.
   * Names only, never values; absent when the send carried no API key.
   */
  keyNames: z.object({ params: z.array(z.string()), headers: z.array(z.string()) }).optional(),
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
  protocol: z.enum(['soap', 'rest', 'grpc', 'websocket']),
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

export const exchangeProblemSchema = z.object({ code: z.string(), message: z.string() });

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
  code: z.enum([
    'missing',
    'unknown-scope',
    'cycle',
    'too-deep',
    'malformed',
    'name-from-response',
    'bad-arguments',
    'secret-source-invalid',
    'secret-source-untrusted',
  ]),
  start: z.number(),
  end: z.number(),
  via: z.array(z.string()).optional(),
  field: expansionFieldSchema.optional(),
  /** Set only when `field` is `'header'`: the (unexpanded) name of the header it was found in. */
  headerName: z.string().optional(),
});
export type UnresolvedRefWire = z.infer<typeof unresolvedRefWireSchema>;

/**
 * Where the credentials a send would use come from, and what they look like without the
 * secret: the renderer needs to explain inheritance in the Auth inspector, and a password
 * never crosses IPC (only its `passwordRef` is ever stored, and that stays in main).
 */
export const requestAuthSourceSchema = z.object({
  /** `api` and `folder` are the REST chain's links; the rest are a SOAP request's. */
  source: z.enum(['request', 'endpoint', 'interface', 'folder', 'api', 'none']),
  type: z.enum(['none', 'basic', 'ntlm', 'bearer', 'api-key', 'oauth2', 'kerberos']),
  username: z.string().optional(),
  preemptive: z.boolean().optional(),
  /** Name of the endpoint the credentials came from, when `source` is `'endpoint'`. */
  endpointName: z.string().optional(),
  /** The endpoint's auth mode, so the UI can say "override" or "complement". */
  authMode: z.enum(['override', 'complement']).optional(),
});
export type RequestAuthSourceWire = z.infer<typeof requestAuthSourceSchema>;

/** Where the editor's "Edit" link for a variable goes: the tab that edits its scope (#340). */
export const variableEditTargetWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('environment'), id: z.string() }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('globals') }),
]);
export type VariableEditTargetWire = z.infer<typeof variableEditTargetWireSchema>;

/**
 * One variable a request can reference, as its send would resolve it (#340). `value` is the value
 * with its own references expanded, and is absent when `masked`: a value that reaches a
 * `${secret:…}` token or a `${#System#…}` variable never crosses to the renderer.
 */
export const requestVariableWireSchema = z.object({
  name: z.string(),
  scope: z.enum(['Env', 'Project', 'Workspace', 'Global', 'System']),
  value: z.string().optional(),
  masked: z.boolean(),
  /** The secret a masked value reads, when it reads one directly. */
  secretName: z.string().optional(),
  /** A nearer scope defines the same name, so the shorthand `${name}` does not reach this one. */
  shadowed: z.boolean(),
  edit: variableEditTargetWireSchema.optional(),
});
export type RequestVariableWire = z.infer<typeof requestVariableWireSchema>;

/** Request payload for `request.variables`. */
export const requestVariablesRequestSchema = z.object({ requestId: z.string() });

/** Response payload for `request.variables`: the variables in scope, and the secret names (never values). */
export const requestVariablesResponseSchema = z.object({
  entries: z.array(requestVariableWireSchema),
  secretNames: z.array(z.string()),
});
export type RequestVariablesResponse = z.infer<typeof requestVariablesResponseSchema>;

/** Request payload for `request.preflight`. */
export const requestPreflightRequestSchema = z.object({ requestId: z.string() });

/** What authentication did during a send; mirrors the engine's `AuthSummary`. */
export const authSummaryWireSchema = z.object({
  scheme: z.enum(['basic', 'ntlm', 'bearer', 'api-key', 'oauth2', 'kerberos']),
  challenged: z.boolean(),
  attempts: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  spn: z.string().optional(),
});
export type AuthSummaryWire = z.infer<typeof authSummaryWireSchema>;

/**
 * What a request's scripts did in one send (#63): the tests they recorded, their log, and a
 * post-response script's failure. Every string is masked before it leaves main.
 */
export const scriptResultWireSchema = z.object({
  tests: z.array(z.object({ name: z.string(), passed: z.boolean(), message: z.string().optional() })),
  log: z.array(z.string()),
  /** The log reached its cap and later lines were dropped. */
  truncated: z.boolean(),
  /** A post-response script that failed: the response is kept, and this says why the script did not finish. */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /**
   * Each script that ran, in order (#334): the API's or interface's, each folder's, then the
   * request's own. Its tests, log and failure, which the flat fields above join together.
   */
  levels: z
    .array(
      z.object({
        level: z.enum(['api', 'interface', 'folder', 'request']),
        name: z.string(),
        phase: z.enum(['pre', 'post']),
        tests: z.array(z.object({ name: z.string(), passed: z.boolean(), message: z.string().optional() })),
        log: z.array(z.string()),
        truncated: z.boolean(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
    )
    .optional(),
});
export type ScriptResultWire = z.infer<typeof scriptResultWireSchema>;

/**
 * One of a request's own assertions as an editor Send checked it (request-assertions spec §6). A
 * callback assertion is `not-checked`: only a run waits for a callback. Every string is masked.
 */
export const requestAssertionResultWireSchema = z.object({
  type: z.string(),
  label: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored', 'not-checked']),
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
});
export type RequestAssertionResultWire = z.infer<typeof requestAssertionResultWireSchema>;

/** Request/response for `request.cancel`. */
export const requestCancelRequestSchema = z.object({ sendId: z.string() });
export const requestCancelResponseSchema = z.object({ cancelled: z.boolean() });

/** A file-open filter group, mirroring Electron's `dialog.showOpenDialog` `filters` option. */
const dialogFilterSchema = z.object({ name: z.string(), extensions: z.array(z.string()) });

/** Request/response for `dialogs.openFile`. */
export const dialogsOpenFileRequestSchema = z.object({
  filters: z.array(dialogFilterSchema).optional(),
  title: z.string().optional(),
});
export const dialogsOpenFileResponseSchema = z.object({ path: z.string().optional() });

/**
 * Request/response for `dialogs.openFolder`: a native folder picker for a folder to import from,
 * recorded as a read pick exactly as an opened file is.
 */
export const dialogsOpenFolderRequestSchema = z.object({ title: z.string().optional() });
export const dialogsOpenFolderResponseSchema = z.object({ path: z.string().optional() });

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

/** One HTTP header of a saved request, in author-defined order (duplicates allowed). A SOAP
 * request's row may be switched off (`enabled: false`, kept but not sent) and carry a description. */
export const headerEntrySchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});
export type HeaderEntryWire = z.infer<typeof headerEntrySchema>;

/**
 * Authentication as it crosses the bridge: the same eight schemes the engine models, with every
 * credential a `secretRef`. There is no channel that returns a secret *value* (ADR-0004), so a
 * renderer can configure a token it can never read back.
 */
export const authConfigWireSchema = z.object({
  type: z.enum(['inherit', 'none', 'basic', 'ntlm', 'bearer', 'api-key', 'oauth2', 'kerberos']),
  /** Kerberos: the service principal, and the ticket-cache principal to pick. */
  spn: z.string().optional(),
  principal: z.string().optional(),
  username: z.string().optional(),
  passwordRef: z.string().optional(),
  /** The committed name CI reads this secret under; the desktop never edits it, only preserves it. */
  passwordEnv: z.string().optional(),
  domain: z.string().optional(),
  workstation: z.string().optional(),
  preemptive: z.boolean().optional(),
  tokenRef: z.string().optional(),
  tokenEnv: z.string().optional(),
  scheme: z.string().optional(),
  name: z.string().optional(),
  valueRef: z.string().optional(),
  valueEnv: z.string().optional(),
  in: z.enum(['header', 'query']).optional(),
  grant: z.enum(['client-credentials', 'authorization-code']).optional(),
  tokenUrl: z.string().optional(),
  authorizationUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecretRef: z.string().optional(),
  clientSecretEnv: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  clientAuth: z.enum(['basic', 'body']).optional(),
  pkce: z.boolean().optional(),
  refreshTokenRef: z.string().optional(),
});
export type AuthConfigWire = z.infer<typeof authConfigWireSchema>;

/** Whether the definition behind an interface has been (re)loaded into the engine yet. */
export const hydrationStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type HydrationStatus = z.infer<typeof hydrationStatusSchema>;

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

/**
 * A request's scripts as the renderer sees and edits them (#63): the text of each, not a file name,
 * since the files are always named after the request's slug.
 */
export const requestScriptsWireSchema = z.object({
  pre: z.string().optional(),
  post: z.string().optional(),
  api: z.enum(['wirebench', 'postman']),
  /** False keeps the scripts but runs none of them, as an imported Postman collection's are. */
  enabled: z.boolean(),
  /** The secrets a script may read with `secrets.get`, named as the engine's `SECRET_NAME_PATTERN` allows. */
  secrets: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  timeoutMs: z.number().int().positive().max(10_000).optional(),
  /** Set when a script file could not be used; the request refuses to send until it is fixed. */
  problems: z
    .array(z.object({ phase: z.enum(['pre', 'post']), code: z.enum(['script-file-missing', 'script-too-large']) }))
    .optional(),
});
export type RequestScriptsWire = z.infer<typeof requestScriptsWireSchema>;

/**
 * An edit to a request's scripts, for `update-request-scripts`. Only the fields present change; a
 * `null` script removes that script and its file, and a `null` timeout goes back to the default.
 * A request without scripts gets them, on the typed API and switched on.
 */
export const requestScriptsPatchSchema = z.object({
  pre: z.string().nullable().optional(),
  post: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  secrets: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(100)
    .optional(),
  timeoutMs: z.number().int().positive().max(10_000).nullable().optional(),
});
export type RequestScriptsPatchWire = z.infer<typeof requestScriptsPatchSchema>;

const assertionNameWire = z.string().optional();

const callbackCheckFields = {
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
};
const callbackHeaderWire = z.object({ name: z.string(), ...callbackCheckFields });
const callbackBodyWire = z.object({
  language: z.enum(['jsonpath', 'xpath']),
  path: z.string(),
  ...callbackCheckFields,
});

const statusAssertionWire = z.object({
  type: z.literal('status'),
  equals: z.union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))]),
  name: assertionNameWire,
});
const soapFaultAssertionWire = z.object({
  type: z.literal('soap-fault'),
  expect: z.enum(['none', 'present']),
  name: assertionNameWire,
});
const matchAssertionWire = z.object({
  type: z.literal('match'),
  language: z.enum(['xpath', 'xquery', 'jsonpath']),
  expression: z.string(),
  namespaces: z.record(z.string(), z.string()).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name: assertionNameWire,
});
const schemaAssertionWire = z.object({ type: z.literal('schema'), name: assertionNameWire });
const slaAssertionWire = z.object({
  type: z.literal('sla'),
  maxMs: z.number().int().positive(),
  name: assertionNameWire,
});
const headerAssertionWire = z.object({
  type: z.literal('header'),
  header: z.string(),
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name: assertionNameWire,
});
const callbackAssertionWire = z.object({
  type: z.literal('callback'),
  catchUrl: z.string(),
  withinMs: z.number().int(),
  match: z.object({
    method: z.string().optional(),
    path: z.string().optional(),
    pathMatches: z.string().optional(),
    headers: z.array(callbackHeaderWire).optional(),
    body: callbackBodyWire.optional(),
  }),
  expect: z.array(
    z.union([
      z.object({ body: callbackBodyWire }),
      z.object({ header: callbackHeaderWire }),
      z.object({ signature: z.literal('verified') }),
    ]),
  ),
  name: assertionNameWire,
});

const requestAssertionUnion = z.discriminatedUnion('type', [
  statusAssertionWire,
  soapFaultAssertionWire,
  matchAssertionWire,
  schemaAssertionWire,
  slaAssertionWire,
  callbackAssertionWire,
]);
// Each kind is named by an interface so the IPC channel registry's inferred type prints it by name
// instead of expanding it at every request wire (which overflows the compiler's serialisation limit).
/* eslint-disable @typescript-eslint/no-empty-object-type -- named, not expanded: see above */
export interface StatusAssertionWire extends z.infer<typeof statusAssertionWire> {}
export interface SoapFaultAssertionWire extends z.infer<typeof soapFaultAssertionWire> {}
export interface MatchAssertionWire extends z.infer<typeof matchAssertionWire> {}
export interface SchemaAssertionWire extends z.infer<typeof schemaAssertionWire> {}
export interface SlaAssertionWire extends z.infer<typeof slaAssertionWire> {}
export interface CallbackAssertionWire extends z.infer<typeof callbackAssertionWire> {}
/* eslint-enable @typescript-eslint/no-empty-object-type */
export type RequestAssertionWire =
  | StatusAssertionWire
  | SoapFaultAssertionWire
  | MatchAssertionWire
  | SchemaAssertionWire
  | SlaAssertionWire
  | CallbackAssertionWire;
/**
 * One assertion a request may carry: the step catalogue without `header`, which only a step may use.
 * Annotated with its named type so the IPC channel registry's inferred type stays serialisable.
 */
export const requestAssertionWireSchema: z.ZodType<RequestAssertionWire> = requestAssertionUnion;

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
  /** A palette name or `#rrggbb` (#345), as the file holds it; absent means no colour. */
  color: z.string().optional(),
  /** True asks before every send under this environment (#345); absent means false. */
  protected: z.boolean().optional(),
});
export type EnvironmentWire = z.infer<typeof environmentWireSchema>;

/**
 * A container the desktop shows as a placeholder (kind modules spec §7.1): one whose kind is switched
 * off (`feature-disabled`), or one of a kind this version does not know (`unknown-kind`). The engine
 * still loads and saves it; nothing in the desktop can change it.
 */
export const unsupportedContainerWireSchema = z.object({
  /** A container folder (`interfaces`, `apis`), or a project-level folder of a kind that is off (`webhooks`, `wss`). */
  dir: z.string(),
  slug: z.string(),
  kind: z.string(),
  reason: z.enum(['unknown-kind', 'feature-disabled']),
  name: z.string().optional(),
  order: z.number().optional(),
});
export type UnsupportedContainerWire = z.infer<typeof unsupportedContainerWireSchema>;

/** A recoverable inconsistency found while loading (or hydrating) a project folder. */
export const projectProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Path relative to the project root, or the interface id for a hydration failure. */
  file: z.string(),
});
export type ProjectProblemWire = z.infer<typeof projectProblemSchema>;

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
  /** The committed name CI reads this secret under; the desktop never edits it, only preserves it. */
  passwordEnv: z.string().optional(),
  defaultAlias: z.string().optional(),
});
export type KeystoreWire = z.infer<typeof keystoreWireSchema>;

/** One params, query, header or form row. */
export const keyValueWireSchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});
export type KeyValueWire = z.infer<typeof keyValueWireSchema>;

/**
 * The engine's `SignatureScheme` restated (webhook-signatures §2). Main re-validates with the
 * engine's schema (`toEngineSigning`); these only check the shape crossing the bridge.
 */
export const signatureSchemeWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hmac'),
    algorithm: z.enum(['sha1', 'sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
    header: z.string(),
    prefix: z.string().optional(),
  }),
  z.object({ kind: z.literal('timestamped'), header: z.string(), toleranceSec: z.number() }),
  z.object({ kind: z.literal('standard'), toleranceSec: z.number() }),
]);
export type SignatureSchemeWire = z.infer<typeof signatureSchemeWireSchema>;

/** The engine's `WebhookSigning` restated (§5.1): absent on a node means inherit. */
export const webhookSigningWireSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('sign'),
    scheme: signatureSchemeWireSchema,
    /** A keychain reference, never the secret. */
    secretRef: z.string().optional(),
    /** The CI name: `WIREBENCH_SECRET_<secretEnv>`. */
    secretEnv: z.string().optional(),
  }),
]);
export type WebhookSigningWire = z.infer<typeof webhookSigningWireSchema>;

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
  /** Webhook folder only: overrides the inherited target for everything inside. */
  target: z.string().optional(),
  /** Webhook folder only: set on a group imported from an API's definition. */
  source: z.object({ apiId: z.string() }).optional(),
  /** Webhook folder only. */
  signing: webhookSigningWireSchema.optional(),
  /** The folder's scripts, run around every request inside it (#334). REST and gRPC folders only. */
  scripts: requestScriptsWireSchema.optional(),
});
export type RestFolderWire = z.infer<typeof restFolderWireSchema>;

/** The jar's verdict on one cookie a response set (cookie jar spec §3). */
export const cookieJarVerdictWireSchema = z.object({
  stored: z.boolean(),
  reason: z
    .enum(['deleted', 'domain-mismatch', 'domain-not-allowed', 'secure-over-http', 'too-large', 'malformed'])
    .optional(),
});
export type CookieJarVerdictWire = z.infer<typeof cookieJarVerdictWireSchema>;

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
  /** What the cookie jar did with it; absent when the send had no jar. */
  jar: cookieJarVerdictWireSchema.optional(),
});
export type CookieWire = z.infer<typeof cookieWireSchema>;

/**
 * One cookie of the workspace jar (cookie jar spec §2.2), as the manager shows and edits it. A leaf
 * schema mirroring the engine's `StoredCookie`; nothing here imports the engine.
 */
export const storedCookieWireSchema = z
  .object({
    // Nothing that would break the `Cookie` header it is sent in: no separator, `=` or whitespace.
    name: z
      .string()
      .min(1)
      .regex(/^[^;=\s\u0000-\u001f\u007f]+$/),
    value: z.string().regex(/^[^;\r\n\0]*$/),
    domain: z.string().min(1),
    hostOnly: z.boolean(),
    path: z.string().startsWith('/'),
    expiresAt: z.number().optional(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
    createdAt: z.number(),
  })
  .refine((cookie) => new TextEncoder().encode(cookie.name + cookie.value).length <= 4096, {
    message: 'A cookie, name and value together, is at most 4096 bytes',
  });
export type StoredCookieWire = z.infer<typeof storedCookieWireSchema>;

/** What names one jar cookie. */
export const cookieKeyWireSchema = z.object({ name: z.string(), domain: z.string(), path: z.string() });
export type CookieKeyWire = z.infer<typeof cookieKeyWireSchema>;

/** The whole jar of the open workspace; `persisted` is false when nothing is saved. */
export const cookieJarStateWireSchema = z.object({
  cookies: z.array(storedCookieWireSchema),
  persisted: z.boolean(),
});
export type CookieJarStateWire = z.infer<typeof cookieJarStateWireSchema>;

export const cookiesSetRequestSchema = z.object({
  cookie: storedCookieWireSchema,
  /** The cookie this one replaces, when its name, domain or path changed. */
  replaces: cookieKeyWireSchema.optional(),
});
export const cookiesRemoveRequestSchema = z.object({ key: cookieKeyWireSchema });
export const cookiesRemoveDomainRequestSchema = z.object({ domain: z.string().min(1) });

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

/**
 * Request payload for `log.resend`: the saved request behind a row, replayed as it is now. A
 * logged row's own headers and body are redacted and are never the source of a send.
 */
export const logResendRequestSchema = z.object({
  protocol: z.enum(['soap', 'rest', 'grpc', 'websocket']),
  requestId: z.string(),
  /**
   * The row's own exchange, when it has one (absent for a failure row, which never streamed). A
   * REST resend keys its event-stream refusal on this row — never on the saved request's *current*
   * settings, which may have changed since — so main looks the row up by the same id the exchange
   * cache already uses.
   */
  sendId: z.string().optional(),
});
export type LogResendRequest = z.infer<typeof logResendRequestSchema>;

// --- Sequences (#62) ---------------------------------------------------------------------------
// The structure only: main round-trips every edit through the engine's own sequence file parser,
// so the limits, the transfer-name pattern and the compiled `matches:` are enforced by the same code
// that guards a file from a teammate.

/** One assertion a sequence step may carry: the request catalogue plus `header`. */
export const stepAssertionWireSchema = z.discriminatedUnion('type', [
  statusAssertionWire,
  soapFaultAssertionWire,
  matchAssertionWire,
  schemaAssertionWire,
  slaAssertionWire,
  headerAssertionWire,
  callbackAssertionWire,
]);
export type StepAssertionWire = z.infer<typeof stepAssertionWireSchema>;

const transferWireBase = {
  name: z.string(),
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
};

/** One value a step lifts from its response, for `${#Sequence#name}` in the steps after it. */
export const sequenceTransferWireSchema = z.discriminatedUnion('from', [
  z.object({
    ...transferWireBase,
    from: z.literal('body'),
    language: z.enum(['xpath', 'xquery', 'jsonpath']),
    expression: z.string(),
    namespaces: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ ...transferWireBase, from: z.literal('header'), header: z.string() }),
  z.object({ ...transferWireBase, from: z.literal('status') }),
  z.object({ ...transferWireBase, from: z.literal('cookie'), cookie: z.string() }),
]);
export type SequenceTransferWire = z.infer<typeof sequenceTransferWireSchema>;

const notWire = { not: z.boolean().optional() };
const branchOutcomeWire = z.enum(['passed', 'failed', 'errored']);

/** What a branch rule tests (#347): a response check, without a name, or the step's outcome. */
export const branchConditionWireSchema = z.discriminatedUnion('type', [
  statusAssertionWire.omit({ name: true }).extend(notWire),
  soapFaultAssertionWire.omit({ name: true }).extend(notWire),
  matchAssertionWire.omit({ name: true }).extend(notWire),
  headerAssertionWire.omit({ name: true }).extend(notWire),
  z.object({
    type: z.literal('outcome'),
    equals: z.union([branchOutcomeWire, z.array(branchOutcomeWire)]),
    ...notWire,
  }),
]);
export type BranchConditionWire = z.infer<typeof branchConditionWireSchema>;

/** Where a step's run goes when the condition holds. Main holds it to the file's limits. */
export const branchRuleWireSchema = z.discriminatedUnion('then', [
  z.object({
    when: branchConditionWireSchema,
    then: z.literal('goto'),
    step: z.string(),
    max: z.number().int(),
    delayMs: z.number().int().optional(),
  }),
  z.object({
    when: branchConditionWireSchema,
    then: z.literal('repeat'),
    max: z.number().int(),
    delayMs: z.number().int().optional(),
  }),
  z.object({ when: branchConditionWireSchema, then: z.literal('skip-next') }),
]);
export type BranchRuleWire = z.infer<typeof branchRuleWireSchema>;

export const sequenceStepWireSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  requestId: z.string(),
  enabled: z.boolean(),
  requestAssertions: z.boolean(),
  transfers: z.array(sequenceTransferWireSchema),
  assertions: z.array(stepAssertionWireSchema),
  branches: z.array(branchRuleWireSchema).optional(),
});
export type SequenceStepWire = z.infer<typeof sequenceStepWireSchema>;

export const sequenceSettingsWireSchema = z.object({
  stopOnFailure: z.boolean(),
  stepTimeoutMs: z.number().int().positive().optional(),
});

/** A sequence as the renderer sees it: `sequences/<slug>.sequence.yaml`, less nothing. */
export const sequenceWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  settings: sequenceSettingsWireSchema,
  steps: z.array(sequenceStepWireSchema),
});
export type SequenceWire = z.infer<typeof sequenceWireSchema>;

/** What `update-sequence` may change. The steps are replaced whole: they are one ordered list. */
export const sequencePatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  settings: sequenceSettingsWireSchema.optional(),
  steps: z.array(sequenceStepWireSchema).optional(),
});
export type SequencePatch = z.infer<typeof sequencePatchSchema>;

/** One transfer's outcome. A secret one never carries a value across the bridge. */
export const sequenceTransferResultWireSchema = z.object({
  name: z.string(),
  outcome: z.enum(['set', 'missing', 'errored']),
  secret: z.boolean(),
  value: z.string().optional(),
  message: z.string().optional(),
});

export const sequenceAssertionResultWireSchema = z.object({
  type: z.string(),
  label: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored']),
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
  /** A callback assertion's matched capture, for the link to it in the Webhook inbox. */
  capture: z.object({ hookId: z.string(), captureId: z.string() }).optional(),
});

/** One step of a run, as the run panel shows it. Every string in it is masked before it leaves main. */
export const sequenceStepResultWireSchema = z.object({
  index: z.number().int(),
  stepId: z.string(),
  requestId: z.string(),
  name: z.string(),
  protocol: z.enum(['soap', 'rest', 'grpc']).optional(),
  outcome: z.enum(['passed', 'failed', 'errored', 'skipped']),
  status: z.number().optional(),
  durationMs: z.number().optional(),
  origin: z.string().optional(),
  assertions: z.array(sequenceAssertionResultWireSchema),
  transfers: z.array(sequenceTransferResultWireSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  skipped: z.enum(['disabled', 'after-failure', 'cancelled', 'branch']).optional(),
  /** Which run of the step this is, from 2 (#347). */
  attempt: z.number().int().optional(),
  /** A later run of this step superseded this one; it does not count. */
  retried: z.literal(true).optional(),
  /** What the step's branches did. */
  branch: z
    .object({
      rule: z.number().int(),
      action: z.enum(['goto', 'repeat', 'skip-next']),
      to: z.object({ index: z.number().int(), stepId: z.string(), name: z.string() }).optional(),
      count: z.number().int(),
      max: z.number().int().optional(),
      limitReached: z.literal(true).optional(),
    })
    .optional(),
  /** What the step request's scripts logged, masked (#63). */
  scriptLog: z.array(z.string()).optional(),
  /** The step's request has scripts, switched off, so none ran. */
  scriptsOff: z.boolean().optional(),
  /** The send behind the step, for its HTTP Log row; absent for a step never sent. */
  sendId: z.string().optional(),
});
export type SequenceStepResultWire = z.infer<typeof sequenceStepResultWireSchema>;

export const sequenceRunResultWireSchema = z.object({
  runId: z.string(),
  sequenceId: z.string(),
  name: z.string(),
  startedAt: z.string(),
  environment: z.string().optional(),
  outcome: z.enum(['passed', 'failed', 'errored', 'skipped']),
  steps: z.array(sequenceStepResultWireSchema),
});
export type SequenceRunResultWire = z.infer<typeof sequenceRunResultWireSchema>;

/** `sequence.run`: the renderer names the run, so it can cancel it before the first step reports. */
export const sequenceRunRequestSchema = z.object({ sequenceId: z.string(), runId: z.string().min(1) });
export type SequenceRunRequest = z.infer<typeof sequenceRunRequestSchema>;

export const sequenceCancelRequestSchema = z.object({ runId: z.string() });
export const sequenceCancelResponseSchema = z.object({ cancelled: z.boolean() });

/** One step of a running sequence has ended; `sequence.run` resolves with all of them at the end. */
export const sequenceProgressEventSchema = z.object({
  runId: z.string(),
  sequenceId: z.string(),
  step: sequenceStepResultWireSchema,
});
export type SequenceProgressEvent = z.infer<typeof sequenceProgressEventSchema>;

/** A step has sent and now waits for its callback assertions (callback-assertion §5). */
export const sequenceWaitingEventSchema = z.object({
  runId: z.string(),
  sequenceId: z.string(),
  index: z.number().int(),
  stepId: z.string(),
  waiting: z.array(z.object({ label: z.string(), catchUrl: z.string(), withinMs: z.number().int() })),
});
export type SequenceWaitingEvent = z.infer<typeof sequenceWaitingEventSchema>;

/** Response payload for `log.exportHar`: `saved: false` when the save dialog was cancelled. */
export const logExportHarResponseSchema = z.object({ saved: z.boolean(), path: z.string().optional() });
export type LogExportHarResponse = z.infer<typeof logExportHarResponseSchema>;

// --- Mock services (#59) ------------------------------------------------------------------------

const mockCheckWire = {
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
};

/** One match condition of a response: a body expression, or a named query, header or path value. */
export const mockMatchWireSchema = z.union([
  z.object({
    from: z.literal('body'),
    language: z.enum(['xpath', 'jsonpath']),
    expression: z.string(),
    namespaces: z.record(z.string(), z.string()).optional(),
    ...mockCheckWire,
  }),
  z.object({ from: z.enum(['query', 'header', 'path']), name: z.string(), ...mockCheckWire }),
]);
export type MockMatchWire = z.infer<typeof mockMatchWireSchema>;

export const mockScenarioWireSchema = z.object({
  name: z.string(),
  state: z.string().optional(),
  next: z.string().optional(),
});
export type MockScenarioWire = z.infer<typeof mockScenarioWireSchema>;

export const mockHeaderWireSchema = z.object({ name: z.string(), value: z.string() });
export type MockHeaderWire = z.infer<typeof mockHeaderWireSchema>;

export const mockBodyLanguageSchema = z.enum(['xml', 'json', 'text', 'none']);
export type MockBodyLanguageWire = z.infer<typeof mockBodyLanguageSchema>;

/** One canned response: `<slug>.response.yaml` and its body file. */
export const mockResponseWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  status: z.number(),
  headers: z.array(mockHeaderWireSchema),
  delayMs: z.number(),
  body: mockBodyLanguageSchema,
  bodyText: z.string(),
  match: z.array(mockMatchWireSchema),
  scenario: mockScenarioWireSchema.optional(),
});
export type MockResponseWire = z.infer<typeof mockResponseWireSchema>;

export const mockDispatchSchema = z.enum(['sequence', 'random', 'match', 'script']);
export type MockDispatchWire = z.infer<typeof mockDispatchSchema>;

/** One operation of a mock: `operations/<slug>/operation.yaml`, its responses and `dispatch.ts`. */
export const mockOperationWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  /** The contract's key: a SOAP operation name, or REST `<method> <path>`. */
  operation: z.string(),
  dispatch: mockDispatchSchema,
  defaultResponseId: z.string().optional(),
  script: z.string().optional(),
  responses: z.array(mockResponseWireSchema),
});
export type MockOperationWire = z.infer<typeof mockOperationWireSchema>;

export const mockValidationSchema = z.enum(['reject', 'report', 'off']);
export type MockValidationWire = z.infer<typeof mockValidationSchema>;

/** A mock as the renderer sees it: `mocks/<slug>/` and everything under it. */
export const mockWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  source: z.object({ containerId: z.string(), binding: z.string().optional() }),
  port: z.number(),
  path: z.string(),
  validation: mockValidationSchema,
  operations: z.array(mockOperationWireSchema),
});
export type MockWire = z.infer<typeof mockWireSchema>;

/** What `update-mock` may change. */
export const mockPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  path: z.string().optional(),
  validation: mockValidationSchema.optional(),
});
export type MockPatch = z.infer<typeof mockPatchSchema>;

/** What `update-mock-operation` may change; `null` clears the default or the script. */
export const mockOperationPatchSchema = z.object({
  dispatch: mockDispatchSchema.optional(),
  defaultResponseId: z.string().nullable().optional(),
  script: z.string().nullable().optional(),
});
export type MockOperationPatch = z.infer<typeof mockOperationPatchSchema>;

/** What `update-mock-response` may change; `scenario: null` takes the response out of its scenario. */
export const mockResponsePatchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.number().int().optional(),
  headers: z.array(mockHeaderWireSchema).optional(),
  delayMs: z.number().int().optional(),
  body: mockBodyLanguageSchema.optional(),
  bodyText: z.string().optional(),
  match: z.array(mockMatchWireSchema).optional(),
  scenario: mockScenarioWireSchema.nullable().optional(),
});
export type MockResponsePatch = z.infer<typeof mockResponsePatchSchema>;

// --- Running a mock (#59) ---

export const mockIdRequestSchema = z.object({ mockId: z.string() });
export type MockIdRequest = z.infer<typeof mockIdRequestSchema>;

/** A mock's running state; `url` is set while it runs, `error` when it failed to start. */
export const mockStateEventSchema = z.object({
  mockId: z.string(),
  running: z.boolean(),
  url: z.string().optional(),
  /** True when the mock listens on every interface (the preference) rather than loopback. */
  exposed: z.boolean().optional(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  error: z.string().optional(),
});
export type MockStateEvent = z.infer<typeof mockStateEventSchema>;

/** One problem a mock found with a request, or with a stub (#325). */
const mockProblemWireSchema = z.object({
  code: z.string(),
  message: z.string(),
  in: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});
export type MockProblemWire = z.infer<typeof mockProblemWireSchema>;

/** Each stub of a mock the contract does not allow (#325), and how many were checked. */
export const mockCheckResponseSchema = z.object({
  checked: z.number(),
  findings: z.array(
    z.object({
      operationId: z.string(),
      operationName: z.string(),
      operation: z.string(),
      responseId: z.string(),
      responseName: z.string(),
      status: z.number(),
      problems: z.array(mockProblemWireSchema),
    }),
  ),
});
export type MockCheckResponse = z.infer<typeof mockCheckResponseSchema>;

export const mockStopResponseSchema = z.object({ stopped: z.boolean() });
export const mockResetResponseSchema = z.object({ reset: z.boolean() });
export const mockStatesResponseSchema = z.object({ states: z.array(mockStateEventSchema) });

const mockEventMessageWireSchema = z.object({
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
  truncated: z.boolean(),
});

/** One request a running mock answered, with sensitive headers and query values masked. */
export const mockExchangeEventSchema = z.object({
  mockId: z.string(),
  seq: z.number(),
  at: z.string(),
  method: z.string(),
  url: z.string(),
  operation: z.string().optional(),
  responseId: z.string().optional(),
  responseName: z.string().optional(),
  status: z.number(),
  durationMs: z.number(),
  problems: z.array(mockProblemWireSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  log: z.array(z.string()).optional(),
  request: mockEventMessageWireSchema,
  response: mockEventMessageWireSchema,
});
export type MockExchangeEventWire = z.infer<typeof mockExchangeEventSchema>;

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
  /** A palette name or `#rrggbb`; `null` takes the colour off. */
  color: z.string().refine(isEnvironmentColor, 'not a palette name or #rrggbb').nullable().optional(),
  protected: z.boolean().optional(),
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

/**
 * The project a `project.*` request addresses. Every one of these channels carries it: inside
 * a workspace "the open project" is not a question with one answer, so the renderer names the
 * project it means and main routes the call to that project's host.
 */
export const projectIdRequestSchema = z.object({ projectId: z.string() });

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

// ---------------------------------------------------------------------------
// OpenAPI import (`api.*`): one API made from a described document, and the
// cached definition it can be read back and exported from.
// ---------------------------------------------------------------------------

/**
 * A definition document's fetch credentials: Basic, a bearer token or an API key, each carrying only
 * a `secretRef`. Every arm is `.strict()`, so a plaintext `password`, `token` or `value` sent by
 * mistake fails validation instead of being stripped, and NTLM or OAuth2 are refused by name.
 */
export const definitionAuthWireSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('basic'), username: z.string(), passwordRef: z.string() }).strict(),
  z.object({ type: z.literal('bearer'), tokenRef: z.string(), scheme: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal('api-key'),
      name: z.string().min(1),
      in: z.enum(['header', 'query']),
      valueRef: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('kerberos'),
      spn: z.string().optional(),
      principal: z.string().optional(),
      username: z.string().optional(),
      domain: z.string().optional(),
      passwordRef: z.string().optional(),
    })
    .strict(),
]);
export type DefinitionAuthWire = z.infer<typeof definitionAuthWireSchema>;

/** Credentials go with a URL only: a file or pasted text is never fetched from anywhere. */
export const onlyWithAUrl = {
  message: 'Definition credentials are only sent with an http(s) URL source',
  path: ['auth'],
};

/**
 * Whether `auth` is absent, or the source is a `url` whose scheme is `http`/`https` — the only case
 * credentials can be sent for. A malformed URL, or one typed with another scheme (`file:`, `ftp:`),
 * refuses `auth` the same way a `file` or `text` source does, rather than reaching main only to fail
 * there or silently drop the credentials.
 */
export function hasFetchableAuthSource(request: {
  readonly source: OpenApiSourceWire;
  readonly auth?: unknown;
}): boolean {
  if (request.auth === undefined) {
    return true;
  }
  if (request.source.kind !== 'url' || !URL.canParse(request.source.url)) {
    return false;
  }
  const { protocol } = new URL(request.source.url);
  return protocol === 'http:' || protocol === 'https:';
}

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

/** An entity id is a short generated string; the cap only keeps a hostile payload small. */
export const MAX_REST_UPDATE_ID_CHARS = 256;

/** Resolves to `true` only when `A` and `B` are the same type. */
export type TypesEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when given `true`. */
export type AssertTrue<T extends true> = T;

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

/** Which committed variables a current value overrides (cookie jar spec §5.1). */
export const scopeKeyWireSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }),
  z.object({ scope: z.literal('workspace') }),
  z.object({ scope: z.literal('workspaceEnvironment'), environmentId: z.string() }),
  z.object({ scope: z.literal('project'), projectId: z.string() }),
  z.object({ scope: z.literal('projectEnvironment'), projectId: z.string(), environmentId: z.string() }),
]);
export type ScopeKeyWire = z.infer<typeof scopeKeyWireSchema>;

/** The open workspace's current values, one entry per scope that has any. Session only. */
export const currentValuesStateWireSchema = z.object({
  scopes: z.array(z.object({ key: scopeKeyWireSchema, values: z.record(z.string(), z.string()) })),
});
export type CurrentValuesStateWire = z.infer<typeof currentValuesStateWireSchema>;

export const currentValuesSetRequestSchema = z.object({
  key: scopeKeyWireSchema,
  name: z.string().min(1).max(65536),
  value: z.string().max(65536),
});
/** `name` omitted resets the whole scope. */
export const currentValuesResetRequestSchema = z.object({ key: scopeKeyWireSchema, name: z.string().optional() });

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

// ---------------------------------------------------------------------------
// Secret sources (`secretSources.*`, secret sources spec D6): where a `${secret:name}` comes from in an
// external manager. Locators cross the bridge; a value never does (ADR-0004). Writes are per entry, so an
// entry the renderer cannot represent (an invalid raw one, A7) is never sent back, and a teammate's change
// reloaded while the dialog is open is not overwritten.
// ---------------------------------------------------------------------------

/** One mapped name, shared (`workspace.yaml`) or this machine's (`local.yaml`). */
export const secretSourceEntryWireSchema = z.object({
  name: z.string(),
  origin: z.enum(['shared', 'local']),
  /** A kind, `invalid`, or (local only) `none`. */
  kind: z.string(),
  /** The entry's string locator fields; never a value. */
  fields: z.record(z.string(), z.string()),
  /** Why an `invalid` entry was refused. */
  reason: z.string().optional(),
  /** A shared entry that a local one replaces or unmaps. */
  overridden: z.boolean(),
});
export type SecretSourceEntryWire = z.infer<typeof secretSourceEntryWireSchema>;

/** Response for `secretSources.get` and `secretSources.approve`. */
export const secretSourcesStateSchema = z.object({
  open: z.boolean(),
  entries: z.array(secretSourceEntryWireSchema),
  /** The shared mapping's hash; absent when there is none to approve. */
  hash: z.string().optional(),
  /** True when there is no shared mapping, or this machine approved the current one. */
  trusted: z.boolean(),
  /** Shared names added, changed or removed since this machine's approval. */
  changes: z.array(z.object({ name: z.string(), change: z.enum(['added', 'changed', 'removed']) })),
  /** A `secretSources` value that is not a mapping, kept as read until an entry is written over it. */
  problem: z.string().optional(),
});
export type SecretSourcesState = z.infer<typeof secretSourcesStateSchema>;

/**
 * Request for `secretSources.setShared` and `secretSources.setLocal`: one entry. `previousName` and `name` are
 * removed first, then `entry` is written under `name`, or nothing is when it is `null`.
 */
export const secretSourcesSetRequestSchema = z.object({
  name: z.string(),
  previousName: z.string().optional(),
  entry: z.record(z.string(), z.string()).nullable(),
  /** An add: refused, writing nothing, when `name` is already mapped in this scope (an invalid entry included). */
  create: z.boolean().optional(),
});
export type SecretSourcesSetRequest = z.infer<typeof secretSourcesSetRequestSchema>;

/** Response for `secretSources.setShared` and `secretSources.setLocal`: nothing is written when `ok` is false. */
export const secretSourcesSetResponseSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.object({ name: z.string(), field: z.string().optional(), reason: z.string() })),
});
export type SecretSourcesSetResponse = z.infer<typeof secretSourcesSetResponseSchema>;

/** Request for `secretSources.approve`: the hash the user reviewed. */
export const secretSourcesApproveRequestSchema = z.object({ hash: z.string() });
export type SecretSourcesApproveRequest = z.infer<typeof secretSourcesApproveRequestSchema>;

/** Request for `secretSources.test`. */
export const secretSourcesTestRequestSchema = z.object({ name: z.string() });
export type SecretSourcesTestRequest = z.infer<typeof secretSourcesTestRequestSchema>;
/** Response for `secretSources.test`: the value's length, or why it could not be read. Never the value. */
export const secretSourcesTestResponseSchema = z.union([
  z.object({ ok: z.literal(true), length: z.number() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export type SecretSourcesTestResponse = z.infer<typeof secretSourcesTestResponseSchema>;

// ---------------------------------------------------------------------------
// Secret scanning (`secretScan.*`): credentials found in plain text in a project, and moving them
// into the store behind a `${secret:name}` token. A finding crosses the bridge as a masked
// `preview` only — every schema here is `.strict()`, so a finding that carried its `value` (or a
// response that grew one) fails validation instead of reaching the renderer.
// ---------------------------------------------------------------------------

/** Where a finding sits: the engine's `SecretLocation`, field for field. */
export const secretLocationWireSchema = z.union([
  z
    .object({
      kind: z.enum(['soap-header', 'rest-header', 'rest-query', 'grpc-metadata', 'ws-header', 'ws-query']),
      requestId: z.string(),
      name: z.string(),
      index: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['grpc-api-metadata', 'ws-api-header']),
      apiId: z.string(),
      name: z.string(),
      index: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rest-body'),
      requestId: z.string(),
      field: z.number().int().optional(),
      name: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.enum(['soap-body', 'grpc-message']), requestId: z.string() }).strict(),
  z.object({ kind: z.enum(['rest-url', 'ws-url']), requestId: z.string(), name: z.string().optional() }).strict(),
  z.object({ kind: z.literal('ws-message'), requestId: z.string(), messageId: z.string() }).strict(),
  z.object({ kind: z.literal('project-property'), name: z.string() }).strict(),
  z.object({ kind: z.literal('env-property'), environmentId: z.string(), name: z.string() }).strict(),
]);

/** One possible secret, as the review dialog shows it: never the value, only its `preview`. */
export const secretFindingWireSchema = z
  .object({
    id: z.string(),
    location: secretLocationWireSchema,
    rule: z.enum([
      'sensitive-name',
      'jwt',
      'bearer',
      'basic',
      'url-credentials',
      'aws-key',
      'private-key',
      'vendor-token',
      'high-entropy',
    ]),
    label: z.string(),
    /** The first few characters and the length (`eyJ… (36 chars)`). */
    preview: z.string(),
  })
  .strict();
export type SecretFindingWire = z.infer<typeof secretFindingWireSchema>;

/** Request payload for `secretScan.scan`. */
export const secretScanScanRequestSchema = z.object({ projectId: z.string() });
/**
 * Response for `secretScan.scan`: the findings not kept this session, a proposed secret name for
 * each (by finding id, unique against the stored names and each other), and the names this
 * project already has a stored value for — Move to one of those needs `replace`.
 */
export const secretScanScanResponseSchema = z
  .object({
    findings: z.array(secretFindingWireSchema),
    proposedNames: z.record(z.string(), z.string()),
    storedNames: z.array(z.string()),
  })
  .strict();

/** Request payload for `secretScan.keep`: findings to leave in place until the project closes. */
export const secretScanKeepRequestSchema = z.object({ projectId: z.string(), ids: z.array(z.string()) });
export const secretScanKeepResponseSchema = z.object({});

/** One finding to move, and the `${secret:name}` name it moves to (the engine's `SECRET_NAME_PATTERN`). */
export const secretScanMoveItemSchema = z
  .object({
    id: z.string(),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    /** Overwrite the value already stored under `name`; without it a taken name is not moved. */
    replace: z.boolean().optional(),
  })
  .strict();
/** Request payload for `secretScan.move`. */
export const secretScanMoveRequestSchema = z.object({
  projectId: z.string(),
  items: z.array(secretScanMoveItemSchema),
});
/** Response for `secretScan.move`, as finding ids: moved, no longer found as scanned, or name taken. */
export const secretScanMoveResponseSchema = z
  .object({ moved: z.array(z.string()), stale: z.array(z.string()), nameTaken: z.array(z.string()) })
  .strict();

/**
 * Request payload for `secretScan.hold`: suspend autosave for these projects while their review is
 * open, so a manual save's edit is not written before the person answers. Released by
 * `secretScan.release`, or by main when the window that asked goes away.
 */
export const secretScanHoldRequestSchema = z.object({ projectIds: z.array(z.string()) });
export const secretScanHoldResponseSchema = z.object({ holdId: z.string() }).strict();
/** Request payload for `secretScan.release`: autosave resumes for the held projects. */
export const secretScanReleaseRequestSchema = z.object({ holdId: z.string() });
export const secretScanReleaseResponseSchema = z.object({});

/** Request payload for `secretScan.tokens`. */
export const secretScanTokensRequestSchema = z.object({ projectId: z.string() });
/**
 * Response for `secretScan.tokens`: the `${secret:name}` names the project uses (first-use order),
 * then the names only stored for it (alphabetical), each with whether this machine has its value.
 * Names only — never a value.
 */
export const secretScanTokensResponseSchema = z
  .object({ tokens: z.array(z.object({ name: z.string(), stored: z.boolean() }).strict()) })
  .strict();
/** Request payload for `secretScan.setValue`: store `value` under the project's label for `name`. */
export const secretScanSetValueRequestSchema = z.object({
  projectId: z.string(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string().min(1),
});
/** Response for `secretScan.setValue`: whether a value was already stored and was replaced. */
export const secretScanSetValueResponseSchema = z.object({ replaced: z.boolean() }).strict();

/** Request payload for `exchanges.get`: the send whose cached exchange to re-read. */
export const exchangesGetRequestSchema = z.object({ sendId: z.string() });

// ---------------------------------------------------------------------------
// History (Task 24): a persistent, per-project record of every send, kept in
// `userData` (outside the project folder) and always stored redacted.
// ---------------------------------------------------------------------------

export const historyFaultSchema = z.object({ code: z.string(), reason: z.string() });
export const historyErrorSchema = z.object({ code: z.string(), message: z.string() });

/** Request payload for `history.list`. */
export const historyListRequestSchema = z.object({
  query: z.string().optional(),
  limit: z.number().optional(),
  before: z.string().optional(),
  /** Narrows the merge to one project of the open workspace; absent means every project. */
  projectId: z.string().optional(),
});

/** Request/response for `history.get`. */
export const historyGetRequestSchema = z.object({ id: z.string() });

/** Response for `history.clear`. */
export const historyClearResponseSchema = z.object({ cleared: z.number() });

/** Request payload for `history.resend`: re-sends a past entry through the normal send path. */
export const historyResendRequestSchema = z.object({ id: z.string() });

/** Payload for the `history.changed` event: another process wrote this project's History file. */
export const historyChangedEventSchema = z.object({ projectId: z.string() });
export type HistoryChangedEvent = z.infer<typeof historyChangedEventSchema>;

// ---------------------------------------------------------------------------
// Snapshot regression: a golden response kept beside a saved request as `<slug>.golden.yaml`.
// ---------------------------------------------------------------------------

/** A saved golden response, as `snapshot.read` returns it and the sidecar file stores it. */
export const snapshotSchema = z.object({
  contentType: z.string().optional(),
  savedAt: z.string(),
  ignore: z.array(z.string()),
  body: z.string(),
});
export type SnapshotWire = z.infer<typeof snapshotSchema>;

/** Request for `snapshot.read` and `snapshot.remove`. */
export const snapshotRequestSchema = z.object({ requestId: z.string() });

/**
 * Response for `snapshot.read`: `unsaved` when the request has no file on disk yet (so there is
 * nowhere to keep a snapshot), `none` when nothing is saved or the sidecar is unreadable.
 */
export const snapshotReadResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unsaved') }),
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('present'), snapshot: snapshotSchema }),
]);
export type SnapshotReadResponse = z.infer<typeof snapshotReadResponseSchema>;

/** Request for `snapshot.write`: saves `body` as the request's golden response. */
export const snapshotWriteRequestSchema = z.object({
  requestId: z.string(),
  body: z.string(),
  contentType: z.string().optional(),
  ignore: z.array(z.string()),
});

/** Request for `snapshot.setIgnore`: replaces the ignore rules and keeps the body. */
export const snapshotSetIgnoreRequestSchema = z.object({ requestId: z.string(), ignore: z.array(z.string()) });

/** Response for `snapshot.write` and `snapshot.setIgnore`. */
export const snapshotSavedResponseSchema = z.object({ savedAt: z.string() });

/** Response for `snapshot.remove`: whether a sidecar was there to delete. */
export const snapshotRemoveResponseSchema = z.object({ removed: z.boolean() });

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

/** `keystores.pickFile`: an Open dialog filtered to keystore files; records a read pick. */
export const keystoresPickFileRequestSchema = z.object({});
export const keystoresPickFileResponseSchema = z.object({ path: z.string().optional() });

/**
 * `certificates.check`: how long the certificates the open workspace relies on have left —
 * every keystore alias (leaf and the chain it carries), the CA bundle, and, when
 * `probeEndpoints` is set, the chain each TLS endpoint presents. Probing reaches the network (one
 * verified TLS handshake per `host:port`, no request), so it is asked for; the local reads are not.
 * Certificates only — no key, no PEM.
 */
export const certificatesCheckRequestSchema = z.object({ probeEndpoints: z.boolean() });
export type CertificatesCheckRequest = z.infer<typeof certificatesCheckRequestSchema>;
/** Where a checked certificate came from. */
export const certificateSourceSchema = z.enum(['endpoint', 'keystore', 'ca-bundle']);
export type CertificateSourceWire = z.infer<typeof certificateSourceSchema>;
export const certificateFindingSchema = z.object({
  source: certificateSourceSchema,
  /** The project that names it; absent for the CA bundle, which is the user's, not a project's. */
  projectId: z.string().optional(),
  /** `host:port`, `<keystore> › <alias>`, or `CA bundle`. */
  where: z.string(),
  subject: z.string(),
  /** ISO 8601. */
  validTo: z.string(),
  status: z.enum(['ok', 'expiring', 'expired']),
  /** Whole days left, rounded up; `0` or less once expired. */
  daysLeft: z.number(),
});
export type CertificateFindingWire = z.infer<typeof certificateFindingSchema>;
/** Something that could not be checked: an endpoint that did not answer, a keystore that did not load. */
export const certificateSkippedSchema = z.object({
  source: certificateSourceSchema,
  projectId: z.string().optional(),
  where: z.string(),
  message: z.string(),
});
export type CertificateSkippedWire = z.infer<typeof certificateSkippedSchema>;
/**
 * An endpoint whose chain does not verify as a send would verify it: expired, untrusted, or not
 * issued for the host. The probe verifies, so nothing of such a chain is read; `code` says why.
 */
export const certificateUntrustedSchema = z.object({
  projectId: z.string().optional(),
  /** `host:port`. */
  where: z.string(),
  /** OpenSSL's reason, e.g. `CERT_HAS_EXPIRED`, or Node's `ERR_TLS_CERT_ALTNAME_INVALID`. */
  code: z.string(),
  message: z.string(),
});
export type CertificateUntrustedWire = z.infer<typeof certificateUntrustedSchema>;
export const certificatesCheckResponseSchema = z.object({
  /** The warning window the statuses were judged against (`ssl.expiryWarningDays`). */
  warnDays: z.number(),
  certificates: z.array(certificateFindingSchema),
  skipped: z.array(certificateSkippedSchema),
  /** Probed endpoints whose chain did not verify; always empty when endpoints were not probed. */
  untrusted: z.array(certificateUntrustedSchema),
  /** Whether endpoints were probed; `false` means only keystores and the CA bundle were read. */
  probedEndpoints: z.boolean(),
});
export type CertificatesCheckResponse = z.infer<typeof certificatesCheckResponseSchema>;

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
    offerH2: z.boolean(),
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
    /** Days before a certificate's expiry that `certificates.check` starts warning. */
    expiryWarningDays: z.number(),
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
    logSize: z.number(),
  }),
  updates: z.object({ checkOnLaunch: z.boolean() }),
  accounts: z.object({ showInStatusBar: z.boolean() }),
  secrets: z.object({ sourceCacheSeconds: z.number() }),
  mocks: z.object({ listenOnAllInterfaces: z.boolean() }),
  terminal: z.object({ confirmMultilinePaste: z.boolean(), copyOnSelect: z.boolean() }),
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
  'accounts',
  'secrets',
  'mocks',
  'terminal',
  'tokens',
  'shortcuts',
]);
export type PreferencesSectionWire = z.infer<typeof preferencesSectionSchema>;
/**
 * The sections that hold stored preferences — every one but `tokens`, which lists a server
 * workspace's CI tokens and has nothing to reset.
 */
export const preferencesStoredSectionSchema = preferencesSectionSchema.exclude(['tokens']);
export type PreferencesStoredSectionWire = z.infer<typeof preferencesStoredSectionSchema>;

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
  accounts: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  mocks: z.record(z.string(), z.unknown()).optional(),
  terminal: z.record(z.string(), z.unknown()).optional(),
  shortcuts: z.record(z.string(), z.string()).optional(),
});
export type PreferencesPatchWire = z.infer<typeof preferencesPatchWireSchema>;

/** Response for every `preferences.*` channel, and the payload of `preferences.changed`. */
export const preferencesResponseSchema = z.object({ preferences: preferencesWireSchema });
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

/**
 * Response for `preferences.policy`: the managed-preferences policy main loaded at startup.
 * `locked` and `ignored` are dotted keys (`proxy.mode`); `error` says why a policy file that
 * exists could not be applied, in which case nothing is locked.
 */
export const preferencesPolicyResponseSchema = z.object({
  path: z.string(),
  locked: z.array(z.string()),
  ignored: z.array(z.string()),
  error: z.string().optional(),
});
export type PreferencesPolicyResponse = z.infer<typeof preferencesPolicyResponseSchema>;

/** Request payload for `preferences.update`. */
export const preferencesUpdateRequestSchema = z.object({ patch: preferencesPatchWireSchema });
/** Request payload for `preferences.reset`. */
export const preferencesResetRequestSchema = z.object({ section: preferencesStoredSectionSchema.optional() });

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

/** A located, usable git executable — mirrors `GitLocation` from `packages/engine/src/sync/git-cli.ts`. */
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
  /** An automatic commit waits for the open projects' possible secrets to be reviewed; how many. */
  held: z.object({ findings: z.number() }).optional(),
  /**
   * The caller's role in a Wirebench Server workspace (teams-access §3.5); `server-sync` fills it and
   * shows *Viewer* on the badge. Inlined rather than `workspaceRoleWireSchema`, which is declared
   * further down this file.
   */
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
  /**
   * The others with this server workspace open (live-updates §3.4), never the caller: names and
   * user ids only, never emails. Set only while a server's live socket is connected.
   */
  presence: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /**
   * A server share's live socket: `connected`, `connecting` (opening, or backing off after a drop) or
   * `off` (the server has no `live`, or the subscription closed). Git and folder shares never have it.
   * Older renderers ignore both fields.
   */
  live: z.enum(['connected', 'connecting', 'off']).optional(),
});
export type SyncStatusWire = z.infer<typeof syncStatusWireSchema>;

/** One unresolved conflict, as the conflict resolver lists it. `projectId` is filled in by main. */
export const syncConflictWireSchema = z.object({
  path: z.string(),
  projectId: z.string().optional(),
  entity: z.object({ kind: z.string(), name: z.string() }).optional(),
});
export type SyncConflictWire = z.infer<typeof syncConflictWireSchema>;

// ---- team secrets (docs/specs/2026-09-26-team-secrets-design.md §4) -------------------------

const teamSecretsIdSchema = z.string().regex(/^[A-Z2-7]{26}$/);

/** Which secret: a keychain ref the tree names, or one project's `${secret:name}` token. Never a value. */
export const teamSecretsSecretWireSchema = z.union([
  z.object({ ref: z.string() }),
  z.object({ token: z.object({ projectId: z.string(), name: z.string() }) }),
]);
export type TeamSecretsSecretWire = z.infer<typeof teamSecretsSecretWireSchema>;

/** One machine key: who asked, from which machine, and the fingerprint an admin checks out of band. */
export const teamSecretsKeyWireSchema = z.object({
  keyId: teamSecretsIdSchema,
  name: z.string(),
  email: z.string(),
  machine: z.string(),
  fingerprint: z.string(),
  requestedAt: z.string(),
  admin: z.boolean(),
  mine: z.boolean(),
});
export type TeamSecretsKeyWire = z.infer<typeof teamSecretsKeyWireSchema>;

export const teamSecretsRotateMarkWireSchema = z.object({
  entryId: teamSecretsIdSchema,
  label: z.string(),
  secret: teamSecretsSecretWireSchema,
  removedNames: z.array(z.string()),
});
export type TeamSecretsRotateMarkWire = z.infer<typeof teamSecretsRotateMarkWireSchema>;

/**
 * A vault entry this machine ignores: signed by a key the log does not approve, or (`rolled-back`) an older
 * signed copy than the one this machine already accepted.
 */
export const teamSecretsUntrustedWireSchema = z.object({
  entryId: teamSecretsIdSchema,
  label: z.string(),
  reason: z.enum(['rolled-back']).optional(),
});
export type TeamSecretsUntrustedWire = z.infer<typeof teamSecretsUntrustedWireSchema>;
export const teamSecretsReplacedWireSchema = z.object({
  entryId: teamSecretsIdSchema,
  label: z.string(),
  byName: z.string(),
});
export type TeamSecretsReplacedWire = z.infer<typeof teamSecretsReplacedWireSchema>;

/** `teamSecrets.status` and the `teamSecrets.changed` event: ids, names, fingerprints and labels only. */
export const teamSecretsStatusWireSchema = z.object({
  on: z.boolean(),
  authority: z.enum(['signed', 'server']).optional(),
  canTurnOn: z.boolean(),
  /** May approve, decline and remove (and, with signed authority, change admins). */
  canManage: z.boolean(),
  me: z.object({
    state: z.enum(['unavailable', 'none', 'pending', 'approved', 'removed', 'declined']),
    keyId: teamSecretsIdSchema.optional(),
    fingerprint: z.string().optional(),
    admin: z.boolean(),
  }),
  /** Why this machine cannot take part, when it cannot (no keychain, a damaged log, removed, declined). */
  message: z.string().optional(),
  pending: z.array(teamSecretsKeyWireSchema),
  approved: z.array(teamSecretsKeyWireSchema),
  /** Server shares: approved keys whose email has no role in the workspace any more (§3.6). */
  formerMembers: z.array(teamSecretsIdSchema),
  rotate: z.array(teamSecretsRotateMarkWireSchema),
  untrusted: z.array(teamSecretsUntrustedWireSchema),
  replaced: z.array(teamSecretsReplacedWireSchema),
  /** Secrets whose value is on this machine only (plan decision 17). */
  localOnly: z.array(teamSecretsSecretWireSchema),
});
export type TeamSecretsStatusWire = z.infer<typeof teamSecretsStatusWireSchema>;

export const teamSecretsKeyActionRequestSchema = z.object({ keyId: teamSecretsIdSchema });
export type TeamSecretsKeyActionRequest = z.infer<typeof teamSecretsKeyActionRequestSchema>;
export const teamSecretsEntryActionRequestSchema = z.object({ entryId: teamSecretsIdSchema });
export type TeamSecretsEntryActionRequest = z.infer<typeof teamSecretsEntryActionRequestSchema>;

/** Payload for `teamSecrets.changed`: the open shared workspace's team-secrets status, as `teamSecrets.status` answers. */
export const teamSecretsChangedEventSchema = z.object({ workspaceId: z.string(), status: teamSecretsStatusWireSchema });
export type TeamSecretsChangedEvent = z.infer<typeof teamSecretsChangedEventSchema>;

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
 * `autoFetchSeconds`/`commitOnSave`/`pushOnSave` are present for a git or server share — the
 * persisted settings, so the Sync panel can show them without guessing a default. `server` names a
 * Wirebench Server share's server, workspace and team (display only), which the panel shows instead
 * of a remote and branch (server-sync §3.4). */
export const workspaceShareWireSchema = z.object({
  kind: z.enum(['folder', 'git', 'server']),
  managed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  server: z
    .object({
      url: z.string(),
      workspaceId: z.string(),
      teamName: z.string().optional(),
      /**
       * The open workspace's last fetched head said `recordDesktopActivity`: its sends and test runs
       * are reported to the server's audit log (desktop audit events §2.2). False for a summary.
       */
      recording: z.boolean(),
    })
    .optional(),
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
  z.object({ kind: z.literal('release-page'), version: z.string() }),
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
  protocol: z.enum(['soap', 'rest', 'grpc', 'websocket']).optional(),
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
  /** A palette name or `#rrggbb` (#345), as the file holds it; absent means no colour. */
  color: z.string().optional(),
  /** True asks before every send under this environment (#345); absent means false. */
  protected: z.boolean().optional(),
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
  /** A palette name or `#rrggbb`; `null` takes the colour off. */
  color: z.string().refine(isEnvironmentColor, 'not a palette name or #rrggbb').nullable().optional(),
  protected: z.boolean().optional(),
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

/**
 * Request for `workspace.exportCollection` (collection exporters spec §4): the project by id, or
 * the one holding `containerId`; with `containerId`, only that API or interface is exported.
 */
export const workspaceExportCollectionRequestSchema = z.object({
  projectId: z.string().optional(),
  containerId: z.string().optional(),
  format: z.enum(['postman', 'opencollection']),
});
export type WorkspaceExportCollectionRequest = z.infer<typeof workspaceExportCollectionRequestSchema>;

/** Response for `workspace.exportCollection`: the folder and file names written, and the report. */
export const workspaceExportCollectionResponseSchema = z.object({
  cancelled: z.boolean(),
  dir: z.string().optional(),
  files: z.array(z.string()),
  requests: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
});
export type WorkspaceExportCollectionResponse = z.infer<typeof workspaceExportCollectionResponseSchema>;

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

/** Payload for `workspace.flushDrafts`: main is about to close; stash drafts now. */
export const workspaceFlushDraftsEventSchema = z.object({});

/**
 * A known server and who this installation is on it (identity spec §4.3), as the renderer sees
 * it: the secret-store ref and the token itself never cross the bridge.
 */
export const accountWireSchema = z.object({
  url: z.string(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  deviceName: z.string(),
  /** True once the server stopped accepting the token (sign-out, revocation, expiry). */
  signedOut: z.boolean(),
  addedAt: z.string(),
});
export type AccountWire = z.infer<typeof accountWireSchema>;

export const accountListResponseSchema = z.object({ servers: z.array(accountWireSchema) });
export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

/** `GET /api/v1/meta`, as far as the Sign in dialog needs it. */
export const serverMetaWireSchema = z.object({
  name: z.string(),
  version: z.string(),
  apiVersion: z.number(),
  publicUrl: z.string(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
});
export type ServerMetaWire = z.infer<typeof serverMetaWireSchema>;

export const accountUrlRequestSchema = z.object({ url: z.string() });
export const accountProbeResponseSchema = z.object({ url: z.string(), meta: serverMetaWireSchema });
export type AccountProbeResponse = z.infer<typeof accountProbeResponseSchema>;
export const accountSignInLocalRequestSchema = z.object({
  url: z.string(),
  email: z.string(),
  password: z.string(),
  deviceName: z.string().optional(),
});
export const accountStartOidcRequestSchema = z.object({ url: z.string(), deviceName: z.string().optional() });
export const accountResponseSchema = z.object({ account: accountWireSchema });
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export const accountLookupInvitationRequestSchema = z.object({ url: z.string(), secret: z.string() });
export const accountLookupInvitationResponseSchema = z.object({
  email: z.string(),
  methods: z.object({ local: z.boolean(), oidc: z.boolean() }),
});
export type AccountLookupInvitationResponse = z.infer<typeof accountLookupInvitationResponseSchema>;
export const accountAcceptInvitationRequestSchema = z.object({
  url: z.string(),
  secret: z.string(),
  displayName: z.string(),
  password: z.string(),
  deviceName: z.string().optional(),
});
export const accountCancelResponseSchema = z.object({ cancelled: z.boolean() });
export const accountChangedEventSchema = accountListResponseSchema;
export type AccountChangedEvent = z.infer<typeof accountChangedEventSchema>;

// ---------------------------------------------------------------------------
// Teams on Wirebench Server (teams-access §3.5, §5.2). Restated from the engine's
// `server-api/teams.ts` rather than imported: this file must stay free of engine values. Main parses
// the server's answers with the engine's schemas first, then these check what crosses the bridge.
// ---------------------------------------------------------------------------

export const teamRoleWireSchema = z.enum(['member', 'admin']);
export type TeamRoleWire = z.infer<typeof teamRoleWireSchema>;
export const workspaceRoleWireSchema = z.enum(['viewer', 'editor', 'admin']);
export type WorkspaceRoleWire = z.infer<typeof workspaceRoleWireSchema>;
export const defaultRoleWireSchema = z.enum(['none', 'viewer', 'editor']);
export type DefaultRoleWire = z.infer<typeof defaultRoleWireSchema>;
export const roleSourceWireSchema = z.enum(['server-admin', 'team-admin', 'grant', 'default']);
export type RoleSourceWire = z.infer<typeof roleSourceWireSchema>;

export const teamWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  myRole: teamRoleWireSchema,
  createdAt: z.string(),
});
export type TeamWire = z.infer<typeof teamWireSchema>;
export const teamMemberWireSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: teamRoleWireSchema,
  disabled: z.boolean(),
  addedAt: z.string(),
});
export type TeamMemberWire = z.infer<typeof teamMemberWireSchema>;
export const teamInvitationWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitationWire = z.infer<typeof teamInvitationWireSchema>;
/** Carries the link, which the dialog shows exactly once (§3.5). */
export const teamInvitationCreatedWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
  url: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitationCreatedWire = z.infer<typeof teamInvitationCreatedWireSchema>;
export const teamWorkspaceWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  defaultRole: defaultRoleWireSchema,
  myRole: workspaceRoleWireSchema,
  source: roleSourceWireSchema,
  createdAt: z.string(),
  /** Restates the engine's `TeamWorkspace.recordDesktopActivity` (desktop audit events §2.1). */
  recordDesktopActivity: z.boolean(),
});
export type TeamWorkspaceWire = z.infer<typeof teamWorkspaceWireSchema>;
export const accessEntryWireSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  teamRole: teamRoleWireSchema,
  disabled: z.boolean(),
  effectiveRole: z.enum(['none', 'viewer', 'editor', 'admin']),
  source: roleSourceWireSchema.optional(),
  grant: workspaceRoleWireSchema.optional(),
});
export type AccessEntryWire = z.infer<typeof accessEntryWireSchema>;

export const teamServerRequestWireSchema = z.object({ url: z.string() });
export const teamCreateRequestWireSchema = z.object({ url: z.string(), name: z.string() });
export const teamRenameRequestWireSchema = z.object({ url: z.string(), teamId: z.string(), name: z.string() });
export const teamRefRequestWireSchema = z.object({ url: z.string(), teamId: z.string() });
export const teamAddMemberRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
});
export const teamMemberRoleRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  userId: z.string(),
  role: teamRoleWireSchema,
});
export const teamMemberRefRequestWireSchema = z.object({ url: z.string(), teamId: z.string(), userId: z.string() });
export const teamInviteRequestWireSchema = teamAddMemberRequestWireSchema;
export const teamInvitationRefRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  invitationId: z.string(),
});
export const teamCreateWorkspaceRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  name: z.string(),
  defaultRole: defaultRoleWireSchema.optional(),
});
export const teamWorkspaceRefRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const teamUpdateWorkspaceRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  name: z.string().optional(),
  defaultRole: defaultRoleWireSchema.optional(),
  recordDesktopActivity: z.boolean().optional(),
});
export const teamSetAccessRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: workspaceRoleWireSchema,
});
export const teamAccessRefRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
});

export const teamListResponseWireSchema = z.object({
  teams: z.array(teamWireSchema),
  serverAdmin: z.boolean(),
  /** The server's `GET /meta` lists `desktop-activity`: it stores the workspace recording setting. */
  desktopActivity: z.boolean(),
});
export type TeamListResponse = z.infer<typeof teamListResponseWireSchema>;
export const teamResponseWireSchema = z.object({ team: teamWireSchema });
export const teamMembersResponseWireSchema = z.object({ members: z.array(teamMemberWireSchema) });
export const teamMemberResponseWireSchema = z.object({ member: teamMemberWireSchema });
export const teamInvitationsResponseWireSchema = z.object({ invitations: z.array(teamInvitationWireSchema) });
export const teamInviteResponseWireSchema = z.object({ invitation: teamInvitationCreatedWireSchema });
export const teamWorkspacesResponseWireSchema = z.object({ workspaces: z.array(teamWorkspaceWireSchema) });
export const teamWorkspaceResponseWireSchema = z.object({ workspace: teamWorkspaceWireSchema });
export const teamAccessResponseWireSchema = z.object({ entries: z.array(accessEntryWireSchema) });
export const teamDoneResponseWireSchema = z.object({ done: z.literal(true) });

// ---------------------------------------------------------------------------
// Workspaces on Wirebench Server (server-sync §3.4, §5.3). Share to a team, open a team workspace,
// and the two lists the dialogs show. Ids and the url are checked again in main: a workspace id only
// becomes a folder name there, after it has matched a ULID.
// ---------------------------------------------------------------------------

/** `workspace.shareToServer`: a new team workspace (O3's default roles) or an existing empty one (O1). */
export const workspaceShareToServerRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  /** Display only; kept in `share.yaml`. */
  teamName: z.string(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('new'), name: z.string(), defaultRole: defaultRoleWireSchema.optional() }),
    z.object({ kind: z.literal('existing'), workspaceId: z.string() }),
  ]),
});
export type WorkspaceShareToServerRequestWire = z.infer<typeof workspaceShareToServerRequestWireSchema>;
/** `workspace.joinFromServer`: *Open a team workspace…*'s choice. */
export const workspaceJoinFromServerRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export type WorkspaceJoinFromServerRequestWire = z.infer<typeof workspaceJoinFromServerRequestWireSchema>;
/** `workspace.serverTargets`: one team's empty workspaces the caller can edit. */
export const workspaceServerTargetsRequestWireSchema = z.object({ url: z.string(), teamId: z.string() });
export type WorkspaceServerTargetsRequestWire = z.infer<typeof workspaceServerTargetsRequestWireSchema>;
export const workspaceServerTargetsResponseWireSchema = z.object({ workspaces: z.array(teamWorkspaceWireSchema) });
export type WorkspaceServerTargetsResponseWire = z.infer<typeof workspaceServerTargetsResponseWireSchema>;
/** `workspace.teamWorkspaces`: every signed-in server's workspaces that have a head (empty ones stay hidden). */
export const workspaceTeamWorkspacesResponseWireSchema = z.object({
  workspaces: z.array(z.object({ url: z.string(), workspace: teamWorkspaceWireSchema })),
});
export type WorkspaceTeamWorkspacesResponseWire = z.infer<typeof workspaceTeamWorkspacesResponseWireSchema>;

// ---------------------------------------------------------------------------
// Webhook capture on Wirebench Server (webhook-capture §3.5, §4). Restated from the engine's
// `server-api/hooks.ts` rather than imported: this file must stay free of engine values. Main parses
// the server's answers with the engine's schemas first; these check what crosses the bridge.
// ---------------------------------------------------------------------------

export const catchUrlResponseWireSchema = z.object({
  status: z.number(),
  contentType: z.string().nullable(),
  body: z.string().nullable(),
  delayMs: z.number(),
});
export type CatchUrlResponseWire = z.infer<typeof catchUrlResponseWireSchema>;
/** The engine's `SignatureFailure`, restated (webhook-signatures §3.3). */
export const signatureFailureWireSchema = z.enum([
  'missing-header',
  'malformed-header',
  'mismatch',
  'stale-timestamp',
  'key-error',
]);
export type SignatureFailureWire = z.infer<typeof signatureFailureWireSchema>;
/** A capture's verdict; absent (or `null`) on a capture means not checked. */
export const captureSignatureWireSchema = z.object({
  verdict: z.enum(['verified', 'failed']),
  reason: signatureFailureWireSchema.optional(),
});
export type CaptureSignatureWire = z.infer<typeof captureSignatureWireSchema>;
export const catchUrlWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  response: catchUrlResponseWireSchema,
  captureCount: z.number(),
  newestCaptureId: z.string().nullable(),
  createdAt: z.string(),
  /** The scheme and only whether a secret is set; the hint only for editors (§3.4). */
  signature: z
    .object({
      scheme: signatureSchemeWireSchema,
      secret: z.object({ set: z.literal(true), hint: z.string().nullable() }),
    })
    .nullable()
    .optional(),
  rejectUnverified: z.boolean().optional(),
  /** `false` while the server's key is unset. Absent from a server without the module. */
  signatureAvailable: z.boolean().optional(),
});
export type CatchUrlWire = z.infer<typeof catchUrlWireSchema>;
export const captureSummaryWireSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  method: z.string(),
  subpath: z.string(),
  bodySize: z.number(),
  truncated: z.boolean(),
  sourceIp: z.string(),
  signature: captureSignatureWireSchema.nullable().optional(),
  rejected: z.boolean().optional(),
});
export type CaptureSummaryWire = z.infer<typeof captureSummaryWireSchema>;
/** One capture, decoded in main for the viewers the REST response pane already has. */
export const captureViewWireSchema = captureSummaryWireSchema.extend({
  query: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  /** The stored bytes: at most the server's body limit, so `bodySize` can be larger. */
  bodyBase64: z.string(),
  /** The first `Content-Type` the sender sent, if any. */
  contentType: z.string().nullable(),
  /** Decoded as a REST response body is; empty for an image or another binary body. */
  text: z.string(),
  language: z.enum(['json', 'xml', 'html', 'javascript', 'text', 'image', 'binary']),
  decodeNote: z.string().optional(),
});
export type CaptureViewWire = z.infer<typeof captureViewWireSchema>;
export const hooksMetaWireSchema = z.object({
  enabled: z.boolean(),
  bodyLimitBytes: z.number(),
  keep: z.number(),
  maxAgeDays: z.number(),
});
export type HooksMetaWire = z.infer<typeof hooksMetaWireSchema>;

/** A `hooks` nudge or a reconnect: re-list this workspace's catch URLs. */
export const hooksChangedEventWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export type HooksChangedEventWire = z.infer<typeof hooksChangedEventWireSchema>;
/** A `capture` nudge: the catch URL's unseen count may have grown. */
export const hooksCapturedEventWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  hookId: z.string(),
  captureId: z.string(),
});
export type HooksCapturedEventWire = z.infer<typeof hooksCapturedEventWireSchema>;
/** What changed in one open view: new summaries on top, a fresh first page, or a failed fetch. */
export const hooksCapturesEventWireSchema = z.discriminatedUnion('mode', [
  z.object({ viewId: z.string(), mode: z.literal('prepend'), captures: z.array(captureSummaryWireSchema) }),
  z.object({
    viewId: z.string(),
    mode: z.literal('replace'),
    captures: z.array(captureSummaryWireSchema),
    more: z.boolean(),
  }),
  z.object({
    viewId: z.string(),
    mode: z.literal('error'),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type HooksCapturesEventWire = z.infer<typeof hooksCapturesEventWireSchema>;

export const hooksServerRequestWireSchema = z.object({ url: z.string() });
export const hooksWorkspaceRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const hooksRefRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string(), hookId: z.string() });
export const hooksCreateRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseWireSchema.partial().optional(),
});
export type HooksCreateRequestWire = z.infer<typeof hooksCreateRequestWireSchema>;
export const hooksUpdateRequestWireSchema = hooksRefRequestWireSchema.extend({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseWireSchema.partial().optional(),
  /** `null` clears; without `secret` the stored one stays (§3.4). */
  signature: z.object({ scheme: signatureSchemeWireSchema, secret: z.string().optional() }).nullable().optional(),
  rejectUnverified: z.boolean().optional(),
});
export type HooksUpdateRequestWire = z.infer<typeof hooksUpdateRequestWireSchema>;
/** `after: null` counts every capture: this device has seen none of them. */
export const hooksUnseenRequestWireSchema = hooksRefRequestWireSchema.extend({ after: z.string().nullable() });
export const hooksViewRequestWireSchema = z.object({ viewId: z.string() });
export const hooksCaptureRequestWireSchema = z.object({ viewId: z.string(), captureId: z.string() });

export const hooksStatusResponseWireSchema = z.object({ hooks: hooksMetaWireSchema.nullable() });
export type HooksStatusResponseWire = z.infer<typeof hooksStatusResponseWireSchema>;
export const hooksListResponseWireSchema = z.object({ hooks: z.array(catchUrlWireSchema) });
export type HooksListResponseWire = z.infer<typeof hooksListResponseWireSchema>;
export const hooksHookResponseWireSchema = z.object({ hook: catchUrlWireSchema });
export const hooksDoneResponseWireSchema = z.object({ done: z.literal(true) });
export const hooksUnseenResponseWireSchema = z.object({ count: z.number(), more: z.boolean() });
export type HooksUnseenResponseWire = z.infer<typeof hooksUnseenResponseWireSchema>;
export const hooksPageResponseWireSchema = z.object({ captures: z.array(captureSummaryWireSchema), more: z.boolean() });
export type HooksPageResponseWire = z.infer<typeof hooksPageResponseWireSchema>;
export const hooksOpenResponseWireSchema = hooksPageResponseWireSchema.extend({ viewId: z.string() });
export type HooksOpenResponseWire = z.infer<typeof hooksOpenResponseWireSchema>;
export const hooksCaptureResponseWireSchema = z.object({ capture: captureViewWireSchema });

// ---------------------------------------------------------------------------
// Scripts (#63): the editor's language features, answered by main's checker, and the session values.
// ---------------------------------------------------------------------------

const scriptPhaseWireSchema = z.enum(['pre', 'post']);

/** Which script an editor holds: one of a request's two, or a mock operation's `dispatch.ts` (#352). */
const requestScriptTargetShape = { requestId: z.string(), phase: scriptPhaseWireSchema };
const dispatchScriptTargetShape = { mockId: z.string(), operationId: z.string() };

/** Bounded as a script file is: text over the limit refuses to send anyway. */
const scriptSourceShape = { source: z.string().max(256 * 1024) };
/** A position in a script: 1-based line and column, as the diagnostics report them. */
const scriptPositionShape = { line: z.number().int().min(1), column: z.number().int().min(1) };

export const scriptTargetWireSchema = z.union([
  z.object(requestScriptTargetShape),
  z.object(dispatchScriptTargetShape),
]);
export type ScriptTargetWire = z.infer<typeof scriptTargetWireSchema>;

/** A script as the editor holds it: which script, and its text. */
export const scriptSourceRequestSchema = z.union([
  z.object({ ...requestScriptTargetShape, ...scriptSourceShape }),
  z.object({ ...dispatchScriptTargetShape, ...scriptSourceShape }),
]);
export type ScriptSourceRequest = z.infer<typeof scriptSourceRequestSchema>;

export const scriptPositionRequestSchema = z.union([
  z.object({ ...requestScriptTargetShape, ...scriptSourceShape, ...scriptPositionShape }),
  z.object({ ...dispatchScriptTargetShape, ...scriptSourceShape, ...scriptPositionShape }),
]);
export type ScriptPositionRequest = z.infer<typeof scriptPositionRequestSchema>;

export const scriptDiagnosticWireSchema = z.object({
  line: z.number(),
  column: z.number(),
  endLine: z.number(),
  endColumn: z.number(),
  message: z.string(),
  code: z.number(),
  severity: z.enum(['error', 'warning']),
});
export type ScriptDiagnosticWire = z.infer<typeof scriptDiagnosticWireSchema>;

export const scriptDiagnosticsResponseSchema = z.object({ diagnostics: z.array(scriptDiagnosticWireSchema) });

export const scriptCompletionsResponseSchema = z.object({
  items: z.array(z.object({ name: z.string(), kind: z.string(), detail: z.string().optional() })),
});
export type ScriptCompletionsResponse = z.infer<typeof scriptCompletionsResponseSchema>;

export const scriptQuickInfoResponseSchema = z.object({
  info: z.object({ text: z.string(), documentation: z.string().optional() }).optional(),
});

export const scriptSignatureHelpResponseSchema = z.object({
  help: z
    .object({
      label: z.string(),
      parameters: z.array(z.string()),
      activeParameter: z.number(),
      documentation: z.string().optional(),
    })
    .optional(),
});

/** Request/response for `script.closeModel`: an editor closed, so its language service can go. */
export const scriptCloseModelRequestSchema = scriptTargetWireSchema;
export const scriptCloseModelResponseSchema = z.object({});

/** A project whose session values are asked for or cleared. */
export const scriptValuesRequestSchema = z.object({ projectId: z.string() });

/** One session value as the explorer lists it: a secret one has no value, and every value is masked. */
export const scriptValueWireSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  secret: z.boolean(),
});
export type ScriptValueWire = z.infer<typeof scriptValueWireSchema>;

export const scriptValuesListResponseSchema = z.object({ values: z.array(scriptValueWireSchema) });
export const scriptValuesClearResponseSchema = z.object({ cleared: z.number() });

/** Payload for `script.valuesChanged`: a project's session values changed; list them again. */
export const scriptValuesChangedEventSchema = z.object({ projectId: z.string() });

// --- CI tokens (callback-assertion §3, §5) -------------------------------------------------------

export const ciTokenSummaryWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type CiTokenSummaryWire = z.infer<typeof ciTokenSummaryWireSchema>;

export const ciTokensRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const ciTokensListResponseWireSchema = z.object({ tokens: z.array(ciTokenSummaryWireSchema) });
export const ciTokenCreateRequestWireSchema = ciTokensRequestWireSchema.extend({ name: z.string().min(1).max(64) });
/** Crosses the bridge once, for the *Copy* in the create panel; never stored in the renderer's state after it closes. */
export const ciTokenCreatedWireSchema = z.object({ id: z.string(), name: z.string(), token: z.string() });
export type CiTokenCreatedWire = z.infer<typeof ciTokenCreatedWireSchema>;
export const ciTokenRevokeRequestWireSchema = ciTokensRequestWireSchema.extend({ tokenId: z.string() });
export const ciTokenRevokeResponseWireSchema = z.object({ revoked: z.literal(true) });

// --- Server license (licensing spec §3.8, §5.3) --------------------------------------------------

/** What `GET /api/v1/license` answers, restated for the bridge; the renderer imports only its type. */
export const licenseStateWireSchema = z.object({
  edition: z.enum(['community', 'team', 'enterprise']),
  status: z.enum(['none', 'active', 'grace', 'expired', 'invalid']),
  seats: z.object({ used: z.number(), limit: z.number().nullable() }),
  features: z.array(z.string()),
  serverId: z.string().optional(),
  licenseId: z.string().optional(),
  customer: z.string().optional(),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  graceUntil: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type LicenseStateWire = z.infer<typeof licenseStateWireSchema>;
export const licenseRequestWireSchema = z.object({ url: z.string() });
export const licenseInstallRequestWireSchema = licenseRequestWireSchema.extend({
  license: z.string().min(1).max(8192),
});
export const licenseRemoveResponseWireSchema = z.object({ removed: z.literal(true) });

// --- Server audit log (audit-log spec §3.4, §5.3) ------------------------------------------------

/** What `GET /api/v1/audit` answers, restated for the bridge; the renderer imports only the types. */
export const auditActorWireSchema = z.object({
  kind: z.enum(['user', 'ci-token', 'system', 'anonymous']),
  userId: z.string().optional(),
  email: z.string().optional(),
  tokenId: z.string().optional(),
  workspaceId: z.string().optional(),
});
export const auditEventWireSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: auditActorWireSchema,
  action: z.string(),
  target: z.object({ kind: z.string(), id: z.string().nullable() }),
  workspaceId: z.string().nullable(),
  teamId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export const auditQueryWireSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  action: z
    .string()
    .regex(/^[a-z_]+\.([a-z_]+)?$/)
    .optional(),
  actorUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
  targetKind: z.string().optional(),
  targetId: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const auditPageWireSchema = z.object({ events: z.array(auditEventWireSchema), next: z.string().optional() });
export const auditQueryRequestWireSchema = z.object({ url: z.string(), query: auditQueryWireSchema });
export const auditExportRequestWireSchema = z.object({
  url: z.string(),
  query: auditQueryWireSchema.omit({ after: true, limit: true }),
});
export const auditExportResponseWireSchema = z.union([
  z.object({ saved: z.literal(false) }),
  z.object({ saved: z.literal(true), path: z.string(), count: z.number().int().nonnegative() }),
]);
export type AuditEventWire = z.infer<typeof auditEventWireSchema>;
export type AuditPageWire = z.infer<typeof auditPageWireSchema>;
export type AuditQueryWire = z.infer<typeof auditQueryWireSchema>;
export type AuditExportQueryWire = z.infer<typeof auditExportRequestWireSchema>['query'];
export type AuditExportResponseWire = z.infer<typeof auditExportResponseWireSchema>;
