/**
 * The platform a user's host runs on in the server (hosted edition spec §17.3, §17.4): its paths stay in
 * the user's own directories, its secrets seal under a key only that user's host derives, and it offers
 * nothing a browser user must not reach.
 */
import { join, relative, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServerPlatform, hostDirectories, userSecretsKey } from '../../../src/host/server-platform.js';
import { loadHostRuntime } from '../../../src/host/host-runtime.js';

const DATA_DIR = join('/', 'srv', 'wirebench-data');
const KEY = Buffer.alloc(32, 7);
const ALICE = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const BOB = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PB';

function platformFor(userId: string, secretsKey = KEY): ReturnType<typeof createServerPlatform> {
  return createServerPlatform({
    userId,
    dataDir: DATA_DIR,
    secretsKey,
    egress: { denyPrivate: true },
    appVersion: '2.1.1-test',
  });
}

/** `path` is `dir` or somewhere beneath it. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

describe('server platform paths', () => {
  it('names the user checkout as userData and root, and logs inside it', () => {
    const platform = platformFor(ALICE);
    const checkout = join(DATA_DIR, 'checkouts', ALICE);
    expect(platform.paths.userData()).toBe(checkout);
    expect(platform.paths.root()).toBe(checkout);
    expect(isInside(checkout, platform.paths.logs())).toBe(true);
  });

  it('gives each user a temp directory of their own, outside every checkout', () => {
    const alice = platformFor(ALICE).paths.temp();
    const bob = platformFor(BOB).paths.temp();
    expect(alice).toBe(join(DATA_DIR, 'tmp', ALICE));
    expect(alice).not.toBe(bob);
    expect(isInside(join(DATA_DIR, 'checkouts'), alice)).toBe(false);
  });

  it('names nothing outside the user checkout but that temp directory', () => {
    const platform = platformFor(ALICE);
    const { checkout, temp } = hostDirectories(DATA_DIR, ALICE);
    const named = [platform.paths.userData(), platform.paths.root(), platform.paths.logs()];
    expect(named.every((path) => isInside(checkout, path))).toBe(true);
    expect(platform.paths.temp()).toBe(temp);
  });

  it.each(['..', '../other', 'a/b', '', '.', 'x'.repeat(65)])(
    'refuses a user id that is no path segment (%j)',
    (id) => {
      expect(() => platformFor(id)).toThrow('not a path segment');
    },
  );
});

describe('server platform secrets (§17.4)', () => {
  it('derives a different key per user, and a different one under another server key', () => {
    expect(userSecretsKey(KEY, ALICE)).not.toEqual(userSecretsKey(KEY, BOB));
    expect(userSecretsKey(KEY, ALICE)).not.toEqual(userSecretsKey(Buffer.alloc(32, 8), ALICE));
    expect(userSecretsKey(KEY, ALICE)).toEqual(userSecretsKey(KEY, ALICE));
    expect(userSecretsKey(KEY, ALICE)).toHaveLength(32);
  });

  it('opens what it sealed, and only for the same user', () => {
    const alice = platformFor(ALICE);
    const bob = platformFor(BOB);
    const sealed = alice.secrets.encrypt('s3cret-token');
    expect(sealed.toString('utf8')).not.toContain('s3cret-token');
    expect(alice.secrets.decrypt(sealed)).toBe('s3cret-token');
    expect(platformFor(ALICE).secrets.decrypt(sealed)).toBe('s3cret-token');
    expect(() => bob.secrets.decrypt(sealed)).toThrow();
    expect(() => bob.secrets.decrypt(alice.secrets.encrypt(''))).toThrow();
    expect(bob.secrets.decrypt(bob.secrets.encrypt('bob-only'))).toBe('bob-only');
  });

  it('does not open a box sealed under another server key', () => {
    const sealed = platformFor(ALICE).secrets.encrypt('value');
    expect(() => platformFor(ALICE, Buffer.alloc(32, 9)).secrets.decrypt(sealed)).toThrow();
  });
});

describe('server platform surface (§17.3)', () => {
  it('has send:public alone, no machine values, the egress rule and no optional members', () => {
    const platform = platformFor(ALICE);
    expect([...platform.capabilities]).toEqual(['send:public']);
    expect(platform.machineValues).toBe(false);
    expect(platform.network.egress).toEqual({ denyPrivate: true });
    expect(platform.secrets.available()).toBe(true);
    for (const member of ['dialogs', 'shell', 'power']) expect(member in platform).toBe(false);
  });

  it('says it is packaged, light, direct, and shows the server version', async () => {
    const platform = platformFor(ALICE);
    expect(platform.app.packaged()).toBe(true);
    expect(platform.app.osTheme()).toBe('light');
    expect(platform.app.version()).toBe('2.1.1-test');
    expect(platform.app.runtimeVersion()).toBe(process.versions.node);
    expect(await platform.proxy.resolve('https://example.com')).toBe('DIRECT');
    expect(() => platform.app.quit()).not.toThrow();
  });
});

describe('loadHostRuntime', () => {
  const missing = new URL('file:///nonexistent/wirebench/host/bundle.js');

  it('imports nothing while the browser client is off', async () => {
    expect(await loadHostRuntime({ browserClient: false, bundle: missing })).toBeUndefined();
  });

  it('says to build the server when the switch is on and the bundle is missing', async () => {
    await expect(loadHostRuntime({ browserClient: true, bundle: missing })).rejects.toThrow(
      'The host bundle could not be loaded',
    );
  });
});
