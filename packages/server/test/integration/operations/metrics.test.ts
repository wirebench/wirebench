/**
 * Slice 5 Task 13 (hosted edition spec §20.8): the metrics of a started server, collected into an in-memory reader.
 * The resource names the process by its holder; the instance count, the bus's dropped payloads and both pools' waiting
 * requests are read at collection; requests record their route template; the attribute sweep is clean; and a
 * shutdown stops the SDK.
 */
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { POOL, ROUTE, TENANT } from '../../../src/operations/metrics/attributes.js';
import { INSTRUMENTS } from '../../../src/operations/metrics/instruments.js';
import { startServer } from '../../../src/serve.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { collect, sweep, TestReader } from '../../helpers/metrics.js';
import { freePort } from '../../helpers/net.js';

describeDb('a started server’s metrics (hosted spec §20.8)', () => {
  it('names the process by its holder and records the server-wide instruments with only the closed attributes', async () => {
    const db = await testDatabase();
    const dataDir = await mkTempDir();
    const port = await freePort();
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(port),
    };
    const modules = BUILTIN_MODULES.map((m) => ({
      name: m.name,
      ...(m.migrationsDir !== undefined ? { migrationsDir: m.migrationsDir } : {}),
      register: () => Promise.resolve(),
    }));
    const reader = new TestReader();
    const server = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules,
        logStream: new Writable({ write: (_chunk, _encoding, done) => done() }),
        metricsReader: reader,
      },
    );
    try {
      expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${String(port)}/api/v1/meta?token=s3cret`)).status).toBe(200);
      const { resource, points } = await collect(reader);
      expect(resource.attributes['service.instance.id']).toBe(server.ctx.instance.holder);
      expect(resource.attributes['service.name']).toBe('wirebench-server');
      expect(sweep(points)).toEqual([]);
      // Its own row, at least: other files' servers may share the schema's instance table.
      expect(points.get(INSTRUMENTS.instances)![0]!.value).toBeGreaterThanOrEqual(1);
      expect(points.get(INSTRUMENTS.busDropped)![0]!.value).toBe(0);
      expect(points.get(INSTRUMENTS.dbPoolWaiting)!.map((p) => p.attributes[POOL])).toEqual(['app', 'lock']);
      const routes = points.get(INSTRUMENTS.httpRequests)!.map((p) => [p.attributes[ROUTE], p.attributes[TENANT]]);
      expect(routes).toEqual(
        expect.arrayContaining([
          ['/healthz', 'none'],
          ['/api/v1/meta', expect.stringMatching(/^[0-9a-f-]{36}$/)],
        ]),
      );
    } finally {
      await server.close();
      await removeTempDir(dataDir);
      await db.close();
    }
    // The provider is shut down with the server: the reader collects no more.
    await expect(reader.collect()).rejects.toThrow();
  });
});
