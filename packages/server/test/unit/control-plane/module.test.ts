/**
 * Slice 7 Task 3 (hosted edition spec §22.2, §22.3): the control-plane module. Registered in every mode for its
 * migration, it serves nothing on a self-hosted server, and in hosted mode it refuses to register without the control
 * pool `serve.ts` hands it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { ServerContext } from '../../../src/context.js';
import { controlHandle, openControlDb } from '../../../src/control-plane/control-db.js';
import { CONTROL_PLANE_MIGRATIONS_DIR, controlPlaneModule } from '../../../src/control-plane/module.js';
import { testContext } from '../../helpers/context.js';

const base = () =>
  loadConfig(
    {
      WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    },
    '0.0.0-test',
  );

describe('the control-plane module (spec §22.3)', () => {
  const apps: FastifyInstance[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const close of closers.splice(0)) await close();
  });

  /** Registers the module on a bare app, counting every route it adds, public ones included. */
  const register = async (ctx: ServerContext): Promise<string[]> => {
    const app = Fastify();
    apps.push(app);
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      routes.push(`${String(route.method)} ${route.url}`);
    });
    const module = controlPlaneModule();
    await app.register(async (scope) => {
      await module.register(scope, ctx);
      await module.registerPublic?.(scope, ctx);
    });
    await app.ready();
    return routes;
  };

  it('owns migration 0023', () => {
    const module = controlPlaneModule();
    expect(module.name).toBe('control-plane');
    expect(module.migrationsDir).toBe(CONTROL_PLANE_MIGRATIONS_DIR);
  });

  it('serves nothing on a self-hosted server, and needs no control pool there', async () => {
    const ctx = await testContext({ config: base() });
    expect(ctx.config.mode).toBe('self-hosted');
    expect(ctx.control).toBeUndefined();
    expect(await register(ctx)).toEqual([]);
  });

  it('refuses to register in hosted mode without the control pool', async () => {
    const ctx = await testContext({ config: { ...base(), mode: 'hosted' } });
    await expect(register(ctx)).rejects.toMatchObject({ code: 'control-plane-control-db-missing' });
  });

  it('registers in hosted mode with the control pool, and serves nothing yet', async () => {
    // A pool connects lazily: nothing listens on port 1, and nothing here queries it.
    const pool = openControlDb('postgres://control:pw@127.0.0.1:1/none');
    closers.push(() => pool.close());
    const ctx = await testContext({ config: { ...base(), mode: 'hosted' }, control: controlHandle(pool) });
    expect(await register(ctx)).toEqual([]);
  });
});
