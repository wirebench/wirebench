/**
 * Renders a {@link WsiReport} as a self-contained HTML document.
 *
 * "Self-contained" is the whole point: the file a user exports has to open from a mail
 * attachment, a ticket, or a shared drive years from now, so it carries its own inline CSS and
 * nothing else — no script, no font, no stylesheet, no image, nothing that resolves over the
 * network. Every value that reaches the markup goes through {@link escapeHtml} first: a finding
 * quotes the offending element's name straight out of somebody else's message.
 */

import type { WsiAssertionReport, WsiReport, WsiAssertionResult } from './types.js';

/** Escapes the five characters that could otherwise close a tag or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How each result is labelled in the report. */
const RESULT_LABEL: Readonly<Record<WsiAssertionResult, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  warning: 'Warning',
  notApplicable: 'Not applicable',
};

/** Options for {@link renderWsiReportHtml}. */
export interface RenderWsiReportHtmlOptions {
  /** The document title and page heading, e.g. the interface or request name. */
  readonly title: string;
  /**
   * The timestamp printed in the header, as an ISO 8601 string. Injected rather than read from
   * the clock so the output is a deterministic function of its input (and so the snapshot test
   * has something stable to compare).
   */
  readonly generatedAt: string;
  /**
   * Whether the table includes the `passed`/`notApplicable` rows the report carries. It only
   * ever *removes* rows: a report produced without `verbose` has no passing rows to show.
   */
  readonly verbose?: boolean;
}

/** The stylesheet, inlined. Kept deliberately plain so the file prints and reads anywhere. */
const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  .target { color: #555; margin: 0 0 1.5rem; word-break: break-all; }
  .summary { display: flex; flex-wrap: wrap; gap: 0.5rem; list-style: none; margin: 0 0 1.5rem; padding: 0; }
  .summary li { border: 1px solid #ccc; border-radius: 999px; padding: 0.15rem 0.75rem; }
  .summary .count { font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { border-bottom-width: 2px; white-space: nowrap; }
  td.id, td.level, td.result { white-space: nowrap; }
  .findings { margin: 0.25rem 0 0; padding-left: 1.1rem; }
  .findings li { color: #444; }
  .where { color: #777; }
  .r-failed { color: #a11; font-weight: 600; }
  .r-warning { color: #a60; font-weight: 600; }
  .r-passed { color: #161; }
  .r-notApplicable { color: #777; }
  .empty { color: #555; font-style: italic; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e6e6; }
    .target, .findings li, .empty { color: #b9b9b9; }
    th, td { border-color: #333; }
    .summary li { border-color: #444; }
    .r-failed { color: #ff8b8b; } .r-warning { color: #f0b429; } .r-passed { color: #7fd08a; }
  }
`;

/** One finding rendered as a list item, with its location when it has one. */
function findingHtml(assertion: WsiAssertionReport): string {
  if (assertion.findings.length === 0) {
    return '';
  }
  const items = assertion.findings.map((finding) => {
    const location = finding.location;
    const where =
      location === undefined
        ? ''
        : ` <span class="where">(${escapeHtml(location.document)}${
            location.line === undefined ? '' : `:${String(location.line)}`
          }${location.xpath === undefined ? '' : ` ${escapeHtml(location.xpath)}`})</span>`;
    return `<li>${escapeHtml(finding.message)}${where}</li>`;
  });
  return `<ul class="findings">${items.join('')}</ul>`;
}

/** One assertion rendered as a table row. */
function rowHtml(assertion: WsiAssertionReport): string {
  return [
    '<tr>',
    `<td class="id">${escapeHtml(assertion.id)}</td>`,
    `<td class="level">${escapeHtml(assertion.level)}</td>`,
    `<td class="result r-${assertion.result}">${RESULT_LABEL[assertion.result]}</td>`,
    `<td>${escapeHtml(assertion.title)}${findingHtml(assertion)}</td>`,
    `<td>${escapeHtml(assertion.section)}</td>`,
    '</tr>',
  ].join('');
}

/**
 * Renders one WS-I report as a standalone HTML document.
 *
 * @param report the report to render, from `runWsdlAssertions` or `runMessageAssertions`
 * @param options the heading, the (injected) timestamp, and whether to keep non-failing rows
 * @returns a complete HTML document with no external references of any kind
 */
export function renderWsiReportHtml(report: WsiReport, options: RenderWsiReportHtmlOptions): string {
  const rows =
    options.verbose === true
      ? report.assertions
      : report.assertions.filter((assertion) => assertion.result === 'failed' || assertion.result === 'warning');

  const summary = [
    ['Passed', report.summary.passed],
    ['Failed', report.summary.failed],
    ['Warning', report.summary.warning],
    ['Not applicable', report.summary.notApplicable],
  ] as const;

  const body =
    rows.length === 0
      ? '<p class="empty">No assertions to show.</p>'
      : [
          '<table>',
          '<thead><tr><th>Id</th><th>Level</th><th>Result</th><th>Assertion</th><th>Section</th></tr></thead>',
          '<tbody>',
          ...rows.map(rowHtml),
          '</tbody>',
          '</table>',
        ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>WS-I ${escapeHtml(report.profile)} report — ${escapeHtml(options.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<h1>WS-I ${escapeHtml(report.profile)} report — ${escapeHtml(options.title)}</h1>`,
    `<p class="target">${escapeHtml(report.target)} · generated ${escapeHtml(options.generatedAt)}</p>`,
    '<ul class="summary">',
    ...summary.map(([label, count]) => `<li>${label}: <span class="count">${String(count)}</span></li>`),
    '</ul>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
