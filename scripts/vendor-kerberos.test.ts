import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tarEntry, vendorKerberos } from './vendor-kerberos.ts';

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
});
