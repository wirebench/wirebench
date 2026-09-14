/**
 * Turns a saved request plus the settings around it into the {@link SoapSendInput} the
 * transport actually receives.
 *
 * This is the single place the three layers of configuration meet, and the precedence between
 * them is fixed here rather than in the desktop app: the request's own property wins, then the
 * project's setting, then the user's preference (which is also the engine default). A property
 * left unset in the request is therefore never "off" — it is "inherit".
 */

import { DEFAULT_PREFERENCES } from './project/preferences.js';
import type { Preferences } from './project/preferences.js';
import type { Attachment, HeaderEntry, ProjectSettings, RequestProperties } from './project/model.js';
import type { AttachmentResolver } from './soap/mime/types.js';
import { soapActionHeaders } from './soap/soap-action.js';
import { prettyPrint, removeEmptyContent, stripWhitespaces } from './soap/transforms.js';
import type { SendAuth, SoapSendInput } from './types.js';
import type { ProxyOptions, TlsOptions } from './http/types.js';
import type { FileResolver } from './rest/body.js';
import type { KeyValueEntry, RestBody, RestMethod, RestRequestSettings } from './rest/model.js';
import type { Cookie } from './rest/response.js';
import type { RestSendInput } from './rest/send.js';

/** The parts of a request {@link toSendInput} reads. */
export interface SendRequestInput {
  readonly properties: RequestProperties;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
  readonly headers: readonly HeaderEntry[];
  readonly envelopeXml: string;
}

/**
 * How the send is to read attachment and inline-file bytes. The engine never opens a file
 * on its own, so without this the request's attachments (and its inline-file property) are
 * left inert; the desktop main process supplies `createFileAttachmentResolver`.
 */
export interface AttachmentResolvers {
  readonly resolver: AttachmentResolver;
  /** Reads one file for "Enable Inline Files". */
  readonly resolveFile?: (path: string) => Promise<Uint8Array>;
  /** The project's resource root, for relative inline-file references. */
  readonly resourceRoot?: string;
}

/** Everything {@link toSendInput} needs beyond the request itself. */
export interface ToSendInputArgs {
  readonly request: SendRequestInput;
  /** The already-resolved endpoint URL (environment overrides applied). */
  readonly endpoint: string;
  readonly preferences?: Preferences;
  readonly projectSettings?: Pick<ProjectSettings, 'defaultTimeoutMs'>;
  /** The request's attachments; only acted on together with {@link attachmentResolvers}. */
  readonly attachments?: readonly Attachment[];
  readonly attachmentResolvers?: AttachmentResolvers;
}

/** Case-insensitive lookup over a header map. */
function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/** Whether `encoding` is (a spelling of) the transport's own default, so nothing needs reflecting. */
function isDefaultEncoding(encoding: string): boolean {
  const normalized = encoding.trim().toLowerCase();
  return normalized.length === 0 || normalized === 'utf-8' || normalized === 'utf8';
}

/**
 * Applies the envelope transforms a request asks for, in a fixed order: content removal
 * first (so whitespace and formatting decisions see the final element set), then whitespace
 * stripping, then pretty printing. Entitizing is not here — it happens during property
 * expansion; see `soap/transforms.ts`.
 */
function transformEnvelope(xml: string, properties: RequestProperties, indentWidth: number): string {
  let out = xml;
  if (properties.removeEmptyContent) {
    out = removeEmptyContent(out);
  }
  if (properties.stripWhitespaces) {
    out = stripWhitespaces(out);
  }
  if (properties.prettyPrint) {
    out = prettyPrint(out, indentWidth);
  }
  return out;
}

/**
 * Builds the send input for one request.
 *
 * Timeout precedence is request > project > preference. The TLS floor (`ssl.minVersion`) and
 * the HTTP/2 offer come from preferences alone. Headers are the request's own, plus a
 * `User-Agent` from preferences when the request does not set one, plus `Accept-Encoding` when
 * response compression is enabled and `Connection: close` when connection reuse is disabled.
 * Request-body gzip is requested via `compressBody`; the transport does the compressing so the
 * `Content-Length` it computes describes the bytes that are actually sent.
 *
 * The MTOM/attachment properties are mapped only when `attachmentResolvers` says how bytes
 * can be read; without a resolver there is nothing the transport could do with them, and a
 * half-configured send would silently drop parts.
 *
 * @param args the request, its resolved endpoint, and the preferences/project settings around it
 */
export function toSendInput(args: ToSendInputArgs): SoapSendInput {
  const preferences = args.preferences ?? DEFAULT_PREFERENCES;
  const { properties } = args.request;

  const headers: Record<string, string> = {};
  for (const header of args.request.headers) {
    headers[header.name] = header.value;
  }
  if (!hasHeader(headers, 'user-agent') && preferences.http.userAgent.length > 0) {
    headers['User-Agent'] = preferences.http.userAgent;
  }
  if (preferences.http.responseCompression && !hasHeader(headers, 'accept-encoding')) {
    headers['Accept-Encoding'] = 'gzip, deflate';
  }
  if (preferences.http.closeConnections && !hasHeader(headers, 'connection')) {
    headers['Connection'] = 'close';
  }
  // A non-default `encoding` property changes what bytes actually go on the wire (see
  // `encodeBody` in `send.ts`), so the `Content-Type` charset must say the same thing — a
  // request sent as ISO-8859-1 but declared UTF-8 would decode wrong at the far end. This is
  // skipped for the default encoding so a request with no opinion keeps getting the transport's
  // own `UTF-8` charset, computed downstream exactly as it always has been.
  if (!isDefaultEncoding(properties.encoding) && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = soapActionHeaders(args.request.soapVersion, args.request.soapAction, {
      ...(properties.skipSoapAction !== undefined ? { skipSoapAction: properties.skipSoapAction } : {}),
      charset: properties.encoding,
    }).contentType;
  }

  const timeoutMs = properties.timeoutMs ?? args.projectSettings?.defaultTimeoutMs ?? preferences.http.socketTimeoutMs;

  const resolvers = args.attachmentResolvers;
  const attachmentOptions =
    resolvers === undefined
      ? undefined
      : {
          enableMtom: properties.enableMtom,
          forceMtom: properties.forceMtom,
          disableMultiparts: properties.disableMultiparts,
          encodeAttachments: properties.encodeAttachments,
          enableInlineFiles: properties.enableInlineFiles,
          inlineResponseAttachments: properties.inlineResponseAttachments,
          expandMtomAttachments: properties.expandMtomAttachments,
          resolver: resolvers.resolver,
          ...(resolvers.resolveFile !== undefined ? { resolveFile: resolvers.resolveFile } : {}),
          ...(resolvers.resourceRoot !== undefined ? { resourceRoot: resolvers.resourceRoot } : {}),
        };

  return {
    endpoint: args.endpoint,
    envelopeXml: transformEnvelope(args.request.envelopeXml, properties, preferences.editor.tabSize),
    soapVersion: args.request.soapVersion,
    ...(args.request.soapAction !== undefined ? { soapAction: args.request.soapAction } : {}),
    headers,
    timeoutMs,
    encoding: properties.encoding,
    followRedirects: properties.followRedirects,
    skipSoapAction: properties.skipSoapAction,
    ...(properties.maxSizeBytes !== undefined ? { maxSizeBytes: properties.maxSizeBytes } : {}),
    ...(properties.bindAddress !== undefined && properties.bindAddress.length > 0
      ? { localAddress: properties.bindAddress }
      : {}),
    ...(preferences.http.requestCompression === 'gzip' ? { compressBody: 'gzip' as const } : {}),
    ...(preferences.http.allowH2 ? { allowH2: true } : {}),
    // The minimum protocol version is a floor the user sets once; everything else in `tls`
    // (trust anchors, the client identity, a per-endpoint trust decision) is resolved in the
    // desktop's main process, which reads files and secrets, and merged onto this.
    tls: { minVersion: preferences.ssl.minVersion },
    ...(properties.entitizeProperties ? { entitize: true } : {}),
    ...(attachmentOptions !== undefined ? { attachments: args.attachments ?? [], attachmentOptions } : {}),
  };
}

/** The parts of a REST request {@link toRestSendInput} reads. */
export interface RestSendRequestInput {
  readonly method: RestMethod;
  readonly url: string;
  readonly pathParams: readonly KeyValueEntry[];
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly body: RestBody;
  readonly settings: RestRequestSettings;
}

/** Everything {@link toRestSendInput} needs beyond the request itself. */
export interface ToRestSendInputArgs {
  readonly request: RestSendRequestInput;
  /** The API's effective base URL, environment override applied and properties expanded. */
  readonly baseUrl: string;
  /** The API's own settings, which a request inherits where it sets nothing. */
  readonly apiSettings?: RestRequestSettings;
  readonly preferences?: Preferences;
  readonly projectSettings?: Pick<ProjectSettings, 'defaultTimeoutMs'>;
  /** Resolved credentials; the host turns `secretRef`s into values and tokens into `oauth2`. */
  readonly auth?: SendAuth;
  /** Cookies already matched against the URL, when the request asks for them. */
  readonly cookies?: readonly Cookie[];
  /** How a multipart file part or a binary body is read. */
  readonly resolveFile?: FileResolver;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly signal?: AbortSignal;
}

/** The first of `values` that is not `undefined`, which is what "inherit" means. */
function inherited<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

/**
 * Builds the send input for one REST request.
 *
 * Precedence is request → API → project → preference, the same ladder a SOAP request's properties
 * climb, and for the same reason: a setting the request leaves unset means *inherit*, never *off*.
 * The headers the host adds on the request's behalf — `User-Agent`, `Accept-Encoding`, `Connection`,
 * a default `Accept` — are passed separately from the request's own, so `rest/send.ts` can let the
 * user's typed header win without having to guess which came from where.
 */
export function toRestSendInput(args: ToRestSendInputArgs): RestSendInput {
  const preferences = args.preferences ?? DEFAULT_PREFERENCES;
  const request = args.request;
  const api = args.apiSettings ?? {};

  const defaultHeaders: Record<string, string> = {};
  if (preferences.http.userAgent.length > 0) {
    defaultHeaders['User-Agent'] = preferences.http.userAgent;
  }
  if (preferences.http.responseCompression) {
    defaultHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  }
  if (preferences.http.closeConnections) {
    defaultHeaders.Connection = 'close';
  }
  if (preferences.rest.defaultAccept.length > 0) {
    defaultHeaders.Accept = preferences.rest.defaultAccept;
  }

  const timeoutMs =
    inherited(request.settings.timeoutMs, api.timeoutMs, args.projectSettings?.defaultTimeoutMs) ??
    preferences.http.socketTimeoutMs;
  const followRedirects =
    inherited(request.settings.followRedirects, api.followRedirects) ?? preferences.rest.followRedirects;
  const maxRedirects = inherited(request.settings.maxRedirects, api.maxRedirects) ?? preferences.rest.maxRedirects;
  const keepBodyOnRedirect = inherited(request.settings.keepBodyOnRedirect, api.keepBodyOnRedirect);
  const encodeUrl = inherited(request.settings.encodeUrl, api.encodeUrl);
  const maxSizeBytes = inherited(request.settings.maxSizeBytes, api.maxSizeBytes);
  const bindAddress = inherited(request.settings.bindAddress, api.bindAddress);

  return {
    baseUrl: args.baseUrl,
    request: {
      method: request.method,
      url: request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
    },
    settings: {
      timeoutMs,
      followRedirects,
      maxRedirects,
      ...(keepBodyOnRedirect !== undefined ? { keepBodyOnRedirect } : {}),
      ...(encodeUrl !== undefined ? { encodeUrl } : {}),
      ...(maxSizeBytes !== undefined ? { maxSizeBytes } : {}),
      ...(bindAddress !== undefined && bindAddress.length > 0 ? { localAddress: bindAddress } : {}),
      ...(preferences.http.allowH2 ? { allowH2: true } : {}),
    },
    defaultHeaders,
    ...(args.auth !== undefined ? { auth: args.auth } : {}),
    ...(args.cookies !== undefined ? { cookies: args.cookies } : {}),
    // As for SOAP: the TLS floor is the user's one-off choice, and everything else in `tls` is
    // resolved by the host, which reads files and secrets, and merged onto this.
    tls: { minVersion: preferences.ssl.minVersion, ...args.tls },
    ...(args.proxy !== undefined ? { proxy: args.proxy } : {}),
    ...(args.resolveFile !== undefined ? { resolveFile: args.resolveFile } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };
}
