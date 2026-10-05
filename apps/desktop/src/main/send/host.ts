/**
 * The desktop's `SendHost` (spec §3.1): what the engine borrows from the app for one send. Each
 * member is the app's own service — the project's secret getter, its proxy and trust preferences,
 * the request's or the global client keystore, the WS-Security keystores, the session's OAuth2 token cache, the workspace
 * cookie jar, the REST contract check, a callback's URL from History, a gRPC API's schema, the
 * session's issued SAML tokens — and the HTTP Log rows the desktop writes while a send is under way:
 * a failure row, a WebSocket handshake's row, and a row for each exchange with a token service.
 *
 * Every member is a port of what the desktop's own send paths did before every send went through
 * the engine, so a send logs, masks and checks exactly as the desktop always has.
 */
import { readFileSync } from 'node:fs';
import { failedRequestOf, findWebhookRequest, SIGNING_PSEUDO_REF_PREFIX } from '@wirebench/engine';
import type {
  AttemptedRequest,
  ClientIdentity,
  CookieJarHost,
  GetSecret,
  HttpExchange,
  IssuedTokenSource,
  OAuth2Auth,
  Preferences,
  ProxyOptions,
  RestExchange,
  RestRequestDef,
  RestSendInput,
  RunTokenSource,
  SelectedBase,
  SendFailure,
  SendHost,
  WsHandshake,
} from '@wirebench/engine';
import type { EngineService } from '../engine-service.js';
import { toHttpExchangeWire, toWsHandshakeWire } from '../engine-wire.js';
import { failedExchangeOf, type FailedExchangeInput } from '../failed-exchange.js';
import type { RequestChannelProject } from '../ipc/request.js';
import type { IssuedTokensService } from '../issued-tokens.js';
import type { OAuth2Service } from '../oauth2.js';
import { recordSecretValue, redactSecretBytes, redactXml } from '../redact.js';
import { restContractOf } from '../rest-contract.js';
import { callbackUrlFor } from '../webhook-send.js';
import { AD_HOC_ID } from './draft.js';
import type { FailedExchangeWire, HistoryEntryWire, LogEntryWire } from '../../shared/wire-types.js';

export interface DesktopSendDeps {
  readonly project: RequestChannelProject;
  /** The exchange cache and the contract checker. */
  readonly service: EngineService;
  readonly oauth2?: Pick<OAuth2Service, 'accessToken' | 'clear'>;
  /** The session's issued SAML tokens; absent, each run fetches its own (and logs no STS row). */
  readonly issuedTokens?: Pick<IssuedTokensService, 'source'>;
  /** Resolves one keychain reference: an OAuth2 client secret or remembered refresh token. */
  readonly getSecret?: (ref: string) => Promise<string | undefined>;
  /** The getter one project's `${secret:name}` tokens resolve through (`projectSecretGetter`). */
  readonly secretsFor?: (projectId: string | undefined) => GetSecret;
  readonly preferences?: () => Preferences;
  /** The newest History entry of a request, which a callback's URL expression reads. */
  readonly newestHistory?: (projectId: string, requestId: string) => HistoryEntryWire | undefined;
  /** The session "show secrets" flag, which the handshake row is redacted by; absent: redacted. */
  readonly showSecrets?: { get(): boolean };
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
  readonly onExchange?: (entry: LogEntryWire) => void;
  /** The open workspace's cookie jar (cookie jar spec §2), asked for once at the start of each send; absent in tests that never send cookies. */
  readonly cookies?: () => CookieJarHost;
}

export interface DesktopSend {
  readonly sendId: string;
  readonly requestId: string;
  readonly projectId: string | undefined;
  readonly envId?: string;
  /** The names of an API key in the query or a header; their values are masked in the rows. */
  readonly keyParams?: readonly string[];
  readonly keyHeaders?: readonly string[];
  /** Set by the host's `onFailed`: which stage failed, so the caller writes History only for 'send'. */
  failedStage?: 'prepare' | 'send';
  /** Set by the host's `onExchange` when the WebSocket handshake row was written. */
  handshakeLogged?: boolean;
}

/**
 * The engine's host for one desktop send. Async because the trust anchors are read (the CA bundle
 * may be a file) before the host is handed over.
 */
export async function desktopSendHost(deps: DesktopSendDeps, send: DesktopSend): Promise<SendHost> {
  const { project } = deps;
  const { projectId } = send;
  // Bound before any await: a workspace switch while this send runs must not move it to another jar.
  const cookies = deps.cookies?.();
  const bundle = projectId === undefined ? undefined : await project.trustAnchorsFor?.(projectId);
  const anchors = [...(bundle ?? []), ...extraTrustAnchors()];
  const preferences = deps.preferences?.();
  const tokens = oauth2Tokens(deps);
  const issued = issuedTokensFor(deps, send);
  return {
    getSecret: desktopSecrets(deps, projectId),
    onSecretValue: recordSecretValue,
    proxyFor: async (url) => {
      const proxy = projectId === undefined ? undefined : await project.proxyFor?.(projectId, url);
      return proxy === undefined ? undefined : withoutUndefined<ProxyOptions>(proxy);
    },
    tls: {
      ...(anchors.length > 0 ? { anchors } : {}),
      identityFor: async (keystoreId) => {
        const identity = projectId === undefined ? undefined : await project.clientIdentityFor?.(projectId, keystoreId);
        return identity?.cert === undefined || identity.key === undefined
          ? undefined
          : ({ cert: identity.cert, key: identity.key } satisfies ClientIdentity);
      },
    },
    // The project's own loader: it also reads a keystore picked this session, outside the project folder.
    ...(projectId !== undefined && project.keystoreFor !== undefined
      ? { keystoreFor: async (keystoreId: string) => await project.keystoreFor?.(projectId, keystoreId) }
      : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(issued !== undefined ? { issuedTokens: issued } : {}),
    ...(preferences !== undefined ? { preferences } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
    contractFor: restContractFor(deps),
    callbackUrlFor: (item) => Promise.resolve(callbackUrlOf(deps, send, item)),
    // The project's own schema for a gRPC API, which it loads once a session, discovered or imported.
    ...(project.grpcProtoSetFor !== undefined
      ? { protoSetFor: async (item: SelectedBase) => await project.grpcProtoSetFor?.(item.request.id) }
      : {}),
    events: {
      onFailed: (item, failure) => {
        send.failedStage = failure.stage;
        // Every module says what it attempted; without that there is no row to write.
        const { attempted } = failure;
        if (attempted === undefined) return;
        reportSendFailed(deps.onSendFailed, () => failedExchangeOf(failureRowOf(send, item, failure, attempted)));
      },
      onExchange: (item, exchange) => {
        if (item.kind !== 'websocket') return;
        send.handshakeLogged = true;
        reportWsHandshake(deps, send, exchange as WsHandshake);
      },
    },
  };
}

/**
 * The getter `tokenSecrets` builds in `ipc/request.ts`: the send's own project's. A webhook signing
 * pseudo-ref (a node that names only a CI variable) is never looked up (R7): the desktop reads a
 * signing secret from the keychain by `secretRef` alone, so such a node refuses rather than signs.
 */
function desktopSecrets(deps: DesktopSendDeps, projectId: string | undefined): GetSecret {
  const getSecret = deps.secretsFor?.(projectId) ?? ((ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined));
  return (ref) => (ref.startsWith(SIGNING_PSEUDO_REF_PREFIX) ? Promise.resolve(undefined) : getSecret(ref));
}

/** The OAuth2 service as the engine's token source: its cache, its browser flow, its `clear`. */
function oauth2Tokens(deps: DesktopSendDeps): RunTokenSource | undefined {
  const oauth2 = deps.oauth2;
  if (oauth2 === undefined) return undefined;
  const issued = new Map<string, OAuth2Auth>();
  return {
    async accessTokenFor(config, request) {
      const proxy = request.proxy !== undefined ? await request.proxy(config.tokenUrl) : undefined;
      const token = await oauth2.accessToken(config, {
        credentials: await oauth2Credentials(deps, config),
        ...(request.tls !== undefined ? { tls: request.tls } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      // As `resolveAuthConfig` (secret-resolver.ts) records the token it puts on the wire.
      recordSecretValue(token);
      issued.set(token, config);
      return token;
    },
    reject(token) {
      const config = issued.get(token);
      if (config !== undefined) oauth2.clear(config);
    },
  };
}

/**
 * The session's issued-token source as this send's: the same cache, with every exchange the send
 * makes with a token service reported as its own HTTP Log row. A cached token asks no service, so
 * it makes no row.
 */
function issuedTokensFor(deps: DesktopSendDeps, send: DesktopSend): IssuedTokenSource | undefined {
  const source = deps.issuedTokens?.source;
  if (source === undefined) return undefined;
  return {
    get: (entry, target, trustDeps) =>
      source.get(entry, target, {
        ...trustDeps,
        onExchange: (exchange) => {
          trustDeps.onExchange?.(exchange);
          reportStsExchange(deps, send, exchange);
        },
      }),
    peek: (entry, target) => source.peek(entry, target),
    reject: (token) => {
      source.reject(token);
    },
    status: (entry, target) => source.status(entry, target),
    clear: (entry, target) => {
      source.clear(entry, target);
    },
  };
}

/**
 * The HTTP Log row of one exchange with a token service: marked `sts`, and linked by `causedBy` to
 * the send it was made for when there is one (Fetch now has none). Redacted as a SOAP row is, and the
 * body too, since the row has no `response` to redact: an assertion's signature value, a proof
 * key's secret and every recorded secret value (the assertion is one) are masked unless `show`.
 */
export function stsLogEntry(
  http: HttpExchange,
  opts: { readonly show: boolean; readonly requestId?: string; readonly causedBy?: string },
): LogEntryWire {
  const { show } = opts;
  const wire = toHttpExchangeWire(http, { show });
  const body = redactBody(wire.bodyBase64, show);
  return {
    kind: 'exchange',
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    exchange: {
      sendId: `${opts.causedBy ?? 'fetch'}:sts:${String(Date.now())}`,
      durationMs: http.timings.totalMs,
      http: {
        ...wire,
        bodyBase64: body,
        // A compressed body's bytes are not text the redaction reads, so the decoded, redacted body
        // stands in for them rather than the assertion crossing the bridge compressed.
        rawBodyBase64: show ? wire.rawBodyBase64 : body,
      },
      problems: [],
      auxiliary: 'sts',
      ...(opts.causedBy !== undefined ? { causedBy: opts.causedBy } : {}),
    },
  };
}

/** A token service's reply body, its XML secrets and recorded values masked unless `show`. */
function redactBody(base64: string, show: boolean): string {
  if (show) return base64;
  const text = Buffer.from(base64, 'base64').toString('utf8');
  const masked = redactXml(text);
  // Re-encoded only when something was masked, so a body that is not text keeps its bytes.
  return redactSecretBytes(masked === text ? base64 : Buffer.from(masked, 'utf8').toString('base64'));
}

/** The STS exchange as its own HTTP Log row (never History), redacted like any SOAP row. */
function reportStsExchange(deps: DesktopSendDeps, send: DesktopSend, http: HttpExchange): void {
  if (deps.onExchange === undefined) return;
  try {
    deps.onExchange(
      stsLogEntry(http, {
        show: deps.showSecrets?.get() ?? false,
        ...(send.requestId !== AD_HOC_ID ? { requestId: send.requestId } : {}),
        causedBy: send.sendId,
      }),
    );
  } catch {
    // A broadcast that fails never affects the send, as `reportWsHandshake`'s own catch.
  }
}

/** The client secret and remembered refresh token an OAuth2 token request needs, if any. */
async function oauth2Credentials(
  deps: Pick<DesktopSendDeps, 'getSecret'>,
  config: OAuth2Auth,
): Promise<{ readonly clientSecret?: string; readonly refreshToken?: string }> {
  const read = async (ref: string | undefined): Promise<string | undefined> =>
    ref === undefined || ref === '' ? undefined : await deps.getSecret?.(ref);
  const clientSecret = await read(config.clientSecretRef);
  const refreshToken = await read(config.refreshTokenRef);
  return {
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

/**
 * A REST response checked against its OpenAPI operation, as the desktop always checked it: only a
 * JSON body that is not a stream, within the service's deadline. The operation is found
 * from the method and the request's own URL as they were sent (the path, not the base URL joined to
 * it), as the send path always matched it; the exchange's URL stands in when the input is absent.
 */
function restContractFor(deps: DesktopSendDeps): NonNullable<SendHost['contractFor']> {
  return (item, exchange, sent) => {
    if (item.kind !== 'rest') return Promise.resolve(undefined);
    const rest = exchange as RestExchange;
    const input = sent as RestSendInput | undefined;
    const target = deps.project.restContractFor?.(item.request.id, {
      method: input?.request.method ?? rest.request.method,
      url: input?.request.url ?? rest.request.url,
    });
    // Handled here too, as the send path did: a cache that fails to read is reported by the check.
    target?.catch(() => undefined);
    return restContractOf(
      {
        status: rest.status,
        headers: rest.headers,
        text: rest.text,
        language: rest.language,
        streamed: rest.stream !== undefined,
      },
      target,
      (input) => deps.service.checkRestContract(input),
      undefined,
      { deadlineMs: deps.service.restContractDeadlineMs },
    );
  };
}

/** A webhook callback's URL from the newest exchange of its parent; `undefined` keeps the target. */
function callbackUrlOf(deps: DesktopSendDeps, send: DesktopSend, item: SelectedBase): string | undefined {
  const { projectId } = send;
  const located = deps.project.runContextFor?.(item.request.id, send.envId);
  const webhooks = located?.project.webhooks;
  if (
    projectId === undefined ||
    located === undefined ||
    webhooks === undefined ||
    findWebhookRequest(webhooks, item.request.id) === undefined
  ) {
    return undefined;
  }
  return callbackUrlFor(located.project, item.request as RestRequestDef, (id) => deps.newestHistory?.(projectId, id))
    .url;
}

/**
 * The HTTP Log's failure row, as `ipc/request.ts` builds it: a prepare row carries no headers (the
 * request was never built), a send row the enabled headers and whatever the transport captured.
 */
function failureRowOf(
  send: DesktopSend,
  item: SelectedBase,
  failure: SendFailure,
  attempted: AttemptedRequest,
): FailedExchangeInput {
  return {
    sendId: send.sendId,
    protocol: item.kind as FailedExchangeInput['protocol'],
    // An ad-hoc send has no request to name.
    requestId: send.requestId === AD_HOC_ID ? undefined : send.requestId,
    url: attempted.url,
    method: attempted.method,
    startedAt: failure.startedAt,
    durationMs: failure.durationMs,
    error: failure.error,
    ...(failure.stage === 'prepare'
      ? { headers: {}, stage: 'prepare' as const }
      : { headers: attempted.headers, captured: failedRequestOf(failure.error) }),
    ...(send.keyParams !== undefined ? { keyParams: send.keyParams } : {}),
    ...(send.keyHeaders !== undefined ? { keyHeaders: send.keyHeaders } : {}),
  };
}

/**
 * The HTTP Log's row for a successful WebSocket handshake, written the moment it settles — not
 * when the session closes, since the send stays pending for the whole session. Reported through
 * `deps.onExchange`, the live twin `onSendFailed` is for a send whose own invoke never leaves main
 * until long after the row should appear.
 *
 * Only ever called with a `status === 101` handshake: the engine tells the host of a handshake only
 * when it actually opened. A refused or failed one is reported from the settled exchange instead.
 */
function reportWsHandshake(deps: DesktopSendDeps, send: DesktopSend, opened: WsHandshake): void {
  if (deps.onExchange === undefined) {
    return;
  }
  const handshake = toWsHandshakeWire(opened, {
    show: deps.showSecrets?.get() ?? false,
    ...(send.keyParams !== undefined ? { keyParams: send.keyParams } : {}),
  });
  const entry: LogEntryWire = {
    kind: 'exchange',
    requestId: send.requestId,
    exchange: {
      sendId: send.sendId,
      protocol: 'websocket',
      method: 'GET',
      // `http(s)://` so the row filters/searches like every other; `wsUrl` keeps `ws(s)://` for display.
      url: handshake.url.replace(/^ws/, 'http'),
      wsUrl: handshake.url,
      requestHeaders: handshake.requestHeaders,
      ...(handshake.rawRequestHead !== undefined ? { rawRequestHead: handshake.rawRequestHead } : {}),
      status: 101,
      responseHeaders: handshake.responseHeaders ?? {},
      startedAt: handshake.startedAt,
      durationMs: handshake.durationMs,
      ...(handshake.tls !== undefined ? { tls: handshake.tls } : {}),
    },
  };
  try {
    deps.onExchange(entry);
  } catch {
    // Deliberately ignored — a broadcast that fails must never affect the session, like `onSendFailed`'s own catch.
  }
}

/**
 * e2e-only: extra trust anchors for every send, as one PEM file named by
 * `WIREBENCH_E2E_EXTRA_CA_FILE`.
 *
 * Superseded, for real use, by the `ssl.caBundlePath` preference (see
 * `ProjectHost.trustAnchors`), which is how a user configures a private CA and which a spec
 * can now drive through the picker with `WIREBENCH_E2E_FILE_DIALOG_PATH`. This hook survives for
 * the specs that predate the preference and only need *some* anchor in place before the
 * Preferences UI exists in their flow; it adds to `tls.ca` exactly as the preference does.
 *
 * The Playwright suite talks to a TLS server signed by a CA it generates at run time, and
 * Wirebench must trust it *the way a user would* — by configuring trust, not by turning
 * verification off, and not by letting a client keystore double as a trust store (which is
 * exactly the confusion `toTlsClientIdentity` was changed to avoid). So a test build takes the
 * anchors from an env var no shipped build ever sets, alongside `WIREBENCH_E2E_OPEN_PATH`,
 * `WIREBENCH_E2E_SAVE_PATH`, `WIREBENCH_E2E_DIALOG_FOLDER`, `WIREBENCH_E2E_DIALOG_SAVE` and
 * `WIREBENCH_E2E_FILE_DIALOG_PATH`.
 *
 * TLS verification itself is untouched: these anchors are *added* to a send's `tls.ca`, and
 * `rejectUnauthorized` keeps its default. The file is read once and remembered; an unset or
 * unreadable variable simply yields no anchors, so an ordinary run pays nothing for it.
 */
let e2eTrustAnchors: readonly string[] | undefined;
export function extraTrustAnchors(): readonly string[] {
  if (e2eTrustAnchors === undefined) {
    const path = process.env['WIREBENCH_E2E_EXTRA_CA_FILE'];
    try {
      e2eTrustAnchors = path === undefined || path.length === 0 ? [] : [readFileSync(path, 'utf-8')];
    } catch {
      e2eTrustAnchors = [];
    }
  }
  return e2eTrustAnchors;
}

/**
 * Hands a failure row to `onSendFailed`, if one is wired. Anything the row builder or the listener
 * throws is swallowed: the send's own error is what the caller rethrows and the user must see.
 */
export function reportSendFailed(
  onSendFailed: ((failure: FailedExchangeWire) => void) | undefined,
  failure: () => FailedExchangeWire,
): void {
  if (onSendFailed === undefined) {
    return;
  }
  try {
    onSendFailed(failure());
  } catch {
    // Deliberately ignored — see above.
  }
}

/**
 * Drops the keys whose value came over as `undefined`: the wire's proxy shape allows
 * present-and-undefined fields, the engine's (`exactOptionalPropertyTypes`) does not.
 */
function withoutUndefined<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
