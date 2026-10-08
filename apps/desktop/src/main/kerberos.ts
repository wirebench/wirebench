/**
 * Points the engine's Kerberos at the binding this build vendored (ADR-0019), once, at start-up. A
 * development run uses the installed `kerberos` package instead. The snap never loads it: strict
 * confinement hides `/etc/krb5.conf` and the ticket cache, so Kerberos there is unavailable with a
 * reason that names the builds where it works (#268).
 */

import { join } from 'node:path';
import { configureKerberos, kerberosProvider, loadKerberosProvider, type KerberosProvider } from '@wirebench/engine';
import { channels } from '../shared/ipc.js';
import { registerHandler } from './ipc/register.js';

export function kerberosBindingPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: string;
  readonly arch: string;
}): string | undefined {
  return input.isPackaged
    ? join(input.resourcesPath, 'kerberos', `${input.platform}-${input.arch}`, 'kerberos.node')
    : undefined;
}

export const SNAP_KERBEROS_REASON = 'Kerberos is not supported in the snap. Install the deb, rpm or AppImage build.';

/** The provider for this install: the vendored (or installed) binding, or a refusal inside the snap. */
export function kerberosProviderFor(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: string;
  readonly arch: string;
  /** `$SNAP`, which snapd sets for every app it runs. */
  readonly snap: string | undefined;
}): KerberosProvider {
  if (input.platform === 'linux' && input.snap !== undefined && input.snap !== '') {
    return {
      availability: () => ({ available: false, reason: SNAP_KERBEROS_REASON }),
      initClient: () => Promise.reject(new Error(SNAP_KERBEROS_REASON)),
    };
  }
  const bindingPath = kerberosBindingPath(input);
  return loadKerberosProvider(bindingPath !== undefined ? { bindingPath } : {});
}

export function setUpKerberos(input: { readonly isPackaged: boolean; readonly resourcesPath: string }): void {
  configureKerberos(
    kerberosProviderFor({ ...input, platform: process.platform, arch: process.arch, snap: process.env.SNAP }),
  );
}

export function registerKerberosChannels(): void {
  registerHandler(channels.auth.kerberosAvailability, () => {
    const availability = kerberosProvider().availability();
    const platform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
    return Promise.resolve(
      availability.available
        ? { available: true, platform }
        : { available: false, reason: availability.reason, platform },
    );
  });
}
