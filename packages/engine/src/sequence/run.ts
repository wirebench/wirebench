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
import type { ProtocolRegistry } from '../protocol/registry.js';
import { findStepRequest } from '../run/select.js';
import type { SelectedRequest } from '../run/select.js';
import type { SequenceDef, SequenceStep } from './model.js';
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
  /** Why a `skipped` step was not sent. */
  readonly skipped?: 'disabled' | 'after-failure' | 'cancelled';
  /** What the step request's scripts logged. NOT yet redacted. */
  readonly scriptLog?: readonly string[];
  /** True when the step's request has scripts and they are switched off. */
  readonly scriptsOff?: boolean;
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
  return selected.request.assertions ?? [];
}

/**
 * Runs `sequence` against `project`, sending each step through `send`. Never throws: every failure,
 * a throwing sender included, is an errored step. A step after an abort, after a failure under
 * `stopOnFailure`, or disabled, is `skipped` and never sent.
 */
export async function runSequence(
  sequence: SequenceDef,
  project: Project,
  send: SequenceStepSender,
  options: RunSequenceOptions = {},
): Promise<SequenceRunResult> {
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const signal = options.signal ?? new AbortController().signal;
  // A Map, not an object: a transfer may legitimately be named `__proto__` or `constructor`.
  const values = new Map<string, string>();
  const steps: SequenceStepResult[] = [];
  let stopped = false;

  const finish = (result: SequenceStepResult): void => {
    steps.push(result);
    options.onStepDone?.(result);
    if (sequence.settings.stopOnFailure && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  };

  for (const [index, step] of sequence.steps.entries()) {
    const target = findStepRequest(project, step.requestId, options.registry);
    const selected = target.kind === 'found' ? target.selected : undefined;
    const base = {
      index,
      stepId: step.id,
      requestId: step.requestId,
      name: stepName(step, selected),
      ...(selected !== undefined ? { protocol: selected.kind } : {}),
      assertions: [],
      transfers: [],
    };

    const skip = signal.aborted ? 'cancelled' : stopped ? 'after-failure' : !step.enabled ? 'disabled' : undefined;
    if (skip !== undefined) {
      // A skipped step never ends the run early by itself; only a failure does.
      steps.push({ ...base, outcome: 'skipped', skipped: skip });
      options.onStepDone?.(steps[steps.length - 1]!);
      continue;
    }
    if (target.kind === 'missing') {
      finish({
        ...base,
        outcome: 'errored',
        error: { code: 'sequence-step-missing-request', message: `The request ${step.requestId} no longer exists` },
      });
      continue;
    }
    if (target.kind === 'unsupported') {
      finish({ ...base, outcome: 'errored', error: { code: 'sequence-step-unsupported', message: target.reason } });
      continue;
    }

    const resolved: ResolvedStep = {
      index,
      step,
      selected: target.selected,
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
      finish({ ...base, outcome: 'errored', error: sent.error });
      continue;
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
    const assertions = [...immediate, ...callbacks, ...scriptAssertions(script?.tests ?? [])];
    transferError ??= script?.error;
    const outcome: SequenceOutcome =
      transferError !== undefined || assertions.some((a) => a.outcome === 'errored')
        ? 'errored'
        : assertions.some((a) => a.outcome === 'failed')
          ? 'failed'
          : 'passed';
    finish({
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
    });
  }

  return {
    sequenceId: sequence.id,
    name: sequence.name,
    startedAt,
    outcome: worst(steps.map((s) => s.outcome)),
    steps,
  };
}
