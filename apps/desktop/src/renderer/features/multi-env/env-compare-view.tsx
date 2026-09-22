/**
 * The compare tab of a multi-environment send (`editors.ts` `kind: 'env-compare'`): one column
 * per environment, a verdict per environment against the baseline, and the baseline diffed with
 * one chosen environment — bodies through `DiffView`, headers through `diffHeaders`.
 */
import { useMemo, useState } from 'react';
import { formatBytes, formatDuration } from '../../lib/format-size.js';
import { DiffView } from '../history/diff-view.js';
import { diffHeaders, type HeaderChange } from '../console/log-compare.js';
import type { EnvSendResult } from '../../../shared/wire-types.js';
import { summarise, toCompareColumns, type CompareColumn, type CompareVerdict } from './env-compare.js';

export interface EnvCompareViewProps {
  readonly results: readonly EnvSendResult[];
  readonly baselineId: string;
}

const VERDICT_LABEL: Record<CompareVerdict, string> = {
  same: 'same body',
  'body-differs': 'body differs',
  'status-differs': 'status differs',
  failed: 'failed',
};

const VERDICT_TONE: Record<CompareVerdict, string> = {
  same: 'text-status-success',
  'body-differs': 'text-status-warning',
  'status-differs': 'text-status-danger',
  failed: 'text-status-danger',
};

const CHANGE_TONE: Record<HeaderChange, string> = {
  same: 'text-fg-muted',
  added: 'text-status-success',
  removed: 'text-status-danger',
  changed: 'text-status-warning',
};

function statusLine(column: CompareColumn): string {
  const parts = [
    column.status === undefined ? '—' : `${column.status}${column.statusText ? ` ${column.statusText}` : ''}`,
  ];
  if (column.fault === true) parts.push('SOAP fault');
  if (column.durationMs !== undefined) parts.push(formatDuration(column.durationMs));
  if (column.sizeBytes !== undefined) parts.push(formatBytes(column.sizeBytes));
  return parts.join(' · ');
}

function Column({ column, baseline }: { readonly column: CompareColumn; readonly baseline: boolean }) {
  return (
    <section
      data-testid="env-compare-column"
      data-environment-id={column.environmentId}
      aria-label={column.environmentName}
      className="flex w-80 min-w-[16rem] shrink-0 flex-col gap-1 border-r border-hairline p-2"
    >
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg-default">
        <span className="truncate">{column.environmentName}</span>
        {baseline && (
          <span data-testid="env-compare-baseline" className="rounded-sm bg-accent-muted px-1 text-xs text-fg-default">
            baseline
          </span>
        )}
      </h3>
      {column.url !== undefined && (
        <p className="truncate font-mono text-xs text-fg-muted" title={column.url}>
          {column.url}
        </p>
      )}
      {column.outcome === 'error' ? (
        <p data-testid="env-compare-error" className="text-xs break-words text-status-danger">
          {column.error}
        </p>
      ) : (
        <>
          <p data-testid="env-compare-status" className="font-mono text-xs text-fg-default">
            {statusLine(column)}
          </p>
          <pre
            data-testid="env-compare-body"
            className="max-h-64 min-h-0 overflow-auto rounded-sm bg-surface-sunken p-1 font-mono text-xs text-fg-default"
          >
            {column.body}
          </pre>
        </>
      )}
    </section>
  );
}

/** The whole compare tab. */
export function EnvCompareView({ results, baselineId }: EnvCompareViewProps) {
  const columns = useMemo(() => toCompareColumns(results), [results]);
  const baselineResult = results.find((result) => result.environmentId === baselineId) ?? results[0];
  const others = results.filter((result) => result !== baselineResult);
  const [otherId, setOtherId] = useState<string | undefined>(others[0]?.environmentId);
  const other = others.find((result) => result.environmentId === otherId) ?? others[0];

  const baseColumn = columns.find((column) => column.environmentId === baselineResult?.environmentId);
  const otherColumn = columns.find((column) => column.environmentId === other?.environmentId);
  const headerRows =
    baseColumn !== undefined && otherColumn !== undefined ? diffHeaders(baseColumn.headers, otherColumn.headers) : [];

  return (
    <div data-testid="env-compare" className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="flex shrink-0 overflow-x-auto border-b border-hairline">
        {columns.map((column) => (
          <Column
            key={column.environmentId}
            column={column}
            baseline={column.environmentId === baselineResult?.environmentId}
          />
        ))}
      </div>

      {baselineResult !== undefined && others.length > 0 && (
        <ul aria-label="Summary" className="flex shrink-0 flex-col gap-0.5 border-b border-hairline px-3 py-2 text-xs">
          {others.map((result) => {
            const verdict = summarise(baselineResult, result);
            return (
              <li key={result.environmentId} data-testid="env-compare-verdict" data-verdict={verdict}>
                <span className="text-fg-default">{result.environmentName}</span>
                <span className={VERDICT_TONE[verdict]}>: {VERDICT_LABEL[verdict]}</span>
              </li>
            );
          })}
        </ul>
      )}

      {baseColumn !== undefined && otherColumn !== undefined && (
        <div className="flex min-h-[24rem] flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-fg-muted">
            <label htmlFor="env-compare-other">Compare the baseline with</label>
            <select
              id="env-compare-other"
              data-testid="env-compare-other"
              value={otherColumn.environmentId}
              onChange={(event) => setOtherId(event.target.value)}
              className="h-row rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
            >
              {others.map((result) => (
                <option key={result.environmentId} value={result.environmentId}>
                  {result.environmentName}
                </option>
              ))}
            </select>
          </div>
          <section className="flex flex-col gap-1 px-3 pb-2">
            <h3 className="text-xs font-medium text-fg-muted">Response headers</h3>
            <table
              aria-label="Response headers"
              data-testid="env-compare-headers"
              className="w-full table-fixed border-collapse font-mono text-xs"
            >
              <thead>
                <tr className="text-fg-muted">
                  <th scope="col" className="w-1/4 py-0.5 pr-2 text-left font-medium">
                    Header
                  </th>
                  <th scope="col" className="py-0.5 pr-2 text-left font-medium break-words">
                    {baseColumn.environmentName}
                  </th>
                  <th scope="col" className="py-0.5 text-left font-medium break-words">
                    {otherColumn.environmentName}
                  </th>
                </tr>
              </thead>
              <tbody>
                {headerRows.map((row) => (
                  <tr key={row.name.toLowerCase()} data-change={row.change} className={CHANGE_TONE[row.change]}>
                    <th scope="row" className="w-1/4 py-0.5 pr-2 text-left font-medium break-words">
                      {row.name}
                    </th>
                    <td className="py-0.5 pr-2 break-words">{row.left ?? '—'}</td>
                    <td className="py-0.5 break-words">{row.right ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div data-testid="env-compare-diff" className="min-h-[20rem] flex-1 border-t border-hairline">
            <DiffView
              leftLabel={baseColumn.environmentName}
              rightLabel={otherColumn.environmentName}
              leftXml={baseColumn.body}
              rightXml={otherColumn.body}
            />
          </div>
        </div>
      )}
    </div>
  );
}
