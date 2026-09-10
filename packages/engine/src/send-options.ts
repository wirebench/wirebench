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
import type { HeaderEntry, ProjectSettings, RequestProperties } from './project/model.js';
import { soapActionHeaders } from './soap/soap-action.js';
import { prettyPrint, removeEmptyContent, stripWhitespaces } from './soap/transforms.js';
import type { SoapSendInput } from './types.js';

/** The parts of a request {@link toSendInput} reads. */
export interface SendRequestInput {
  readonly properties: RequestProperties;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
  readonly headers: readonly HeaderEntry[];
  readonly envelopeXml: string;
}

/** Everything {@link toSendInput} needs beyond the request itself. */
export interface ToSendInputArgs {
  readonly request: SendRequestInput;
  /** The already-resolved endpoint URL (environment overrides applied). */
  readonly endpoint: string;
  readonly preferences?: Preferences;
  readonly projectSettings?: Pick<ProjectSettings, 'defaultTimeoutMs'>;
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
 * Applies the envelope transforms a request asks for, in SoapUI's order: content removal
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
 * Timeout precedence is request > project > preference. Headers are the request's own, plus a
 * `User-Agent` from preferences when the request does not set one, plus `Accept-Encoding` when
 * response compression is enabled and `Connection: close` when connection reuse is disabled.
 * Request-body gzip is requested via `compressBody`; the transport does the compressing so the
 * `Content-Length` it computes describes the bytes that are actually sent.
 *
 * The MTOM/attachment properties are deliberately *not* mapped: they are stored and editable
 * now, and become effective with the attachments task.
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
    ...(properties.entitizeProperties ? { entitize: true } : {}),
  };
}
