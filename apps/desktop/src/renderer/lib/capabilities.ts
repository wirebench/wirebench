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
