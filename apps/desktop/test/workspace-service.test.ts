// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkspace,
  saveWorkspace,
  workspaceDir,
  workspaceManifestFile,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { WorkspaceProjectRef } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';

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
    await host.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });

    const snapshot = service.projectSnapshot(calculator.id);
    const requestId = snapshot?.requests[0]?.id;
    const interfaceId = snapshot?.interfaces[0]?.id;
    expect(requestId).toEqual(expect.any(String));

    expect(service.hostOfEntity(requestId!)).toBe(host);
    expect(service.hostOfEntity(interfaceId!)).toBe(host);
    expect(service.hostOfEntity(calculator.id)).toBe(host);
    expect(service.projectId(requestId!)).toBe(calculator.id);
    // The other project's host holds none of those ids.
    expect(service.hostOfEntity(plain.id)).toBe(service.hostFor(plain.id));

    // Routed calls land on the owning host without the caller naming a project.
    expect(service.requestMeta(requestId!)?.requestName).toEqual(expect.any(String));
    expect(service.validationTargetFor(requestId!)?.interfaceId).toBe(interfaceId);
    expect(service.projectSnapshot(plain.id)?.requests).toEqual([]);

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

    await service.hostFor(project.id).addInterface({
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
});
