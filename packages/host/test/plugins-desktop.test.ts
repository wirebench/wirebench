// @vitest-environment node
/**
 * Plugins in the desktop's main process (phase 7 spec §6, §9; ADR-0031): loaded once from userData into
 * the start-up registry, listed for Settings, installed only from a path the person picked, and their
 * switches resolved like a built-in's.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startupFeatures } from '../src/features/startup.js';
import { registerPluginChannels } from '../src/ipc/plugins.js';
import { loadDesktopPlugins, type DesktopPlugins } from '../src/plugins/desktop-plugins.js';
import { isCodeLanguage } from '@wirebench/wire/code-targets';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const MANIFEST = {
  manifestVersion: 1,
  id: 'acme',
  name: 'Acme formats',
  version: '1.0.0',
  api: 1,
  main: 'main.js',
  contributes: {
    reporters: [{ id: 'summary', title: 'Acme summary', extension: '.txt' }],
    codeGenerators: [{ id: 'kotlin', title: 'Kotlin', language: 'kotlin' }],
  },
};
const MAIN = `export const reporters = { summary: { render() { return 'x'; } } };
export const codeGenerators = { kotlin: { generate() { return { code: 'fun main() {}', notes: [] }; } } };`;

const temps: string[] = [];
const hosts: DesktopPlugins[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-desktop-plugins-'));
  temps.push(dir);
  return dir;
}
async function source(): Promise<string> {
  const dir = join(await temp(), 'acme');
  await mkdir(dir);
  await writeFile(join(dir, 'wirebench-plugin.json'), JSON.stringify(MANIFEST));
  await writeFile(join(dir, 'main.js'), MAIN);
  return dir;
}
const load = (userData: string, off = false): DesktopPlugins => {
  const plugins = loadDesktopPlugins({ userData, off });
  hosts.push(plugins);
  return plugins;
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((plugins) => plugins.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the desktop’s plugins', () => {
  it('stages, installs for the next start, lists and removes', async () => {
    const userData = await temp();
    const plugins = load(userData);
    expect(plugins.list()).toEqual({ plugins: [], skipped: [], off: false });
    const staged = await plugins.stage(await source());
    expect(staged.plugin).toMatchObject({
      id: 'acme',
      reporters: [{ id: 'acme/summary', title: 'Acme summary', extension: '.txt' }],
      codeGenerators: [{ id: 'acme/kotlin', language: 'kotlin' }],
      network: [],
    });
    expect(plugins.list().plugins).toEqual([]);
    expect(await plugins.install(staged.token)).toEqual({ id: 'acme' });
    await expect(plugins.install(staged.token)).rejects.toMatchObject({ code: 'plugin-install-refused' });
    expect(plugins.list().plugins.map((row) => [row.id, row.loaded])).toEqual([['acme', false]]);
    await plugins.remove('acme');
    expect(plugins.list().plugins).toEqual([]);
  });

  it('composes a loaded plugin into the start-up registry, behind its own switch', async () => {
    const userData = await temp();
    const installer = load(userData);
    await installer.install((await installer.stage(await source())).token);
    const plugins = load(userData);
    expect(plugins.list().plugins[0]?.loaded).toBe(true);
    const run = startupFeatures({
      preferences: { features: {} },
      isPackaged: true,
      ...(plugins.host !== undefined ? { plugins: plugins.host } : {}),
    });
    expect(run.states.find((state) => state.id === 'plugin:acme')).toMatchObject({
      enabled: true,
      requires: ['plugins'],
    });
    expect(run.registry.extensions.codeGenerators.map((entry) => entry.id)).toContain('acme/kotlin');
    const policed = run.forPolicy(['plugin:acme']);
    expect(policed.registry.extensions.codeGenerators.map((entry) => entry.id)).not.toContain('acme/kotlin');
    expect(policed.states.find((state) => state.id === 'plugin:acme')).toMatchObject({ enabled: false, policy: true });
  });

  it('loads nothing with the plugins switch off', async () => {
    const userData = await temp();
    const installer = load(userData);
    await installer.install((await installer.stage(await source())).token);
    const off = load(userData, true);
    expect(off.host).toBeUndefined();
    expect(off.list()).toMatchObject({ off: true, plugins: [{ id: 'acme', loaded: false }] });
  });

  it('stages only a path the person picked in this window', async () => {
    const userData = await temp();
    const plugins = load(userData);
    const picked = new Set<string>();
    registerPluginChannels(table, { plugins: () => plugins, picks: { hasRead: (path) => picked.has(path) } });
    const stage = handlers.get('plugins.stage');
    const path = await source();
    expect(await stage?.({}, { path })).toMatchObject({ ok: false, error: { code: 'path-not-picked' } });
    picked.add(path);
    expect(await stage?.({}, { path })).toMatchObject({ ok: true, value: { plugin: { id: 'acme' } } });
  });

  it('remembers a plugin generator as the Code panel’s language', () => {
    expect(isCodeLanguage('acme/kotlin')).toBe(true);
    expect(isCodeLanguage('Acme/../x')).toBe(false);
  });
});
