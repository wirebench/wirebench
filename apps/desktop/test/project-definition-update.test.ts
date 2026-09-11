// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectService } from '../src/main/project-service.js';
import { RecentProjects } from '../src/main/recent-projects.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

const craftedRoot = fileURLToPath(new URL('../../../fixtures/wsdl/crafted/', import.meta.url));

const v1Path = join(craftedRoot, 'versioned', 'v1', 'service.wsdl');
const v2Path = join(craftedRoot, 'versioned', 'v2', 'service.wsdl');

const DEFAULTS = {
  createNewRequests: true,
  recreateRequests: true,
  recreateOptional: false,
  keepExisting: true,
  keepSoapHeaders: true,
  createBackups: true,
  updateTestRequests: false as const,
};

let userData = '';
let projectDir = '';
let picks: DialogPicks;
let service: ProjectService;
let interfaceId = '';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `wirebench-${prefix}-`));
}

/** The request named `name` under the operation `operationName`, from a project snapshot. */
function requestOf(project: ProjectWire, operationName: string, name = 'Request 1') {
  return project.requests.find((request) => request.operationName === operationName && request.name === name);
}

beforeEach(async () => {
  userData = tempDir('userdata');
  projectDir = join(tempDir('projects'), 'Versioned');
  picks = new DialogPicks();
  service = new ProjectService(
    new EngineService(),
    new RecentProjects(userData),
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    picks,
  );
  await service.create({ dir: projectDir, name: 'Versioned' });
  // The v1 file is outside the project, so it needs the same dialog evidence a user would give.
  picks.rememberRead(v1Path);
  const added = await service.addInterface({ source: { kind: 'file', path: v1Path } });
  interfaceId = added.interfaceId;
});

afterEach(async () => {
  await service.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('ProjectService — Update Definition', () => {
  it('plans the v1 → v2 update without changing anything', async () => {
    picks.rememberRead(v2Path);
    const plan = await service.planDefinitionUpdate(interfaceId, { kind: 'file', path: v2Path });
    expect(plan.newOperations.map((ref) => ref.operationName)).toEqual(['Subtract']);
    expect(plan.removedOperations.map((ref) => ref.operationName)).toEqual(['Legacy']);
    expect(plan.changedOperations.map((changed) => changed.ref.operationName)).toEqual(['Echo']);
    expect(plan.endpointsAdded).toEqual(['http://example.invalid/versioned-alt']);
    // Planning is a preview: the project still describes v1.
    const snapshot = service.snapshot() as ProjectWire;
    expect(requestOf(snapshot, 'Subtract')).toBeUndefined();
    expect(requestOf(snapshot, 'Legacy')?.orphaned).toBeUndefined();
  });

  it('applies the update: new request, kept edit, orphan flag and a backup on disk', async () => {
    const before = service.snapshot() as ProjectWire;
    const echo = requestOf(before, 'Echo');
    expect(echo).toBeDefined();
    const edited = (echo?.envelopeXml ?? '').replace('<ver:text>?</ver:text>', '<ver:text>hello</ver:text>');
    expect(edited).toContain('hello');
    await service.mutate({ kind: 'update-request', requestId: echo?.id ?? '', patch: { envelopeXml: edited } });
    await service.save({ reason: 'test' });

    picks.rememberRead(v2Path);
    const applied = await service.applyDefinitionUpdate(interfaceId, { kind: 'file', path: v2Path }, DEFAULTS);

    expect(applied.requestsCreated).toHaveLength(1);
    expect(applied.requestsRecreated).toHaveLength(1);
    expect(applied.requestsOrphaned).toHaveLength(1);
    expect(applied.backups).toHaveLength(1);

    const after = service.snapshot() as ProjectWire;
    expect(requestOf(after, 'Subtract')?.envelopeXml).toContain('Subtract');
    // The edit survives, and the newly required element arrived with it.
    expect(requestOf(after, 'Echo')?.envelopeXml).toContain('hello');
    expect(requestOf(after, 'Echo')?.envelopeXml).toContain('lang');
    expect(requestOf(after, 'Echo')?.envelopeXml).not.toContain('note');
    expect(requestOf(after, 'Legacy')?.orphaned).toBe(true);
    expect(after.interfaces[0]?.definitionUrl).toContain('versioned/v2');

    const backup = applied.backups[0] ?? '';
    expect(backup.endsWith('.xml.bak')).toBe(true);
    expect(existsSync(join(projectDir, ...backup.split('/')))).toBe(true);
    expect(await readFile(join(projectDir, ...backup.split('/')), 'utf8')).toBe(edited);
  });

  it('inserts the new optional element when "Recreate optional elements" is set', async () => {
    picks.rememberRead(v2Path);
    await service.applyDefinitionUpdate(
      interfaceId,
      { kind: 'file', path: v2Path },
      { ...DEFAULTS, recreateOptional: true },
    );
    expect(requestOf(service.snapshot() as ProjectWire, 'Echo')?.envelopeXml).toContain('note');
  });

  it('writes no backup when "Create backups" is clear', async () => {
    picks.rememberRead(v2Path);
    const applied = await service.applyDefinitionUpdate(
      interfaceId,
      { kind: 'file', path: v2Path },
      { ...DEFAULTS, createBackups: false },
    );
    expect(applied.backups).toEqual([]);
  });

  it('refuses a file that was never picked and is outside the project', async () => {
    await expect(service.planDefinitionUpdate(interfaceId, { kind: 'file', path: v2Path })).rejects.toThrow(
      /outside the project/,
    );
  });

  it('refuses an interface the project does not have', async () => {
    await expect(service.planDefinitionUpdate('nope', { kind: 'file', path: v2Path })).rejects.toThrow(/nope/);
  });

  it('updates from a URL served over HTTP', async () => {
    const server: TestSoapServer = await startTestSoapServer({ fixture: 'versioned/v2' });
    try {
      const plan = await service.planDefinitionUpdate(interfaceId, { kind: 'url', url: server.wsdlUrl });
      expect(plan.newOperations.map((ref) => ref.operationName)).toEqual(['Subtract']);
    } finally {
      await server.close();
    }
  });
});

describe('ProjectService — Export Definition and documentation', () => {
  it('exports every document of the bundle into a folder', async () => {
    const target = tempDir('export');
    try {
      const files = await service.exportDefinitionTo(interfaceId, target);
      expect(files).toHaveLength(1);
      const written = await readFile(join(target, files[0] ?? ''), 'utf8');
      expect(written).toContain('VersionedService');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('renders documentation in both formats, titled with the interface name', () => {
    const html = service.definitionDocs(interfaceId, 'html');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>VersionedService</title>');
    expect(service.definitionDocs(interfaceId, 'markdown').startsWith('# VersionedService')).toBe(true);
  });

  it('refuses to export or document an interface the project does not have', async () => {
    await expect(service.exportDefinitionTo('nope', tempDir('export'))).rejects.toThrow(/nope/);
    expect(() => service.definitionDocs('nope', 'html')).toThrow(/nope/);
  });
});
