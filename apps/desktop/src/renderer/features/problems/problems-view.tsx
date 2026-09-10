import { AlertTriangle, XCircle } from 'lucide-react';
import { explorerActions } from '../explorer/explorer-actions.js';
import type { Problem } from '../../state/problems.js';
import { useProblemsStore } from '../../state/problems.js';

const SOURCE_CLASS = 'shrink-0 rounded-sm border border-hairline px-1 font-mono text-xs text-fg-subtle';

function key(item: Problem, index: number): string {
  return `${item.groupId}:${String(index)}`;
}

/**
 * The Problems view: import findings and pre-send expansion warnings in one list, each tagged
 * with its source and severity. An expansion problem knows which request raised it, so clicking
 * it opens (or focuses) that request's tab — the only place the offending text can be fixed.
 */
export function ProblemsView() {
  const items = useProblemsStore((state) => state.items);

  if (items.length === 0) {
    return <p className="text-sm text-fg-subtle">No problems found.</p>;
  }

  return (
    <ul aria-label="Problems" className="flex flex-col gap-1 text-sm">
      {items.map((item, index) => {
        const { source, severity, requestId, problem } = item;
        const Icon = severity === 'warning' ? AlertTriangle : XCircle;
        const body = (
          <>
            <Icon
              size={13}
              aria-label={severity}
              className={`mt-0.5 shrink-0 ${severity === 'warning' ? 'text-status-warning' : 'text-status-danger'}`}
            />
            <span className={SOURCE_CLASS}>{problem.source ?? source}</span>
            <span className="min-w-0 flex-1 text-fg-default">{problem.message}</span>
            {problem.location !== undefined && <span className="text-xs text-fg-subtle">({problem.location})</span>}
          </>
        );

        if (source === 'expansion' && requestId !== undefined) {
          return (
            <li key={key(item, index)}>
              <button
                type="button"
                data-testid="problem-row"
                onClick={() => {
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
  );
}
