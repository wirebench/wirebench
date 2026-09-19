import { DiffXmlEditor } from '../../editor/diff-xml-editor.js';
import { formatDuration } from '../../lib/format-size.js';
import type { LogEntry } from '../../state/exchanges.js';
import { comparableBodies, diffHeaders, requestBodyOf, responseBodyOf, type HeaderChange } from './log-compare.js';
import { durationOf, methodOf, statusLabelOf, urlOf } from './log-filter.js';
import { requestHeadersOf } from './log-row-actions.js';

const CHANGE_TONE: Record<HeaderChange, string> = {
  same: 'text-fg-muted',
  added: 'text-status-success',
  removed: 'text-status-danger',
  changed: 'text-status-warning',
};

function Summary({ entry, side }: { readonly entry: LogEntry; readonly side: string }) {
  return (
    <p data-testid="log-compare-summary" className="truncate font-mono text-xs text-fg-default" title={urlOf(entry)}>
      <span className="text-fg-faint">{side} </span>
      {methodOf(entry)} {urlOf(entry)} · {statusLabelOf(entry)} · {formatDuration(durationOf(entry))}
    </p>
  );
}

function HeaderTable({
  label,
  left,
  right,
}: {
  readonly label: string;
  readonly left: Readonly<Record<string, string>>;
  readonly right: Readonly<Record<string, string>>;
}) {
  const rows = diffHeaders(left, right);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <table aria-label={label} className="w-full table-fixed border-collapse font-mono text-xs">
        <tbody>
          {rows.map((row) => (
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
  );
}

function BodyDiff({ label, left, right }: { readonly label: string; readonly left: string; readonly right: string }) {
  const bodies = comparableBodies(left, right);
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-fg-muted">{label}</h3>
      <div className="h-48 min-h-0 border border-hairline">
        <DiffXmlEditor
          original={bodies.left}
          modified={bodies.right}
          renderSideBySide
          ignoreTrimWhitespace
          language={bodies.language}
        />
      </div>
    </section>
  );
}

const responseHeadersOf = (entry: LogEntry): Readonly<Record<string, string>> => {
  if (entry.kind !== 'exchange') {
    return {};
  }
  return 'protocol' in entry.exchange ? entry.exchange.responseHeaders : entry.exchange.http.headers;
};

/** Two HTTP Log rows side by side: a summary of each, the headers that differ, and a diff of both bodies. */
export function LogCompare({ left, right }: { readonly left: LogEntry; readonly right: LogEntry }) {
  return (
    <div
      data-testid="log-compare"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto border-l border-hairline p-2"
    >
      <div className="flex flex-col gap-0.5">
        <Summary entry={left} side="A" />
        <Summary entry={right} side="B" />
      </div>
      <HeaderTable label="Request headers" left={requestHeadersOf(left)} right={requestHeadersOf(right)} />
      <HeaderTable label="Response headers" left={responseHeadersOf(left)} right={responseHeadersOf(right)} />
      <BodyDiff label="Request body" left={requestBodyOf(left)} right={requestBodyOf(right)} />
      <BodyDiff label="Response body" left={responseBodyOf(left)} right={responseBodyOf(right)} />
    </div>
  );
}
