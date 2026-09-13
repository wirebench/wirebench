// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@wirebench/engine';
import {
  createProject,
  createWorkspace,
  createWorkspaceEnvironment,
  loadWorkspace,
  nodeFs,
  saveProject,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { FsLike, Workspace } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { ProjectHost } from '../src/main/project-host.js';
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
  /** Files-changed-on-disk events forwarded from an open project's own watcher — used only by
   * the close()-races-a-reload test, to detect a host that a reload opened but never closed. */
  projectOnDisk: { projectId: string; paths: readonly string[] }[];
}

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): { service: WorkspaceService; recorded: Recorded } {
  const recorded: Recorded = { changed: [], onDisk: [], projectOnDisk: [] };
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: WATCH_DEBOUNCE_MS,
    hooks: {
      onChanged: (workspace) => recorded.changed.push(workspace),
      onWorkspaceChangedOnDisk: (paths, message) => recorded.onDisk.push({ paths: [...paths], message }),
      onProjectChangedOnDisk: (projectId, paths) => recorded.projectOnDisk.push({ projectId, paths: [...paths] }),
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

  it('reopens a project at its new folder when its ref is renamed on disk, keeping its unsaved edit', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service } = newService();
    await service.open(workspace.id);
    await settle();

    const alphaId = workspace.projects[0]!.id;
    await service.projectMutate(alphaId, { kind: 'rename-project', name: 'Edited while open' });
    expect(service.projectSnapshot(alphaId)?.dirty).toBe(true);

    // The unsaved record has to be on disk (not just in memory) before the relocation, since it
    // is what `openEntry` restores from when the reload re-adds this project id at its new dir.
    const unsavedRecordPath = join(root, 'workspaces', workspace.id, 'unsaved', `${alphaId}.json`);
    await expect.poll(() => existsSync(unsavedRecordPath), { timeout: 5_000, interval: 50 }).toBe(true);

    // A teammate's rename, pulled via `git`: the project folder moves and the manifest ref's
    // slug changes to match it — never through the service, so nothing here calls `expect()`.
    await rename(join(tree, 'projects', 'alpha'), join(tree, 'projects', 'alpha-renamed'));
    const renamed: Workspace = {
      ...workspace,
      projects: workspace.projects.map((ref) => (ref.id === alphaId ? { ...ref, slug: 'alpha-renamed' } : ref)),
    };
    await saveWorkspace(renamed, tree);

    await vi.waitFor(() => {
      const row = service.snapshot()?.projects.find((p) => p.id === alphaId);
      expect(row?.slug).toBe('alpha-renamed');
      expect(row?.status).toBe('ready');
    }, WAIT_OPTIONS);

    // The edit made before the rename survived the release-and-reopen: still dirty, still the
    // edited name — not silently discarded the way a `removeProject`-style release would.
    expect(service.projectSnapshot(alphaId)).toMatchObject({ name: 'Edited while open', dirty: true });

    await service.close();
  }, 20_000);

  it('serialises a watcher-driven reload behind an in-flight removeProject, leaving entries and the manifest consistent', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const second = createProject('Beta');
    await saveProject(second, workspaceProjectDir(tree, 'beta'));
    const seeded: Workspace = {
      ...workspace,
      projects: [...workspace.projects, { id: second.id, slug: 'beta', source: 'internal' }],
    };
    await saveWorkspace(seeded, tree);

    // `removeProject`'s own sequence saves the manifest *before* trashing the folder; gating the
    // trash call is what lets a reload's watcher event land while `removeProject`'s operation is
    // still in flight (queued behind it, per `enqueueWorkspaceOp`), without needing real timing
    // luck to hit that window.
    let releaseTrash: (() => void) | undefined;
    const trashGate = new Promise<void>((resolve) => {
      releaseTrash = resolve;
    });
    const { service } = newService({
      trash: async () => {
        await trashGate;
      },
    });
    await service.open(workspace.id);
    await settle();

    const alphaId = seeded.projects[0]!.id;
    const removePromise = service.removeProject(alphaId, { deleteFiles: true });

    // Give `removeProject` time to reach (and block on) the gated trash call — its manifest save
    // has already landed on disk by then, per its own sequence.
    await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));

    // An outside edit that only touches `environments/` — built from what is *currently* on
    // disk, the way a text editor opened after the removal already landed would see it, so this
    // does not itself race the removal.
    const { workspace: onDiskDuringRemoval } = await loadWorkspace(tree);
    const withEnv: Workspace = {
      ...onDiskDuringRemoval,
      environments: [createWorkspaceEnvironment('Dev', new Set())],
    };
    await saveWorkspace(withEnv, tree);

    releaseTrash?.();
    await removePromise;

    await vi.waitFor(() => {
      expect(service.snapshot()?.environments.map((e) => e.name)).toEqual(['Dev']);
    }, WAIT_OPTIONS);

    const finalSlugs = service.snapshot()?.projects.map((p) => p.slug) ?? [];
    expect(finalSlugs).toEqual(['beta']);
    expect(new Set(finalSlugs).size).toBe(finalSlugs.length);

    // The manifest on disk agrees with the in-memory model: the queued reload never saw (and
    // never wrote through) a half-updated `entries` array.
    const { workspace: onDiskFinal } = await loadWorkspace(tree);
    expect(onDiskFinal.projects.map((ref) => ref.slug)).toEqual(['beta']);

    await service.close();
  }, 20_000);

  it('closes a host a reload was still opening when close() ran concurrently', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const gamma = createProject('Gamma');
    const gammaDir = workspaceProjectDir(tree, 'gamma');
    await saveProject(gamma, gammaDir);
    const gammaManifestPath = join(gammaDir, 'wirebench.yaml');

    // Gates `ProjectHost.openProject` for gamma's folder specifically, so the reload can be
    // caught reliably mid-way through opening gamma's host — not left to real disk-I/O timing.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to be re-applied with `this` preserved below, never called unbound.
    const original = ProjectHost.prototype.openProject;
    const spy = vi.spyOn(ProjectHost.prototype, 'openProject').mockImplementation(async function (
      this: ProjectHost,
      ...args: Parameters<typeof original>
    ) {
      if (args[0] === gammaDir) {
        await gate;
      }
      return original.apply(this, args);
    });

    try {
      const { service, recorded } = newService();
      await service.open(workspace.id);
      await settle();

      // An outside edit appends gamma's ref; the watcher's reload will try to open its host and
      // block inside the gate above.
      const withGamma: Workspace = {
        ...workspace,
        projects: [...workspace.projects, { id: gamma.id, slug: 'gamma', source: 'internal' }],
      };
      await saveWorkspace(withGamma, tree);

      // Give the reload time to notice the change and reach (and block inside) the gate — well
      // past the watcher's own debounce window.
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));

      // `close()` is deliberately not queued behind the reload (see `enqueueWorkspaceOp`), so it
      // runs concurrently with the still-blocked reload — exactly the race this test exists for.
      const closePromise = service.close();
      releaseGate?.();
      await closePromise;

      // The host the reload was mid-way through opening must have been closed, not left running
      // — proven by writing to gamma's folder now and confirming no `onProjectChangedOnDisk`
      // follows: a host whose watcher was never stopped would still report this.
      const before = recorded.projectOnDisk.length;
      await writeFile(gammaManifestPath, await readFile(gammaManifestPath, 'utf8'), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));
      expect(recorded.projectOnDisk.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  }, 20_000);

  it('serialises mutate and setActiveEnvironment behind an in-flight reload, so neither loses the other', async () => {
    const { workspace, tree } = await seedWorkspace('Team');

    // Wraps `loadWorkspace` (used only by the watcher's reload, `open()`, `list()` and rename's
    // "not open" branch — never by `mutate`/`setActiveEnvironment`, which only ever call
    // `saveWorkspace`/`saveLocalState`) so the reload's read can be captured immediately (getting
    // whatever is on disk *right now*, exactly like the real race) while its *resolution* is held
    // back until the test releases it — simulating "the reload is still in flight" without
    // touching any of the writes this test goes on to make.
    let armed = false;
    // Set once the gated `loadWorkspace` call is actually reached *while armed* — the proof that
    // this run genuinely exercised the race (a reload in flight, blocked mid-read) rather than
    // passing because the watcher happened not to have fired yet within the wait below.
    let observedWhileArmed = false;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const originalLoadWorkspace = engine.loadWorkspace;
    const spy = vi
      .spyOn(engine, 'loadWorkspace')
      .mockImplementation(async (...args: Parameters<typeof engine.loadWorkspace>) => {
        const result = await originalLoadWorkspace(...args);
        if (armed) {
          observedWhileArmed = true;
          await gate;
        }
        return result;
      });

    try {
      const { service } = newService();
      await service.open(workspace.id);
      await settle();

      armed = true;
      // An outside edit — unrelated to environments — starts a reload; its `loadWorkspace` read
      // captures this content right away but will not resolve until `releaseGate()` below.
      await saveWorkspace({ ...workspace, name: 'Touched externally' }, tree);
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));
      // The whole point of the wait above is to let the reload reach the gate; if it hasn't, the
      // rest of this test would pass without exercising the race at all.
      expect(observedWhileArmed).toBe(true);

      const chained = service.mutate({ kind: 'add-workspace-environment', name: 'Dev' }).then((added) => {
        const createdId = added.createdEnvironmentId;
        if (createdId === undefined) {
          throw new Error('expected mutate to report createdEnvironmentId');
        }
        return service.setActiveEnvironment(createdId).then(() => createdId);
      });

      // Gives the unfixed code every chance to run `mutate` and `setActiveEnvironment` to
      // completion *while the reload is still gated* — exactly the interleaving window the
      // defect exploited. Under the fix neither has even started yet: both are queued behind
      // the still-running reload.
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseGate?.();
      const createdId = await chained;

      // Let the now-unblocked reload run to completion before checking the final state — this is
      // where the defect showed up: a reload finishing *after* `mutate`/`setActiveEnvironment`
      // already returned would silently overwrite their result with what it read before they ran.
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));

      const finalSnapshot = service.snapshot();
      expect(finalSnapshot?.environments.map((environment) => environment.id)).toContain(createdId);
      expect(finalSnapshot?.activeEnvironmentId).toBe(createdId);

      const { workspace: onDisk } = await loadWorkspace(tree);
      expect(onDisk.environments.map((environment) => environment.id)).toContain(createdId);

      await service.close();
    } finally {
      spy.mockRestore();
    }
  }, 20_000);

  it('pre-announcing before the write keeps mutate’s own atomic rename from looking like an outside edit', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const workspaceYamlPath = join(tree, 'workspace.yaml');

    // `saveWorkspace` writes `workspace.yaml` via `writeFileAtomic`: a temp file, then
    // `fs.rename(temp, path)`. This wrapper performs that rename immediately — so the *real*
    // `fs.watch` sees it (and, absent pre-announcement, would queue it) right away, on real OS
    // timing — but holds the *promise* pending a while longer, simulating "the write hasn't
    // returned control to `mutate` yet". That reproduces the exact race deterministically:
    // without this gate, whether the event arrives before or after `mutate`'s own post-write
    // `expect()` call is down to FSEvents/inotify latency, which almost always loses the race in
    // this test's favour and lets the bug pass unnoticed.
    const gatedFs: FsLike = {
      ...nodeFs,
      rename: async (from: string, to: string) => {
        await nodeFs.rename(from, to);
        if (to === workspaceYamlPath) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      },
    };

    const { service, recorded } = newService({ fs: gatedFs });
    await service.open(workspace.id);
    await settle();
    const before = recorded.changed.length;

    await service.mutate({ kind: 'add-workspace-environment', name: 'Dev' });

    // Long enough for the (already real, already on-disk) rename's `fs.watch` event to arrive and
    // for the watcher's debounce window to run its course either way — suppressed by the pre-write
    // `expect()`, or (without it) delivered and turned into a second, spurious reload.
    await new Promise((resolve) => setTimeout(resolve, 300 + WATCH_DEBOUNCE_MS + 300));
    expect(recorded.changed.length).toBe(before + 1);

    await service.close();
  });

  it('a mutate queued behind a reload stuck on the workspace it targeted rejects rather than landing on whatever opens next', async () => {
    const { workspace: workspaceA, tree: treeA } = await seedWorkspace('A');
    const { workspace: workspaceB, tree: treeB } = await seedWorkspace('B');

    let armed = false;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const originalLoadWorkspace = engine.loadWorkspace;
    const spy = vi
      .spyOn(engine, 'loadWorkspace')
      .mockImplementation(async (...args: Parameters<typeof engine.loadWorkspace>) => {
        const result = await originalLoadWorkspace(...args);
        if (armed) {
          await gate;
        }
        return result;
      });

    try {
      const { service } = newService();
      await service.open(workspaceA.id);
      await settle();

      armed = true;
      // An outside edit to A starts a reload that will not resolve until `releaseGate()` below.
      await saveWorkspace({ ...workspaceA, name: 'Touched externally' }, treeA);
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 300));

      // Called for A — `mutate` captures A's `open` right here, before it is even enqueued.
      const mutatePromise = service.mutate({ kind: 'add-workspace-environment', name: 'Dev' });

      // Give the queued `mutate` a moment, then switch the open workspace to B while A's reload
      // (and `mutate`, queued behind it) are still stuck on the gate.
      await new Promise((resolve) => setTimeout(resolve, 50));
      armed = false; // B's own `open()` must not be gated too.
      await service.open(workspaceB.id);

      releaseGate?.();
      await expect(mutatePromise).rejects.toThrow(/no workspace is open/i);

      // B — the workspace actually open now — must be untouched by A's queued `mutate`.
      expect(service.snapshot()?.id).toBe(workspaceB.id);
      expect(service.snapshot()?.environments).toEqual([]);
      const { workspace: bOnDisk } = await loadWorkspace(treeB);
      expect(bOnDisk.environments).toEqual([]);

      await service.close();
    } finally {
      spy.mockRestore();
    }
  }, 20_000);

  it('a mutate called while close() has already set `closing` performs no write', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const { service } = newService();
    await service.open(workspace.id);
    await settle();

    const closePromise = service.close();
    // `close()` sets `open.closing = true` as its very first statement, before its own first
    // `await` — so by this point (no `await` of our own has run yet) it is already set.
    const mutatePromise = service.mutate({ kind: 'add-workspace-environment', name: 'Dev' });

    await expect(mutatePromise).rejects.toThrow(/no workspace is open/i);
    await closePromise;

    const { workspace: onDisk } = await loadWorkspace(tree);
    expect(onDisk.environments).toEqual([]);
  });

  it('a genuine outside edit to an untouched environment file during a mutate’s own write is still picked up', async () => {
    const { workspace, tree } = await seedWorkspace('Team');
    const prodEnv = createWorkspaceEnvironment('Prod', new Set());
    await saveWorkspace({ ...workspace, environments: [prodEnv] }, tree);
    const prodEnvPath = join(tree, 'environments', `${prodEnv.slug}.yaml`);

    // `saveWorkspace` (no `previous` map is ever passed by the service) reads each managed
    // file's current bytes to decide whether it changed, `prod`'s included even though this
    // write never touches it — `candidateWorkspacePaths` conservatively pre-announces it anyway,
    // since `prod` exists in both the before and after model. Gating that comparison read lets a
    // real outside edit to `prod` land in the narrow window between the pre-announced `expect()`
    // and the post-write reconciliation, deterministically: the read already captured `prod`'s
    // *old* bytes before this fires, so `saveWorkspace` still (correctly) treats it as unchanged
    // and never touches the file itself — only the *reconciliation* decides its fate.
    let armed = false;
    let edited = false;
    const gatedFs: FsLike = {
      ...nodeFs,
      readFile: async (path: string) => {
        const data = await nodeFs.readFile(path);
        if (armed && path === prodEnvPath && !edited) {
          edited = true;
          await writeFile(
            prodEnvPath,
            JSON.stringify({
              id: prodEnv.id,
              name: 'Prod (edited externally)',
              order: 0,
              properties: {},
              endpoints: {},
            }),
            'utf8',
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return data;
      },
    };

    const { service } = newService({ fs: gatedFs });
    await service.open(workspace.id);
    await settle();
    armed = true;

    await service.mutate({ kind: 'rename-workspace', name: 'Renamed' });

    // The reconciliation un-expects `prod`'s file (never touched by this write) once the write
    // resolves, re-delivering the outside edit it had provisionally suppressed.
    await vi.waitFor(() => {
      const row = service.snapshot()?.environments.find((environment) => environment.id === prodEnv.id);
      expect(row?.name).toBe('Prod (edited externally)');
    }, WAIT_OPTIONS);

    await service.close();
  }, 20_000);

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
