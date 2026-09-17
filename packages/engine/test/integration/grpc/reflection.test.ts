/**
 * Server reflection against a real HTTP/2 gRPC server in this process: both protocol versions, the
 * automatic fallback between them, a server that leaves its transitive dependencies to be chased by
 * name, and one that serves no reflection at all.
 *
 * The descriptors the server answers with are produced by protobufjs's own `toDescriptor` rather
 * than by the client's code, so what is proved here is that the client reads a second, independent
 * rendering of the `greeter` fixture — and that what comes out builds the same API an import of the
 * same fixture builds. That rendering names its files by package (`wirebench_greet.proto`) rather
 * than by the fixture's paths, which is the test server's business and not the client's: nothing in
 * the protocol ties a descriptor's name to a path on disk.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrpcError } from '../../../src/errors.js';
import { callGrpc } from '../../../src/grpc/call.js';
import { apiFromProtoSet, importProto } from '../../../src/grpc/import.js';
import { reflectProtoSet, reflectServices } from '../../../src/grpc/reflection/client.js';
import type { GrpcReflectInput } from '../../../src/grpc/reflection/client.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { startTestGrpcServer, type TestGrpcServer } from '../../helpers/test-grpc-server.js';

const GREETER = 'wirebench.greet.Greeter';

let both: TestGrpcServer;
let alphaOnly: TestGrpcServer;
let silent: TestGrpcServer;

beforeAll(async () => {
  [both, alphaOnly, silent] = await Promise.all([
    startTestGrpcServer({ reflection: ['v1', 'v1alpha'] }),
    startTestGrpcServer({ reflection: ['v1alpha'] }),
    startTestGrpcServer(),
  ]);
});

afterAll(async () => {
  await Promise.all([both.close(), alphaOnly.close(), silent.close()]);
});

function input(server: TestGrpcServer, overrides: Partial<GrpcReflectInput> = {}): GrpcReflectInput {
  return { target: server.target, tls: false, metadata: [], timeoutMs: 5_000, ...overrides };
}

describe('reflectServices', () => {
  it('lists the services a server exposes, reflection itself excluded', async () => {
    const result = await reflectServices(input(both));
    expect(result.version).toBe('v1');
    expect(result.services).toEqual([GREETER]);
    expect(result.missing).toEqual([]);
    expect(result.roots).toEqual(['wirebench_greet.proto']);
    expect([...result.files.keys()]).toContain('wirebench_common.proto');
  });

  it('asks only for the reflection version the caller pinned', async () => {
    const result = await reflectServices(input(both, { version: 'v1alpha' }));
    expect(result.version).toBe('v1alpha');
    expect(result.services).toEqual([GREETER]);
    expect(both.calls.map((call) => call.path)).toContain(
      '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
    );
  });

  it('falls back to v1alpha when the server does not serve v1', async () => {
    const result = await reflectServices(input(alphaOnly));
    expect(result.version).toBe('v1alpha');
    expect(result.services).toEqual([GREETER]);
  });

  it('chases a dependency the server did not volunteer', async () => {
    const server = await startTestGrpcServer({ reflection: ['v1'], reflectionOmitsDependencies: true });
    try {
      const result = await reflectServices(input(server));
      expect(result.missing).toEqual([]);
      expect([...result.files.keys()]).toContain('wirebench_common.proto');
      // greeter.proto first, then one round per depth of the import graph.
      expect(server.calls.length).toBeGreaterThan(2);
    } finally {
      await server.close();
    }
  });

  it('stops chasing dependencies at the round cap', async () => {
    const server = await startTestGrpcServer({ reflection: ['v1'], reflectionOmitsDependencies: true });
    try {
      const result = await reflectServices(input(server, { maxRounds: 0 }));
      expect(result.missing.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('fails with grpc-reflection-unsupported when the server serves no reflection', async () => {
    await expect(reflectServices(input(silent))).rejects.toMatchObject({ code: 'grpc-reflection-unsupported' });
  });

  it('reports a pinned version the server does not serve', async () => {
    await expect(reflectServices(input(alphaOnly, { version: 'v1' }))).rejects.toMatchObject({
      code: 'grpc-reflection-unsupported',
    });
  });

  it('sends the metadata and credentials a call would', async () => {
    const before = both.calls.length;
    await reflectServices(
      input(both, {
        version: 'v1',
        metadata: [{ name: 'x-tenant', value: 'acme', enabled: true }],
        auth: { type: 'bearer', token: 'secret' },
      }),
    );
    const call = both.calls[before];
    expect(call?.headers['x-tenant']).toBe('acme');
    expect(call?.headers['authorization']).toBe('Bearer secret');
  });
});

describe('reflectProtoSet', () => {
  it('builds the same API an import of the same files builds', async () => {
    const discovered = await reflectProtoSet(input(both, { version: 'v1' }));
    const fromReflection = apiFromProtoSet(discovered.set, { name: 'greeter', target: both.target });
    const fromFiles = importProto(readProtoFixture('greeter'), {
      roots: ['greeter.proto'],
      name: 'greeter',
      target: both.target,
    });
    const shape = (api: typeof fromFiles.api): unknown =>
      api.folders.map((folder) => ({ name: folder.name, methods: folder.requests.map((request) => request.method) }));
    expect(shape(fromReflection.api)).toEqual(shape(fromFiles.api));
    expect(fromReflection.summary.services).toBe(fromFiles.summary.services);
    expect(fromReflection.summary.methods).toBe(fromFiles.summary.methods);
  });

  it('calls a method the schema it discovered describes', async () => {
    const discovered = await reflectProtoSet(input(both, { version: 'v1' }));
    const result = await callGrpc({
      set: discovered.set,
      target: both.target,
      tls: false,
      service: GREETER,
      method: 'SayHello',
      messageText: '{"name":"discovered"}',
      metadata: [],
      timeoutMs: 5_000,
    });
    expect(result.exchange.status).toBe(0);
    expect(result.responseMessages[0]?.json).toMatchObject({ message: 'Hello, discovered' });
  });

  it('names the files a server withheld when the set does not resolve', async () => {
    const server = await startTestGrpcServer({ reflection: ['v1'], reflectionOmitsDependencies: true });
    try {
      await expect(reflectProtoSet(input(server, { maxRounds: 0 }))).rejects.toMatchObject({
        code: 'grpc-reflection-incomplete',
      });
    } finally {
      await server.close();
    }
  });

  it('is a GrpcError, so a caller can branch on the code', async () => {
    const error = await reflectServices(input(silent)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GrpcError);
  });
});
