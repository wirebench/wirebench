import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePluginManifest } from '#core/extension/plugin/manifest';
import {
  installedManifest,
  installStaged,
  loadInstalledPlugins,
  readPluginLock,
  removePlugin,
  stagePlugin,
} from '#core/extension/plugin/store';
import { readTgz } from '#core/extension/plugin/tar';
import { MAIN, manifest, pluginFolder, tgz } from './plugin-fixtures.js';

const temps: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-plugins-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const problemsOf = (value: Record<string, unknown>): readonly string[] => {
  const parsed = parsePluginManifest(JSON.stringify(value));
  return parsed.ok ? [] : parsed.problems;
};

describe('the plugin manifest', () => {
  it('accepts a full manifest', () => {
    expect(problemsOf(manifest({ capabilities: { network: ['https://schemas.example.test'] } }))).toEqual([]);
  });

  it('refuses network on a plugin with no importer', () => {
    const reporterOnly = manifest({
      contributes: { reporters: [{ id: 'summary', title: 'S', extension: '.txt' }] },
      capabilities: { network: ['https://example.test'] },
    });
    expect(problemsOf(reporterOnly)).toEqual(['only a plugin with an importer may list network origins']);
  });

  it.each([
    ['https://example.test/path'],
    ['https://example.test:443'],
    ['ftp://example.test'],
    ['https://*.example.test'],
    ['https://user@example.test'],
  ])('refuses %s as an origin', (value) => {
    expect(problemsOf(manifest({ capabilities: { network: [value] } }))[0]).toMatch(/must be an origin/);
  });

  it('refuses an unknown field, a bad id, a main outside the folder and a contribution twice', () => {
    expect(problemsOf(manifest({ extra: true })).length).toBeGreaterThan(0);
    expect(problemsOf(manifest({ id: 'Acme!' }))[0]).toMatch(/^id:/);
    expect(problemsOf(manifest({ main: '../main.js' }))[0]).toMatch(/^main:/);
    const twice = manifest({
      contributes: {
        importers: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      },
    });
    expect(problemsOf(twice)).toEqual(['two importers share an id']);
  });
});

describe('the plugin archive reader', () => {
  it('reads regular files and folders', () => {
    const files = readTgz(
      tgz([
        { name: 'acme/', type: '5' },
        { name: 'acme/main.js', body: 'x' },
      ]),
    );
    expect([...files.keys()]).toEqual(['acme/main.js']);
  });

  it.each([
    [[{ name: '../evil.js', body: 'x' }], /may not/],
    [[{ name: '/etc/evil', body: 'x' }], /may not/],
    [[{ name: 'a/../../evil', body: 'x' }], /may not/],
    [[{ name: 'link', type: '2' }], /not a regular file/],
    [[{ name: 'hard', type: '1' }], /not a regular file/],
    [Array.from({ length: 17 }, (_, i) => ({ name: `f${String(i)}`, body: 'x' })), /more than 16 files/],
  ])('refuses %j', (entries, message) => {
    expect(() => readTgz(tgz(entries))).toThrow(message);
  });

  it('refuses a file that is not a gzipped tar', () => {
    expect(() => readTgz(Buffer.from('not a tar'))).toThrow(/not a gzipped tar/);
  });
});

describe('installing and loading plugins', () => {
  it('installs a folder, keeps only its plugin files, and loads it back', async () => {
    const userData = await temp();
    const source = await pluginFolder(join(await temp(), 'src'));
    await writeFile(join(source, 'package.json'), '{}');
    await writeFile(join(source, 'README.md'), '# Acme');
    await installStaged(userData, await stagePlugin(source), new Date('2026-10-23T10:00:00Z'));
    const lock = readPluginLock(userData);
    expect(lock.plugins['acme']).toMatchObject({ version: '1.0.0', installedAt: '2026-10-23T10:00:00.000Z' });
    const { plugins, problems } = loadInstalledPlugins(userData);
    expect(problems).toEqual([]);
    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(['acme']);
    expect(plugins[0]?.code).toBe(MAIN);
    await expect(readFile(join(userData, 'plugins', 'acme', 'package.json'))).rejects.toThrow();
    expect(await readFile(join(userData, 'plugins', 'acme', 'README.md'), 'utf8')).toBe('# Acme');
  });

  it('installs a .tgz packed with a top folder', async () => {
    const userData = await temp();
    const archive = join(await temp(), 'acme.tgz');
    await writeFile(
      archive,
      tgz([
        { name: 'package/wirebench-plugin.json', body: JSON.stringify(manifest()) },
        { name: 'package/main.js', body: MAIN },
      ]),
    );
    await installStaged(userData, await stagePlugin(archive));
    expect(loadInstalledPlugins(userData).plugins).toHaveLength(1);
  });

  it('skips a plugin whose module changed after it was installed, until it is installed again', async () => {
    const userData = await temp();
    await installStaged(userData, await stagePlugin(await pluginFolder(join(await temp(), 'src'))));
    await writeFile(join(userData, 'plugins', 'acme', 'main.js'), `${MAIN}\n// changed`);
    expect(loadInstalledPlugins(userData)).toEqual({
      plugins: [],
      problems: [
        { id: 'acme', code: 'plugin-modified', message: 'acme changed since it was installed; install it again' },
      ],
    });
  });

  it('skips a folder nobody installed, and a symlinked one', async () => {
    const userData = await temp();
    await pluginFolder(join(userData, 'plugins', 'dropped'), manifest({ id: 'dropped' }));
    await symlink(await pluginFolder(join(await temp(), 'elsewhere')), join(userData, 'plugins', 'linked'));
    const { plugins, problems } = loadInstalledPlugins(userData);
    expect(plugins).toEqual([]);
    expect(problems.map((problem) => [problem.id, problem.code])).toEqual([
      ['dropped', 'plugin-not-installed'],
      ['linked', 'plugin-not-installed'],
    ]);
  });

  it('refuses a plugin for another API major', async () => {
    const source = await pluginFolder(join(await temp(), 'src'), manifest({ api: 2 }));
    await expect(stagePlugin(source)).rejects.toMatchObject({ code: 'plugin-api-mismatch' });
  });

  it('replaces a plugin of the same id, and removes one', async () => {
    const userData = await temp();
    await installStaged(userData, await stagePlugin(await pluginFolder(join(await temp(), 'v1'))));
    await installStaged(
      userData,
      await stagePlugin(await pluginFolder(join(await temp(), 'v2'), manifest({ version: '2.0.0' }))),
    );
    expect(installedManifest(userData, 'acme')?.version).toBe('2.0.0');
    expect(loadInstalledPlugins(userData).plugins).toHaveLength(1);
    await removePlugin(userData, 'acme');
    expect(loadInstalledPlugins(userData)).toEqual({ plugins: [], problems: [] });
    expect(readPluginLock(userData).plugins).toEqual({});
    await expect(removePlugin(userData, 'acme')).rejects.toMatchObject({ code: 'plugin-missing' });
  });
});
