// @vitest-environment node
/**
 * A gRPC API discovered from a running server, end to end in main: the descriptor cache it is
 * stored in, the schema that comes back out of it on reopen, the grpcurl export that names no
 * `.proto` files, and the refresh that asks the server again and reconciles the request tree.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { descriptorSetBytes, reflectProtoSet } from '@wirebench/engine';
import { startTestGrpcServer, type TestGrpcServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { ProtoImportService } from '../src/main/proto-import.js';

let server: TestGrpcServer;
let dirs: string[] = [];

beforeEach(async () => {
  server = await startTestGrpcServer({ reflection: ['v1'] });
});

afterEach(async () => {
  await server.close();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-grpc-reflect-'));
  dirs.push(dir);
  return dir;
}

/** Creates a project and places a gRPC API discovered from the test server in it. */
async function discoverInto(host: ProjectHost): Promise<string> {
  const run = await new ProtoImportService().run({
    source: { kind: 'reflection', target: server.target, tls: false },
    target: server.target,
  });
  if (run.kind !== 'reflection') {
    throw new Error('expected a reflection run');
  }
  const added = await host.addGrpcApi({
    api: run.imported.api,
    roots: run.roots,
    source: run.sourceLabel,
    kind: 'reflection',
    descriptors: run.descriptors,
    version: run.version,
    trustInvalid: run.trustInvalid,
  });
  return added.apiId;
}

describe('a gRPC API discovered from a running server', () => {
  it('caches the descriptor set, and records how it was obtained', async () => {
    const dir = join(tempDir(), 'Discovered');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'Discovered' });
    const apiId = await discoverInto(host);

    const api = host.snapshot()?.grpcApis.find((candidate) => candidate.id === apiId);
    expect(api?.definition).toMatchObject({
      kind: 'reflection',
      source: server.target,
      cache: true,
      reflectionVersion: 'auto',
    });
    const definitionDir = join(dir, 'apis', api!.slug, 'definition');
    expect(existsSync(join(definitionDir, 'descriptors.binpb'))).toBe(true);
    expect(existsSync(join(definitionDir, 'protos'))).toBe(false);
    const manifest = await readFile(join(definitionDir, 'manifest.yaml'), 'utf8');
    expect(manifest).toContain('kind: descriptors');
    expect(manifest).toContain('reflectionVersion: v1');
    await host.close();
  });

  it('loads its schema back from the cache when the project is reopened', async () => {
    const dir = join(tempDir(), 'Reopened');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'Reopened' });
    const apiId = await discoverInto(host);
    await host.close();

    const reopened = new ProjectHost(new EngineService(), {});
    await reopened.openProject(dir);
    const definition = await reopened.grpcDefinition(apiId);
    expect(definition.kind).toBe('reflection');
    expect(definition.reflectionVersion).toBe('v1');
    expect(definition.services.map((service) => service.fullName)).toEqual(['wirebench.greet.Greeter']);
    expect(definition.files.map((file) => file.path)).toEqual(['descriptors.binpb']);
    expect(await reopened.grpcSample(apiId, 'wirebench.greet.HelloRequest')).toContain('"name"');
    await reopened.close();
  });

  it('exports its definition as the descriptor set, since there is no .proto text to show', async () => {
    const dir = join(tempDir(), 'Exported');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'Exported' });
    const apiId = await discoverInto(host);

    const documents = await host.apiDefinitionDocuments(apiId);
    expect(documents.declaredVersion).toBe('descriptors');
    await expect(host.apiDefinitionText(apiId, 'descriptors.binpb')).rejects.toMatchObject({
      code: 'definition-not-text',
    });
    const out = tempDir();
    expect(await host.exportApiDefinitionTo(apiId, out)).toEqual(['descriptors.binpb']);
    expect(existsSync(join(out, 'descriptors.binpb'))).toBe(true);
    await host.close();
  });

  it('refreshes from the server, rewrites the cache and reconciles the tree', async () => {
    const dir = join(tempDir(), 'Refreshed');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'Refreshed' });
    const apiId = await discoverInto(host);
    const api = host.snapshot()!.grpcApis.find((candidate) => candidate.id === apiId)!;
    const cachePath = join(dir, 'apis', api.slug, 'definition', 'descriptors.binpb');
    const before = await readFile(cachePath);

    const refreshed = await host.refreshGrpcDefinition(apiId, { version: 'v1' });
    expect(refreshed.version).toBe('v1');
    expect(refreshed.summary.services).toBe(1);
    // The server describes the same schema, so nothing is added and nothing is orphaned.
    expect(refreshed.reconciled.requestsAdded).toEqual([]);
    expect(refreshed.reconciled.requestsOrphaned).toEqual([]);
    expect(new Uint8Array(await readFile(cachePath))).toEqual(new Uint8Array(before));
    const version = refreshed.project.grpcApis.find((candidate) => candidate.id === apiId)?.definition
      ?.reflectionVersion;
    expect(version).toBe('v1');
    await host.close();
  });

  it('refuses to refresh an API that was imported from files', async () => {
    const dir = join(tempDir(), 'Imported');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'Imported' });
    const run = await new ProtoImportService().run({
      source: {
        kind: 'text',
        text: 'syntax = "proto3";\npackage p;\nmessage M { string a = 1; }\n',
        filename: 'p.proto',
      },
    });
    if (run.kind !== 'proto') {
      throw new Error('expected a proto run');
    }
    const added = await host.addGrpcApi({
      api: run.imported.api,
      roots: run.roots,
      source: run.sourceLabel,
      kind: 'proto',
      sources: run.sources,
    });
    await expect(host.refreshGrpcDefinition(added.apiId)).rejects.toMatchObject({
      code: 'definition-not-discovered',
    });
    await host.close();
  });

  it('keeps the cached descriptors byte-identical to what the server sent', async () => {
    const dir = join(tempDir(), 'ByteExact');
    const host = new ProjectHost(new EngineService(), {});
    await host.create({ dir, name: 'ByteExact' });
    const apiId = await discoverInto(host);
    const api = host.snapshot()!.grpcApis.find((candidate) => candidate.id === apiId)!;

    const discovered = await reflectProtoSet({
      target: server.target,
      tls: false,
      metadata: [],
      timeoutMs: 5_000,
      version: 'v1',
    });
    const onDisk = await readFile(join(dir, 'apis', api.slug, 'definition', 'descriptors.binpb'));
    expect(new Uint8Array(onDisk)).toEqual(descriptorSetBytes(discovered.files));
    await host.close();
  });
});
