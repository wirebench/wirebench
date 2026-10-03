import type { StoredCookie } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { StoredCookieWire } from '../../shared/wire-types.js';
import type { CookieStore } from '../cookie-store.js';
import { registerHandler } from './register.js';

/** A wire cookie as the engine's type: zod's optional keys may hold `undefined`, the engine's may not. */
export function toStoredCookie(wire: StoredCookieWire): StoredCookie {
  const { expiresAt, sameSite, ...rest } = wire;
  return {
    ...rest,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(sameSite !== undefined ? { sameSite } : {}),
  };
}

/**
 * Registers the `cookies.*` channels (cookie jar spec §2.2). Each answers with the whole jar, so the
 * renderer merges nothing; `cookies.changed` comes from the store itself, after every change.
 */
export function registerCookiesChannels(
  store: Pick<CookieStore, 'state' | 'set' | 'remove' | 'removeDomain' | 'clear'>,
): void {
  registerHandler(channels.cookies.list, () => Promise.resolve(store.state()));
  registerHandler(channels.cookies.set, (request) =>
    Promise.resolve(store.set(toStoredCookie(request.cookie), request.replaces)),
  );
  registerHandler(channels.cookies.remove, (request) => Promise.resolve(store.remove(request.key)));
  registerHandler(channels.cookies.removeDomain, (request) => Promise.resolve(store.removeDomain(request.domain)));
  registerHandler(channels.cookies.clear, () => Promise.resolve(store.clear()));
}
