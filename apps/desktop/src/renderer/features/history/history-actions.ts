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

/**
 * Whether History can re-send an entry. Only SOAP: main replays a send as a SOAP send input, and
 * refuses every other kind (an entry with no kind predates the other protocols and is SOAP).
 */
export function canResendHistoryEntry(entry: Pick<HistoryEntryWire, 'kind'>): boolean {
  return (entry.kind ?? 'soap') === 'soap';
}

/**
 * Re-sends the most recent SOAP history entry, or says there is none.
 *
 * Only SOAP can be replayed, so the newest entry overall is not always the one this re-sends.
 * When it is not, the entry that *is* being re-sent is named — a command called "re-send the last
 * request" must never quietly replay something older than the row at the top of History.
 */
export async function resendLastHistoryEntry(): Promise<void> {
  const entries = useHistoryStore.getState().entries;
  const entry = entries.find(canResendHistoryEntry);
  if (entry === undefined) {
    showToast('Nothing to re-send: only a SOAP entry can be re-sent from History.');
    return;
  }
  if (entry.id !== entries[0]?.id) {
    showToast(`Re-sending the newest SOAP entry: ${entry.requestName} (${formatClockTime(entry.at)}).`);
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
