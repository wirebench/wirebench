import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kerberosBindingPath, kerberosProviderFor, SNAP_KERBEROS_REASON } from '../src/main/kerberos.js';
import { channels } from '../src/shared/ipc.js';

describe('kerberosBindingPath', () => {
  it('points a packaged app at its vendored binding for this architecture', () => {
    expect(
      kerberosBindingPath({ isPackaged: true, resourcesPath: '/app/Resources', platform: 'darwin', arch: 'arm64' }),
    ).toBe(join('/app/Resources', 'kerberos', 'darwin-arm64', 'kerberos.node'));
  });

  it('leaves a development run on the installed package', () => {
    expect(
      kerberosBindingPath({ isPackaged: false, resourcesPath: '/x', platform: 'linux', arch: 'x64' }),
    ).toBeUndefined();
  });
});

describe('kerberosProviderFor', () => {
  const packaged = { isPackaged: true, resourcesPath: '/nowhere', platform: 'linux', arch: 'x64' } as const;

  it('refuses inside the snap, naming the builds where Kerberos works', async () => {
    const provider = kerberosProviderFor({ ...packaged, snap: '/snap/wirebench/x1' });
    expect(provider.availability()).toEqual({ available: false, reason: SNAP_KERBEROS_REASON });
    await expect(provider.initClient({ spn: 'HTTP@host' })).rejects.toThrow(SNAP_KERBEROS_REASON);
  });

  it('loads the vendored binding outside the snap', () => {
    const availability = kerberosProviderFor({ ...packaged, snap: undefined }).availability();
    expect(availability).toMatchObject({ available: false, reason: 'The Kerberos component is not installed.' });
  });

  it('ignores an empty $SNAP and $SNAP off Linux', () => {
    for (const input of [
      { ...packaged, snap: '' },
      { ...packaged, platform: 'darwin', snap: '/snap/wirebench/x1' },
    ]) {
      expect(kerberosProviderFor(input).availability()).not.toEqual({
        available: false,
        reason: SNAP_KERBEROS_REASON,
      });
    }
  });
});

describe('auth.kerberosAvailability', () => {
  it('carries availability, the reason and the platform', () => {
    const response = channels.auth.kerberosAvailability.response;
    expect(response.safeParse({ available: false, reason: 'r', platform: 'win32' }).success).toBe(true);
    expect(response.safeParse({ available: true, platform: 'aix' }).success).toBe(false);
  });
});
