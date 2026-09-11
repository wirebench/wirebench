/**
 * The History actions behind the `history.*` commands.
 *
 * The History view drives the same operations per row; these are the keyboard/palette entry
 * points, so they act on the newest entries — the ones a user reaches for without pointing at
 * a row. Kept out of the view so the palette and the view can never drift.
 */

import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { ipc } from '../../state/ipc-client.js';
import { formatClockTime } from '../../lib/format-size.js';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';

/** The response body a history entry is best compared by, falling back to what was sent. */
function comparableXml(entry: HistoryEntryWire): string {
  return entry.response?.envelopeXml ?? entry.request.envelopeXml;
}

/** Re-sends the most recent history entry. */
export async function resendLastHistoryEntry(): Promise<void> {
  const entry = useHistoryStore.getState().entries[0];
  if (entry === undefined) {
    return;
  }
  const result = await ipc().history.resend({ id: entry.id });
  if (!result.ok) {
    showToast(result.error.code);
  }
}

/** Opens a diff tab over the two most recent history entries, newest on the right. */
export function compareLastTwoHistoryEntries(): void {
  const [newer, older] = useHistoryStore.getState().entries;
  if (newer === undefined || older === undefined) {
    return;
  }
  useEditorsStore.getState().openOrReplace({
    id: 'diff',
    kind: 'diff',
    title: 'Compare',
    diff: {
      leftLabel: `${older.requestName} (${formatClockTime(older.at)})`,
      rightLabel: `${newer.requestName} (${formatClockTime(newer.at)})`,
      leftXml: comparableXml(older),
      rightXml: comparableXml(newer),
    },
  });
}

/** Deletes every history entry. The view's own button confirms first; the command is explicit. */
export async function clearHistory(): Promise<void> {
  await useHistoryStore.getState().clear();
  showToast('History cleared.');
}
