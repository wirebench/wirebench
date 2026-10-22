/**
 * Running a sequence: the loop, the transfers and the assertions, with the same semantics wherever it
 * runs. Sending stays with the host (the CLI through `createRunSender`, the desktop through its own send
 * paths and History), because the two send with different secrets, auth flows and cookie jars.
 *
 * Values lifted from responses reach the next step only through the `sequence` scope the host passes to
 * its expanders, where ADR-0015's rules apply: literal, explicit, escaped, never the origin.
 */

import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { AssertionResult, AssertionSubject, StepAssertion } from '../assert/model.js';
import { isWirebenchError } from '../errors.js';
import type { PropertyMap, Project } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import { featureDisabled } from '../protocol/registry.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocol/default-registry.js';
import { findStepRequest } from '../run/select.js';
import type { SelectedRequest } from '../run/select.js';
import { SEQUENCE_LIMITS } from './model.js';
import type { SequenceDef, SequenceStep } from './model.js';
import { chooseBranch, pause } from './branch.js';
import type { BranchDecision } from './branch.js';
import { extractTransfer } from './transfer.js';
import { mergeScriptValues, scriptAssertions, type SentScripts } from '../run/script-support.js';

/** How one step, or a run, ended. The runner's own outcomes, with `skipped` for a step never sent. */
export type SequenceOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

/** What the host needs to send one step. */
export interface ResolvedStep {
  readonly index: number;
  readonly step: SequenceStep;
  readonly selected: SelectedRequest;
  /** The sequence's `stepTimeoutMs`, when set: it overrides the request's own timeout. */
  readonly timeoutMs?: number;
  /** Which run of this step this is in the run, from 1: a branch may run a step again (#347). */
  readonly attempt: number;
}

/** A step the host sent: the response as assertions see it, and where it went. */
export interface SequenceStepSent {
  readonly subject: AssertionSubject;
  /** The origin the request went to, for the run panel and the reports. */
  readonly origin?: string;
  /** What the step request's scripts produced (#63): tests, values for later steps, a log. */
  readonly script?: SentScripts;
  /** True when the step's request has scripts and they are switched off. */
  readonly scriptsOff?: boolean;
  /** Checks the protocol made of the response itself: a GraphQL request's errors (#77). */
  readonly checks?: readonly AssertionResult[];
}

/** A step the host could not send. */
export interface SequenceStepNotSent {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * Sends one step's request with `sequenceScope` as the `${#Sequence#…}` values, and describes the
 * response. May throw; a throw becomes an errored step.
 */
export type SequenceStepSender = (
  step: ResolvedStep,
  sequenceScope: PropertyMap,
  signal: AbortSignal,
) => Promise<SequenceStepSent | SequenceStepNotSent>;

/** What one transfer did. A secret value is never carried here, so it cannot reach a report or the UI. */
export interface TransferResult {
  readonly name: string;
  readonly outcome: 'set' | 'missing' | 'errored';
  readonly secret: boolean;
  readonly value?: string;
  readonly message?: string;
}

/** One step's result. */
export interface SequenceStepResult {
  readonly index: number;
  readonly stepId: string;
  readonly requestId: string;
  readonly name: string;
  readonly protocol?: SelectedRequest['kind'];
  readonly outcome: SequenceOutcome;
  readonly status?: number;
  readonly durationMs?: number;
  readonly origin?: string;
  readonly assertions: readonly AssertionResult[];
  readonly transfers: readonly TransferResult[];
  readonly error?: { readonly code: string; readonly message: string };
  /** Why a `skipped` step was not sent; `branch` when a go-to or skip-next passed over it. */
  readonly skipped?: 'disabled' | 'after-failure' | 'cancelled' | 'branch';
  /** Which run of this step this is, from 2; absent for its first. */
  readonly attempt?: number;
  /** A later run of this step superseded this one, so it does not count towards the run's outcome. */
  readonly retried?: true;
  /** What the step's branches did: the rule that fired, or one that matched at its limit (#347). */
  readonly branch?: StepBranch;
  /** What the step request's scripts logged. NOT yet redacted. */
  readonly scriptLog?: readonly string[];
  /** True when the step's request has scripts and they are switched off. */
  readonly scriptsOff?: boolean;
}

/** A step's branch decision, with where it went. */
export interface StepBranch extends BranchDecision {
  /** The step a `goto` or `repeat` continues at. */
  readonly to?: { readonly index: number; readonly stepId: string; readonly name: string };
}

/** A whole run's result. */
export interface SequenceRunResult {
  readonly sequenceId: string;
  readonly name: string;
  readonly startedAt: string;
  readonly outcome: SequenceOutcome;
  readonly steps: readonly SequenceStepResult[];
}

/** Which step waits: for the run panel's waiting row and the CLI's waiting line. */
export interface CallbackStep {
  readonly index: number;
  readonly stepId: string;
  readonly name: string;
}

/** Options for {@link runSequence}. */
export interface RunSequenceOptions {
  readonly signal?: AbortSignal;
  /** Called as each step ends, in order, skipped steps included. */
  readonly onStepDone?: (result: SequenceStepResult) => void;
  /** Called with every value that is to be masked from here on, as soon as it is extracted. */
  readonly onSecretValue?: (value: string) => void;
  /** Whether `value` contains a credential the host already knows; such a value is treated as secret. */
  readonly containsKnownSecret?: (value: string) => boolean;
  /** Injectable clock for `startedAt`. */
  readonly now?: () => Date;
  /** Where callback assertions read captures (callback-assertion §2.2). */
  readonly captures?: CaptureSource;
  /** The clock callback waits poll by; a test seam. */
  readonly callbackClock?: CallbackClock;
  /** A test seam; `CALLBACK_LIMITS.pollIntervalMs` by default. */
  readonly callbackPollMs?: number;
  /**
   * The scopes a step's callback values expand against: the host's own for that request, with
   * `sequence` set. Absent: the Sequence values alone.
   */
  readonly callbackScopes?: (step: ResolvedStep, sequenceScope: PropertyMap) => PropertyScopes;
  /** Called after a step's send when it has callbacks to wait for. */
  readonly onCallbackWaiting?: (step: CallbackStep, waiting: readonly CallbackWaiting[]) => void;
  /**
   * The protocol modules a step's request is looked up in. Absent: the built-in ones. A host that
   * sends with `createRunSender` passes the registry of its `RunContext` here too.
   */
  readonly registry?: ProtocolRegistry;
}

/** Carries a step the host could not send out of `sendAwaitingCallbacks`, so no wait follows it. */
class NotSent extends Error {
  constructor(readonly failure: SequenceStepNotSent) {
    super(failure.error.message);
  }
}

const RANK: Record<SequenceOutcome, number> = { skipped: 0, passed: 1, failed: 2, errored: 3 };

function worst(outcomes: readonly SequenceOutcome[]): SequenceOutcome {
  return outcomes.reduce<SequenceOutcome>((a, b) => (RANK[b] > RANK[a] ? b : a), 'skipped');
}

function stepName(step: SequenceStep, selected: SelectedRequest | undefined): string {
  return step.name ?? selected?.request.name ?? step.requestId;
}

function requestAssertionsOf(selected: SelectedRequest): readonly StepAssertion[] {
  return ('assertions' in selected.request ? selected.request.assertions : undefined) ?? [];
}

/** The fields every result of one step shares, sent or not. */
interface StepBase {
  readonly index: number;
  readonly stepId: string;
  readonly requestId: string;
  readonly name: string;
  readonly protocol?: SelectedRequest['kind'];
  readonly assertions: readonly AssertionResult[];
  readonly transfers: readonly TransferResult[];
}

/** One run of one step: its result, and the response its branches look at (none when it was not sent). */
interface StepRun {
  readonly result: SequenceStepResult;
  readonly subject?: AssertionSubject;
}

/**
 * Sends one step and evaluates it: transfers into `values`, then the assertions. Never throws: a
 * missing or unsupported request, a refused or throwing send, is an errored result.
 */
async function runStep(
  step: SequenceStep,
  index: number,
  attempt: number,
  target: ReturnType<typeof findStepRequest>,
  base: StepBase,
  values: Map<string, string>,
  sequence: SequenceDef,
  send: SequenceStepSender,
  signal: AbortSignal,
  options: RunSequenceOptions,
): Promise<StepRun> {
  if (target.kind === 'missing') {
    return {
      result: {
        ...base,
        outcome: 'errored',
        error: { code: 'sequence-step-missing-request', message: `The request ${step.requestId} no longer exists` },
      },
    };
  }
  if (target.kind === 'unsupported') {
    return {
      result: { ...base, outcome: 'errored', error: { code: 'sequence-step-unsupported', message: target.reason } },
    };
  }

  const resolved: ResolvedStep = {
    index,
    step,
    selected: target.selected,
    attempt,
    ...(sequence.settings.stepTimeoutMs !== undefined ? { timeoutMs: sequence.settings.stepTimeoutMs } : {}),
  };
  const sequenceScope = Object.fromEntries(values);
  const stepAssertions: readonly StepAssertion[] = [
    ...(step.requestAssertions ? requestAssertionsOf(target.selected) : []),
    ...step.assertions,
  ];
  let sent: SequenceStepSent | SequenceStepNotSent;
  let callbacks: AssertionResult[] = [];
  try {
    // The cursor is taken inside this helper, before the send (§2.3 step 1).
    const awaited = await sendAwaitingCallbacks(
      stepAssertions,
      () =>
        options.callbackScopes?.(resolved, sequenceScope) ?? {
          project: {},
          global: {},
          system: {},
          sequence: sequenceScope,
        },
      async () => {
        const result = await send(resolved, sequenceScope, signal);
        if ('error' in result) throw new NotSent(result);
        return result;
      },
      {
        ...(options.captures !== undefined ? { captures: options.captures } : {}),
        ...(options.callbackClock !== undefined ? { clock: options.callbackClock } : {}),
        ...(options.callbackPollMs !== undefined ? { pollIntervalMs: options.callbackPollMs } : {}),
        signal,
        onWaiting: (waiting) => options.onCallbackWaiting?.({ index, stepId: step.id, name: base.name }, waiting),
      },
    );
    sent = awaited.sent;
    callbacks = awaited.callbacks;
  } catch (error) {
    sent =
      error instanceof NotSent
        ? error.failure
        : {
            error: {
              code: isWirebenchError(error) ? error.code : 'internal-error',
              message: error instanceof Error ? error.message : String(error),
            },
          };
  }
  if ('error' in sent) {
    return { result: { ...base, outcome: 'errored', error: sent.error } };
  }

  const { subject, script } = sent;
  // A script's values join the run's before the step's own transfers, which win on a clash (#63).
  mergeScriptValues(values, script?.values ?? [], options.onSecretValue, options.containsKnownSecret);
  const transfers: TransferResult[] = [];
  let transferError: { code: string; message: string } | undefined;
  for (const transfer of step.transfers) {
    const found = await extractTransfer(subject, transfer);
    if (found.kind === 'value') {
      const secret = transfer.secret === true || options.containsKnownSecret?.(found.value) === true;
      if (secret) {
        options.onSecretValue?.(found.value);
      }
      values.set(transfer.name, found.value);
      transfers.push({ name: transfer.name, outcome: 'set', secret, ...(secret ? {} : { value: found.value }) });
      continue;
    }
    const secret = transfer.secret === true;
    if (found.kind === 'missing') {
      transfers.push({ name: transfer.name, outcome: 'missing', secret });
      if (transfer.optional !== true) {
        transferError ??= {
          code: 'sequence-transfer-missing',
          message: `${transfer.name}: the response had nothing there`,
        };
      }
      continue;
    }
    transfers.push({ name: transfer.name, outcome: 'errored', secret, message: found.message });
    transferError ??= { code: found.code, message: `${transfer.name}: ${found.message}` };
  }

  const immediate = await evaluateAssertions(
    subject,
    stepAssertions.filter((assertion) => !isCallbackAssertion(assertion)),
  );
  const assertions = [...immediate, ...callbacks, ...(sent.checks ?? []), ...scriptAssertions(script?.tests ?? [])];
  transferError ??= script?.error;
  const outcome: SequenceOutcome =
    transferError !== undefined || assertions.some((a) => a.outcome === 'errored')
      ? 'errored'
      : assertions.some((a) => a.outcome === 'failed')
        ? 'failed'
        : 'passed';
  return {
    subject,
    result: {
      ...base,
      outcome,
      status: subject.status,
      durationMs: subject.durationMs,
      ...(sent.origin !== undefined ? { origin: sent.origin } : {}),
      assertions,
      transfers,
      ...(transferError !== undefined ? { error: transferError } : {}),
      ...(script !== undefined && script.log.lines.length > 0 ? { scriptLog: script.log.lines } : {}),
      ...(sent.scriptsOff === true ? { scriptsOff: true } : {}),
    },
  };
}

/**
 * Runs `sequence` against `project`, sending each step through `send`. Never throws: every failure,
 * a throwing sender included, is an errored step. A step after an abort, after a failure under
 * `stopOnFailure`, disabled, or passed over by a branch, is `skipped` and never sent.
 *
 * After each run of a step its branches choose where the run goes (#347): the same step again, a
 * step by id, or past the next one. Every loop is bounded by its rule's `max`, and the run by
 * `SEQUENCE_LIMITS.stepRuns`. Only the last run of each step counts towards the outcome.
 *
 * The one thing it throws: `feature-disabled` for `sequences` when its registry has that feature
 * off (feature switches spec §7), before any step is looked at.
 *
 * @throws WirebenchError `feature-disabled`
 */
export async function runSequence(
  sequence: SequenceDef,
  project: Project,
  send: SequenceStepSender,
  options: RunSequenceOptions = {},
): Promise<SequenceRunResult> {
  const registry = options.registry ?? defaultRegistry();
  if (!registry.features.isEnabled('sequences')) throw featureDisabled(registry.features, 'sequences');
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const signal = options.signal ?? new AbortController().signal;
  // A Map, not an object: a transfer may legitimately be named `__proto__` or `constructor`.
  const values = new Map<string, string>();
  const steps: SequenceStepResult[] = [];
  /** Where each step's latest run sits in `steps`, so a later run can mark it retried. */
  const latestRun = new Map<string, number>();
  const runsOf = new Map<string, number>();
  const fired = new Map<string, number>();
  let stepRuns = 0;
  let stopped = false;

  const report = (result: SequenceStepResult): void => {
    steps.push(result);
    options.onStepDone?.(result);
  };

  /** The fields every result of the step at `index` shares, and its request as the run finds it. */
  const baseAt = (index: number): { base: StepBase; target: ReturnType<typeof findStepRequest> } => {
    const step = sequence.steps[index]!;
    const target = findStepRequest(project, step.requestId, options.registry);
    const selected = target.kind === 'found' ? target.selected : undefined;
    return {
      target,
      base: {
        index,
        stepId: step.id,
        requestId: step.requestId,
        name: stepName(step, selected),
        ...(selected !== undefined ? { protocol: selected.kind } : {}),
        assertions: [],
        transfers: [],
      },
    };
  };
  const nameAt = (index: number): string => baseAt(index).base.name;

  /** Reports `from`..`to` (exclusive) as passed over by a branch. */
  const passOver = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      report({ ...baseAt(index).base, outcome: 'skipped', skipped: 'branch' });
    }
  };

  let cursor = 0;
  while (cursor < sequence.steps.length) {
    const index = cursor;
    const step = sequence.steps[index]!;
    const { base, target } = baseAt(index);

    const skip = signal.aborted ? 'cancelled' : stopped ? 'after-failure' : !step.enabled ? 'disabled' : undefined;
    if (skip !== undefined) {
      // A skipped step never ends the run early by itself, and never branches.
      report({ ...base, outcome: 'skipped', skipped: skip });
      cursor += 1;
      continue;
    }
    if (stepRuns >= SEQUENCE_LIMITS.stepRuns) {
      // Every rule has its own max; this bounds a long loop body, and cannot be turned off.
      report({
        ...base,
        outcome: 'errored',
        error: {
          code: 'sequence-run-limit',
          message: `The run reached ${SEQUENCE_LIMITS.stepRuns} step runs; it stopped here`,
        },
      });
      stopped = true;
      cursor += 1;
      continue;
    }
    stepRuns += 1;
    const attempt = (runsOf.get(step.id) ?? 0) + 1;
    runsOf.set(step.id, attempt);

    const ran = await runStep(step, index, attempt, target, base, values, sequence, send, signal, options);
    const branch = signal.aborted
      ? undefined
      : await chooseBranch(step, ran.subject, ran.result.outcome as 'passed' | 'failed' | 'errored', fired);
    const goes = branch !== undefined && branch.limitReached !== true ? branch : undefined;
    const rule = branch !== undefined ? step.branches?.[branch.rule] : undefined;
    // The parser refuses a goto to a step that is not in the sequence.
    const to =
      rule?.then === 'goto'
        ? sequence.steps.findIndex((candidate) => candidate.id === rule.step)
        : rule?.then === 'repeat'
          ? index
          : undefined;
    const result: SequenceStepResult = {
      ...ran.result,
      ...(attempt > 1 ? { attempt } : {}),
      // A repeat is certain to run this step again, so it is marked as it is reported.
      ...(goes?.action === 'repeat' ? { retried: true as const } : {}),
      ...(branch !== undefined
        ? {
            branch: {
              ...branch,
              ...(to !== undefined && to >= 0
                ? { to: { index: to, stepId: sequence.steps[to]!.id, name: nameAt(to) } }
                : {}),
            },
          }
        : {}),
    };
    // This run supersedes the step's previous one.
    const previous = latestRun.get(step.id);
    if (previous !== undefined && steps[previous]!.retried !== true) {
      steps[previous] = { ...steps[previous]!, retried: true };
    }
    latestRun.set(step.id, steps.length);
    report(result);

    if (goes === undefined) {
      // No branch: as before, a failure under stopOnFailure skips the rest.
      if (sequence.settings.stopOnFailure && (result.outcome === 'failed' || result.outcome === 'errored')) {
        stopped = true;
      }
      cursor += 1;
      continue;
    }
    // A branch that fires wins over stopOnFailure.
    if (rule !== undefined && rule.then !== 'skip-next' && rule.delayMs !== undefined) {
      await pause(rule.delayMs, signal);
    }
    if (goes.action === 'skip-next') {
      passOver(index + 1, Math.min(index + 2, sequence.steps.length));
      cursor = index + 2;
    } else {
      const next = to ?? index;
      passOver(index + 1, next);
      cursor = next;
    }
  }

  return {
    sequenceId: sequence.id,
    name: sequence.name,
    startedAt,
    // Only the last run of each step counts.
    outcome: worst(steps.filter((s) => s.retried !== true).map((s) => s.outcome)),
    steps,
  };
}
