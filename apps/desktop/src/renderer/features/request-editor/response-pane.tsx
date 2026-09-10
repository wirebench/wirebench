import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '../../components/empty-state.js';
import { XmlEditor } from '../../editor/xml-editor.js';
import { decodeBase64Text } from '../../lib/format-size.js';
import { formatXml } from '../../lib/format-xml.js';
import type { ExchangeState } from '../../state/exchanges.js';
import { ResponseStatus } from './response-status.js';
import { ViewTabs } from './view-tabs.js';

const VIEWS = [
  { id: 'xml', label: 'XML' },
  { id: 'raw', label: 'Raw', disabledReason: 'Arrives in Task 28' },
] as const;

export interface ResponsePaneProps {
  readonly state: ExchangeState | undefined;
}

/** The response half: status line, then the formatted envelope (or the raw body, or nothing yet). */
export function ResponsePane({ state }: ResponsePaneProps) {
  const exchange = state?.exchange;
  const response = exchange?.response;

  const body = useMemo(() => {
    if (exchange === undefined) {
      return '';
    }
    if (response?.isSoap === true) {
      return formatXml(response.envelopeXml);
    }
    return decodeBase64Text(exchange.http.bodyBase64) ?? '';
  }, [exchange, response]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline">
        <ViewTabs label="Response views" items={VIEWS} active="xml" />
        <div className="min-w-0 flex-1">
          <ResponseStatus exchange={exchange} error={state?.error} />
        </div>
      </div>

      <div data-testid="response-editor" className="min-h-0 flex-1">
        {state?.status === 'sending' ? (
          <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            Sending… (Esc to cancel)
          </div>
        ) : exchange === undefined ? (
          <EmptyState
            title="No response yet"
            description={
              state?.error !== undefined
                ? 'The last send did not complete. Fix the problem above and send again.'
                : 'Send this request to see the response envelope, timings, and the raw exchange.'
            }
          />
        ) : response?.isSoap === true ? (
          <XmlEditor ariaLabel="Response envelope XML" value={body} readOnly />
        ) : (
          <pre className="h-full overflow-auto p-3 font-mono text-sm break-words whitespace-pre-wrap text-fg-default">
            {body}
          </pre>
        )}
      </div>
    </div>
  );
}
