/**
 * Whether this machine may use a workspace's shared secret sources (secret sources spec D4). A shared
 * mapping decides which of the user's secrets a shared request can read, so it is used only once approved
 * here (desktop) or trusted by flag (CLI), and any change needs that again. Local entries are always trusted.
 */

import { createHash } from 'node:crypto';
import { serializeSecretSources, type SharedSecretSources } from './parse.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    // Null prototype and `defineProperty`: an own `__proto__` key must stay a key, not set the prototype.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: canonical((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted at every level, so equal mappings compare and hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** SHA-256 (hex) of the shared mapping's canonical JSON; `undefined` when there is none. */
export function secretSourcesHash(shared: SharedSecretSources | undefined): string | undefined {
  if (shared === undefined || Object.keys(shared).length === 0) {
    return undefined;
  }
  return createHash('sha256')
    .update(canonicalJson(serializeSecretSources(shared)))
    .digest('hex');
}

export type SecretSourcesTrust =
  | { readonly mode: 'approved'; readonly hash: string | undefined }
  | { readonly mode: 'any' }
  | { readonly mode: 'hash'; readonly hash: string };

/** Whether the shared entries of a mapping whose hash is `current` may be used. */
export function sharedTrusted(trust: SecretSourcesTrust, current: string | undefined): boolean {
  if (trust.mode === 'any') {
    return true;
  }
  return trust.hash !== undefined && trust.hash === current;
}
