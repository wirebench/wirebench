/**
 * The Runner (#336): a folder, an API, a project or a sequence run once per iteration, each iteration
 * reading one row of the target's data file as `${#Data#…}`. The engine owns the loops
 * (`runIterations`, `runRequests`, `runSequence`); this service resolves the target, reads the data
 * file main keeps for it, sends through the app's own send path (`desktop-send.ts`), streams each
 * request's result to the renderer, and keeps the run in the history under user data.
 *
 * Security (spec §Security, as the sequence runner's):
 * - Every string of a result is masked before it crosses to the renderer or is written to the history.
 * - A sequence step's transfer marked secret, or holding a recorded credential, is recorded for
 *   masking before that step's own log row and History entry exist.
 * - The data file's path never crosses to the renderer; a data value is never put in an error.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  createPacer,
  dataFormatOf,
  errorOf,
  extractTransfer,
  isWirebenchError,
  iterationContext,
  parseDataFile,
  planIterations,
  runIterations,
  runRequests,
  runSequence,
  tagIteration,
  unavailableCaptureSource,
  WirebenchError,
} from '@wirebench/engine';
import type {
  CaptureSource,
  DataTable,
  Iteration,
  Pacer,
  Project,
  RequestResult,
  RunContext,
  RunResult,
  SequenceDef,
  SequenceStepResult,
  SequenceStepSender,
} from '@wirebench/engine';
import { UNLINKED_WORKSPACE_MESSAGE } from '../hooks/capture-source.js';
import { containsRecordedSecret, recordSecretValue, redactSecretText } from '../redact.js';
import { toSendDeps } from '../ipc/request.js';
import { confirmProtectedSend, environmentNameOf, protectedEnvironmentOf, sendDeclined } from '../send/exchange.js';
import type {
  RunnerDataChooseResponse,
  RunnerDataFile,
  RunnerHistoryEntry,
  RunnerProgressEvent,
  RunnerRequestResult,
  RunnerRunRequest,
  RunnerRunResult,
  RunnerSettings,
  RunnerState,
} from '../../shared/runner-wire.js';
import { asRunSender, createDesktopRunSend, type DesktopRunSend, type DesktopSendDeps } from './desktop-send.js';
import type { RunnerHistoryStore, RunnerSettingsStore } from './stores.js';
import { resolveTarget, runnable, runnerRequests, type RunnerTarget } from './targets.js';

export interface RunnerDeps extends DesktopSendDeps {
  /** The open model (unsaved edits included) of the project that owns `entityId`. */
  readonly modelOf: (entityId: string) => Project | undefined;
  readonly settings: RunnerSettingsStore;
  readonly history: RunnerHistoryStore;
  /** Tells the renderer a request has ended. */
  readonly emit: (event: RunnerProgressEvent) => void;
  /** The open workspace's capture source, built per run; absent means the workspace has no server. */
  readonly captures?: () => CaptureSource;
  /** Reads a data file; `fs.readFile` by default. A test seam. */
  readonly readText?: (path: string) => Promise<string>;
}

const mask = (text: string): string => redactSecretText(text, { show: false });

/** A request's result as it may cross to the renderer and be kept: every string masked. */
export function toRunnerResult(result: RequestResult): RunnerRequestResult {
  return {
    path: mask(result.path),
    name: mask(result.name),
    protocol: result.protocol,
    outcome: result.outcome,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    assertions: result.assertions.map((assertion) => ({
      type: assertion.type,
      label: mask(assertion.label),
      outcome: assertion.outcome,
      ...(assertion.expected !== undefined ? { expected: mask(assertion.expected) } : {}),
      ...(assertion.actual !== undefined ? { actual: mask(assertion.actual) } : {}),
      ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
      ...(assertion.capture !== undefined ? { capture: assertion.capture } : {}),
    })),
    ...(result.error !== undefined ? { error: { code: result.error.code, message: mask(result.error.message) } } : {}),
    ...(result.scriptLog !== undefined ? { scriptLog: result.scriptLog.map(mask) } : {}),
    ...(result.iteration !== undefined ? { iteration: result.iteration } : {}),
  };
}

/** One sequence step as a request of the run, named `<sequence>/<n>. <step>` as the command line names it. */
function stepAsRequest(sequence: SequenceDef, step: SequenceStepResult): RequestResult {
  const name = `${String(step.index + 1)}. ${step.name}`;
  return {
    path: `${sequence.name}/${name}`,
    group: sequence.name,
    name,
    protocol: step.protocol ?? 'unknown',
    outcome: step.outcome,
    ...(step.status !== undefined ? { status: step.status } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    assertions: step.assertions,
    ...(step.error !== undefined ? { error: step.error } : {}),
    unasserted: step.outcome !== 'skipped' && step.assertions.length === 0,
    ...(step.scriptLog !== undefined ? { scriptLog: step.scriptLog } : {}),
  };
}

function summaryOf(requests: readonly RequestResult[], durationMs: number): RunResult['summary'] {
  const count = (outcome: RequestResult['outcome']): number => requests.filter((r) => r.outcome === outcome).length;
  return {
    total: requests.length,
    passed: count('passed'),
    failed: count('failed'),
    errored: count('errored'),
    skipped: count('skipped'),
    durationMs,
  };
}

/** The data file's rows. @throws WirebenchError the file's refusal, with the file's name and never a value */
async function readTable(path: string, readText: (path: string) => Promise<string>): Promise<DataTable> {
  const format = dataFormatOf(path);
  let text: string;
  try {
    text = await readText(path);
  } catch {
    throw new WirebenchError('data-file-unreadable', `The data file ${basename(path)} cannot be read`);
  }
  return parseDataFile(text, format);
}

interface ActiveRun {
  readonly targetId: string;
  readonly controller: AbortController;
}

export class RunnerService {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunnerDeps) {}

  private readText(path: string): Promise<string> {
    return (this.deps.readText ?? ((file: string) => readFile(file, 'utf8')))(path);
  }

  /** @throws WirebenchError `unknown-entity`, `runner-nothing-to-run` */
  private target(targetId: string): { project: Project; target: RunnerTarget } {
    const project = this.deps.modelOf(targetId);
    if (project === undefined) {
      throw new WirebenchError('unknown-entity', `Nothing with id "${targetId}" is open`, { details: { targetId } });
    }
    const located = this.deps.requests.project.runContextFor?.(targetId);
    const target = resolveTarget(project, targetId, located?.registry);
    if (target === undefined) {
      throw new WirebenchError('runner-nothing-to-run', 'There is nothing to run here');
    }
    return { project, target };
  }

  /** The data file as the renderer may see it: its name, columns and row count, or why it does not read. */
  private async dataFile(path: string): Promise<RunnerDataFile> {
    try {
      const table = await readTable(path, (file) => this.readText(file));
      return { name: basename(path), columns: [...table.columns], rows: table.rows.length };
    } catch (error) {
      const { code, message } = errorOf(error);
      return { name: basename(path), columns: [], rows: 0, error: { code, message: mask(message) } };
    }
  }

  /** The target, its requests in run order, its settings and its data file. */
  async state(targetId: string): Promise<RunnerState> {
    const { target } = this.target(targetId);
    const stored = await this.deps.settings.get(targetId);
    return {
      targetId,
      kind: target.kind,
      name: target.name,
      settings: stored.settings,
      requests: runnerRequests(target, stored.settings),
      ...(stored.dataPath !== undefined ? { data: await this.dataFile(stored.dataPath) } : {}),
    };
  }

  setSettings(targetId: string, settings: RunnerSettings): Promise<void> {
    return this.deps.settings.setSettings(targetId, settings);
  }

  /** Asks `pick` for a data file and keeps it for the target; the renderer is told its name only. */
  async chooseData(targetId: string, pick: () => Promise<string | undefined>): Promise<RunnerDataChooseResponse> {
    const path = await pick();
    if (path === undefined) return { cancelled: true };
    await this.deps.settings.setDataPath(targetId, path);
    return { cancelled: false, data: await this.dataFile(path) };
  }

  clearData(targetId: string): Promise<void> {
    return this.deps.settings.setDataPath(targetId, undefined);
  }

  async historyList(targetId: string): Promise<{ runs: RunnerHistoryEntry[] }> {
    return { runs: await this.deps.history.list(targetId) };
  }

  async historyGet(targetId: string, runId: string): Promise<{ run?: RunnerRunResult }> {
    const run = await this.deps.history.get(targetId, runId);
    return run !== undefined ? { run } : {};
  }

  /** Stops `runId`: the request in flight is cancelled and nothing after it runs. */
  cancel(runId: string): { cancelled: boolean } {
    const active = this.runs.get(runId);
    if (active === undefined) return { cancelled: false };
    active.controller.abort();
    return { cancelled: true };
  }

  /**
   * Runs the target to the end and resolves with every request; each is also reported through
   * `deps.emit` as it ends. A run that cannot start (an unreadable data file, nothing to run) throws
   * before anything is sent.
   *
   * @throws WirebenchError `runner-already-running`, `unknown-entity`, `runner-nothing-to-run`, a data file's code
   */
  async run(request: RunnerRunRequest): Promise<RunnerRunResult> {
    for (const active of this.runs.values()) {
      if (active.targetId === request.targetId) {
        throw new WirebenchError('runner-already-running', 'This is already running');
      }
    }
    // Held from the first moment, before any await, so a second run of the target is refused.
    const controller = new AbortController();
    this.runs.set(request.runId, { targetId: request.targetId, controller });
    try {
      return await this.runHeld(request, controller.signal);
    } finally {
      this.runs.delete(request.runId);
    }
  }

  private async runHeld(request: RunnerRunRequest, signal: AbortSignal): Promise<RunnerRunResult> {
    const { project, target } = this.target(request.targetId);
    const stored = await this.deps.settings.get(request.targetId);
    const { settings } = stored;
    const table = stored.dataPath !== undefined ? await readTable(stored.dataPath, (f) => this.readText(f)) : undefined;
    const plan = planIterations({
      ...(table !== undefined ? { rows: table.rows } : {}),
      ...(settings.iterations !== undefined ? { iterations: settings.iterations } : {}),
      overrun: settings.overrun,
    });
    const selected = target.kind === 'sequence' ? [] : runnable(target.selected, settings);
    if (target.kind !== 'sequence' && selected.length === 0) {
      throw new WirebenchError('runner-nothing-to-run', 'Every request is excluded from the run');
    }

    const located = this.deps.requests.project.runContextFor?.(request.targetId);
    // Asked once for the whole run (#345), before its first send; its sends then never ask.
    const guarded = located === undefined ? undefined : protectedEnvironmentOf(located);
    if (
      guarded !== undefined &&
      !(await confirmProtectedSend(toSendDeps(this.deps.service, this.deps.requests), [guarded]))
    ) {
      throw sendDeclined([guarded]);
    }
    const base: RunContext = {
      project,
      projectDir: located?.projectDir ?? '',
      ...(located?.environmentId !== undefined ? { environmentId: located.environmentId } : {}),
      ...(located?.workspace !== undefined ? { workspace: located.workspace } : {}),
      ...(located?.globals !== undefined ? { globals: located.globals } : {}),
      ...(located?.current !== undefined ? { current: located.current } : {}),
      ...(located?.registry !== undefined ? { registry: located.registry } : {}),
      overrides: {},
      // The run's own sender sends; this host only hears of a value to mask.
      host: { getSecret: () => Promise.resolve(undefined), onSecretValue: recordSecretValue },
      signal,
      containsKnownSecret: containsRecordedSecret,
    };
    const send = createDesktopRunSend(
      this.deps,
      request.runId,
      [`runner:${target.id}`, `run:${request.runId}`],
      signal,
    );
    const pace = createPacer(settings.delayMs, signal);
    const captures = this.deps.captures?.() ?? unavailableCaptureSource(UNLINKED_WORKSPACE_MESSAGE);
    const report = (result: RequestResult, iteration: Iteration): void => {
      this.deps.emit({
        runId: request.runId,
        targetId: request.targetId,
        request: toRunnerResult(tagIteration(result, iteration)),
      });
    };
    const once = (iteration: Iteration): Promise<RunResult> => {
      const context = iterationContext(base, iteration);
      if (target.kind === 'sequence') {
        return this.runSequenceOnce(target.sequence, project, context, send, pace, captures, (result) =>
          report(result, iteration),
        );
      }
      return runRequests(selected, context, {
        bail: settings.bail,
        send: asRunSender(send),
        pace,
        captures,
        onRequestDone: (result) => report(result, iteration),
      });
    };

    const startedAt = new Date().toISOString();
    try {
      const result = await runIterations(plan, once, { bail: settings.bail, signal });
      const environment = located !== undefined ? environmentNameOf(located) : null;
      const run: RunnerRunResult = {
        runId: request.runId,
        targetId: request.targetId,
        name: mask(target.name),
        startedAt,
        ...(environment !== null ? { environment: mask(environment) } : {}),
        ...(stored.dataPath !== undefined ? { dataFile: basename(stored.dataPath) } : {}),
        cancelled: signal.aborted,
        summary: result.summary,
        requests: result.requests.map(toRunnerResult),
      };
      try {
        await this.deps.history.add(run);
      } catch (error) {
        console.warn(`[runner] a run could not be kept: ${error instanceof Error ? error.message : String(error)}`);
      }
      return run;
    } catch (error) {
      throw isWirebenchError(error) ? error : new WirebenchError('internal-error', errorOf(error).message);
    }
  }

  /** One iteration of a sequence: its steps through the run's sender, each reported as a request. */
  private async runSequenceOnce(
    sequence: SequenceDef,
    project: Project,
    context: RunContext,
    send: DesktopRunSend,
    pace: Pacer,
    captures: CaptureSource,
    onDone: (result: RequestResult) => void,
  ): Promise<RunResult> {
    const started = performance.now();
    const stepSender: SequenceStepSender = async (resolved, sequenceScope) => {
      await pace.wait();
      try {
        const sent = await send(
          resolved.selected,
          {
            sequence: sequenceScope,
            ...(context.data !== undefined ? { data: context.data } : {}),
            ...(context.iteration !== undefined ? { iteration: context.iteration } : {}),
            ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
          },
          // Before the step's own log row and History entry exist: record what must be masked in them.
          async (exchange) => {
            for (const transfer of resolved.step.transfers) {
              const found = await extractTransfer(exchange.subject, transfer);
              if (found.kind === 'value' && (transfer.secret === true || containsRecordedSecret(found.value))) {
                recordSecretValue(found.value);
              }
            }
          },
        );
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
    const ran = await runSequence(sequence, project, stepSender, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      onStepDone: (step) => onDone(stepAsRequest(sequence, step)),
      onSecretValue: recordSecretValue,
      containsKnownSecret: containsRecordedSecret,
      captures,
      ...(context.registry !== undefined ? { registry: context.registry } : {}),
      // The scopes a step's own send expands against, plus the run's Sequence values and the row.
      callbackScopes: (resolved, sequenceScope) => ({
        ...this.deps.requests.project.scopesFor(resolved.selected.request.id),
        sequence: sequenceScope,
        ...(context.data !== undefined ? { data: context.data } : {}),
      }),
    });
    const requests = ran.steps.map((step) => stepAsRequest(sequence, step));
    return {
      startedAt: ran.startedAt,
      summary: summaryOf(requests, Math.round(performance.now() - started)),
      requests,
    };
  }
}
