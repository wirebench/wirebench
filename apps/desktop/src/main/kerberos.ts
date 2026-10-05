/**
 * Points the engine's Kerberos at the binding this build vendored (ADR-0019), once, at start-up. A
 * development run uses the installed `kerberos` package instead.
 */

import { join } from 'node:path';
import { configureKerberos, kerberosProvider, loadKerberosProvider } from '@wirebench/engine';
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

export function setUpKerberos(input: { readonly isPackaged: boolean; readonly resourcesPath: string }): void {
  const bindingPath = kerberosBindingPath({ ...input, platform: process.platform, arch: process.arch });
  configureKerberos(loadKerberosProvider(bindingPath !== undefined ? { bindingPath } : {}));
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
