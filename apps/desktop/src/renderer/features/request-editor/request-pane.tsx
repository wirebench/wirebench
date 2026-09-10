import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { setActiveRequestEditor } from '../../editor/active-request-editor.js';
import { FORMAT_KEYBINDING, GOTO_LINE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import { XmlEditor } from '../../editor/xml-editor.js';
import { ipcCompletionSource } from '../../editor/xml-completion-source.js';
import { formatEditorInPlace, gotoLine, registerXmlLanguageFeaturesOnce } from '../../editor/xml-language.js';
import { useUiStore } from '../../state/ui.js';
import { OverflowMenu } from './overflow-menu.js';
import { ViewTabs } from './view-tabs.js';

/** Long enough that a burst of keystrokes is one store write, short enough to feel immediate. */
const DEBOUNCE_MS = 120;

const LATER = 'Arrives in Task 26/27/28';

const VIEWS = [
  { id: 'xml', label: 'XML' },
  { id: 'form', label: 'Form', disabledReason: LATER },
  { id: 'outline', label: 'Outline', disabledReason: LATER },
  { id: 'raw', label: 'Raw', disabledReason: LATER },
] as const;

export interface RequestPaneProps {
  readonly envelopeXml: string;
  readonly onEnvelopeChange: (xml: string) => void;
  /** Run when ⌘⏎ is pressed while the editor has focus — Monaco owns those keys, not the window. */
  readonly onSend: () => void;
  /** Backs the completion/"go to declaration" IPC calls: which interface's `SchemaSet` to query. */
  readonly interfaceId: string;
}

/** Imperative escape hatch for callers that must flush a pending debounced edit synchronously. */
export interface RequestPaneHandle {
  /** Writes any not-yet-committed edit to the store immediately. Safe to call when there is none. */
  flush: () => void;
}

/** The request half: the editable SOAP envelope, plus the (mostly future) view strip. */
export const RequestPane = forwardRef<RequestPaneHandle, RequestPaneProps>(function RequestPane(
  { envelopeXml, onEnvelopeChange, onSend, interfaceId }: RequestPaneProps,
  ref,
) {
  const [local, setLocal] = useState(envelopeXml);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const lineNumbers = useUiStore((state) => state.editorLineNumbers);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);

  // The latest text the editor holds, kept outside React state so flush() can read it
  // synchronously even mid-render (e.g. from an unmount cleanup or an event handler).
  const pendingRef = useRef<{ xml: string; onEnvelopeChange: (xml: string) => void } | undefined>(undefined);
  const onEnvelopeChangeRef = useRef(onEnvelopeChange);
  onEnvelopeChangeRef.current = onEnvelopeChange;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const pending = pendingRef.current;
    if (pending === undefined) {
      return;
    }
    pendingRef.current = undefined;
    pending.onEnvelopeChange(pending.xml);
  }, []);

  useImperativeHandle(ref, () => ({ flush }), [flush]);

  // An edit made anywhere else (regenerate, clone) must win over this pane's local copy.
  useEffect(() => {
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

  // Commits an edit to the store immediately, bypassing the debounce — used by Format and Load
  // from…, which replace the whole buffer in one deliberate act rather than a keystroke burst.
  const commitNow = useCallback((next: string) => {
    setLocal(next);
    clearTimeout(timer.current);
    pendingRef.current = undefined;
    onEnvelopeChangeRef.current(next);
  }, []);

  const handleChange = useCallback((next: string) => {
    setLocal(next);
    clearTimeout(timer.current);
    pendingRef.current = { xml: next, onEnvelopeChange: onEnvelopeChangeRef.current };
    timer.current = setTimeout(() => {
      pendingRef.current = undefined;
      onEnvelopeChangeRef.current(next);
    }, DEBOUNCE_MS);
  }, []);

  const handleMount = useCallback<OnMount>(
    (editor, monacoNS) => {
      editor.addCommand(SEND_KEYBINDING, () => {
        flush();
        sendRef.current();
      });
      editor.addCommand(FORMAT_KEYBINDING, () => {
        formatEditorInPlace(editor);
        const value = editor.getModel()?.getValue();
        if (value !== undefined) {
          commitNow(value);
        }
      });
      editor.addCommand(GOTO_LINE_KEYBINDING, () => {
        gotoLine(editor);
      });
      editorRef.current = editor;
      setActiveRequestEditor(editor, interfaceId);
      // `monacoNS.languages` is absent from the lightweight test double swapped in under jsdom
      // (see `test/mocks/monaco-editor-react.tsx`); the real Monaco always has it.
      if ((monacoNS as { languages?: unknown }).languages !== undefined) {
        registerXmlLanguageFeaturesOnce(monacoNS as typeof Monaco, () => ipcCompletionSource(interfaceId));
      }
    },
    [flush, commitNow, interfaceId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-hairline">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline">
        <ViewTabs label="Request views" items={VIEWS} active="xml" />
        <div className="flex items-center gap-1">
          <span className="px-2 text-xs text-fg-faint">Request</span>
          <OverflowMenu currentText={local} onLoaded={commitNow} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <XmlEditor
          ariaLabel="Request envelope XML"
          value={local}
          onChange={handleChange}
          onMount={handleMount}
          lineNumbers={lineNumbers}
        />
      </div>
    </div>
  );
});
