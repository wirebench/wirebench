import { useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { explorerActions } from '../explorer/explorer-actions.js';
import { revealProblem } from '../request-editor/validate-actions.js';
import type { Problem, ProblemSeverity } from '../../state/problems.js';
import { useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';

const SOURCE_CLASS = 'shrink-0 rounded-sm border border-hairline px-1 font-mono text-xs text-fg-subtle';

/** Which severities the list is showing; the chips toggle these. */
type Filter = 'all' | ProblemSeverity;

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
];

function key(item: Problem, index: number): string {
  return `${item.groupId}:${String(index)}`;
}

/** `line:col`, or just `line`, or nothing at all — whatever the problem actually knows. */
function locationLabel(problem: Problem['problem']): string | undefined {
  if (problem.line === undefined) {
    return problem.location;
  }
  const position = problem.column === undefined ? String(problem.line) : `${problem.line}:${problem.column}`;
  return problem.location === undefined ? position : `${problem.location} ${position}`;
}

/**
 * The Problems view: import findings, pre-send expansion warnings, failed sends and message
 * validation in one table — severity, message, source, location and the request it belongs to.
 *
 * A row that knows its request is a button: clicking it opens (or focuses) that request's tab,
 * and — for a row with a position — selects the offending line in the editor.
 */
export function ProblemsView() {
  const items = useProblemsStore((state) => state.items);
  const requests = useProjectStore((state) => state.requests);
  const [filter, setFilter] = useState<Filter>('all');

  const errors = items.filter((item) => item.severity === 'error').length;
  const visible = filter === 'all' ? items : items.filter((item) => item.severity === filter);

  if (items.length === 0) {
    return <p className="text-sm text-fg-subtle">No problems found.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Filter problems">
        {FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            data-testid={`problems-filter-${chip.id}`}
            aria-pressed={filter === chip.id}
            onClick={() => {
              setFilter(chip.id);
            }}
            className={`rounded-full border border-hairline px-2 py-0.5 text-xs ${
              filter === chip.id ? 'bg-accent-muted text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
            }`}
          >
            {chip.label}
            {chip.id === 'error' && errors > 0 ? ` (${String(errors)})` : ''}
            {chip.id === 'warning' && items.length - errors > 0 ? ` (${String(items.length - errors)})` : ''}
          </button>
        ))}
      </div>

      <ul aria-label="Problems" className="flex min-h-0 flex-col gap-1 overflow-auto text-sm">
        {visible.map((item, index) => {
          const { source, severity, requestId, problem } = item;
          const Icon = severity === 'warning' ? AlertTriangle : XCircle;
          const location = locationLabel(problem);
          const requestName = requestId === undefined ? undefined : requests[requestId]?.name;
          const body = (
            <>
              <Icon
                size={13}
                aria-label={severity}
                className={`mt-0.5 shrink-0 ${severity === 'warning' ? 'text-status-warning' : 'text-status-danger'}`}
              />
              <span className={SOURCE_CLASS}>{problem.source ?? source}</span>
              <span className="min-w-0 flex-1 text-fg-default">{problem.message}</span>
              {requestName !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{requestName}</span>}
              {location !== undefined && (
                <span data-testid="problem-location" className="shrink-0 font-mono text-xs text-fg-subtle">
                  {location}
                </span>
              )}
            </>
          );

          if (requestId !== undefined) {
            return (
              <li key={key(item, index)}>
                <button
                  type="button"
                  data-testid="problem-row"
                  onClick={() => {
                    if (source === 'validation') {
                      revealProblem(requestId, item.direction ?? 'request', problem.line, problem.column);
                      return;
                    }
                    explorerActions.openRequest(requestId);
                  }}
                  className="flex w-full items-start gap-2 rounded px-1 text-left hover:bg-surface-raised"
                >
                  {body}
                </button>
              </li>
            );
          }

          return (
            <li key={key(item, index)} data-testid="problem-row" className="flex items-start gap-2 px-1">
              {body}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
