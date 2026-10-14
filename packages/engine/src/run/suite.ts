/**
 * A whole run as `wirebench run` makes it, as a library (#343): the CLI and a server running a
 * schedule share the selection, the sequences, the data rows and the baselines. Loading the project,
 * resolving secrets and reporting stay with the host.
 */
import type { CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import type { StepAssertion } from '../assert/model.js';
import { WirebenchError } from '../errors.js';
import type { Environment, Project } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { createScriptChecker } from '../script/check/host.js';
import { RequestScripting } from '../script/request-scripts.js';
import { createScriptSandbox } from '../script/sandbox/host.js';
import { sequenceFilePath } from '../sequence/file.js';
import type { SequenceDef } from '../sequence/model.js';
import { runSequence } from '../sequence/run.js';
import type { SequenceStepResult, SequenceStepSender } from '../sequence/run.js';
import type { WorkspaceEnvironment } from '../workspace/model.js';
import { scopesFor } from './context.js';
import type { RunContext, RunWorkspace } from './context.js';
import { pickEnvironment, projectIdOf } from './environment.js';
import { createPacer, iterationContext, runIterations, tagIteration } from './iterate.js';
import type { Pacer } from './iterate.js';
import type { Iteration } from './iterations.js';
import {
  cappedExchange,
  checkRunScripts,
  createRunSender,
  errorOf,
  hasPostResponseScript,
  runRequests,
} from './run.js';
import type { RequestResult, RunOptions, RunRequestSender, RunResult, SentRequest } from './run.js';
import { findStepRequest, selectRequests } from './select.js';
import type { SelectedRequest } from './select.js';

function normalise(selector: string): string {
  return selector.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The sequences `selectors` name, in the order given: each selector is a sequence's name or its file
 * path (`sequences/<slug>.sequence.yaml`). A selector naming nothing is refused (`sequence-not-found`), as for requests:
 * a pipeline that tested nothing must not be told it passed.
 */
export function selectSequences(project: Project, selectors: readonly string[]): SequenceDef[] {
  const selected: SequenceDef[] = [];
  const unmatched: string[] = [];
  for (const selector of selectors) {
    const wanted = normalise(selector);
    const found = project.sequences.find((s) => s.name === selector || sequenceFilePath(s.slug) === wanted);
    if (found === undefined) {
      unmatched.push(selector);
    } else if (!selected.includes(found)) {
      selected.push(found);
    }
  }
  if (unmatched.length > 0) {
    const names = project.sequences.map((s) => s.name).join(', ');
    throw new WirebenchError(
      'sequence-not-found',
      `--sequence matched nothing: ${unmatched.join(', ')}${names !== '' ? `; sequences: ${names}` : '; the project has none'}`,
    );
  }
  return selected;
}

/**
 * Every step's request, resolved before anything is sent. A step whose request is missing or cannot
 * run refuses the whole run (`sequence-cannot-run`) naming it, so a report never has a step it cannot say
 * the protocol of, and a broken sequence fails loudly rather than as a red step.
 */
export function resolveSteps(
  project: Project,
  sequences: readonly SequenceDef[],
  registry?: ProtocolRegistry,
): SelectedRequest[] {
  const problems: string[] = [];
  const requests = new Map<string, SelectedRequest>();
  for (const sequence of sequences) {
    for (const [index, step] of sequence.steps.entries()) {
      const target = findStepRequest(project, step.requestId, registry);
      if (target.kind === 'found') {
        requests.set(target.selected.request.id, target.selected);
      } else {
        const reason = target.kind === 'missing' ? `its request (${step.requestId}) no longer exists` : target.reason;
        problems.push(
          `"${sequence.name}" step ${index + 1}${step.name !== undefined ? ` (${step.name})` : ''}: ${reason}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new WirebenchError('sequence-cannot-run', `a sequence cannot run:\n  ${problems.join('\n  ')}`);
  }
  return [...requests.values()];
}

/** `--sla` for a step that has no `sla` assertion of its own nor from its request. */
export function withDefaultSla(sequence: SequenceDef, project: Project, slaMs: number | undefined): SequenceDef {
  if (slaMs === undefined) {
    return sequence;
  }
  return {
    ...sequence,
    steps: sequence.steps.map((step) => {
      const target = findStepRequest(project, step.requestId);
      const own: readonly StepAssertion[] = [
        ...(step.requestAssertions && target.kind === 'found' && 'assertions' in target.selected.request
          ? (target.selected.request.assertions ?? [])
          : []),
        ...step.assertions,
      ];
      return own.some((a) => a.type === 'sla')
        ? step
        : { ...step, assertions: [...step.assertions, { type: 'sla', maxMs: slaMs }] };
    }),
  };
}

/** Options for {@link runSequences}. */
export interface RunSequencesOptions {
  readonly bail: boolean;
  readonly requireAssertions: boolean;
  readonly slaMs?: number;
  readonly signal: AbortSignal;
  readonly onStepDone: (result: RequestResult) => void;
  /** Whether `value` contains a credential the run already knows. */
  readonly containsKnownSecret: (value: string) => boolean;
  /** Where callback assertions read captures; one that errors when the server is not configured. */
  readonly captures: CaptureSource;
  /** A step has sent and waits for callbacks; `path` is the step's report path. */
  readonly onCallbackWaiting: (path: string, waiting: readonly CallbackWaiting[]) => void;
  /** The run's sender, shared by every iteration of a data-driven run; one of its own when absent. */
  readonly send?: RunRequestSender;
  /** Waited on before each step's send: a data-driven run's delay (#336). */
  readonly pace?: Pacer;
}

/**
 * Runs each sequence in turn through the runner's own sender, and reports every step as a request of
 * the run, grouped by sequence. `--bail` skips the sequences after the first that fails or errors; a
 * sequence's own `stopOnFailure` decides within it.
 */
export async function runSequences(
  sequences: readonly SequenceDef[],
  context: RunContext,
  options: RunSequencesOptions,
): Promise<RunResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const send = options.send ?? createRunSender(context);
  const results: RequestResult[] = [];
  let bailed = false;

  for (const original of sequences) {
    const sequence = withDefaultSla(original, context.project, options.slaMs);
    // Kept per step for the report: the raw exchange of a failed or errored step.
    const raw = new Map<string, SentRequest['raw']>();
    const sender: SequenceStepSender = async (step, sequenceScope) => {
      // A post-response script's tests count as the step's assertions (#63), a level's too (#334).
      const { request } = step.selected;
      const declared =
        (step.step.requestAssertions && 'assertions' in request ? (request.assertions ?? []).length : 0) +
        step.step.assertions.length +
        (hasPostResponseScript(step.selected, context.registry) ? 1 : 0);
      if (options.requireAssertions && declared === 0) {
        return { error: { code: 'assertions-required', message: 'This step has no assertions.' } };
      }
      try {
        await options.pace?.wait();
        const sent = await send(step.selected, {
          sequence: sequenceScope,
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          // An iteration's row reaches every step (#336).
          ...(context.data !== undefined ? { data: context.data } : {}),
          ...(context.iteration !== undefined ? { iteration: context.iteration } : {}),
        });
        raw.set(`${step.step.id}#${step.attempt}`, sent.raw);
        return {
          subject: sent.subject,
          ...(sent.origin !== undefined ? { origin: sent.origin } : {}),
          ...(sent.script !== undefined ? { script: sent.script } : {}),
          ...(sent.scriptsOff === true ? { scriptsOff: true } : {}),
          ...(sent.checks !== undefined ? { checks: sent.checks } : {}),
        };
      } catch (error) {
        return { error: errorOf(error) };
      }
    };
    const toResult = (step: SequenceStepResult): RequestResult =>
      stepResult(sequence, step, raw.get(`${step.stepId}#${step.attempt ?? 1}`));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    if (bailed || options.signal.aborted) {
      controller.abort();
    }
    try {
      const run = await runSequence(sequence, context.project, sender, {
        signal: controller.signal,
        onStepDone: (step) => options.onStepDone(toResult(step)),
        ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
        // Steps are looked up in the registry the sender sends through.
        ...(context.registry !== undefined ? { registry: context.registry } : {}),
        containsKnownSecret: options.containsKnownSecret,
        captures: options.captures,
        // The same scopes the step's request expands against, with the run's Sequence values.
        callbackScopes: (_step, sequenceScope) => scopesFor({ ...context, sequence: sequenceScope }),
        onCallbackWaiting: (step, waiting) =>
          options.onCallbackWaiting(`${sequence.name}/${step.index + 1}. ${step.name}`, waiting),
      });
      // The run's own list: an earlier run of a step that ran again is marked retried by now.
      results.push(...run.steps.map(toResult));
      if (options.bail && (run.outcome === 'failed' || run.outcome === 'errored')) {
        bailed = true;
      }
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }

  const count = (outcome: RequestResult['outcome']): number => results.filter((r) => r.outcome === outcome).length;
  // Inside a workspace the environment a run names is the workspace's, as for a request run (#476).
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

/**
 * One step as a request of the run: grouped by its sequence, named `<sequence>/<n>. <step>` so two steps
 * sending the same request stay apart, with the sequence, the step and the transfers alongside. A
 * second or later run of a step adds ` (attempt k)`; a run a later one superseded (#347) is reported
 * as skipped and `retried`, keeping what it found, so only the last run of a step counts.
 */
function stepResult(
  sequence: SequenceDef,
  step: SequenceStepResult,
  raw: SentRequest['raw'] | undefined,
): RequestResult {
  if (step.protocol === undefined) {
    // `resolveSteps` refused the run before any send for a step without a request.
    throw new Error(`step ${step.stepId} has no request`);
  }
  const name = `${step.index + 1}. ${step.name}${step.attempt !== undefined ? ` (attempt ${step.attempt})` : ''}`;
  const retried = step.retried === true;
  return {
    path: `${sequence.name}/${name}`,
    group: sequence.name,
    name,
    protocol: step.protocol,
    outcome: retried ? 'skipped' : step.outcome,
    ...(step.status !== undefined ? { status: step.status } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    assertions: step.assertions,
    ...(step.error !== undefined ? { error: step.error } : {}),
    unasserted: !retried && step.outcome !== 'skipped' && step.assertions.length === 0,
    ...(!retried && raw !== undefined && (step.outcome === 'failed' || step.outcome === 'errored')
      ? { exchange: cappedExchange(raw) }
      : {}),
    sequence: { id: sequence.id, name: sequence.name, stepId: step.stepId },
    transfers: step.transfers,
    ...(step.origin !== undefined ? { origin: step.origin } : {}),
    ...(step.attempt !== undefined ? { attempt: step.attempt } : {}),
    ...(retried ? { retried: true as const } : {}),
    ...(step.branch !== undefined ? { branch: step.branch } : {}),
    ...(step.scriptLog !== undefined ? { scriptLog: step.scriptLog } : {}),
    ...(step.scriptsOff === true ? { scriptsOff: true } : {}),
  };
}

/** What a run covers: its environment, the requests to send, and the sequences when it runs sequences. */
export interface SuiteSelection {
  readonly environment?: Environment | WorkspaceEnvironment;
  /** The requests to send: the selection's, or every request the sequences' steps name. */
  readonly selected: readonly SelectedRequest[];
  /** Set when the run is of sequences. */
  readonly sequences?: readonly SequenceDef[];
}

/** What {@link selectSuite} picks by: the names `wirebench run` takes as `--env`, selectors and `--sequence`. */
export interface SuiteSelectors {
  readonly environment?: string;
  readonly select: readonly string[];
  readonly sequences?: readonly string[];
}

/**
 * The environment and the requests a run covers. Inside a workspace the environment is the workspace's,
 * as in the app. Everything that would make the run test nothing is refused before any send.
 *
 * @throws WirebenchError `environment-required`, `environment-not-found`, `environment-out-of-scope`,
 *   `sequence-not-found`, `sequence-cannot-run`, `selector-unmatched` or `nothing-to-run`
 */
export function selectSuite(
  project: Project,
  workspace: RunWorkspace | undefined,
  selectors: SuiteSelectors,
  registry?: ProtocolRegistry,
): SuiteSelection {
  const environment =
    workspace === undefined
      ? pickEnvironment(project.environments, 'project', selectors.environment)
      : pickEnvironment(workspace.workspace.environments, 'workspace', selectors.environment, projectIdOf(workspace));
  const at = environment !== undefined ? { environment } : {};
  if (selectors.sequences !== undefined && selectors.sequences.length > 0) {
    const sequences = selectSequences(project, selectors.sequences);
    return { ...at, selected: resolveSteps(project, sequences, registry), sequences };
  }
  const { selected, unmatched } = selectRequests(project, selectors.select, registry);
  if (unmatched.length > 0) {
    throw new WirebenchError('selector-unmatched', `selector matched nothing: ${unmatched.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new WirebenchError('nothing-to-run', 'nothing to run: the project has no requests');
  }
  return { ...at, selected };
}

/** Options for {@link runSuite}: the run's shape as `wirebench run`'s flags give it. */
export interface RunSuiteOptions {
  readonly selection: SuiteSelection;
  /** The iterations, from `planIterations`: one without data for a plain run. */
  readonly plan: readonly Iteration[];
  readonly bail: boolean;
  readonly requireAssertions: boolean;
  /** `--sla`: the response-time limit for a request or step that declares none. */
  readonly slaMs?: number;
  /** `--delay`: waited before each send, and between iterations. */
  readonly delayMs?: number;
  /** Compare responses to the golden files (request runs only). */
  readonly baseline?: RunOptions['baseline'];
  /** Rewrite the golden files (request runs only); the CLI's one write. */
  readonly updateBaseline?: RunOptions['updateBaseline'];
  /** Each request or step as it finishes, tagged with its iteration. Raw: the host masks it. */
  readonly onRequestDone?: (result: RequestResult) => void;
  /** Where callback assertions read captures. */
  readonly captures: CaptureSource;
  readonly onCallbackWaiting?: (path: string, waiting: readonly CallbackWaiting[]) => void;
  /** Whether a value holds a credential the run already knows. */
  readonly containsKnownSecret: (value: string) => boolean;
  /** A value a script made secret: every mask built after this must hide it. */
  readonly onSecretValue: (value: string) => void;
}

/**
 * How a run ended: it ran, or its scripts were refused before anything was sent (a wrong path fails
 * the run up front, the same way in CI as in the app, #63). Errors are raw: the host masks them.
 */
export type SuiteOutcome =
  | { readonly kind: 'ran'; readonly result: RunResult }
  | { readonly kind: 'scripts-refused'; readonly errors: readonly WirebenchError[] };

/**
 * Runs a selection the way `wirebench run` does: every script checked first, then each iteration of the
 * plan in turn through one sender and one pacer, so a definition loads once, an OAuth2 token is shared
 * and the delay holds between iterations too (#336). `context` is everything but the scripting, which
 * the suite owns and disposes; its `signal` stops the run, marking what is left skipped.
 */
export async function runSuite(
  context: Omit<RunContext, 'scripting'>,
  options: RunSuiteOptions,
): Promise<SuiteOutcome> {
  const { selection } = options;
  const signal = context.signal ?? new AbortController().signal;
  const sandbox = createScriptSandbox();
  const checker = createScriptChecker();
  const run: RunContext = {
    ...context,
    signal,
    scripting: new RequestScripting({ sandbox, checker, onSecretValue: options.onSecretValue }),
  };
  try {
    const scriptErrors = await checkRunScripts(selection.selected, run);
    if (scriptErrors.length > 0) {
      return { kind: 'scripts-refused', errors: scriptErrors };
    }
    const send = createRunSender(run);
    const pace = createPacer(options.delayMs, signal);
    const onCallbackWaiting = options.onCallbackWaiting ?? ((): void => undefined);
    const once = (iteration: Iteration): Promise<RunResult> => {
      const iterated = iterationContext(run, iteration);
      const done = (request: RequestResult): void => options.onRequestDone?.(tagIteration(request, iteration));
      return selection.sequences !== undefined
        ? runSequences(selection.sequences, iterated, {
            bail: options.bail,
            requireAssertions: options.requireAssertions,
            ...(options.slaMs !== undefined ? { slaMs: options.slaMs } : {}),
            signal,
            onStepDone: done,
            containsKnownSecret: options.containsKnownSecret,
            captures: options.captures,
            onCallbackWaiting,
            send,
            pace,
          })
        : runRequests(selection.selected, iterated, {
            bail: options.bail,
            // An API or folder run: its scripts may steer it (#335).
            runControl: true,
            ...(options.slaMs !== undefined ? { defaultSlaMs: options.slaMs } : {}),
            requireAssertions: options.requireAssertions,
            ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
            ...(options.updateBaseline !== undefined ? { updateBaseline: options.updateBaseline } : {}),
            onRequestDone: done,
            captures: options.captures,
            onCallbackWaiting,
            send,
            pace,
          });
    };
    return { kind: 'ran', result: await runIterations(options.plan, once, { bail: options.bail, signal }) };
  } finally {
    await Promise.all([sandbox.dispose(), checker.dispose()]);
  }
}
