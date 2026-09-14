// @vitest-environment node
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  createWorkspace,
  saveProject,
  saveShare,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';

let root: string;

function newService(overrides: Partial<WorkspaceServiceDeps> = {}): WorkspaceService {
  return new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-workspace-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Builds a `share.yaml { kind: 'folder', path: <external tree> }` app-data folder: the manifest
 * and one project live at `treeDir`, entirely outside `dir` — exactly the layout a folder share
 * will produce once sharing exists, though nothing here writes it through `WorkspaceService`.
 */
async function seedFolderShare(
  name: string,
): Promise<{ dir: string; treeDir: string; workspaceId: string; projectSlug: string }> {
  const workspace = createWorkspace(name);
  const treeDir = mkdtempSync(join(tmpdir(), 'wirebench-tree-'));
  await saveWorkspace({ ...workspace, projects: [{ id: 'proj-1', slug: 'calc', source: 'internal' }] }, treeDir);
  const project = createProject('Calc', { id: 'proj-1' });
  await saveProject(project, workspaceProjectDir(treeDir, 'calc'));

  const dir = workspaceDir(root, workspace.id);
  await mkdir(dir, { recursive: true });
  await saveShare(dir, { version: 1, kind: 'folder', path: treeDir });
  return { dir, treeDir, workspaceId: workspace.id, projectSlug: 'calc' };
}

describe('WorkspaceService — tree root vs app-data directory', () => {
  it('opens a share.yaml-only workspace, reading the manifest and projects from the tree', async () => {
    const { workspaceId, dir } = await seedFolderShare('Shared team');

    const service = newService();
    const opened = await service.open(workspaceId);

    expect(opened.name).toBe('Shared team');
    expect(opened.projects.map((project) => project.name)).toEqual(['Calc']);
    expect(opened.projects[0]?.status).toBe('ready');
    // snapshot().dir stays the app-data directory (T3 ruling), not the tree.
    expect(opened.dir).toBe(dir);

    await service.close();
  });

  it('list() shows a folder-share workspace, reading its manifest through the tree', async () => {
    const { workspaceId } = await seedFolderShare('Listed share');

    const rows = await newService().list();
    const row = rows.find((candidate) => candidate.id === workspaceId);
    expect(row).toMatchObject({ name: 'Listed share', projectCount: 1, internalProjectCount: 1 });
    expect(row?.unreadable).toBeUndefined();
  });

  it('a share.yaml pointing at a missing folder lists as unreadable and refuses to open', async () => {
    const workspace = createWorkspace('Dangling share');
    const dir = workspaceDir(root, workspace.id);
    await mkdir(dir, { recursive: true });
    await saveShare(dir, { version: 1, kind: 'folder', path: join(root, 'nowhere-near-here') });

    const rows = await newService().list();
    const row = rows.find((candidate) => candidate.id === workspace.id);
    expect(row).toMatchObject({ unreadable: true });

    await expect(newService().open(workspace.id)).rejects.toThrow();
  });

  it('addProject writes the new project under the tree root, not the app-data directory', async () => {
    const { workspaceId, treeDir, dir } = await seedFolderShare('Grows in the tree');
    const service = newService();
    await service.open(workspaceId);

    const { projectId } = await service.addProject('Second project');
    expect(projectId).toEqual(expect.any(String));

    const treeSlugs = await readProjectSlugs(treeDir);
    expect(treeSlugs).toContain('Second project');
    const appDataSlugs = await readProjectSlugs(dir).catch(() => []);
    expect(appDataSlugs).not.toContain('Second project');

    await service.close();
  });

  it('renaming a closed folder-share workspace rewrites the manifest in the tree', async () => {
    const { workspaceId, treeDir } = await seedFolderShare('Old name');

    await newService().rename(workspaceId, 'New name');

    const manifest = await readFile(join(treeDir, 'workspace.yaml'), 'utf8');
    expect(manifest).toContain('name: New name');
  });
});

async function readProjectSlugs(treeOrDir: string): Promise<string[]> {
  try {
    return await readdir(join(treeOrDir, 'projects'));
  } catch {
    return [];
  }
}
