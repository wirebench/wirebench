import type { Capability } from '@shared/capabilities.js';

export type { Capability };

/**
 * Whether the connected host can do `capability` (hosted edition spec §3.1): what the preload or the
 * browser bootstrap put in `window.wirebench.env.capabilities`. The one way the renderer asks; nothing
 * compares `env.host`. A feature that needs a capability is not offered without it, and the host refuses
 * the channel anyway (`host-capability-missing`), so this decides what is shown, never what is allowed.
 *
 * No list at all (a renderer test's stub, a preload older than the field) means the desktop: every
 * capability, so the app renders as it always has.
 */
export function hasCapability(capability: Capability): boolean {
  const capabilities = (globalThis as { wirebench?: { env?: { capabilities?: readonly string[] } } }).wirebench?.env
    ?.capabilities;
  return capabilities === undefined || capabilities.includes(capability);
}

/**
 * The hint under a secret field: where the value is kept. The OS keychain where the host has one, else
 * sealed on the server (hosted edition spec §3.5), where a value is never read back.
 */
export function secretKeptHint(desktop: string): string {
  return hasCapability('keychain') ? desktop : 'Sealed on the server and never shown again.';
}

/**
 * The tab's own sign-out, when the API has one: the browser bootstrap sets `env.signOut`, since a tab's
 * account is the server's and `account.signOut` is refused there. The desktop has none, and signs out
 * of each server through the account channel as before.
 */
export function tabSignOut(): (() => void) | undefined {
  return (globalThis as { wirebench?: { env?: { signOut?: () => void } } }).wirebench?.env?.signOut;
}

/**
 * Whether this window has a local agent to route sends to: the browser bootstrap sets `env.agent`
 * (hosted edition spec §18.3), the desktop preload never does. Asked about the API's shape, never `host`.
 */
export function hasAgent(): boolean {
  return (globalThis as { wirebench?: { env?: { agent?: unknown } } }).wirebench?.env?.agent !== undefined;
}
