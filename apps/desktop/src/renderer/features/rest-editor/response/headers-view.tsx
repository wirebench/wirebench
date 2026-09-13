/**
 * The response headers, exactly as they came off the wire — `rawHeaders`, not the joined map — so a
 * repeated name (`Set-Cookie`) stays repeated and in order.
 */
import { Copy } from 'lucide-react';
import { InspectorIconButton } from '../../request-editor/inspectors/inspector-strip.js';
import type { RestExchangeSummary } from '../../../../shared/wire-types.js';

export interface ResponseHeadersViewProps {
  readonly exchange: RestExchangeSummary;
}

/** The Headers tab. */
export function ResponseHeadersView({ exchange }: ResponseHeadersViewProps) {
  const rawHeaders = exchange.http.rawHeaders ?? Object.entries(exchange.http.headers);
  const asText = rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');

  return (
    <div data-testid="rest-response-headers" className="flex flex-col gap-1 overflow-auto p-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">Response headers</h3>
        <InspectorIconButton
          label="Copy response headers"
          onClick={() => {
            void navigator.clipboard?.writeText(asText);
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </InspectorIconButton>
      </div>
      <table aria-label="Response headers" className="w-full table-fixed border-collapse font-mono text-xs">
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
      {rawHeaders.length === 0 && <p className="text-sm text-fg-subtle">This response carried no headers.</p>}
    </div>
  );
}
