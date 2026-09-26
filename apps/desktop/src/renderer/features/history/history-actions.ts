/**
 * The History actions behind the `history.*` commands.
 *
 * The History view drives the same operations per row; these are the keyboard/palette entry
 * points, so they act on the newest entries — the ones a user reaches for without pointing at
 * a row. Kept out of the view so the palette and the view can never drift.
 */

import { showToast } from '../../components/toast.js';
import { useEditorsStore, type EditorTab } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { ipc } from '../../state/ipc-client.js';
import { formatClockTime } from '../../lib/format-size.js';
import type { HistoryEntryWire, RestExchangeSummary } from '../../../shared/wire-types.js';
import { restEntryTexts, restExchangeTexts, type RestDiffTexts } from './rest-diff-text.js';

/** The response body a history entry is best compared by, falling back to what was sent. */
function comparableXml(entry: HistoryEntryWire): string {
  return entry.response?.envelopeXml ?? entry.request.envelopeXml;
}

/**
 * Whether History can re-send an entry: SOAP, gRPC and REST, except a REST event stream, which has
 * no live pane to run in (the HTTP Log draws the same line). A WebSocket session resends from its
 * request. An entry with no kind predates the other protocols and is SOAP.
 */
export function canResendHistoryEntry(entry: Pick<HistoryEntryWire, 'kind' | 'sse'>): boolean {
  const kind = entry.kind ?? 'soap';
  return kind === 'soap' || kind === 'grpc' || (kind === 'rest' && entry.sse === undefined);
}

/** The toast for a failed re-send: main's message, or the code when there is no message. */
function resendFailure(error: { readonly code: string; readonly message: string }): string {
  return error.message.trim() === '' ? error.code : error.message;
}

/** Re-sends one history entry through its protocol's channel, toasting why on failure. */
export async function resendHistoryEntry(entry: Pick<HistoryEntryWire, 'id' | 'kind'>): Promise<void> {
  const result =
    entry.kind === 'grpc'
      ? await ipc().history.resendGrpc({ id: entry.id })
      : entry.kind === 'rest'
        ? await ipc().history.resendRest({ id: entry.id })
        : await ipc().history.resend({ id: entry.id });
  if (!result.ok) {
    showToast(resendFailure(result.error));
  }
}

/** Only SOAP entries are what `history.resendLast` replays. */
function isSoapEntry(entry: Pick<HistoryEntryWire, 'kind'>): boolean {
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
  const entry = entries.find(isSoapEntry);
  if (entry === undefined) {
    showToast('Nothing to re-send: only a SOAP entry can be re-sent from History.');
    return;
  }
  if (entry.id !== entries[0]?.id) {
    showToast(`Re-sending the newest SOAP entry: ${entry.requestName} (${formatClockTime(entry.at)}).`);
  }
  const result = await ipc().history.resend({ id: entry.id });
  if (!result.ok) {
    showToast(resendFailure(result.error));
  }
}

/** One side of a Compare tab: a History entry, a REST request's latest exchange, or a bare body. */
export type CompareSide =
  | { readonly label: string; readonly entry: HistoryEntryWire }
  | { readonly label: string; readonly restExchange: RestExchangeSummary }
  | { readonly label: string; readonly body: string };

/** The side an entry makes, labelled with its request's name and the time it was sent. */
export function entrySide(entry: HistoryEntryWire): CompareSide {
  return { label: `${entry.requestName} (${formatClockTime(entry.at)})`, entry };
}

/** The one body a side is diffed by when the pair is not REST on both sides. */
function sideBody(side: CompareSide): string {
  if ('entry' in side) {
    return comparableXml(side.entry);
  }
  return 'restExchange' in side ? side.restExchange.text : side.body;
}

/** A side's REST texts, or `undefined` when the side is not REST. */
function sideRestTexts(side: CompareSide): RestDiffTexts | undefined {
  if ('entry' in side) {
    return side.entry.kind === 'rest' ? restEntryTexts(side.entry) : undefined;
  }
  return 'restExchange' in side ? restExchangeTexts(side.restExchange) : undefined;
}

/**
 * A Compare tab's data for two sides. Every entry point builds its tab here, so they cannot drift:
 * two REST sides also get their Response and Request texts, and any other pair diffs one body.
 */
export function compareDiff(left: CompareSide, right: CompareSide): NonNullable<EditorTab['diff']> {
  const leftRest = sideRestTexts(left);
  const rightRest = leftRest === undefined ? undefined : sideRestTexts(right);
  return {
    leftLabel: left.label,
    rightLabel: right.label,
    leftXml: sideBody(left),
    rightXml: sideBody(right),
    ...(leftRest !== undefined && rightRest !== undefined
      ? {
          rest: {
            response: { left: leftRest.response, right: rightRest.response },
            request: { left: leftRest.request, right: rightRest.request },
          },
        }
      : {}),
  };
}

/** Opens (or replaces) the Compare tab over two sides. */
export function openCompareTab(left: CompareSide, right: CompareSide): void {
  useEditorsStore
    .getState()
    .openOrReplace({ id: 'diff', kind: 'diff', title: 'Compare', diff: compareDiff(left, right) });
}

/** Opens a diff tab over the two most recent history entries, newest on the right. */
export function compareLastTwoHistoryEntries(): void {
  const [newer, older] = useHistoryStore.getState().entries;
  if (newer === undefined || older === undefined) {
    return;
  }
  openCompareTab(entrySide(older), entrySide(newer));
}

/** Deletes every history entry. The view's own button confirms first; the command is explicit. */
export async function clearHistory(): Promise<void> {
  await useHistoryStore.getState().clear();
  showToast('History cleared.');
}
