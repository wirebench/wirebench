// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  createWorkspace,
  createWorkspaceEnvironment,
  saveProject,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { Workspace } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import type { WorkspaceWire } from '../src/shared/wire-types.js';

/**
 * `fs.watch`'s coalescing on real disks is not instant; a short debounce keeps every test here
 * comfortably under a few seconds while still exercising the real watcher (no fake timers — this
 * is a real `fs.watch` against a real temp directory).
 */
const WATCH_DEBOUNCE_MS = 30;
const WAIT_OPTIONS = { timeout: 10_000, interval: 20 };
/**
 * `fs.watch`'s underlying FSEvents stream on macOS goes live a moment after `watch()` returns,
 * and can otherwise report a write from just before that moment once it does. Every write made
 * during `open()` itself (the manifest re-save, `saveProject`'s own bookkeeping) predates the
 * watcher; this settle window lets any such stray event arrive and be consumed before a test
 * starts counting `onChanged` calls, mirroring `project-watch.test.ts`'s `SETTLE_MS`.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

let root: string;

interface Recorded {
  changed: (WorkspaceWire | null)[];
  onDisk: { paths: readonly string[]; message: string }[];
}

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): { service: WorkspaceService; recorded: Recorded } {
  const recorded: Recorded = { changed: [], onDisk: [] };
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: WATCH_DEBOUNCE_MS,
    hooks: {
      onChanged: (workspace) => recorded.changed.push(workspace),
      onWorkspaceChangedOnDisk: (paths, message) => recorded.onDisk.push({ paths: [...paths], message }),
    },
    ...overrides,
  });
  return { service, recorded };
}

/** Seeds a bare workspace folder (no service involved) with one internal project. */
async function seedWorkspace(name: string): Promise<{ workspace: Workspace; tree: string }> {
  const workspace = createWorkspace(name);
  const tree = workspaceDir(root, workspace.id);
  await mkdir(tree, { recursive: true });
  const project = createProject('Alpha');
  await saveProject(project, workspaceProjectDir(tree, 'alpha'));
  const seeded: Workspace = { ...workspace, projects: [{ id: project.id, slug: 'alpha', source: 'internal' }] };
  await saveWorkspace(seeded, tree);
  return { workspace: seeded, tree };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-workspace-watch-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceService — workspace-level watcher', () => {
  it('reloads environments after an outside edit to environments/*.yaml, firing onChanged once', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const withEnv: Workspace = {
      ...workspace,
      environments: [createWorkspaceEnvironment('Dev', new Set())],
    };
    await saveWorkspace(withEnv, tree);

    const { service, recorded } = newService();
    await service.open(workspace.id);
    await settle();
    const before = recorded.changed.length;

    // An edit made outside the app: a teammate's `git pull`, a text editor, a sync client —
    // never through the service, so there is no `expect()` suppressing it.
    const renamed: Workspace = {
      ...withEnv,
      environments: [
        { ...(withEnv.environments[0] ?? createWorkspaceEnvironment('Dev', new Set())), name: 'Dev (edited)' },
      ],
    };
    await saveWorkspace(renamed, tree);

    await vi.waitFor(() => {
      const snapshot = service.snapshot();
      expect(snapshot?.environments.map((e) => e.name)).toEqual(['Dev (edited)']);
    }, WAIT_OPTIONS);

    // Exactly one more onChanged: the debounced batch coalesces into a single reload.
    expect(recorded.changed.length).toBe(before + 1);

    await service.close();
  });

  it('opens a host for a project ref appended on disk', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service } = newService();
    await service.open(workspace.id);
    await settle();
    expect(service.snapshot()?.projects.map((p) => p.slug)).toEqual(['alpha']);

    const second = createProject('Beta');
    await saveProject(second, workspaceProjectDir(tree, 'beta'));
    const withSecond: Workspace = {
      ...workspace,
      projects: [...workspace.projects, { id: second.id, slug: 'beta', source: 'internal' }],
    };
    await saveWorkspace(withSecond, tree);

    await vi.waitFor(() => {
      const betaRow = service.snapshot()?.projects.find((p) => p.slug === 'beta');
      // Checked in one read, not "contains beta" then a separate re-read: `reloadWorkspaceFromDisk`
      // awaits the new host all the way to `ready` (or `error`) before its one `onChanged`, but the
      // entry is pushed to `open.entries` — and so visible to `snapshot()` — the moment it starts
      // loading, before that await settles.
      expect(betaRow?.status).toBe('ready');
    }, WAIT_OPTIONS);

    await service.close();
  });

  it('closes the host of a project ref removed on disk', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service } = newService();
    await service.open(workspace.id);
    await settle();
    expect(service.snapshot()?.projects.map((p) => p.slug)).toEqual(['alpha']);

    const withoutAlpha: Workspace = { ...workspace, projects: [] };
    await saveWorkspace(withoutAlpha, tree);

    await vi.waitFor(() => {
      expect(service.snapshot()?.projects.map((p) => p.slug)).toEqual([]);
    }, WAIT_OPTIONS);

    await service.close();
  });

  it('reports unparsable YAML through onWorkspaceChangedOnDisk and keeps the in-memory model', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service, recorded } = newService();
    await service.open(workspace.id);
    await settle();
    const nameBefore = service.snapshot()?.name;

    await writeFile(join(tree, 'workspace.yaml'), ': not : yaml : at : all\n\t- broken', 'utf8');

    await vi.waitFor(() => {
      expect(recorded.onDisk.length).toBeGreaterThan(0);
    }, WAIT_OPTIONS);
    expect(recorded.onDisk[0]?.message).toBeTruthy();
    expect(recorded.onDisk[0]?.paths).toContain('workspace.yaml');
    // The model is left exactly as it was — no partial reload.
    expect(service.snapshot()?.name).toBe(nameBefore);

    await service.close();
  });

  it('does not reload when a project file under projects/** changes', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service, recorded } = newService();
    await service.open(workspace.id);
    await settle();
    const before = recorded.changed.length;

    // A file under a project's own folder — the workspace-level predicate must reject it even
    // though a recursive watch on the tree root also sees this event.
    await mkdir(join(tree, 'projects', 'alpha', 'environments'), { recursive: true });
    await writeFile(join(tree, 'projects', 'alpha', 'environments', 'Local.yaml'), 'name: Local\n', 'utf8');

    // No onChanged should follow; give the debounce window (and then some) a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 200));
    expect(recorded.changed.length).toBe(before);

    await service.close();
  });

  it('does not re-trigger a reload from the service’s own save (mutate)', async () => {
    const { workspace } = await seedWorkspace('Team');
    const { service, recorded } = newService();
    await service.open(workspace.id);
    await settle();
    const before = recorded.changed.length;

    await service.mutate({ kind: 'rename-workspace', name: 'Renamed by the app' });

    // `mutate` itself fires one onChanged synchronously; the assertion is that the watcher does
    // not add a *second* one once its debounce window has passed.
    await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 200));
    expect(recorded.changed.length).toBe(before + 1);

    await service.close();
  });

  it('stops the watcher on close(): no callbacks arrive afterwards', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service, recorded } = newService();
    await service.open(workspace.id);
    await settle();
    await service.close();
    const before = recorded.changed.length;
    const beforeOnDisk = recorded.onDisk.length;

    const withEnv: Workspace = { ...workspace, environments: [createWorkspaceEnvironment('Dev', new Set())] };
    await saveWorkspace(withEnv, tree);

    await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 200));
    expect(recorded.changed.length).toBe(before);
    expect(recorded.onDisk.length).toBe(beforeOnDisk);
  });
});
