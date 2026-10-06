/**
 * What this machine's build of the app can do, as the renderer needs to know it to label a control.
 * Nothing here gates behaviour: main refuses what it cannot do.
 */
import { detectPlatform } from '../lib/platform.js';

/** Kerberos / SPNEGO support: whether it is built in, and whether a username and password can be typed in. */
export interface KerberosAvailability {
  readonly available: boolean;
  /** Windows takes explicit credentials for a Kerberos logon; other hosts use their ticket cache. */
  readonly explicitCredentials: boolean;
}

/** Until the Kerberos support lands, it is unavailable everywhere; Windows would take explicit credentials. */
export function useKerberosAvailable(): KerberosAvailability {
  return { available: false, explicitCredentials: detectPlatform() === 'win' };
}
