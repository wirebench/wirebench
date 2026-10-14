// @vitest-environment node
/**
 * Kind modules spec §7: a kind switched off with `WIREBENCH_KINDS` loads its containers as
 * placeholders, which the desktop shows and never rewrites (§7.4), and a container of a kind the
 * desktop has no half of is a placeholder too (§7.1).
 */
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createProject } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { enabledKindsFromEnv, kindRegistry } from '../src/main/kinds/enabled-kinds.js';
import { ProjectHost } from '../src/main/project-host.js';
import { toProjectWire } from '../src/main/project-wire.js';

function newHost(): ProjectHost {
  return new ProjectHost(new EngineService(), {});
}

/** Every file under `dir`, by path relative to it, with its bytes. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = (await readFile(path)).toString('base64');
  }
  return out;
}

describe('WIREBENCH_KINDS', () => {
  it('switches off the kinds it names, and ignores anything else', () => {
    expect(enabledKindsFromEnv({ WIREBENCH_KINDS: 'grpc=off, websocket=OFF, nonsense, rest=maybe' })).toEqual([
      'soap',
      'rest',
      'mcp',
    ]);
    expect(enabledKindsFromEnv({})).toEqual(['soap', 'rest', 'grpc', 'websocket', 'mcp']);
  });

  it('builds an engine registry with those kinds off', () => {
    const registry = kindRegistry(['soap', 'rest']);
    expect(registry.status('grpc')).toBe('disabled');
    expect(registry.status('websocket')).toBe('disabled');
    expect(registry.status('rest')).toBe('enabled');
  });

  it('switches MCP off like any other kind (#79)', () => {
    expect(enabledKindsFromEnv({}).includes('mcp')).toBe(true);
    const enabled = enabledKindsFromEnv({ WIREBENCH_KINDS: 'mcp=off' });
    expect(enabled).not.toContain('mcp');
    expect(kindRegistry(enabled).status('mcp')).toBe('disabled');
  });
});

describe('a project with a kind switched off', () => {
  it('shows its containers as placeholders and never rewrites them, with no global set (§7.4)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wirebench-placeholders-')), 'Mixed');
    const seed = newHost();
    await seed.create({ dir, name: 'Mixed' });
    await seed.kind('grpc').importGrpcApi({ api: createGrpcApi('Pets', { target: 'localhost:50051' }) });
    await seed.close();
    const grpcDir = join(dir, 'apis', 'Pets');
    const before = await filesUnder(grpcDir);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    // No global: the host is handed the run's registry, as the app's workspace hands it.
    const enabledKinds = ['soap', 'rest', 'websocket'] as const;
    const host = new ProjectHost(new EngineService(), { enabledKinds, registry: kindRegistry(enabledKinds) });
    const opened = await host.openProject(dir);
    expect(opened.grpcApis).toEqual([]);
    expect(opened.unsupported).toEqual([
      expect.objectContaining({ dir: 'apis', slug: 'Pets', kind: 'grpc', reason: 'feature-disabled', name: 'Pets' }),
    ]);

    // Every kind of change on another container, each saved, leaves the placeholder's files alone.
    const api = await host.mutate({ kind: 'add-api', name: 'Shop', baseUrl: 'https://shop.test' });
    const apiId = api.createdId ?? '';
    await host.save({ reason: 'add-api' });
    const folder = await host.mutate({ kind: 'add-folder', apiId, name: 'Orders' });
    await host.save({ reason: 'add-folder' });
    await host.mutate({ kind: 'add-rest-request', apiId, parentId: folder.createdId ?? '', name: 'List' });
    await host.save({ reason: 'add-rest-request' });
    await host.mutate({ kind: 'update-api', apiId, patch: { name: 'Shop 2' } });
    await host.save({ reason: 'update-api' });
    await host.mutate({ kind: 'rename-project', name: 'Mixed 2' });
    await host.save({ reason: 'rename-project' });
    await host.close();

    expect(await filesUnder(grpcDir)).toEqual(before);

    // Nothing was set process-wide: a host given no registry opens the same folder with gRPC on.
    const unswitched = newHost();
    expect((await unswitched.openProject(dir)).grpcApis.map((api) => api.name)).toEqual(['Pets']);
    await unswitched.close();
  });
});

describe('a container of a kind the desktop has no half of', () => {
  it('is a placeholder on the wire, unknown-kind', () => {
    const project = {
      ...createProject('Unknown'),
      containers: { graphql: [{ kind: 'graphql', id: 'g1', name: 'Graph', slug: 'graph', order: 2 }] },
    };
    const wire = toProjectWire(project, {
      dir: '/p',
      dirty: false,
      problems: [],
      runtime: new Map(),
    });
    expect(wire.unsupported).toEqual([
      { dir: 'apis', slug: 'graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph', order: 2 },
    ]);
  });
});
