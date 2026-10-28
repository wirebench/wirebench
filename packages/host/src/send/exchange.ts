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
  isProtectedEnvironment,
  isWirebenchError,
  openExchange,
  parseSecretPseudoRef,
  ProjectError,
  resolvedBaseUrl,
  signJwtFor,
  resolveExchange,
  restEffectiveAuth,
  SecretPlaceholders,
  soapEffectiveAuth,
  webhooksOf,
  WirebenchError,
  wsEffectiveAuth,
} from '@wirebench/engine';
import type {
  JwtAuth,
  JwtSendAuth,
  AuthConfig,
  BaseUrlSource,
  CommandApprovalRequest,
  DesktopAuditEvent,
  ExchangeHandle,
  GrpcResolvedInput,
  GrpcSelected,
  LiveEvent,
  Project,
  PropertyMap,
  PropertyScopes,
  RestSelected,
  RestSendInput,
  RunContext,
  RunScope,
  ScriptedRequest,
  ScriptedSend,
  SelectedBase,
  SelectedRequest,
  SendFailure,
  SendHost,
  SentRequest,
  SentScripts,
  SoapOwnerAuth,
  SoapOverride,
  SoapSelected,
  SoapSendInput,
  UnresolvedRef,
  WorkerFrameChecker,
  WorkerFrameCheckerOptions,
  WsCallInput,
  WsExchange,
} from '@wirebench/engine';
import type { Redactor } from '../host/redactor.js';
import { requestSentEvent } from '../audit/desktop-events.js';
import type { HistoryService } from '../history-service.js';
import { finishScripts, scriptsFailed, scriptsForSend, sessionValuesFor, type SendScripts } from '../script-send.js';
import { callbackUrlFor, type WebhookUrlSource } from '../webhook-send.js';
import { editorAssertionResults } from './assertions.js';
import { adHocSoapItem, AD_HOC_ID, type DraftOf } from './draft.js';
import { kindSend } from '../kinds/kind-send.js';
import type { KeyMasks } from '../kinds/kind-main.js';
import { wsSent } from '../kinds/ws/send.js';
import { wsSessionOf, type WsSession } from '../kinds/ws/session.js';
import { isInteractive, kindById } from '@wirebench/wire/kinds/kind-module';
import { desktopSendHost, type DesktopSend, type DesktopSendDeps } from './host.js';
import { toWireEvent } from './live.js';
import { type HistoryLabel, type HistoryNameFallback } from './record.js';
import type { HistoryEntryWire, ResolvedSendInputWire } from '@wirebench/wire/wire-types';
import type { GrpcExchangeSummary, GrpcLiveEvent, GrpcRequestPatchWire } from '@wirebench/wire/kinds/grpc/wire';
import type { RestExchangeSummary, RestLiveEvent, RestRequestPatchWire } from '@wirebench/wire/kinds/rest/wire';
import type { McpExchangeSummary, McpLiveEvent } from '@wirebench/wire/kinds/mcp/wire';
import type { ExchangeSummary } from '@wirebench/wire/kinds/soap/wire';
import type { WsExchangeSummary, WsLiveEvent, WsRequestPatchWire } from '@wirebench/wire/kinds/ws/wire';

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
  /** A Runner iteration's data row, `${#Data#…}` (`RunContext.data`, #336). */
  readonly data?: PropertyMap;
  /** Which Runner iteration this send belongs to, for its scripts (`RunContext.iteration`). */
  readonly iteration?: { readonly index: number; readonly count: number };
  readonly timeoutMs?: number;
  readonly interactive?: boolean;
  /**
   * True for a sequence step, which is a run (`ExchangeOptions.run`): a stream waits for its answer
   * within the timeout, and one the timeout cuts fails with `timeout`. The editor's sends are not.
   */
  readonly run?: boolean;
  /**
   * True for an editor's Send: the request's own assertions are checked against what came back and
   * returned with the result. Resends, multi-environment sends and sequence steps leave it off.
   */
  readonly checkAssertions?: boolean;
  /**
   * True when the caller already asked about a protected environment (#345): a sequence run asks
   * once before its first step, a multi-environment batch once for all its protected environments.
   * Absent, a send under a protected environment asks for itself.
   */
  readonly protectedConfirmed?: boolean;
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
  /**
   * Asks about an MCP stdio command line for this send (#79): the window that sent it, or a run's
   * memo so each command line is asked about once per run. Absent, the deps' approver asks.
   */
  readonly approveCommand?: (request: CommandApprovalRequest) => Promise<boolean>;
  /**
   * A send the app makes for its own use, such as fetching a GraphQL schema (#77): the request's
   * scripts do not run, and it leaves no History entry and no HTTP Log row. It is still audited.
   */
  readonly quiet?: boolean;
}

/** The live events a send reports, by protocol: a SOAP send reports none. */
interface LiveByKind {
  readonly rest: RestLiveEvent;
  readonly soap: never;
  readonly grpc: GrpcLiveEvent;
  readonly websocket: WsLiveEvent;
  readonly mcp: McpLiveEvent;
}

/** What a send answers with, by protocol. */
interface SummaryByKind {
  readonly rest: RestExchangeSummary;
  readonly soap: ExchangeSummary;
  readonly grpc: GrpcExchangeSummary;
  readonly websocket: WsExchangeSummary;
  readonly mcp: McpExchangeSummary;
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
    if (isInteractive(kind) && this.kept.has(sendId)) {
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
    if (kept?.handle === undefined || !isInteractive(kept.kind) || kept.closed === true) return false;
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
      if (!isInteractive(kind) || kept.opened?.() !== true) {
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

/** The saved request as a send item with the editor's draft applied. Undefined: no such request of that kind. */
function selectedFor(project: Project, requestId: string, draft: DraftOf): SelectedRequest | undefined {
  return kindSend(draft.kind).selected(project, requestId, draft);
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
  /**
   * Told of each saved request's send that reached the wire, successful or failed (desktop audit
   * events spec §2.2); never of a run's step, an ad-hoc send, or one that failed while prepared.
   * `workspaceId` is {@link auditWorkspace} as it was when the send started.
   */
  readonly audit?: (event: DesktopAuditEvent, workspaceId: string | undefined) => void;
  /** The server workspace audit events are queued for now. */
  readonly auditWorkspace?: () => string | undefined;
  /**
   * Asks the person whether to send under the protected environments named (#345); resolves
   * `true` to send. Absent (a test, a headless caller), a guarded send is refused: it fails safe.
   */
  readonly confirmProtected?: (environmentNames: readonly string[]) => Promise<boolean>;
}

/**
 * The name of the environment a send runs under when it is protected (#345) — the workspace's
 * when the send runs inside one, its linked project environment counting too — else `undefined`.
 */
export function protectedEnvironmentOf(
  located: Pick<Located, 'environmentId' | 'workspace' | 'project'>,
): string | undefined {
  const id = located.environmentId;
  if (id === undefined) return undefined;
  const environments = located.workspace?.workspace.environments ?? located.project.environments;
  const environment = environments.find((candidate) => candidate.id === id);
  return environment !== undefined && isProtectedEnvironment(located.project, environment)
    ? environment.name
    : undefined;
}

/** Asks about the protected environments named, `true` at once when there are none; never throws. */
export async function confirmProtectedSend(
  deps: Pick<SendThroughEngineDeps, 'confirmProtected'>,
  environmentNames: readonly string[],
): Promise<boolean> {
  if (environmentNames.length === 0) return true;
  try {
    return (await deps.confirmProtected?.(environmentNames)) === true;
  } catch {
    return false;
  }
}

/** The refusal of a send the person did not confirm, naming its protected environments. */
export function sendDeclined(environmentNames: readonly string[]): WirebenchError {
  const names = environmentNames.map((name) => `"${name}"`).join(', ');
  return new WirebenchError('send-declined', `Not sent: ${names} is protected and the send was not confirmed`, {
    details: { environments: [...environmentNames] },
  });
}

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
  const scripts = await scriptsForSend(deps, adHoc === undefined && options.quiet !== true ? requestId : undefined);
  const located = adHoc === undefined ? savedContext(deps, requestId, options.envId) : adHocContext(deps, adHoc.input);
  const item =
    located === undefined
      ? undefined
      : adHoc !== undefined
        ? adHocSoapItem(adHoc.input, adHoc.names)
        : selectedFor(located.project, requestId, options.draft);
  if (located === undefined || item === undefined) {
    throw new ProjectError(
      'unknown-entity',
      `No ${kindById(options.draft.kind).label} request with id "${requestId}"`,
      {
        details: { requestId },
      },
    );
  }
  // Asked before anything is resolved or sent; an ad-hoc send runs under no environment.
  if (adHoc === undefined && options.protectedConfirmed !== true) {
    const guarded = protectedEnvironmentOf(located);
    if (guarded !== undefined && !(await confirmProtectedSend(deps, [guarded]))) {
      throw sendDeclined([guarded]);
    }
  }
  // An ad-hoc send belongs to no project: no project's secrets, proxy, keystore or session values.
  const projectId = adHoc === undefined ? deps.project.projectId(requestId) : undefined;
  const masks = keyMasks(item);
  // What the rows name: the saved request, or the one a resent entry came from.
  const namedId = adHoc === undefined ? requestId : adHoc.requestId;
  const target = targetHostOf(item);
  const send: DesktopSend = {
    sendId,
    requestId: namedId ?? AD_HOC_ID,
    projectId,
    ...(target !== undefined ? { target } : {}),
    ...masks,
    ...(options.envId !== undefined ? { envId: options.envId } : {}),
    ...(options.approveCommand !== undefined ? { approveCommand: options.approveCommand } : {}),
  };
  const desktopHost = await desktopSendHost(deps, send);
  // A quiet send reports no failure row: its caller hears the error.
  const failures = deferredSendFailure(options.quiet === true ? { ...desktopHost, events: {} } : desktopHost);
  const { host } = failures;
  const stepDeps = options.onScriptsRan !== undefined ? { ...deps, onScriptsRan: options.onScriptsRan } : deps;
  const sequence = options.sequence ?? sessionValuesFor(stepDeps, projectId);
  const context: RunContext = {
    ...runContextOf(located, host),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(deps.scripts !== undefined ? { scripting: deps.scripts.scripting } : {}),
    containsKnownSecret: deps.hostState.redactor.containsRecordedSecret,
  };
  const scope = createRunScope(context);
  // The workspace this send happens in: one that closes before the send ends must not take it.
  const auditWorkspaceId = deps.auditWorkspace?.();
  const scripted =
    scripts.kind === 'on' && deps.scripts !== undefined
      ? scriptedSend(deps.hostState.redactor, deps.scripts, scripts.request, context)
      : undefined;
  // An interactive session's events are always read: its frames are checked, its handshake opens it.
  const session = isInteractive(item.kind) ? wsSessionOf(deps, sendId, requestId, send, options.onLive) : undefined;
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
  const forwarding = forwardLive(deps.hostState.redactor, sendId, handle, { show, ...masks }, options.onLive, session);
  try {
    const sent = await handle.result;
    await forwarding;
    await options.onSent?.(sent);
    const checked = session === undefined ? undefined : await session.checked(wsSent(sent).ws);
    const summarised = summarise(deps, sendId, item, sent, masks, show, namedId, checked);
    const full: SendSummary = {
      ...summarised.summary,
      ...(sent.script !== undefined ? finishScripts(deps.hostState.redactor, stepDeps, projectId, sent.script) : {}),
      ...(scripts.kind === 'off' ? { scriptsOff: true } : {}),
    };
    const recorded: Recorded = {
      ...recordedOf(item, masks, options),
      handshakeLogged: send.handshakeLogged === true,
    };
    if (options.quiet !== true) await record(deps, recorded, sent, full, summarised.unredacted);
    reportSend(deps, options, projectId, located, item, auditWorkspaceId, () => sentAudit(sent, full));
    // After History is written, so a result never reaches it (request-assertions spec §6).
    const own = options.checkAssertions === true && 'assertions' in item.request ? (item.request.assertions ?? []) : [];
    const assertions = await editorAssertionResults(deps.hostState.redactor, own, sent.subject);
    return assertions === undefined ? full : { ...full, assertions };
  } catch (error) {
    await forwarding;
    const failed = failures.sendStage();
    if (failed !== undefined) {
      // As the app always has: History first, then the HTTP Log's row.
      const recorded: Recorded = {
        ...recordedOf(item, masks, options),
        handshakeLogged: send.handshakeLogged === true,
      };
      await recordFailure(deps, recorded, failed, error, { sendId, show });
      reportSend(deps, options, projectId, located, item, auditWorkspaceId, () => failedAudit(item, failed));
      failed.report();
    }
    throw error;
  } finally {
    deps.registry.forget(sendId, token);
    // The contract worker ends with the session however it ended: a close, a drop, a quit.
    await session?.dispose();
  }
}

/**
 * The host name a request goes to when its own URL (or endpoint) names one outright; `undefined` when
 * it is built from variables or the kind keeps its address elsewhere. Only reported with a secret
 * resolution (`HostOptions.onSecret`), so a miss costs nothing but the name.
 */
function targetHostOf(item: unknown): string | undefined {
  const selected = item as
    | { readonly request?: Readonly<Record<string, unknown>>; readonly api?: Readonly<Record<string, unknown>> }
    | undefined;
  // The request's own address first; a REST request's path is taken from its API's base URL.
  for (const value of [selected?.request?.['url'], selected?.request?.['endpoint'], selected?.api?.['baseUrl']]) {
    if (typeof value !== 'string' || value.includes('${')) continue;
    try {
      const host = new URL(value).hostname;
      if (host.length > 0) return host;
    } catch {
      // Not a URL on its own: no target to name.
    }
  }
  return undefined;
}

type Located = NonNullable<ReturnType<NonNullable<SendThroughEngineDeps['project']['runContextFor']>>> & {
  /** The `${…}` shorthand's values laid over the environment's (`RunContext.overrides`). */
  readonly overrides?: PropertyMap;
  /** A SOAP request's default `wsa:Action`, from the definition the app has loaded. */
  readonly defaultWsaActionFor?: RunContext['defaultWsaActionFor'];
  /** A SOAP request's definition, as the app has loaded it: the engine then reads no cache. */
  readonly loadedDefinitionFor?: RunContext['loadedDefinitionFor'];
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
    // The session's current values (cookie jar spec §5.2), laid over committed ones by the engine.
    ...(located.current !== undefined ? { current: located.current } : {}),
    overrides: located.overrides ?? {},
    ...(located.defaultWsaActionFor !== undefined ? { defaultWsaActionFor: located.defaultWsaActionFor } : {}),
    ...(located.loadedDefinitionFor !== undefined ? { loadedDefinitionFor: located.loadedDefinitionFor } : {}),
    // The run's registry: a send selects and runs through the kinds this run has on.
    ...(located.registry !== undefined ? { registry: located.registry } : {}),
    // The host's `${#System#…}` scope (`savedContext` and `adHocContext` always set one), so the engine
    // never falls back to the process environment.
    ...(located.system !== undefined ? { system: located.system } : {}),
    host,
  };
}

/**
 * What a send the app makes for its own use runs in, outside any saved request (#79, an MCP
 * catalogue refresh): the project that owns `entityId` under its active environment, and the app's
 * host for it, which writes no HTTP Log row. Undefined when no open project owns the entity.
 */
export async function appSendScope(
  deps: SendThroughEngineDeps,
  entityId: string,
  send: Pick<DesktopSend, 'sendId' | 'approveCommand'>,
): Promise<{ readonly project: Project; readonly scope: RunScope; readonly host: SendHost } | undefined> {
  const located = savedContext(deps, entityId, undefined);
  if (located === undefined) return undefined;
  const real = await desktopSendHost(deps, {
    ...send,
    requestId: entityId,
    projectId: deps.project.projectId(entityId),
  });
  const host: SendHost = { ...real, events: {} };
  return { project: located.project, scope: createRunScope(runContextOf(located, host)), host };
}

/**
 * Where a send of a saved request runs: its project, environment and globals, and the default
 * `wsa:Action` of its operation from the definition the app has loaded — whether or not the
 * interface caches it on disk, which is all the engine can read for itself. That definition is lent
 * whole too, so a SOAP send or preview never re-reads and recompiles the interface's cache.
 */
function savedContext(deps: SendThroughEngineDeps, requestId: string, envId: string | undefined): Located | undefined {
  const located = deps.project.runContextFor?.(requestId, envId);
  if (located === undefined) return undefined;
  const defaultAction = deps.project.defaultWsaActionFor;
  const { service } = deps;
  return {
    ...located,
    // The host's own `${#System#…}` scope when the project gives none: never the process fallback.
    system: located.system ?? deps.hostState.systemValues,
    ...(defaultAction !== undefined
      ? { defaultWsaActionFor: (selected) => defaultAction.call(deps.project, selected.request.id) }
      : {}),
    loadedDefinitionFor: (selected) =>
      service.has(selected.iface.id) ? service.resultFor(selected.iface.id) : undefined,
  };
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
    system: scopes?.system ?? deps.hostState.systemValues,
  };
}

/**
 * What every preview resolves in: the saved request with the draft over it, the run context a send
 * of it runs in (under `envId` when one is named, else the active environment), and a host that
 * reads no secret. Each `${secret:name}` stands behind a placeholder
 * while the request resolves and is put back as its token text (`asTyped`), so it stays in the output
 * as written; `secretTokens` answers whether one was reached. Undefined: no such request of that
 * kind, or no such environment.
 */
async function previewOf<K extends DraftOf['kind']>(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: Extract<DraftOf, { kind: K }>,
  envId?: string,
): Promise<
  | {
      readonly item: Extract<SelectedRequest, { kind: K }>;
      readonly context: RunContext;
      readonly placeholders: SecretPlaceholders;
      readonly asTyped: (ref: string) => Promise<string | undefined>;
      readonly secretTokens: () => boolean;
      /** The names of the `${secret:name}` tokens reached, in the order reached. */
      readonly secretNames: () => readonly string[];
      /** Signs (or reuses) the JWT a send of this request would carry, with the real secrets. */
      readonly signJwt: (auth: JwtAuth) => Promise<JwtSendAuth>;
    }
  | undefined
> {
  const located = savedContext(deps, requestId, envId);
  const item = located === undefined ? undefined : selectedFor(located.project, requestId, draft);
  if (located === undefined || item?.kind !== draft.kind) return undefined;
  const send: DesktopSend = {
    sendId: '',
    requestId,
    projectId: deps.project.projectId(requestId),
    ...(envId !== undefined ? { envId } : {}),
  };
  let reached = false;
  const names = new Set<string>();
  const asTyped = (ref: string): Promise<string | undefined> => {
    const name = parseSecretPseudoRef(ref);
    reached ||= name !== undefined;
    if (name !== undefined) names.add(name);
    return tokenText(ref);
  };
  const real = await desktopSendHost(deps, send);
  const host: SendHost = { ...real, getSecret: asTyped };
  const placeholders = new SecretPlaceholders();
  return {
    item: item as Extract<SelectedRequest, { kind: K }>,
    context: { ...runContextOf(located, host), secretPlaceholders: placeholders },
    placeholders,
    asTyped,
    secretTokens: () => reached,
    secretNames: () => [...names],
    // Through the app's JWT source, so an export shows the token the next send carries.
    signJwt: (auth) => signJwtFor(auth, runContextOf(located, real)),
  };
}

/** Where a REST request's base URL came from: an environment, the API, or a webhook item's target or callback. */
export type RestUrlSource = BaseUrlSource | WebhookUrlSource;

/** A REST request resolved as its send would resolve it, nothing connected and no secret read. */
export interface RestPreview {
  readonly item: RestSelected;
  readonly input: RestSendInput;
  readonly unresolved: readonly UnresolvedRef[];
  /** The names of the `${secret:name}` tokens reached, for the preflight's early warnings. */
  readonly secretNames: readonly string[];
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Signs (or reuses) the JWT a send would carry, reading the real secrets; only for `auth.type === 'jwt'`. */
  readonly signJwt: (auth: JwtAuth) => Promise<JwtSendAuth>;
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
  envId?: string,
): Promise<RestPreview | undefined> {
  const preview = await previewOf(deps, requestId, { kind: 'rest', ...(draft !== undefined ? { draft } : {}) }, envId);
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
    secretNames: preview.secretNames(),
    auth: restEffectiveAuth(item),
    signJwt: preview.signJwt,
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
  const webhooks = webhooksOf(project);
  if (webhooks === undefined || findWebhookRequest(webhooks, item.request.id) === undefined) {
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
  /** The names of the `${secret:name}` tokens reached, for the preflight's early warnings. */
  readonly secretNames: readonly string[];
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Signs (or reuses) the JWT a send would carry, reading the real secrets; only for `auth.type === 'jwt'`. */
  readonly signJwt: (auth: JwtAuth) => Promise<JwtSendAuth>;
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
    secretNames: preview.secretNames(),
    auth: grpcEffectiveAuth(item),
    signJwt: preview.signJwt,
    targetSource: resolvedBaseUrl(context, { slug: item.api.slug, baseUrl: item.api.target }).source,
  };
}

/** A WebSocket session resolved as its open would resolve it, nothing dialled and no secret read. */
export interface WsPreview {
  readonly input: WsCallInput;
  readonly unresolved: readonly UnresolvedRef[];
  /** True when a `${secret:name}` token was reached: it stays in the output as typed. */
  readonly secretTokens: boolean;
  /** The names of the `${secret:name}` tokens reached, for the preflight's early warnings. */
  readonly secretNames: readonly string[];
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
  /** Signs (or reuses) the JWT a send would carry, reading the real secrets; only for `auth.type === 'jwt'`. */
  readonly signJwt: (auth: JwtAuth) => Promise<JwtSendAuth>;
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
    secretNames: preview.secretNames(),
    auth: wsEffectiveAuth(item),
    signJwt: preview.signJwt,
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
export async function previewSoap(
  deps: SendThroughEngineDeps,
  requestId: string,
  override?: SoapOverride,
  envId?: string,
): Promise<SoapPreview | undefined> {
  const preview = await previewOf(
    deps,
    requestId,
    { kind: 'soap', ...(override !== undefined ? { override } : {}) },
    envId,
  );
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
function keyMasks(item: SelectedRequest): KeyMasks {
  return kindSend(item.kind).keyMasks?.(item) ?? {};
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
function scriptedSend(
  redactor: Redactor,
  scripts: SendScripts,
  request: ScriptedRequest,
  context: RunContext,
): ScriptedSend {
  const session = deferredSession(scripts.scripting, request, context, {
    onSecretValue: redactor.recordSecretValue,
    containsKnownSecret: redactor.containsRecordedSecret,
  });
  return {
    session: { pre: session.pre, post: (sent, response) => session.post(sent, response).catch(scriptsFailed) },
    placeholders: new SecretPlaceholders(),
  };
}

/** Hands each live event to `onLive`, redacted; one that cannot be delivered never affects the send. */
async function forwardLive(
  redactor: Redactor,
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
      onLive?.(toWireEvent(redactor, sendId, event, redaction.show, redaction.keyParams));
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
export interface HeldFailure {
  /** The protocol's input as the engine reports it; it may hold live credentials, never logged. */
  readonly input: unknown;
  /** What the protocol recorded of the exchange before it failed, when it settled part way. */
  readonly exchange: unknown;
  /** How long the send stage ran. */
  readonly durationMs: number;
  report(): void;
}

/** What a send's History entry is written from beyond the result: the item, its masks, an ad-hoc send's names. */
export interface Recorded {
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
  return kindSend(item.kind).summarise({ deps, sendId, item, sent, masks, show, requestId, checked });
}

async function record(
  deps: SendThroughEngineDeps,
  recorded: Recorded,
  sent: SentRequest,
  summary: SendSummary,
  unredacted: ExchangeSummary | undefined,
): Promise<void> {
  await kindSend(recorded.item.kind).record(deps, recorded, sent, summary, unredacted);
}

async function recordFailure(
  deps: SendThroughEngineDeps,
  recorded: Recorded,
  failed: HeldFailure,
  error: unknown,
  summaryOf: { readonly sendId: string; readonly show: boolean },
): Promise<void> {
  await kindSend(recorded.item.kind).recordFailure(deps, recorded, failed, error, summaryOf);
}

/** What the audit log keeps of one send beyond its request: where it went and how it ended. */
export interface AuditedSend {
  readonly method: string | null;
  /** Unredacted: `requestSentEvent` masks it. */
  readonly url: string;
  readonly status: number | null;
  readonly outcome: 'ok' | 'failed';
  readonly durationMs: number;
}

/** The environment a send ran under, by name: the workspace's when it runs inside one, else the project's. */
export function environmentNameOf(located: Pick<Located, 'environmentId' | 'workspace' | 'project'>): string | null {
  const id = located.environmentId;
  if (id === undefined) return null;
  const environments = located.workspace?.workspace.environments ?? located.project.environments;
  return environments.find((environment) => environment.id === id)?.name ?? null;
}

/**
 * Hands the audit hook a saved request's send. A run's step is covered by its run's event, and an
 * ad-hoc send belongs to no project. Nothing here may fail the send it reports.
 */
function reportSend(
  deps: SendThroughEngineDeps,
  options: SendOptions,
  projectId: string | undefined,
  located: Located,
  item: SelectedRequest,
  workspaceId: string | undefined,
  of: () => AuditedSend | undefined,
): void {
  if (deps.audit === undefined || options.run === true || projectId === undefined) return;
  try {
    const sent = of();
    if (sent === undefined || sent.url.length === 0) return;
    deps.audit(
      requestSentEvent(deps.hostState.redactor, {
        protocol: item.kind,
        ...sent,
        environment: environmentNameOf(located),
        requestId: item.request.id,
        requestName: item.request.name,
        sentAt: new Date().toISOString(),
      }),
      workspaceId,
    );
  } catch (error) {
    console.warn(`[audit] a send could not be reported: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A send that got its answer: the URL as it went out, the status, and the time the summary shows. */
function sentAudit(sent: SentRequest, summary: SendSummary): AuditedSend | undefined {
  const { exchange } = sent;
  return exchange === undefined ? undefined : kindSend(exchange.kind).sentAudit(exchange, summary);
}

/** A send that failed on the wire (desktop audit events plan, ruling 8): no status, where it was going. */
function failedAudit(item: SelectedRequest, failed: HeldFailure): AuditedSend | undefined {
  return kindSend(item.kind).failedAudit(item, failed);
}
