/**
 * Turns a saved REST request plus the settings around it into the {@link RestSendInput} the
 * transport receives. The precedence between the layers of configuration is fixed here rather than
 * in the host: the request's own setting wins, then the API's, then the project's, then the user's
 * preference. A setting left unset is therefore never "off" — it is "inherit".
 */

import type { SendAuth } from '../http/auth/send-auth.js';
import type { Cookie } from '../http/cookies.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';
import { inherited } from '../project/inherit.js';
import type { ProjectSettings } from '../project/model.js';
import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import type { FileResolver } from './body.js';
import type { RestBody, RestMethod, RestRequestSettings } from './model.js';
import type { RestSendInput } from './send.js';

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
