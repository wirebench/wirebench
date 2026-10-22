/**
 * The contract diff's reports (#56 spec §5): Markdown for a pull request or a wiki, a self-contained
 * HTML page in the run report's look, and JSON. Pure — no I/O.
 */
import type { ContractChange, ContractDiff, ContractDiffSummary, ContractSide } from './model.js';
import { summarize } from './model.js';

/** Escapes what Markdown would read as formatting inside a table cell; a line break becomes a space. */
export function escapeMarkdownCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `2 breaking, 5 compatible changes in 7 operations compared`. */
export function summaryLine(diff: ContractDiff, summary: ContractDiffSummary = summarize(diff.changes)): string {
  const operations = diff.operationsCompared === 1 ? 'operation' : 'operations';
  return `${String(summary.breaking)} breaking, ${String(summary.compatible)} compatible changes in ${String(diff.operationsCompared)} ${operations} compared`;
}

const FORMAT_NAME: Readonly<Record<ContractDiff['format'], string>> = { wsdl: 'WSDL', openapi: 'OpenAPI' };

const sideRows = (diff: ContractDiff): readonly (readonly [string, (side: ContractSide) => string])[] => [
  ['Source', (side) => side.label],
  ...(diff.old.title !== undefined || diff.new.title !== undefined
    ? [['Title', (side: ContractSide) => side.title ?? ''] as const]
    : []),
  ...(diff.old.version !== undefined || diff.new.version !== undefined
    ? [['Version', (side: ContractSide) => side.version ?? ''] as const]
    : []),
];

const EQUIVALENT = 'No differences: the two contracts are equivalent for a client.';

export function renderContractDiffMarkdown(diff: ContractDiff): string {
  const lines = [`# ${FORMAT_NAME[diff.format]} contract diff`, '', '|  | Old | New |', '| --- | --- | --- |'];
  for (const [name, value] of sideRows(diff)) {
    lines.push(`| ${name} | ${escapeMarkdownCell(value(diff.old))} | ${escapeMarkdownCell(value(diff.new))} |`);
  }
  lines.push('', `**${summaryLine(diff)}.**`);
  if (diff.changes.length === 0) {
    lines.push('', EQUIVALENT);
  }
  const section = (title: string, changes: readonly ContractChange[]): void => {
    if (changes.length === 0) {
      return;
    }
    lines.push('', `## ${title}`, '', '| Operation | Location | Change |', '| --- | --- | --- |');
    for (const change of changes) {
      lines.push(
        `| ${escapeMarkdownCell(change.operation ?? '(contract)')} | ${escapeMarkdownCell(change.location ?? '')} | ${escapeMarkdownCell(change.message)} |`,
      );
    }
  };
  section(
    'Breaking changes',
    diff.changes.filter((change) => change.severity === 'breaking'),
  );
  section(
    'Compatible changes',
    diff.changes.filter((change) => change.severity === 'compatible'),
  );
  if (diff.notes.length > 0) {
    lines.push('', '## Notes', '', ...diff.notes.map((note) => `- ${escapeMarkdownCell(note)}`));
  }
  return `${lines.join('\n')}\n`;
}

function htmlTable(title: string, cssClass: string, changes: readonly ContractChange[]): string {
  if (changes.length === 0) {
    return '';
  }
  const rows = changes
    .map(
      (change) =>
        `<tr><td>${escapeHtml(change.operation ?? '(contract)')}</td><td><code>${escapeHtml(change.location ?? '')}</code></td><td>${escapeHtml(change.message)}</td></tr>`,
    )
    .join('');
  return `<h2 class="${cssClass}">${escapeHtml(title)} (${String(changes.length)})</h2>
<table><thead><tr><th>Operation</th><th>Location</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderContractDiffHtml(
  diff: ContractDiff,
  tool: { readonly name: string; readonly version: string },
): string {
  const title = `${FORMAT_NAME[diff.format]} contract diff`;
  const sides = sideRows(diff)
    .map(
      ([name, value]) =>
        `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value(diff.old))}</td><td>${escapeHtml(value(diff.new))}</td></tr>`,
    )
    .join('');
  const notes =
    diff.notes.length === 0
      ? ''
      : `<h2>Notes</h2><ul>${diff.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #faf9f7;
  --fg: #22201d;
  --fg-muted: #6b6a67;
  --border: #ddd9d3;
  --success: #2b7550;
  --danger: #b23b33;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151413;
    --fg: #ece9e3;
    --fg-muted: #a9a6a0;
    --border: #3a3733;
    --success: #6fbf8f;
    --danger: #e0685f;
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
header p { margin: 0.15rem 0; color: var(--fg-muted); }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
th, td { border: 1px solid var(--border); padding: 0.25rem 0.5rem; text-align: left; font-size: 0.9em; overflow-wrap: anywhere; }
code { font-family: ui-monospace, monospace; }
.success { color: var(--success); }
.danger { color: var(--danger); }
</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(tool.name)} ${escapeHtml(tool.version)}</p>
</header>
<table><thead><tr><th></th><th>Old</th><th>New</th></tr></thead><tbody>${sides}</tbody></table>
<p><strong>${escapeHtml(summaryLine(diff))}.</strong></p>
${diff.changes.length === 0 ? `<p class="success">${escapeHtml(EQUIVALENT)}</p>` : ''}
${htmlTable(
  'Breaking changes',
  'danger',
  diff.changes.filter((change) => change.severity === 'breaking'),
)}
${htmlTable(
  'Compatible changes',
  'success',
  diff.changes.filter((change) => change.severity === 'compatible'),
)}
${notes}
</body>
</html>
`;
}

/** The JSON report: the diff and its counts. */
export function contractDiffJson(diff: ContractDiff): ContractDiff & { readonly summary: ContractDiffSummary } {
  return { ...diff, summary: summarize(diff.changes) };
}
