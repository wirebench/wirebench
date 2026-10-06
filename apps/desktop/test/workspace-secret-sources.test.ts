// @vitest-environment node
/**
 * The workspace side of secret sources (secret sources spec D4, D6; amendments A7): per-entry writes to the
 * shared map in `workspace.yaml` and to this machine's overrides in `local.yaml`, the approval, and the state
 * the Secret Sources dialog shows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadLocalState,
  loadWorkspace,
  nodeFs,
  parseSecretSources,
  saveWorkspace,
  workspaceDir,
} from '@wirebench/engine';
import type { FsLike } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { SecretSourcesService } from '../src/main/secret-sources-service.js';
import { secretSourcesStateOf } from '../src/main/secret-sources-state.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import type { WorkspaceWire } from '../src/shared/wire-types.js';

/** Copied from workspace-watch.test.ts: a short debounce over the real `fs.watch`. */
const WATCH_DEBOUNCE_MS = 30;
const WAIT_OPTIONS = { timeout: 10_000, interval: 20 };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

const VAULT = { kind: 'vault', path: 'kv/app', field: 'password' };

let root: string;
const services: WorkspaceService[] = [];

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): {
  service: WorkspaceService;
  changed: (WorkspaceWire | null)[];
} {
  const changed: (WorkspaceWire | null)[] = [];
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: WATCH_DEBOUNCE_MS,
    hooks: { onChanged: (workspace) => changed.push(workspace) },
    ...overrides,
  });
  services.push(service);
  return { service, changed };
}

/** A fresh local workspace, open. Its tree is its app-data dir, so `workspace.yaml` and `local.yaml` sit side by side. */
async function openFixtureWorkspace(overrides: Partial<WorkspaceServiceDeps> = {}): Promise<{
  service: WorkspaceService;
  changed: (WorkspaceWire | null)[];
  dir: string;
}> {
  const bootstrap = newService();
  const created = await bootstrap.service.create('Sources');
  await bootstrap.service.close();
  const opened = newService(overrides);
  await opened.service.open(created.id);
  return { ...opened, dir: workspaceDir(root, created.id) };
}

/** A workspace whose files are seeded by hand before it is opened. */
async function openSeeded(
  seed: (dir: string) => Promise<void>,
  overrides: Partial<WorkspaceServiceDeps> = {},
): Promise<{ service: WorkspaceService; changed: (WorkspaceWire | null)[]; dir: string }> {
  const bootstrap = newService();
  const created = await bootstrap.service.create('Sources');
  await bootstrap.service.close();
  const dir = workspaceDir(root, created.id);
  await seed(dir);
  const opened = newService(overrides);
  await opened.service.open(created.id);
  return { ...opened, dir };
}

const manifest = (dir: string): Promise<string> => readFile(join(dir, 'workspace.yaml'), 'utf8');
const localFile = (dir: string): Promise<string> => readFile(join(dir, 'local.yaml'), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-secret-sources-'));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('secretSourcesState', () => {
  it('reports nothing open, trusted, when no workspace is open', () => {
    const { service } = newService();
    expect(service.secretSourcesState()).toEqual({ open: false, entries: [], trusted: true, changes: [] });
  });

  it('keeps secretSources when a format-3 workspace is loaded', async () => {
    const { service } = await openSeeded(async (dir) => {
      const text = (await manifest(dir)).replace(/^formatVersion: \d+$/m, 'formatVersion: 3');
      expect(text).toContain('formatVersion: 3\n');
      await writeFile(
        join(dir, 'workspace.yaml'),
        `${text}secretSources:\n  db:\n    kind: vault\n    path: kv/app\n    field: password\n`,
      );
    });
    expect(service.secretSourcesState().entries).toEqual([
      { name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: false },
    ]);
  });
});

describe('setSharedSecretSources', () => {
  it('writes the entry to workspace.yaml and refuses an invalid one without writing', async () => {
    const { service, dir } = await openFixtureWorkspace();
    expect(await service.setSharedSecretSources({ name: 'db', entry: VAULT })).toEqual({ ok: true, issues: [] });
    expect(await manifest(dir)).toContain('secretSources:');
    const before = await manifest(dir);
    const bad = await service.setSharedSecretSources({ name: 'db', entry: { kind: 'vault', path: '-x', field: 'f' } });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ name: 'db', field: 'path' });
    expect(await manifest(dir)).toBe(before);
    expect(service.secretSourcesState().entries[0]?.fields['path']).toBe('kv/app');
  });

  it('refuses a name that is not a secret name', async () => {
    const { service } = await openFixtureWorkspace();
    const result = await service.setSharedSecretSources({ name: '1db', entry: VAULT });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ name: '1db' });
    expect(service.secretSourcesState().entries).toEqual([]);
  });

  it('touches one entry: the others, an invalid raw one included, are written back untouched', async () => {
    const { service, dir } = await openSeeded(async (dir) => {
      await writeFile(
        join(dir, 'workspace.yaml'),
        `${await manifest(dir)}secretSources:\n  bad:\n    kind: vault\n    path: -x\n    field: f\n    note: 7\n  db:\n    kind: vault\n    path: kv/app\n    field: password\n`,
      );
    });
    const bad = service.secretSourcesState().entries.find((entry) => entry.name === 'bad');
    expect(bad).toMatchObject({ kind: 'invalid', fields: { path: '-x', field: 'f' } });
    expect(bad?.reason).toMatch(/path/);
    expect(
      await service.setSharedSecretSources({ name: 'api', entry: { kind: '1password', ref: 'op://a/b/c' } }),
    ).toEqual({ ok: true, issues: [] });
    const { workspace } = await loadWorkspace(dir);
    expect(workspace.secretSources?.['bad']).toMatchObject({
      kind: 'invalid',
      raw: { kind: 'vault', path: '-x', field: 'f', note: 7 },
    });
    expect(workspace.secretSources?.['db']).toEqual(VAULT);
    expect(workspace.secretSources?.['api']).toEqual({ kind: '1password', ref: 'op://a/b/c' });
  });

  it('renames with previousName and removes with a null entry', async () => {
    const { service } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    await service.setSharedSecretSources({ name: 'pw', previousName: 'db', entry: VAULT });
    expect(service.secretSourcesState().entries.map((entry) => entry.name)).toEqual(['pw']);
    await service.setSharedSecretSources({ name: 'pw', entry: null });
    expect(service.secretSourcesState().entries).toEqual([]);
  });

  it('refuses a rename onto a name that is already mapped, and a rename with a null entry, writing nothing', async () => {
    const { service, dir } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    await service.setSharedSecretSources({ name: 'api', entry: { kind: '1password', ref: 'op://a/b/c' } });
    const before = await manifest(dir);
    const collision = await service.setSharedSecretSources({ name: 'api', previousName: 'db', entry: VAULT });
    expect(collision).toMatchObject({ ok: false, issues: [{ name: 'api' }] });
    const removal = await service.setSharedSecretSources({ name: 'api', previousName: 'db', entry: null });
    expect(removal).toMatchObject({ ok: false, issues: [{ name: 'api' }] });
    expect(await manifest(dir)).toBe(before);
    expect(service.secretSourcesState().entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['db', 'vault'],
      ['api', '1password'],
    ]);
  });

  it('refuses a create onto a name that is already mapped, an invalid raw entry included, writing nothing', async () => {
    const { service, dir } = await openSeeded(async (dir) => {
      await writeFile(
        join(dir, 'workspace.yaml'),
        `${await manifest(dir)}secretSources:\n  bad:\n    kind: vault\n    path: -x\n    field: f\n  db:\n    kind: vault\n    path: kv/app\n    field: password\n`,
      );
    });
    const before = await manifest(dir);
    for (const name of ['db', 'bad']) {
      const refused = await service.setSharedSecretSources({ name, entry: VAULT, create: true });
      expect(refused).toMatchObject({ ok: false, issues: [{ name }] });
    }
    expect(await manifest(dir)).toBe(before);
    expect(await service.setSharedSecretSources({ name: 'fresh', entry: VAULT, create: true })).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('reports a non-mapping secretSources as a problem and replaces it when an entry is written', async () => {
    const { service, dir } = await openSeeded(async (dir) => {
      await writeFile(join(dir, 'workspace.yaml'), `${await manifest(dir)}secretSources: oops\n`);
    });
    expect(service.secretSourcesState().problem).toMatch(/workspace\.yaml/);
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    expect(service.secretSourcesState().problem).toBeUndefined();
    expect(await manifest(dir)).not.toContain('oops');
    expect((await loadWorkspace(dir)).workspace.secretSources?.['db']).toEqual(VAULT);
  });

  it('throws when no workspace is open', async () => {
    const { service } = newService();
    await expect(service.setSharedSecretSources({ name: 'db', entry: VAULT })).rejects.toMatchObject({
      code: 'workspace-not-found',
    });
  });
});

describe('approveSecretSources', () => {
  it('needs approval after a shared change and approves only the current hash', async () => {
    const { service } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    const state = service.secretSourcesState();
    expect(state.trusted).toBe(false);
    expect(state.changes).toEqual([{ name: 'db', change: 'added' }]);
    await expect(service.approveSecretSources('0'.repeat(64))).rejects.toMatchObject({
      code: 'secret-source-approval-stale',
    });
    const approved = await service.approveSecretSources(state.hash as string);
    expect(approved).toMatchObject({ trusted: true, changes: [] });
    await service.setSharedSecretSources({ name: 'db', entry: { ...VAULT, path: 'kv/other' } });
    expect(service.secretSourcesState()).toMatchObject({
      trusted: false,
      changes: [{ name: 'db', change: 'changed' }],
    });
    await service.setSharedSecretSources({ name: 'db', entry: null });
    expect(service.secretSourcesState()).toMatchObject({ trusted: true, changes: [{ name: 'db', change: 'removed' }] });
  });

  it('keeps the approval in local.yaml across a reopen', async () => {
    const { service, dir } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    const { hash } = service.secretSourcesState();
    await service.approveSecretSources(hash as string);
    expect((await loadLocalState(dir)).secretSourcesApproved?.hash).toBe(hash);
    const id = service.snapshot()?.id as string;
    await service.close();
    const again = newService().service;
    await again.open(id);
    expect(again.secretSourcesState()).toMatchObject({ trusted: true, changes: [] });
  });

  it('compares an approved invalid entry that holds a non-finite number without throwing', async () => {
    const { service } = await openSeeded(async (dir) => {
      await writeFile(
        join(dir, 'workspace.yaml'),
        `${await manifest(dir)}secretSources:\n  bad:\n    kind: vault\n    path: .inf\n    field: f\n`,
      );
    });
    const { hash } = service.secretSourcesState();
    expect(hash).toBeDefined();
    expect(await service.approveSecretSources(hash as string)).toMatchObject({ trusted: true, changes: [] });
  });

  it('tells a non-finite number from the same text when comparing with the approval', () => {
    const now = parseSecretSources({ bad: { kind: 'vault', path: 'Infinity', field: 'f', n: 1 } }).sources;
    const state = secretSourcesStateOf({
      shared: now,
      sharedRaw: undefined,
      local: undefined,
      localRaw: undefined,
      approved: { hash: '0'.repeat(64), mapping: { bad: { kind: 'vault', path: Infinity, field: 'f', n: 1 } } },
    });
    expect(state.changes).toEqual([{ name: 'bad', change: 'changed' }]);
  });

  it('goes untrusted when workspace.yaml is changed outside the app', async () => {
    // Seeded before opening: the app's own write of workspace.yaml would hide an outside edit for a while.
    const { service, dir } = await openSeeded(async (dir) => {
      const { workspace } = await loadWorkspace(dir);
      await saveWorkspace({ ...workspace, secretSources: parseSecretSources({ db: VAULT }).sources }, dir);
    });
    await service.approveSecretSources(service.secretSourcesState().hash as string);
    await settle();
    const { workspace } = await loadWorkspace(dir);
    const { sources } = parseSecretSources({ db: { ...VAULT, path: 'kv/changed' } });
    await saveWorkspace({ ...workspace, secretSources: sources }, dir);
    await vi.waitFor(() => {
      expect(service.secretSourcesState()).toMatchObject({
        trusted: false,
        changes: [{ name: 'db', change: 'changed' }],
      });
    }, WAIT_OPTIONS);
  });
});

describe('setLocalSecretSources', () => {
  it('keeps local overrides in local.yaml, never in workspace.yaml', async () => {
    const { service, dir } = await openFixtureWorkspace();
    await service.setLocalSecretSources({ name: 'db', entry: { kind: '1password', ref: 'op://a/b/c' } });
    expect(await manifest(dir)).not.toContain('op://');
    expect(await localFile(dir)).toContain('op://a/b/c');
    expect(service.secretSourcesState().entries).toContainEqual(
      expect.objectContaining({ name: 'db', origin: 'local', kind: '1password' }),
    );
  });

  it('marks a shared entry a local one replaces or unmaps as overridden', async () => {
    const { service } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none' } });
    expect(service.secretSourcesState().entries).toEqual([
      { name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: true },
      { name: 'db', origin: 'local', kind: 'none', fields: {}, overridden: false },
    ]);
  });

  it('refuses a local rename onto a name that is already mapped, and a rename with a null entry, writing nothing', async () => {
    const { service, dir } = await openFixtureWorkspace();
    await service.setLocalSecretSources({ name: 'db', entry: VAULT });
    await service.setLocalSecretSources({ name: 'api', entry: { kind: 'none' } });
    const before = await localFile(dir);
    const collision = await service.setLocalSecretSources({ name: 'api', previousName: 'db', entry: VAULT });
    expect(collision).toMatchObject({ ok: false, issues: [{ name: 'api' }] });
    const removal = await service.setLocalSecretSources({ name: 'api', previousName: 'db', entry: null });
    expect(removal).toMatchObject({ ok: false, issues: [{ name: 'api' }] });
    expect(await localFile(dir)).toBe(before);
    expect(service.secretSourcesState().entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['db', 'vault'],
      ['api', 'none'],
    ]);
  });

  it('refuses a local create onto a mapped name, writing nothing, and allows one that only the shared map has', async () => {
    const { service, dir } = await openFixtureWorkspace();
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    await service.setLocalSecretSources({ name: 'pw', entry: { kind: 'none' } });
    const before = await localFile(dir);
    expect(await service.setLocalSecretSources({ name: 'pw', entry: VAULT, create: true })).toMatchObject({
      ok: false,
      issues: [{ name: 'pw' }],
    });
    expect(await localFile(dir)).toBe(before);
    expect(await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none' }, create: true })).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('keeps the active environment when local secret sources are written', async () => {
    const { service, dir } = await openFixtureWorkspace();
    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    await service.setActiveEnvironment(createdEnvironmentId as string);
    await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none' } });
    const local = await localFile(dir);
    expect(local).toContain('activeEnvironmentId');
    expect(local).toContain('kind: none');
  });

  it('refuses an invalid override without writing', async () => {
    const { service, dir } = await openFixtureWorkspace();
    const result = await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none', path: 'x' } });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ name: 'db' });
    await expect(localFile(dir)).rejects.toThrow();
  });

  it('reports a non-mapping local secretSources as a problem and replaces it when an override is written', async () => {
    const { service, dir } = await openSeeded(async (dir) => {
      await writeFile(join(dir, 'local.yaml'), 'version: 2\nsecretSources: [1, 2]\n');
    });
    expect(service.secretSourcesState().problem).toMatch(/local\.yaml/);
    await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none' } });
    expect(service.secretSourcesState().problem).toBeUndefined();
    expect((await loadLocalState(dir)).secretSources).toEqual({ db: { kind: 'none' } });
  });
});

describe('queueing and the change hook', () => {
  it('queues a local write behind setActiveEnvironment, so the slower write cannot land stale', async () => {
    // The first local.yaml write after `armed` waits on the gate: without the queue, setLocal's own write would
    // land first and the held one, built before it, would overwrite it.
    let armed = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const fs: FsLike = {
      ...nodeFs,
      rename: async (from, to) => {
        if (armed && to.endsWith('local.yaml')) {
          armed = false;
          await gate;
        }
        await nodeFs.rename(from, to);
      },
    };
    const { service, dir } = await openFixtureWorkspace({ fs });
    const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
    armed = true;
    const activating = service.setActiveEnvironment(createdEnvironmentId as string);
    const writing = service.setLocalSecretSources({ name: 'api', entry: { kind: '1password', ref: 'op://a/b/c' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.secretSourcesState().entries).toEqual([]);
    open();
    await Promise.all([activating, writing]);
    const local = await loadLocalState(dir);
    expect(local.activeEnvironmentId).toBe(createdEnvironmentId);
    expect(Object.keys(local.secretSources ?? {})).toEqual(['api']);
  });

  it('fires onChanged for every write: shared, local and approval', async () => {
    const { service, changed } = await openFixtureWorkspace();
    const start = changed.length;
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    expect(changed.length).toBe(start + 1);
    await service.setLocalSecretSources({ name: 'db', entry: { kind: 'none' } });
    expect(changed.length).toBe(start + 2);
    await service.approveSecretSources(service.secretSourcesState().hash as string);
    expect(changed.length).toBe(start + 3);
  });

  it('a local override change and an approval each make the source cache refetch', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: 'pw', stderr: '', exitCode: 0 }));
    const holder: { service?: WorkspaceService } = {};
    const sources = new SecretSourcesService({
      snapshot: () => holder.service?.secretSourcesSnapshot(),
      cacheSeconds: () => 300,
      onValue: () => undefined,
      mask: (text) => text,
      platform: 'linux',
      env: {},
      find: (tool) => Promise.resolve(`/bin/${tool}`),
      run,
    });
    const noteChange = vi.spyOn(sources, 'noteChange');
    const { service } = await openFixtureWorkspace({ hooks: { onChanged: () => sources.noteChange() } });
    holder.service = service;
    const get = sources.wrap(() => Promise.resolve(undefined));

    // An approved shared source, cached.
    await service.setSharedSecretSources({ name: 'db', entry: VAULT });
    await service.approveSecretSources(service.secretSourcesState().hash as string);
    await get('secret:db');
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(1);

    // A local override to the very same source: only the override changed, and nothing watches local.yaml.
    await service.setLocalSecretSources({ name: 'db', entry: VAULT });
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);

    // A new shared name is untrusted until approved; the approval reaches the source cache through the hook.
    await service.setSharedSecretSources({ name: 'api', entry: { ...VAULT, path: 'kv/api' } });
    await expect(get('secret:api')).rejects.toMatchObject({ code: 'secret-source-untrusted' });
    const calls = noteChange.mock.calls.length;
    await service.approveSecretSources(service.secretSourcesState().hash as string);
    expect(noteChange.mock.calls.length).toBe(calls + 1);
    expect(await get('secret:api')).toBe('pw');
    expect(run).toHaveBeenCalledTimes(3);
  });
});
