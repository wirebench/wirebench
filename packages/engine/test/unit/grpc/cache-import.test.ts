import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import { readProtoDefinitionCache, writeProtoDefinitionCache, protoPathSegments } from '../../../src/grpc/cache.js';
import { importProto } from '../../../src/grpc/import.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-proto-'));
  dirs.push(dir);
  return dir;
}

describe('importProto', () => {
  it('makes a folder per service and a request per method, each seeded with a sample message', () => {
    let next = 0;
    const imported = importProto(readProtoFixture('greeter'), {
      roots: ['greeter.proto'],
      target: 'localhost:50051',
      newId: () => `id-${String(++next)}`,
      definition: { kind: 'proto', source: '/protos', cache: true, roots: ['greeter.proto'] },
    });
    expect(imported.api).toMatchObject({
      kind: 'grpc',
      name: 'wirebench.greet',
      target: 'localhost:50051',
      tls: false,
      id: 'id-9',
    });
    expect(imported.api.folders.map((folder) => folder.name)).toEqual(['Greeter']);
    const folder = imported.api.folders[0]!;
    expect(folder.description).toBe('Package `wirebench.greet`. Greets people, in every streaming shape.');
    expect(folder.requests.map((request) => [request.name, request.methodKind])).toEqual([
      ['SayHello', 'unary'],
      ['LotsOfReplies', 'server-streaming'],
      ['LotsOfGreetings', 'client-streaming'],
      ['Chat', 'bidi-streaming'],
      ['Fail', 'unary'],
      ['Slow', 'unary'],
      ['Deprecated', 'unary'],
    ]);
    const sayHello = folder.requests[0]!;
    expect(sayHello).toMatchObject({
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      description: 'Says hello once.',
    });
    expect(JSON.parse(sayHello.message)).toMatchObject({ name: '', tags: [''] });
    expect(folder.requests.at(-1)?.description).toBe('**Deprecated.**');
    expect(imported.summary).toEqual({ files: 9, services: 1, methods: 7, deprecated: 1 });
  });

  it('names an API after its first service when the file declares no package', () => {
    const imported = importProto(readProtoFixture('no-package'));
    expect(imported.api.name).toBe('Pinger');
    expect(imported.api.folders[0]?.description).toBeUndefined();
  });

  it('keeps folder slugs unique when two packages declare the same service name', () => {
    const sources = new Map([
      ['a.proto', 'syntax = "proto3"; package a; message M {} service Svc { rpc Do (M) returns (M); }'],
      ['b.proto', 'syntax = "proto3"; package b; message M {} service Svc { rpc Do (M) returns (M); }'],
    ]);
    const imported = importProto(sources, { name: 'Both' });
    expect(imported.api.folders.map((folder) => folder.slug)).toEqual(['Svc', 'Svc-2']);
  });
});

describe('the proto definition cache', () => {
  it('writes every file at its import path and reads them back verified', async () => {
    const dir = await tempDir();
    const sources = readProtoFixture('greeter');
    const manifest = await writeProtoDefinitionCache(sources, dir, {
      source: '/protos',
      roots: ['greeter.proto'],
      now: () => 'T',
    });
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: 'proto',
      source: '/protos',
      fetchedAt: 'T',
      roots: ['greeter.proto'],
    });
    expect(manifest.files.map((file) => file.path)).toEqual(['greeter.proto', 'wirebench/common/address.proto']);
    expect(await readFile(join(dir, 'protos', 'wirebench', 'common', 'address.proto'), 'utf8')).toBe(
      sources.get('wirebench/common/address.proto'),
    );
    const cached = await readProtoDefinitionCache(dir);
    expect(cached.manifest).toEqual(manifest);
    expect([...cached.sources.entries()]).toEqual([...sources.entries()].sort(([a], [b]) => a.localeCompare(b)));
  });

  it('replaces a previous cache and notices a tampered file', async () => {
    const dir = await tempDir();
    await writeProtoDefinitionCache(new Map([['old.proto', 'syntax = "proto3";']]), dir, {
      source: 's',
      roots: ['old.proto'],
    });
    await writeProtoDefinitionCache(new Map([['new.proto', 'syntax = "proto3";']]), dir, {
      source: 's',
      roots: ['new.proto'],
    });
    await expect(readFile(join(dir, 'protos', 'old.proto'))).rejects.toThrow();
    await writeFile(join(dir, 'protos', 'new.proto'), 'syntax = "proto2";');
    await expect(readProtoDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-corrupt' });
  });

  it('refuses an empty set, an unsafe path, a missing manifest, and a manifest of another kind', async () => {
    const dir = await tempDir();
    await expect(writeProtoDefinitionCache(new Map(), dir, { source: 's', roots: [] })).rejects.toBeInstanceOf(
      ProjectError,
    );
    await expect(
      writeProtoDefinitionCache(new Map([['../escape.proto', 'x']]), dir, { source: 's', roots: [] }),
    ).rejects.toMatchObject({ code: 'project-path-invalid' });
    expect(() => protoPathSegments('a//b.proto')).toThrow(ProjectError);
    await expect(readProtoDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-missing' });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.yaml'), 'formatVersion: 1\nrootLocation: x\nfetchedAt: t\ndocuments: []\n');
    await expect(readProtoDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });
});
