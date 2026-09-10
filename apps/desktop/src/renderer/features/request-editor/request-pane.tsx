import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { setActiveRequestEditor } from '../../editor/active-request-editor.js';
import { FORMAT_KEYBINDING, GOTO_LINE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import { XmlEditor } from '../../editor/xml-editor.js';
import { ipcCompletionSource } from '../../editor/xml-completion-source.js';
import { formatEditorInPlace, gotoLine, registerXmlLanguageFeaturesOnce } from '../../editor/xml-language.js';
import { useEditorsStore } from '../../state/editors.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';
import { HeadersInspector } from './inspectors/headers-inspector.js';
import { InspectorPlaceholder, InspectorStrip, type InspectorItem } from './inspectors/inspector-strip.js';
import { SslInspector } from './inspectors/ssl-inspector.js';
import { OverflowMenu } from './overflow-menu.js';
import { ViewTabs } from './view-tabs.js';
import { FormView } from './views/form-view.js';
import { OutlineView } from './views/outline-view.js';
import { RawView } from './views/raw-view.js';
import { applyValueEdit, type TextRange } from './views/xml-model.js';

/** Long enough that a burst of keystrokes is one store write, short enough to feel immediate. */
const DEBOUNCE_MS = 120;

/** The request pane's inspector strip. Attachments/Auth/WS-A are placeholders until their tasks land. */
const REQUEST_INSPECTORS: readonly InspectorItem[] = [
  { id: 'headers', label: 'Headers' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'auth', label: 'Auth' },
  { id: 'wsa', label: 'WS-A' },
  { id: 'ssl', label: 'SSL' },
];

const VIEWS = [
  { id: 'xml', label: 'XML' },
  { id: 'form', label: 'Form' },
  { id: 'outline', label: 'Outline' },
  { id: 'raw', label: 'Raw' },
] as const;

/** Converts a 0-based UTF-16 offset into a 1-based Monaco line/column, without pulling in the
 * Node-only engine `LineIndex` (the renderer may only import the browser-safe `xml` subpath). */
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

export interface RequestPaneProps {
  /** The request draft this pane edits — keys the persisted Form view type in the editors store. */
  readonly requestId: string;
  readonly envelopeXml: string;
  readonly onEnvelopeChange: (xml: string) => void;
  /** Run when ⌘⏎ is pressed while the editor has focus — Monaco owns those keys, not the window. */
  readonly onSend: () => void;
  /** Backs the completion/"go to declaration" IPC calls: which interface's `SchemaSet` to query. */
  readonly interfaceId: string;
  /** Clark-notation binding QName; with `operationName` it tells the Form view which body to model. */
  readonly bindingName: string;
  readonly operationName: string;
}

/** Imperative escape hatch for callers that must flush a pending debounced edit synchronously. */
export interface RequestPaneHandle {
  /** Writes any not-yet-committed edit to the store immediately. Safe to call when there is none. */
  flush: () => void;
  /** Formats the editor's content and commits the formatted text immediately. */
  formatAndCommit: () => void;
}

/** The request half: the editable SOAP envelope, plus the (mostly future) view strip. */
export const RequestPane = forwardRef<RequestPaneHandle, RequestPaneProps>(function RequestPane(
  { requestId, envelopeXml, onEnvelopeChange, onSend, interfaceId, bindingName, operationName }: RequestPaneProps,
  ref,
) {
  const [local, setLocal] = useState(envelopeXml);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const lineNumbers = useUiStore((state) => state.editorLineNumbers);
  const exchange = useExchangesStore((state) => state.byRequest[requestId]?.exchange);
  const rawRequestBase64 = exchange?.http.rawRequestBase64;
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('xml');
  // The Form view type is editor state, not project data — it never reaches the saved request
  // file — but it is keyed by `requestId` in the editors store (not local component state) so
  // it survives this pane remounting (a tab switch, or the pane unmounting while its tab stays
  // open in the background) instead of resetting to 'full' every time.
  const formViewType = useEditorsStore((state) => state.formViewTypeFor(requestId));
  const setFormViewType = useEditorsStore((state) => state.setFormViewType);
  // Set by an Outline row selection; consumed once when the XML view remounts so the editor's
  // selection follows the row the user was just looking at.
  const pendingSelectionRef = useRef<TextRange | undefined>(undefined);

  // The latest text the editor holds, kept outside React state so flush() can read it
  // synchronously even mid-render (e.g. from an unmount cleanup or an event handler).
  const pendingRef = useRef<{ xml: string; onEnvelopeChange: (xml: string) => void } | undefined>(undefined);
  const onEnvelopeChangeRef = useRef(onEnvelopeChange);
  onEnvelopeChangeRef.current = onEnvelopeChange;

  // The last text this pane itself sent to the store. An incoming `envelopeXml` that matches
  // it is this pane's own edit echoing back through the mirror; anything else came from
  // outside (Recreate, Clone, Load from…) and must win — see the external-replace effect below.
  const committedRef = useRef(envelopeXml);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const pending = pendingRef.current;
    if (pending === undefined) {
      return;
    }
    pendingRef.current = undefined;
    committedRef.current = pending.xml;
    pending.onEnvelopeChange(pending.xml);
  }, []);

  // Commits an edit to the store immediately, bypassing the debounce — used by Format and Load
  // from…, which replace the whole buffer in one deliberate act rather than a keystroke burst.
  const commitNow = useCallback((next: string) => {
    setLocal(next);
    clearTimeout(timer.current);
    pendingRef.current = undefined;
    committedRef.current = next;
    onEnvelopeChangeRef.current(next);
  }, []);

  const formatAndCommit = useCallback(() => {
    const editor = editorRef.current;
    if (editor !== undefined) {
      formatEditorInPlace(editor, usePreferencesStore.getState().preferences.editor.tabSize);
      const value = editor.getModel()?.getValue();
      if (value !== undefined) {
        commitNow(value);
      }
    }
  }, [commitNow]);

  useImperativeHandle(ref, () => ({ flush, formatAndCommit }), [flush, formatAndCommit]);

  // An envelope replaced from OUTSIDE this pane (Recreate, Clone, Load from…) must win over
  // both the local copy and any still-debounced keystroke: without dropping the pending edit,
  // the timer would fire a moment later and write the old text back over the new one (the
  // Task 15 ruling). An `envelopeXml` this pane itself committed is not such a replacement —
  // it is the mirror echoing that very edit back, and a keystroke made since must survive it.
  useEffect(() => {
    if (envelopeXml === committedRef.current) {
      return;
    }
    clearTimeout(timer.current);
    pendingRef.current = undefined;
    committedRef.current = envelopeXml;
    setLocal(envelopeXml);
  }, [envelopeXml]);

  useEffect(
    () => () => {
      // Flush, don't discard: unmounting (closing the tab, switching requests) must not drop
      // an edit that hasn't reached the store yet.
      flush();
      setActiveRequestEditor(undefined);
    },
    [flush],
  );

  const handleChange = useCallback((next: string) => {
    setLocal(next);
    clearTimeout(timer.current);
    pendingRef.current = { xml: next, onEnvelopeChange: onEnvelopeChangeRef.current };
    timer.current = setTimeout(() => {
      pendingRef.current = undefined;
      committedRef.current = next;
      onEnvelopeChangeRef.current(next);
    }, DEBOUNCE_MS);
  }, []);

  const handleMount = useCallback<OnMount>(
    (editor, monacoNS) => {
      const handle: RequestPaneHandle = { flush, formatAndCommit };
      editor.addCommand(SEND_KEYBINDING, () => {
        flush();
        sendRef.current();
      });
      editor.addCommand(FORMAT_KEYBINDING, () => {
        formatAndCommit();
      });
      editor.addCommand(GOTO_LINE_KEYBINDING, () => {
        gotoLine(editor);
      });
      editorRef.current = editor;
      setActiveRequestEditor(editor, interfaceId, handle);
      // `monacoNS.languages` is absent from the lightweight test double swapped in under jsdom
      // (see `test/mocks/monaco-editor-react.tsx`); the real Monaco always has it.
      if ((monacoNS as { languages?: unknown }).languages !== undefined) {
        registerXmlLanguageFeaturesOnce(monacoNS as typeof Monaco, () => ipcCompletionSource(interfaceId));
      }
      // An Outline row selected just before switching back to XML: reveal the same range now
      // that the editor exists again.
      const pending = pendingSelectionRef.current;
      if (pending !== undefined) {
        pendingSelectionRef.current = undefined;
        const start = offsetToPosition(local, pending.start);
        const end = offsetToPosition(local, pending.end);
        editor.setSelection({
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        });
      }
    },
    [flush, formatAndCommit, interfaceId, local],
  );

  // The outline writes back through the very same path as typing: apply the edit to the current
  // text, then commit it immediately (bypassing the debounce, like Format does) so `flush()`'s
  // "nothing pending" invariant still holds afterwards.
  const handleOutlineEdit = useCallback(
    (range: TextRange, value: string) => {
      commitNow(applyValueEdit(local, range, value));
    },
    [commitNow, local],
  );

  const handleOutlineSelectRange = useCallback((range: TextRange) => {
    pendingSelectionRef.current = range;
  }, []);

  return (
    <div data-testid="request-pane" className="flex h-full min-h-0 flex-col border-r border-hairline">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline">
        <ViewTabs label="Request views" items={VIEWS} active={view} onSelect={(id) => setView(id as typeof view)} />
        <div className="flex items-center gap-1">
          <span className="px-2 text-xs text-fg-faint">Request</span>
          <OverflowMenu currentText={local} onLoaded={commitNow} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'form' ? (
          <FormView
            xml={local}
            interfaceId={interfaceId}
            bindingName={bindingName}
            operationName={operationName}
            onValueEdit={handleOutlineEdit}
            onEnvelopeReplace={commitNow}
            viewType={formViewType}
            onViewTypeChange={(next) => setFormViewType(requestId, next)}
          />
        ) : view === 'outline' ? (
          <OutlineView
            xml={local}
            interfaceId={interfaceId}
            readOnly={false}
            onEdit={handleOutlineEdit}
            onSelectRange={handleOutlineSelectRange}
          />
        ) : view === 'raw' ? (
          <RawView
            base64={rawRequestBase64}
            ariaLabel="Request raw bytes"
            emptyTitle="No request sent yet"
            emptyDescription="Send this request to see the raw bytes."
          />
        ) : (
          <XmlEditor
            ariaLabel="Request envelope XML"
            value={local}
            onChange={handleChange}
            onMount={handleMount}
            lineNumbers={lineNumbers}
            contextMenu={false}
          />
        )}
      </div>
      <InspectorStrip
        requestId={requestId}
        pane="request"
        label="Request inspectors"
        items={REQUEST_INSPECTORS}
        render={(inspector) =>
          inspector === 'headers' ? (
            <HeadersInspector requestId={requestId} />
          ) : inspector === 'ssl' ? (
            <SslInspector exchange={exchange} />
          ) : inspector === 'attachments' ? (
            <InspectorPlaceholder name="Attachments" task={32} />
          ) : inspector === 'auth' ? (
            <InspectorPlaceholder name="Auth" task={34} />
          ) : (
            <InspectorPlaceholder name="WS-Addressing" task={41} />
          )
        }
      />
    </div>
  );
});
