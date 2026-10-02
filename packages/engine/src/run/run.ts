/**
 * Sends each selected request, evaluates its assertions and summarises the run.
 *
 * One request's error never stops the run unless `bail` asks it to: a pipeline wants the whole
 * picture, not the first thing that went wrong. An errored assertion outranks a failed one for the
 * request's outcome, because "we could not tell" is a different problem from "it is wrong".
 */
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { ProtocolRun, SelectedBase } from '../protocol/module.js';
import { featureDisabled } from '../protocol/registry.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest, SentExchange } from '../protocols.js';
import { scriptProperties } from '../script/props.js';
import { activeScripts, type RequestScripting, type ScriptedRequest } from '../script/request-scripts.js';
import type { RequestScripts } from '../script/model.js';
import { SecretPlaceholders } from '../script/send.js';
import type { TransferResult } from '../sequence/run.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import type { SendHost } from './host.js';
import { openExchange } from './open.js';
import { createRunTokenSource } from './oauth2-token.js';
import { createRunScope, scopeWith } from './scope.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  type ScriptSession,
  type ScriptSessionOptions,
  type SentScripts,
} from './script-support.js';

export type { LiveEvent, SentExchange } from '../protocols.js';

export type RequestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

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
  /** What the request's scripts logged, capped. NOT yet redacted. */
  readonly scriptLog?: readonly string[];
  /** True when the request has scripts and they are switched off, so none ran. */
  readonly scriptsOff?: boolean;
}

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface RunResult {
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunSummary;
  readonly requests: readonly RequestResult[];
}

export interface RunOptions {
  readonly bail?: boolean;
  readonly defaultSlaMs?: number;
  readonly requireAssertions?: boolean;
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
}

/** A request's own assertions; a gRPC request that never had any, and a protocol without them, carry none. */
const assertionsOf = (item: SelectedRequest): readonly Assertion[] =>
  ('assertions' in item.request ? item.request.assertions : undefined) ?? [];

/** A request's scripts, as saved; a protocol without scripts has none. */
const scriptsOf = (item: SelectedRequest): RequestScripts | undefined =>
  'scripts' in item.request ? item.request.scripts : undefined;

/** Enough of each exchange to keep for a report: a failing response can be megabytes. */
const EXCHANGE_CAP_BYTES = 64 * 1024;

function capped(bytes: Uint8Array): string {
  if (bytes.length <= EXCHANGE_CAP_BYTES) {
    return new TextDecoder().decode(bytes);
  }
  return `${new TextDecoder().decode(bytes.subarray(0, EXCHANGE_CAP_BYTES))}\n… truncated`;
}

function identity(item: SelectedRequest): Pick<RequestResult, 'path' | 'group' | 'name' | 'protocol'> {
  return { path: item.path, group: item.group, name: item.request.name, protocol: item.kind };
}

function erroredResult(item: SelectedRequest, error: NonNullable<RequestResult['error']>): RequestResult {
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
}

/** What a run's sender may change for one request. */
export type RunSendOverrides = Pick<RunContext, 'sequence' | 'timeoutMs'>;

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
    opening ??= listedSecrets(scripted.scripts.secrets, context.host.getSecret).then((secrets) =>
      // The run records a value as it merges it (`mergeScriptValues`); nothing about the send is
      // shown before that.
      scriptSession(
        scripting,
        scripted,
        {
          vars: context.sequence ?? {},
          props: scriptProperties(scopesFor(context)),
          secrets,
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
  // One token source for the whole run: requests behind the same OAuth2 configuration share a token.
  const host: SendHost = {
    ...context.host,
    tokens:
      context.host.tokens ??
      createRunTokenSource({
        getSecret: context.host.getSecret,
        ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
      }),
  };
  const scope = createRunScope({ ...context, host });

  return async (item, overrides = {}) => {
    const itemContext: RunContext = {
      ...scope.context,
      ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    };
    const itemScope = scopeWith(scope, itemContext);
    const run = runOf(registry, item);

    const scripts = activeScripts(scriptsOf(item));
    if (scripts === undefined) {
      const sent = await openExchange(item, itemContext.host, { scope: itemScope, interactive: false, run: true })
        .result;
      return scriptsOf(item) !== undefined ? { ...sent, scriptsOff: true } : sent;
    }

    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) throw refused;

    const scripting = context.scripting;
    if (scripting === undefined) {
      throw new WirebenchError('script-unavailable', `"${item.path}" has scripts, and this run cannot run them`, {
        details: { path: item.path },
      });
    }
    const scripted: ScriptedRequest = {
      protocol: item.kind,
      path: item.path,
      name: item.request.name,
      slug: item.request.slug,
      scripts,
      types: await run.scriptTypes(item, itemScope),
    };
    await scripting.check(scripted);
    return openExchange(item, itemContext.host, {
      scope: itemScope,
      interactive: false,
      run: true,
      scripts: { session: deferredSession(scripting, scripted, itemContext), placeholders: new SecretPlaceholders() },
    }).result;
  };
}

/**
 * Type-checks the scripts of every selected request before a run sends anything (spec
 * §Type-checking): each request whose scripts are switched on, against its own contract's types.
 * Returns one error per request that fails, in selection order; empty when all pass.
 */
export async function checkRunScripts(
  selected: readonly SelectedRequest[],
  context: RunContext,
): Promise<readonly WirebenchError[]> {
  const scripting = context.scripting;
  const errors: WirebenchError[] = [];
  if (scripting === undefined) return errors;
  const registry = context.registry ?? defaultRegistry();
  const scope = createRunScope(context);
  for (const item of selected) {
    const scripts = activeScripts(scriptsOf(item));
    if (scripts === undefined) continue;
    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) {
      errors.push(refused);
      continue;
    }
    try {
      await scripting.check({
        protocol: item.kind,
        path: item.path,
        name: item.request.name,
        slug: item.request.slug,
        scripts,
        types: await runOf(registry, item).scriptTypes(item, scope),
      });
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

/** Runs one request; a throw anywhere on the way becomes an errored result, never a stopped run. */
async function runOne(
  item: SelectedRequest,
  send: RunRequestSender,
  options: RunOptions,
  overrides: RunSendOverrides,
  context: RunContext,
): Promise<{ result: RequestResult; sent?: SentRequest }> {
  try {
    const own = assertionsOf(item);
    // The cursor is taken inside this helper, before the send (§2.3 step 1).
    const { sent, callbacks } = await sendAwaitingCallbacks(
      own,
      () => scopesFor({ ...context, ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}) }),
      () => send(item, overrides),
      {
        ...(options.captures !== undefined ? { captures: options.captures } : {}),
        ...(options.callbackClock !== undefined ? { clock: options.callbackClock } : {}),
        ...(options.callbackPollMs !== undefined ? { pollIntervalMs: options.callbackPollMs } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        onWaiting: (waiting) => options.onCallbackWaiting?.(item.path, waiting),
      },
    );
    options.onSent?.(item, sent);
    const { subject, raw, script } = sent;
    const withDefault: readonly Assertion[] =
      options.defaultSlaMs !== undefined && !own.some((a) => a.type === 'sla')
        ? [...own, { type: 'sla', maxMs: options.defaultSlaMs }]
        : own;
    const immediate = await evaluateAssertions(
      subject,
      withDefault.filter((assertion) => !isCallbackAssertion(assertion)),
    );
    const assertions = [...immediate, ...callbacks, ...scriptAssertions(script?.tests ?? [])];
    const outcome = script?.error !== undefined ? 'errored' : outcomeOf(assertions);
    return {
      sent,
      result: {
        ...identity(item),
        outcome,
        status: subject.status,
        durationMs: subject.durationMs,
        assertions,
        unasserted: own.length === 0 && (script?.tests.length ?? 0) === 0,
        ...(script?.error !== undefined ? { error: script.error } : {}),
        ...scriptReport(script, sent.scriptsOff === true),
        ...(outcome !== 'passed'
          ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
          : {}),
      },
    };
  } catch (e) {
    return { result: erroredResult(item, errorOf(e)) };
  }
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

/**
 * Sends `selected` in order and reports each. A request after an abort, or after the first
 * failure under `bail`, is `skipped` and never sent.
 */
export async function runRequests(
  selected: readonly SelectedRequest[],
  context: RunContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const send = createRunSender(context);
  const results: RequestResult[] = [];
  // Values scripts set, which later requests of the run read as `${#Sequence#name}` (#63).
  const runValues = new Map<string, string>(Object.entries(context.sequence ?? {}));
  let stopped = false;
  for (const item of selected) {
    let result: RequestResult;
    if (stopped || context.signal?.aborted === true) {
      result = {
        ...identity(item),
        outcome: 'skipped',
        assertions: [],
        unasserted: assertionsOf(item).length === 0,
      };
    } else if (
      assertionsOf(item).length === 0 &&
      activeScripts(scriptsOf(item))?.post === undefined &&
      options.requireAssertions === true
    ) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      const ran = await runOne(item, send, options, { sequence: Object.fromEntries(runValues) }, context);
      result = ran.result;
      mergeScriptValues(
        runValues,
        ran.sent?.script?.values ?? [],
        context.host.onSecretValue,
        context.containsKnownSecret,
      );
    }
    results.push(result);
    options.onRequestDone?.(result);
    if (options.bail === true && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  }
  const count = (outcome: RequestOutcome): number => results.filter((r) => r.outcome === outcome).length;
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
    },
    requests: results,
  };
}
