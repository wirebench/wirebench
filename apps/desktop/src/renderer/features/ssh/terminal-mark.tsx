import { useEffect, useRef, useState } from 'react';
import { CircleDot, Keyboard, TriangleAlert } from 'lucide-react';
import { MARK_LABEL, type TerminalMark } from './terminal-marks.js';

// Each mark has its own shape, not only its own colour: a ringed dot, a keyboard, a warning triangle.
const ICON = { unread: CircleDot, input: Keyboard, error: TriangleAlert } as const;
const COLOR: Readonly<Record<TerminalMark, string>> = {
  unread: 'text-accent',
  input: 'text-status-warning',
  error: 'text-status-danger',
};

/** A terminal tab's or a pane header's mark (#422): new output, a prompt waiting, or an error. */
export function TerminalMarkIcon({ mark }: { readonly mark: TerminalMark }) {
  const Icon = ICON[mark];
  return (
    <span
      role="img"
      aria-label={MARK_LABEL[mark]}
      title={MARK_LABEL[mark]}
      data-testid="terminal-mark"
      data-mark={mark}
      className={`inline-flex shrink-0 ${COLOR[mark]}`}
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}

/** One tab as the announcer sees it: its name and its mark, if it has one. */
export interface MarkedTab {
  readonly id: string;
  readonly label: string;
  readonly mark: TerminalMark | undefined;
}

/**
 * Says to a screen reader when a tab gets a mark or a different one: "web-1: Waiting for input". A mark
 * that clears, or stays, says nothing.
 */
export function TerminalMarksAnnouncer({ tabs }: { readonly tabs: readonly MarkedTab[] }) {
  const seen = useRef(new Map<string, TerminalMark | undefined>());
  const [message, setMessage] = useState('');
  const latest = useRef(tabs);
  latest.current = tabs;
  const key = tabs.map((tab) => `${tab.id}=${tab.mark ?? ''}`).join(' ');
  useEffect(() => {
    let said: string | undefined;
    const next = new Map<string, TerminalMark | undefined>();
    for (const tab of latest.current) {
      next.set(tab.id, tab.mark);
      if (tab.mark !== undefined && seen.current.get(tab.id) !== tab.mark) {
        said = `${tab.label}: ${MARK_LABEL[tab.mark]}`;
      }
    }
    seen.current = next;
    if (said !== undefined) setMessage(said);
  }, [key]);
  return (
    <div role="status" aria-live="polite" className="sr-only" data-testid="terminal-marks-announcer">
      {message}
    </div>
  );
}
