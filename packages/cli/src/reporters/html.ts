import type { AssertionResult, RequestResult, RunResult } from '@wirebench/engine';
import { escapeHtml } from './escape.js';

/** The outcome mark and its colour class, shared by the summary line and the assertion table. */
const OUTCOME_MARK: Readonly<Record<RequestResult['outcome'], string>> = {
  passed: 'PASS',
  failed: 'FAIL',
  errored: 'ERROR',
  skipped: 'SKIP',
};

const OUTCOME_CLASS: Readonly<Record<RequestResult['outcome'], string>> = {
  passed: 'success',
  failed: 'danger',
  errored: 'danger',
  skipped: 'warning',
};

function seconds(durationMs: number | undefined): string | undefined {
  return durationMs === undefined ? undefined : `${(durationMs / 1000).toFixed(3)}s`;
}

/** The message an assertion reports, matching the `cli` and `junit` reporters' own wording. */
function assertionMessage(assertion: AssertionResult): string {
  if (assertion.expected !== undefined || assertion.actual !== undefined) {
    return `${assertion.expected ?? ''} / ${assertion.actual ?? ''}`;
  }
  return assertion.message ?? assertion.outcome;
}

function renderAssertionRow(assertion: AssertionResult): string {
  const outcomeClass = OUTCOME_CLASS[assertion.outcome === 'passed' ? 'passed' : 'failed'];
  return (
    `<tr><td>${escapeHtml(assertion.label)}</td>` +
    `<td class="${outcomeClass}">${escapeHtml(assertion.outcome)}</td>` +
    `<td>${escapeHtml(assertionMessage(assertion))}</td></tr>`
  );
}

function renderAssertions(assertions: readonly AssertionResult[]): string {
  if (assertions.length === 0) {
    return '';
  }
  const rows = assertions.map(renderAssertionRow).join('');
  return `<table><thead><tr><th>Assertion</th><th>Outcome</th><th>Expected / actual</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderExchange(result: RequestResult): string {
  if (result.exchange === undefined) {
    return '';
  }
  return `<pre>${escapeHtml(result.exchange.request)}</pre>` + `<pre>${escapeHtml(result.exchange.response)}</pre>`;
}

function renderError(result: RequestResult): string {
  if (result.error === undefined) {
    return '';
  }
  return `<p class="danger">${escapeHtml(result.error.code)}: ${escapeHtml(result.error.message)}</p>`;
}

function renderSummary(result: RequestResult): string {
  const mark = OUTCOME_MARK[result.outcome];
  const status = result.status !== undefined ? ` — ${String(result.status)}` : '';
  const duration = seconds(result.durationMs);
  const time = duration !== undefined ? ` — ${duration}` : '';
  return (
    `<span class="${OUTCOME_CLASS[result.outcome]}">${escapeHtml(mark)}</span> ` +
    `${escapeHtml(result.path)}${escapeHtml(status)}${escapeHtml(time)}`
  );
}

function renderRequest(result: RequestResult): string {
  const open = result.outcome === 'failed' || result.outcome === 'errored' ? ' open' : '';
  return (
    `<details${open}><summary>${renderSummary(result)}</summary>` +
    `${renderAssertions(result.assertions)}${renderError(result)}${renderExchange(result)}</details>`
  );
}

/**
 * Renders the `html` report: one self-contained, offline document — inline CSS, no script,
 * nothing fetched — safe to open from a CI artefact store or an air-gapped share. Exchanges are
 * shown for failed and errored requests only, already masked by the time this function sees them.
 * Pure — no I/O.
 */
export function renderHtml(result: RunResult, tool: { readonly name: string; readonly version: string }): string {
  const { total, passed, failed, errored, skipped } = result.summary;
  const counts = `${String(passed)} passed, ${String(failed)} failed, ${String(errored)} errored, ${String(skipped)} skipped`;
  const environment = result.environment !== undefined ? `<p>environment: ${escapeHtml(result.environment)}</p>` : '';
  const requests = result.requests.map(renderRequest).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(tool.name)} ${escapeHtml(tool.version)} run report</title>
<style>
:root {
  --bg: #faf9f7;
  --fg: #22201d;
  --fg-muted: #6b6a67;
  --border: #ddd9d3;
  --success: #2b7550;
  --danger: #b23b33;
  --warning: #8b6010;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151413;
    --fg: #ece9e3;
    --fg-muted: #a9a6a0;
    --border: #3a3733;
    --success: #6fbf8f;
    --danger: #e0685f;
    --warning: #d9a441;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.5rem;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
header { margin-bottom: 1.5rem; }
header p { margin: 0.15rem 0; color: var(--fg-muted); }
details {
  border: 1px solid var(--border);
  border-radius: 4px;
  margin-bottom: 0.5rem;
  padding: 0.5rem 0.75rem;
}
summary { cursor: pointer; font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
th, td { border: 1px solid var(--border); padding: 0.25rem 0.5rem; text-align: left; font-size: 0.9em; }
pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.5rem;
  overflow-x: auto;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  white-space: pre-wrap;
  word-break: break-word;
}
.success { color: var(--success); }
.danger { color: var(--danger); }
.warning { color: var(--warning); }
</style>
</head>
<body>
<header>
<h1>${escapeHtml(tool.name)} ${escapeHtml(tool.version)} run report</h1>
${environment}
<p>started: ${escapeHtml(result.startedAt)}</p>
<p>${escapeHtml(String(total))} total — ${escapeHtml(counts)}</p>
</header>
<main>
${requests}
</main>
</body>
</html>
`;
}
