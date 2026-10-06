// packages/engine/test/unit/secrets/sources/getter.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  effectiveSecretSources,
  parseLocalSecretSources,
  parseSecretSources,
} from '../../../../src/secrets/sources/parse.js';
import { createSourceCache, sourceGetter, type SourceGetterOptions } from '../../../../src/secrets/sources/getter.js';
import { secretSourcesHash } from '../../../../src/secrets/sources/trust.js';

const shared = parseSecretSources({
  db: { kind: 'vault', path: 'kv/app', field: 'password' },
  bad: { kind: 'vault', path: '-x', field: 'f' },
  win: { kind: 'keychain', service: 's', account: 'a' },
}).sources;
const hash = secretSourcesHash(shared);

function setup(overrides: Partial<SourceGetterOptions> = {}) {
  const run = vi.fn(() => Promise.resolve({ stdout: 'pw\n', stderr: '', exitCode: 0 }));
  const find = vi.fn((tool: string) => Promise.resolve(`/bin/${tool}`));
  const next = vi.fn((ref: string) =>
    Promise.resolve(ref === 'secret:other' ? 'from-store' : ref === 'secret:db' ? 'stale' : undefined),
  );
  const values: string[] = [];
  let clock = 0;
  const options: SourceGetterOptions = {
    sources: effectiveSecretSources(shared, undefined),
    sharedHash: hash,
    trust: { mode: 'approved', hash },
    cache: createSourceCache(),
    cacheMs: 1000,
    onValue: (value) => values.push(value),
    platform: 'linux',
    env: {},
    find,
    run,
    now: () => clock,
    ...overrides,
  };
  return {
    get: sourceGetter(next, options),
    run: (overrides.run ?? run) as typeof run,
    next,
    values,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('sourceGetter', () => {
  it('answers a mapped name from its source and records the value', async () => {
    const { get, run, next, values } = setup();
    expect(await get('secret:db')).toBe('pw');
    expect(run).toHaveBeenCalledWith('/bin/vault', ['kv', 'get', '-field=password', 'kv/app'], expect.anything());
    expect(next).not.toHaveBeenCalled();
    expect(values).toEqual(['pw']);
  });

  it('passes unmapped names and opaque refs to the next getter', async () => {
    const { get, run } = setup();
    expect(await get('secret:other')).toBe('from-store');
    expect(await get('sec_123')).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('never falls back when a mapped source fails', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: '', stderr: 'permission denied\n', exitCode: 2 }));
    const { get, next } = setup({ run });
    const error = (await get('secret:db').catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: 'secret-source-failed', details: { name: 'db', kind: 'vault' } });
    expect(error.message).toContain('permission denied');
    expect(next).not.toHaveBeenCalled();
  });

  it('masks stderr and cuts it to 1 KiB', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: '', stderr: `token=abc ${'x'.repeat(3000)}`, exitCode: 1 }));
    const { get } = setup({ run, mask: (text) => text.replace('abc', '<redacted>') });
    const error = (await get('secret:db').catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('<redacted>');
    expect(error.message).not.toContain('abc');
    expect(error.message.length).toBeLessThan(1300);
  });

  it('refuses an invalid entry, an untrusted mapping and the Windows keychain without spawning', async () => {
    const invalid = setup();
    await expect(invalid.get('secret:bad')).rejects.toMatchObject({
      code: 'secret-source-invalid',
      details: { name: 'bad', field: 'path' },
    });
    const untrusted = setup({ trust: { mode: 'approved', hash: undefined } });
    await expect(untrusted.get('secret:db')).rejects.toMatchObject({
      code: 'secret-source-untrusted',
      details: { name: 'db' },
    });
    const windows = setup({ platform: 'win32' });
    await expect(windows.get('secret:win')).rejects.toMatchObject({
      code: 'secret-source-unsupported',
      details: { name: 'win', kind: 'keychain' },
    });
    expect(invalid.run).not.toHaveBeenCalled();
    expect(untrusted.run).not.toHaveBeenCalled();
    expect(windows.run).not.toHaveBeenCalled();
  });

  it('trusts local entries without an approval', async () => {
    const local = parseLocalSecretSources({ db: { kind: '1password', ref: 'op://a/b/c' } }).sources;
    const { get, run } = setup({
      sources: effectiveSecretSources(shared, local),
      trust: { mode: 'approved', hash: undefined },
    });
    expect(await get('secret:db')).toBe('pw');
    expect(run).toHaveBeenCalledWith('/bin/op', ['read', 'op://a/b/c'], expect.anything());
  });

  it('shares one spawn between concurrent calls and caches for cacheMs', async () => {
    const { get, run, tick } = setup();
    await Promise.all([get('secret:db'), get('secret:db'), get('secret:db')]);
    expect(run).toHaveBeenCalledTimes(1);
    tick(999);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
    tick(2);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records a cached value each time it is handed out', async () => {
    const { get, values } = setup();
    await get('secret:db');
    await get('secret:db');
    expect(values).toEqual(['pw', 'pw']);
  });

  it('shares one cache across getters and clears it', async () => {
    const cache = createSourceCache();
    const first = setup({ cache });
    await first.get('secret:db');
    const second = setup({ cache, run: first.run });
    await second.get('secret:db');
    expect(first.run).toHaveBeenCalledTimes(1);
    cache.clear();
    await second.get('secret:db');
    expect(first.run).toHaveBeenCalledTimes(2);
  });

  it('refuses a SourceCache that createSourceCache did not make', () => {
    expect(() => setup({ cache: { clear: vi.fn() } })).toThrow(/createSourceCache/);
  });

  it('does not cache a failure', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'down', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: 'pw', stderr: '', exitCode: 0 });
    const { get } = setup({ run });
    await expect(get('secret:db')).rejects.toBeDefined();
    expect(await get('secret:db')).toBe('pw');
  });

  it('with cacheMs 0 shares only the in-flight lookup', async () => {
    const { get, run } = setup({ cacheMs: 0 });
    await Promise.all([get('secret:db'), get('secret:db')]);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
