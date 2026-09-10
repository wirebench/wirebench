import { Copy } from 'lucide-react';
import type { ExchangeSummary } from '../../../../shared/wire-types.js';
import { InspectorIconButton } from './inspector-strip.js';

export interface ResponseHeadersInspectorProps {
  /** The exchange whose response headers to show; absent before the first send. */
  readonly exchange: ExchangeSummary | undefined;
}

/**
 * The response pane's Headers inspector: the response headers exactly as they came off the
 * wire — `rawHeaders`, not the joined map — so repeated names (`Set-Cookie`) stay repeated and
 * in order. Read-only by nature; the only action is copying the block.
 */
export function ResponseHeadersInspector({ exchange }: ResponseHeadersInspectorProps) {
  const rawHeaders = exchange?.http.rawHeaders;
  if (rawHeaders === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">No response yet. Send this request to see its headers.</p>;
  }

  const asText = rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');

  return (
    <div className="flex flex-col gap-1 p-2">
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
            <tr key={`${name}:${index}`} data-testid="response-header-row" className="align-top">
              <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
                {name}
              </th>
              <td className="py-0.5 break-words text-fg-default">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
