/** The words a History row, its tab and its footer are made of. */
import { formatClockTime } from '../../lib/format-size.js';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';

/** The host part of a URL, or the raw string when it doesn't parse (a `${...}` placeholder, say). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * An entry tab's title: the request's name and the time it was sent, so the tab never reads as the
 * request's own editor tab and two entries of one request tell apart.
 */
export function historyTabTitle(entry: Pick<HistoryEntryWire, 'requestName' | 'at'>): string {
  return `${entry.requestName} · ${formatClockTime(entry.at)}`;
}

/** The footer's count: "1 entry", "2 entries". */
export function historyCountLabel(total: number): string {
  return total === 1 ? '1 entry' : `${String(total)} entries`;
}
