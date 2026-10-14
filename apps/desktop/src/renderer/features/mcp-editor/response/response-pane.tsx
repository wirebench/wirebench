/**
 * The MCP response half (#79): the status line, the catalogue checks' warnings, then Result,
 * Messages and Assertions.
 *
 * While the session runs the Messages tab reads the store's live messages as they arrive; once it
 * finishes the exchange replaces them, holding the same messages. Loaded lazily by the editor, so
 * nothing here is in the eager bundle.
 */
import { useState } from 'react';
import { Tabs } from '../../../components/tabs.js';
import type { McpExchangeState } from '../../../state/exchanges.js';
import { AssertionResults, assertionResultsBadge } from '../../assertions/assertion-results.js';
import { McpMessagesView } from './messages-view.js';
import { McpResultView } from './result-view.js';
import { McpStatusLine } from './status-line.js';

const TABS = [
  { id: 'result', label: 'Result' },
  { id: 'messages', label: 'Messages' },
  { id: 'assertions', label: 'Assertions' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** The warnings of a send's checks against the catalogue, each on its own line. */
export function McpWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul
      role="note"
      aria-label="Warnings"
      data-testid="mcp-response-warnings"
      className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-status-warning"
    >
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

export interface McpResponsePaneProps {
  readonly state: McpExchangeState | undefined;
  /** The server's transport, for the side panel while no exchange has arrived to say. */
  readonly transport?: 'stdio' | 'http' | 'sse' | undefined;
}

/** The response pane. */
export function McpResponsePane({ state, transport }: McpResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('result');
  const exchange = state?.status === 'done' ? state.exchange : undefined;
  const messages = exchange?.messages ?? state?.live?.messages ?? [];

  if (state === undefined || state.status === 'idle') {
    return (
      <section aria-label="Response" data-testid="mcp-response" className="flex h-full min-h-0 flex-col">
        <p className="p-3 text-sm text-fg-subtle">Send the request to see the server’s answer.</p>
      </section>
    );
  }

  const items = TABS.map((item) => {
    if (item.id === 'assertions') {
      const verdict = assertionResultsBadge(exchange?.assertions);
      if (verdict === undefined) return item;
      return { ...item, label: verdict.failed ? 'Assertions ✕' : item.label, badge: verdict.text };
    }
    return item.id === 'messages' && messages.length > 0 ? { ...item, badge: String(messages.length) } : item;
  });

  return (
    <section aria-label="Response" data-testid="mcp-response" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-row shrink-0 items-center border-b border-hairline">
        <div className="min-w-0 flex-1">
          <McpStatusLine state={state} />
        </div>
      </div>
      {exchange !== undefined && <McpWarnings warnings={exchange.warnings} />}
      <Tabs label="Response tabs" items={items} active={tab} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'result' &&
          (exchange === undefined ? (
            <p className="p-3 text-sm text-fg-subtle">
              {state.status === 'sending' ? 'Waiting for the server…' : 'No result.'}
            </p>
          ) : (
            <McpResultView method={exchange.method} result={exchange.result} error={exchange.error} />
          ))}
        {tab === 'messages' && (
          <McpMessagesView
            messages={messages}
            startedAt={exchange?.startedAt ?? state.startedAt ?? messages[0]?.at ?? ''}
            transport={exchange?.transport.type ?? transport ?? 'stdio'}
            droppedMessages={exchange?.droppedMessages}
            httpCalls={exchange?.httpCalls}
            stderr={exchange?.stderr}
            stderrTruncated={exchange?.stderrTruncated}
            exitCode={exchange?.exitCode}
            exitSignal={exchange?.exitSignal}
          />
        )}
        {tab === 'assertions' && <AssertionResults assertions={exchange?.assertions} />}
      </div>
    </section>
  );
}
