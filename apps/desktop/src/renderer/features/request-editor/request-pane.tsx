import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { SEND_KEYBINDING } from '../../editor/monaco.js';
import { XmlEditor } from '../../editor/xml-editor.js';
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
}

/** Imperative escape hatch for callers that must flush a pending debounced edit synchronously. */
export interface RequestPaneHandle {
  /** Writes any not-yet-committed edit to the store immediately. Safe to call when there is none. */
  flush: () => void;
}

/** The request half: the editable SOAP envelope, plus the (mostly future) view strip. */
export const RequestPane = forwardRef<RequestPaneHandle, RequestPaneProps>(function RequestPane(
  { envelopeXml, onEnvelopeChange, onSend }: RequestPaneProps,
  ref,
) {
  const [local, setLocal] = useState(envelopeXml);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

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
    },
    [flush],
  );

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
    (editor) => {
      editor.addCommand(SEND_KEYBINDING, () => {
        flush();
        sendRef.current();
      });
    },
    [flush],
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-hairline">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline">
        <ViewTabs label="Request views" items={VIEWS} active="xml" />
        <span className="px-2 text-xs text-fg-faint">Request</span>
      </div>
      <div className="min-h-0 flex-1">
        <XmlEditor ariaLabel="Request envelope XML" value={local} onChange={handleChange} onMount={handleMount} />
      </div>
    </div>
  );
});
