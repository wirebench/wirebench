import {
  activeScripts,
  cappedExchange,
  createRunSender,
  errorOf,
  findStepRequest,
  runSequence,
  scopesFor,
  sequenceFilePath,
} from '@wirebench/engine';
import type {
  CallbackWaiting,
  CaptureSource,
  Project,
  RequestResult,
  RunContext,
  RunResult,
  SelectedRequest,
  SentRequest,
  SequenceDef,
  SequenceStepResult,
  SequenceStepSender,
  StepAssertion,
} from '@wirebench/engine';
import { UsageError } from '../args.js';

function normalise(selector: string): string {
  return selector.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The sequences `selectors` name, in the order given: each selector is a sequence's name or its file
 * path (`sequences/<slug>.sequence.yaml`). A selector naming nothing is a usage error, as for requests:
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
    throw new UsageError(
      `--sequence matched nothing: ${unmatched.join(', ')}${names !== '' ? `; sequences: ${names}` : '; the project has none'}`,
    );
  }
  return selected;
}

/**
 * Every step's request, resolved before anything is sent. A step whose request is missing or cannot
 * run refuses the whole run with a usage error naming it, so a report never has a step it cannot say
 * the protocol of, and a broken sequence fails loudly rather than as a red step.
 */
export function resolveSteps(project: Project, sequences: readonly SequenceDef[]): SelectedRequest[] {
  const problems: string[] = [];
  const requests = new Map<string, SelectedRequest>();
  for (const sequence of sequences) {
    for (const [index, step] of sequence.steps.entries()) {
      const target = findStepRequest(project, step.requestId);
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
    throw new UsageError(`a sequence cannot run:\n  ${problems.join('\n  ')}`);
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
  const send = createRunSender(context);
  const results: RequestResult[] = [];
  let bailed = false;

  for (const original of sequences) {
    const sequence = withDefaultSla(original, context.project, options.slaMs);
    // Kept per step for the report: the raw exchange of a failed or errored step.
    const raw = new Map<string, SentRequest['raw']>();
    const sender: SequenceStepSender = async (step, sequenceScope) => {
      // A post-response script's tests count as the step's assertions (#63).
      // A WebSocket request has no scripts of its own.
      const { request } = step.selected;
      const declared =
        (step.step.requestAssertions && 'assertions' in request ? (request.assertions ?? []).length : 0) +
        step.step.assertions.length +
        ('scripts' in request && activeScripts(request.scripts)?.post !== undefined ? 1 : 0);
      if (options.requireAssertions && declared === 0) {
        return { error: { code: 'assertions-required', message: 'This step has no assertions.' } };
      }
      try {
        const sent = await send(step.selected, {
          sequence: sequenceScope,
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        });
        raw.set(step.step.id, sent.raw);
        return {
          subject: sent.subject,
          ...(sent.origin !== undefined ? { origin: sent.origin } : {}),
          ...(sent.script !== undefined ? { script: sent.script } : {}),
          ...(sent.scriptsOff === true ? { scriptsOff: true } : {}),
        };
      } catch (error) {
        return { error: errorOf(error) };
      }
    };
    const toResult = (step: SequenceStepResult): RequestResult => stepResult(sequence, step, raw.get(step.stepId));
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
      results.push(...run.steps.map(toResult));
      if (options.bail && (run.outcome === 'failed' || run.outcome === 'errored')) {
        bailed = true;
      }
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  }

  const count = (outcome: RequestResult['outcome']): number => results.filter((r) => r.outcome === outcome).length;
  const environment = context.project.environments.find((e) => e.id === context.environmentId)?.name;
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
 * sending the same request stay apart, with the sequence, the step and the transfers alongside.
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
  const name = `${step.index + 1}. ${step.name}`;
  return {
    path: `${sequence.name}/${name}`,
    group: sequence.name,
    name,
    protocol: step.protocol,
    outcome: step.outcome,
    ...(step.status !== undefined ? { status: step.status } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    assertions: step.assertions,
    ...(step.error !== undefined ? { error: step.error } : {}),
    unasserted: step.outcome !== 'skipped' && step.assertions.length === 0,
    ...(raw !== undefined && (step.outcome === 'failed' || step.outcome === 'errored')
      ? { exchange: cappedExchange(raw) }
      : {}),
    sequence: { id: sequence.id, name: sequence.name, stepId: step.stepId },
    transfers: step.transfers,
    ...(step.origin !== undefined ? { origin: step.origin } : {}),
    ...(step.scriptLog !== undefined ? { scriptLog: step.scriptLog } : {}),
    ...(step.scriptsOff === true ? { scriptsOff: true } : {}),
  };
}
