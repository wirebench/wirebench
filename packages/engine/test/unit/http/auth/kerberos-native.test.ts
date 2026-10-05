import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GSS_C_MUTUAL_FLAG,
  GSS_MECH_OID_KRB5,
  configureKerberos,
  kerberosProvider,
  loadKerberosProvider,
  type KerberosProvider,
} from '../../../../src/http/auth/kerberos-native.js';

const FAKE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'kerberos', 'fake-binding.cjs');
const PROMISE_ONLY = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'kerberos', 'promise-binding.cjs');
const ABSENT = join(import.meta.dirname, 'absent.node');

afterEach(() => {
  configureKerberos(undefined);
});

describe('loadKerberosProvider', () => {
  it('loads a binding from an explicit path, lazily, and promisifies it', async () => {
    const provider = loadKerberosProvider({ bindingPath: FAKE });
    expect(provider.availability()).toEqual({ available: true });
    const client = await provider.initClient({ spn: 'HTTP@svc.corp' });
    await expect(client.step('')).resolves.toBe(Buffer.from('token-for:HTTP@svc.corp').toString('base64'));
  });

  it('works when the package has made the binding promise-only, and rejects rather than hangs', async () => {
    const provider = loadKerberosProvider({ bindingPath: PROMISE_ONLY });
    const client = await provider.initClient({ spn: 'HTTP@svc.corp' });
    await expect(client.step('')).resolves.toBe(Buffer.from('token-for:HTTP@svc.corp').toString('base64'));
    const failing = await provider.initClient({ spn: 'HTTP@fail-step' });
    await expect(failing.step('')).rejects.toThrow('not found in Kerberos database');
  });

  it('passes the keys the binary reads: mechOID, flags, principal, user, domain, password', async () => {
    const provider = loadKerberosProvider({ bindingPath: FAKE });
    await provider.initClient({ spn: 'HTTP/svc', principal: 'a@R', user: 'u', domain: 'D', password: 'p' });
    const binding = createRequire(import.meta.url)(FAKE) as {
      __calls: { init?: string; options?: Record<string, unknown> }[];
    };
    const init = binding.__calls.findLast((call) => call.init === 'HTTP/svc');
    expect(init?.options).toEqual({
      mechOID: GSS_MECH_OID_KRB5,
      flags: GSS_C_MUTUAL_FLAG,
      principal: 'a@R',
      user: 'u',
      domain: 'D',
      password: 'p',
    });
  });

  it('reports a missing binding as unavailable, with a reason, and never throws on load', () => {
    const availability = loadKerberosProvider({ bindingPath: ABSENT }).availability();
    expect(availability).toEqual({ available: false, reason: 'The Kerberos component is not installed.' });
  });

  it('names Windows on ARM when there is no binding for it', () => {
    const provider = loadKerberosProvider({ bindingPath: ABSENT, platform: 'win32', arch: 'arm64' });
    expect(provider.availability()).toEqual({
      available: false,
      reason: 'Kerberos is not available on Windows on ARM.',
    });
  });

  it('rejects initClient on an unavailable provider with the reason', async () => {
    await expect(loadKerberosProvider({ bindingPath: ABSENT }).initClient({ spn: 'HTTP@x' })).rejects.toThrow(
      'The Kerberos component is not installed.',
    );
  });
});

describe('configureKerberos', () => {
  it('replaces and restores the process-wide provider', () => {
    const fake: KerberosProvider = {
      availability: () => ({ available: false, reason: 'fake' }),
      initClient: () => Promise.reject(new Error('fake')),
    };
    configureKerberos(fake);
    expect(kerberosProvider()).toBe(fake);
    configureKerberos(undefined);
    expect(kerberosProvider()).not.toBe(fake);
  });
});
