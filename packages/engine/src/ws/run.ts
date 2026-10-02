/**
 * WebSocket's run facet (spec §3.3). A run selects every request its contract still has. A send
 * resolves the request and refuses one with a reference nothing resolves, connects (its TLS
 * identity, the proxy, its credentials with an OAuth2 token), then opens the session (spec §3.4).
 * A host that opens it interactive drives the session with push and close; a run sends the saved
 * messages in order, waits for a reply after the last one, then closes, all within the run timeout
 * (spec §5.2).
 */
import type { AssertionSubject } from '../assert/model.js';
import { HttpError, WsError } from '../errors.js';
import { resolveAuthChain } from '../http/auth/apply-auth.js';
import type { AuthConfig, Project } from '../project/model.js';
import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import { expand } from '../project/properties.js';
import type { UnresolvedRef } from '../project/properties.js';
import type { ProtocolRun, RunGroup } from '../protocol/module.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import { exchangeController } from '../run/exchange.js';
import type { ExchangeController, PushMessage, StreamingSide } from '../run/exchange.js';
import type { AttemptedRequest } from '../run/host.js';
import type { SentRequest } from '../run/run.js';
import {
  authFor,
  baseUrlFor,
  keystoreNeeds,
  originOf,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import type { Resolved } from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, findInTree, walkTree } from '../run/tree.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import { toWsSessionOptions } from './call.js';
import type { WsLiveEvent } from './events.js';
import { expandWsInput, expandWsMessage } from './expand.js';
import type { WsCallInput } from './expand.js';
import type { WsApi, WsExchange, WsFolder, WsFrame, WsHandshake, WsRequestDef, WsRequestSettings } from './model.js';
import { assertCloseCode, HANDSHAKE_TIMEOUT_ERROR, openWsSession } from './session.js';
import type { WsSessionHandle, WsSessionOptions } from './session.js';
import { resolveWsUrl } from './url.js';

/** One saved WebSocket request selected for a run. */
export interface WsSelected {
  readonly kind: 'websocket';
  readonly path: string;
  readonly group: string;
  readonly api: WsApi;
  readonly chain: readonly WsFolder[];
  readonly request: WsRequestDef;
}

/** The same chain for a WebSocket request: request, its folders inside-out, the API. */
export function wsEffectiveAuth(selected: WsSelected): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}

/**
 * The WebSocket item for `requestId`, built as a run builds it, and found even when its contract no
 * longer has it (`orphaned`), which a run skips and a person may still open. Undefined when no
 * WebSocket request has that id.
 */
export function wsItemFor(project: Project, requestId: string): WsSelected | undefined {
  const candidates: { item: WsSelected; diskPath: string }[] = [];
  for (const api of project.wsApis) {
    walkTree<WsFolder, WsRequestDef, WsSelected>(
      api,
      [],
      api.name,
      `apis/${api.slug}/requests`,
      (request, chain, group) =>
        request.id === requestId
          ? { kind: 'websocket', path: `${group}/${request.name}`, group, api, chain, request }
          : undefined,
      candidates,
    );
  }
  return candidates[0]?.item;
}

/**
 * The effective `WsRequestSettings` a request sends with, request settings resolved against
 * project/preference defaults.
 *
 * A `WsApi` carries no settings of its own to inherit from (unlike a gRPC or REST API), so this
 * ladder is shorter than `toGrpcSendInput`'s: only `handshakeTimeoutMs` has a project/preference
 * fallback (mirroring gRPC's `timeoutMs`, sourced from `project.settings.defaultTimeoutMs` and then
 * `preferences.http.socketTimeoutMs`); `trustInvalid`, `sslKeystoreRef`, `bindAddress` and
 * `maxMessageBytes` are the request's own or absent. A host that lends no preferences gets the
 * defaults, as gRPC's does.
 */
export function effectiveWsSettings(
  request: WsRequestDef,
  project: Project,
  preferences: Preferences | undefined,
): WsRequestSettings {
  const handshakeTimeoutMs =
    request.settings.handshakeTimeoutMs ??
    project.settings.defaultTimeoutMs ??
    (preferences ?? DEFAULT_PREFERENCES).http.socketTimeoutMs;
  return {
    ...request.settings,
    handshakeTimeoutMs,
  };
}

/**
 * A WebSocket request resolved for its send (spec §3.4): the server URL through the environment's override for the
 * API (the slot a REST base URL uses), the settings ladder, and one expansion pass over the server
 * URL, the request's URL, query, headers and subprotocols and the API's headers, nothing connected.
 * The run timeout, when given, is the handshake timeout. A reference nothing resolves is reported in
 * `unresolved`, not thrown: the send refuses it, a preview shows it.
 *
 * @throws WirebenchError `secret-missing`
 */
export async function resolveWs(selected: WsSelected, context: RunContext): Promise<Resolved<WsCallInput>> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const settings = effectiveWsSettings(request, context.project, context.host.preferences);
  const unexpanded: WsCallInput = {
    serverUrl: baseUrlFor(context, { slug: api.slug, baseUrl: api.url }),
    request: {
      url: request.url,
      query: request.query,
      headers: request.headers,
      subprotocols: request.subprotocols,
      settings: context.timeoutMs !== undefined ? { ...settings, handshakeTimeoutMs: context.timeoutMs } : settings,
    },
    apiHeaders: api.headers,
  };
  const withTokens = await withSecrets(unexpanded, scopes, context.host.getSecret, context.secretPlaceholders);
  // `expandWsInput` leaves the server URL alone; it is expanded here, first, as the app does.
  const server = expand(unexpanded.serverUrl, withTokens);
  const { input, unresolved } = expandWsInput(unexpanded, withTokens);
  return { input: { ...input, serverUrl: server.text }, unresolved: [...server.unresolved, ...unresolved] };
}

/** The URL a resolved call dials, before any API key travels in its query. */
function dialledUrl(input: WsCallInput): string {
  try {
    return resolveWsUrl(input.serverUrl, input.request.url, input.request.query);
  } catch {
    return `${input.serverUrl}${input.request.url}`;
  }
}

/** What a call that failed before it dialled was about to send: its URL and its enabled header rows. */
function attemptedOf(input: WsCallInput): AttemptedRequest {
  return {
    url: dialledUrl(input),
    method: 'GET',
    headers: Object.fromEntries(
      [...input.apiHeaders, ...input.request.headers].filter((row) => row.enabled).map((row) => [row.name, row.value]),
    ),
  };
}

/**
 * The request's TLS identity and trust decision, the proxy chosen for the URL's `http(s)` form, and
 * the chain's credentials (an OAuth2 token included), over a resolved call, as the options the
 * session opens with.
 *
 * @throws WirebenchError `secret-missing` | `auth-grant-unsupported` | `keystore-missing` |
 * `ws-auth-unsupported` | `ws-bad-url`
 */
async function connectWs(
  selected: WsSelected,
  context: RunContext,
  input: WsCallInput,
  signal: AbortSignal,
): Promise<WsSessionOptions> {
  const { settings } = selected.request;
  const tls = await tlsFor(context, settings.sslKeystoreRef, settings.trustInvalid === true);
  const proxy = await context.host.proxyFor?.(dialledUrl(input).replace(/^ws/, 'http'));
  const auth = await authFor(wsEffectiveAuth(selected), selected.path, context, tls);
  return toWsSessionOptions(input, {
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    signal,
  });
}

/** True when `text` is strictly valid base64, the empty string included: the app's own check. */
function isValidBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text);
}

/**
 * The saved messages a run sends, in order: text expanded with the request's escaping, binary from
 * its base64. Expanded before the session dials, so a reference nothing resolves refuses the send.
 *
 * @throws WsError `ws-bad-binary` for a binary message that is not valid base64
 */
async function savedPayloads(
  selected: WsSelected,
  context: RunContext,
): Promise<{ readonly payloads: readonly (string | Uint8Array)[]; readonly unresolved: readonly UnresolvedRef[] }> {
  const { messages, settings } = selected.request;
  const texts = messages.filter((message) => message.format === 'text').map((message) => message.content);
  const scopes = await withSecrets(texts, scopesFor(context), context.host.getSecret);
  const unresolved: UnresolvedRef[] = [];
  const payloads = messages.map((message) => {
    if (message.format === 'binary') {
      // `Buffer.from` drops what is not base64 and would send what is left: refuse it instead.
      if (!isValidBase64(message.content)) {
        throw new WsError('ws-bad-binary', `The saved message "${message.name}" is not valid base64.`, {
          details: { path: selected.path, message: message.name },
        });
      }
      return new Uint8Array(Buffer.from(message.content, 'base64'));
    }
    const expanded = expandWsMessage(message.content, scopes, { escape: settings.escapeProperties === true });
    unresolved.push(...expanded.unresolved);
    return expanded.text;
  });
  return { payloads, unresolved };
}

/** A pushed message as it goes on the wire, a text expanded against the request's scopes when asked. */
async function pushedPayload(
  selected: WsSelected,
  context: RunContext,
  message: PushMessage,
): Promise<string | Uint8Array> {
  if ('base64' in message) return new Uint8Array(Buffer.from(message.base64, 'base64'));
  if (message.expand !== true) return message.text;
  const scopes = await withSecrets(message.text, message.scopes ?? scopesFor(context), context.host.getSecret);
  const expanded = expandWsMessage(message.text, scopes, {
    escape: selected.request.settings.escapeProperties === true,
  });
  if (expanded.unresolved.length > 0) {
    throw unresolvedError('ws-unresolved-properties', selected.path, expanded.unresolved);
  }
  return expanded.text;
}

function sessionClosed(closing: boolean, settled: boolean): WsError {
  return new WsError('ws-session-closed', 'The connection is closed', { details: { closing, settled } });
}

/**
 * A session's sending side, between the handle `open` returns at once and the handshake that opens
 * the socket later. Messages go out one at a time in the order they were given, as the app's
 * `queueWsSend` keeps them: a text still being expanded holds back the ones after it. Before the
 * handshake they wait; it sends them. A close never drops a message given before it: it goes out
 * after them. A message after the close, or after the session ended, is refused at once with
 * `ws-session-closed`, as is any still waiting when the session ends without opening.
 */
interface WsSessionState {
  /**
   * Queues the payload `prepare` builds behind every message before it; resolves with the frame it
   * went out as. `prepare` is not called for a message refused as closed, so nothing it would ask for
   * (a secret) is asked, and no rejection of its goes unobserved.
   */
  send(prepare: () => Promise<string | Uint8Array>): Promise<WsFrame>;
  /** @throws WsError `ws-bad-close` for a code an application may not send. */
  close(code?: number, reason?: string): void;
  /** The handshake has opened the session. */
  opened(handle: WsSessionHandle): void;
  /** The session has ended, opened or not. */
  settled(): void;
}

function wsSessionState(): WsSessionState {
  let resolveOpen!: (handle: WsSessionHandle) => void;
  let rejectOpen!: (error: unknown) => void;
  const open = new Promise<WsSessionHandle>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  // Observed here: a session that never opens and has nothing waiting rejects it unread.
  open.catch(() => undefined);
  let isOpen = false;
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let done = false;
  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const result = tail.then(step);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    send(prepare) {
      if (closing || done) return Promise.reject(sessionClosed(closing, done));
      // Expanded at once; only the write waits its turn.
      const payload = prepare();
      payload.catch(() => undefined);
      return enqueue(async () => {
        const data = await payload;
        return (await open).send(data);
      });
    },
    close(code, reason) {
      if (closing || done) return;
      if (code !== undefined) assertCloseCode(code);
      closing = true;
      void enqueue(async () => (await open).close(code, reason)).catch(() => undefined);
    },
    opened(handle) {
      isOpen = true;
      resolveOpen(handle);
    },
    settled() {
      done = true;
      if (!isOpen) rejectOpen(sessionClosed(closing, true));
    },
  };
}

/**
 * Why a run's session never opened: `timeout` when the server did not answer the handshake in time,
 * the HTTP layer's code; `ws-handshake-refused` for a refusal or a server that cannot be reached.
 */
function handshakeFailure(handshake: WsHandshake): HttpError | WsError {
  if (handshake.error?.startsWith(HANDSHAKE_TIMEOUT_ERROR) === true) {
    return new HttpError('timeout', 'The request timed out.', { details: { url: handshake.url } });
  }
  return new WsError('ws-handshake-refused', handshake.error ?? 'The server refused the WebSocket handshake.', {
    details: { url: handshake.url },
  });
}

/** How long a run waits for the server to answer its close before letting the connection go. */
const RUN_CLOSE_GRACE_MS = 500;

/**
 * When a run's session has its answer: a text or binary frame received once the last saved message
 * has gone out, or the first one when there is none.
 */
interface ReplyWatch {
  /** Given every frame the session records. */
  frame(frame: WsFrame): void;
  readonly replied: Promise<void>;
  readonly hasReplied: boolean;
}

function replyWatch(saved: number): ReplyWatch {
  let sent = 0;
  let hasReplied = false;
  let resolve!: () => void;
  const replied = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    replied,
    get hasReplied() {
      return hasReplied;
    },
    frame(frame) {
      if (frame.opcode !== 'text' && frame.opcode !== 'binary') return;
      if (frame.direction === 'sent') {
        sent += 1;
      } else if (sent >= saved && !hasReplied) {
        hasReplied = true;
        resolve();
      }
    },
  };
}

/** The handshake's response head, as `raw` keeps it: status line and headers. */
function responseHead(handshake: WsHandshake): string {
  if (handshake.status === undefined) return '';
  const lines = [
    `HTTP/1.1 ${handshake.status} ${handshake.statusText ?? ''}`.trimEnd(),
    ...Object.entries(handshake.responseHeaders ?? {}).map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * A session as assertions see it: the handshake's status and response headers, and every text the
 * server sent, in order, as a JSON array. A refused handshake has no status, so it reads as 0.
 * Exported for its unit test; not part of the run module's public surface.
 */
export function wsSubject(exchange: WsExchange): AssertionSubject {
  const receivedTexts = exchange.frames
    .filter((frame) => frame.direction === 'received' && frame.opcode === 'text')
    .map((frame) => frame.text ?? '');
  return {
    protocol: 'websocket',
    status: exchange.handshake.status ?? 0,
    durationMs: exchange.durationMs,
    bodyText: JSON.stringify(receivedTexts),
    bodyKind: 'json',
    headers: Object.entries(exchange.handshake.responseHeaders ?? {}),
  };
}

/**
 * One WebSocket request as a run or a host sends it (spec §3.4): resolve, connect, open. A failure
 * is told to the host with its stage and what was attempted: a reference nothing resolves in the
 * prepare stage. A cancel before the handshake fails the send, with `aborted`; a cancel after it
 * ends the session, which settles with what it recorded. Otherwise an interactive session's outcome
 * is a result, a refused handshake included, which the host shows; a run's session that never opened
 * fails, with `ws-handshake-refused` or `timeout`, so a dead endpoint never passes a run. A run's
 * session closes with 1000 once a reply comes after its last saved message; one the run timeout
 * closes first fails with `timeout`, never a pass, and a server that never answers that close is let
 * go after a short grace. A host's own send that is not interactive closes after its last message.
 */
async function sendWsItem(
  selected: WsSelected,
  context: RunContext,
  controller: ExchangeController<WsLiveEvent>,
  state: WsSessionState,
  interactive: boolean,
  run: boolean,
): Promise<SentRequest> {
  let startedAt = Date.now();
  // Never masks the send's own error: a row that cannot be built, or a host that throws, is dropped.
  const failed = (
    stage: 'prepare' | 'send',
    error: unknown,
    attempted: AttemptedRequest | undefined,
    input: WsCallInput | undefined,
    transcript?: WsExchange,
  ): void => {
    try {
      context.host.events?.onFailed?.(selected, {
        stage,
        error,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(attempted !== undefined ? { attempted, input } : {}),
        ...(transcript !== undefined ? { exchange: transcript } : {}),
      });
    } catch {
      // Deliberately ignored — see above.
    }
  };
  let watch: ReplyWatch | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    let input: WsCallInput | undefined;
    let options: WsSessionOptions;
    try {
      const resolved = await resolveWs(selected, context);
      input = resolved.input;
      if (resolved.unresolved.length > 0) {
        throw unresolvedError('ws-unresolved-properties', selected.path, resolved.unresolved);
      }
      if (!interactive) {
        const saved = await savedPayloads(selected, context);
        if (saved.unresolved.length > 0) {
          throw unresolvedError('ws-unresolved-properties', selected.path, saved.unresolved);
        }
        for (const payload of saved.payloads) void state.send(() => Promise.resolve(payload)).catch(() => undefined);
        if (run) {
          watch = replyWatch(saved.payloads.length);
          void watch.replied.then(() => state.close(1000));
        } else {
          state.close(1000);
        }
      }
      const connected = await connectWs(selected, context, input, controller.signal);
      options = run ? { ...connected, closeGraceMs: RUN_CLOSE_GRACE_MS } : connected;
    } catch (error) {
      failed('prepare', error, input === undefined ? undefined : attemptedOf(input), input);
      throw error;
    }
    const sentAttempt: AttemptedRequest = { url: options.url, method: 'GET', headers: options.headers ?? {} };
    // The send stage's own clock: a send-stage failure never counts resolve or the token.
    startedAt = Date.now();
    let opened = false;
    let timedOut = false;
    let exchange: WsExchange | undefined;
    try {
      // The run timeout bounds the whole session; it is also the handshake's, so either ends it. The
      // settings ladder always gives one.
      if (watch !== undefined && options.handshakeTimeoutMs !== undefined) {
        deadline = setTimeout(() => {
          timedOut = true;
          state.close(1000);
        }, options.handshakeTimeoutMs);
      }
      const session: WsSessionHandle = openWsSession(options, {
        onHandshake: (handshake) => {
          opened = true;
          controller.queue.push({ protocol: 'websocket', kind: 'handshake', handshake });
          if (handshake.status === 101) {
            try {
              context.host.events?.onExchange?.(selected, handshake);
            } catch {
              // A host that cannot log the handshake does not end the session.
            }
          }
          // After this hook returns: `session` is assigned by then, and the socket is open.
          queueMicrotask(() => state.opened(session));
        },
        onFrame: (frame) => {
          watch?.frame(frame);
          controller.queue.push({ protocol: 'websocket', kind: 'frame', frame });
        },
        onClosed: () => controller.queue.push({ protocol: 'websocket', kind: 'closed' }),
      });
      exchange = await session.done;
      if (!opened && controller.signal.aborted) {
        throw new HttpError('aborted', 'The request was aborted.');
      }
      // A host shows a refused handshake from the transcript; a run has nothing to assert on, so it fails.
      if (!opened && !interactive) throw handshakeFailure(exchange.handshake);
      if (timedOut && watch?.hasReplied === false) {
        throw new HttpError('timeout', 'The request timed out.', { details: { url: exchange.url } });
      }
    } catch (error) {
      // A session that settled before failing (cancelled before it opened) keeps its transcript.
      failed('send', error, sentAttempt, input, exchange);
      throw error;
    }
    return {
      subject: wsSubject(exchange),
      raw: {
        rawRequest: new TextEncoder().encode(exchange.handshake.rawRequestHead ?? ''),
        rawResponse: new TextEncoder().encode(responseHead(exchange.handshake)),
      },
      exchange: { kind: 'websocket', ws: exchange },
      ...originOf(exchange.url),
    };
  } finally {
    clearTimeout(deadline);
    state.settled();
  }
}

/** WebSocket's run facet. */
export const wsRun: ProtocolRun<WsSelected> = {
  groups(project) {
    return project.wsApis.map((api) => {
      const candidates: RunGroup<WsSelected>['candidates'][number][] = [];
      walkTree<WsFolder, WsRequestDef, WsSelected>(
        api,
        [],
        api.name,
        `apis/${api.slug}/requests`,
        (request, chain, group) =>
          request.orphaned === true
            ? undefined
            : { kind: 'websocket', path: `${group}/${request.name}`, group, api, chain, request },
        candidates,
      );
      return { order: api.order, name: api.name, candidates };
    });
  },

  whyNotRunnable(project, requestId) {
    for (const api of project.wsApis) {
      const request = findInTree(api, requestId);
      if (request !== undefined) {
        return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
      }
    }
    return undefined;
  },

  open(selected, scope, host, options) {
    const controller = exchangeController<WsLiveEvent>('websocket', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    const state = wsSessionState();
    // A WebSocket has no half-close: ending the sending side ends the session.
    const streaming: StreamingSide = {
      push: (message) => state.send(() => pushedPayload(selected, context, message)),
      halfClose: () => state.close(),
      close: (code, reason) => state.close(code, reason),
    };
    return controller.handle(
      () => sendWsItem(selected, context, controller, state, options.interactive, options.run === true),
      options.interactive ? streaming : undefined,
    );
  },

  resolve(selected, scope, host) {
    return resolveWs(selected, { ...scope.context, host });
  },

  scriptTypes() {
    // No scripting facet: a run refuses a scripted request with `script-unsupported` before asking.
    return Promise.resolve({ generated: '' });
  },

  secretNeeds(selected, project) {
    return [
      ...secretNeedsOfAuth(wsEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  },
};
