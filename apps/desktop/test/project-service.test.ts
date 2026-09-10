// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectService } from '../src/main/project-service.js';
import { RecentProjects } from '../src/main/recent-projects.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

let server: TestSoapServer | undefined;
let root: string | undefined;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `wirebench-${prefix}-`));
}

/** A service wired to its own engine, over a shared `userData` directory for the recent list. */
function newService(userDataDir: string): ProjectService {
  return new ProjectService(new EngineService(), new RecentProjects(userDataDir));
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  root = tempDir('userdata');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('ProjectService', () => {
  it('creates, imports, mutates, saves and reopens a project from disk', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Calculator Project');
    const service = newService(userData);

    // --- create -------------------------------------------------------------
    const created = await service.create({ dir, name: 'Calculator Project' });
    expect(created.name).toBe('Calculator Project');
    expect(created.dir).toBe(dir);
    expect(created.dirty).toBe(false);
    expect(existsSync(join(dir, 'wirebench.yaml'))).toBe(true);

    // A second create into the same, now non-empty folder is refused.
    await expect(newService(userData).create({ dir, name: 'Again' })).rejects.toThrow(/not empty/);

    // --- import -------------------------------------------------------------
    const { project: afterImport, interfaceId } = await service.addInterface({
      source: { kind: 'url', url: server!.wsdlUrl },
    });
    expect(afterImport.interfaces).toHaveLength(1);
    const iface = afterImport.interfaces[0]!;
    expect(iface.id).toBe(interfaceId);
    expect(iface.hydration).toBe('ready');
    expect(iface.endpoints.length).toBeGreaterThan(0);
    expect(iface.operations.map((op) => op.name)).toContain('Add');

    // One `Request 1` per operation, each with a generated envelope.
    expect(afterImport.requests.length).toBe(iface.operations.length);
    expect(new Set(afterImport.requests.map((request) => request.name))).toEqual(new Set(['Request 1']));
    const add = afterImport.requests.find((request) => request.operationName === 'Add')!;
    expect(add.envelopeXml).toContain('intA');
    // The interface's default endpoint is pre-selected, so the request is sendable at once.
    expect(add.endpointId).toBe(iface.defaultEndpointId);

    // --- on-disk layout -----------------------------------------------------
    const interfaceRoot = join(dir, 'interfaces', iface.slug);
    expect(existsSync(join(interfaceRoot, 'interface.yaml'))).toBe(true);
    expect(existsSync(join(interfaceRoot, 'definition', 'manifest.yaml'))).toBe(true);
    const addDir = join(interfaceRoot, 'operations', 'Add');
    // Two bindings expose `Add`, so the second operation folder is slug-disambiguated; the
    // first still holds exactly the two files one request occupies.
    expect((await readdir(addDir)).sort()).toEqual(['Request 1.request.yaml', 'Request 1.xml']);
    expect(await readFile(join(addDir, 'Request 1.xml'), 'utf8')).toContain('intA');

    // --- mutate + save ------------------------------------------------------
    const renamed = await service.mutate({ kind: 'rename-project', name: 'Renamed Project' });
    expect(renamed.project.name).toBe('Renamed Project');
    expect(renamed.project.dirty).toBe(true);

    const saved = await service.save({ reason: 'test' });
    expect(saved.saved).toBe(true);
    expect(saved.written).toBeGreaterThan(0);
    expect(service.snapshot()?.dirty).toBe(false);

    const reloaded = await loadProject(dir);
    expect(reloaded.project.name).toBe('Renamed Project');
    expect(reloaded.problems).toEqual([]);

    // --- recent list --------------------------------------------------------
    const recent = await service.recentProjects();
    expect(recent[0]).toMatchObject({ dir, exists: true });

    await service.close();
    expect(service.snapshot()).toBeNull();

    // --- reopen, offline ----------------------------------------------------
    // The definition cache is the whole point of writing it: a fresh service must hydrate
    // without the origin server, so this closes it first.
    await server!.close();
    server = undefined;

    const reopened = newService(userData);
    const opened: ProjectWire = await reopened.openProject(dir);
    expect(opened.name).toBe('Renamed Project');
    expect(opened.requests.find((request) => request.operationName === 'Add')?.envelopeXml).toContain('intA');

    await reopened.whenHydrated();
    const hydrated = reopened.snapshot()!;
    expect(hydrated.interfaces[0]?.hydration).toBe('ready');
    expect(hydrated.problems).toEqual([]);
    // Hydration is what makes generating another request work after a restart.
    // The calculator fixture exposes `Add` on both a SOAP 1.1 and a SOAP 1.2 binding, so the
    // binding has to be part of the identity here as well as in the model.
    const addBinding = hydrated.interfaces[0]!.operations.find((op) => op.name === 'Add')!.binding;
    const another = await reopened.mutate({
      kind: 'add-request',
      interfaceId: hydrated.interfaces[0]!.id,
      bindingName: addBinding,
      operationName: 'Add',
    });
    expect(another.createdRequestId).toBeDefined();
    expect(
      another.project.requests
        .filter((r) => r.operationName === 'Add' && r.bindingName === addBinding)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Request 1', 'Request 2']);

    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('records a hydration failure as a problem rather than failing the open', async () => {
    const userData = root!;
    const dir = join(tempDir('project'), 'Broken');
    const service = newService(userData);
    await service.create({ dir, name: 'Broken' });
    const { project } = await service.addInterface({ source: { kind: 'url', url: server!.wsdlUrl } });
    const slug = project.interfaces[0]!.slug;
    await service.close();

    // Remove the cache, then take the origin away: hydration now has nowhere to read from,
    // but the interface (and its saved requests) are still on disk.
    rmSync(join(dir, 'interfaces', slug, 'definition'), { recursive: true, force: true });
    await server!.close();
    server = undefined;

    const reopened = newService(userData);
    const opened = await reopened.openProject(dir);
    expect(opened.interfaces).toHaveLength(1);
    expect(opened.interfaces[0]?.hydration).toBe('pending');

    await reopened.whenHydrated();
    const after = reopened.snapshot()!;
    expect(after.interfaces[0]?.hydration).toBe('failed');
    expect(after.problems.map((problem) => problem.code)).toContain('hydration-failed');
    // The requests themselves survive: only generating new ones needs the definition.
    expect(after.requests.length).toBeGreaterThan(0);

    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
