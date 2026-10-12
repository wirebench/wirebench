// @vitest-environment node
import { parse as parseYaml } from 'yaml';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadLocalState,
  loadWorkspace,
  saveWorkspace,
  workspaceDir,
  workspaceManifestFile,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { WorkspaceProjectRef } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { CurrentValuesStore } from '../src/main/current-values.js';
import { HistoryService } from '../src/main/history-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import type { WorkspaceWire } from '../src/shared/wire-base.js';

let server: TestSoapServer | undefined;
let root: string;

/** A service over the temp `userData`, with a real engine and its own history files. */
function newService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    ...overrides,
  });
}

/**
 * Creates a real project folder at `projects/<slug>` inside `wsDir` and returns the manifest
 * reference for it — the id is the project's own, as the spec requires.
 */
async function seedProject(wsDir: string, slug: string, name: string): Promise<WorkspaceProjectRef> {
  const host = new ProjectHost(new EngineService());
  const project = await host.create({ dir: workspaceProjectDir(wsDir, slug), name });
  await host.close();
  return { id: project.id, slug, source: 'internal' };
}

/** Rewrites `wsDir`'s manifest so it references `refs`. */
async function registerProjects(wsDir: string, refs: readonly WorkspaceProjectRef[]): Promise<void> {
  const { workspace } = await loadWorkspace(wsDir);
  await saveWorkspace({ ...workspace, projects: refs }, wsDir);
}

/** Every file under `dir`, recursively, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  root = mkdtempSync(join(tmpdir(), 'wirebench-workspace-'));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceService lifecycle', () => {
  it('creates, lists and reopens a workspace', async () => {
    const service = newService();

    const created = await service.create('Payments team');
    expect(created.name).toBe('Payments team');
    expect(created.projects).toEqual([]);
    // The folder is named by the id, never by the display name.
    expect(created.dir).toBe(workspaceDir(root, created.id));
    expect(await filesUnder(created.dir)).toContain('workspace.yaml');

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, name: 'Payments team', projectCount: 0 });
    expect(listed[0]?.lastOpenedAt).toEqual(expect.any(String));

    await service.close();
    expect(service.snapshot()).toBeNull();

    const reopened = await newService().openLast();
    expect(reopened?.id).toBe(created.id);
  }, 60_000);

  it('lists internalProjectCount as internal-only, distinct from the raw projectCount', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Mixed');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const internal = await seedProject(dir, 'internal', 'Internal');
    await registerProjects(dir, [
      internal,
      { id: 'linked-project', slug: 'linked', source: 'linked', path: join(root, 'elsewhere') },
    ]);

    const listed = await newService().list();
    const row = listed.find((entry) => entry.id === created.id);
    expect(row).toMatchObject({ projectCount: 2, internalProjectCount: 1 });
  }, 60_000);

  it('opens two internal projects as independent hosts, each with its own history file', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Two projects');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const countries = await seedProject(dir, 'countries', 'Countries');
    const payments = await seedProject(dir, 'payments', 'Payments');
    await registerProjects(dir, [countries, payments]);

    const history = new HistoryService(root);
    const service = newService({ history });
    const workspace = await service.open(created.id);

    expect(workspace.projects.map((project) => project.name)).toEqual(['Countries', 'Payments']);
    expect(workspace.projects.map((project) => project.status)).toEqual(['ready', 'ready']);
    expect(workspace.projects.map((project) => project.source)).toEqual(['internal', 'internal']);

    const hosts = service.hosts();
    expect(hosts).toHaveLength(2);
    expect(hosts[0]).not.toBe(hosts[1]);
    expect(service.hostFor(countries.id)).toBe(hosts[0]);
    expect(service.hostFor(payments.id)).toBe(hosts[1]);
    expect(history.openProjectIds()).toEqual([countries.id, payments.id]);

    await service.close();
    expect(history.openProjectIds()).toEqual([]);
  }, 60_000);

  it('never writes recent-projects.json for a project opened as part of a workspace', async () => {
    // `recent-projects.json` predates workspaces: it is a leftover-import hint for the picker,
    // not a log of every project a workspace host happens to open. `ProjectHost.create`/
    // `openProject` used to record every project unconditionally; a host built by
    // `WorkspaceService` must not resurrect that file.
    const bootstrap = newService();
    const created = await bootstrap.create('No recents');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const countries = await seedProject(dir, 'countries', 'Countries');
    await registerProjects(dir, [countries]);

    const service = newService();
    await service.open(created.id);
    await service.addProject('Second project');
    await service.close();

    expect(existsSync(join(root, 'recent-projects.json'))).toBe(false);
  }, 60_000);

  it("opens a project's history before announcing the project", async () => {
    // The renderer's history view reloads on `project.changed`; a list answered before the
    // project's history file is attached would come back without it.
    const bootstrap = newService();
    const created = await bootstrap.create('Ordering');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const countries = await seedProject(dir, 'countries', 'Countries');
    await registerProjects(dir, [countries]);

    const history = new HistoryService(root);
    const seen: { projectId: string; historyOpen: boolean }[] = [];
    const service = newService({
      history,
      hooks: {
        onProjectChanged: (projectId, project) => {
          if (project !== null) {
            seen.push({ projectId, historyOpen: history.openProjectIds().includes(projectId) });
          }
        },
      },
    });
    await service.open(created.id);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => event.projectId === countries.id && event.historyOpen)).toBe(true);

    // A new project follows the same order.
    seen.length = 0;
    const { projectId } = await service.addProject('Payments');
    expect(seen.some((event) => event.projectId === projectId)).toBe(true);
    expect(seen.every((event) => event.historyOpen)).toBe(true);

    await service.close();
  }, 60_000);

  it('lists a corrupt workspace as unreadable rather than dropping it', async () => {
    const service = newService();
    const created = await service.create('Healthy');
    await service.close();

    const brokenId = '01J8K3Q7Z2M5N9RVTX4W6Y8BAD';
    const brokenDir = workspaceDir(root, brokenId);
    await mkdir(brokenDir, { recursive: true });
    await writeFile(workspaceManifestFile(brokenDir), 'formatVersion: 1\nid: [not, a, string]\n', 'utf8');

    const listed = await service.list();
    expect(listed).toHaveLength(2);
    const broken = listed.find((row) => row.unreadable === true);
    expect(broken).toMatchObject({ id: brokenId, name: brokenId, dir: brokenDir, projectCount: 0, createdAt: '' });
    expect(listed.some((row) => row.id === created.id)).toBe(true);
  }, 60_000);

  it('opens the workspace even when a project folder is gone, marking that project missing', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Half broken');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const present = await seedProject(dir, 'present', 'Present');
    await registerProjects(dir, [present, { id: 'gone-project', slug: 'gone', source: 'internal' }]);

    const service = newService();
    const workspace = await service.open(created.id);

    expect(workspace.projects.map((project) => project.status)).toEqual(['ready', 'missing']);
    expect(workspace.projects[1]?.message).toContain('gone');
    expect(service.hosts()).toHaveLength(1);

    await service.close();
  }, 60_000);

  it('opens the workspace when a linked ref carries a relative path instead of aborting the open', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Bad link');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const present = await seedProject(dir, 'present', 'Present');
    await registerProjects(dir, [
      present,
      { id: 'linked-project', slug: 'linked', source: 'linked', path: join(root, 'elsewhere') },
    ]);
    // Rewritten on disk: a relative linked path cannot be produced through `saveWorkspace`, and
    // the loader drops such a ref as a `project-ref-invalid` problem rather than handing it over
    // — which is exactly what has to happen, without the open itself failing.
    const manifest = await readFile(workspaceManifestFile(dir), 'utf8');
    await writeFile(
      workspaceManifestFile(dir),
      manifest.replace(join(root, 'elsewhere'), 'relative/elsewhere'),
      'utf8',
    );

    const service = newService();
    const workspace = await service.open(created.id);

    // A corrupt reference costs the user that project, never the whole workspace.
    expect(workspace.projects.map((project) => project.status)).toEqual(['ready']);
    expect(service.hosts()).toHaveLength(1);

    await service.close();
  }, 60_000);

  it('marks a linked project whose folder is gone as missing rather than failing the open', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Missing link');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const present = await seedProject(dir, 'present', 'Present');
    await registerProjects(dir, [
      present,
      { id: 'linked-project', slug: 'linked', source: 'linked', path: join(root, 'not-a-folder') },
    ]);

    const service = newService();
    const workspace = await service.open(created.id);

    expect(workspace.projects.map((project) => project.status)).toEqual(['ready', 'missing']);
    expect(workspace.projects[1]).toMatchObject({ source: 'linked', dir: join(root, 'not-a-folder') });
    expect(service.hosts()).toHaveLength(1);

    await service.close();
  }, 60_000);

  it('closes everything again when open throws after the workspace is already current', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Half open');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'present', 'Present');
    await registerProjects(dir, [project]);

    const history = new HistoryService(root);
    const service = newService({
      history,
      // Throws only on the open, so `close()`'s own `onChanged(null)` still runs.
      hooks: {
        onChanged: (workspace) => {
          if (workspace !== null) {
            throw new Error('hook exploded');
          }
        },
      },
    });

    await expect(service.open(created.id)).rejects.toThrow(/hook exploded/);

    // No half-open state: no snapshot, no hosts, no history files left attached.
    expect(service.snapshot()).toBeNull();
    expect(service.hosts()).toEqual([]);
    expect(history.openProjectIds()).toEqual([]);
  }, 60_000);

  it('openLast returns null and keeps the reason when the workspace will not open', async () => {
    const service = newService();
    const created = await service.create('Doomed');
    await service.close();
    await writeFile(workspaceManifestFile(workspaceDir(root, created.id)), 'formatVersion: 1\nid: 7\n', 'utf8');

    const reopened = newService();
    expect(await reopened.openLast()).toBeNull();
    expect(reopened.lastError()).toEqual(expect.any(String));
    expect(reopened.snapshot()).toBeNull();
  }, 60_000);

  it('openLast returns null when no workspace has ever been opened', async () => {
    expect(await newService().openLast()).toBeNull();
  });
});

describe('WorkspaceService across windows', () => {
  it('refuses to open, rename or delete a workspace another window holds', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Held');
    await bootstrap.close();
    const service = newService({ heldElsewhere: (id) => id === created.id, trash: () => Promise.resolve() });

    await expect(service.open(created.id)).rejects.toMatchObject({ code: 'workspace-open-elsewhere' });
    await expect(service.rename(created.id, 'Renamed')).rejects.toMatchObject({ code: 'workspace-open-elsewhere' });
    await expect(service.delete(created.id)).rejects.toMatchObject({ code: 'workspace-open-elsewhere' });
    expect(service.snapshot()).toBeNull();
    expect((await service.list()).map((summary) => summary.name)).toEqual(['Held']);
  });

  it("closing one window's workspace keeps a project the other window has open in History", async () => {
    const bootstrap = newService();
    const first = await bootstrap.create('First');
    const second = await bootstrap.create('Second');
    await bootstrap.close();
    const shared = await seedProject(workspaceDir(root, first.id), 'shared', 'Shared');
    await registerProjects(workspaceDir(root, first.id), [shared]);
    // The same project folder linked into a second workspace.
    await registerProjects(workspaceDir(root, second.id), [
      {
        id: shared.id,
        slug: 'shared',
        source: 'linked',
        path: workspaceProjectDir(workspaceDir(root, first.id), 'shared'),
      },
    ]);

    const history = new HistoryService(root);
    const one = newService({ history, sweepJoining: false });
    const two = newService({ history, sweepJoining: false });
    await one.open(first.id);
    await two.open(second.id);
    expect(history.openProjectIds()).toEqual([shared.id]);

    await one.close();
    expect(history.openProjectIds()).toEqual([shared.id]);
    await two.close();
    expect(history.openProjectIds()).toEqual([]);
  }, 60_000);

  it('only the service told to sweeps `.joining/`', async () => {
    const joining = join(root, 'workspaces', '.joining');
    await mkdir(join(joining, 'half-made'), { recursive: true });
    const later = newService({ sweepJoining: false });
    await later.list();
    expect(existsSync(join(joining, 'half-made'))).toBe(true);
  });
});

describe('WorkspaceService manifest operations', () => {
  it('renames the open workspace and a closed one', async () => {
    const service = newService();
    const open = await service.create('Before');
    const other = await newService().create('Other');
    // `other` was created by a second service, so it is not the one `service` holds open.

    const afterOpenRename = await service.rename(open.id, 'After');
    expect(afterOpenRename.find((row) => row.id === open.id)?.name).toBe('After');
    expect(service.snapshot()?.name).toBe('After');

    const afterClosedRename = await service.rename(other.id, 'Renamed while closed');
    expect(afterClosedRename.find((row) => row.id === other.id)?.name).toBe('Renamed while closed');
    // Still the workspace this service holds open — renaming another one does not switch.
    expect(service.snapshot()?.id).toBe(open.id);

    const { workspace } = await loadWorkspace(workspaceDir(root, other.id));
    expect(workspace.name).toBe('Renamed while closed');
  }, 60_000);

  it('gives a new environment an order past the highest, not the count', async () => {
    const service = newService();
    await service.create('Orders');

    const first = (await service.mutate({ kind: 'add-workspace-environment', name: 'dev' })).createdEnvironmentId;
    await service.mutate({ kind: 'add-workspace-environment', name: 'uat' });
    // Removing the first frees order 0: a count-based order would hand the next environment
    // order 1, which `uat` already holds, and the grid would show two columns claiming one slot.
    await service.mutate({ kind: 'remove-workspace-environment', environmentId: first! });
    await service.mutate({ kind: 'add-workspace-environment', name: 'prod' });

    const orders = service.snapshot()!.environments.map((environment) => environment.order);
    expect(orders).toEqual([1, 2]);
    expect(new Set(orders).size).toBe(orders.length);
  }, 60_000);

  it('refuses a workspace id that is not a folder name', async () => {
    const service = newService({ trash: () => Promise.resolve() });
    // The picker's row id is the one workspace value that comes from the renderer: a traversal
    // must never reach `join`.
    await expect(service.open('../../etc')).rejects.toThrow(/Not a workspace id/);
    await expect(service.rename('..', 'x')).rejects.toThrow(/Not a workspace id/);
    await expect(service.delete('a/b')).rejects.toThrow(/Not a workspace id/);
  });

  it('refuses to delete without a trash implementation, keeping the workspace open', async () => {
    const service = newService();
    const created = await service.create('Still mine');

    await expect(service.delete(created.id)).rejects.toThrow(/trash implementation/);

    // The refusal comes before the close, so the user is not dropped at the picker.
    expect(service.snapshot()?.id).toBe(created.id);
    expect((await service.list()).map((row) => row.id)).toEqual([created.id]);

    await service.close();
  }, 60_000);

  it('deletes through the injected trash and drops the workspace from the list', async () => {
    const trashed: string[] = [];
    const service = newService({
      trash: (path) => {
        trashed.push(path);
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
    });
    const created = await service.create('Doomed');

    const remaining = await service.delete(created.id);

    expect(trashed).toEqual([workspaceDir(root, created.id)]);
    expect(remaining).toEqual([]);
    // Deleting the open workspace closes it first.
    expect(service.snapshot()).toBeNull();
    // And it is no longer what `openLast` would reopen.
    expect(await newService().openLast()).toBeNull();
  }, 60_000);

  it('tells the hooks a workspace was deleted, so what main keeps for it goes too', async () => {
    const deleted: string[] = [];
    const service = newService({
      trash: (path) => {
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
      hooks: {
        onDeleted: (workspaceId) => {
          deleted.push(workspaceId);
        },
      },
    });
    const created = await service.create('Doomed');
    await service.delete(created.id);
    expect(deleted).toEqual([created.id]);
  }, 60_000);
});

describe('WorkspaceService current values', () => {
  it('lets a project current value be set after a workspace opens, and hands it to a send', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Values');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const seeded = new ProjectHost(new EngineService());
    const project = await seeded.create({ dir: workspaceProjectDir(dir, 'pets'), name: 'Pets' });
    await seeded.mutate({ kind: 'set-project-property', name: 'tenant', value: 'alpha' });
    await seeded.save();
    await seeded.close();
    await registerProjects(dir, [{ id: project.id, slug: 'pets', source: 'internal' }]);

    // Wired through the hooks as index.ts does: `close()` announces no workspace first, and the
    // hosts' first project snapshots arrive before the workspace's own.
    const currentValues = new CurrentValuesStore();
    const service = newService({
      currentValues,
      hooks: {
        onChanged: (workspace) => currentValues.syncWorkspace(workspace),
        onDeleted: (workspaceId) => currentValues.forgetWorkspace(workspaceId),
        onProjectChanged: (projectId, changed) => currentValues.syncProject(projectId, changed),
      },
    });
    await service.open(created.id);

    currentValues.set({ scope: 'project', projectId: project.id }, 'tenant', 'beta');
    const context = service.hostFor(project.id).runContextFor('any');
    expect(context?.current).toEqual({ project: { tenant: 'beta' } });
    await service.close();
  }, 60_000);
});

describe('WorkspaceService routing', () => {
  it('finds the host of a request id, and refuses an unknown entity', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Routing');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const plain = await seedProject(dir, 'plain', 'Plain');
    const calculator = await seedProject(dir, 'calculator', 'Calculator');
    await registerProjects(dir, [plain, calculator]);

    const service = newService();
    await service.open(created.id);

    const host = service.hostFor(calculator.id);
    await host.kind('soap').addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });

    const snapshot = service.projectSnapshot(calculator.id);
    const requestId = snapshot?.requests[0]?.id;
    const interfaceId = snapshot?.interfaces[0]?.id;
    expect(requestId).toEqual(expect.any(String));

    expect(service.hostOfEntity(requestId!)).toBe(host);
    expect(service.hostOfEntity(interfaceId!)).toBe(host);
    // An endpoint can own an OAuth2 configuration, so the `oauth2.*` channels route by its id too.
    const endpointId = snapshot?.interfaces[0]?.endpoints[0]?.id;
    expect(endpointId).toEqual(expect.any(String));
    expect(service.hostOfEntity(endpointId!)).toBe(host);
    expect(service.soapAuthOf(endpointId!)).toBeUndefined();
    expect(service.hostOfEntity(calculator.id)).toBe(host);
    expect(service.projectId(requestId!)).toBe(calculator.id);
    // The other project's host holds none of those ids.
    expect(service.hostOfEntity(plain.id)).toBe(service.hostFor(plain.id));

    // Routed calls land on the owning host without the caller naming a project.
    expect(service.requestMeta(requestId!)?.requestName).toEqual(expect.any(String));
    expect(service.validationTargetFor(requestId!)?.interfaceId).toBe(interfaceId);
    expect(service.projectSnapshot(plain.id)?.requests).toEqual([]);

    // `mock.start` addresses a mock by id, so a new mock routes to its project too.
    await host.mutate({ kind: 'add-mock', containerId: interfaceId!, name: 'Calculator mock' });
    const mockId = service.projectSnapshot(calculator.id)?.mocks[0]?.id;
    expect(mockId).toEqual(expect.any(String));
    expect(service.hostOfEntity(mockId!)).toBe(host);
    expect(service.projectId(mockId!)).toBe(calculator.id);

    expect(() => service.hostOfEntity('01J8NOTHINGATALL')).toThrow(/No open project holds the entity/);
    expect(() => service.reload('01J8NOTAPROJECT')).toThrow(/No open project with id/);
    expect(() => service.hostFor('01J8NOTAPROJECT')).toThrow(/No open project with id/);

    await service.close();
  }, 60_000);
});

describe('WorkspaceService routing of addInterface and reload', () => {
  it('routes addInterface and reload to the project named in the call', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Per-project channels');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const plain = await seedProject(dir, 'plain', 'Plain');
    const target = await seedProject(dir, 'target', 'Target');
    await registerProjects(dir, [plain, target]);

    const service = newService();
    await service.open(created.id);

    const { interfaceId } = await service.addInterface(target.id, { source: { kind: 'url', url: server!.wsdlUrl } });

    // The import landed on `target` and nowhere else.
    expect(service.projectSnapshot(target.id)?.interfaces.map((iface) => iface.id)).toEqual([interfaceId]);
    expect(service.projectSnapshot(plain.id)?.interfaces).toEqual([]);

    // `reload` takes what is on disk for that one project, discarding its unsaved rename.
    await service.projectMutate(target.id, { kind: 'rename-project', name: 'Renamed but not saved' });
    expect(service.projectSnapshot(target.id)?.name).toBe('Renamed but not saved');
    const reloaded = await service.reload(target.id);
    expect(reloaded?.name).toBe('Target');
    expect(service.projectSnapshot(plain.id)?.name).toBe('Plain');

    await service.close();
  }, 60_000);
});

describe('WorkspaceService saving', () => {
  it('keeps a dirty host unsaved on close, and restores it unsaved on the next open', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Saving');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'dirty', 'Dirty');
    await registerProjects(dir, [project]);
    const projectYamlPath = join(workspaceProjectDir(dir, 'dirty'), 'wirebench.yaml');
    const before = await readFile(projectYamlPath, 'utf8');

    const service = newService();
    await service.open(created.id);
    await service.projectMutate(project.id, { kind: 'rename-project', name: 'Renamed before close' });
    expect(service.projectSnapshot(project.id)?.dirty).toBe(true);
    await service.close();

    // Nothing reached the project folder; the unsaved state is kept with the workspace instead.
    expect(await readFile(projectYamlPath, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'unsaved', `${project.id}.json`))).toBe(true);

    const reopened = newService();
    await reopened.open(created.id);
    expect(reopened.projectSnapshot(project.id)).toMatchObject({ name: 'Renamed before close', dirty: true });
    expect(reopened.takeRestored().notices).toEqual([
      { projectId: project.id, projectName: 'Renamed before close', status: 'restored', conflicts: [], dropped: [] },
    ]);
    // Handed over once.
    expect(reopened.takeRestored().notices).toEqual([]);
    await reopened.close();
    expect(await readFile(projectYamlPath, 'utf8')).toBe(before);
  }, 60_000);

  it('restores unsaved changes on top of a file that changed on disk, and says so', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Conflict');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'shared', 'Shared');
    await registerProjects(dir, [project]);
    const projectYamlPath = join(workspaceProjectDir(dir, 'shared'), 'wirebench.yaml');

    const service = newService();
    await service.open(created.id);
    await service.projectMutate(project.id, { kind: 'rename-project', name: 'Mine' });
    await service.close();

    // Edited outside the app while the workspace was closed.
    const onDisk = await readFile(projectYamlPath, 'utf8');
    await writeFile(projectYamlPath, onDisk.replace('name: Shared', 'name: Theirs'));

    const reopened = newService();
    await reopened.open(created.id);
    expect(reopened.projectSnapshot(project.id)).toMatchObject({ name: 'Mine', dirty: true });
    expect(reopened.takeRestored().notices).toMatchObject([{ status: 'restored', conflicts: ['wirebench.yaml'] }]);
    await reopened.close();
  }, 60_000);

  it('leaves nothing to restore once the project is saved', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Saved');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'saved', 'Saved');
    await registerProjects(dir, [project]);

    const service = newService();
    await service.open(created.id);
    await service.projectMutate(project.id, { kind: 'rename-project', name: 'Saved name' });
    await service.saveAll('manual');
    await service.close();
    expect(existsSync(join(dir, 'unsaved', `${project.id}.json`))).toBe(false);

    const reopened = newService();
    await reopened.open(created.id);
    expect(reopened.projectSnapshot(project.id)).toMatchObject({ name: 'Saved name', dirty: false });
    expect(reopened.takeRestored().notices).toEqual([]);
    await reopened.close();
  }, 60_000);

  it('keeps stashed request drafts for the workspace they were stashed for', async () => {
    const service = newService();
    const first = await service.create('Drafts');
    await service.stashDrafts(first.id, { r1: { envelopeXml: '<unsaved/>' } });
    await service.stashDrafts('some-other-workspace', { r2: { envelopeXml: '<ignored/>' } });
    await service.close();

    await service.open(first.id);
    expect(service.takeRestored()).toMatchObject({
      workspaceId: first.id,
      drafts: { r1: { envelopeXml: '<unsaved/>' } },
    });
    await service.close();
  }, 60_000);

  it('keeps stashed WebSocket drafts across a close and reopen, alongside the other protocols', async () => {
    const service = newService();
    const first = await service.create('WS drafts');
    await service.stashDrafts(first.id, {}, {}, {}, { ws1: { url: 'wss://example.test' } });
    await service.close();

    await service.open(first.id);
    expect(service.takeRestored()).toMatchObject({
      workspaceId: first.id,
      wsDrafts: { ws1: { url: 'wss://example.test' } },
    });
    await service.close();
  }, 60_000);

  it('restores unsaved changes after a crash, from the record kept current while running', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Crash');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'crashy', 'Crashy');
    await registerProjects(dir, [project]);

    const crashed = newService();
    await crashed.open(created.id);
    await crashed.projectMutate(project.id, { kind: 'rename-project', name: 'Before the crash' });
    // No close: the process "dies" once the debounced record write has landed.
    await expect
      .poll(() => existsSync(join(dir, 'unsaved', `${project.id}.json`)), { timeout: 10_000, interval: 100 })
      .toBe(true);

    const relaunched = newService();
    await relaunched.open(created.id);
    expect(relaunched.projectSnapshot(project.id)).toMatchObject({ name: 'Before the crash', dirty: true });
    await relaunched.close();
  }, 60_000);

  it('opens normally past a corrupt record, and drops a removed project’s record', async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Corrupt');
    await bootstrap.close();
    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'plain', 'Plain');
    await registerProjects(dir, [project]);
    await mkdir(join(dir, 'unsaved'), { recursive: true });
    await writeFile(join(dir, 'unsaved', `${project.id}.json`), '{ not json');

    const service = newService();
    await service.open(created.id);
    expect(service.projectSnapshot(project.id)).toMatchObject({ name: 'Plain', dirty: false });

    await service.projectMutate(project.id, { kind: 'rename-project', name: 'About to go' });
    await service.close();
    expect(existsSync(join(dir, 'unsaved', `${project.id}.json`))).toBe(true);
    await service.open(created.id);
    await service.removeProject(project.id, { deleteFiles: false });
    expect(existsSync(join(dir, 'unsaved', `${project.id}.json`))).toBe(false);
    await service.close();
  }, 60_000);

  it('keeps no secret material anywhere in the workspace folder', async () => {
    const password = 'hunter2-workspace';
    const bootstrap = newService();
    const created = await bootstrap.create('Secrets');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const project = await seedProject(dir, 'secretive', 'Secretive');
    await registerProjects(dir, [project]);

    const secrets = { get: (ref: string) => Promise.resolve(ref === 'secret:pw' ? password : undefined) };
    const service = new WorkspaceService({
      userDataDir: root,
      engine: new EngineService((ref) => secrets.get(ref)),
      history: new HistoryService(root),
      secrets,
    });
    await service.open(created.id);

    await service
      .hostFor(project.id)
      .kind('soap')
      .addInterface({
        source: { kind: 'url', url: server!.wsdlUrl },
        auth: { username: 'alice', passwordRef: 'secret:pw' },
        useForRequests: true,
      });
    await service.saveAll('test');

    // Same discipline as the project-level "passwordRef, never the password" checks: grep the
    // whole saved workspace, project folders and definition cache included.
    const files = await filesUnder(dir);
    const offenders: string[] = [];
    for (const file of files) {
      if ((await readFile(join(dir, file), 'utf8')).includes(password)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    expect(files.some((file) => file.startsWith(join('projects', 'secretive')))).toBe(true);

    await service.close();
  }, 60_000);

  it("routes a project's webhook collection id, so its OAuth2 channels find the host", async () => {
    const bootstrap = newService();
    const created = await bootstrap.create('Webhook routing');
    await bootstrap.close();

    const dir = workspaceDir(root, created.id);
    const hooks = await seedProject(dir, 'hooks', 'Hooks');
    await registerProjects(dir, [hooks]);

    const service = newService();
    await service.open(created.id);
    const host = service.hostFor(hooks.id);
    await host.mutate({ kind: 'update-webhooks', patch: { auth: { type: 'basic', username: 'u', passwordRef: 'p' } } });

    const collectionId = `webhooks:${hooks.id}`;
    expect(service.hostOfEntity(collectionId)).toBe(host);
    expect(service.restAuthOf(collectionId)).toMatchObject({ type: 'basic', username: 'u' });

    await service.close();
  }, 60_000);
});

describe('secretSourcesSnapshot', () => {
  it('is undefined with no workspace open and reads the shared mapping, overrides and approval once open', async () => {
    const bootstrap = newService();
    expect(bootstrap.secretSourcesSnapshot()).toBeUndefined();
    const created = await bootstrap.create('Sources');
    await bootstrap.close();
    const hash = 'cd'.repeat(32);
    await writeFile(
      join(workspaceDir(root, created.id), 'local.yaml'),
      [
        'version: 2',
        'secretSources:',
        '  a:',
        '    kind: none',
        'secretSourcesApproved:',
        `  hash: ${hash}`,
        '  mapping: {}',
        '',
      ].join('\n'),
    );
    const service = newService();
    await service.open(created.id);
    expect(service.secretSourcesSnapshot()).toEqual({
      shared: undefined,
      local: { a: { kind: 'none' } },
      approvedHash: hash,
    });
    await service.close();
    expect(service.secretSourcesSnapshot()).toBeUndefined();
  });
});

/**
 * A closed workspace with two internal projects, Billing and CRM, and no environment yet: the
 * per-project active state needs projects to key on.
 */
async function twoProjectWorkspace(name = 'Envs'): Promise<{ id: string; dir: string; billing: string; crm: string }> {
  const bootstrap = newService();
  const created = await bootstrap.create(name);
  await bootstrap.close();
  const dir = workspaceDir(root, created.id);
  const billing = await seedProject(dir, 'billing', 'Billing');
  const crm = await seedProject(dir, 'crm', 'CRM');
  await registerProjects(dir, [billing, crm]);
  return { id: created.id, dir, billing: billing.id, crm: crm.id };
}

/** Adds an environment named `name` to the open workspace and returns its id. */
async function addEnvironment(service: WorkspaceService, name: string): Promise<string> {
  const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name });
  return createdEnvironmentId as string;
}

/** Rewrites the closed workspace's manifest as a v2 one carrying `activeEnvironmentId`, as an older build would have. */
async function writeV2Manifest(dir: string, activeEnvironmentId: string): Promise<void> {
  const manifestText = await readFile(workspaceManifestFile(dir), 'utf8');
  const v2Text = manifestText
    .replace('formatVersion: 4', 'formatVersion: 2')
    .replace(/\nprojects:/, `\nactiveEnvironmentId: ${activeEnvironmentId}\nprojects:`);
  await writeFile(workspaceManifestFile(dir), v2Text);
}

describe('active environment: machine-local, via local.yaml', () => {
  it('setActiveEnvironment writes local.yaml and leaves workspace.yaml bytes unchanged', async () => {
    const { id, dir, billing } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const manifestBefore = await readFile(workspaceManifestFile(dir), 'utf8');

    const dev = await addEnvironment(service, 'dev');
    // Adding an environment does touch the manifest (it holds the environments list), so re-snapshot
    // the manifest bytes right before the call under test.
    const manifestBeforeActivate = await readFile(workspaceManifestFile(dir), 'utf8');

    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });

    const manifestAfter = await readFile(workspaceManifestFile(dir), 'utf8');
    expect(manifestAfter).toBe(manifestBeforeActivate);
    expect(manifestAfter).not.toContain('activeEnvironmentId');
    expect(manifestBefore).not.toContain('activeEnvironmentId');

    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev } });
    expect(service.snapshot()?.activeEnvironments).toEqual({ [billing]: dev });
    expect(service.snapshot()?.activeEnvironmentId).toBe(dev);

    await service.close();
  });

  it('setActiveEnvironment keeps the secret-source fields of local.yaml, set or cleared', async () => {
    const { id, dir, billing } = await twoProjectWorkspace();
    const bootstrap = newService();
    await bootstrap.open(id);
    const dev = await addEnvironment(bootstrap, 'dev');
    await bootstrap.close();
    const approval = { hash: 'ab'.repeat(32), mapping: { a: { kind: 'gcp', secret: 's' } } };
    const overrides = { a: { kind: 'none' as const } };
    await writeFile(
      join(dir, 'local.yaml'),
      [
        'version: 2',
        'secretSources:',
        '  a:',
        '    kind: none',
        'secretSourcesApproved:',
        `  hash: ${approval.hash}`,
        '  mapping:',
        '    a:',
        '      kind: gcp',
        '      secret: s',
        '',
      ].join('\n'),
    );

    const service = newService();
    await service.open(id);
    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });
    expect(await loadLocalState(dir)).toEqual({
      version: 3,
      activeEnvironments: { [billing]: dev },
      secretSources: overrides,
      secretSourcesApproved: approval,
    });

    await service.setActiveEnvironment({ projectId: billing, environmentId: null });
    expect(await loadLocalState(dir)).toEqual({
      version: 3,
      secretSources: overrides,
      secretSourcesApproved: approval,
    });

    await service.close();
  });

  it('clearing the active environment keeps a non-mapping secretSources value in local.yaml', async () => {
    const { id, dir, billing } = await twoProjectWorkspace();
    const bootstrap = newService();
    await bootstrap.open(id);
    const dev = await addEnvironment(bootstrap, 'dev');
    await bootstrap.close();
    await writeFile(join(dir, 'local.yaml'), 'version: 2\nsecretSources:\n  - one\n');

    const service = newService();
    await service.open(id);
    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });
    await service.setActiveEnvironment({ projectId: billing, environmentId: null });
    expect(await loadLocalState(dir)).toEqual({ version: 3, secretSourcesRaw: ['one'] });
    await service.close();
  });

  it('reopening the workspace restores each project’s active environment from local.yaml', async () => {
    const { id, billing, crm } = await twoProjectWorkspace();
    const bootstrap = newService();
    await bootstrap.open(id);
    const dev = await addEnvironment(bootstrap, 'dev');
    const qa = await addEnvironment(bootstrap, 'qa');
    await bootstrap.setActiveEnvironment({ projectId: billing, environmentId: dev });
    await bootstrap.setActiveEnvironment({ projectId: crm, environmentId: qa });
    await bootstrap.close();

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: qa });
    // No project has been set since the open, so the transitional single id names none.
    expect(snapshot.activeEnvironmentId).toBeUndefined();

    await reopened.close();
  });

  it('opens a v2 workspace.yaml with activeEnvironmentId active for every project, creating local.yaml', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.close();

    await writeV2Manifest(dir, dev);
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: dev });
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev, [crm]: dev } });

    await reopened.close();
  });

  it('upgrades a v2 local.yaml on open: the active environment is kept per project and local.yaml becomes v3', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.close();

    await writeFile(join(dir, 'local.yaml'), `version: 2\nactiveEnvironmentId: ${dev}\n`);

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: dev });
    expect(parseYaml(await readFile(join(dir, 'local.yaml'), 'utf8'))).toEqual({
      version: 3,
      activeEnvironments: { [billing]: dev, [crm]: dev },
    });
    await reopened.close();
  });

  it('copies a legacy active environment only to the projects its scope applies to', async () => {
    const { id, dir, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.mutate({ kind: 'update-workspace-environment', environmentId: dev, patch: { projects: [crm] } });
    await service.close();

    await writeFile(join(dir, 'local.yaml'), `version: 2\nactiveEnvironmentId: ${dev}\n`);

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [crm]: dev });
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [crm]: dev } });
    await reopened.close();
  });

  it('a v2 local.yaml active environment wins over the manifest’s legacy one', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const qa = await addEnvironment(service, 'qa');
    await service.close();

    await writeV2Manifest(dir, qa);
    await writeFile(join(dir, 'local.yaml'), `version: 2\nactiveEnvironmentId: ${dev}\n`);

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: dev });
    await reopened.close();
  });

  it('a workspace with no project records no active environment for a legacy id', async () => {
    const service = newService();
    const created = await service.create('Legacy');
    const dev = await addEnvironment(service, 'dev');
    await service.close();

    const dir = workspaceDir(root, created.id);
    await writeFile(join(dir, 'local.yaml'), `version: 2\nactiveEnvironmentId: ${dev}\n`);

    const reopened = newService();
    const snapshot = await reopened.open(created.id);
    expect(snapshot.activeEnvironments).toEqual({});
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);
    await reopened.close();
  });

  it('drops a v2 local.yaml active environment that no longer exists', async () => {
    const service = newService();
    const created = await service.create('Legacy');
    await service.close();

    const dir = workspaceDir(root, created.id);
    await writeFile(join(dir, 'local.yaml'), 'version: 2\nactiveEnvironmentId: DELETED\n');

    const reopened = newService();
    const snapshot = await reopened.open(created.id);
    expect(snapshot.activeEnvironments).toEqual({});
    expect(snapshot.activeEnvironmentId).toBeUndefined();
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);
    expect(await loadLocalState(dir)).toEqual({ version: 3 });
    await reopened.close();
  });

  it('renaming a closed v2 workspace keeps its active environment in local.yaml', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.close();

    await writeV2Manifest(dir, dev);

    // Rewrites the manifest at v3 while closed, which drops the key from it.
    await newService().rename(id, 'Renamed legacy');
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev, [crm]: dev } });

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.name).toBe('Renamed legacy');
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: dev });
    await reopened.close();
  });

  it('renaming a closed workspace keeps a v2 local.yaml choice over the manifest’s legacy one', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const qa = await addEnvironment(service, 'qa');
    await service.close();

    await writeV2Manifest(dir, qa);
    await writeFile(join(dir, 'local.yaml'), `version: 2\nactiveEnvironmentId: ${dev}\n`);

    await newService().rename(id, 'Renamed legacy');
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev, [crm]: dev } });
  });

  it('finishes the v2->v3 migration on open: the manifest is rewritten at v3 with the key gone, so a later clear sticks', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace('Legacy');
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.close();

    await writeV2Manifest(dir, dev);

    const reopened = newService();
    const snapshot = await reopened.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [billing]: dev, [crm]: dev });

    // The migration is finished on disk immediately: no more legacy key to resurrect later.
    const migratedManifest = await readFile(workspaceManifestFile(dir), 'utf8');
    expect(migratedManifest).toContain('formatVersion: 4');
    expect(migratedManifest).not.toContain('activeEnvironmentId');

    // Explicitly clearing it must stick across a close/reopen — nothing on disk can bring it back.
    await reopened.setActiveEnvironment({ environmentId: null });
    await reopened.close();

    const relaunched = newService();
    const snapshotAfterClear = await relaunched.open(id);
    expect(snapshotAfterClear.activeEnvironments).toEqual({});

    await relaunched.close();
  });

  it('a v2 activeEnvironmentId naming a missing environment writes no local.yaml and activates nothing', async () => {
    const service = newService();
    const created = await service.create('Legacy');
    await service.close();

    const dir = workspaceDir(root, created.id);
    await writeV2Manifest(dir, '01JGHOSTGHOSTGHOSTGHOSTGH');

    const reopened = newService();
    const snapshot = await reopened.open(created.id);
    expect(snapshot.activeEnvironments).toEqual({});
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);

    // The stale manifest key is still cleaned up on disk, even though it named nothing real.
    const migratedManifest = await readFile(workspaceManifestFile(dir), 'utf8');
    expect(migratedManifest).toContain('formatVersion: 4');
    expect(migratedManifest).not.toContain('activeEnvironmentId');

    await reopened.close();
  });
});

describe('active environment per project (#468)', () => {
  it('keeps one active environment per project, and the transitional id follows the project last set', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const qa = await addEnvironment(service, 'qa');

    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });
    const afterCrm = await service.setActiveEnvironment({ projectId: crm, environmentId: qa });
    expect(afterCrm.activeEnvironments).toEqual({ [billing]: dev, [crm]: qa });
    expect(afterCrm.activeEnvironmentId).toBe(qa);
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev, [crm]: qa } });

    const afterClear = await service.setActiveEnvironment({ projectId: billing, environmentId: null });
    expect(afterClear.activeEnvironments).toEqual({ [crm]: qa });
    expect(afterClear.activeEnvironmentId).toBeUndefined();
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [crm]: qa } });

    await service.close();
  });

  it('fires onChanged with the new per-project state', async () => {
    const { id, billing } = await twoProjectWorkspace();
    const changed: (WorkspaceWire | null)[] = [];
    const service = newService({ hooks: { onChanged: (workspace) => changed.push(workspace) } });
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const before = changed.length;

    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });
    expect(changed.length).toBe(before + 1);
    expect(changed.at(-1)?.activeEnvironments).toEqual({ [billing]: dev });

    await service.close();
  });

  it('refuses an unknown project, an unknown environment, and an environment out of the project’s scope', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.mutate({ kind: 'update-workspace-environment', environmentId: dev, patch: { projects: [crm] } });

    await expect(
      service.setActiveEnvironment({ projectId: '01JNOTAPROJECT', environmentId: dev }),
    ).rejects.toMatchObject({
      code: 'project-not-found',
    });
    await expect(
      service.setActiveEnvironment({ projectId: billing, environmentId: '01JNOTANENV' }),
    ).rejects.toMatchObject({ code: 'environment-not-found' });
    await expect(service.setActiveEnvironment({ projectId: billing, environmentId: dev })).rejects.toMatchObject({
      code: 'environment-out-of-scope',
    });

    expect(service.snapshot()?.activeEnvironments).toEqual({});
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);
    await service.close();
  });

  it('without a project, applies to every project in the environment’s scope, and null clears them all', async () => {
    const { id, billing, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const qa = await addEnvironment(service, 'qa');
    await service.mutate({ kind: 'update-workspace-environment', environmentId: qa, patch: { projects: [crm] } });

    expect((await service.setActiveEnvironment({ environmentId: dev })).activeEnvironments).toEqual({
      [billing]: dev,
      [crm]: dev,
    });
    const scoped = await service.setActiveEnvironment({ environmentId: qa });
    expect(scoped.activeEnvironments).toEqual({ [billing]: dev, [crm]: qa });
    expect(scoped.activeEnvironmentId).toBe(qa);

    const cleared = await service.setActiveEnvironment({ environmentId: null });
    expect(cleared.activeEnvironments).toEqual({});
    expect(cleared.activeEnvironmentId).toBeUndefined();
    await service.close();
  });

  it('narrowing a scope drops the entries it leaves out; widening it again keeps the rest', async () => {
    const { id, dir, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.setActiveEnvironment({ environmentId: dev });

    const narrowed = await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev,
      patch: { projects: [crm] },
    });
    expect(narrowed.workspace.environments[0]?.projects).toEqual([crm]);
    expect(narrowed.workspace.activeEnvironments).toEqual({ [crm]: dev });
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [crm]: dev } });

    const widened = await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev,
      patch: { projects: null },
    });
    expect(widened.workspace.environments[0]).not.toHaveProperty('projects');
    expect(widened.workspace.activeEnvironments).toEqual({ [crm]: dev });
    await service.close();
  });

  it('removing an environment drops every entry pointing at it', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    const qa = await addEnvironment(service, 'qa');
    await service.setActiveEnvironment({ projectId: billing, environmentId: dev });
    await service.setActiveEnvironment({ projectId: crm, environmentId: qa });

    const { workspace } = await service.mutate({ kind: 'remove-workspace-environment', environmentId: qa });
    expect(workspace.activeEnvironments).toEqual({ [billing]: dev });
    expect(workspace.activeEnvironmentId).toBeUndefined();
    expect(await loadLocalState(dir)).toEqual({ version: 3, activeEnvironments: { [billing]: dev } });
    await service.close();
  });

  it('a scope patch keeps a project id this machine does not know', async () => {
    const { id, dir, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');

    const { workspace } = await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev,
      patch: { projects: [crm, '01JTEAMMATESPROJECTNOTHERE'] },
    });
    expect(workspace.environments[0]?.projects).toEqual([crm, '01JTEAMMATESPROJECTNOTHERE']);
    await service.close();

    const { workspace: onDisk } = await loadWorkspace(dir);
    expect(onDisk.environments[0]?.projects).toEqual([crm, '01JTEAMMATESPROJECTNOTHERE']);
  });

  it('a scope patch stores each project id once, in first-seen order', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');

    const { workspace } = await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev,
      patch: { projects: [crm, billing, crm, billing] },
    });
    expect(workspace.environments[0]?.projects).toEqual([crm, billing]);
    await service.close();

    const { workspace: onDisk } = await loadWorkspace(dir);
    expect(onDisk.environments[0]?.projects).toEqual([crm, billing]);
  });

  it('a patch that leaves out projects keeps the scope', async () => {
    const { id, crm } = await twoProjectWorkspace();
    const service = newService();
    await service.open(id);
    const dev = await addEnvironment(service, 'dev');
    await service.mutate({ kind: 'update-workspace-environment', environmentId: dev, patch: { projects: [crm] } });

    const { workspace } = await service.mutate({
      kind: 'update-workspace-environment',
      environmentId: dev,
      patch: { name: 'Development' },
    });
    expect(workspace.environments[0]?.projects).toEqual([crm]);
    await service.close();
  });

  it('opening drops entries for projects no longer in the workspace and environments that do not apply', async () => {
    const { id, dir, billing, crm } = await twoProjectWorkspace();
    const bootstrap = newService();
    await bootstrap.open(id);
    const dev = await addEnvironment(bootstrap, 'dev');
    const qa = await addEnvironment(bootstrap, 'qa');
    await bootstrap.mutate({ kind: 'update-workspace-environment', environmentId: qa, patch: { projects: [crm] } });
    await bootstrap.close();
    await writeFile(
      join(dir, 'local.yaml'),
      `version: 3\nactiveEnvironments:\n  ${billing}: ${qa}\n  ${crm}: ${dev}\n  01JGONEPROJECT: ${dev}\n`,
    );

    const service = newService();
    const snapshot = await service.open(id);
    expect(snapshot.activeEnvironments).toEqual({ [crm]: dev });
    await service.close();
  });
});
