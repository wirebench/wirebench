/**
 * Wraps `EngineService.send` so every completed (or failed) send is also recorded to the open
 * project's history — shared by `request.send` (`ipc/request.ts`) and `history.resend`
 * (`ipc/history.ts`), which both need the exact same "send, then append a redacted entry"
 * behaviour.
 */

import {
  failedRequestOf,
  isEndpointAuth,
  isWirebenchError,
  resolveSecretTokens,
  resolveSoapAuth,
  secretNamesInValue,
} from '@wirebench/engine';
import type { OAuth2Auth } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { failedExchangeOf } from './failed-exchange.js';
import type { HistoryService } from './history-service.js';
import type { OAuth2Service } from './oauth2.js';
import type { ProjectRouter } from './project-router.js';
import type { GetSecret, PropertyScopes } from '@wirebench/engine';
import type {
  ExchangeSummary,
  FailedExchangeWire,
  HistoryEntryWire,
  ResolvedSendRequest,
} from '../shared/wire-types.js';

/** What an ad-hoc send with no `adHocScopes` expands against: nothing but the process env. */
const EMPTY_SCOPES: PropertyScopes = { project: {}, global: {}, system: process.env };

/** What `sendAndRecordHistory` needs from `ProjectRouter`, so tests can stub a minimal object. */
export type HistorySendProject = Pick<ProjectRouter, 'scopesFor' | 'authFor' | 'requestMeta' | 'projectId'> &
  // Optional so the many test stubs (and any ad-hoc caller with no project) stay valid: a send
  // without it simply carries no attachments, which is what an ad-hoc send should do anyway.
  // `wssFor` is optional for the same reason, and async besides: it resolves a password out of
  // the secret store, which is why it cannot live on the synchronous send input.
  // `proxyFor` is optional for the same reason, and async besides: resolving the proxy password
  // means a round trip to the OS keychain.
  // `tlsFor` is optional too: it only feeds the OAuth2 token request, which then uses the defaults.
  Partial<Pick<ProjectRouter, 'sendAttachmentsFor' | 'wssFor' | 'proxyFor' | 'tlsFor'>>;

/** Dependencies for {@link sendAndRecordHistory}. */
export interface SendWithHistoryDeps {
  readonly project: HistorySendProject;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  readonly showSecrets?: { get(): boolean };
  /** Omitted only in tests that don't care about history; the app always wires one in. */
  readonly history?: HistoryService;
  /** Called with the entry a successful record produced, so the caller can broadcast it. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so the
   * caller can broadcast `exchange.failed`. Omitted in tests that don't care.
   */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
  /**
   * The getter the send's `${secret:name}` tokens resolve through, for the request's own project
   * (`projectSecretGetter`). Omitted in tests that send no tokens, where a token then refuses the
   * send as `secret-missing`.
   */
  readonly secretsFor?: (projectId: string | undefined) => GetSecret;
  /**
   * The app's OAuth2 token service, for a SOAP owner configured with OAuth2. Omitted in tests
   * that never send one, which then send no token rather than quietly obtaining one.
   */
  readonly oauth2?: Pick<OAuth2Service, 'accessToken'>;
  /** Resolves the client secret and remembered refresh token an OAuth2 token request needs. */
  readonly getSecret?: (ref: string) => Promise<string | undefined>;
}

/** The label used when the send's `requestId` is unknown or no longer exists. */
export interface HistoryNameFallback {
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
  /**
   * The project an entry for a send with no live request is keyed to. Only a resend supplies
   * one — the project whose history the resent entry came from; with none, such a send is
   * simply not recorded, since no project owns it.
   */
  readonly projectId?: string;
}

const AD_HOC_NAME: HistoryNameFallback = { requestName: 'Ad-hoc request', interfaceName: '', operationName: '' };

function errorDetail(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Sends `request` through `service.send`, then records a history entry for it (success, SOAP
 * fault, or transport error) against the project that owns the request — a no-op when no
 * project does (see {@link HistoryNameFallback.projectId}) or no `HistoryService` was supplied. Rethrows whatever `service.send` throws, after recording.
 */
export async function sendAndRecordHistory(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: ResolvedSendRequest,
  fallback: HistoryNameFallback = AD_HOC_NAME,
): Promise<ExchangeSummary> {
  // An ad-hoc send (a resend of an entry whose request is gone) names no entity, so there is
  // no project to route to: it carries no auth, no attachments, no WS-Security and no
  // project-scoped proxy rather than being routed to an arbitrary "current" project.
  const requestId = request.requestId;
  const owner = requestId === undefined ? undefined : deps.project.projectId(requestId);
  const auth = requestId !== undefined ? deps.project.authFor(requestId) : undefined;
  // The one query parameter an API key may travel in, so the URL is masked wherever it is shown
  // or stored even when the key is called something the redactor has never heard of.
  const keyParams = auth?.type === 'api-key' && auth.in === 'query' ? [auth.name] : undefined;
  // And the header one may travel in, masked by name for the same reason.
  const keyHeaders = auth?.type === 'api-key' && auth.in === 'header' ? [auth.name] : undefined;
  const attachments = requestId !== undefined ? deps.project.sendAttachmentsFor?.(requestId) : undefined;
  const prepareStartedAt = Date.now(); // log-only: a prepare row's duration, never History's
  let wss: Awaited<ReturnType<NonNullable<HistorySendProject['wssFor']>>> | undefined;
  let proxy: Awaited<ReturnType<NonNullable<HistorySendProject['proxyFor']>>> | undefined;
  let scopes = requestId === undefined ? (deps.adHocScopes?.() ?? EMPTY_SCOPES) : deps.project.scopesFor(requestId);
  let accessToken: string | undefined;
  try {
    // The engine expands the input with these scopes; every `${secret:name}` it will reach is
    // resolved here first, and a missing one refuses the send before anything is built.
    const names = secretNamesInValue(request.input, scopes);
    if (names.length > 0) {
      const getSecret = deps.secretsFor?.(owner) ?? (() => Promise.resolve(undefined));
      scopes = { ...scopes, secrets: await resolveSecretTokens(names, getSecret) };
    }
    wss = requestId !== undefined ? await deps.project.wssFor?.(requestId) : undefined;
    // Resolved per send rather than per session: the exclude list is evaluated against *this*
    // URL, and a system proxy can change under the app while it is running.
    proxy = owner === undefined ? undefined : await deps.project.proxyFor?.(owner, request.input.endpoint);
    // Obtained here rather than in the engine service, as for REST: it needs a browser, a loopback
    // listener and a cache. A grant that would have to open a window refuses instead, and the user
    // presses *Get new token*. Same TLS and proxy as the send itself.
    if (auth?.type === 'oauth2' && deps.oauth2 !== undefined && requestId !== undefined) {
      const tls = await deps.project.tlsFor?.(requestId);
      accessToken = await deps.oauth2.accessToken(auth, {
        credentials: await oauth2Credentials(deps, auth),
        ...(tls !== undefined ? { tls: withoutUndefined(tls) } : {}),
        ...(proxy !== undefined ? { proxy: withoutUndefined(proxy) } : {}),
      });
    }
    // A token scheme whose reference points at nothing is refused here, before the wire, so it is
    // a `prepare` row rather than a send History records — the same place REST refuses one. The
    // engine service resolves again for the send; Basic/NTLM keep their own, unchanged path.
    if (auth !== undefined && !isEndpointAuth(auth) && deps.getSecret !== undefined) {
      const getSecret = deps.getSecret;
      await resolveSoapAuth(auth, (ref) => getSecret(ref), accessToken !== undefined ? { accessToken } : {});
    }
  } catch (error) {
    // Before the request was built: a secret token, the WS-Security password, the proxy lookup or
    // the OAuth2 token request failed. The row says it never went on the wire; History is not
    // written (nothing was sent).
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'soap',
        requestId,
        url: request.input.endpoint,
        method: 'POST',
        headers: {},
        startedAt: prepareStartedAt,
        durationMs: Date.now() - prepareStartedAt,
        error,
        stage: 'prepare',
        keyParams,
        keyHeaders,
      }),
    );
    throw error;
  }
  const startedAt = Date.now();
  try {
    const result = await service.send(request, {
      scopes,
      showSecrets: deps.showSecrets?.get() ?? false,
      ...(auth !== undefined ? { auth } : {}),
      ...(accessToken !== undefined ? { accessToken } : {}),
      ...(keyParams !== undefined ? { keyParams } : {}),
      ...(keyHeaders !== undefined ? { keyHeaders } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(wss !== undefined ? { wss } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    });
    await record(service, deps, request, fallback, { durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await record(service, deps, request, fallback, { durationMs, error: errorDetail(error) });
    // The failure row for the console's HTTP Log: the request as the transport was about to send
    // it when the error carries one, else the resolved input's headers — redacted for good inside
    // `failedExchangeOf`. A SOAP send is always a POST.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'soap',
        requestId,
        url: request.input.endpoint,
        method: 'POST',
        headers: request.input.headers ?? {},
        startedAt,
        durationMs,
        error,
        captured: failedRequestOf(error),
        keyParams,
        keyHeaders,
      }),
    );
    throw error;
  }
}

/** The client secret and remembered refresh token an OAuth2 token request needs, if any. */
async function oauth2Credentials(
  deps: SendWithHistoryDeps,
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
 * Drops the keys whose value came over as `undefined`: the wire's TLS and proxy shapes allow
 * present-and-undefined fields, the token service's (`exactOptionalPropertyTypes`) do not.
 */
function withoutUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
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

async function record(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: ResolvedSendRequest,
  fallback: HistoryNameFallback,
  opts: { durationMs: number; error?: { code: string; message: string } },
): Promise<void> {
  if (deps.history === undefined) {
    return;
  }
  // The entry is keyed to the project the request came from. A send with no live request
  // belongs to no project, unless the caller named one (a resend of an orphaned entry goes
  // back into the history it came from); otherwise it is simply not recorded.
  const projectId =
    (request.requestId === undefined ? undefined : deps.project.projectId(request.requestId)) ?? fallback.projectId;
  if (projectId === undefined) {
    return;
  }
  const meta = request.requestId !== undefined ? deps.project.requestMeta(request.requestId) : undefined;
  const name = meta ?? fallback;
  const exchange = opts.error === undefined ? service.exchanges.get(request.sendId) : undefined;
  const entry = await deps.history.recordSend(projectId, {
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    requestName: name.requestName,
    interfaceName: name.interfaceName,
    operationName: name.operationName,
    input: request.input,
    ...(exchange !== undefined ? { exchange } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    durationMs: opts.durationMs,
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}
