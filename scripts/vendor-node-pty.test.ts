import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tarEntry } from './vendor-kerberos.ts';
import { lockedBindings, vendorNodePty } from './vendor-node-pty.ts';

/** A registry tarball: every file under `package/`. */
function tarball(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([name, content]) => tarEntry(`package/${name}`, Buffer.from(content)));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}
const integrity = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const LOCK = `
packages:

  '@lydell/node-pty-darwin-arm64@1.1.0':
    resolution: {integrity: sha512-AAA=}
    cpu: [arm64]
    os: [darwin]

  '@lydell/node-pty-darwin-x64@1.1.0':
    resolution: {integrity: sha512-BBB=}
    cpu: [x64]
    os: [darwin]

  '@lydell/node-pty-linux-x64@1.1.0':
    resolution: {integrity: sha512-CCC=}
    cpu: [x64]
    os: [linux]

  '@lydell/node-pty@1.1.0':
    resolution: {integrity: sha512-DDD=}
`;

describe('lockedBindings', () => {
  it('reads the integrity of each of the platform’s bindings at the locked version from the lockfile', () => {
    expect(lockedBindings(LOCK, '1.1.0', 'darwin')).toEqual({
      'darwin-arm64': 'sha512-AAA=',
      'darwin-x64': 'sha512-BBB=',
    });
    expect(lockedBindings(LOCK, '1.1.0', 'linux')).toEqual({ 'linux-x64': 'sha512-CCC=' });
    expect(lockedBindings(LOCK, '1.2.0', 'linux')).toEqual({});
  });

  it('pins every binding the real lockfile has, for every platform', async () => {
    const lock = await readFile(join(import.meta.dirname, '..', 'pnpm-lock.yaml'), 'utf8');
    const desktop = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'apps', 'desktop', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const version = desktop.dependencies['@lydell/node-pty'] ?? '';
    expect(Object.keys(lockedBindings(lock, version, 'darwin')).sort()).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(Object.keys(lockedBindings(lock, version, 'linux')).sort()).toEqual(['linux-arm64', 'linux-x64']);
    expect(Object.keys(lockedBindings(lock, version, 'win32')).sort()).toEqual(['win32-arm64', 'win32-x64']);
  });
});

describe('vendorNodePty', () => {
  it('writes each binding as its package, executables runnable, debug symbols and readme left out', async () => {
    const bytes = tarball({
      'package.json': '{"name":"@lydell/node-pty-darwin-arm64"}',
      'pty.node': 'mach-o',
      'spawn-helper': 'helper',
      'README.md': 'readme',
      'conpty.pdb': 'symbols',
    });
    const outDir = await mkdtemp(join(tmpdir(), 'pty-'));
    const urls: string[] = [];
    const written = await vendorNodePty({
      platform: 'darwin',
      version: '1.1.0',
      outDir,
      pins: { 'darwin-arm64': integrity(bytes) },
      fetchBytes: (url) => {
        urls.push(url);
        return Promise.resolve(bytes);
      },
    });
    expect(urls).toEqual([
      'https://registry.npmjs.org/@lydell/node-pty-darwin-arm64/-/node-pty-darwin-arm64-1.1.0.tgz',
    ]);
    expect(written).toEqual([join(outDir, 'node-pty-darwin-arm64')]);
    const dir = join(outDir, 'node-pty-darwin-arm64');
    await expect(readFile(join(dir, 'pty.node'), 'utf8')).resolves.toBe('mach-o');
    await expect(readFile(join(dir, 'package.json'), 'utf8')).resolves.toContain('node-pty-darwin-arm64');
    await expect(stat(join(dir, 'README.md'))).rejects.toThrow();
    await expect(stat(join(dir, 'conpty.pdb'))).rejects.toThrow();
    if (process.platform !== 'win32') expect((await stat(join(dir, 'spawn-helper'))).mode & 0o111).not.toBe(0);
  });

  it('fails the build when a tarball does not match the lockfile, and leaves outDir as it was', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'pty-'));
    await mkdir(join(outDir, 'node-pty-linux-x64'));
    await writeFile(join(outDir, 'node-pty-linux-x64', 'pty.node'), 'old');
    await expect(
      vendorNodePty({
        platform: 'linux',
        version: '1.1.0',
        outDir,
        pins: { 'linux-x64': 'sha512-AAA=' },
        fetchBytes: () => Promise.resolve(tarball({ 'pty.node': 'x' })),
      }),
    ).rejects.toThrow(/integrity mismatch for linux-x64/);
    await expect(readFile(join(outDir, 'node-pty-linux-x64', 'pty.node'), 'utf8')).resolves.toBe('old');
  });

  it('refuses a platform the lockfile pins nothing for', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'pty-'));
    await expect(
      vendorNodePty({
        platform: 'linux',
        version: '1.1.0',
        outDir,
        pins: {},
        fetchBytes: () => Promise.reject(new Error('no network')),
      }),
    ).rejects.toThrow('No locked node-pty bindings for linux');
  });
});
