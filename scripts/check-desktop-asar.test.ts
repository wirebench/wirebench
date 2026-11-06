import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDesktopAsar, excludedButNeeded, excludedTopLevelPackages } from './check-desktop-asar.ts';

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

describe('the imports of our own packages', () => {
  const tree = {
    'package.json': { dependencies: { '@wirebench/engine': '1', '@wirebench/protocol-rest': '1' } },
    'node_modules/@wirebench/engine/package.json': {
      imports: { '#protocol-rest/*': { development: './src/*.ts', default: '@wirebench/protocol-rest/*' } },
    },
    'node_modules/@wirebench/protocol-rest/package.json': {
      exports: { './*': { development: './src/*.ts', types: './dist/*.d.ts', default: './dist/*.js' } },
    },
    'node_modules/@wirebench/engine/dist/index.js':
      "export { documentFor } from '#protocol-rest/rest/docs/document'; import x from 'third-party';",
    'node_modules/@wirebench/protocol-rest/dist/rest/browser.js':
      "import { documentFor } from './docs/document.js'; const m = await import('../index.js');",
    'node_modules/@wirebench/protocol-rest/dist/index.js': 'export {};',
  };

  it('passes when every relative, # and @wirebench import resolves inside the asar', async () => {
    const dir = await resources({
      ...tree,
      'node_modules/@wirebench/protocol-rest/dist/rest/docs/document.js': 'export const documentFor = 1;',
    });
    expect(checkDesktopAsar([dir])).toEqual([]);
  });

  // 7.0.0-rc.1: the docs exclusion dropped protocol-rest's dist/rest/docs/, and the app did not start.
  it('names each import of a folder an exclusion dropped', async () => {
    const dir = await resources(tree);
    expect(checkDesktopAsar([dir])).toEqual([
      `${join(dir, 'app.asar')}: @wirebench/engine/dist/index.js imports #protocol-rest/rest/docs/document, which is not in the asar`,
      `${join(dir, 'app.asar')}: @wirebench/protocol-rest/dist/rest/browser.js imports ./docs/document.js, which is not in the asar`,
    ]);
  });
});

describe('the electron-builder exclusion list', () => {
  // The release checks the packed asar; this catches the same mistake on a pull request, against the
  // installed tree: a package only `kerberos` needed becoming a dependency of something that ships.
  it('leaves out no package the app loads', () => {
    const excluded = excludedTopLevelPackages(readFileSync('apps/desktop/electron-builder.yml', 'utf8'));
    expect(excluded).toContain('prebuild-install');
    expect(excludedButNeeded('apps/desktop', excluded)).toEqual([]);
  });

  // ssh2's native cipher binding is never built (#362). Its build folder and the two optional packages
  // only the binding needs are excluded by name: the asar check cannot catch them by itself, since an
  // optional dependency counts wherever it is present.
  it('keeps the ssh2 binding, cpu-features and nan out of the asar', () => {
    const builderYaml = readFileSync('apps/desktop/electron-builder.yml', 'utf8');
    for (const pattern of [
      "'!**/node_modules/ssh2/lib/protocol/crypto/build/**'",
      "'!**/node_modules/cpu-features/**'",
      "'!**/node_modules/nan/**'",
    ]) {
      expect(builderYaml).toContain(pattern);
    }
  });

  // The release's asar check catches this too, but only once a tag is pushed.
  it('drops tests, docs and examples from third-party packages only, never from ours', () => {
    const builderYaml = readFileSync('apps/desktop/electron-builder.yml', 'utf8');
    expect(builderYaml).toContain("'!**/node_modules/!(@wirebench)/**/{test,__tests__,docs,example,examples}/**'");
    expect(builderYaml).not.toContain("'!**/node_modules/**/{test,__tests__,docs,example,examples}/**'");
  });
});
