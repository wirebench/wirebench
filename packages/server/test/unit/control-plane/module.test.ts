/**
 * Slice 7 Task 3 (hosted edition spec §22.2, §22.3): the control-plane module. Registered in every mode for its
 * migration, it serves nothing on a self-hosted server, and in hosted mode it refuses to register without the control
 * pool `serve.ts` hands its factory. The pool is never on the shared context (Part A review).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { ServerContext } from '../../../src/context.js';
import { openControlDb } from '../../../src/control-plane/control-db.js';
import {
  CONTROL_PLANE_MIGRATIONS_DIR,
  controlPlaneModule,
  withControlPool,
} from '../../../src/control-plane/module.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
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
  const register = async (ctx: ServerContext, module = controlPlaneModule()): Promise<string[]> => {
    const app = Fastify();
    apps.push(app);
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      routes.push(`${String(route.method)} ${route.url}`);
    });
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
    expect(Object.keys(ctx)).not.toContain('control');
    expect(await register(ctx)).toEqual([]);
  });

  it('refuses to register in hosted mode without the control pool', async () => {
    const ctx = await testContext({ config: { ...base(), mode: 'hosted' } });
    await expect(register(ctx)).rejects.toMatchObject({ code: 'control-plane-control-db-missing' });
  });

  it('refuses to serve in hosted mode without the Paddle settings', async () => {
    // A pool connects lazily: nothing listens on port 1, and nothing here queries it.
    const pool = openControlDb('postgres://control:pw@127.0.0.1:1/none');
    closers.push(() => pool.close());
    const ctx = await testContext({ config: { ...base(), mode: 'hosted' } });
    await expect(register(ctx, controlPlaneModule({ control: pool }))).rejects.toMatchObject({
      code: 'control-plane-paddle-missing',
    });
  });

  it('registers in hosted mode with the control pool and the secret: the billing webhook alone', async () => {
    const pool = openControlDb('postgres://control:pw@127.0.0.1:1/none');
    closers.push(() => pool.close());
    const ctx = await testContext({
      config: { ...base(), mode: 'hosted', appDomain: 'app.test', paddleTeamPriceId: 'pri_test_team' },
    });
    const app = Fastify();
    apps.push(app);
    // The entry constraint the resolver registers in a built server (`tenancy/resolve.ts`).
    app.addConstraintStrategy({
      name: 'wirebenchEntry',
      storage: () => {
        const handlers = new Map<unknown, unknown>();
        return {
          get: (value) => (handlers.get(value) as never) ?? null,
          set: (value, h) => void handlers.set(value, h),
        };
      },
      deriveConstraint: () => undefined,
      mustMatchWhenDerived: false,
    });
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      routes.push(`${String(route.method)} ${route.url}`);
    });
    const module = withControlPool([controlPlaneModule()], pool, {
      paddleWebhookSecret: 'pdl_ntfset_test_placeholder_webhook_secret',
    })[0]!;
    await app.register(async (scope) => {
      await module.register(scope, ctx);
      await module.registerPublic?.(scope, ctx);
    });
    await app.ready();
    expect(routes).toEqual(['POST /billing/paddle']);
    // Nothing of the pool or the secret reaches the shared context, which every module sees.
    expect(Object.keys(ctx)).not.toContain('control');
    expect(Object.values(ctx)).not.toContain(pool);
    expect(JSON.stringify(ctx.config)).not.toContain('pdl_ntfset_');
  });

  it('hands the pool to the control-plane entry alone, and leaves the list as it was without one', () => {
    const pool = openControlDb('postgres://control:pw@127.0.0.1:1/none');
    closers.push(() => pool.close());
    const swapped = withControlPool(BUILTIN_MODULES, pool);
    expect(swapped.map((m) => m.name)).toEqual(BUILTIN_MODULES.map((m) => m.name));
    swapped.forEach((module, i) => {
      if (module.name === 'control-plane') {
        expect(module).not.toBe(BUILTIN_MODULES[i]);
        expect(module.migrationsDir).toBe(CONTROL_PLANE_MIGRATIONS_DIR);
      } else expect(module).toBe(BUILTIN_MODULES[i]);
    });
    expect(withControlPool(BUILTIN_MODULES, undefined)).toEqual([...BUILTIN_MODULES]);
  });
});
