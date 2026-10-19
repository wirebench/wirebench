/**
 * `wirebench scripts convert` (convert-imported-scripts spec §10): the preview prints each layered
 * level's diff and TODOs and writes nothing; `--write` writes the backups, switches the levels and
 * saves through the engine; a level that does not parse is listed and skipped.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createApi,
  createFolder,
  createProject,
  createRestRequest,
  loadProject,
  restApisOf,
  saveProject,
  withRestApis,
} from '@wirebench/engine';
import type { RequestScripts, RestApi } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptsConvertCommand, unifiedDiff } from '../../src/commands/scripts-convert.js';
import { ExitCode } from '../../src/exit-codes.js';
import type { CliIo } from '../../src/main.js';
import { removeTempDirs, tempDir } from './ops/helpers.js';

afterEach(removeTempDirs);

const bruno = (pre: string | undefined, post?: string): RequestScripts => ({
  ...(pre !== undefined ? { pre: { text: pre } } : {}),
  ...(post !== undefined ? { post: { text: post } } : {}),
  api: 'bruno',
  enabled: false,
  secrets: [],
});

/** A REST API with a layered API level, a layered request in a folder, and one whose pre does not parse. */
async function layeredProject(): Promise<string> {
  const dir = await tempDir('wirebench-convert-');
  const shop: RestApi = {
    ...createApi('Shop', { id: 'shop' }),
    scripts: bruno("bru.setVar('a', '1');\n"),
    folders: [
      {
        ...createFolder('Carts', { id: 'carts' }),
        requests: [
          {
            ...createRestRequest('Create cart', { id: 'create' }),
            scripts: bruno("bru.setVar('c', '3');\n", "bru.sendRequest({});\nbru.setVar('d', '4');\n"),
          },
        ],
      },
    ],
    requests: [{ ...createRestRequest('Broken', { id: 'broken' }), scripts: bruno('const a = 1;\nbru.setVar(;\n') }],
  };
  await saveProject(withRestApis(createProject('Convert', { id: 'convert' }), [shop]), dir);
  return dir;
}

function io(): { io: CliIo; out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  return { io: { stdout, stderr, env: {} }, out: () => out, err: () => err };
}

/** Every file under `dir` with its text, keyed by its `/`-separated path, so a test can say nothing changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(dir, path).split(sep).join('/')] = await readFile(path, 'utf8');
    }
  }
  return files;
}

const scriptsOf = async (dir: string): Promise<Record<string, RequestScripts | undefined>> => {
  const api = restApisOf((await loadProject(dir)).project)[0]!;
  return {
    api: api.scripts,
    folder: api.folders[0]?.scripts,
    create: api.folders[0]?.requests[0]?.scripts,
    broken: api.requests[0]?.scripts,
  };
};

const convert = (path: string, selectors: readonly string[], write: boolean, cli: CliIo): Promise<ExitCode> =>
  scriptsConvertCommand({ command: 'scripts-convert', path, selectors, write }, cli);

describe('wirebench scripts convert', () => {
  it('the preview writes nothing', async () => {
    const dir = await layeredProject();
    const before = await snapshot(dir);
    const cli = io();

    expect(await convert(dir, [], false, cli.io)).toBe(ExitCode.Ok);

    expect(await snapshot(dir)).toEqual(before);
    const out = cli.out();
    expect(out).toContain('Shop (bruno)');
    expect(out).toContain('Shop / Carts / Create cart (bruno)');
    expect(out).toContain("-bru.setVar('c', '3');\n+// Converted from a bruno script");
    expect(out).toContain('+// Converted from a bruno script');
    expect(out).toMatch(/^--- .*pre/m);
    expect(out).toMatch(/^\+\+\+ .*pre/m);
    expect(out).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/m);
    expect(out).toMatch(/ {2}line \d+: bru\.sendRequest — /);
    expect(out).toMatch(/^2 levels, \d+ mapped calls?, 1 TODO, 1 skipped$/m);
    expect(out).toContain('--write');
  });

  it('--write converts and backs up', async () => {
    const dir = await layeredProject();
    const cli = io();

    expect(await convert(dir, [], true, cli.io)).toBe(ExitCode.Ok);

    const scripts = await scriptsOf(dir);
    expect(scripts.api?.api).toBe('wirebench');
    expect(scripts.create?.api).toBe('wirebench');
    expect(scripts.create?.pre?.text).toContain("vars.set('c', '3')");
    expect(scripts.create?.enabled).toBe(false);
    const files = Object.keys(await snapshot(dir));
    const backups = files.filter((file) => file.startsWith('imported-scripts/')).sort();
    expect(backups).toEqual([
      'imported-scripts/shop/shop-carts-create cart.post.js',
      'imported-scripts/shop/shop-carts-create cart.pre.js',
      'imported-scripts/shop/shop.pre.js',
    ]);
    expect(await readFile(join(dir, 'imported-scripts/shop/shop-carts-create cart.pre.js'), 'utf8')).toBe(
      "bru.setVar('c', '3');\n",
    );
    // The converted levels' .js files are gone; the skipped one keeps its own.
    expect(files.filter((file) => file.endsWith('.js') && !file.startsWith('imported-scripts/'))).toEqual([
      expect.stringContaining('Broken.pre.js'),
    ]);
    for (const backup of backups) expect(cli.out()).toContain(backup);
    expect(cli.out()).toMatch(/^Converted 2 levels, \d+ mapped calls?, 1 TODO, 1 skipped\.$/m);
  });

  it('a syntax error is listed and skipped', async () => {
    const dir = await layeredProject();
    const cli = io();

    expect(await convert(dir, ['Shop/Broken'], true, cli.io)).toBe(ExitCode.Ok);

    expect(cli.out()).toMatch(/^Shop \/ Broken \(bruno\): skipped, pre line 2: .+$/m);
    expect((await scriptsOf(dir)).broken?.api).toBe('bruno');
    expect(Object.keys(await snapshot(dir)).some((file) => file.startsWith('imported-scripts/'))).toBe(false);
  });

  it('a selector converts only the levels at or below it', async () => {
    const dir = await layeredProject();
    const cli = io();

    expect(await convert(dir, ['Shop/Carts', 'apis/Shop/requests/Carts/Create cart'], true, cli.io)).toBe(ExitCode.Ok);

    const scripts = await scriptsOf(dir);
    expect(scripts.create?.api).toBe('wirebench');
    expect(scripts.api?.api).toBe('bruno');
    expect(scripts.broken?.api).toBe('bruno');
    expect(cli.out()).toMatch(/^Converted 1 level, /m);
  });

  it('--write refuses levels that share an id and converts the others', async () => {
    const dir = await layeredProject();
    const cli = io();
    // A copied request file keeps its id: the folder now holds two requests with the id `create`.
    const carts = join(dir, 'apis/Shop/requests/Carts');
    const yaml = await readFile(join(carts, 'Create cart.request.yaml'), 'utf8');
    await writeFile(
      join(carts, 'Copy.request.yaml'),
      yaml
        .replace('name: Create cart', 'name: Copy')
        .replace('order: 0', 'order: 1')
        .replace('  post: Create cart.post.js\n', '')
        .replace('Create cart.pre.js', 'Copy.pre.js'),
    );
    await writeFile(join(carts, 'Copy.pre.js'), "bru.setVar('x', '9');\n");

    expect(await convert(dir, ['Shop'], true, cli.io)).toBe(ExitCode.Ok);

    const out = cli.out();
    expect(out).toContain('Converted Shop (bruno): ');
    expect(out).toContain('Shop / Carts / Create cart (bruno): skipped (another level has the same id)\n');
    expect(out).toContain('Shop / Carts / Copy (bruno): skipped (another level has the same id)\n');
    expect(out).toMatch(/^Converted 1 level, .*, 3 skipped\.$/m);
    const loaded = await loadProject(dir);
    const api = restApisOf(loaded.project)[0]!;
    expect(api.scripts?.api).toBe('wirebench');
    expect(api.folders[0]?.requests.map((request) => request.scripts)).toEqual([
      bruno("bru.setVar('c', '3');\n", "bru.sendRequest({});\nbru.setVar('d', '4');\n"),
      bruno("bru.setVar('x', '9');\n"),
    ]);
    const backups = Object.keys(await snapshot(dir)).filter((file) => file.startsWith('imported-scripts/'));
    expect(backups).toEqual(['imported-scripts/shop/shop.pre.js']);
  });

  it('a selector that matches nothing is a usage error', async () => {
    const dir = await layeredProject();
    const cli = io();
    expect(await convert(dir, ['Nope'], false, cli.io)).toBe(ExitCode.Usage);
    expect(cli.err()).toContain('Nope');
  });

  it('a backup that cannot be written stops before the save', async () => {
    const dir = await layeredProject();
    const before = await scriptsOf(dir);
    // A file where the API's backup folder would be: no backup can be created under it.
    await mkdir(join(dir, 'imported-scripts'));
    await writeFile(join(dir, 'imported-scripts', 'shop'), 'not a folder');
    const cli = io();

    expect(await convert(dir, [], true, cli.io)).toBe(ExitCode.RunError);

    expect(await scriptsOf(dir)).toEqual(before);
    expect(cli.err()).toMatch(/^backup-failed: /m);
    expect(cli.err()).toContain('the project is not saved; backups already written stay in imported-scripts/\n');
  });

  it('a backup that fails part way keeps the backups already written and saves nothing', async () => {
    const dir = await layeredProject();
    const before = await scriptsOf(dir);
    // An empty folder where the last backup goes: the listing shows no file, so the path is chosen
    // and its exclusive create fails after the others were written.
    await mkdir(join(dir, 'imported-scripts/shop/shop-carts-create cart.post.js'), { recursive: true });
    const cli = io();

    expect(await convert(dir, [], true, cli.io)).toBe(ExitCode.RunError);

    expect(await scriptsOf(dir)).toEqual(before);
    expect(await readFile(join(dir, 'imported-scripts/shop/shop.pre.js'), 'utf8')).toBe("bru.setVar('a', '1');\n");
    expect(cli.err()).toMatch(
      /^backup-failed: imported-scripts\/shop\/shop-carts-create cart\.post\.js: .+; the project is not saved; backups already written stay in imported-scripts\/$/m,
    );
  });

  it('exit 3 when the project cannot be loaded', async () => {
    const dir = await tempDir('wirebench-convert-');
    await mkdir(join(dir, 'empty'));
    const cli = io();

    expect(await convert(join(dir, 'empty'), [], false, cli.io)).toBe(ExitCode.RunError);
    expect(cli.err()).toContain('project-not-found');
  });
});

describe('unifiedDiff', () => {
  it('prints removals before additions, three lines of context, and one hunk per distant change', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n';
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l'].join('\n') + '\n';
    expect(unifiedDiff(before, after, 'old', 'new')).toBe(
      [
        '--- old',
        '+++ new',
        '@@ -1,4 +1,4 @@',
        '-a',
        '+A',
        ' b',
        ' c',
        ' d',
        '@@ -8,4 +8,5 @@',
        ' h',
        ' i',
        ' j',
        '-k',
        '+K',
        '+l',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff('x\n', 'x\n', 'old', 'new')).toBe('');
    expect(unifiedDiff('', 'x\n', 'old', 'new')).toBe('--- old\n+++ new\n@@ -0,0 +1 @@\n+x\n');
  });
});
