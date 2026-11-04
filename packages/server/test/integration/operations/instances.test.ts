/**
 * Slice 5 Task 2 (hosted edition spec §20.1, §20.2, §20.10): the instance row and its heartbeat, the Enterprise rule
 * for several self-hosted instances, the start-up lease delete in `single` only, and `admin instances`.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicenseState } from '@wirebench/engine';
import { permissiveLicense, type ServerModule } from '../../../src/context.js';
import { packageVersion } from '../../../src/io.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { DEAD_MS, HEARTBEAT_MS, InstanceRegistry } from '../../../src/operations/instances.js';
import { startServer, StartupError, type RunningServer } from '../../../src/serve.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';
import { manualTimers } from '../../helpers/timers.js';

/** Every built-in module's migrations, and none of its routes; `licensing` installs `license` when given. */
const modulesWith = (license?: Pick<LicenseState, 'edition' | 'status'>): readonly ServerModule[] =>
  BUILTIN_MODULES.map((m) => ({
    name: m.name,
    ...(m.migrationsDir !== undefined ? { migrationsDir: m.migrationsDir } : {}),
    register: (_app, ctx) => {
      if (m.name === 'licensing' && license !== undefined) {
        const base = permissiveLicense();
        ctx.license = {
          ...base,
          state: () =>
            Promise.resolve({
              edition: license.edition,
              status: license.status,
              seats: { used: 0, limit: null },
              features: [],
            }),
        };
      }
      return Promise.resolve();
    },
  }));

describeDb('server instances (hosted spec §20.1, §20.2, §20.10)', () => {
  let db: TestDatabase;
  let dataDirs: string[];
  beforeEach(async () => {
    db = await testDatabase();
    dataDirs = [];
  });
  afterEach(async () => {
    await db.close();
    for (const dir of dataDirs) await removeTempDir(dir);
  });

  const rows = async () =>
    (
      await db.query<{ holder: string; url: string | null; version: string; fresh: boolean }>(
        `select holder::text as holder, url, version, renewed_at > now() - interval '5 seconds' as fresh
           from server_instances order by started_at, holder`,
      )
    ).rows;

  const registry = (holder = randomUUID(), extra: { mode?: 'single' | 'multi'; log?: (m: string) => void } = {}) => {
    const timers = manualTimers();
    const made = new InstanceRegistry({
      db,
      holder,
      mode: extra.mode ?? 'single',
      url: 'http://10.0.0.5:8091',
      version: '6.2.0-test',
      setTimer: timers.setTimer,
      log: (message) => extra.log?.(message),
    });
    return { registry: made, timers };
  };

  describe('the registry', () => {
    it('inserts its row at start, renews it on the heartbeat, and deletes it on stop', async () => {
      const { registry: one, timers } = registry();
      await one.start();
      expect(await rows()).toEqual([{ holder: one.holder, url: null, version: '6.2.0-test', fresh: true }]);
      expect(timers.pending(HEARTBEAT_MS)).toBe(1);
      await db.owner.query(`update server_instances set renewed_at = now() - interval '40 seconds'`);
      expect((await rows())[0]!.fresh).toBe(false);
      // The timer's beat re-arms at once; its renew runs as `renew` does.
      expect(timers.fire(HEARTBEAT_MS)).toBe(1);
      expect(timers.pending(HEARTBEAT_MS)).toBe(1);
      await vi.waitFor(async () => {
        expect((await rows())[0]!.fresh).toBe(true);
      });
      await one.stop();
      expect(await rows()).toEqual([]);
      expect(timers.pending(HEARTBEAT_MS)).toBe(0);
    });

    it('stores its address in multi only', async () => {
      const { registry: one } = registry(randomUUID(), { mode: 'multi' });
      await one.start();
      expect((await rows())[0]!.url).toBe('http://10.0.0.5:8091');
      await one.stop();
    });

    it('sweeps a dead instance’s row on another instance’s renew, and lists only live rows', async () => {
      const { registry: one } = registry();
      const { registry: other } = registry();
      await one.start();
      await other.start();
      // `other` died 61 s ago without its shutdown; a third is late but alive.
      const late = randomUUID();
      await db.query(`insert into server_instances (holder, version) values ($1::uuid, 'old')`, [late]);
      await db.owner.query(
        `update server_instances set renewed_at = now() - make_interval(secs => $2) where holder = $1::uuid`,
        [other.holder, DEAD_MS / 1000 + 1],
      );
      await db.owner.query(
        `update server_instances set renewed_at = now() - interval '30 seconds' where holder = $1::uuid`,
        [late],
      );
      expect((await one.live()).map((row) => row.holder).sort()).toEqual([one.holder, late].sort());
      expect((await rows()).map((row) => row.holder)).toContain(other.holder);
      await one.renew();
      expect((await rows()).map((row) => row.holder).sort()).toEqual([one.holder, late].sort());
      const listed = await one.live();
      expect(listed.find((row) => row.holder === one.holder)).toMatchObject({
        url: null,
        version: '6.2.0-test',
        renewedSecondsAgo: 0,
      });
      await one.stop();
    });

    it('runs every listener on a beat, a failing one logged, and the row renewed regardless', async () => {
      const logged: string[] = [];
      const { registry: one } = registry(randomUUID(), { log: (m) => logged.push(m) });
      const beats: string[] = [];
      one.onBeat(() => Promise.reject(new Error('listener down')));
      one.onBeat(() => {
        beats.push('leases');
        return Promise.resolve();
      });
      await one.start();
      await db.owner.query(`update server_instances set renewed_at = now() - interval '40 seconds'`);
      await one.renew();
      expect(beats).toEqual(['leases']);
      expect(logged).toEqual(['a heartbeat listener failed']);
      expect((await rows())[0]!.fresh).toBe(true);
      await one.stop();
    });

    it('puts its row back when another instance swept it while this one was cut off', async () => {
      const { registry: one } = registry();
      await one.start();
      await db.query('delete from server_instances');
      await one.renew();
      expect((await rows()).map((row) => row.holder)).toEqual([one.holder]);
      await one.stop();
    });
  });

  describe('the start-up', () => {
    const start = async (extra: {
      readonly env?: Record<string, string>;
      readonly license?: Pick<LicenseState, 'edition' | 'status'>;
      readonly lines?: string[];
    }): Promise<RunningServer> => {
      const dataDir = await mkTempDir();
      dataDirs.push(dataDir);
      const env = {
        WIREBENCH_SERVER_DATABASE_URL: db.url,
        WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: dataDir,
        WIREBENCH_SERVER_HOST: '127.0.0.1',
        WIREBENCH_SERVER_PORT: String(await freePort()),
        WIREBENCH_SERVER_LOG_LEVEL: 'info',
        ...extra.env,
      };
      const logStream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          extra.lines?.push(chunk.toString('utf8'));
          done();
        },
      });
      return startServer(
        env,
        { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
        { signals: new EventEmitter(), exit: vi.fn(), logStream, modules: modulesWith(extra.license) },
      );
    };
    /** A `multi` server's variables, its internal listener on a port of its own (spec §20.6). */
    const multi = async (): Promise<Record<string, string>> => ({
      WIREBENCH_SERVER_INSTANCES: 'multi',
      WIREBENCH_SERVER_INSTANCE_URL: `http://127.0.0.1:${String(await freePort())}`,
      WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    });

    it('a single server writes its row under the holder modules see, and deletes it on close', async () => {
      const server = await start({});
      try {
        expect(await rows()).toEqual([
          { holder: server.ctx.instance.holder, url: null, version: packageVersion(), fresh: true },
        ]);
        expect(server.ctx.instance.mode).toBe('single');
      } finally {
        await server.close();
      }
      expect(await rows()).toEqual([]);
    });

    it.each([
      ['Community', { edition: 'community', status: 'none' }],
      ['Team', { edition: 'team', status: 'active' }],
      ['an expired Enterprise license', { edition: 'enterprise', status: 'expired' }],
    ] as const)('refuses multi on %s with server-instances-need-enterprise, writing no row', async (_name, license) => {
      const failed = await start({ env: await multi(), license }).then(
        async (server) => {
          await server.close();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(StartupError);
      expect((failed as StartupError).exitCode).toBe(2);
      expect((failed as StartupError).message).toMatch(/^server-instances-need-enterprise: /);
      expect((failed as StartupError).message).toContain(`${license.edition} (${license.status})`);
      expect(await rows()).toEqual([]);
    });

    it.each([
      ['valid', 'active'],
      ['in grace', 'grace'],
    ] as const)('accepts multi on an Enterprise license %s, its row carrying its address', async (_name, status) => {
      const env = await multi();
      const server = await start({ env, license: { edition: 'enterprise', status } });
      try {
        expect(server.ctx.instance.mode).toBe('multi');
        expect(await rows()).toEqual([
          {
            holder: server.ctx.instance.holder,
            url: env.WIREBENCH_SERVER_INSTANCE_URL,
            version: packageVersion(),
            fresh: true,
          },
        ]);
      } finally {
        await server.close();
      }
    });

    it('a multi server listens on its instance URL for /internal/v1/* only, until it closes (spec §20.6)', async () => {
      const env = await multi();
      const internal = env.WIREBENCH_SERVER_INSTANCE_URL!;
      const server = await start({ env, license: { edition: 'enterprise', status: 'active' } });
      try {
        // This server has no terminal-shares module, so no share route either; and nothing else is served.
        expect((await fetch(`${internal}/internal/v1/shares/${'a'.repeat(26)}/info`)).status).toBe(404);
        expect((await fetch(`${internal}/healthz`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${String(server.port)}/internal/v1/shares/x/info`)).status).toBe(404);
      } finally {
        await server.close();
      }
      await expect(fetch(`${internal}/healthz`)).rejects.toThrow();
    });

    it('a single server opens no internal listener', async () => {
      const server = await start({});
      try {
        expect(server.ctx.relay).toBeUndefined();
      } finally {
        await server.close();
      }
    });

    it('needs no license for single', async () => {
      const server = await start({ license: { edition: 'community', status: 'none' } });
      await server.close();
    });
  });

  describe('admin instances', () => {
    it('lists the live rows, holder, address, version, age and last renew, and prints no tenant', async () => {
      const live = randomUUID();
      const dead = randomUUID();
      await db.query(
        `insert into server_instances (holder, url, version) values ($1::uuid, 'http://10.0.0.5:8091', '6.2.0')`,
        [live],
      );
      await db.query(`insert into server_instances (holder, version) values ($1::uuid, '6.1.0')`, [dead]);
      await db.owner.query(
        `update server_instances set renewed_at = now() - interval '2 minutes' where holder = $1::uuid`,
        [dead],
      );
      const tenant = (await db.owner.query<{ id: string; slug: string }>('select id::text as id, slug from tenants'))
        .rows;
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const env = {
        WIREBENCH_SERVER_DATABASE_URL: db.url,
        WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      };
      expect(await main(['admin', 'instances'], { stdout, stderr, env })).toBe(0);
      const text = stdout.write.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toMatch(/^HOLDER\s+ADDRESS\s+VERSION\s+AGE\s+LAST RENEW\n/);
      expect(text).toContain(`${live}  http://10.0.0.5:8091  6.2.0`);
      expect(text).toMatch(/\(\d+s ago\)/);
      expect(text).not.toContain(dead);
      for (const row of tenant) expect(text).not.toContain(row.id);
      expect(text).not.toMatch(/tenant/i);
      expect(stderr.write).not.toHaveBeenCalled();
    });

    it('says so when no instance is running', async () => {
      const stdout = { write: vi.fn() };
      const env = {
        WIREBENCH_SERVER_DATABASE_URL: db.url,
        WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      };
      expect(await main(['admin', 'instances'], { stdout, stderr: { write: vi.fn() }, env })).toBe(0);
      expect(stdout.write.mock.calls.map((c) => String(c[0])).join('')).toContain('no instance is running');
    });
  });
});
