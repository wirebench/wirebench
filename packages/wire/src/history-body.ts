/**
 * How much of a body a History line keeps, and the cut it makes beyond that. Shared by the host's History
 * and a browser tab, which trims an agent's exchange the same way before it uploads it for History
 * (`exchanges.recordAgentSend`), so a large response never has to cross the server socket whole.
 *
 * Plain values only, no schema: the renderer imports it eagerly.
 */

/** How much of a body a History line keeps. Beyond this it is cut with a marker. */
export const HISTORY_BODY_MAX_CHARS = 256 * 1024;

/** The line a cut body ends with. */
const TRUNCATION_TAIL = /\n… truncated, \d+ more characters$/;

/** The longest marker {@link historyBody} writes (a count of up to 16 digits). */
const MAX_MARKER_CHARS = 48;

/** `text` itself when short enough, else its first {@link HISTORY_BODY_MAX_CHARS} characters and a marker. */
export function historyBody(text: string): string {
  if (text.length <= HISTORY_BODY_MAX_CHARS) return text;
  const kept = text.slice(0, HISTORY_BODY_MAX_CHARS);
  return `${kept}\n… truncated, ${String(text.length - HISTORY_BODY_MAX_CHARS)} more characters`;
}

/**
 * True when `text` is History's cut copy of a body: longer than the cap, and ending with the marker.
 * Only the tail is tested, so a 256 KB body costs one short match.
 */
export function isTruncatedBody(text: string): boolean {
  return text.length > HISTORY_BODY_MAX_CHARS && TRUNCATION_TAIL.test(text.slice(-64));
}

/**
 * True when `text` is exactly what {@link historyBody} makes of a longer body: the cap, then the marker,
 * and nothing more. A long body that merely ends in the marker is not one, so it is still cut.
 */
export function isHistoryCut(text: string): boolean {
  return isTruncatedBody(text) && text.length <= HISTORY_BODY_MAX_CHARS + MAX_MARKER_CHARS;
}
