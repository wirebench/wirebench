/**
 * One scheduled run, start to finish (scheduled-runs spec §3.2): the workspace head is written to a
 * private directory, loaded with the engine's loaders and run with `runSuite` — the CLI's own run —
 * under an empty system scope, the schedule's sealed secrets and one cookie jar. Everything stored
 * is masked first. The temporary directory goes in every case.
 */
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  CookieJar,
  createSecretMasker,
  dataFormatOf,
  envVariablesFor,
  isProtectedEnvironment,
  isWirebenchError,
  jarCookieHost,
  loadProject,
  loadWorkspace,
  maskRunResult,
  parseDataFile,
  planIterations,
  runSuite,
  SECRET_ENV_PREFIX,
  secretNeedsOf,
  selectSuite,
  toJsonReport,
  unavailableCaptureSource,
  workspaceProjectDir,
  type DataTable,
  type GetSecret,
  type Iteration,
  type RunResult,
  type ScheduleRunSummary,
  type ScheduleTarget,
  type SuiteSelection,
  type SyncSnapshotResponse,
  type Workspace,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, type Database, type ServerHooks } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { materialise, type Materialised } from './materialise.js';
import { RunStopped, type RunReason } from './outcome.js';
import * as repo from './repo.js';
import { openSecrets } from './seal.js';
import type { SchedulesSettings } from './settings.js';

export interface ExecutorEnv {
  readonly db: Database;
  readonly hooks: ServerHooks;
  readonly settings: SchedulesSettings;
  /** The workspace's files at its head: `CommitStore.snapshot`. */
  readonly snapshot: (workspaceId: string) => Promise<SyncSnapshotResponse>;
  /** Absolute: `<dataDir>/tmp/schedules`. */
  readonly tmpRoot: string;
  /** The server's version, for the stored report's `tool`. */
  readonly version: string;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
}

/** Why the scheduler aborted a run; the executor's own deadline is `timeout`. */
export type AbortReason = 'shutdown' | 'cancelled';

const CAPTURES_UNAVAILABLE = 'callback assertions are not available in scheduled runs yet';

/** Selection codes that mean the target names something the project no longer has. */
const SELECTION_MISSING = new Set(['environment-not-found', 'sequence-not-found', 'selector-unmatched']);

type Outcome = Omit<repo.FinishedRun, 'commit' | 'environment' | 'at'>;

/** A run that ran: a failed request fails it, else an errored one errors it. */
function statusOf(summary: RunResult['summary']): 'passed' | 'failed' | 'errored' {
  if (summary.failed > 0) return 'failed';
  return summary.errored > 0 ? 'errored' : 'passed';
}

function summaryOf(summary: RunResult['summary']): ScheduleRunSummary {
  const { total, passed, failed, errored, skipped, durationMs } = summary;
  return { total, passed, failed, errored, skipped, durationMs: Math.round(durationMs) };
}

function abortReasonOf(signal: AbortSignal): AbortReason | 'timeout' | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason === 'shutdown' || reason === 'timeout' ? reason : 'cancelled';
}

/** A run cut short: the deadline errors it, a shutdown or a cancel cancels it. */
function stoppedBy(reason: AbortReason | 'timeout'): Pick<Outcome, 'status' | 'reason'> {
  return reason === 'timeout' ? { status: 'errored', reason: 'timeout' } : { status: 'cancelled', reason };
}

/** The workspace's project the target names, by slug or id. A linked project lives off the server. */
function projectSlugOf(workspace: Workspace, wanted: string): string {
  const ref = workspace.projects.find((candidate) => candidate.slug === wanted || candidate.id === wanted);
  if (ref === undefined) throw new RunStopped('target-missing', `The workspace has no project "${wanted}".`);
  if (ref.source !== 'internal') {
    throw new RunStopped('target-invalid', `"${wanted}" is a linked project, which lives off the server.`);
  }
  return ref.slug;
}

/** The data file, read from inside the project folder only. */
async function readTable(projectDir: string, path: string): Promise<DataTable> {
  const file = resolve(projectDir, ...path.split('/'));
  if (!file.startsWith(projectDir + sep)) {
    throw new RunStopped('target-invalid', 'The data file is outside the project.');
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new RunStopped('target-missing', `The data file ${path} cannot be read.`);
  }
  try {
    return parseDataFile(text, dataFormatOf(path));
  } catch (error) {
    throw new RunStopped('target-invalid', error instanceof Error ? error.message : String(error));
  }
}

function plan(table: DataTable | undefined, data: ScheduleTarget['data'] = { path: '' }): Iteration[] {
  try {
    return planIterations({
      ...(table !== undefined ? { rows: table.rows } : {}),
      ...(data.iterations !== undefined ? { iterations: data.iterations } : {}),
      ...(data.overrun !== undefined ? { overrun: data.overrun } : {}),
    });
  } catch (error) {
    throw new RunStopped('target-invalid', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs `runId`, which the scheduler has marked running, and stores how it ended. `signal` is the
 * scheduler's, aborted with an {@link AbortReason}. A run that goes wrong is an outcome, never a throw.
 */
export async function executeRun(env: ExecutorEnv, runId: string, signal: AbortSignal): Promise<void> {
  const found = await repo.runWithSchedule(env.db, runId);
  if (found === undefined) return;
  const { schedule } = found;
  const { target, options } = schedule;

  const deadline = new AbortController();
  const timer = env.setTimer(() => deadline.abort('timeout'), options.timeoutMinutes * 60_000);
  const runSignal = AbortSignal.any([signal, deadline.signal]);
  // Every mask is built when it is used, so it hides each token the run has obtained by then.
  const known = new Set<string>();
  const mask = (text: string): string => createSecretMasker([...known])(text);
  const containsKnownSecret = (value: string): boolean => mask(value) !== value;

  let commit: string | null = null;
  let environment: string | null = null;
  let snapshot: Materialised | undefined;
  let outcome: Outcome;
  try {
    if (Object.keys(schedule.secrets).length > 0 && env.settings.secretKey === undefined) {
      throw new RunStopped('secret-key-missing');
    }
    const secrets = openSecrets(env.settings, schedule.secrets);
    for (const value of Object.values(secrets)) known.add(value);

    const head = await env.snapshot(schedule.workspaceId);
    if (head.head === null) throw new RunStopped('workspace-empty', 'The workspace has nothing pushed yet.');
    commit = head.head;
    snapshot = await materialise({
      root: env.tmpRoot,
      runId,
      files: head.files,
      maxBytes: env.settings.maxSnapshotBytes,
    });
    const { workspace } = await loadWorkspace(snapshot.dir);
    const slug = projectSlugOf(workspace, target.project);
    await snapshot.addProject(slug);
    const projectDir = workspaceProjectDir(snapshot.dir, slug);
    const { project } = await loadProject(projectDir).catch(() => {
      throw new RunStopped('target-missing', `The project "${target.project}" cannot be loaded.`);
    });
    const runWorkspace = { workspace, projectSlug: slug };
    let selection: SuiteSelection;
    try {
      selection = selectSuite(project, runWorkspace, {
        ...(target.environment !== undefined ? { environment: target.environment } : {}),
        select: target.select ?? [],
        ...(target.sequences !== undefined ? { sequences: target.sequences } : {}),
      });
    } catch (error) {
      if (!isWirebenchError(error)) throw error;
      throw new RunStopped(SELECTION_MISSING.has(error.code) ? 'target-missing' : 'target-invalid', error.message);
    }
    environment = selection.environment?.name ?? null;
    if (isProtectedEnvironment(project, selection.environment) && !options.allowProtected) {
      throw new RunStopped('environment-protected');
    }
    const table = target.data === undefined ? undefined : await readTable(projectDir, target.data.path);

    // A secret resolves from the schedule's sealed values only, under the name `WIREBENCH_SECRET_<NAME>`
    // gives it in a pipeline: the server's own environment never reaches a run.
    const needs = new Map(secretNeedsOf(selection.selected, project, {}, workspace).map((need) => [need.ref, need]));
    const getSecret: GetSecret = (ref) => {
      for (const variable of envVariablesFor(needs.get(ref) ?? { ref })) {
        const value = secrets[variable.slice(SECRET_ENV_PREFIX.length)];
        if (value !== undefined && value !== '') return Promise.resolve(value);
      }
      return Promise.resolve(undefined);
    };
    const ran = await runSuite(
      {
        project,
        projectDir,
        workspace: runWorkspace,
        ...(selection.environment !== undefined ? { environmentId: selection.environment.id } : {}),
        overrides: {},
        // The server's process environment is not the project's to read.
        system: {},
        host: {
          getSecret,
          onSecretValue: (value) => known.add(value),
          // One jar for the whole run: every request, sequence step and iteration shares it.
          cookies: jarCookieHost(new CookieJar()),
        },
        insecure: options.insecureTls,
        signal: runSignal,
        containsKnownSecret,
      },
      {
        selection,
        plan: plan(table, target.data),
        bail: options.bail,
        requireAssertions: false,
        captures: unavailableCaptureSource(CAPTURES_UNAVAILABLE),
        containsKnownSecret,
        onSecretValue: (value) => known.add(value),
      },
    );
    if (ran.kind === 'scripts-refused') throw new RunStopped('scripts-refused');
    const report = toJsonReport(maskRunResult(ran.result, mask), { name: 'wirebench-server', version: env.version });
    const aborted = abortReasonOf(runSignal);
    outcome = {
      ...(aborted === undefined ? { status: statusOf(ran.result.summary), reason: null } : stoppedBy(aborted)),
      summary: summaryOf(report.summary),
      results: report.requests,
    };
  } catch (error) {
    const aborted = abortReasonOf(runSignal);
    if (aborted !== undefined) {
      outcome = { ...stoppedBy(aborted), summary: null, results: [] };
    } else if (error instanceof RunStopped) {
      outcome = { status: 'errored', reason: error.reason, summary: null, results: [] };
    } else {
      // The stored reason is a code; only the log has the message, masked.
      env.log.error(
        { runId, message: mask(error instanceof Error ? error.message : String(error)) },
        'scheduled run failed',
      );
      outcome = { status: 'errored', reason: 'run-failed' satisfies RunReason, summary: null, results: [] };
    }
  } finally {
    timer.cancel();
    await snapshot?.dispose();
  }

  await env.db.transaction(async (tx) => {
    if (!(await repo.finishRun(tx, runId, { ...outcome, commit, environment, at: env.now() }))) return;
    const { summary } = outcome;
    await recordAudit(env.hooks, tx, {
      actor: { kind: 'system' },
      action: 'schedule.run_finished',
      target: { kind: 'schedule', id: schedule.id },
      workspaceId: schedule.workspaceId,
      details: {
        name: schedule.name,
        runId,
        trigger: found.run.trigger,
        status: outcome.status,
        reason: outcome.reason,
        commit,
        ...(summary !== null
          ? { total: summary.total, passed: summary.passed, failed: summary.failed, errored: summary.errored }
          : {}),
      },
    });
  });
}
