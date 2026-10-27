/**
 * The selected level of the conversion review: each phase's layered text beside its proposed
 * Wirebench script, and under it the checker's problems with the proposal. A chunk of its own, so
 * the review loads Monaco only once it opens.
 */
import { DiffXmlEditor } from '../../editor/diff-xml-editor.js';
import type { ScriptConversionWire } from '@shared/wire-base.js';

const PHASES = [
  { id: 'pre', label: 'Pre-request' },
  { id: 'post', label: 'Post-response' },
] as const;

export function ConvertScriptsDiff({ level }: { readonly level: ScriptConversionWire }) {
  const { before, result } = level;
  if (!result.ok) {
    return null;
  }
  const phases = PHASES.filter(({ id }) => before[id] !== undefined || result[id] !== undefined);
  return (
    <div className="flex flex-col gap-3">
      {phases.map(({ id, label }) => {
        const problems = result.problems[id] ?? [];
        return (
          <section key={id} data-testid={`convert-scripts-phase-${id}`} aria-label={label}>
            <h3 className="mb-1 text-sm font-medium text-fg-default">{label}</h3>
            <div className="h-56 overflow-hidden rounded border border-hairline">
              <DiffXmlEditor
                original={before[id] ?? ''}
                modified={result[id] ?? ''}
                renderSideBySide
                ignoreTrimWhitespace={false}
                language="typescript"
              />
            </div>
            {problems.length === 0 ? (
              <p className="mt-1 text-xs text-fg-subtle">No problems.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {problems.map((problem, index) => (
                  <li
                    key={index}
                    className={problem.severity === 'error' ? 'text-status-danger' : 'text-status-warning'}
                  >
                    {`Line ${String(problem.line)}: ${problem.message}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
