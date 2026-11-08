/**
 * Profile photos and covers for the renderer (user profile spec §7, plan ruling 6). The renderer never loads a
 * server URL itself, so each image comes from the host over `account.image` as a `data:` URL. Answers are kept for
 * the session, keyed by server, person, kind and version: a changed version fetches again, an unchanged one never
 * does. A failed load is dropped from the cache, so the next render tries again.
 */
import type { AccountImageKindWire } from '@shared/wire-base.js';
import { ipc } from './ipc-client.js';

export interface PersonImageRef {
  readonly url: string;
  readonly userId: string;
  readonly kind: AccountImageKindWire;
  readonly version: string;
}

const cache = new Map<string, Promise<string>>();
/** The answers already in hand: lets a component show a cached image on its first render, without a flash. */
const settled = new Map<string, string>();

export function personImageKey(ref: PersonImageRef): string {
  return `${ref.url}|${ref.userId}|${ref.kind}|${ref.version}`;
}

/** The image as a `data:` URL; rejects with the host's message when it cannot be loaded. */
export function loadPersonImage(ref: PersonImageRef): Promise<string> {
  const key = personImageKey(ref);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = ipc()
    .account.image({ url: ref.url, userId: ref.userId, kind: ref.kind, version: ref.version })
    .then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      settled.set(key, result.value.dataUrl);
      return result.value.dataUrl;
    });
  cache.set(key, pending);
  pending.catch(() => {
    // Only this attempt is forgotten: a newer one for the same key may already be in the map.
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** The answer already in hand for `ref`, if any. */
export function settledPersonImage(ref: PersonImageRef): string | undefined {
  return settled.get(personImageKey(ref));
}

/** Tests only: forget every image. */
export function clearPersonImages(): void {
  cache.clear();
  settled.clear();
}
