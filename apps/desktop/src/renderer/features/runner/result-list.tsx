/**
 * A run's results, one row per request with its checks, grouped by iteration: the Runner tab's (#336)
 * and a scheduled run's (#517). Everything shown arrived from main masked.
 */
import type { ReactNode } from 'react';
import type { RunnerRequestResult } from '../../../shared/runner-wire.js';

export const OUTCOME_TONE: Record<RunnerRequestResult['outcome'], string> = {
  passed: 'text-status-success',
  failed: 'text-status-danger',
  errored: 'text-status-danger',
  skipped: 'text-fg-subtle',
};

export const OUTCOME_MARK: Record<RunnerRequestResult['outcome'], string> = {
  passed: '✓',
  failed: '✗',
  errored: '!',
  skipped: '–',
};

/** How one result's mark reads: the glyph, its colour, and what it means in words. */
export interface ResultMark {
  readonly mark: string;
  readonly tone: string;
  readonly label: string;
}

/**
 * The mark a request's result shows. A request that "passed" with nothing checked only got an answer,
 * so it is not given the green tick a check earns (#560): a neutral mark when the status was fine, and
 * an amber one when the server answered 4xx or 5xx, which nothing caught.
 */
export function resultMark(result: Pick<RunnerRequestResult, 'outcome' | 'status' | 'assertions'>): ResultMark {
  if (result.outcome === 'passed' && result.assertions.length === 0) {
    if (result.status !== undefined && result.status >= 400) {
      return { mark: '!', tone: 'text-status-warning', label: `No checks, and the status was ${result.status}` };
    }
    return { mark: '○', tone: 'text-fg-subtle', label: 'No checks: the request was sent, nothing was tested' };
  }
  return { mark: OUTCOME_MARK[result.outcome], tone: OUTCOME_TONE[result.outcome], label: result.outcome };
}

export interface ResultRowProps<T extends RunnerRequestResult> {
  readonly result: T;
  /** More to show under the row's checks, such as a scheduled run's stored exchange. */
  readonly extra?: (result: T) => ReactNode;
}

export function ResultRow<T extends RunnerRequestResult>({ result, extra }: ResultRowProps<T>) {
  const failedChecks = result.assertions.filter((assertion) => assertion.outcome !== 'passed');
  const passedChecks = result.assertions.filter((assertion) => assertion.outcome === 'passed');
  const more = extra?.(result);
  const details =
    result.assertions.length > 0 ||
    result.error !== undefined ||
    (result.scriptLog?.length ?? 0) > 0 ||
    (more !== undefined && more !== null);
  const mark = resultMark(result);
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <span
        data-testid="runner-result-mark"
        role="img"
        aria-label={mark.label}
        title={mark.label}
        className={`w-4 shrink-0 text-center ${mark.tone}`}
      >
        {mark.mark}
      </span>
      <span className="truncate text-fg-default">{result.path}</span>
      {result.status !== undefined && <span className="text-fg-muted">{result.status}</span>}
      {result.durationMs !== undefined && <span className="text-fg-subtle">{Math.round(result.durationMs)} ms</span>}
    </span>
  );
  return (
    <li data-testid="runner-result" data-outcome={result.outcome} className="px-2 py-1 text-sm">
      {details ? (
        <details open={result.outcome === 'failed' || result.outcome === 'errored'}>
          <summary className="cursor-pointer">{summary}</summary>
          <div className="mt-1 ml-6 flex flex-col gap-0.5">
            {result.error !== undefined && (
              <p data-testid="runner-result-error" className="text-status-danger">
                {result.error.code}: {result.error.message}
              </p>
            )}
            {[...failedChecks, ...passedChecks].map((assertion, index) => (
              <p
                key={index}
                data-testid="runner-result-assertion"
                data-outcome={assertion.outcome}
                className={OUTCOME_TONE[assertion.outcome]}
              >
                {OUTCOME_MARK[assertion.outcome]} {assertion.label}
                {assertion.outcome !== 'passed' &&
                  (assertion.expected !== undefined || assertion.actual !== undefined
                    ? ` — expected ${assertion.expected ?? ''}, actual ${assertion.actual ?? ''}`
                    : assertion.message !== undefined
                      ? ` — ${assertion.message}`
                      : '')}
              </p>
            ))}
            {result.scriptLog?.map((line, index) => (
              <p key={`l${index}`} className="font-mono text-xs text-fg-muted">
                {line}
              </p>
            ))}
            {more}
          </div>
        </details>
      ) : (
        summary
      )}
    </li>
  );
}

/** The results, grouped by iteration when the run had more than one or read data. */
export function Results<T extends RunnerRequestResult>({
  requests,
  extra,
}: {
  readonly requests: readonly T[];
  readonly extra?: (result: T) => ReactNode;
}) {
  const groups = new Map<number, T[]>();
  for (const request of requests) {
    const index = request.iteration?.index ?? 0;
    groups.set(index, [...(groups.get(index) ?? []), request]);
  }
  return (
    <div data-testid="runner-results" className="flex flex-col gap-1">
      {[...groups.entries()].map(([index, group]) => {
        const iteration = group[0]?.iteration;
        return (
          <section key={index} data-testid="runner-iteration" aria-label={`Iteration ${index + 1}`}>
            {iteration !== undefined && (
              <h4 className="px-2 pt-1 text-xs font-medium text-fg-muted">
                Iteration {iteration.index + 1}/{iteration.count}
                {iteration.row !== undefined ? ` (row ${iteration.row + 1})` : ''}
              </h4>
            )}
            <ul>
              {group.map((result, position) => (
                <ResultRow key={position} result={result} {...(extra !== undefined ? { extra } : {})} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
