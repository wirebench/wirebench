// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, saveWorkspace, workspaceDir, workspaceProjectDir } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { readLeftoverProjectFolders } from '../src/main/workspace-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-leftover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRecent(content: string): void {
  writeFileSync(join(root, 'recent-projects.json'), content, 'utf8');
}

describe('readLeftoverProjectFolders', () => {
  it('returns nothing when there is no pre-workspace recent list', async () => {
    expect(await readLeftoverProjectFolders(root)).toEqual([]);
  });

  it("returns the listed folders that still exist, in the file's order", async () => {
    const payments = join(root, 'payments');
    const billing = join(root, 'billing');
    mkdirSync(payments);
    mkdirSync(billing);
    writeRecent(
      JSON.stringify({
        version: 1,
        entries: [
          { dir: billing, name: 'Billing', lastOpenedAt: '2026-09-10T00:00:00.000Z' },
          { dir: join(root, 'gone'), name: 'Gone', lastOpenedAt: '2026-09-09T00:00:00.000Z' },
          { dir: payments, name: 'Payments', lastOpenedAt: '2026-09-08T00:00:00.000Z' },
        ],
      }),
    );

    expect(await readLeftoverProjectFolders(root)).toEqual([billing, payments]);
  });

  it('treats a corrupt or wrongly shaped file as empty rather than failing the picker', async () => {
    writeRecent('{ not json');
    expect(await readLeftoverProjectFolders(root)).toEqual([]);
    writeRecent(JSON.stringify({ entries: 'nope' }));
    expect(await readLeftoverProjectFolders(root)).toEqual([]);
  });

  it('drops a folder that is already an internal project of some workspace', async () => {
    const workspace = createWorkspace('Team');
    const wsDir = workspaceDir(root, workspace.id);
    mkdirSync(wsDir, { recursive: true });
    const projectDir = workspaceProjectDir(wsDir, 'billing');
    mkdirSync(projectDir, { recursive: true });
    const host = new ProjectHost(new EngineService());
    const project = await host.create({ dir: projectDir, name: 'Billing' });
    await host.close();
    await saveWorkspace({ ...workspace, projects: [{ id: project.id, slug: 'billing', source: 'internal' }] }, wsDir);

    const payments = join(root, 'payments');
    mkdirSync(payments);
    writeRecent(
      JSON.stringify({
        version: 1,
        entries: [
          { dir: projectDir, name: 'Billing', lastOpenedAt: '2026-09-10T00:00:00.000Z' },
          { dir: payments, name: 'Payments', lastOpenedAt: '2026-09-08T00:00:00.000Z' },
        ],
      }),
    );

    // Billing is already a project of the "Team" workspace, so it is no longer offered as
    // something to import — only Payments, which is not in any workspace yet, is suggested.
    expect(await readLeftoverProjectFolders(root)).toEqual([payments]);
  });

  it('drops a folder that is already a linked project of some workspace', async () => {
    const workspace = createWorkspace('Team');
    const wsDir = workspaceDir(root, workspace.id);
    mkdirSync(wsDir, { recursive: true });
    const linked = join(root, 'elsewhere', 'linked-project');
    mkdirSync(linked, { recursive: true });
    await saveWorkspace(
      { ...workspace, projects: [{ id: 'linked-id', slug: 'linked-project', source: 'linked', path: linked }] },
      wsDir,
    );

    writeRecent(
      JSON.stringify({
        version: 1,
        entries: [{ dir: linked, name: 'Linked', lastOpenedAt: '2026-09-10T00:00:00.000Z' }],
      }),
    );

    expect(await readLeftoverProjectFolders(root)).toEqual([]);
  });
});
