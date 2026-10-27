// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerHistoryStore, RunnerSettingsStore } from '../src/runner/stores.js';
import { defaultRunnerSettings, RUNNER_HISTORY_LIMIT } from '@wirebench/wire/runner-defaults';
import type { RunnerRunResult } from '@wirebench/wire/runner-wire';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-runner-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RunnerSettingsStore', () => {
  it('starts every target with the defaults and no data file', async () => {
    expect(await new RunnerSettingsStore(root).get('api-1')).toEqual({ settings: defaultRunnerSettings() });
  });

  it('keeps each target’s settings and data file apart, across instances', async () => {
    const store = new RunnerSettingsStore(root);
    const settings = { ...defaultRunnerSettings(), iterations: 3, order: ['b', 'a'], excluded: ['c'] };
    await store.setSettings('api-1', settings);
    await store.setDataPath('api-1', '/data/rows.csv');
    await store.setSettings('folder-2', { ...defaultRunnerSettings(), bail: true });
    const again = new RunnerSettingsStore(root);
    expect(await again.get('api-1')).toEqual({ settings, dataPath: '/data/rows.csv' });
    expect((await again.get('folder-2')).settings.bail).toBe(true);
  });

  it('forgets a data file, keeping the settings', async () => {
    const store = new RunnerSettingsStore(root);
    await store.setSettings('api-1', { ...defaultRunnerSettings(), delayMs: 50 });
    await store.setDataPath('api-1', '/data/rows.csv');
    await store.setDataPath('api-1', undefined);
    expect(await store.get('api-1')).toEqual({ settings: { ...defaultRunnerSettings(), delayMs: 50 } });
  });

  it('reads a corrupt file as empty', async () => {
    await writeFile(join(root, 'runner-settings.json'), '{not json');
    expect(await new RunnerSettingsStore(root).get('api-1')).toEqual({ settings: defaultRunnerSettings() });
  });

  it('writes concurrent changes one after another', async () => {
    const store = new RunnerSettingsStore(root);
    await Promise.all(
      ['a', 'b', 'c'].map((id, i) => store.setSettings(id, { ...defaultRunnerSettings(), delayMs: i })),
    );
    expect((await store.get('c')).settings.delayMs).toBe(2);
    expect((await store.get('a')).settings.delayMs).toBe(0);
  });
});

function run(runId: string, targetId = 'api-1'): RunnerRunResult {
  return {
    runId,
    targetId,
    name: 'Api',
    startedAt: `2026-10-11T10:00:00.000Z`,
    cancelled: false,
    summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 5 },
    requests: [],
  };
}

describe('RunnerHistoryStore', () => {
  it('lists a target’s runs newest first, and reads one back whole', async () => {
    const store = new RunnerHistoryStore(root);
    await store.add(run('r1'));
    await store.add(run('r2'));
    await store.add(run('other', 'folder-9'));
    expect((await store.list('api-1')).map((entry) => entry.runId)).toEqual(['r2', 'r1']);
    expect(await store.get('api-1', 'r1')).toEqual(run('r1'));
    expect(await store.get('api-1', 'nope')).toBeUndefined();
    expect(await store.list('folder-9')).toHaveLength(1);
  });

  it('keeps the last runs only', async () => {
    const store = new RunnerHistoryStore(root);
    for (let i = 0; i <= RUNNER_HISTORY_LIMIT; i++) await store.add(run(`r${i}`));
    const runs = await store.list('api-1');
    expect(runs).toHaveLength(RUNNER_HISTORY_LIMIT);
    expect(runs[0]!.runId).toBe(`r${RUNNER_HISTORY_LIMIT}`);
    expect(runs.some((entry) => entry.runId === 'r0')).toBe(false);
  });

  it('keeps every file under its own folder, named so an id cannot reach outside it', async () => {
    const store = new RunnerHistoryStore(root);
    await store.add(run('r1', '../../escape'));
    expect(await readdir(root)).toEqual(['runner-history']);
    expect((await readdir(join(root, 'runner-history')))[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it('reads a corrupt file as no runs', async () => {
    const store = new RunnerHistoryStore(root);
    await store.add(run('r1'));
    const [file] = await readdir(join(root, 'runner-history'));
    await mkdir(join(root, 'runner-history'), { recursive: true });
    await writeFile(join(root, 'runner-history', file!), '[]');
    expect(await store.list('api-1')).toEqual([]);
  });
});
