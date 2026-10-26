/** Guards for the optional parts of a {@link HostPlatform}: a host without one refuses, loudly. */
import { WirebenchError } from '@wirebench/engine';
import type { HostPlatform } from './platform.js';

/** The optional parts of a platform a module may need. */
export type OptionalPart = 'dialogs' | 'shell' | 'power';

/**
 * The platform's `part`, or a `host-capability-missing` error naming it. The Electron platform has
 * every part; a headless one has none, and a feature that needs a machine says so rather than failing deep inside.
 */
export function requireCapability<K extends OptionalPart>(
  platform: Pick<HostPlatform, K>,
  part: K,
): NonNullable<Pick<HostPlatform, K>[K]> {
  const found = platform[part];
  if (found === undefined) {
    throw new WirebenchError('host-capability-missing', `This host has no ${part}`, { details: { capability: part } });
  }
  return found;
}
