/**
 * History's Compare…: the first entry picked, then a second. Kept apart from the view so the steps can
 * be pinned without a DOM.
 */
import { formatClockTime } from '../../lib/format-size.js';
import { requestDisplayName } from '../rest-api/request-display-name.js';
import type { HistoryEntryWire } from '@shared/wire-types.js';

/** What picking `entryId` does, given the entry picked first (if any). */
export type CompareStep =
  | { readonly kind: 'arm'; readonly first: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'compare'; readonly first: string; readonly second: string };

/**
 * Picking with nothing armed arms that entry; picking the armed entry again cancels; picking any
 * other entry compares the two, first on the left.
 */
export function compareStep(armed: string | undefined, entryId: string): CompareStep {
  if (armed === undefined) {
    return { kind: 'arm', first: entryId };
  }
  if (armed === entryId) {
    return { kind: 'cancel' };
  }
  return { kind: 'compare', first: armed, second: entryId };
}

/** The banner shown while a first side is picked: which entry, and when it was sent. */
export function compareBannerText(entry: Pick<HistoryEntryWire, 'requestName' | 'method' | 'at'>): string {
  return `Comparing with ${requestDisplayName(entry.requestName, entry.method)} · ${formatClockTime(entry.at)}`;
}
