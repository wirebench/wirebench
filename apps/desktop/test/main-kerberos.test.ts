import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kerberosBindingPath } from '../src/main/kerberos.js';
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

describe('auth.kerberosAvailability', () => {
  it('carries availability, the reason and the platform', () => {
    const response = channels.auth.kerberosAvailability.response;
    expect(response.safeParse({ available: false, reason: 'r', platform: 'win32' }).success).toBe(true);
    expect(response.safeParse({ available: true, platform: 'aix' }).success).toBe(false);
  });
});
