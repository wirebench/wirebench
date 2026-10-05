import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { download, tarEntry, vendorKerberos } from './vendor-kerberos.ts';

/** A one-entry ustar archive, gzipped: the shape of a real prebuild tarball. */
function tarball(content: string): Buffer {
  return gzipSync(Buffer.concat([tarEntry('build/Release/kerberos.node', Buffer.from(content)), Buffer.alloc(1024)]));
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('vendorKerberos', () => {
  it('writes every prebuild of the platform when its hash matches', async () => {
    const bytes = tarball('fat-binary');
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    const written = await vendorKerberos({
      platform: 'darwin',
      outDir,
      pins: { 'darwin-arm64': sha(bytes), 'darwin-x64': sha(bytes), 'linux-x64': 'x' },
      fetchBytes: () => Promise.resolve(bytes),
    });
    expect(written.map((path) => path.slice(outDir.length + 1)).sort()).toEqual([
      join('darwin-arm64', 'kerberos.node'),
      join('darwin-x64', 'kerberos.node'),
    ]);
    await expect(readFile(join(outDir, 'darwin-x64', 'kerberos.node'), 'utf8')).resolves.toBe('fat-binary');
  });

  it('fails the build on a hash mismatch', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    await expect(
      vendorKerberos({
        platform: 'linux',
        outDir,
        pins: { 'linux-x64': '00' },
        fetchBytes: () => Promise.resolve(tarball('x')),
      }),
    ).rejects.toThrow(/SHA-256 mismatch for linux-x64/);
  });

  it('vendors only what is pinned: win32 has x64 alone', async () => {
    const bytes = tarball('w');
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    const written = await vendorKerberos({
      platform: 'win32',
      outDir,
      pins: { 'win32-x64': sha(bytes) },
      fetchBytes: () => Promise.resolve(bytes),
    });
    expect(written).toEqual([join(outDir, 'win32-x64', 'kerberos.node')]);
  });

  it('pins a real hash for every prebuild', async () => {
    const pins = JSON.parse(await readFile(join(import.meta.dirname, 'kerberos-prebuilds.json'), 'utf8')) as {
      prebuilds: Record<string, string>;
    };
    for (const value of Object.values(pins.prebuilds)) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a platform with no pins and leaves outDir alone', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    await writeFile(join(outDir, 'keep.txt'), 'prior');
    await expect(
      vendorKerberos({ platform: 'linux', outDir, pins: {}, fetchBytes: () => Promise.resolve(Buffer.alloc(0)) }),
    ).rejects.toThrow('No pinned Kerberos prebuilds for platform linux.');
    await expect(readFile(join(outDir, 'keep.txt'), 'utf8')).resolves.toBe('prior');
  });

  it('leaves the previous content untouched on a hash mismatch', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    await mkdir(join(outDir, 'linux-x64'));
    await writeFile(join(outDir, 'linux-x64', 'kerberos.node'), 'old');
    await expect(
      vendorKerberos({
        platform: 'linux',
        outDir,
        pins: { 'linux-x64': '00' },
        fetchBytes: () => Promise.resolve(tarball('new')),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(readFile(join(outDir, 'linux-x64', 'kerberos.node'), 'utf8')).resolves.toBe('old');
  });

  it('refuses a tarball without the binding', async () => {
    const bytes = gzipSync(Buffer.concat([tarEntry('build/Release/other.node', Buffer.from('x')), Buffer.alloc(1024)]));
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    await expect(
      vendorKerberos({
        platform: 'linux',
        outDir,
        pins: { 'linux-x64': sha(bytes) },
        fetchBytes: () => Promise.resolve(bytes),
      }),
    ).rejects.toThrow(/build\/Release\/kerberos\.node is not in the tarball/);
  });
});

describe('download', () => {
  it('retries a flaky response and then succeeds', async () => {
    const responses = [new Error('socket hang up'), new Response('', { status: 503 }), new Response('ok')];
    let calls = 0;
    const fetchFn = (() => {
      const next = responses[calls++];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }) as typeof fetch;
    await expect(download('https://example.test/a', { fetchFn, delaysMs: [0, 0] })).resolves.toEqual(Buffer.from('ok'));
    expect(calls).toBe(3);
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 404 }));
    }) as typeof fetch;
    await expect(download('https://example.test/a', { fetchFn, delaysMs: [0, 0] })).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it('gives up after three attempts', async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 429 }));
    }) as typeof fetch;
    await expect(download('https://example.test/a', { fetchFn, delaysMs: [0, 0] })).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(3);
  });
});

describe('vendor-kerberos run as a command', () => {
  // A symlinked path to the script (a linked checkout, a package manager's shim) is still the script.
  it.skipIf(process.platform === 'win32')('runs its command through a symlinked path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'krb-link-'));
    const link = join(dir, 'vendor-kerberos.ts');
    await symlink(fileURLToPath(new URL('./vendor-kerberos.ts', import.meta.url)), link);

    const run = spawnSync(process.execPath, [link, 'plan9'], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('kerberos: unsupported platform "plan9"');
  });
});
