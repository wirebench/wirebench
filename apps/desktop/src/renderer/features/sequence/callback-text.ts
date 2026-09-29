/**
 * Callback assertion values as the renderer shows and edits them. The bounds restate the engine's
 * `CALLBACK_LIMITS` (the renderer imports no engine values); `test/callback-bounds.test.ts` pins them.
 */
export const CALLBACK_BOUNDS = Object.freeze({
  defaultWithinMs: 30_000,
  minWithinMs: 1_000,
  maxWithinMs: 300_000,
  pollIntervalMs: 1_000,
  maxCatchUrlLength: 100,
  maxHeaderChecks: 20,
  maxExpectChecks: 20,
});

/** `30 s` for whole seconds, otherwise one decimal: `2.5 s`. */
export function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** Seconds as typed, in milliseconds within the bounds; `undefined` for text that is not a number. */
export function withinMsOf(text: string): number | undefined {
  const trimmed = text.trim();
  const seconds = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(seconds)) return undefined;
  return Math.min(CALLBACK_BOUNDS.maxWithinMs, Math.max(CALLBACK_BOUNDS.minWithinMs, Math.round(seconds * 1000)));
}

/** A waiting step's row: `waiting for orders-hook… (up to 30 s)`, naming every catch URL it waits on. */
export function waitingText(waiting: readonly { readonly catchUrl: string; readonly withinMs: number }[]): string {
  const names = waiting.map((one) => one.catchUrl).join(', ');
  const longest = Math.max(...waiting.map((one) => one.withinMs));
  return `waiting for ${names}… (up to ${secondsText(longest)})`;
}
