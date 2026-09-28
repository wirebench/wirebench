/**
 * The last capture this device has seen, per catch URL (webhook-capture spec §4.2, Revision R8).
 * Kept in `localStorage` like the rest of the renderer's per-device UI state: it is a convenience,
 * not a setting, and losing it only re-badges captures. `''` means "seen, and it had none".
 */
export const SEEN_KEY = 'wirebench.webhooks.seen';

const keyOf = (url: string, hookId: string): string => `${url} ${hookId}`;

/** The lower module: `state/webhooks.ts` imports and re-exports this rather than keeping a copy (M11). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function readAll(storage: Storage): Record<string, string> {
  try {
    const raw = storage.getItem(SEEN_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function writeAll(storage: Storage, seen: Record<string, string>): void {
  try {
    storage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // A full or blocked storage only costs a badge; nothing else depends on it.
  }
}

export function readSeen(url: string, hookId: string, storage: Storage = localStorage): string | undefined {
  return readAll(storage)[keyOf(url, hookId)];
}

export function writeSeen(url: string, hookId: string, captureId: string, storage: Storage = localStorage): void {
  writeAll(storage, { ...readAll(storage), [keyOf(url, hookId)]: captureId });
}

/** `url` may be the server's full URL or its origin — this applies `originOf` itself, like the store does. */
export function forgetSeen(url: string, hookId: string, storage: Storage = localStorage): void {
  const seen = readAll(storage);
  delete seen[keyOf(originOf(url), hookId)];
  writeAll(storage, seen);
}
