/**
 * The response headers, exactly as they came off the wire — `rawHeaders`, not the joined map — so a
 * repeated name (`Set-Cookie`) stays repeated and in order.
 */
import { Copy } from 'lucide-react';
import { InspectorIconButton } from '../../request-editor/inspectors/inspector-strip.js';
import type { RestExchangeSummary } from '../../../../shared/wire-types.js';

/**
 * A finished exchange; while an event stream is still arriving, the headers it opened with; or a
 * captured request's pairs in arrival order (webhook-capture §4.2), shown as request headers.
 */
export type ResponseHeadersViewProps = (
  | { readonly exchange: RestExchangeSummary; readonly headers?: undefined; readonly pairs?: undefined }
  | { readonly exchange?: undefined; readonly headers: Readonly<Record<string, string>>; readonly pairs?: undefined }
  | {
      readonly exchange?: undefined;
      readonly headers?: undefined;
      readonly pairs: readonly (readonly [string, string])[];
    }
) & { readonly subject?: 'response' | 'request' };

/** The Headers tab. */
export function ResponseHeadersView({ exchange, headers, pairs, subject = 'response' }: ResponseHeadersViewProps) {
  const rawHeaders =
    pairs ??
    (exchange !== undefined
      ? (exchange.http.rawHeaders ?? Object.entries(exchange.http.headers))
      : Object.entries(headers ?? {}));
  const asText = rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');
  const title = subject === 'request' ? 'Request headers' : 'Response headers';

  return (
    <div
      data-testid={subject === 'request' ? 'capture-headers' : 'rest-response-headers'}
      className="flex flex-col gap-1 overflow-auto p-2"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">{title}</h3>
        <InspectorIconButton
          label={`Copy ${title.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(asText);
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </InspectorIconButton>
      </div>
      <table aria-label={title} className="w-full table-fixed border-collapse font-mono text-xs">
        <tbody>
          {rawHeaders.map(([name, value], index) => (
            <tr key={`${name}:${String(index)}`} data-testid="rest-response-header-row" className="align-top">
              <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
                {name}
              </th>
              <td className="py-0.5 break-words text-fg-default">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rawHeaders.length === 0 && <p className="text-sm text-fg-subtle">This {subject} carried no headers.</p>}
    </div>
  );
}
