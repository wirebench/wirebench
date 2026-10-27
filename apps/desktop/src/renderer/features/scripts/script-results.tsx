/**
 * The response **Script** tab (#63): what the request's scripts did in this send — each test with
 * its outcome, a post-response script that failed, and the log. Every string arrives masked from
 * main. A request whose scripts are switched off says so, rather than showing an empty tab.
 *
 * When an API's, an interface's or a folder's scripts ran too (#334), the tab lists every script
 * that ran, in order, each under a heading such as `API "Shop" · pre-request`.
 */
import { CheckCircle2, XCircle } from 'lucide-react';
import type { ScriptResultWire } from '@shared/wire-base.js';

type ScriptTestWire = ScriptResultWire['tests'][number];
type ScriptLevelResultWire = NonNullable<ScriptResultWire['levels']>[number];

const LEVEL_NAME: Record<ScriptLevelResultWire['level'], string> = {
  api: 'API',
  interface: 'Interface',
  folder: 'Folder',
  request: 'Request',
};

/** A level's heading: `API "Shop" · pre-request`. */
export function scriptLevelHeading(level: Pick<ScriptLevelResultWire, 'level' | 'name' | 'phase'>): string {
  return `${LEVEL_NAME[level.level]} "${level.name}" · ${level.phase === 'pre' ? 'pre-request' : 'post-response'}`;
}

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
  const levels = script.levels ?? [];
  if (levels.some((level) => level.level !== 'request')) {
    return (
      <div data-testid="script-results" className="flex min-h-0 flex-1 flex-col overflow-auto p-3 text-sm">
        {script.error !== undefined && (
          <p role="alert" data-testid="script-results-error" className="mb-3 text-status-danger">
            <span className="font-mono">{script.error.code}</span> — {script.error.message}
          </p>
        )}
        {levels.map((level, index) => (
          <section
            key={`${String(index)}:${level.level}:${level.phase}`}
            aria-label={scriptLevelHeading(level)}
            data-testid="script-level"
            className="mb-3"
          >
            <h3 className="mb-1 text-xs font-semibold text-fg-muted">{scriptLevelHeading(level)}</h3>
            {level.error !== undefined && (
              <p className="mb-1 text-status-danger">
                <span className="font-mono">{level.error.code}</span> — {level.error.message}
              </p>
            )}
            {level.tests.length > 0 && <TestList tests={level.tests} />}
            {level.log.length > 0 && (
              <pre className="font-mono text-xs whitespace-pre-wrap">{level.log.join('\n')}</pre>
            )}
            {level.tests.length === 0 && level.log.length === 0 && level.error === undefined && (
              <p className="text-fg-subtle">No tests, nothing logged.</p>
            )}
            {level.truncated && (
              <p className="mt-1 text-xs text-status-warning">The log reached its limit; later lines were dropped.</p>
            )}
          </section>
        ))}
      </div>
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
      {script.tests.length === 0 ? <p className="mb-3 text-fg-subtle">No tests.</p> : <TestList tests={script.tests} />}
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

/** Each test with its outcome. */
function TestList({ tests }: { readonly tests: readonly ScriptTestWire[] }) {
  return (
    <ul aria-label="Script tests" className="mb-3 space-y-1">
      {tests.map((test, index) => (
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
  );
}
