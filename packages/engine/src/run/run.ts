/**
 * Sends each selected request, evaluates its assertions and summarises the run.
 *
 * One request's error never stops the run unless `bail` asks it to: a pipeline wants the whole
 * picture, not the first thing that went wrong. An errored assertion outranks a failed one for the
 * request's outcome, because "we could not tell" is a different problem from "it is wrong".
 */
import { findTemplatePlaceholders } from '../xml/template-placeholders.js';
import { sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { checkRequestAssertions } from '../assert/check.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { ProtocolRun, RunScope, SelectedBase } from '../protocol/module.js';
import { featureDisabled } from '../protocol/registry.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocol/default-registry.js';
import type { SelectedRequest, SentExchange } from '../protocol/unions.js';
import type { GoldenFile, GoldenRead, GoldenWrite } from '../snapshot/golden-file.js';
import { scriptProperties } from '../script/props.js';
import {
  activeLevels,
  activeScripts,
  scriptSecretNames,
  type PostResponseOrder,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptLevel,
} from '../script/request-scripts.js';
import type { RequestScripts, ScriptValue } from '../script/model.js';
import { SecretPlaceholders } from '../script/send.js';
import type { StepBranch, TransferResult } from '../sequence/run.js';
import { finishBaselineUpdate, planBaselineUpdate, type SinkOutcome } from './baseline-update.js';
import { BASELINE_PROTOCOLS, checkBaseline } from './baseline.js';
import type { BaselineCheck, BaselineReport } from './baseline.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import type { SendHost } from './host.js';
import type { Pacer } from './iterate.js';
import { openExchange } from './open.js';
import { asSelected } from './select.js';
import { createRunTokenSource } from './oauth2-token.js';
import { createJwtSource } from '../http/auth/jwt.js';
import { createRunScope, scopeWith } from './scope.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  type ScriptSession,
  type ScriptSessionOptions,
  ScriptSkipped,
  type SentScripts,
} from './script-support.js';

export type { LiveEvent, SentExchange } from '../protocol/unions.js';

export type RequestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

/** Reads the golden saved for a selected request (#36); the host knows where the project is saved. */
export type BaselineSource = (item: SelectedRequest) => Promise<GoldenRead>;

/** Saves a golden for a selected request (#217); the host knows where the project is saved. */
export type BaselineSink = (item: SelectedRequest, golden: GoldenFile) => Promise<GoldenWrite>;

/** What happened to one selected request. */
export interface RequestResult {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  /** The request's kind, as its module registered it. */
  readonly protocol: string;
  readonly outcome: RequestOutcome;
  readonly status?: number;
  readonly durationMs?: number;
  readonly assertions: readonly AssertionResult[];
  /** The `--baseline` comparison (#36); absent when not asked for, or when the send failed. */
  readonly baseline?: BaselineReport;
  /** Set when errored before or during the send. */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  /** A request with no assertions of its own; reported, and an error under `requireAssertions`. */
  readonly unasserted: boolean;
  /** Raw request and response text, kept for failed and errored requests only. NOT yet redacted. */
  readonly exchange?: { readonly request: string; readonly response: string };
  /** Set when this is a sequence step: which sequence, and which of its steps. */
  readonly sequence?: { readonly id: string; readonly name: string; readonly stepId: string };
  /** A sequence step's transfers. A secret one carries no value. */
  readonly transfers?: readonly TransferResult[];
  /** Where the request went, for a sequence step. */
  readonly origin?: string;
  /** A sequence step's run of it, from 2, when a branch ran it again (#347). */
  readonly attempt?: number;
  /** A later run of this sequence step superseded this one; it is reported as skipped. */
  readonly retried?: true;
  /** What a sequence step's branches did. */
  readonly branch?: StepBranch;
  /** What the request's scripts logged, capped. NOT yet redacted. */
  readonly scriptLog?: readonly string[];
  /** True when the request has scripts and they are switched off, so none ran. */
  readonly scriptsOff?: boolean;
  /** Which iteration of a data-driven run sent it (0-based), of how many, and its data row (#336). */
  readonly iteration?: { readonly index: number; readonly count: number; readonly row?: number };
  /**
   * What the request's scripts asked of an API or folder run (#335): that it was skipped, and the
   * request the run goes on at (`null`: the run ended).
   */
  readonly control?: { readonly skipped?: true; readonly next?: string | null };
  /** How many values of a SOAP request went out still holding the template "?" (#728); absent for none. */
  readonly templatePlaceholders?: number;
}

/** The template "?" values a SOAP request was sent with (#728), as a result field, or nothing. */
function templatePlaceholdersOf(item: SelectedBase, rawRequest: Uint8Array): { templatePlaceholders?: number } {
  if (identity(item).protocol !== 'soap') return {};
  const count = findTemplatePlaceholders(new TextDecoder().decode(rawRequest)).length;
  return count > 0 ? { templatePlaceholders: count } : {};
}

/** Bounds on run control (#335): fixed, with no option to raise or remove them. */
export const RUN_CONTROL_LIMITS = Object.freeze({
  /** The most times one run may go on at a request its scripts named. */
  jumps: 1_000,
});

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
  /** Set when the run compared baselines (#36). */
  readonly baseline?: { readonly matched: number; readonly differs: number; readonly missing: number };
  /** Set when the run updated baselines (#217). */
  readonly baselineUpdate?: {
    readonly updated: number;
    readonly created: number;
    readonly matched: number;
    readonly skipped: number;
    readonly refused: number;
  };
  /** Set for a data-driven run (#336): the iterations planned, and how many ran before a bail or a stop. */
  readonly iterations?: { readonly planned: number; readonly run: number };
}

export interface RunResult {
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunSummary;
  readonly requests: readonly RequestResult[];
}

export interface RunOptions {
  readonly bail?: boolean;
  /**
   * True for an API or folder run (#335): scripts may skip their request, end the run or send it on
   * at another selected request. Off, as in a single send, they are ignored and the log says so.
   */
  readonly runControl?: boolean;
  readonly defaultSlaMs?: number;
  readonly requireAssertions?: boolean;
  /** Compare each response with its golden (#36). Sequence steps never are. */
  readonly baseline?: { readonly source: BaselineSource; readonly require: boolean };
  /** Save each changed response as its golden (#217). Never set with `baseline`; sequence steps never are. */
  readonly updateBaseline?: { readonly source: BaselineSource; readonly sink: BaselineSink };
  readonly onRequestDone?: (result: RequestResult) => void;
  /** Where callback assertions read captures (callback-assertion §2.2). Absent: they error, and the run goes on. */
  readonly captures?: CaptureSource;
  /** The clock callback waits poll by; a test seam. */
  readonly callbackClock?: CallbackClock;
  /** How often a waiting callback polls; `CALLBACK_LIMITS.pollIntervalMs` by default. A test seam. */
  readonly callbackPollMs?: number;
  /** Called after a request's send when it has callbacks to wait for. */
  readonly onCallbackWaiting?: (path: string, waiting: readonly CallbackWaiting[]) => void;
  /**
   * Called once for each request that got a response: after the send and after any callback wait,
   * before the request's other assertions are evaluated. It is not called when the send throws, nor
   * when the callback wait throws. A host that records the send (the command line's `send` writes
   * History) reads the exchange here.
   */
  readonly onSent?: (item: SelectedRequest, sent: SentRequest) => void;
  /**
   * Sends each request; `createRunSender(context)` when absent. A data-driven run passes one sender
   * to every iteration so a definition loads once and an OAuth2 token is shared; a host with its own
   * send path (the desktop) passes that.
   */
  readonly send?: RunRequestSender;
  /** Waited on before each send: a data-driven run's delay between requests (#336). */
  readonly pace?: Pacer;
}

/** A request's own assertions; a gRPC request that never had any, and a protocol without them, carry none. */
const assertionsOf = (item: SelectedBase): readonly Assertion[] =>
  ('assertions' in item.request ? item.request.assertions : undefined) ?? [];

/** A request's scripts, as saved; a protocol without scripts has none. */
const scriptsOf = (item: SelectedBase): RequestScripts | undefined =>
  'scripts' in item.request ? item.request.scripts : undefined;

/** The scripts that will run in a send of `item`: its own, and its levels', switched on (#334). */
interface ItemScripts {
  readonly own: RequestScripts | undefined;
  readonly outer: readonly ScriptLevel[];
  /** The API's post-response order, read before its level was dropped for being off or empty. */
  readonly postResponseOrder: PostResponseOrder | undefined;
  /** True when the request or a level above it has scripts, on or off. */
  readonly any: boolean;
}

function itemScripts(item: SelectedBase, registry: ProtocolRegistry): ItemScripts {
  const levels = registry.find(item.kind)?.run?.scriptLevels?.(item) ?? [];
  const own = activeScripts(scriptsOf(item));
  return {
    own,
    outer: activeLevels(levels),
    postResponseOrder: levels.find((level) => level.level === 'api')?.scripts.postResponseOrder,
    any: scriptsOf(item) !== undefined || levels.length > 0,
  };
}

/** True when a send of `item` runs any script, at any level. */
const runsScripts = (scripts: ItemScripts): boolean => scripts.own !== undefined || scripts.outer.length > 0;

/** True when a send of `item` runs a post-response script, at any level: its tests are assertions. */
const runsPostScript = (scripts: ItemScripts): boolean =>
  scripts.own?.post !== undefined || scripts.outer.some((level) => level.scripts.post !== undefined);

/**
 * True when a send of `item` runs a post-response script, its own or a level's (#334), so its
 * tests count as the request's assertions. `registry` is where its levels are looked up.
 */
export function hasPostResponseScript(item: SelectedBase, registry: ProtocolRegistry = defaultRegistry()): boolean {
  return runsPostScript(itemScripts(item, registry));
}

/** The request as its scripts run it: its own, its levels', and the types its module gives it. */
async function scriptedOf(
  item: SelectedBase,
  scripts: ItemScripts,
  run: ProtocolRun,
  scope: RunScope,
): Promise<ScriptedRequest> {
  return {
    protocol: item.kind,
    path: item.path,
    name: item.request.name,
    slug: item.request.slug,
    ...(scripts.own !== undefined ? { scripts: scripts.own } : {}),
    ...(scripts.outer.length > 0 ? { outer: scripts.outer } : {}),
    ...(scripts.postResponseOrder !== undefined ? { postResponseOrder: scripts.postResponseOrder } : {}),
    types: await run.scriptTypes(item, scope),
  };
}

/** Enough of each exchange to keep for a report: a failing response can be megabytes. */
const EXCHANGE_CAP_BYTES = 64 * 1024;

function capped(bytes: Uint8Array): string {
  if (bytes.length <= EXCHANGE_CAP_BYTES) {
    return new TextDecoder().decode(bytes);
  }
  return `${new TextDecoder().decode(bytes.subarray(0, EXCHANGE_CAP_BYTES))}\n… truncated`;
}

function identity(item: SelectedBase): Pick<RequestResult, 'path' | 'group' | 'name' | 'protocol'> {
  return { path: item.path, group: item.group, name: item.request.name, protocol: item.kind };
}

function erroredResult(item: SelectedBase, error: NonNullable<RequestResult['error']>): RequestResult {
  return {
    ...identity(item),
    outcome: 'errored',
    assertions: [],
    error,
    unasserted: assertionsOf(item).length === 0,
  };
}

function outcomeOf(assertions: readonly AssertionResult[]): RequestOutcome {
  if (assertions.some((a) => a.outcome === 'errored')) return 'errored';
  if (assertions.some((a) => a.outcome === 'failed')) return 'failed';
  return 'passed';
}

/** One request as a run sends it: the response as assertions see it, and what a report keeps. */
export interface SentRequest {
  readonly subject: AssertionSubject;
  readonly raw: { readonly rawRequest: Uint8Array; readonly rawResponse: Uint8Array };
  /** The whole exchange, of whichever protocol sent it. */
  readonly exchange?: SentExchange;
  /** Where the request went: a URL's origin, or a gRPC target. */
  readonly origin?: string;
  /** What the request's scripts produced (#63). */
  readonly script?: SentScripts;
  /** True when the request has scripts and they are switched off. */
  readonly scriptsOff?: boolean;
  /** Checks the protocol made of the response itself: a GraphQL request's errors (#77). */
  readonly checks?: readonly AssertionResult[];
}

/** What a run's sender may change for one request. */
export type RunSendOverrides = Pick<RunContext, 'sequence' | 'timeoutMs' | 'data' | 'iteration'> & {
  /** True in an API or folder run: the request's scripts may steer it (#335). A sequence step never sets it. */
  readonly runControl?: boolean;
};

/** Sends one selected request as a run does. Throws what preparing or sending throws. */
export type RunRequestSender = (item: SelectedRequest, overrides?: RunSendOverrides) => Promise<SentRequest>;

/** The run facet of the module for `item`'s kind. */
function runOf(registry: ProtocolRegistry, item: SelectedBase): ProtocolRun {
  const run = registry.require(item.kind).run;
  if (run === undefined) {
    throw new Error(`The "${item.kind}" protocol cannot run requests`);
  }
  return run;
}

/**
 * The scripts of one send, opened when the module first runs one. The secrets a request lists for
 * its scripts are read then and not before, so they are asked for after everything resolving the
 * request asks for, and before anything connecting it does. Exported for the desktop's sends,
 * which pass `options` to record each secret value a script sets as the app's other sends do.
 */
export function deferredSession(
  scripting: RequestScripting,
  scripted: ScriptedRequest,
  context: RunContext,
  options: ScriptSessionOptions = {},
): ScriptSession {
  let opening: Promise<ScriptSession> | undefined;
  const open = (): Promise<ScriptSession> => {
    opening ??= listedSecrets(scriptSecretNames(scripted), context.host.getSecret).then((secrets) =>
      // The run records a value as it merges it (`mergeScriptValues`); nothing about the send is
      // shown before that.
      scriptSession(
        scripting,
        scripted,
        {
          vars: context.sequence ?? {},
          props: scriptProperties(scopesFor(context)),
          secrets,
          ...(context.data !== undefined ? { data: context.data } : {}),
          ...(context.iteration !== undefined ? { iteration: context.iteration } : {}),
        },
        options,
      ),
    );
    return opening;
  };
  return {
    pre: async (before) => (await open()).pre(before),
    post: async (sent, response) => (await open()).post(sent, response),
  };
}

/**
 * Why a request's active scripts cannot run in this registry, as the error its send reports (spec
 * §5.3, §9): the `scripts` feature is off, or the request's protocol has no scripting facet.
 * Undefined when they can run, and for a protocol the registry does not hold: looking its module up
 * refuses that request first, with the protocol's own `feature-disabled`.
 */
function scriptsRefusal(item: SelectedBase, registry: ProtocolRegistry): WirebenchError | undefined {
  const module = registry.find(item.kind);
  if (module === undefined) return undefined;
  if (!registry.features.isEnabled('scripts')) {
    return featureDisabled(registry.features, 'scripts');
  }
  if (module.scripting === undefined) {
    return new WirebenchError(
      'script-unsupported',
      `"${item.path}" has scripts, and ${item.kind} requests cannot have them`,
      {
        details: { path: item.path, protocol: item.kind },
      },
    );
  }
  return undefined;
}

/**
 * Why a selected webhook item cannot be sent in this registry (feature switches spec §2.1): the
 * `webhooks` feature is off. A webhook item is a REST item against the synthetic `webhooks` API that
 * REST's run facet builds for the collection. Undefined for every other item, and when the feature
 * is on. Checked before the item's scripts and its send, the way `scriptsRefusal` is.
 */
function webhookRefusal(item: SelectedBase, registry: ProtocolRegistry): WirebenchError | undefined {
  if (item.kind !== 'rest' || (item as { readonly api?: { readonly id?: string } }).api?.id !== 'webhooks') {
    return undefined;
  }
  if (registry.features.isEnabled('webhooks')) return undefined;
  return featureDisabled(registry.features, 'webhooks');
}

/**
 * A sender for one run: whatever a protocol loads for a container (a definition, a schema, an
 * OpenAPI document) is loaded once, and one OAuth2 token source serves every request behind the same
 * configuration. `runRequests` sends through it, and so does a sequence run, so a step is sent
 * exactly as a selected request is. Which protocol sends a request is the registry's answer
 * (`context.registry`, the built-in protocols by default).
 *
 * A request with scripts (#63) is type-checked first; its module then resolves it with its secrets
 * behind placeholders, runs the pre-request script on that, puts the secrets back, connects, sends,
 * and runs the post-response script on the response.
 */
export function createRunSender(context: RunContext): RunRequestSender {
  const registry = context.registry ?? defaultRegistry();
  // One token source for the whole run: requests behind the same OAuth2 configuration share a token,
  // and requests behind the same JWT configuration share a signed JWT while it is fresh.
  const host: SendHost = {
    ...context.host,
    tokens:
      context.host.tokens ??
      createRunTokenSource({
        getSecret: context.host.getSecret,
        ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
      }),
    jwts: context.host.jwts ?? createJwtSource(),
  };
  const scope = createRunScope({ ...context, host });

  return async (selected, overrides = {}) => {
    // Core works on the base: the union is the host's (package split spec §3.4).
    const item: SelectedBase = selected;
    const itemContext: RunContext = {
      ...scope.context,
      ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      ...(overrides.data !== undefined ? { data: overrides.data } : {}),
      ...(overrides.iteration !== undefined ? { iteration: overrides.iteration } : {}),
    };
    const itemScope = scopeWith(scope, itemContext);
    const run = runOf(registry, item);

    const webhookRefused = webhookRefusal(item, registry);
    if (webhookRefused !== undefined) throw webhookRefused;

    const scripts = itemScripts(item, registry);
    if (!runsScripts(scripts)) {
      const sent = await openExchange(item, itemContext.host, { scope: itemScope, interactive: false, run: true })
        .result;
      return scripts.any ? { ...sent, scriptsOff: true } : sent;
    }

    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) throw refused;

    const scripting = context.scripting;
    if (scripting === undefined) {
      throw new WirebenchError('script-unavailable', `"${item.path}" has scripts, and this run cannot run them`, {
        details: { path: item.path },
      });
    }
    const scripted = await scriptedOf(item, scripts, run, itemScope);
    await scripting.check(scripted);
    return openExchange(item, itemContext.host, {
      scope: itemScope,
      interactive: false,
      run: true,
      scripts: {
        session: deferredSession(
          scripting,
          scripted,
          itemContext,
          overrides.runControl === true ? { runControl: true } : {},
        ),
        placeholders: new SecretPlaceholders(),
      },
    }).result;
  };
}

/**
 * Type-checks the scripts of every selected request before a run sends anything (spec
 * §Type-checking): each request whose scripts are switched on, against its own contract's types.
 * Returns one error per request that fails, in selection order; empty when all pass.
 */
export async function checkRunScripts(
  selected: readonly SelectedBase[],
  context: RunContext,
): Promise<readonly WirebenchError[]> {
  const scripting = context.scripting;
  const errors: WirebenchError[] = [];
  if (scripting === undefined) return errors;
  const registry = context.registry ?? defaultRegistry();
  const scope = createRunScope(context);
  for (const item of selected) {
    const scripts = itemScripts(item, registry);
    if (!runsScripts(scripts)) continue;
    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) {
      errors.push(refused);
      continue;
    }
    try {
      await scripting.check(await scriptedOf(item, scripts, runOf(registry, item), scope));
    } catch (error) {
      errors.push(
        isWirebenchError(error)
          ? error
          : new WirebenchError('script-type-error', error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return errors;
}

/** The `--baseline` check for one sent request: `unsupported` for a protocol without goldens. */
async function baselineOf(
  item: SelectedBase,
  subject: AssertionSubject,
  baseline: NonNullable<RunOptions['baseline']>,
): Promise<BaselineCheck> {
  if (!BASELINE_PROTOCOLS.has(item.kind)) {
    return { report: { status: 'unsupported' } };
  }
  return checkBaseline(await baseline.source(asSelected(item)), subject, baseline.require);
}

/** The `--update-baseline` step for one sent request whose own outcome did not error. */
async function baselineUpdateOf(
  item: SelectedBase,
  subject: AssertionSubject,
  failed: boolean,
  update: NonNullable<RunOptions['updateBaseline']>,
  containsKnownSecret: ((value: string) => boolean) | undefined,
): Promise<BaselineCheck> {
  if (!BASELINE_PROTOCOLS.has(item.kind)) {
    return { report: { status: 'unsupported' } };
  }
  const plan = planBaselineUpdate({
    read: await update.source(asSelected(item)),
    subject,
    failed,
    ...(containsKnownSecret !== undefined ? { containsKnownSecret } : {}),
    now: () => new Date(),
  });
  if (plan.kind === 'done') return plan.check;
  let outcome: SinkOutcome;
  try {
    outcome = await update.sink(asSelected(item), plan.golden);
  } catch (error) {
    outcome = { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return finishBaselineUpdate(plan.report, outcome);
}

/** Runs one request; a throw anywhere on the way becomes an errored result, never a stopped run. */
async function runOne(
  item: SelectedBase,
  send: RunRequestSender,
  options: RunOptions,
  overrides: RunSendOverrides,
  context: RunContext,
): Promise<{ result: RequestResult; sent?: SentRequest; values?: readonly ScriptValue[] }> {
  try {
    const own = assertionsOf(item);
    // The cursor is taken inside this helper, before the send (§2.3 step 1).
    const { sent, callbacks } = await sendAwaitingCallbacks(
      own,
      () => scopesFor({ ...context, ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}) }),
      () => send(asSelected(item), overrides),
      {
        ...(options.captures !== undefined ? { captures: options.captures } : {}),
        ...(options.callbackClock !== undefined ? { clock: options.callbackClock } : {}),
        ...(options.callbackPollMs !== undefined ? { pollIntervalMs: options.callbackPollMs } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        onWaiting: (waiting) => options.onCallbackWaiting?.(item.path, waiting),
      },
    );
    options.onSent?.(asSelected(item), sent);
    const { subject, raw, script } = sent;
    const immediate = await checkRequestAssertions(
      subject,
      own,
      options.defaultSlaMs !== undefined ? { defaultSlaMs: options.defaultSlaMs } : {},
    );
    const checked = [...immediate, ...callbacks, ...(sent.checks ?? []), ...scriptAssertions(script?.tests ?? [])];
    // `--update-baseline` writes only for a request its own checks did not error (#217).
    const ownOutcome = script?.error === undefined ? outcomeOf(checked) : 'errored';
    const compared =
      options.baseline !== undefined
        ? await baselineOf(item, subject, options.baseline)
        : options.updateBaseline !== undefined && ownOutcome !== 'errored'
          ? await baselineUpdateOf(
              item,
              subject,
              ownOutcome === 'failed',
              options.updateBaseline,
              context.containsKnownSecret,
            )
          : undefined;
    const assertions = compared?.assertion !== undefined ? [...checked, compared.assertion] : checked;
    const error = script?.error ?? compared?.error;
    const outcome = error !== undefined ? 'errored' : outcomeOf(assertions);
    return {
      sent,
      result: {
        ...identity(item),
        outcome,
        status: subject.status,
        durationMs: subject.durationMs,
        assertions,
        // The synthetic baseline assertion does not count: --require-assertions keeps its meaning.
        unasserted: own.length === 0 && (script?.tests.length ?? 0) === 0,
        ...(error !== undefined ? { error } : {}),
        ...(compared !== undefined ? { baseline: compared.report } : {}),
        ...scriptReport(script, sent.scriptsOff === true),
        ...(script?.control !== undefined ? { control: script.control } : {}),
        ...templatePlaceholdersOf(item, raw.rawRequest),
        ...(outcome !== 'passed'
          ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
          : {}),
      },
    };
  } catch (e) {
    if (e instanceof ScriptSkipped) {
      return {
        result: {
          ...skippedResult(item),
          ...(e.log.lines.length > 0 ? { scriptLog: e.log.lines } : {}),
          control: { skipped: true, ...(e.next !== undefined ? { next: e.next } : {}) },
        },
        values: e.values,
      };
    }
    return { result: erroredResult(item, errorOf(e)) };
  }
}

/** A request the run did not send: after an abort, a bail, a script's skip or a jump past it. */
function skippedResult(item: SelectedBase): RequestResult {
  return { ...identity(item), outcome: 'skipped', assertions: [], unasserted: assertionsOf(item).length === 0 };
}

/** What a result reports of a request's scripts: their log, or that they were switched off. */
export function scriptReport(
  script: SentScripts | undefined,
  scriptsOff: boolean,
): Pick<RequestResult, 'scriptLog' | 'scriptsOff'> {
  return {
    ...(script !== undefined && script.log.lines.length > 0 ? { scriptLog: script.log.lines } : {}),
    ...(scriptsOff ? { scriptsOff: true } : {}),
  };
}

/** A thrown value as a result's `error`, with the engine's code when it has one. */
export function errorOf(e: unknown): NonNullable<RequestResult['error']> {
  return {
    code: isWirebenchError(e) ? e.code : 'internal-error',
    message: e instanceof Error ? e.message : String(e),
    ...(isWirebenchError(e) && e.details !== undefined ? { details: e.details } : {}),
  };
}

/** A failed or errored exchange as a report keeps it: each side capped, not yet redacted. */
export function cappedExchange(raw: SentRequest['raw']): NonNullable<RequestResult['exchange']> {
  return { request: capped(raw.rawRequest), response: capped(raw.rawResponse) };
}

/** A result errored by its scripts' run control (#335): the request ran, and the run cannot go where they said. */
function runControlError(result: RequestResult, code: string, message: string): RequestResult {
  return { ...result, outcome: 'errored', error: { code, message } };
}

/**
 * Sends `selected` in order and reports each. A request after an abort, or after the first
 * failure under `bail`, is `skipped` and never sent. A script may skip its request, end the run or
 * send it on at another selected request by name (#335), at most `RUN_CONTROL_LIMITS.jumps` times.
 */
export async function runRequests(
  selected: readonly SelectedBase[],
  context: RunContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const send = options.send ?? createRunSender(context);
  const registry = context.registry ?? defaultRegistry();
  const results: RequestResult[] = [];
  // Values scripts set, which later requests of the run read as `${#Sequence#name}` (#63).
  const runValues = new Map<string, string>(Object.entries(context.sequence ?? {}));
  let stopped = false;
  let jumps = 0;
  const report = (result: RequestResult): void => {
    results.push(result);
    options.onRequestDone?.(result);
    if (options.bail === true && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  };
  // By index, not in order: a script may send the run on at another selected request (#335).
  let index = 0;
  while (index < selected.length) {
    const item = selected[index]!;
    let result: RequestResult;
    const willSend =
      !stopped &&
      context.signal?.aborted !== true &&
      !(
        assertionsOf(item).length === 0 &&
        activeScripts(scriptsOf(item))?.post === undefined &&
        options.requireAssertions === true
      );
    if (willSend) await options.pace?.wait();
    if (stopped || context.signal?.aborted === true) {
      result = skippedResult(item);
    } else if (
      assertionsOf(item).length === 0 &&
      options.requireAssertions === true &&
      !runsPostScript(itemScripts(item, registry))
    ) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      const ran = await runOne(
        item,
        send,
        options,
        {
          sequence: Object.fromEntries(runValues),
          ...(context.data !== undefined ? { data: context.data } : {}),
          ...(context.iteration !== undefined ? { iteration: context.iteration } : {}),
          ...(options.runControl === true ? { runControl: true } : {}),
        },
        context,
      );
      result = ran.result;
      mergeScriptValues(
        runValues,
        ran.values ?? ran.sent?.script?.values ?? [],
        context.host.onSecretValue,
        context.containsKnownSecret,
      );
    }
    const next = result.control?.next;
    let target = index + 1;
    if (next === null) {
      stopped = true;
    } else if (next !== undefined) {
      const found = selected.findIndex((s) => s.request.name === next);
      if (found === -1) {
        result = runControlError(
          result,
          'script-next-unknown',
          `The scripts asked for "${next}", which this run did not select`,
        );
        stopped = true;
      } else if (jumps >= RUN_CONTROL_LIMITS.jumps) {
        result = runControlError(
          result,
          'script-jump-limit',
          `The scripts sent this run on ${String(RUN_CONTROL_LIMITS.jumps)} times, the most a run allows`,
        );
        stopped = true;
      } else {
        jumps += 1;
        target = found;
      }
    }
    report(result);
    if (stopped || context.signal?.aborted === true) {
      target = index + 1;
    }
    // A jump forward passes over requests: they are reported, as skipped, where the run passed them.
    for (let passed = index + 1; passed < target; passed += 1) {
      report(skippedResult(selected[passed]!));
    }
    index = target;
  }
  const count = (outcome: RequestOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const baselineCount = (status: BaselineReport['status']): number =>
    results.filter((r) => r.baseline?.status === status).length;
  // Inside a workspace the environment a run names is the workspace's.
  const environments = context.workspace?.workspace.environments ?? context.project.environments;
  const environment = environments.find((e) => e.id === context.environmentId)?.name;
  return {
    startedAt,
    ...(environment !== undefined ? { environment } : {}),
    summary: {
      total: results.length,
      passed: count('passed'),
      failed: count('failed'),
      errored: count('errored'),
      skipped: count('skipped'),
      durationMs: Math.round(performance.now() - started),
      ...(options.baseline !== undefined
        ? {
            baseline: {
              matched: baselineCount('matched'),
              differs: baselineCount('differs'),
              missing: baselineCount('missing'),
            },
          }
        : {}),
      ...(options.updateBaseline !== undefined
        ? {
            baselineUpdate: {
              updated: baselineCount('updated'),
              created: baselineCount('created'),
              matched: baselineCount('matched'),
              skipped: baselineCount('skipped'),
              refused: baselineCount('refused'),
            },
          }
        : {}),
    },
    requests: results,
  };
}
