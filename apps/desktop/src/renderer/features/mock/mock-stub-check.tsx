/**
 * The mock tab's check of its stubs against the contract (#325): each stub whose status, headers or
 * body the contract does not allow, by the checks a received response gets. It runs when the tab opens
 * and after every edit, and its findings also go to the Problems view.
 */
import { useEffect, useState } from 'react';
import { useProblemsStore } from '../../state/problems.js';
import type { Problem } from '../../state/problems.js';
import { ipc } from '../../state/ipc-client.js';
import type { MockCheckResponse, MockProblemWire, MockWire } from '../../../shared/wire-types.js';

type CheckState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly result: MockCheckResponse }
  | { readonly kind: 'failed'; readonly message: string };

/** Where a problem sits: `status`, `header Content-Type`, `body /items/0 3:7`. */
export function stubProblemPlace(problem: MockProblemWire): string {
  const where = [problem.in ?? 'body', problem.name, problem.path].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  const position = problem.line === undefined ? '' : ` ${String(problem.line)}:${String(problem.column ?? 1)}`;
  return `${where.join(' ')}${position}`;
}

/** The Problems group a mock's stub findings belong to. */
function problemsGroup(mockId: string): string {
  return `mock-stubs:${mockId}`;
}

function publish(mock: MockWire, result: MockCheckResponse | undefined): void {
  const store = useProblemsStore.getState();
  const groupId = problemsGroup(mock.id);
  store.clear(groupId);
  if (result === undefined) return;
  const items: Problem[] = result.findings.flatMap((finding) =>
    finding.problems.map((problem) => ({
      groupId,
      source: 'mock' as const,
      severity: 'error' as const,
      problem: {
        code: problem.code,
        message: `${mock.name} › ${finding.operationName} › ${finding.responseName}: ${problem.message}`,
        location: stubProblemPlace(problem),
      },
    })),
  );
  if (items.length > 0) store.add(items);
}

export interface MockStubCheckProps {
  readonly mock: MockWire;
  /** Shows the operation a finding belongs to. */
  readonly onSelect: (operationId: string) => void;
}

export function MockStubCheck({ mock, onSelect }: MockStubCheckProps) {
  const [state, setState] = useState<CheckState>({ kind: 'checking' });
  const [round, setRound] = useState(0);

  // `mock` is a new object after every edit, so each edit checks again; a stale answer is dropped.
  useEffect(() => {
    let current = true;
    setState({ kind: 'checking' });
    void ipc()
      .mock.check({ mockId: mock.id })
      .then((result) => {
        if (!current) return;
        setState(
          result.ok ? { kind: 'done', result: result.value } : { kind: 'failed', message: result.error.message },
        );
        publish(mock, result.ok ? result.value : undefined);
      });
    return () => {
      current = false;
    };
  }, [mock, round]);

  return (
    <div data-testid="mock-stub-check" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <p data-testid="mock-stub-check-summary" className="text-sm text-fg-muted">
          {state.kind === 'checking' && 'Checking the stubs…'}
          {state.kind === 'failed' && <span className="text-status-danger">{state.message}</span>}
          {state.kind === 'done' &&
            (state.result.findings.length === 0
              ? `All ${String(state.result.checked)} stub${state.result.checked === 1 ? '' : 's'} conform to the contract.`
              : `${String(state.result.findings.length)} of ${String(state.result.checked)} stubs do not conform to the contract.`)}
        </p>
        <button
          type="button"
          data-testid="mock-stub-check-run"
          disabled={state.kind === 'checking'}
          className="text-sm text-accent hover:underline disabled:opacity-40"
          onClick={() => setRound((n) => n + 1)}
        >
          Check again
        </button>
      </div>
      {state.kind === 'done' && state.result.findings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {state.result.findings.map((finding) => (
            <li key={finding.responseId} data-testid="mock-stub-finding" className="flex flex-col">
              <button
                type="button"
                className="flex items-center gap-2 rounded-md px-1 text-left text-sm hover:bg-surface-hover"
                onClick={() => onSelect(finding.operationId)}
              >
                <span className="w-10 shrink-0 font-mono text-xs text-fg-subtle">{finding.status}</span>
                <span className="truncate text-fg-default">
                  {finding.operationName} › {finding.responseName}
                </span>
              </button>
              <ul className="ml-12 flex flex-col">
                {finding.problems.map((problem, index) => (
                  <li key={index} className="flex gap-2 text-xs">
                    <span className="shrink-0 font-mono text-fg-subtle">{stubProblemPlace(problem)}</span>
                    <span className="text-status-danger">{problem.message}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
