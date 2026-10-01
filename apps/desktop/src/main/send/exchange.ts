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
  openExchange,
  parseSecretPseudoRef,
  ProjectError,
  resolveExchange,
  restEffectiveAuth,
  SecretPlaceholders,
  soapEffectiveAuth,
} from '@wirebench/engine';
import type {
  AuthConfig,
  ExchangeHandle,
  LiveEvent,
  PropertyMap,
  PropertyScopes,
  RestContractResult,
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
  SoapSendInput,
  UnresolvedRef,
} from '@wirebench/engine';
import type { HistoryService } from '../history-service.js';
import { containsRecordedSecret, recordSecretValue } from '../redact.js';
import { finishScripts, scriptsFailed, scriptsForSend, sessionValuesFor, type SendScripts } from '../script-send.js';
import { withSentSigningHeaders } from '../webhook-send.js';
import { adHocSoapItem, AD_HOC_ID, selectedFor, type DraftOf } from './draft.js';
import { desktopSendHost, type DesktopSend, type DesktopSendDeps } from './host.js';
import { toWireEvent } from './live.js';
import { recordRest, recordSoap, summariseRest, summariseSoap, type HistoryNameFallback } from './record.js';
import type {
  ExchangeSummary,
  HistoryEntryWire,
  ResolvedSendInputWire,
  RestExchangeSummary,
  RestLiveEvent,
  RestRequestPatchWire,
} from '../../shared/wire-types.js';

export interface SendOptions<D extends DraftOf = DraftOf> {
  readonly draft: D;
  /**
   * A SOAP send with no saved request behind it: an ad-hoc send, or the resend of a request deleted
   * since. It is sent as a synthetic item (`adHocSoapItem`) and recorded under `names`.
   */
  readonly adHoc?: { readonly input: ResolvedSendInputWire; readonly names: HistoryNameFallback };
  readonly envId?: string;
  /** `${#Sequence#…}` values for a sequence step (`RunContext.sequence`). */
  readonly sequence?: PropertyMap;
  readonly timeoutMs?: number;
  readonly interactive?: boolean;
  /** The wire events, redacted; omitted when the caller shows nothing live. */
  readonly onLive?: (event: RestLiveEvent) => void;
  /** A sequence step's: told the scripts' result instead of the session store. */
  readonly onScriptsRan?: (sent: SentScripts) => void;
  /** Told the engine's `SentRequest` before the summary is built (a sequence step's subject). */
  readonly onSent?: (sent: SentRequest) => void;
}

/** What a send answers with, by protocol. Tasks 11 and 13 add the gRPC and WebSocket summaries. */
interface SummaryByKind {
  readonly rest: RestExchangeSummary;
  readonly soap: ExchangeSummary;
}

export type SendSummary = SummaryByKind[keyof SummaryByKind];

interface Kept {
  readonly requestId: string;
  readonly kind: string;
  readonly handle: ExchangeHandle;
}

/** The exchanges in flight, by send id: what `request.cancel` and a project's close reach. */
export class ExchangeRegistry {
  private readonly kept = new Map<string, Kept>();

  keep(sendId: string, requestId: string, kind: string, handle: ExchangeHandle): void {
    this.kept.set(sendId, { requestId, kind, handle });
  }

  get(sendId: string): ExchangeHandle | undefined {
    return this.kept.get(sendId)?.handle;
  }

  has(sendId: string): boolean {
    return this.kept.has(sendId);
  }

  /** Aborts the send `sendId`. `false` when no such send is in flight, or it has already settled. */
  cancel(sendId: string): { readonly cancelled: boolean } {
    const kept = this.kept.get(sendId);
    return { cancelled: kept?.handle.cancel() ?? false };
  }

  /** Ends every kept handle of `kind` whose request matches: a WebSocket closes 1000, anything else is cancelled. */
  endWhere(matches: (requestId: string) => boolean, kind: string): number {
    let ended = 0;
    for (const kept of this.kept.values()) {
      if (kept.kind !== kind || !matches(kept.requestId)) continue;
      if (kind === 'websocket') {
        kept.handle.close(1000);
        ended += 1;
      } else if (kept.handle.cancel()) {
        ended += 1;
      }
    }
    return ended;
  }

  forget(sendId: string): void {
    this.kept.delete(sendId);
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
}

/** What the "no such request" refusal calls a kind, as the app always has. */
const KIND_LABEL: Readonly<Record<DraftOf['kind'], string>> = { rest: 'REST', soap: 'SOAP' };

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
  return (await sendItem(deps, sendId, requestId, options)) as SummaryByKind[D['kind']];
}

async function sendItem(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  options: SendOptions,
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
  const send: DesktopSend = {
    sendId,
    requestId,
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
  const handle = openExchange(item, host, {
    scope,
    interactive: options.interactive === true,
    live: options.onLive !== undefined,
    ...(scripted !== undefined ? { scripts: scripted } : {}),
  });
  deps.registry.keep(sendId, requestId, item.kind, handle);
  const show = deps.showSecrets?.get() ?? false;
  const forwarding = forwardLive(sendId, handle, show, options.onLive);
  const startedAt = Date.now();
  try {
    const sent = await handle.result;
    await forwarding;
    options.onSent?.(sent);
    const summarised = summarise(deps, sendId, item, sent, masks, show, adHoc === undefined ? requestId : undefined);
    const full: SendSummary = {
      ...summarised.summary,
      ...(sent.script !== undefined ? finishScripts(stepDeps, projectId, sent.script) : {}),
      ...(scripts.kind === 'off' ? { scriptsOff: true } : {}),
    };
    const recorded: Recorded = { item, masks, ...(adHoc !== undefined ? { adHoc: adHoc.names } : {}) };
    await record(deps, recorded, sent, full, summarised.unredacted, Date.now() - startedAt);
    return full;
  } catch (error) {
    await forwarding;
    const failed = failures.sendStage();
    if (failed !== undefined) {
      // As the app always has: History first, then the HTTP Log's row.
      const recorded: Recorded = { item, masks, ...(adHoc !== undefined ? { adHoc: adHoc.names } : {}) };
      await recordFailure(deps, recorded, failed, error, Date.now() - startedAt);
      failed.report();
    }
    throw error;
  } finally {
    deps.registry.forget(sendId);
  }
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

/** A REST request resolved as its send would resolve it, nothing connected and no secret read. */
export interface RestPreview {
  readonly input: RestSendInput;
  readonly unresolved: readonly UnresolvedRef[];
  /** The credentials that apply, still as references. */
  readonly auth: AuthConfig;
}

/**
 * What a send of the REST request would send, for an export: resolved through the engine with no
 * secret read. Each `${secret:name}` stands behind a placeholder while the request resolves and is
 * put back as the token text, so it stays in the output as written. Undefined: no such REST request.
 *
 * @throws WirebenchError what resolving refuses: a webhook item's target, a file outside the project
 */
export async function previewRest(
  deps: SendThroughEngineDeps,
  requestId: string,
  draft: RestRequestPatchWire | undefined,
): Promise<RestPreview | undefined> {
  const located = deps.project.runContextFor?.(requestId);
  const item =
    located === undefined
      ? undefined
      : selectedFor(located.project, requestId, { kind: 'rest', ...(draft !== undefined ? { draft } : {}) });
  if (located === undefined || item?.kind !== 'rest') return undefined;
  const send: DesktopSend = { sendId: '', requestId, projectId: deps.project.projectId(requestId) };
  const host: SendHost = { ...(await desktopSendHost(deps, send)), getSecret: tokenText };
  const placeholders = new SecretPlaceholders();
  const context: RunContext = { ...runContextOf(located, host), secretPlaceholders: placeholders };
  const resolved = (await resolveExchange(item, host, createRunScope(context))) as {
    readonly input: RestSendInput;
    readonly unresolved: readonly UnresolvedRef[];
  };
  return {
    input: await placeholders.restore(resolved.input, tokenText),
    unresolved: resolved.unresolved,
    auth: restEffectiveAuth(item),
  };
}

/** A `${secret:name}` token's own text, which a preview shows in place of its value. */
function tokenText(ref: string): Promise<string | undefined> {
  const name = parseSecretPseudoRef(ref);
  return Promise.resolve(name === undefined ? undefined : `\${secret:${name}}`);
}

/** The names of an API key in the query or a header, from the item's effective credentials. */
function keyMasks(item: SelectedRequest): Pick<DesktopSend, 'keyParams' | 'keyHeaders'> {
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
  show: boolean,
  onLive: SendOptions['onLive'],
): Promise<void> {
  for await (const event of handle.events) {
    try {
      onLive?.(toWireEvent(sendId, event as LiveEvent, show));
    } catch (error) {
      console.warn(
        `[${event.protocol}] a live event ("${event.kind}") for send "${sendId}" could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** A send-stage failure held back until History is written. */
interface HeldFailure {
  /** The protocol's input as the engine reports it; it may hold live credentials, never logged. */
  readonly input: unknown;
  /** How long the send stage ran. */
  readonly durationMs: number;
  report(): void;
}

/** What a send's History entry is written from beyond the result: the item, its masks, an ad-hoc send's names. */
interface Recorded {
  readonly item: SelectedRequest;
  readonly masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>;
  readonly adHoc?: HistoryNameFallback;
}

function restSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'rest' }> {
  if (sent.exchange?.kind !== 'rest') throw new Error('A REST send came back without its exchange');
  return sent.exchange;
}

function soapSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'soap' }> {
  if (sent.exchange?.kind !== 'soap') throw new Error('A SOAP send came back without its exchange');
  return sent.exchange;
}

/** The summary the renderer is handed and, for SOAP, the unredacted one History records. */
function summarise(
  deps: SendThroughEngineDeps,
  sendId: string,
  item: SelectedRequest,
  sent: SentRequest,
  masks: Pick<DesktopSend, 'keyParams' | 'keyHeaders'>,
  show: boolean,
  requestId: string | undefined,
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
    default:
      throw new Error('not yet');
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
      await recordRest(deps, item, sentInput, rest, durationMs, masks.keyParams);
      return;
    }
    case 'soap': {
      const exchange = soapSent(sent);
      await recordSoap(deps, {
        ...(recorded.adHoc === undefined ? { requestId: item.request.id } : {}),
        names: soapNames(recorded),
        input: exchange.input,
        ...(unredacted !== undefined ? { exchange: unredacted } : {}),
        // The exchange's own time on the wire: History has never counted resolving and connecting.
        durationMs: exchange.soap.durationMs,
      });
      return;
    }
    default:
      throw new Error('not yet');
  }
}

async function recordFailure(
  deps: SendThroughEngineDeps,
  recorded: Recorded,
  failed: HeldFailure,
  error: unknown,
  durationMs: number,
): Promise<void> {
  const { item, masks } = recorded;
  if (failed.input === undefined) return;
  switch (item.kind) {
    case 'rest':
      await recordRest(deps, item, failed.input as RestSendInput, undefined, durationMs, masks.keyParams, error);
      return;
    case 'soap':
      await recordSoap(deps, {
        ...(recorded.adHoc === undefined ? { requestId: item.request.id } : {}),
        names: soapNames(recorded),
        input: failed.input as SoapSendInput,
        error,
        durationMs: failed.durationMs,
      });
      return;
    default:
      throw new Error('not yet');
  }
}
