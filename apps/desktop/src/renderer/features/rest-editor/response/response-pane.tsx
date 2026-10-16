/**
 * The REST response half: the status line, then one of the response tabs.
 *
 * The tabs are the ones §3.3 fixes — Body, Headers, Cookies, Redirects, Timing, TLS, Exchange and Query —
 * and each says what it is about even when there is nothing to show, because "no cookies" and "no
 * response yet" are different answers and the user is entitled to tell them apart.
 *
 * *Save response* goes through a channel that takes only the send id: the bytes stay in main and the
 * file is chosen by the user in a native dialog, exactly as a SOAP attachment's save does.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useContractRevealStore } from './contract.js';
import { Download } from 'lucide-react';
import { showToast } from '../../../components/toast.js';
import { SendErrorPanel } from '../../../components/send-error-panel.js';
import { Tabs } from '../../../components/tabs.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import type { RestExchangeState } from '../../../state/exchanges.js';
import { InspectorIconButton } from '../../request-editor/inspectors/inspector-strip.js';
import { SslInspector } from '../../request-editor/inspectors/ssl-inspector.js';
import { QueryView } from '../../request-editor/views/lazy-views.js';
import { TimingsBar } from '../../console/timings-bar.js';
import { BodyView } from './body-view.js';
import { EventsView, eventsDocument } from './events-view.js';
import { CookiesView } from './cookies-view.js';
import { RedirectsView } from './redirects-view.js';
import { ResponseHeadersView } from './headers-view.js';
import { StatusLine } from './status-line.js';
import { responseHeadersBadge } from '../tab-counts.js';
import { ExampleResponse, ExamplesMenu } from './examples-menu.js';
import { SnapshotPanel } from '../../snapshot/snapshot-panel.js';
import { AssertionResults, assertionResultsBadge } from '../../assertions/assertion-results.js';
import { hasScriptResults, ScriptResults, scriptResultsBadge } from '../../scripts/script-results.js';

/** The response tabs, in order. An event stream swaps Body for Events, first. */
const TABS = [
  { id: 'events', label: 'Events' },
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'redirects', label: 'Redirects' },
  { id: 'timing', label: 'Timing' },
  { id: 'tls', label: 'TLS' },
  // The wire bytes of both directions: "Exchange", not "Raw", which is the body's own line-by-line view.
  { id: 'exchange', label: 'Exchange' },
  { id: 'query', label: 'Query' },
  { id: 'assertions', label: 'Assertions' },
  { id: 'script', label: 'Script' },
  { id: 'snapshot', label: 'Snapshot' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface RestResponsePaneProps {
  readonly state: RestExchangeState | undefined;
  /** The request this response belongs to, which keys the Query view's own expression history. */
  readonly requestId: string;
  /** Sends the request again from a failed send's panel; absent hides Retry. */
  readonly onRetry?: (() => void) | undefined;
  /** Why Retry cannot run now (the same reason Send is disabled). */
  readonly retryDisabledReason?: string | undefined;
  /** Opens the request's Settings tab, where its timeout is set. */
  readonly onOpenTimeoutSetting?: (() => void) | undefined;
  /** Shows the field an unresolved `${name}` was written in. */
  readonly onRevealReference?: ((ref: string) => void) | undefined;
  /** Names the field a reference was written in, for an unclosed `${`. */
  readonly describeReferenceField?: ((ref: string) => string | undefined) | undefined;
}

/** The response pane. */
export function RestResponsePane({
  state,
  requestId,
  onRetry,
  retryDisabledReason,
  onOpenTimeoutSetting,
  onRevealReference,
  describeReferenceField,
}: RestResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('body');
  const sending = state?.status === 'sending';
  // While a plain send is out, the last response stays on screen, dimmed under the Sending bar,
  // rather than the pane going blank until the new one lands.
  const stale = sending && state?.exchange === undefined && state?.live === undefined ? state?.previous : undefined;
  const exchange = state?.exchange ?? stale;
  // While an event stream is open there is no exchange yet, only the live half; once the send
  // resolves the exchange's `stream` replaces it with the same rows.
  const live = exchange === undefined ? state?.live : undefined;
  const stream = exchange?.stream;
  const isStream = stream !== undefined || live !== undefined;
  // A Problems row revealing a contract problem needs the body on screen first.
  const revealPending = useContractRevealStore((store) => store.pending?.requestId === requestId);
  useEffect(() => {
    if (revealPending) {
      setTab('body');
    }
  }, [revealPending]);
  // The example on show, and the send it was chosen over: a new send has a new id, so starting
  // one puts the live response back without an effect having to notice.
  const examples = useProjectStore((store) => store.restRequests[requestId]?.examples);
  const removeRestExample = useProjectStore((store) => store.removeRestExample);
  const [shown, setShown] = useState<{ readonly exampleId: string; readonly sendId: string | undefined }>();
  const shownExample =
    shown !== undefined && shown.sendId === state?.sendId
      ? examples?.find((example) => example.id === shown.exampleId)
      : undefined;

  const activeTab: TabId = isStream ? (tab === 'body' ? 'events' : tab) : tab === 'events' ? 'body' : tab;

  // Built once per set of rows, not on every render of a pane that re-renders per event.
  const queryDocument = useMemo(() => (stream !== undefined ? eventsDocument(stream.rows) : undefined), [stream]);
  // While live only Events and the Headers the stream opened with exist; the rest need the exchange.
  const liveTab: TabId = tab === 'headers' ? 'headers' : 'events';

  /** The tab counts that are worth showing before the tab is opened. */
  const available = TABS.filter((item) =>
    live !== undefined
      ? item.id === 'events' || item.id === 'headers'
      : (isStream ? item.id !== 'body' : item.id !== 'events') &&
        (item.id !== 'script' || (exchange !== undefined && hasScriptResults(exchange))),
  );
  const items = available.map((item) => {
    if (item.id === 'events') {
      const total = stream !== undefined ? streamRowTotal(stream) : (live?.rows.length ?? 0) + (live?.droppedRows ?? 0);
      return total > 0 ? { ...item, badge: String(total) } : item;
    }
    if (item.id === 'assertions') {
      const verdict = assertionResultsBadge(exchange?.assertions);
      if (verdict === undefined) {
        return item;
      }
      // Once assertions ran, their verdict never hides behind More, and a failure reads in red.
      return {
        ...item,
        label: verdict.failed ? 'Assertions ✕' : item.label,
        badge: verdict.text,
        pinned: true,
        ...(verdict.failed ? { tone: 'danger' as const } : {}),
      };
    }
    if (item.id === 'script') {
      const badge = scriptResultsBadge(exchange?.script);
      return badge !== undefined ? { ...item, badge } : item;
    }
    if (item.id === 'headers') {
      const badge =
        exchange !== undefined
          ? responseHeadersBadge(exchange.http)
          : live?.headers !== undefined
            ? responseHeadersBadge({ headers: live.headers })
            : undefined;
      return badge !== undefined ? { ...item, badge } : item;
    }
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
            live={live}
            startedAt={state?.startedAt}
          />
        </div>
        <ExamplesMenu
          examples={examples ?? []}
          onShow={(exampleId) => {
            setShown({ exampleId, sendId: state?.sendId });
          }}
        />
        {exchange !== undefined && stale === undefined && shownExample === undefined && (
          <InspectorIconButton
            label="Save response…"
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
            <Download size={13} aria-hidden="true" />
          </InspectorIconButton>
        )}
      </div>

      {shownExample !== undefined ? (
        <ExampleResponse
          example={shownExample}
          onClose={() => {
            setShown(undefined);
          }}
          onDelete={() => {
            const exampleId = shownExample.id;
            void removeRestExample(requestId, exampleId).then(
              () => {
                setShown(undefined);
              },
              (error: unknown) => {
                showToast(error instanceof Error ? error.message : String(error));
              },
            );
          }}
        />
      ) : live !== undefined ? (
        <>
          <Tabs label="Response tabs" items={items} active={liveTab} onSelect={setTab} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {liveTab === 'events' ? (
              <EventsView rows={live.rows} droppedRows={live.droppedRows} />
            ) : (
              <ResponseHeadersView headers={live.headers ?? {}} />
            )}
          </div>
        </>
      ) : exchange === undefined && state?.error !== undefined && !sending ? (
        <SendErrorPanel
          error={state.error}
          onRetry={onRetry}
          retryDisabledReason={retryDisabledReason}
          onOpenTimeoutSetting={onOpenTimeoutSetting}
          onRevealReference={onRevealReference}
          describeReferenceField={describeReferenceField}
        />
      ) : exchange === undefined ? (
        // The bar above already says "Sending…"; the pane says it only once.
        sending ? null : (
          <p className="p-3 text-sm text-fg-subtle">Send the request to see its response.</p>
        )
      ) : (
        <div
          data-testid="rest-response-view"
          className={`flex min-h-0 flex-1 flex-col transition-opacity ${stale !== undefined ? 'opacity-50' : ''}`}
          {...(stale !== undefined ? { 'aria-busy': true, 'data-stale': '' } : {})}
        >
          <Tabs label="Response tabs" items={items} active={activeTab} onSelect={setTab} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'events' && stream !== undefined && (
              <EventsView rows={stream.rows} droppedRows={stream.droppedRows} omittedRows={stream.omittedRows} />
            )}
            {activeTab === 'body' && <BodyView exchange={exchange} requestId={requestId} />}
            {activeTab === 'headers' && <ResponseHeadersView exchange={exchange} />}
            {activeTab === 'cookies' && <CookiesView exchange={exchange} />}
            {activeTab === 'redirects' && (
              <RedirectsView http={exchange.http} method={exchange.method} methodChanged={exchange.methodChanged} />
            )}
            {activeTab === 'timing' && (
              <div data-testid="rest-response-timing" className="overflow-auto">
                <TimingsBar timings={exchange.http.timings} />
              </div>
            )}
            {activeTab === 'tls' && (
              <div data-testid="rest-response-tls" className="overflow-auto">
                {/* The SSL inspector reads only `http`, which both protocols' exchanges share, so a
                    REST exchange is accepted as it is. */}
                <SslInspector http={exchange.http} />
              </div>
            )}
            {activeTab === 'exchange' && <RawExchange exchange={exchange} />}
            {activeTab === 'assertions' && <AssertionResults assertions={exchange.assertions} />}
            {activeTab === 'script' && <ScriptResults script={exchange.script} scriptsOff={exchange.scriptsOff} />}
            {activeTab === 'snapshot' && (
              <SnapshotPanel
                requestId={requestId}
                body={exchange.text}
                binary={exchange.text === '' || exchange.language === 'image' || exchange.language === 'binary'}
                {...(exchange.http.headers['content-type'] !== undefined
                  ? { contentType: exchange.http.headers['content-type'] }
                  : {})}
              />
            )}
            {activeTab === 'query' && (
              <div data-testid="rest-response-query" className="min-h-0 flex-1">
                {/* The same view the SOAP response uses, over whichever document this response is:
                    a JSON body opens on JSONPath, with XPath 3.1 (maps, arrays, `?` lookup) beside
                    it. A body with no text form has nothing to query. */}
                {queryDocument !== undefined ? (
                  <Suspense fallback={<p className="p-3 text-sm text-fg-subtle">Loading…</p>}>
                    <QueryView requestId={requestId} xml={queryDocument} documentKind="json" />
                  </Suspense>
                ) : exchange.text === '' ? (
                  <p className="p-3 text-sm text-fg-subtle">
                    This response has no text to query ({exchange.language}).
                  </p>
                ) : (
                  <Suspense fallback={<p className="p-3 text-sm text-fg-subtle">Loading…</p>}>
                    <QueryView
                      requestId={requestId}
                      xml={exchange.text}
                      documentKind={exchange.language === 'xml' || exchange.language === 'html' ? 'xml' : 'json'}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </div>
        </div>
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
    <div data-testid="rest-response-exchange" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
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
        {exchange.stream !== undefined && (
          <p data-testid="rest-response-exchange-stream" className="mt-1 text-xs text-fg-subtle">
            {`The body is an event stream of ${String(streamRowTotal(exchange.stream))} rows, shown under Events; its raw bytes are not kept.`}
          </p>
        )}
      </section>
    </div>
  );
}

/** Every row the stream produced: the kept rows plus the ones let go or left out of the summary. */
function streamRowTotal(stream: NonNullable<NonNullable<RestExchangeState['exchange']>['stream']>): number {
  return stream.rows.length + stream.droppedRows + stream.omittedRows;
}
