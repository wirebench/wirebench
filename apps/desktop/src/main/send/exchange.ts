/**
 * One desktop send through the engine's `openExchange` (spec §3.2), the path the command line and
 * MCP send through too: the saved request selected as a run selects it, the editor's draft laid over
 * it, the app's own services lent as the `SendHost`, and the result turned into the summary the
 * renderer is handed and the History entry — byte for byte what the app's own send path wrote.
 */
import { tmpdir } from 'node:os';
import {
  createProject,
  createRunScope,
  deferredSession,
  expandSendInput,
  findWebhookRequest,
  grpcEffectiveAuth,
  isWirebenchError,
  openExchange,
  parseSecretPseudoRef,
  ProjectError,
  resolveExchange,
  resolvedBaseUrl,
  restEffectiveAuth,
  SecretPlaceholders,
  soapEffectiveAuth,
  WirebenchError,
  wsEffectiveAuth,
} from '@wirebench/engine';
import type {
  AuthConfig,
  BaseUrlSource,
  ExchangeHandle,
  GrpcFailedInput,
  GrpcResolvedInput,
  GrpcSelected,
  LiveEvent,
  PropertyMap,
  PropertyScopes,
  RestContractResult,
  RestSelected,
  RestSendInput,
  RunContext,
  ScriptedRequest,
  ScriptedSend,
  SelectedBase,
  SelectedRequest,
  SendFailure,
  SendHost,
  SentRequest,
  SentScripts,
  SoapOwnerAuth,
  SoapSelected,
  SoapSendInput,
  UnresolvedRef,
  WorkerFrameChecker,
  WorkerFrameCheckerOptions,
  WsCallInput,
  WsExchange,
  WsFrameContract,
} from '@wirebench/engine';
import type { HistoryService } from '../history-service.js';
import { containsRecordedSecret, recordSecretValue } from '../redact.js';
import { finishScripts, scriptsFailed, scriptsForSend, sessionValuesFor, type SendScripts } from '../script-send.js';
import { callbackUrlFor, withSentSigningHeaders, type WebhookUrlSource } from '../webhook-send.js';
import { adHocSoapItem, AD_HOC_ID, selectedFor, type DraftOf } from './draft.js';
import { desktopSendHost, type DesktopSend, type DesktopSendDeps } from './host.js';
import { toWireEvent } from './live.js';
import {
  recordGrpc,
  recordRest,
  recordSoap,
  recordWs,
  reportWsHandshakeFailure,
  summariseGrpc,
  summariseRest,
  summariseSoap,
  summariseWs,
  type HistoryLabel,
  type HistoryNameFallback,
} from './record.js';
import { withContracts, wsContractChecks, type WsContractChecks } from './ws-contract.js';
import type {
  ExchangeSummary,
  GrpcExchangeSummary,
  GrpcLiveEvent,
  GrpcRequestPatchWire,
  HistoryEntryWire,
  ResolvedSendInputWire,
  RestExchangeSummary,
  RestLiveEvent,
  RestRequestPatchWire,
  WsExchangeSummary,
  WsLiveEvent,
  WsRequestPatchWire,
} from '../../shared/wire-types.js';
import { toWsFrameContractWire } from '../engine-wire.js';

export interface SendOptions<D extends DraftOf = DraftOf> {
  readonly draft: D;
  /**
   * A SOAP send with no saved request behind it: an ad-hoc send, or the resend of a request deleted
   * since. It is sent as a synthetic item (`adHocSoapItem`) and recorded under `names`; a resend
   * names the request it was sent from (`requestId`), which its History entry and rows keep.
   */
  readonly adHoc?: {
    readonly input: ResolvedSendInputWire;
    readonly names: HistoryNameFallback;
    readonly requestId?: string;
  };
  readonly envId?: string;
  /** `${#Sequence#…}` values for a sequence step (`RunContext.sequence`). */
  readonly sequence?: PropertyMap;
  readonly timeoutMs?: number;
  readonly interactive?: boolean;
  /**
   * True for a sequence step, which is a run (`ExchangeOptions.run`): a stream waits for its answer
   * within the timeout, and one the timeout cuts fails with `timeout`. The editor's sends are not.
   */
  readonly run?: boolean;
  /** The History entry's tags in place of the request's own: the run a sequence step belongs to. */
  readonly tags?: readonly string[];
  /** Appended to the History entry's request name: the environment a multi-environment send went to. */
  readonly environmentName?: string;
  /** The wire events, redacted; omitted when the caller shows nothing live. */
  readonly onLive?: (event: LiveByKind[D['kind']]) => void;
  /** A sequence step's: told the scripts' result instead of the session store. */
  readonly onScriptsRan?: (sent: SentScripts) => void;
  /**
   * Told the engine's `SentRequest` before the summary is built and History is written, and awaited:
   * a sequence step reads its subject here and records the values to mask before its rows exist.
   */
  readonly onSent?: (sent: SentRequest) => void | Promise<void>;
}

/** The live events a send reports, by protocol: a SOAP send reports none. */
interface LiveByKind {
  readonly rest: RestLiveEvent;
  readonly soap: never;
  readonly grpc: GrpcLiveEvent;
  readonly websocket: WsLiveEvent;
}

/** What a send answers with, by protocol. */
interface SummaryByKind {
  readonly rest: RestExchangeSummary;
  readonly soap: ExchangeSummary;
  readonly grpc: GrpcExchangeSummary;
  readonly websocket: WsExchangeSummary;
}

export type SendSummary = SummaryByKind[keyof SummaryByKind];

interface Kept {
  readonly requestId: string;
  readonly kind: string;
  /** Who holds the entry: the send that reserved it, so an older send never removes a newer one. */
  readonly token: object;
  /** Absent while the send is still being prepared. */
  handle?: ExchangeHandle;
  /** A WebSocket session's: true once its handshake has opened it. */
  opened?: () => boolean;
  /** Set once its request side has been half-closed through the registry. */
  halfClosed?: boolean;
  /** Set once a WebSocket session has been asked to close through the registry. */
  closed?: boolean;
  /** Set when a cancel, a project's close or a quit reached the send before it had a handle: cancelled on arrival. */
  ending?: boolean;
}

/** The exchanges in flight, by send id: what `request.cancel` and a project's close reach. */
export class ExchangeRegistry {
  private readonly kept = new Map<string, Kept>();

  /** The contract workers of the WebSocket sessions in flight, by send id, while each runs. */
  readonly frameCheckers = new Map<string, WorkerFrameChecker>();

  /** Every send still running, by the request it sends, each settling once its History is written. */
  private readonly running = new Map<Promise<void>, string>();

  /** Follows `send` until it settles — its History entry written or skipped — whatever its outcome. */
  track(requestId: string, send: Promise<unknown>): void {
    const settled = send.then(
      () => undefined,
      () => undefined,
    );
    this.running.set(settled, requestId);
    void settled.finally(() => this.running.delete(settled));
  }

  /**
   * Resolves once every send whose request `matches` has settled, or after `timeoutMs`: a project's
   * close waits on it, so a send it cancelled writes its History entry before the file closes.
   */
  async whenRecorded(timeoutMs: number, matches?: (requestId: string) => boolean): Promise<void> {
    const waiting = [...this.running]
      .filter(([, requestId]) => matches === undefined || matches(requestId))
      .map(([send]) => send);
    if (waiting.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(waiting),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Holds `sendId` for a send from its first moment, before it is prepared, and answers the token
   * that {@link attach} and {@link forget} name it by. A WebSocket session's id is its address for
   * every push and close, so a second open of one still held is refused; any other send replaces
   * the entry, as a send id is never reused while its send runs.
   *
   * @throws WirebenchError `ws-session-exists`
   */
  reserve(sendId: string, requestId: string, kind: string): object {
    if (kind === 'websocket' && this.kept.has(sendId)) {
      throw new WirebenchError('ws-session-exists', 'That connection is already open.', { details: { sendId } });
    }
    const token = {};
    this.kept.set(sendId, { requestId, kind, token });
    return token;
  }

  /**
   * Gives the send `token` reserved its handle. `opened` tells a WebSocket session that has opened
   * from one still in its handshake. A send already ended by a project's close is cancelled at once.
   */
  attach(sendId: string, token: object, handle: ExchangeHandle, opened?: () => boolean): void {
    const kept = this.kept.get(sendId);
    if (kept?.token !== token) return;
    kept.handle = handle;
    if (opened !== undefined) kept.opened = opened;
    if (kept.ending === true) handle.cancel();
  }

  /** Reserves and attaches at once: a send whose handle is already built. */
  keep(sendId: string, requestId: string, kind: string, handle: ExchangeHandle, opened?: () => boolean): void {
    this.kept.delete(sendId);
    this.attach(sendId, this.reserve(sendId, requestId, kind), handle, opened);
  }

  /** The handle of the send `sendId`, if it has one yet, and is of `kind` when one is named. */
  get(sendId: string, kind?: string): ExchangeHandle | undefined {
    const kept = this.kept.get(sendId);
    return kind === undefined || kept?.kind === kind ? kept?.handle : undefined;
  }

  has(sendId: string): boolean {
    return this.kept.has(sendId);
  }

  /**
   * Aborts the send `sendId`. `false` when no such send is in flight, or it has already settled. A
   * WebSocket session that has opened is not aborted: it ends only through a close, with a close
   * code, never a torn socket, so a late Escape after the handshake does nothing. A send still being
   * prepared is cancelled as soon as it has a handle.
   */
  cancel(sendId: string): { readonly cancelled: boolean } {
    const kept = this.kept.get(sendId);
    if (kept === undefined || kept.opened?.() === true) return { cancelled: false };
    if (kept.handle === undefined) {
      if (kept.ending === true) return { cancelled: false };
      kept.ending = true;
      return { cancelled: true };
    }
    return { cancelled: kept.handle.cancel() };
  }

  /**
   * Closes the WebSocket session `sendId` with `code` and `reason`. `false` when no such session is
   * in flight or it has already been asked to close; a close before the handshake waits for it.
   *
   * @throws WsError `ws-bad-close` for a code an application may not send; the session stays open.
   */
  closeWs(sendId: string, code?: number, reason?: string): boolean {
    const kept = this.kept.get(sendId);
    if (kept?.handle === undefined || kept.kind !== 'websocket' || kept.closed === true) return false;
    kept.handle.close(code, reason);
    kept.closed = true;
    return true;
  }

  /**
   * Half-closes the request side of the send `sendId`. `false` when no such send is in flight, it
   * takes no messages, or it has already been half-closed; its `closed` event comes from the engine.
   */
  halfClose(sendId: string): boolean {
    const kept = this.kept.get(sendId);
    if (kept?.handle === undefined || kept.halfClosed === true) return false;
    try {
      kept.handle.halfClose();
    } catch (error) {
      // A send that takes no messages has no request side to close; anything else is a real failure.
      if (isWirebenchError(error) && error.code === 'exchange-not-streaming') return false;
      throw error;
    }
    kept.halfClosed = true;
    return true;
  }

  /**
   * Ends every kept send of `kind` whose request matches, and answers how many it ended. An open
   * WebSocket session closes `1000 'going away'` (an application may not send 1001, RFC 6455
   * §7.4.1), and one already asked to close is left to finish; one still in its handshake is
   * cancelled, so a project's close or the app's quit never waits out the handshake timeout. A send
   * still being prepared is cancelled as soon as it has a handle. Anything else is cancelled.
   */
  endWhere(matches: (requestId: string) => boolean, kind: string): number {
    let ended = 0;
    for (const [sendId, kept] of this.kept) {
      if (kept.kind !== kind || !matches(kept.requestId)) continue;
      if (kept.handle === undefined) {
        if (kept.ending !== true) ended += 1;
        kept.ending = true;
        continue;
      }
      if (kind !== 'websocket' || kept.opened?.() !== true) {
        if (kept.handle.cancel()) ended += 1;
        continue;
      }
      if (kept.closed === true) continue;
      // One session refusing to close must not stop the rest of them from being asked to close too.
      try {
        kept.handle.close(1000, 'going away');
        kept.closed = true;
        ended += 1;
      } catch (error) {
        console.warn(`[ws] closing "${sendId}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return ended;
  }

  /** Lets go of `sendId`, unless a newer send holds it now. */
  forget(sendId: string, token: object): void {
    if (this.kept.get(sendId)?.token === token) this.kept.delete(sendId);
  }
}

export interface SendThroughEngineDeps extends DesktopSendDeps {
  readonly registry: ExchangeRegistry;
  readonly history?: HistoryService;
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  readonly showSecrets?: { get(): boolean };
  readonly scripts?: SendScripts;
  readonly onScriptsRan?: (sent: SentScripts) => void;
  /** The scopes an ad-hoc send expands against: the user's globals and the process env. */
  readonly adHocScopes?: () => PropertyScopes;
  /** For tests: substitutes a WebSocket contract checker's worker script or its deadline. */
  readonly wsFrameChecker?: WorkerFrameCheckerOptions;
}

/** What the "no such request" refusal calls a kind, as the app always has. */
const KIND_LABEL: Readonly<Record<DraftOf['kind'], string>> = {
  rest: 'REST',
  soap: 'SOAP',
  grpc: 'gRPC',
  websocket: 'WebSocket',
};

/**
 * Sends one saved request through the engine. Its scripts are type-checked first; a request that
 * no longer exists refuses as `unknown-entity`. The HTTP Log's failure row is written by the host as
 * the engine reports it; History is written for a send that went out (or failed on the wire), never
 * for one that failed while it was prepared.
 */
export async function sendThroughEngine<D extends DraftOf>(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  options: SendOptions<D>,
): Promise<SummaryByKind[D['kind']]> {
  // Narrowed by `D` for the caller; the send itself hands any protocol's events on.
  return (await sendItem(deps, sendId, requestId, options as unknown as SendOptions)) as SummaryByKind[D['kind']];
}

async function sendItem(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  options: SendOptions,
): Promise<SendSummary> {
  // Held before the first await: a second open of the same session is refused even while this one prepares.
  const token = deps.registry.reserve(sendId, requestId, options.draft.kind);
  const sending = sendReserved(deps, sendId, requestId, options, token);
  // An ad-hoc resend is tracked under the request its entry names, the project's History it writes to.
  deps.registry.track(options.adHoc?.requestId ?? requestId, sending);
  try {
    return await sending;
  } finally {
    deps.registry.forget(sendId, token);
  }
}

async function sendReserved(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  options: SendOptions,
  token: object,
): Promise<SendSummary> {
  const { adHoc } = options;
  // Type-checked before anything is resolved: a script that does not check never reaches the wire.
  const scripts = await scriptsForSend(deps, adHoc === undefined ? requestId : undefined);
  const located = adHoc === undefined ? savedContext(deps, requestId, options.envId) : adHocContext(deps, adHoc.input);
  const item =
    located === undefined
      ? undefined
      : adHoc !== undefined
        ? adHocSoapItem(adHoc.input, adHoc.names)
        : selectedFor(located.project, requestId, options.draft);
  if (located === undefined || item === undefined) {
    throw new ProjectError('unknown-entity', `No ${KIND_LABEL[options.draft.kind]} request with id "${requestId}"`, {
      details: { requestId },
    });
  }
  // An ad-hoc send belongs to no project: no project's secrets, proxy, keystore or session values.
  const projectId = adHoc === undefined ? deps.project.projectId(requestId) : undefined;
  const masks = keyMasks(item);
  // What the rows name: the saved request, or the one a resent entry came from.
  const namedId = adHoc === undefined ? requestId : adHoc.requestId;
  const send: DesktopSend = {
    sendId,
    requestId: namedId ?? AD_HOC_ID,
    projectId,
    ...masks,
    ...(options.envId !== undefined ? { envId: options.envId } : {}),
  };
  const failures = deferredSendFailure(await desktopSendHost(deps, send));
  const { host } = failures;
  const stepDeps = options.onScriptsRan !== undefined ? { ...deps, onScriptsRan: options.onScriptsRan } : deps;
  const sequence = options.sequence ?? sessionValuesFor(stepDeps, projectId);
  const context: RunContext = {
    ...runContextOf(located, host),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(deps.scripts !== undefined ? { scripting: deps.scripts.scripting } : {}),
    containsKnownSecret: containsRecordedSecret,
  };
  const scope = createRunScope(context);
  const scripted =
    scripts.kind === 'on' && deps.scripts !== undefined
      ? scriptedSend(deps.scripts, scripts.request, context)
      : undefined;
  // A WebSocket session's events are always read: its frames are checked, its handshake opens it.
  const session = item.kind === 'websocket' ? wsSessionOf(deps, sendId, requestId, send, options.onLive) : undefined;
  const handle = openExchange(item, host, {
    scope,
    interactive: options.interactive === true,
    live: options.onLive !== undefined || session !== undefined,
    ...(options.run === true ? { run: true } : {}),
    ...(scripted !== undefined ? { scripts: scripted } : {}),
  });
  // Only a session the person drives is spared a cancel once open: a run's has no close to end it by.
  deps.registry.attach(sendId, token, handle, options.interactive === true ? session?.opened : undefined);
  const show = deps.showSecrets?.get() ?? false;
  const forwarding = forwardLive(sendId, handle, { show, ...masks }, options.onLive, session);
  const startedAt = Date.now();
  try {
    const sent = await handle.result;
    await forwarding;
    await options.onSent?.(sent);
    const checked = session === undefined ? undefined : await session.checked(wsSent(sent).ws);
    const summarised = summarise(deps, sendId, item, sent, masks, show, namedId, checked);
    const full: SendSummary = {
      ...summarised.summary,
      ...(sent.script !== undefined ? finishScripts(stepDeps, projectId, sent.script) : {}),
      ...(scripts.kind === 'off' ? { scriptsOff: true } : {}),
    };
    const recorded: Recorded = {
      ...recordedOf(item, masks, options),
      handshakeLogged: send.handshakeLogged === true,
    };
    await record(deps, recorded, sent, full, summarised.unredacted, Date.now() - startedAt);
    return full;
  } catch (error) {
    await forwarding;
    const failed = failures.sendStage();
    if (failed !== undefined) {
      // As the app always has: History first, then the HTTP Log's row.
      const recorded = recordedOf(item, masks, options);
      await recordFailure(deps, recorded, failed, error, Date.now() - startedAt, { sendId, show });
      failed.report();
    }
    throw error;
  } finally {
    deps.registry.forget(sendId, token);
    // The contract worker ends with the session however it ended: a close, a drop, a quit.
    await session?.dispose();
  }
}

/** A WebSocket session as the desktop follows it: opened or not, and its frames' contract checks. */
interface WsSession {
  /** True once the handshake has opened the session. */
  readonly opened: () => boolean;
  /** Told each live event before it is handed on. */
  seen(event: LiveEvent): void;
  /** Told each live event after it is handed on. */
  forwarded(event: LiveEvent): void;
  /** The exchange with its frames' check results, once every check has answered or run out of time. */
  checked(exchange: WsExchange): Promise<WsExchange>;
  dispose(): Promise<void>;
}

/**
 * A WebSocket session's follower. Its contract is asked for here and never awaited: frames flow
 * while it loads, and one that fails leaves the session unchecked with one console line. Each frame
 * is checked on a worker after its own `frame` event, and its result follows as a `contract` event.
 */
function wsSessionOf(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  send: DesktopSend,
  onLive: SendOptions['onLive'],
): WsSession {
  let handshakeSeen = false;
  const onContract = (index: number, contract: WsFrameContract): void => {
    try {
      onLive?.({ kind: 'contract', sendId, index, contract: toWsFrameContractWire(contract) });
    } catch (error) {
      console.warn(
        `[ws] a live event ("contract") for send "${sendId}" could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const checks: WsContractChecks | undefined = wsContractChecks(
    sendId,
    deps.project.wsContractFor?.(requestId),
    deps.wsFrameChecker,
    onContract,
    deps.registry.frameCheckers,
  );
  return {
    // The host's handshake row is written as the socket opens; the live event follows it.
    opened: () => handshakeSeen || send.handshakeLogged === true,
    seen: (event) => {
      if (event.protocol === 'websocket' && event.kind === 'handshake') handshakeSeen = true;
    },
    forwarded: (event) => {
      if (event.protocol === 'websocket' && event.kind === 'frame') checks?.check(event.frame);
    },
    checked: async (exchange) => (checks === undefined ? exchange : withContracts(exchange, await checks.settle())),
    dispose: async () => {
      await checks?.dispose();
    },
  };
}

type Located = NonNullable<ReturnType<NonNullable<SendThroughEngineDeps['project']['runContextFor']>>> & {
  /** The `${…}` shorthand's values laid over the environment's (`RunContext.overrides`). */
  readonly overrides?: PropertyMap;
  /** A SOAP request's default `wsa:Action`, from the definition the app has loaded. */
  readonly defaultWsaActionFor?: RunContext['defaultWsaActionFor'];
};

/** The run context a send of the located request runs in: its project, environment and globals. */
function runContextOf(located: Located, host: SendHost): RunContext {
  return {
    project: located.project,
    projectDir: located.projectDir,
    ...(located.environmentId !== undefined ? { environmentId: located.environmentId } : {}),
    ...(located.workspace !== undefined ? { workspace: located.workspace } : {}),
    // The `${#Global#…}` scope: without it a global property stays unresolved.
    ...(located.globals !== undefined ? { globals: located.globals } : {}),
    overrides: located.overrides ?? {},
    ...(located.defaultWsaActionFor !== undefined ? { defaultWsaActionFor: located.defaultWsaActionFor } : {}),
    host,
  };
}

/**
 * Where a send of a saved request runs: its project, environment and globals, and the default
 * `wsa:Action` of its operation from the definition the app has loaded — whether or not the
 * interface caches it on disk, which is all the engine can read for itself.
 */
function savedContext(deps: SendThroughEngineDeps, requestId: string, envId: string | undefined): Located | undefined {
  const located = deps.project.runContextFor?.(requestId, envId);
  const defaultAction = deps.project.defaultWsaActionFor;
  return located === undefined || defaultAction === undefined
    ? located
    : { ...located, defaultWsaActionFor: (selected) => defaultAction.call(deps.project, selected.request.id) };
}

/**
 * Where an ad-hoc send runs: a project of its own, holding nothing, with the scopes the app gives
 * such a send (`adHocScopes`: the user's globals and the process env) as its properties.
 */
function adHocContext(deps: SendThroughEngineDeps, input: ResolvedSendInputWire): Located {
  const scopes = deps.adHocScopes?.();
  const defaultAction = input.wsa?.defaultAction;
  return {
    // The input's own WS-Addressing names its default action: the item has no definition.
    ...(defaultAction !== undefined ? { defaultWsaActionFor: () => defaultAction } : {}),
    project: { ...createProject('Ad hoc', { id: AD_HOC_ID }), properties: { ...scopes?.project } },
    // Nothing is read from it: the item has no attachments, keystore or cached definition.
    projectDir: tmpdir(),
    globals: { ...scopes?.global },
    overrides: { ...scopes?.env },
  };
}

/**
 * What every preview resolves in: the saved request with the draft over it, the run context a send
 * of it runs in, and a host that reads no secret. Each `${secret:name}` stands behind a placeholder
 * while the request resolves and is put back as its token text (`asTyped`), so it stays in the output
 * as written; `secretTokens` answers whether one was reached. Undefined: no such request of that kind.
 */
async function previewOf<K extends DraftOf['kind']>(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: Extract<DraftOf, { kind: K }>,
): Promise<
  | {
      readonly item: Extract<SelectedRequest, { kind: K }>;
      readonly context: RunContext;
      readonly placeholders: SecretPlaceholders;
      readonly asTyped: (ref: string) => Promise<string | undefined>;
      readonly secretTokens: () => boolean;
    }
  | undefined
> {
  const located = savedContext(deps, requestId, undefined);
  const item = located === undefined ? undefined : selectedFor(located.project, requestId, draft);
  if (located === undefined || item?.kind !== draft.kind) return undefined;
  const send: DesktopSend = { sendId: '', requestId, projectId: deps.project.projectId(requestId) };
  let reached = false;
  const asTyped = (ref: string): Promise<string | undefined> => {
    reached ||= parseSecretPseudoRef(ref) !== undefined;
    return tokenText(ref);
  };
  const host: SendHost = { ...(await desktopSendHost(deps, send)), getSecret: asTyped };
  const placeholders = new SecretPlaceholders();
  return {
    item: item as Extract<SelectedRequest, { kind: K }>,
    context: { ...runContextOf(located, host), secretPlaceholders: placeholders },
    placeholders,
    asTyped,
    secretTokens: () => reached,
  };
}

/** Where a REST request's base URL came from: an environment, the API, or a webhook item's target or callback. */
export type RestUrlSource = BaseUrlSource | WebhookUrlSource;

/** A REST request resolved as its send would resolve it, nothing connected and no secret read. */
export interface RestPreview {
  readonly item: RestSelected;
  readonly input: RestSendInput;
  readonly unresolved: readonly UnresolvedRef[];
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Where the base URL came from, for the editor's badge. */
  readonly baseUrlSource: RestUrlSource;
  /** A webhook callback's editor note: where its URL came from, or why the target stands in. */
  readonly targetDetail?: string;
}

/**
 * What a send of the REST request would send, for an export or the editor's badge: resolved through
 * the engine with no secret read, each `${secret:name}` put back as its token text. Undefined: no
 * such REST request.
 *
 * @throws WirebenchError what resolving refuses: a webhook item's target, a file outside the project
 */
export async function previewRest(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: RestRequestPatchWire | undefined,
): Promise<RestPreview | undefined> {
  const preview = await previewOf(deps, requestId, { kind: 'rest', ...(draft !== undefined ? { draft } : {}) });
  if (preview === undefined) return undefined;
  const { item, context, placeholders, asTyped } = preview;
  const resolved = (await resolveExchange(item, context.host, createRunScope(context))) as {
    readonly input: RestSendInput;
    readonly unresolved: readonly UnresolvedRef[];
  };
  return {
    item,
    input: await placeholders.restore(resolved.input, asTyped),
    unresolved: resolved.unresolved,
    auth: restEffectiveAuth(item),
    ...restUrlSourceOf(deps, item, context),
  };
}

/**
 * Where a REST item's base URL comes from. A webhook item's is its target, or, for a callback, the
 * URL its parent's newest exchange named (`callbackUrlFor`, which the send's host reads too); an
 * API request's is the environment's override or the API's own base URL, as the send resolves it.
 */
function restUrlSourceOf(
  deps: SendThroughEngineDeps,
  item: RestSelected,
  context: RunContext,
): Pick<RestPreview, 'baseUrlSource' | 'targetDetail'> {
  const { project } = context;
  if (project.webhooks === undefined || findWebhookRequest(project.webhooks, item.request.id) === undefined) {
    return { baseUrlSource: resolvedBaseUrl(context, item.api).source };
  }
  if (item.request.hook?.kind !== 'callback') return { baseUrlSource: 'target' };
  const projectId = deps.project.projectId(item.request.id);
  const callback = callbackUrlFor(project, item.request, (id) =>
    projectId === undefined ? undefined : deps.newestHistory?.(projectId, id),
  );
  return { baseUrlSource: callback.source, targetDetail: callback.detail };
}

/** A gRPC call resolved as its send would resolve it, nothing connected and no secret read. */
export interface GrpcPreview {
  readonly item: GrpcSelected;
  readonly input: GrpcResolvedInput;
  readonly messageText: string;
  readonly unresolved: readonly UnresolvedRef[];
  /** True when a `${secret:name}` token was reached: it stays in the output as typed. */
  readonly secretTokens: boolean;
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Where the target came from, for the editor's badge. */
  readonly targetSource: BaseUrlSource;
}

/**
 * What a send of the gRPC request would send, for an export or the editor's badge: resolved through
 * the engine with no secret read, each `${secret:name}` put back as its token text. Undefined: no
 * such gRPC request.
 */
export async function previewGrpc(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: GrpcRequestPatchWire | undefined,
): Promise<GrpcPreview | undefined> {
  const preview = await previewOf(deps, requestId, { kind: 'grpc', ...(draft !== undefined ? { draft } : {}) });
  if (preview === undefined) return undefined;
  const { item, context, placeholders, asTyped } = preview;
  const resolved = (await resolveExchange(item, context.host, createRunScope(context))) as {
    readonly input: GrpcResolvedInput;
    readonly messageText: string;
    readonly unresolved: readonly UnresolvedRef[];
  };
  const restored = await placeholders.restore(
    { metadata: resolved.input.metadata, messageText: resolved.messageText },
    asTyped,
  );
  return {
    item,
    input: { ...resolved.input, metadata: restored.metadata },
    messageText: restored.messageText,
    unresolved: resolved.unresolved,
    secretTokens: preview.secretTokens(),
    auth: grpcEffectiveAuth(item),
    targetSource: resolvedBaseUrl(context, { slug: item.api.slug, baseUrl: item.api.target }).source,
  };
}

/** A WebSocket session resolved as its open would resolve it, nothing dialled and no secret read. */
export interface WsPreview {
  readonly input: WsCallInput;
  readonly unresolved: readonly UnresolvedRef[];
  /** True when a `${secret:name}` token was reached: it stays in the output as typed. */
  readonly secretTokens: boolean;
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Where the server URL came from, for the editor's badge. */
  readonly urlSource: BaseUrlSource;
}

/**
 * What an open of the WebSocket request would dial, for an export or the editor's badge: resolved
 * through the engine with no secret read, each `${secret:name}` put back as its token text.
 * Undefined: no such WebSocket request.
 */
export async function previewWs(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: WsRequestPatchWire | undefined,
): Promise<WsPreview | undefined> {
  const preview = await previewOf(deps, requestId, { kind: 'websocket', ...(draft !== undefined ? { draft } : {}) });
  if (preview === undefined) return undefined;
  const { item, context, placeholders, asTyped } = preview;
  const resolved = (await resolveExchange(item, context.host, createRunScope(context))) as {
    readonly input: WsCallInput;
    readonly unresolved: readonly UnresolvedRef[];
  };
  return {
    input: await placeholders.restore(resolved.input, asTyped),
    unresolved: resolved.unresolved,
    secretTokens: preview.secretTokens(),
    auth: wsEffectiveAuth(item),
    urlSource: resolvedBaseUrl(context, { slug: item.api.slug, baseUrl: item.api.url }).source,
  };
}

/** A SOAP request resolved as its send would resolve it, nothing connected and no secret read. */
export interface SoapPreview {
  /** Every property expanded and WS-Addressing still to apply; no credentials, no WS-Security. */
  readonly input: SoapSendInput;
  /** The credentials that apply, still as references. */
  readonly auth: SoapOwnerAuth | undefined;
}

/**
 * What a send of the saved SOAP request would send, for an export: resolved through the engine with
 * no secret read, each `${secret:name}` put back as its token text and a reference nothing resolves
 * left as written. WS-Security is never part of it (it needs secrets and a keystore), so a selected
 * configuration is not looked up either. Undefined: no such SOAP request.
 *
 * @throws WirebenchError `endpoint-unresolved` when no endpoint resolves for it
 */
export async function previewSoap(deps: SendThroughEngineDeps, requestId: string): Promise<SoapPreview | undefined> {
  const preview = await previewOf(deps, requestId, { kind: 'soap' });
  if (preview === undefined) return undefined;
  const { context, placeholders, asTyped } = preview;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { wssOutgoingRef, wssIncomingRef, ...request } = preview.item.request;
  const item: SoapSelected = { ...preview.item, request };
  const resolved = (await resolveExchange(item, context.host, createRunScope(context))) as {
    readonly input: SoapSendInput;
    readonly scopes: PropertyScopes;
  };
  const expanded = expandSendInput(resolved.input, resolved.scopes).input;
  const restored = await placeholders.restore(
    {
      endpoint: expanded.endpoint,
      envelopeXml: expanded.envelopeXml,
      ...(expanded.soapAction !== undefined ? { soapAction: expanded.soapAction } : {}),
      ...(expanded.headers !== undefined ? { headers: expanded.headers } : {}),
    },
    asTyped,
  );
  return { input: { ...expanded, ...restored }, auth: soapEffectiveAuth(item) };
}

/** A `${secret:name}` token's own text, which a preview shows in place of its value. */
function tokenText(ref: string): Promise<string | undefined> {
  const name = parseSecretPseudoRef(ref);
  return Promise.resolve(name === undefined ? undefined : `\${secret:${name}}`);
}

/** The names of an API key in the query or a header, from the item's effective credentials. */
function keyMasks(item: SelectedRequest): Pick<DesktopSend, 'keyParams' | 'keyHeaders'> {
  if (item.kind === 'websocket') {
    // A WebSocket session masks its URL's key alone, as the app always has: its rows mask headers by name.
    const auth = wsEffectiveAuth(item);
    return auth.type === 'api-key' && auth.in === 'query' ? { keyParams: [auth.name] } : {};
  }
  const auth =
    item.kind === 'rest' ? restEffectiveAuth(item) : item.kind === 'soap' ? soapEffectiveAuth(item) : undefined;
  if (auth?.type !== 'api-key') return {};
  // The one query parameter an API key may be configured to travel in, so the URL is masked wherever
  // it is logged even when the key is called something this build has never heard of; and the
  // header one may travel in, masked by name wherever the request's headers are shown.
  return auth.in === 'query' ? { keyParams: [auth.name] } : auth.in === 'header' ? { keyHeaders: [auth.name] } : {};
}

/**
 * The host with a send-stage failure held back: the engine reports it before the send rejects, and
 * the app writes the History entry before the HTTP Log's row. A prepare-stage one goes straight on.
 */
function deferredSendFailure(base: SendHost): {
  readonly host: SendHost;
  sendStage(): HeldFailure | undefined;
} {
  let held: { readonly item: SelectedBase; readonly failure: SendFailure } | undefined;
  return {
    host: {
      ...base,
      events: {
        ...base.events,
        onFailed: (item, failure) => {
          if (failure.stage === 'send') {
            held = { item, failure };
            return;
          }
          base.events?.onFailed?.(item, failure);
        },
      },
    },
    sendStage: () => {
      const failed = held;
      if (failed === undefined) return undefined;
      return {
        input: failed.failure.input,
        exchange: failed.failure.exchange,
        durationMs: failed.failure.durationMs,
        report: () => base.events?.onFailed?.(failed.item, failed.failure),
      };
    },
  };
}

/**
 * The scripts of one send: the session opens when the engine first runs one, reads the secrets the
 * scripts list, and records each secret value a script sets, as the app's other sends do. A
 * post-response script that cannot finish is reported as the scripts' error, never as the send's.
 */
function scriptedSend(scripts: SendScripts, request: ScriptedRequest, context: RunContext): ScriptedSend {
  const session = deferredSession(scripts.scripting, request, context, {
    onSecretValue: recordSecretValue,
    containsKnownSecret: containsRecordedSecret,
  });
  return {
    session: { pre: session.pre, post: (sent, response) => session.post(sent, response).catch(scriptsFailed) },
    placeholders: new SecretPlaceholders(),
  };
}

/** Hands each live event to `onLive`, redacted; one that cannot be delivered never affects the send. */
async function forwardLive(
  sendId: string,
  handle: ExchangeHandle,
  redaction: { readonly show: boolean; readonly keyParams?: readonly string[] },
  onLive: SendOptions['onLive'],
  session: WsSession | undefined,
): Promise<void> {
  for await (const raw of handle.events) {
    const event = raw as LiveEvent;
    session?.seen(event);
    try {
      onLive?.(toWireEvent(sendId, event, redaction.show, redaction.keyParams));
    } catch (error) {
      console.warn(
        `[${event.protocol}] a live event ("${event.kind}") for send "${sendId}" could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    session?.forwarded(event);
  }
}

/** A send-stage failure held back until History is written. */
interface HeldFailure {
  /** The protocol's input as the engine reports it; it may hold live credentials, never logged. */
  readonly input: unknown;
  /** What the protocol recorded of the exchange before it failed, when it settled part way. */
  readonly exchange: unknown;
  /** How long the send stage ran. */
  readonly durationMs: number;
  report(): void;
}

/** What a send's History entry is written from beyond the result: the item, its masks, an ad-hoc send's names. */
interface Recorded {
  readonly item: SelectedRequest;
  readonly masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>;
  readonly adHoc?: HistoryNameFallback;
  /** The request an ad-hoc resend's entry still names, though it no longer exists. */
  readonly adHocRequestId?: string;
  readonly label?: HistoryLabel;
  /** A WebSocket session's: its opened handshake's Log row was written. */
  readonly handshakeLogged?: boolean;
}

function recordedOf(
  item: SelectedRequest,
  masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>,
  options: SendOptions,
): Recorded {
  const { adHoc, tags, environmentName } = options;
  const label: HistoryLabel | undefined =
    tags === undefined && environmentName === undefined
      ? undefined
      : { ...(tags !== undefined ? { tags } : {}), ...(environmentName !== undefined ? { environmentName } : {}) };
  return {
    item,
    masks,
    ...(adHoc !== undefined ? { adHoc: adHoc.names } : {}),
    ...(adHoc?.requestId !== undefined ? { adHocRequestId: adHoc.requestId } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/** The request a SOAP entry is keyed to: the saved one, or the one an ad-hoc resend came from. */
function soapRequestId(recorded: Recorded): { readonly requestId?: string } {
  if (recorded.adHoc === undefined) return { requestId: recorded.item.request.id };
  return recorded.adHocRequestId !== undefined ? { requestId: recorded.adHocRequestId } : {};
}

function restSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'rest' }> {
  if (sent.exchange?.kind !== 'rest') throw new Error('A REST send came back without its exchange');
  return sent.exchange;
}

function soapSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'soap' }> {
  if (sent.exchange?.kind !== 'soap') throw new Error('A SOAP send came back without its exchange');
  return sent.exchange;
}

function grpcSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'grpc' }> {
  if (sent.exchange?.kind !== 'grpc') throw new Error('A gRPC send came back without its exchange');
  return sent.exchange;
}

function wsSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'websocket' }> {
  if (sent.exchange?.kind !== 'websocket') throw new Error('A WebSocket session came back without its exchange');
  return sent.exchange;
}

/**
 * The summary the renderer is handed and, for SOAP, the unredacted one History records. A WebSocket
 * session's is built from `checked`, its exchange with its frames' contract results.
 */
function summarise(
  deps: SendThroughEngineDeps,
  sendId: string,
  item: SelectedRequest,
  sent: SentRequest,
  masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>,
  show: boolean,
  requestId: string | undefined,
  checked: WsExchange | undefined,
): { readonly summary: SendSummary; readonly unredacted?: ExchangeSummary } {
  switch (item.kind) {
    case 'rest': {
      const exchange = restSent(sent);
      return {
        summary: summariseRest(
          deps.service,
          sendId,
          exchange.rest,
          exchange.contract as RestContractResult | undefined,
          {
            method: exchange.input.request.method,
            ...masks,
            show,
          },
        ),
      };
    }
    case 'soap': {
      const exchange = soapSent(sent);
      const { summary, full } = summariseSoap(deps.service, sendId, exchange.soap, {
        ...(requestId !== undefined ? { requestId } : {}),
        requestEnvelopeXml: exchange.input.envelopeXml,
        ...masks,
        show,
      });
      return { summary, unredacted: full };
    }
    case 'grpc':
      return { summary: summariseGrpc(grpcSent(sent).grpc, sendId, show) };
    case 'websocket':
      return {
        summary: summariseWs(checked ?? wsSent(sent).ws, sendId, {
          show,
          ...(masks.keyParams !== undefined ? { keyParams: masks.keyParams } : {}),
        }),
      };
  }
}

/** What History names a SOAP item by when the project has no meta for it: an ad-hoc send's own names. */
function soapNames(recorded: Recorded): HistoryNameFallback {
  if (recorded.adHoc !== undefined) return recorded.adHoc;
  const { item } = recorded;
  return item.kind === 'soap'
    ? { requestName: item.request.name, interfaceName: item.iface.name, operationName: item.operation.name }
    : { requestName: item.request.name, interfaceName: '', operationName: '' };
}

async function record(
  deps: SendThroughEngineDeps,
  recorded: Recorded,
  sent: SentRequest,
  summary: SendSummary,
  unredacted: ExchangeSummary | undefined,
  durationMs: number,
): Promise<void> {
  const { item, masks } = recorded;
  switch (item.kind) {
    case 'rest': {
      const { input } = restSent(sent);
      // History keeps the signing headers as they went out, so its resend replays them (R1).
      const rest = summary as RestExchangeSummary;
      const sentInput =
        input.sign === undefined ? input : withSentSigningHeaders(input, input.sign.scheme, rest.http.request.headers);
      await recordRest(deps, item, sentInput, rest, durationMs, masks.keyParams, undefined, recorded.label);
      return;
    }
    case 'soap': {
      const exchange = soapSent(sent);
      await recordSoap(deps, {
        ...soapRequestId(recorded),
        names: soapNames(recorded),
        input: exchange.input,
        ...(unredacted !== undefined ? { exchange: unredacted } : {}),
        // The exchange's own time on the wire: History has never counted resolving and connecting.
        durationMs: exchange.soap.durationMs,
        ...(recorded.label !== undefined ? { label: recorded.label } : {}),
      });
      return;
    }
    case 'grpc':
      await recordGrpc(
        deps,
        item,
        grpcSent(sent),
        summary as GrpcExchangeSummary,
        durationMs,
        undefined,
        recorded.label,
      );
      return;
    case 'websocket': {
      // As the app always has: the refused handshake's Log row, then History.
      const ws = summary as WsExchangeSummary;
      const opened = recorded.handshakeLogged === true;
      reportWsHandshakeFailure(deps, ws.sendId, item.request.id, ws, masks.keyParams, opened);
      await recordWs(deps, item, ws, masks.keyParams, opened, recorded.label);
      return;
    }
  }
}

async function recordFailure(
  deps: SendThroughEngineDeps,
  recorded: Recorded,
  failed: HeldFailure,
  error: unknown,
  durationMs: number,
  summaryOf: { readonly sendId: string; readonly show: boolean },
): Promise<void> {
  const { item, masks } = recorded;
  if (failed.input === undefined) return;
  switch (item.kind) {
    case 'rest':
      await recordRest(
        deps,
        item,
        failed.input as RestSendInput,
        undefined,
        durationMs,
        masks.keyParams,
        error,
        recorded.label,
      );
      return;
    case 'soap':
      await recordSoap(deps, {
        ...soapRequestId(recorded),
        names: soapNames(recorded),
        input: failed.input as SoapSendInput,
        error,
        durationMs: failed.durationMs,
        ...(recorded.label !== undefined ? { label: recorded.label } : {}),
      });
      return;
    case 'grpc': {
      // The call as connected, with the message it was to send: a send-stage failure has both.
      const { messageText, ...input } = failed.input as GrpcFailedInput;
      if (messageText === undefined) return;
      await recordGrpc(deps, item, { input, messageText }, undefined, durationMs, error, recorded.label);
      return;
    }
    case 'websocket': {
      // A session cancelled before it opened settled with its transcript, which History keeps as
      // the app always has; one that failed as it was built (a bad option) has none to record.
      if (failed.exchange === undefined) return;
      const summary = summariseWs(failed.exchange as WsExchange, summaryOf.sendId, {
        show: summaryOf.show,
        ...(masks.keyParams !== undefined ? { keyParams: masks.keyParams } : {}),
      });
      await recordWs(deps, item, summary, masks.keyParams, false, recorded.label);
      return;
    }
  }
}
