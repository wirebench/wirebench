/**
 * The console's "WS-I Report" tab: the last WS-I Basic Profile run, whether it analysed a
 * description (`wsi.checkWsdl`) or one exchange (`wsi.checkExchange`).
 *
 * Exported on its own rather than inlined in the console panel because Task 45's Interface
 * editor shows the very same report in its own tab; both read {@link useWsiStore}, so a run
 * started from either place shows up in both.
 */

import type { WsiAssertionReportWire, WsiReportWire } from '../../../shared/wire-types.js';
import { useWsiStore } from '../../state/wsi.js';

/** How each result is labelled and coloured. */
const RESULT: Readonly<Record<WsiAssertionReportWire['result'], { label: string; className: string }>> = {
  failed: { label: 'Failed', className: 'text-danger' },
  warning: { label: 'Warning', className: 'text-warning' },
  passed: { label: 'Passed', className: 'text-fg-subtle' },
  notApplicable: { label: 'N/A', className: 'text-fg-subtle' },
};

const CHIP_CLASS = 'rounded-full border border-hairline px-2 py-0.5 text-xs text-fg-subtle';

/** `document:line`, or just the document — whatever the finding actually knows. */
function locationLabel(finding: WsiAssertionReportWire['findings'][number]): string | undefined {
  const location = finding.location;
  if (location === undefined) {
    return undefined;
  }
  return location.line === undefined ? location.document : `${location.document}:${String(location.line)}`;
}

/** The rows the table shows, given the "failed only" toggle. */
function visibleRows(report: WsiReportWire, showAll: boolean): readonly WsiAssertionReportWire[] {
  return showAll
    ? report.assertions
    : report.assertions.filter((assertion) => assertion.result === 'failed' || assertion.result === 'warning');
}

/** The four summary counts, as chips. */
function Summary({ report }: { readonly report: WsiReportWire }) {
  const chips: readonly (readonly [string, number])[] = [
    ['Passed', report.summary.passed],
    ['Failed', report.summary.failed],
    ['Warning', report.summary.warning],
    ['N/A', report.summary.notApplicable],
  ];
  return (
    <ul className="flex flex-wrap items-center gap-1" aria-label="WS-I summary">
      {chips.map(([label, count]) => (
        <li key={label} className={CHIP_CLASS} data-testid={`wsi-summary-${label.toLowerCase()}`}>
          {label}: {count}
        </li>
      ))}
    </ul>
  );
}

/** The WS-I Report tab body. */
export function WsiReport() {
  const status = useWsiStore((state) => state.status);
  const report = useWsiStore((state) => state.report);
  const error = useWsiStore((state) => state.error);
  const showAll = useWsiStore((state) => state.showAll);
  const setShowAll = useWsiStore((state) => state.setShowAll);
  const exportHtml = useWsiStore((state) => state.exportHtml);

  if (status === 'error') {
    return (
      <p className="text-sm text-danger" data-testid="wsi-error">
        {error ?? 'The WS-I check failed.'}
      </p>
    );
  }
  if (report === undefined) {
    return (
      <p className="text-sm text-fg-subtle" data-testid="wsi-empty">
        {status === 'running'
          ? 'Running the WS-I Basic Profile checks…'
          : 'Run a WS-I Basic Profile check on an interface to see its report here.'}
      </p>
    );
  }

  const rows = visibleRows(report, showAll);

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="wsi-report">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg-default" data-testid="wsi-label">
          {report.label}
        </span>
        <span className={CHIP_CLASS}>{report.profile}</span>
        <span className={CHIP_CLASS}>{report.scope === 'wsdl' ? 'Description' : 'Message'}</span>
        <Summary report={report} />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="wsi-filter-failed"
            aria-pressed={!showAll}
            onClick={() => {
              setShowAll(!showAll);
            }}
            className={`rounded-full border border-hairline px-2 py-0.5 text-xs ${
              showAll ? 'text-fg-subtle hover:bg-surface-raised' : 'bg-accent-muted text-fg-default'
            }`}
          >
            Failed only
          </button>
          <button
            type="button"
            data-testid="wsi-export-html"
            onClick={() => {
              void exportHtml();
            }}
            className="rounded border border-hairline px-2 py-0.5 text-xs text-fg-default hover:bg-surface-raised"
          >
            Export HTML
          </button>
        </div>
      </div>
      <p className="shrink-0 truncate text-xs text-fg-subtle" data-testid="wsi-target" title={report.target}>
        {report.target}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle" data-testid="wsi-no-rows">
          {showAll ? 'This report has no assertions.' : 'No failures or warnings.'}
        </p>
      ) : (
        <div className="min-h-0 overflow-auto">
          <table className="w-full text-sm" aria-label="WS-I assertions">
            <thead>
              <tr className="text-left text-xs text-fg-subtle">
                <th className="py-1 pr-2 font-normal">Id</th>
                <th className="py-1 pr-2 font-normal">Result</th>
                <th className="py-1 pr-2 font-normal">Assertion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((assertion) => (
                <tr key={assertion.id} data-testid="wsi-row" data-result={assertion.result} className="align-top">
                  <td className="py-1 pr-2 font-mono text-xs">
                    {assertion.id}
                    {assertion.unverifiedId === true && <sup data-testid="wsi-unverified-id">*</sup>}
                  </td>
                  <td className={`py-1 pr-2 text-xs ${RESULT[assertion.result].className}`}>
                    {RESULT[assertion.result].label}
                  </td>
                  <td className="py-1">
                    <span className="text-fg-default">{assertion.title}</span>
                    {assertion.findings.length > 0 && (
                      <ul className="mt-0.5 list-disc pl-4 text-xs text-fg-subtle">
                        {assertion.findings.map((finding, index) => (
                          <li key={`${assertion.id}:${String(index)}`} data-testid="wsi-finding">
                            {finding.message}
                            {locationLabel(finding) !== undefined && (
                              <span className="ml-1 font-mono">({locationLabel(finding)})</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.some((assertion) => assertion.unverifiedId === true) && (
        <p className="shrink-0 text-xs text-fg-subtle" data-testid="wsi-unverified-footnote">
          * requirement number not verified against the published Basic Profile 1.1; quote the title.
        </p>
      )}
    </div>
  );
}
