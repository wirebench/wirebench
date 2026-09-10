import { useProblemsStore } from '../../state/problems.js';

/**
 * A minimal list of import/schema problems. Placeholder for the full Problems view (Task 42):
 * no grouping, filtering, or click-to-navigate yet — just the flat list so problems raised by
 * an import are visible somewhere.
 */
export function ProblemsView() {
  const items = useProblemsStore((state) => state.items);

  if (items.length === 0) {
    return <p className="text-sm text-fg-subtle">No problems found.</p>;
  }

  return (
    <ul aria-label="Problems" className="flex flex-col gap-1 text-sm">
      {items.map(({ groupId, problem }, index) => (
        <li key={`${groupId}:${String(index)}`} className="flex items-start gap-2">
          <span className="shrink-0 font-mono text-xs text-fg-subtle">{problem.source}</span>
          <span className="text-fg-default">{problem.message}</span>
          {problem.location !== undefined && <span className="text-xs text-fg-subtle">({problem.location})</span>}
        </li>
      ))}
    </ul>
  );
}
