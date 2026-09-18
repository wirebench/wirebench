// @vitest-environment node
/**
 * The reflection source of the `.proto` import service in main: a running server asked to describe
 * itself produces the same API an import of files produces, carries the descriptors the cache will
 * hold, and reports progress under the import's own token so the dialog's cancel still works.
 */
import { describe, expect, it } from 'vitest';
import { startTestGrpcServer, type TestGrpcServer } from '@wirebench/engine/test-helpers';
import { protoSetFromDescriptorSet } from '@wirebench/engine';
import { ProtoImportService } from '../src/main/proto-import.js';
import type { EngineProgressEvent } from '../src/shared/wire-types.js';

async function withServer<T>(
  options: Parameters<typeof startTestGrpcServer>[0],
  run: (server: TestGrpcServer) => Promise<T>,
): Promise<T> {
  const server = await startTestGrpcServer(options);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

describe('ProtoImportService, from a running server', () => {
  it('discovers the services a server exposes and names the API after their package', async () => {
    await withServer({ reflection: ['v1'] }, async (server) => {
      const service = new ProtoImportService();
      const progress: EngineProgressEvent[] = [];
      const run = await service.run(
        { source: { kind: 'reflection', target: server.target, tls: false }, token: 't1', target: server.target },
        { onProgress: (event) => progress.push(event) },
      );
      expect(run.kind).toBe('reflection');
      expect(run.imported.api.name).toBe('wirebench.greet');
      expect(run.imported.api.target).toBe(server.target);
      expect(run.imported.summary.services).toBe(1);
      expect(run.imported.summary.methods).toBeGreaterThan(0);
      expect(run.sourceLabel).toBe(server.target);
      expect(progress.map((event) => event.token)).toEqual(progress.map(() => 't1'));
      expect(progress.at(-1)?.phase).toBe('done');
      expect(progress.at(-1)?.message).toContain('Discovered');
    });
  });

  it('carries descriptors that resolve back into the same schema', async () => {
    await withServer({ reflection: ['v1'] }, async (server) => {
      const run = await new ProtoImportService().run({
        source: { kind: 'reflection', target: server.target, tls: false },
      });
      if (run.kind !== 'reflection') {
        throw new Error('expected a reflection run');
      }
      const set = protoSetFromDescriptorSet(run.descriptors, { roots: run.roots });
      expect(set.root.lookupService('wirebench.greet.Greeter').methodsArray.length).toBeGreaterThan(0);
      expect(run.version).toBe('v1');
      expect(run.trustInvalid).toBe(false);
    });
  });

  it('falls back to v1alpha, and records the version that answered', async () => {
    await withServer({ reflection: ['v1alpha'] }, async (server) => {
      const run = await new ProtoImportService().run({
        source: { kind: 'reflection', target: server.target, tls: false },
      });
      expect(run.kind === 'reflection' && run.version).toBe('v1alpha');
    });
  });

  it('honours a pinned version, and reports a server that does not serve it', async () => {
    await withServer({ reflection: ['v1alpha'] }, async (server) => {
      await expect(
        new ProtoImportService().run({
          source: { kind: 'reflection', target: server.target, tls: false, version: 'v1' },
        }),
      ).rejects.toMatchObject({ code: 'grpc-reflection-unsupported' });
    });
  });

  it('reports a server that serves no reflection at all', async () => {
    await withServer({}, async (server) => {
      await expect(
        new ProtoImportService().run({ source: { kind: 'reflection', target: server.target, tls: false } }),
      ).rejects.toMatchObject({ code: 'grpc-reflection-unsupported' });
    });
  });

  it('asks for the TLS material main resolved, and remembers the trust decision', async () => {
    await withServer({ reflection: ['v1'] }, async (server) => {
      const asked: { trustInvalid: boolean }[] = [];
      const service = new ProtoImportService({
        grpcTls: (options) => {
          asked.push(options);
          return Promise.resolve(undefined);
        },
      });
      const run = await service.run({
        source: { kind: 'reflection', target: server.target, tls: false, trustInvalid: true },
      });
      expect(asked).toEqual([{ trustInvalid: true }]);
      expect(run.kind === 'reflection' && run.trustInvalid).toBe(true);
    });
  });

  it('cancels a discovery by its token', async () => {
    await withServer({ reflection: ['v1'] }, async (server) => {
      const service = new ProtoImportService({
        grpcTls: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(undefined), 50);
          }),
      });
      const running = service.run({
        source: { kind: 'reflection', target: server.target, tls: false },
        token: 'cancel-me',
      });
      expect(service.cancel('cancel-me')).toEqual({ cancelled: true });
      await expect(running).rejects.toThrow();
    });
  });
});
