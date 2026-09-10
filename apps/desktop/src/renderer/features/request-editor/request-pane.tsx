import { useCallback, useEffect, useRef, useState } from 'react';
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

/** The request half: the editable SOAP envelope, plus the (mostly future) view strip. */
export function RequestPane({ envelopeXml, onEnvelopeChange, onSend }: RequestPaneProps) {
  const [local, setLocal] = useState(envelopeXml);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  // An edit made anywhere else (regenerate, clone) must win over this pane's local copy.
  useEffect(() => {
    setLocal(envelopeXml);
  }, [envelopeXml]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const handleChange = useCallback(
    (next: string) => {
      setLocal(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        onEnvelopeChange(next);
      }, DEBOUNCE_MS);
    },
    [onEnvelopeChange],
  );

  const handleMount = useCallback<OnMount>((editor) => {
    editor.addCommand(SEND_KEYBINDING, () => {
      sendRef.current();
    });
  }, []);

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
}
