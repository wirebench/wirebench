/**
 * The platform a user's host runs on in the server (hosted edition spec §17.3, §17.4): its paths stay in
 * the user's own directories, its secrets seal under a key only that user's host derives, and it offers
 * nothing a browser user must not reach.
 */
import { join, relative, isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { createServerPlatform, hostDirectories, userSecretsKey } from '../../../src/host/server-platform.js';
import { loadHostRuntime } from '../../../src/host/host-runtime.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

// Resolved, as the server resolves its data directory: on Windows this carries the drive letter.
const DATA_DIR = resolve('/', 'srv', 'wirebench-data');
const KEY = Buffer.alloc(32, 7);
const TENANT = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });
const OTHER = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'other' });
const TENANT_DIR = join(DATA_DIR, 'tenants', TENANT.tenantId);
const ALICE = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const BOB = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PB';

function platformFor(userId: string, dataKey = KEY, scope = TENANT): ReturnType<typeof createServerPlatform> {
  return createServerPlatform({
    userId,
    scope,
    dataDir: DATA_DIR,
    dataKey,
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
    const checkout = join(TENANT_DIR, 'checkouts', ALICE);
    expect(platform.paths.userData()).toBe(checkout);
    expect(platform.paths.root()).toBe(checkout);
    expect(isInside(checkout, platform.paths.logs())).toBe(true);
  });

  it('gives each user a temp directory of their own, outside every checkout', () => {
    const alice = platformFor(ALICE).paths.temp();
    const bob = platformFor(BOB).paths.temp();
    expect(alice).toBe(join(TENANT_DIR, 'tmp', 'hosts', ALICE));
    expect(alice).not.toBe(bob);
    expect(isInside(join(TENANT_DIR, 'checkouts'), alice)).toBe(false);
  });

  it('gives one user id in two tenants two checkouts and two temp directories (Task 16 review M1)', () => {
    const here = platformFor(ALICE);
    const there = platformFor(ALICE, KEY, OTHER);
    expect(there.paths.root()).toBe(join(DATA_DIR, 'tenants', OTHER.tenantId, 'checkouts', ALICE));
    expect(isInside(here.paths.root(), there.paths.root())).toBe(false);
    expect(isInside(there.paths.root(), here.paths.root())).toBe(false);
    expect(here.paths.temp()).not.toBe(there.paths.temp());
  });

  it('names nothing outside the user checkout but that temp directory', () => {
    const platform = platformFor(ALICE);
    const { checkout, temp } = hostDirectories(DATA_DIR, TENANT, ALICE);
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
  it("derives a different key per user, and a different one under another tenant's data key", () => {
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

  it("does not open a box sealed under another tenant's data key", () => {
    const sealed = platformFor(ALICE).secrets.encrypt('value');
    expect(() => platformFor(ALICE, Buffer.alloc(32, 9), OTHER).secrets.decrypt(sealed)).toThrow();
  });

  it("opens nothing under slice 2's root-derived key: the re-wrap moves those blobs before any host opens", () => {
    const root = Buffer.alloc(32, 3);
    expect(() => platformFor(ALICE).secrets.decrypt(seal(userSecretsKey(root, ALICE), 'from slice 2'))).toThrow();
    // What it seals opens under the data key's user key alone.
    expect(open(userSecretsKey(KEY, ALICE), platformFor(ALICE).secrets.encrypt('new'))).toBe('new');
  });
});

describe('server platform surface (§17.3)', () => {
  it('has send:public alone, no machine values, the egress rule and no optional members', () => {
    const platform = platformFor(ALICE);
    expect([...platform.capabilities]).toEqual(['send:public']);
    // Accounts and secret values stay in the desktop: a browser tab manages neither.
    for (const capability of ['accounts', 'reveal-secrets']) {
      expect((platform.capabilities as ReadonlySet<string>).has(capability)).toBe(false);
    }
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
