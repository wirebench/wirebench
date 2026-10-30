import { CircleDot } from 'lucide-react';
import type { PaneSession } from './hosts-store.js';

/** Whether any of the given panes has an open session whose output goes to a session log (#414). */
export function recordingOf(panes: Readonly<Record<string, PaneSession>>, paneIds: Iterable<string>): boolean {
  for (const id of paneIds) {
    const pane = panes[id];
    if (pane?.state === 'open' && pane.recording === true) return true;
  }
  return false;
}

const LABEL = 'Recording: this session is written to a session log';

/**
 * The record glyph — a ring around a dot — drawn on a terminal tab and a pane header while its
 * session is logged. A shape, not a bare red dot, so it reads in every colour theme (#803).
 */
export function RecordingMark() {
  return (
    <span
      role="img"
      aria-label={LABEL}
      title={LABEL}
      data-testid="recording-mark"
      className="flex shrink-0 text-status-danger"
    >
      <CircleDot size={10} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}
