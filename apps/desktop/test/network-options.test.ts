// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '@wirebench/engine';
import { mainHttpOptions, resolveProxy, resolveTrustAnchors } from '../src/main/network-options.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('network options without a project', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-net-'));
    await writeFile(join(dir, 'ca.pem'), PEM);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('trusts a CA bundle only when main picked it, and never a relative path with no root', async () => {
    const picks = { hasRead: (path: string) => path === join(dir, 'ca.pem') };
    expect(await resolveTrustAnchors({ caBundlePath: join(dir, 'ca.pem'), roots: [], picks })).toHaveLength(1);
    expect(
      await resolveTrustAnchors({ caBundlePath: join(dir, 'ca.pem'), roots: [], picks: undefined }),
    ).toBeUndefined();
    expect(await resolveTrustAnchors({ caBundlePath: 'ca.pem', roots: [], picks })).toBeUndefined();
    expect(await resolveTrustAnchors({ caBundlePath: 'ca.pem', roots: [dir], picks: undefined })).toHaveLength(1);
    expect(await resolveTrustAnchors({ caBundlePath: undefined, roots: [dir], picks })).toBeUndefined();
  });

  it('resolves a manual proxy with its keychain password and skips excluded hosts for the system proxy', async () => {
    const manual = await resolveProxy({
      url: 'https://wirebench.example.com/api/v1/meta',
      proxy: { mode: 'manual', host: 'proxy.local', port: 3128, username: 'u', passwordRef: 'sec_p', excludes: [] },
      getSecret: (ref) => Promise.resolve(ref === 'sec_p' ? 'pw' : undefined),
    });
    expect(manual?.url).toContain('proxy.local:3128');
    const excluded = await resolveProxy({
      url: 'https://wirebench.example.com/',
      proxy: { mode: 'system', excludes: ['*.example.com'] },
      getSecret: () => Promise.resolve(undefined),
      resolveSystemProxy: () => Promise.resolve('PROXY should-not-be-asked:8080'),
    });
    expect(excluded).toBeUndefined();
    expect(
      await resolveProxy({
        url: 'https://x.test/',
        proxy: { mode: 'none', excludes: [] },
        getSecret: () => Promise.resolve(undefined),
      }),
    ).toBeUndefined();
  });

  it('mainHttpOptions combines the two from the preferences document', async () => {
    const preferences: Preferences = {
      ...DEFAULT_PREFERENCES,
      ssl: { ...DEFAULT_PREFERENCES.ssl, caBundlePath: join(dir, 'ca.pem'), caBundlePickedByMain: true },
      proxy: { mode: 'manual', host: 'proxy.local', port: 3128, excludes: [] },
    };
    const options = await mainHttpOptions('https://wirebench.example.com/', {
      preferences: () => preferences,
      picks: { hasRead: (path) => path === join(dir, 'ca.pem') },
      getSecret: () => Promise.resolve(undefined),
    });
    expect(options.tls?.ca).toHaveLength(1);
    expect(options.tls?.minVersion).toBe('TLSv1.2');
    expect(options.proxy).toBeDefined();
    expect(
      await mainHttpOptions('https://x.test/', {
        preferences: () => DEFAULT_PREFERENCES,
        getSecret: () => Promise.resolve(undefined),
      }),
    ).toEqual({});
  });
});
