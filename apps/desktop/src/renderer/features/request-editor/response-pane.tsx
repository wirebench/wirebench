import { Loader2 } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { setActiveResponseEditor } from '../../editor/active-response-editor.js';
import { FOCUS_OTHER_PANE_KEYBINDING } from '../../editor/monaco.js';
import { focusOtherPane } from './pane-focus.js';
import { EmptyState } from '../../components/empty-state.js';
import { XmlEditor } from '../../editor/xml-editor.js';
import { decodeBase64Text } from '../../lib/format-size.js';
import { prettyPrintXml } from '../../editor/xml-language.js';
import type { ExchangeState } from '../../state/exchanges.js';
import { useEditorsStore } from '../../state/editors.js';
import { usePreferencesStore } from '../../state/preferences.js';
import type { ResponseViewType } from '../../state/editors.js';
import { InspectorStrip, type InspectorItem } from './inspectors/inspector-strip.js';
import { WssInspector, wssTabLabel } from './inspectors/wss-inspector.js';
import { ResponseAttachmentsInspector } from './inspectors/response-attachments-inspector.js';
import { ResponseHeadersInspector } from './inspectors/response-headers-inspector.js';
import { SslInspector } from './inspectors/ssl-inspector.js';
import { ResponseStatus } from './response-status.js';
import { ViewTabs } from './view-tabs.js';
import type { ViewTabItem } from './view-tabs.js';
import { FaultOverview, OutlineView, prefetchViews, QueryView, RawView, ViewFallback } from './views/lazy-views.js';
import type { TextRange } from './views/xml-model.js';

/** Converts a 0-based UTF-16 offset into a 1-based Monaco line/column — mirrors `request-pane.tsx`'s
 * copy: the renderer may only import the browser-safe `xml` subpath, not the Node-only `LineIndex`. */
function offsetToPosition(text: string, offset: number): { lineNumber: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { lineNumber: line, column: offset - lineStart + 1 };
}

/**
 * The response pane's inspector strip.
 *
 * The Attachments tab carries its count (`Attachments (2)`), and the WSS tab a ✓/✗ badge,
 * because their emptiness (or outcome) is a property of the *response* rather than of the app:
 * without the badge you would have to open the tab to learn a send brought parts back, or that
 * a signature did not hold.
 */
function responseInspectors(attachmentCount: number, wssLabel: string): readonly InspectorItem[] {
  return [
    { id: 'headers', label: 'Headers' },
    { id: 'attachments', label: attachmentCount > 0 ? `Attachments (${String(attachmentCount)})` : 'Attachments' },
    { id: 'wss', label: wssLabel },
    { id: 'ssl', label: 'SSL Info' },
  ];
}

export interface ResponsePaneProps {
  readonly state: ExchangeState | undefined;
  /** Which interface's schema to resolve the Outline's Type column against. */
  readonly interfaceId?: string;
  /** Keys the persisted selected tab, the Raw view's "last exchange", and the Query history. */
  readonly requestId: string;
}

/** The response half: status line, then the formatted envelope (or the raw body, or nothing yet). */
export function ResponsePane({ state, interfaceId, requestId }: ResponsePaneProps) {
  const exchange = state?.exchange;
  const response = exchange?.response;
  const fault = response?.fault;

  const view = useEditorsStore((s) => s.responseViewFor(requestId));
  const setView = useEditorsStore((s) => s.setResponseView);
  const revealFaultTab = useEditorsStore((s) => s.revealFaultTab);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const pendingSelectionRef = useRef<TextRange | undefined>(undefined);

  // "Format responses" is a preference: with it off the envelope is shown exactly as it came
  // off the wire, which is what you want when the server's own formatting is the thing under
  // inspection.
  const autoFormat = usePreferencesStore((state) => state.preferences.editor.autoFormatResponses);
  const tabSize = usePreferencesStore((state) => state.preferences.editor.tabSize);
  const body = useMemo(() => {
    if (exchange === undefined) {
      return '';
    }
    if (response?.isSoap === true) {
      return autoFormat ? prettyPrintXml(response.envelopeXml, tabSize) : response.envelopeXml;
    }
    return decodeBase64Text(exchange.http.bodyBase64) ?? '';
  }, [exchange, response, autoFormat, tabSize]);

  // Warm the view chunks as soon as the pane exists, so the first click on Raw, Outline, Query
  // or Fault renders synchronously instead of suspending. Idempotent; the request pane does the
  // same, and whichever mounts first pays for it.
  useEffect(() => {
    prefetchViews();
  }, []);

  // A fault just arrived: switch to the Fault tab, unless the user already pinned another one.
  // `status` is in the deps (not just `sendId`) because a send's `sendId` is assigned once, at
  // `'sending'`, and does not change again when it later resolves to `'done'` with a fault.
  const status = state?.status;
  useEffect(() => {
    if (fault !== undefined) {
      revealFaultTab(requestId);
    }
    // `revealFaultTab`'s identity is stable (a zustand store action), so it is intentionally
    // left out of the deps array.
  }, [status, fault, requestId]);

  const handleReveal = useCallback(
    (range: TextRange) => {
      pendingSelectionRef.current = range;
      setView(requestId, 'xml');
    },
    [requestId, setView],
  );

  const handleMount = useCallback<OnMount>(
    (editor) => {
      editorRef.current = editor;
      setActiveResponseEditor(editor);
      // ⇧⇥ back to the request editor; see `FOCUS_OTHER_PANE_KEYBINDING` for why the binding
      // has to live on the editor and not only on the window.
      editor.addCommand(FOCUS_OTHER_PANE_KEYBINDING, () => {
        focusOtherPane();
      });
      const pending = pendingSelectionRef.current;
      if (pending !== undefined) {
        pendingSelectionRef.current = undefined;
        const start = offsetToPosition(body, pending.start);
        const end = offsetToPosition(body, pending.end);
        const selection = {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        };
        editor.setSelection(selection);
        editor.revealRangeInCenter(selection);
      }
    },
    [body],
  );

  useEffect(
    () => () => {
      setActiveResponseEditor(undefined);
    },
    [],
  );

  const views: ViewTabItem[] = [
    { id: 'xml', label: 'XML' },
    { id: 'outline', label: 'Outline' },
    { id: 'raw', label: 'Raw' },
    { id: 'query', label: 'Query' },
    ...(fault !== undefined ? [{ id: 'fault', label: 'Fault' }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline">
        <ViewTabs
          label="Response views"
          items={views}
          active={view}
          onSelect={(id) => setView(requestId, id as ResponseViewType)}
        />
        <div className="min-w-0 flex-1">
          <ResponseStatus exchange={exchange} error={state?.error} />
        </div>
      </div>

      <div data-testid="response-editor" className="min-h-0 flex-1">
        <Suspense fallback={<ViewFallback />}>
          {state?.status === 'sending' ? (
            <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              Sending… (Esc to cancel)
            </div>
          ) : view === 'raw' ? (
            <RawView
              base64={exchange?.http.rawResponseBase64}
              ariaLabel="Response raw bytes"
              emptyTitle="No response yet"
              emptyDescription="Send this request to see the raw bytes."
            />
          ) : view === 'query' ? (
            <QueryView requestId={requestId} xml={body} onReveal={handleReveal} />
          ) : view === 'fault' && fault !== undefined ? (
            <FaultOverview fault={fault} />
          ) : exchange === undefined ? (
            <EmptyState
              title="No response yet"
              description={
                state?.error !== undefined
                  ? 'The last send did not complete. Fix the problem above and send again.'
                  : 'Send this request to see the response envelope, timings, and the raw exchange.'
              }
            />
          ) : response?.isSoap === true && view === 'outline' ? (
            <OutlineView xml={body} interfaceId={interfaceId} readOnly />
          ) : response?.isSoap === true ? (
            <XmlEditor ariaLabel="Response envelope XML" value={body} onMount={handleMount} readOnly />
          ) : (
            <pre className="h-full overflow-auto p-3 font-mono text-sm break-words whitespace-pre-wrap text-fg-default">
              {body}
            </pre>
          )}
        </Suspense>
      </div>

      <InspectorStrip
        requestId={requestId}
        pane="response"
        label="Response inspectors"
        items={responseInspectors(response?.attachments.length ?? 0, wssTabLabel(exchange))}
        render={(inspector) =>
          inspector === 'headers' ? (
            <ResponseHeadersInspector exchange={exchange} />
          ) : inspector === 'ssl' ? (
            <SslInspector http={exchange?.http} />
          ) : inspector === 'attachments' ? (
            <ResponseAttachmentsInspector exchange={exchange} />
          ) : (
            <WssInspector exchange={exchange} requestId={requestId} />
          )
        }
      />
    </div>
  );
}
