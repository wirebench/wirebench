/**
 * Resolves an `EndpointAuth` (which only ever carries a `passwordRef`) into the plaintext shape
 * the engine's `importDefinition`/send path expects. Kept pure — the secret getter is injected —
 * so it needs no Electron and is trivially testable without a real `SecretStore`.
 */

import { WirebenchError } from '@wirebench/engine';
import type { EndpointAuth } from '@wirebench/engine';

/** The engine-facing shape: a resolved password in place of a `passwordRef`. */
export interface ResolvedAuth {
  readonly type: EndpointAuth['type'];
  readonly username?: string;
  readonly password?: string;
  readonly domain?: string;
  readonly workstation?: string;
  readonly preemptive?: boolean;
}

/**
 * Looks up `auth.passwordRef` via `getSecret` and returns the resolved auth. Returns `undefined`
 * when `auth` itself is `undefined` (nothing to resolve). Throws a `secret-missing`
 * `WirebenchError` when a `passwordRef` is set but the store has no value for it — a dangling
 * reference must fail loudly rather than silently sending no credentials.
 */
export async function resolveEndpointAuth(
  auth: EndpointAuth | undefined,
  getSecret: (ref: string) => Promise<string | undefined>,
): Promise<ResolvedAuth | undefined> {
  if (!auth) {
    return undefined;
  }
  const resolved: ResolvedAuth = {
    type: auth.type,
    ...(auth.username !== undefined ? { username: auth.username } : {}),
    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
    ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
    ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
  };
  if (auth.passwordRef === undefined) {
    return resolved;
  }
  const password = await getSecret(auth.passwordRef);
  if (password === undefined) {
    throw new WirebenchError('secret-missing', `Secret ${auth.passwordRef} was not found in the secret store.`, {
      details: { ref: auth.passwordRef },
    });
  }
  return { ...resolved, password };
}
