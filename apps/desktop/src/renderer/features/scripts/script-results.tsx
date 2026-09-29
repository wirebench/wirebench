/**
 * The response **Script** tab (#63): what the request's scripts did in this send — each test with
 * its outcome, a post-response script that failed, and the log. Every string arrives masked from
 * main. A request whose scripts are switched off says so, rather than showing an empty tab.
 */
import { CheckCircle2, XCircle } from 'lucide-react';
import type { ScriptResultWire } from '../../../shared/wire-types.js';

export interface ScriptResultsProps {
  readonly script: ScriptResultWire | undefined;
  readonly scriptsOff?: boolean | undefined;
}

/** The tab's badge: passed of total tests, or `!` for a script that failed. */
export function scriptResultsBadge(script: ScriptResultWire | undefined): string | undefined {
  if (script === undefined) {
    return undefined;
  }
  if (script.error !== undefined) {
    return '!';
  }
  if (script.tests.length === 0) {
    return undefined;
  }
  const passed = script.tests.filter((test) => test.passed).length;
  return `${String(passed)}/${String(script.tests.length)}`;
}

/** Whether a response has anything for the Script tab to show. */
export function hasScriptResults(summary: {
  readonly script?: unknown;
  readonly scriptsOff?: boolean | undefined;
}): boolean {
  return summary.script !== undefined || summary.scriptsOff === true;
}

/** The Script tab's body. */
export function ScriptResults({ script, scriptsOff }: ScriptResultsProps) {
  if (script === undefined) {
    return (
      <p data-testid="script-results-empty" className="p-3 text-sm text-fg-subtle">
        {scriptsOff === true
          ? 'This request has scripts, and they are switched off, so none ran.'
          : 'This request ran no scripts.'}
      </p>
    );
  }
  return (
    <div data-testid="script-results" className="flex min-h-0 flex-1 flex-col overflow-auto p-3 text-sm">
      {script.error !== undefined && (
        <p role="alert" data-testid="script-results-error" className="mb-3 text-status-danger">
          <span className="font-mono">{script.error.code}</span> — {script.error.message}
        </p>
      )}
      <h3 className="mb-1 text-xs font-semibold text-fg-subtle uppercase">Tests</h3>
      {script.tests.length === 0 ? (
        <p className="mb-3 text-fg-subtle">No tests.</p>
      ) : (
        <ul aria-label="Script tests" className="mb-3 space-y-1">
          {script.tests.map((test, index) => (
            <li key={`${String(index)}:${test.name}`} className="flex items-start gap-2">
              {test.passed ? (
                <CheckCircle2 aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-status-success" />
              ) : (
                <XCircle aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-status-danger" />
              )}
              <span>
                {test.name}
                {test.message !== undefined && <span className="block text-xs text-fg-subtle">{test.message}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mb-1 text-xs font-semibold text-fg-subtle uppercase">Log</h3>
      {script.log.length === 0 ? (
        <p className="text-fg-subtle">Nothing logged.</p>
      ) : (
        <pre data-testid="script-log" className="font-mono text-xs whitespace-pre-wrap">
          {script.log.join('\n')}
        </pre>
      )}
      {script.truncated && (
        <p className="mt-1 text-xs text-status-warning">The log reached its limit; later lines were dropped.</p>
      )}
    </div>
  );
}
