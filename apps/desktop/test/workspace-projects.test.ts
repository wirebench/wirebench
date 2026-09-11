// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { definitionCacheDir, loadProject, loadWorkspace, workspaceProjectDir } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { registerProjectChannels } from '../src/main/ipc/project.js';
import { HistoryService } from '../src/main/history-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import type { WorkspaceWire } from '../src/shared/wire-types.js';

/**
 * What the next folder picker answers. `undefined` is a cancelled dialog.
 *
 * The real {@link pickFolder} runs in every one of these tests — only Electron's `dialog` is
 * stubbed — so each test exercises the actual pick-recording path into {@link DialogPicks}
 * rather than a stub that skips it. That is the whole point: "the renderer never names a path"
 * is only true if the main-side picker really is the only way a path gets in.
 */
let folderPick: string | undefined;

/** `project.*` handlers, registered for the one test that drives the channel end to end. */
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showOpenDialog: () =>
      Promise.resolve(
        folderPick === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folderPick] },
      ),
  },
}));

let server: TestSoapServer | undefined;
let root: string;
let picks: DialogPicks;
let trashed: string[];

/** A stand-in for a `WebContents`; the picker only ever uses it to find the parent window. */
const SENDER = {} as Parameters<WorkspaceService['linkProject']>[0];

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    picks,
    trash: (path: string) => {
      trashed.push(path);
      return Promise.resolve();
    },
    ...overrides,
  });
}

/** A workspace with one project of the given name, its calculator interface imported. */
async function workspaceWithProject(
  name: string,
): Promise<{ service: WorkspaceService; workspace: WorkspaceWire; projectId: string }> {
  const service = newService();
  const created = await service.create('Workspace');
  const { projectId } = await service.addProject(name);
  await service.hostFor(projectId).addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
  await service.saveAll('test');
  return { service, workspace: created, projectId };
}

/** Every file under `dir`, recursively, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Every entity id a workspace snapshot's projects hold, through their hosts. */
function entityIds(service: WorkspaceService, projectIds: readonly string[]): string[] {
  return projectIds.flatMap((projectId) => {
    const project = service.projectSnapshot(projectId);
    if (project === null) {
      return [];
    }
    return [
      project.id,
      ...project.interfaces.map((iface) => iface.id),
      ...project.requests.map((request) => request.id),
      ...project.environments.map((environment) => environment.id),
      ...project.keystores.map((keystore) => keystore.id),
    ];
  });
}

/**
 * The service resolves picked and linked folders with `fs.promises.realpath`, which on Windows
 * expands 8.3 short names (`RUNNER~1` → `runneradmin`). The plain `realpathSync` used for `root`
 * below does not, so an expected `dir` built from a temp path under `root` needs this instead to
 * match what the service actually stores.
 */
function realDir(path: string): string {
  return realpathSync.native(path);
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-projects-')));
  picks = new DialogPicks();
  trashed = [];
  folderPick = undefined;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceService.addProject', () => {
  it('creates the folder, appends the reference and opens a host', async () => {
    const service = newService();
    const created = await service.create('Payments');

    const { workspace, projectId } = await service.addProject('Billing API');

    expect(workspace.projects).toEqual([
      {
        id: projectId,
        name: 'Billing API',
        slug: 'Billing API',
        source: 'internal',
        dir: workspaceProjectDir(created.dir, 'Billing API'),
        status: 'ready',
      },
    ]);
    expect(await filesUnder(workspaceProjectDir(created.dir, 'Billing API'))).toContain('wirebench.yaml');
    expect(service.hostFor(projectId).snapshot()?.name).toBe('Billing API');

    // The reference survives a close/reopen because it went into the manifest, not just memory.
    const { workspace: onDisk } = await loadWorkspace(created.dir);
    expect(onDisk.projects).toEqual([{ id: projectId, slug: 'Billing API', source: 'internal' }]);

    await service.close();
  }, 60_000);

  it('gives two projects with the same name distinct slugs', async () => {
    const service = newService();
    await service.create('Payments');

    await service.addProject('Orders');
    const workspace = (await service.addProject('Orders')).workspace;

    expect(workspace.projects.map((project) => project.slug)).toEqual(['Orders', 'Orders-2']);
    await service.close();
  }, 60_000);
});

describe('WorkspaceService.removeProject', () => {
  it('takes back the project a failed project.addInterface { newProjectName } created', async () => {
    const service = newService();
    const created = await service.create('Payments');
    const { projectId: existing } = await service.addProject('Billing API');
    const before = service.snapshot()?.projects.map((project) => project.id);
    registerProjectChannels({
      router: service,
      addProject: async (name) => await service.addProject(name),
      removeProject: async (projectId, options) => await service.removeProject(projectId, options),
      projectDirs: () => [],
      picks,
    });

    const handler = handlers.get('project.addInterface');
    const result = (await handler?.(
      { sender: {} },
      { target: { newProjectName: 'Calculator' }, source: { kind: 'text', text: '<not-a-wsdl/>' } },
    )) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual(before);
    expect((await loadWorkspace(created.dir)).workspace.projects.map((ref) => ref.id)).toEqual([existing]);
    // Trash — never an `rm` — and only the folder the failed import created.
    expect(trashed).toEqual([workspaceProjectDir(created.dir, 'Calculator')]);

    await service.close();
  }, 60_000);

  it('moves an internal project folder to the trash when asked to delete the files', async () => {
    const service = newService();
    const created = await service.create('Payments');
    const { projectId } = await service.addProject('Billing API');
    const dir = workspaceProjectDir(created.dir, 'Billing API');

    const workspace = await service.removeProject(projectId, { deleteFiles: true });

    expect(workspace.projects).toEqual([]);
    expect(trashed).toEqual([dir]);
    // Trash is the *only* deletion: the folder is still there, because the injected trash
    // records rather than moves. A real `trash` is what removes it — never an `rm` here.
    expect(await filesUnder(dir)).toContain('wirebench.yaml');
    expect((await loadWorkspace(created.dir)).workspace.projects).toEqual([]);
    expect(() => service.hostFor(projectId)).toThrow(/unknown-project|No open project/);

    await service.close();
  }, 60_000);

  it('keeps an internal project folder when the files are not to be deleted', async () => {
    const service = newService();
    const created = await service.create('Payments');
    const { projectId } = await service.addProject('Billing API');

    await service.removeProject(projectId, { deleteFiles: false });

    expect(trashed).toEqual([]);
    expect(await filesUnder(workspaceProjectDir(created.dir, 'Billing API'))).toContain('wirebench.yaml');
    await service.close();
  }, 60_000);

  it('never touches a linked project folder, even when asked to delete the files', async () => {
    const outside = await workspaceWithProject('Shared');
    const linkedDir = workspaceProjectDir(outside.workspace.dir, 'Shared');
    const before = await filesUnder(linkedDir);
    await outside.service.close();

    const service = newService();
    const created = await service.create('Consumer');
    folderPick = linkedDir;
    const linked = await service.linkProject(SENDER);
    const projectId = linked?.projects[0]?.id as string;

    const workspace = await service.removeProject(projectId, { deleteFiles: true });

    expect(workspace.projects).toEqual([]);
    expect(trashed).toEqual([]);
    expect(await filesUnder(linkedDir)).toEqual(before);
    expect((await loadWorkspace(created.dir)).workspace.projects).toEqual([]);

    await service.close();
  }, 60_000);

  it('refuses an id that is not in the workspace', async () => {
    const service = newService();
    await service.create('Payments');

    await expect(service.removeProject('01J8NOTAPROJECT', { deleteFiles: false })).rejects.toMatchObject({
      code: 'project-not-in-workspace',
    });
    await service.close();
  }, 60_000);
});

describe('WorkspaceService.linkProject', () => {
  it('links an exported copy, recording the picked folder as a read pick', async () => {
    const source = await workspaceWithProject('Calculator');
    const exportDir = join(root, 'exported');
    await mkdir(exportDir, { recursive: true });
    folderPick = exportDir;
    expect(await source.service.exportProject(source.projectId, SENDER)).toEqual({ dir: realDir(exportDir) });
    await source.service.close();

    const service = newService();
    const created = await service.create('Consumer');
    folderPick = exportDir;
    const workspace = await service.linkProject(SENDER);

    expect(workspace?.projects).toEqual([
      expect.objectContaining({
        name: 'Calculator',
        slug: 'Calculator',
        source: 'linked',
        dir: realDir(exportDir),
        status: 'ready',
      }),
    ]);
    expect(picks.hasRead(exportDir)).toBe(true);
    expect((await loadWorkspace(created.dir)).workspace.projects[0]).toMatchObject({
      source: 'linked',
      path: realDir(exportDir),
    });

    await service.close();
  }, 60_000);

  it('refuses the same folder twice', async () => {
    const source = await workspaceWithProject('Calculator');
    const linkedDir = workspaceProjectDir(source.workspace.dir, 'Calculator');
    await source.service.close();

    const service = newService();
    await service.create('Consumer');
    folderPick = linkedDir;
    await service.linkProject(SENDER);

    await expect(service.linkProject(SENDER)).rejects.toMatchObject({
      code: 'project-already-in-workspace',
      details: { projectId: source.projectId },
    });
    expect(service.snapshot()?.projects).toHaveLength(1);

    await service.close();
  }, 60_000);

  it('refuses a folder that holds no project', async () => {
    const empty = join(root, 'not-a-project');
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, 'readme.txt'), 'nothing to see');

    const service = newService();
    await service.create('Consumer');
    folderPick = empty;

    await expect(service.linkProject(SENDER)).rejects.toMatchObject({ code: 'project-folder-missing' });
    expect(service.snapshot()?.projects).toEqual([]);

    await service.close();
  }, 60_000);

  it('returns null when the dialog is cancelled', async () => {
    const service = newService();
    await service.create('Consumer');
    folderPick = undefined;

    expect(await service.linkProject(SENDER)).toBeNull();
    expect(service.snapshot()?.projects).toEqual([]);
    await service.close();
  }, 60_000);
});

describe('WorkspaceService.importProjectFolder', () => {
  it('imports a copy of a linked project that coexists with its source', async () => {
    const origin = await workspaceWithProject('Calculator');
    const sourceDir = workspaceProjectDir(origin.workspace.dir, 'Calculator');
    await origin.service.close();

    const service = newService();
    await service.create('Consumer');
    folderPick = sourceDir;
    await service.linkProject(SENDER);
    folderPick = sourceDir;
    const workspace = await service.importProjectFolder(SENDER);

    expect(workspace?.projects.map((project) => [project.slug, project.source, project.status])).toEqual([
      ['Calculator', 'linked', 'ready'],
      ['Calculator-2', 'internal', 'ready'],
    ]);
    expect(picks.hasRead(sourceDir)).toBe(true);

    // No entity id is shared between the two — the index would be ambiguous if one were.
    const ids = workspace!.projects.map((project) => project.id);
    expect(ids[1]).not.toBe(ids[0]);
    const all = entityIds(service, ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(4);

    // The copy carries the definition cache, so its interfaces are usable without a re-fetch.
    const copyDir = workspaceProjectDir(service.snapshot()!.dir, 'Calculator-2');
    const slug = (await readdir(join(copyDir, 'interfaces')))[0] as string;
    expect(await filesUnder(definitionCacheDir(copyDir, slug))).toEqual(
      await filesUnder(definitionCacheDir(sourceDir, slug)),
    );

    await service.close();
  }, 60_000);

  it('returns null when the dialog is cancelled', async () => {
    const service = newService();
    await service.create('Consumer');
    folderPick = undefined;

    expect(await service.importProjectFolder(SENDER)).toBeNull();
    expect(service.snapshot()?.projects).toEqual([]);
    await service.close();
  }, 60_000);
});

describe('WorkspaceService.exportProject', () => {
  it('writes a project the target can load back, definition cache included', async () => {
    const { service, workspace, projectId } = await workspaceWithProject('Calculator');
    const sourceDir = workspaceProjectDir(workspace.dir, 'Calculator');
    const target = join(root, 'export-target');
    await mkdir(target, { recursive: true });
    folderPick = target;

    expect(await service.exportProject(projectId, SENDER)).toEqual({ dir: realDir(target) });

    // The write target went into the *write* half of the picks, not the read half.
    expect(picks.hasWrite(target)).toBe(true);
    expect(picks.hasRead(target)).toBe(false);

    const { project } = await loadProject(target);
    expect(project).toEqual(service.hostFor(projectId).model());

    // The definition cache is byte-identical: an export must not need the service back.
    const slug = (await readdir(join(target, 'interfaces')))[0] as string;
    const files = await filesUnder(definitionCacheDir(sourceDir, slug));
    expect(files.length).toBeGreaterThan(0);
    expect(await filesUnder(definitionCacheDir(target, slug))).toEqual(files);
    for (const file of files) {
      expect(await readFile(join(definitionCacheDir(target, slug), file))).toEqual(
        await readFile(join(definitionCacheDir(sourceDir, slug), file)),
      );
    }

    await service.close();
  }, 60_000);

  it('refuses a target that is not empty', async () => {
    const { service, projectId } = await workspaceWithProject('Calculator');
    const target = join(root, 'occupied');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'notes.txt'), 'mine');
    folderPick = target;

    await expect(service.exportProject(projectId, SENDER)).rejects.toMatchObject({
      code: 'export-target-not-empty',
    });
    expect(await filesUnder(target)).toEqual(['notes.txt']);

    await service.close();
  }, 60_000);

  it('returns null when the dialog is cancelled', async () => {
    const { service, projectId } = await workspaceWithProject('Calculator');
    folderPick = undefined;

    expect(await service.exportProject(projectId, SENDER)).toBeNull();
    await service.close();
  }, 60_000);
});

describe('WorkspaceService.locateProject', () => {
  it('re-points a linked project whose folder moved and brings its host back', async () => {
    const origin = await workspaceWithProject('Calculator');
    const originalDir = workspaceProjectDir(origin.workspace.dir, 'Calculator');
    await origin.service.close();

    const service = newService();
    const created = await service.create('Consumer');
    folderPick = originalDir;
    await service.linkProject(SENDER);
    await service.close();

    // The user moves the folder behind the app's back, then reopens the workspace.
    const movedDir = join(root, 'moved-calculator');
    await mkdir(movedDir, { recursive: true });
    await rm(movedDir, { recursive: true });
    await cp(originalDir, movedDir, { recursive: true });
    await rm(originalDir, { recursive: true, force: true });

    const reopened = newService();
    await reopened.open(created.id);
    expect(reopened.snapshot()?.projects[0]?.status).toBe('missing');

    folderPick = movedDir;
    const workspace = await reopened.locateProject(origin.projectId, SENDER);

    expect(workspace?.projects[0]).toMatchObject({ status: 'ready', dir: realDir(movedDir), source: 'linked' });
    expect(picks.hasRead(movedDir)).toBe(true);
    expect((await loadWorkspace(created.dir)).workspace.projects[0]).toMatchObject({ path: realDir(movedDir) });
    expect(reopened.hostFor(origin.projectId).snapshot()?.name).toBe('Calculator');

    await reopened.close();
  }, 60_000);

  it('refuses a folder that holds a different project', async () => {
    const origin = await workspaceWithProject('Calculator');
    const originalDir = workspaceProjectDir(origin.workspace.dir, 'Calculator');
    const otherDir = workspaceProjectDir(origin.workspace.dir, 'Other');
    await origin.service.addProject('Other');
    await origin.service.close();

    const service = newService();
    const created = await service.create('Consumer');
    folderPick = originalDir;
    await service.linkProject(SENDER);
    await service.close();

    await rm(originalDir, { recursive: true, force: true });
    const reopened = newService();
    await reopened.open(created.id);

    folderPick = otherDir;
    await expect(reopened.locateProject(origin.projectId, SENDER)).rejects.toMatchObject({
      code: 'project-folder-mismatch',
    });
    expect(reopened.snapshot()?.projects[0]?.status).toBe('missing');

    await reopened.close();
  }, 60_000);

  it('refuses a project that is not a missing linked one', async () => {
    const service = newService();
    await service.create('Payments');
    const { projectId } = await service.addProject('Billing API');

    await expect(service.locateProject(projectId, SENDER)).rejects.toMatchObject({
      code: 'project-not-relocatable',
    });
    await service.close();
  }, 60_000);
});
