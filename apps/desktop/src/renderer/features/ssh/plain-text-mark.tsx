import { LockOpen } from 'lucide-react';

/** The "not encrypted" sign of a Telnet session (#425), for a pane header or a details row. */
export function PlainTextMark() {
  return (
    <span role="img" aria-label="Not encrypted" title="Telnet: not encrypted" className="text-status-warning">
      <LockOpen size={12} aria-hidden="true" />
    </span>
  );
}

/** The strip over a lone Telnet pane, for as long as it is open: what is typed and shown is plain text. */
export function PlainTextStrip() {
  return (
    <div
      role="note"
      data-testid="ssh-plain-text"
      className="flex h-6 shrink-0 items-center gap-1.5 border-b border-hairline px-2 text-xs text-status-warning"
    >
      <LockOpen size={12} aria-hidden="true" />
      <span className="truncate">Not encrypted: this Telnet session travels in plain text</span>
    </div>
  );
}
