import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDesktopAsar } from './check-desktop-asar.ts';

interface Node {
  files?: Record<string, Node>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

/**
 * Writes `resources/app.asar` holding the given files, in the archive format electron-builder writes:
 * a pickled header size, a pickled JSON header, then the file contents back to back. Files listed in
 * `unpacked` go to `app.asar.unpacked/` instead, as `asarUnpack` puts them.
 */
async function resources(files: Record<string, unknown>, unpacked: readonly string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asar-'));
  const root: Node = { files: {} };
  const contents: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const data = Buffer.from(JSON.stringify(value));
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.files ??= {};
      node = node.files[part] ??= { files: {} };
    }
    node.files ??= {};
    const name = parts[parts.length - 1] ?? path;
    if (unpacked.includes(path)) {
      node.files[name] = { size: data.length, unpacked: true };
      await mkdir(join(dir, 'app.asar.unpacked', ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(dir, 'app.asar.unpacked', path), data);
      continue;
    }
    node.files[name] = { size: data.length, offset: String(offset) };
    contents.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const sizes = Buffer.alloc(16);
  sizes.writeUInt32LE(4, 0);
  sizes.writeUInt32LE(8 + padded.length, 4);
  sizes.writeUInt32LE(4 + padded.length, 8);
  sizes.writeUInt32LE(json.length, 12);
  await writeFile(join(dir, 'app.asar'), Buffer.concat([sizes, padded, ...contents]));
  return dir;
}

const app = { dependencies: { '@scope/lib': '1', kerberos: '7' } };

describe('checkDesktopAsar', () => {
  it('passes when the asar holds exactly what the app depends on', async () => {
    const dir = await resources(
      {
        'package.json': app,
        'node_modules/@scope/lib/package.json': { dependencies: { shared: '1' }, peerDependencies: { electron: '1' } },
        'node_modules/shared/package.json': { optionalDependencies: { absent: '1' } },
      },
      ['node_modules/shared/package.json'],
    );
    expect(checkDesktopAsar([dir])).toEqual([]);
  });

  it('names a package nothing loads, such as the tree only kerberos depends on', async () => {
    const dir = await resources({
      'package.json': app,
      'node_modules/@scope/lib/package.json': { dependencies: { shared: '1' } },
      'node_modules/shared/package.json': {},
      'node_modules/prebuild-install/package.json': { dependencies: { shared: '1' } },
    });
    expect(checkDesktopAsar([dir])).toEqual([
      `${join(dir, 'app.asar')}: prebuild-install ships, but nothing the app loads depends on it`,
    ]);
  });

  it('names a package excluded although something the app loads depends on it', async () => {
    const dir = await resources({
      'package.json': app,
      'node_modules/@scope/lib/package.json': { dependencies: { shared: '1' } },
    });
    expect(checkDesktopAsar([dir])).toEqual([
      `${join(dir, 'app.asar')}: shared is missing, and @scope/lib depends on it`,
    ]);
  });

  it('resolves a nested copy before the top-level one', async () => {
    const dir = await resources({
      'package.json': { dependencies: { a: '1' } },
      'node_modules/a/package.json': { dependencies: { b: '2' } },
      'node_modules/a/node_modules/b/package.json': {},
      'node_modules/b/package.json': {},
    });
    expect(checkDesktopAsar([dir])).toEqual([
      `${join(dir, 'app.asar')}: b ships, but nothing the app loads depends on it`,
    ]);
  });
});
