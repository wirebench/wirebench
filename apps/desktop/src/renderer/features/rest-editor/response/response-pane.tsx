/**
 * The REST response half: the status line, then one of the response tabs.
 *
 * The tabs are the ones §3.3 fixes — Body, Headers, Cookies, Redirects, Timing, TLS, Raw and Query —
 * and each says what it is about even when there is nothing to show, because "no cookies" and "no
 * response yet" are different answers and the user is entitled to tell them apart.
 *
 * *Save response* goes through a channel that takes only the send id: the bytes stay in main and the
 * file is chosen by the user in a native dialog, exactly as a SOAP attachment's save does.
 */
import { useState } from 'react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import { Tabs } from '../../../components/tabs.js';
import { ipc } from '../../../state/ipc-client.js';
import type { RestExchangeState } from '../../../state/exchanges.js';
import { SslInspector } from '../../request-editor/inspectors/ssl-inspector.js';
import { TimingsBar } from '../../console/timings-bar.js';
import { BodyView } from './body-view.js';
import { CookiesView } from './cookies-view.js';
import { RedirectsView } from './redirects-view.js';
import { ResponseHeadersView } from './headers-view.js';
import { StatusLine } from './status-line.js';

/** The response tabs, in order. */
const TABS = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'redirects', label: 'Redirects' },
  { id: 'timing', label: 'Timing' },
  { id: 'tls', label: 'TLS' },
  { id: 'raw', label: 'Raw' },
  { id: 'query', label: 'Query' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface RestResponsePaneProps {
  readonly state: RestExchangeState | undefined;
}

/** The response pane. */
export function RestResponsePane({ state }: RestResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('body');
  const exchange = state?.exchange;
  const sending = state?.status === 'sending';

  /** The tab counts that are worth showing before the tab is opened. */
  const items = TABS.map((item) => {
    if (item.id === 'cookies' && exchange !== undefined && exchange.cookies.length > 0) {
      return { ...item, badge: String(exchange.cookies.length) };
    }
    if (item.id === 'redirects' && exchange !== undefined && (exchange.http.redirects ?? []).length > 0) {
      return { ...item, badge: String((exchange.http.redirects ?? []).length) };
    }
    return item;
  });

  return (
    <section aria-label="Response" data-testid="rest-response" className="flex h-full min-h-0 flex-col">
      <div className="flex h-row shrink-0 items-center gap-2 border-b border-hairline">
        <div className="min-w-0 flex-1">
          <StatusLine
            {...(exchange !== undefined ? { exchange } : {})}
            {...(state?.error !== undefined ? { error: state.error } : {})}
            sending={sending}
          />
        </div>
        {exchange !== undefined && (
          <Button
            variant="secondary"
            data-testid="rest-response-save"
            onClick={() => {
              void ipc()
                .exchanges.saveRestBody({ sendId: exchange.sendId })
                .then((result) => {
                  if (!result.ok) {
                    showToast(result.error.message);
                    return;
                  }
                  if ('path' in result.value) {
                    showToast(`Saved to ${result.value.path}`);
                  }
                });
            }}
          >
            Save response…
          </Button>
        )}
      </div>

      {exchange === undefined ? (
        <p className="p-3 text-sm text-fg-subtle">{sending ? 'Sending…' : 'Send the request to see its response.'}</p>
      ) : (
        <>
          <Tabs label="Response tabs" items={items} active={tab} onSelect={setTab} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'body' && <BodyView exchange={exchange} />}
            {tab === 'headers' && <ResponseHeadersView exchange={exchange} />}
            {tab === 'cookies' && <CookiesView exchange={exchange} />}
            {tab === 'redirects' && <RedirectsView exchange={exchange} />}
            {tab === 'timing' && (
              <div data-testid="rest-response-timing" className="overflow-auto">
                <TimingsBar timings={exchange.http.timings} />
              </div>
            )}
            {tab === 'tls' && (
              <div data-testid="rest-response-tls" className="overflow-auto">
                {/* The SSL inspector reads only `http`, which both protocols' exchanges share, so a
                    REST exchange is accepted as it is. */}
                <SslInspector exchange={exchange} />
              </div>
            )}
            {tab === 'raw' && <RawExchange exchange={exchange} />}
            {tab === 'query' && (
              <p data-testid="rest-response-query" className="p-3 text-sm text-fg-subtle">
                Querying a response with JSONPath or XPath arrives with the round-out task.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The reconstructed request and response bytes, as they went over the wire. */
function RawExchange({ exchange }: { readonly exchange: NonNullable<RestExchangeState['exchange']> }) {
  const decode = (base64: string): string => {
    try {
      // `atob`'s binary string maps each byte to the same-valued code unit, which is what raw wire
      // bytes want: decoding as UTF-8 would corrupt a body that is not valid UTF-8.
      return atob(base64);
    } catch {
      return '';
    }
  };

  return (
    <div data-testid="rest-response-raw-exchange" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">Request</h3>
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-fg-default">
          {decode(exchange.http.rawRequestBase64)}
        </pre>
      </section>
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">Response</h3>
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-fg-default">
          {decode(exchange.http.rawResponseBase64)}
        </pre>
      </section>
    </div>
  );
}
