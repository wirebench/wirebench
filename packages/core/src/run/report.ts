import type { AssertionResult } from '../assert/model.js';
import type { RequestResult, RunResult } from './run.js';

/**
 * The `json` report shape — the CLI's stable machine interface. Pipelines parse this, so changing
 * it after this task ships is an ask-first: bump `formatVersion` for anything but an additive field.
 *
 * - `formatVersion`: `1`. A consumer branches on it, never on field presence.
 * - `tool`: `{ name, version }` of the CLI that produced the report.
 * - `startedAt`: ISO timestamp the run began, from `RunResult.startedAt`.
 * - `environment`: the environment name the run used, when the project defines any.
 * - `summary`: `{ total, passed, failed, errored, skipped, durationMs }` for the whole run.
 * - `requests[]`: one entry per selected request —
 *   - `path`, `group`, `name`, `protocol`, `outcome` as the engine reports them.
 *   - `status`, `durationMs`: present only when the request was sent.
 *   - `unasserted`: `true` when the request declares no assertions.
 *   - `assertions[]`: `{ type, label, outcome, expected?, actual?, message?, capture? }`, in order. A
 *     `callback` assertion that matched carries `capture: { hookId, captureId }`, added without a version change.
 *   - `error`: `{ code, message, details? }`, present only for an errored request.
 *   - `exchange`: `{ request, response }`, present only for a failed or errored request.
 *   - For a sequence step only (`--sequence`), three more fields, added without a version change
 *     since a consumer of requests alone never sees them:
 *     - `sequence`: `{ id, name, stepId }`.
 *     - `transfers[]`: `{ name, outcome, secret, value?, message? }`; a secret transfer has no `value`.
 *     - `origin`: where the step's request went.
 *   - For a sequence step whose branches acted (#347), three more optional fields, also additive:
 *     - `attempt`: which run of the step this is, from 2.
 *     - `retried`: `true` when a later run of the step superseded this one; its `outcome` is then `skipped`.
 *     - `branch`: `{ rule, action, to?, count, max?, limitReached? }`, what the step's branches did.
 *   - For a request with scripts (#63), two more optional fields, also added without a version change:
 *     - `scriptLog[]`: what its scripts logged, masked like every other string.
 *     - `scriptsOff`: `true` when its scripts are switched off and none ran.
 *     - `control`: what its scripts asked of the run (#335), `{ skipped?: true, next?: string | null }`.
 *   - A script's tests appear in `assertions[]` with `type: "script"`.
 *   - For a data-driven run (#336), `iteration`: `{ index, count, row? }` (0-based; `row` is the data file's
 *     row), and `summary.iterations`: `{ planned, run }`. Both added without a version change, and absent
 *     from a run of one iteration without data.
 *
 *   - `baseline`: the `--baseline` comparison — `status`, `format?`, `changes?` (at most 100), `ignored?`,
 *     `truncated?`, `error?`. `summary.baseline`: `{ matched, differs, missing }` when the run compared baselines.
 *     With `--update-baseline` (#217) the same field carries `status` `updated`, `created`, `matched`, `skipped`,
 *     `refused` or `unsupported`, a `reason?` and the written `file?`; `summary.baselineUpdate` is
 *     `{ updated, created, matched, skipped, refused }`.
 *
 * An absent optional is omitted from the object entirely, never written as `null`.
 */
export interface JsonReport {
  readonly formatVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunResult['summary'];
  readonly requests: readonly JsonReportRequest[];
}

export interface JsonReportRequest {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  /** The request's kind: `soap`, `rest` or `grpc` for the built-in protocols. */
  readonly protocol: string;
  readonly outcome: RequestResult['outcome'];
  readonly status?: number;
  readonly durationMs?: number;
  readonly unasserted: boolean;
  readonly assertions: readonly AssertionResult[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly exchange?: { readonly request: string; readonly response: string };
  readonly sequence?: RequestResult['sequence'];
  readonly transfers?: RequestResult['transfers'];
  readonly origin?: string;
  readonly attempt?: number;
  readonly retried?: true;
  readonly branch?: RequestResult['branch'];
  readonly scriptLog?: readonly string[];
  readonly scriptsOff?: true;
  readonly control?: RequestResult['control'];
  readonly baseline?: RequestResult['baseline'];
  readonly iteration?: RequestResult['iteration'];
}

function toReportRequest(result: RequestResult): JsonReportRequest {
  const { path, group, name, protocol, outcome, status, durationMs, unasserted, assertions, error, exchange } = result;
  const { sequence, transfers, origin, scriptLog, scriptsOff, baseline, iteration, attempt, retried, branch, control } =
    result;
  return {
    path,
    group,
    name,
    protocol,
    outcome,
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    unasserted,
    assertions,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(transfers !== undefined ? { transfers } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(retried === true ? { retried: true as const } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(scriptLog !== undefined ? { scriptLog } : {}),
    ...(scriptsOff === true ? { scriptsOff: true as const } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...(control !== undefined ? { control } : {}),
  };
}

/** Builds the report object — used by `renderJson` and available to a caller that needs the value itself. */
export function toJsonReport(result: RunResult, tool: { readonly name: string; readonly version: string }): JsonReport {
  return {
    formatVersion: 1,
    tool,
    startedAt: result.startedAt,
    ...(result.environment !== undefined ? { environment: result.environment } : {}),
    summary: result.summary,
    requests: result.requests.map(toReportRequest),
  };
}

/** Renders the `json` report: the full run, pretty-printed. Pure — no I/O. */
export function renderJson(result: RunResult, tool: { readonly name: string; readonly version: string }): string {
  return `${JSON.stringify(toJsonReport(result, tool), null, 2)}\n`;
}
