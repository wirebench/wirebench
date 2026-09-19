import type { AssertionResult, RequestResult, RunResult } from '@wirebench/engine';

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
 *   - `assertions[]`: `{ type, label, outcome, expected?, actual?, message? }`, in order.
 *   - `error`: `{ code, message, details? }`, present only for an errored request.
 *   - `exchange`: `{ request, response }`, present only for a failed or errored request.
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
  readonly protocol: 'soap' | 'rest';
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
}

function toReportRequest(result: RequestResult): JsonReportRequest {
  const { path, group, name, protocol, outcome, status, durationMs, unasserted, assertions, error, exchange } = result;
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
    ...(error !== undefined ? { error } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
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
