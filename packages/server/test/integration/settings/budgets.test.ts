/**
 * Slice 7 Task 28 (hosted edition spec §20.7, §22.12): the operator overrides one tenant's budgets. The send budget,
 * the concurrency and the run slots of that tenant follow the override; every other tenant keeps the defaults; and
 * a tenant cannot raise its own (`settings-operator-only`).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { SendBudgets, sendBudgetSettings } from '../../../src/operations/budgets.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

describeDb('budget overrides per tenant (spec §20.7)', () => {
  let h: IdentityHarness;
  let acme: TenantScope;
  let beta: TenantScope;
  let budgets: SendBudgets;
  beforeAll(async () => {
    h = await identityHarness({
      env: { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') },
      configure: hosted,
      beforeBuild: async (db, ctx) => {
        const admin = new TenantAdmin(db, directoryOf(ctx.tenancy));
        acme = (await admin.create({ slug: 'acme', name: 'Acme' })).scope;
        beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
      },
    });
    // As the host module builds it in hosted mode.
    budgets = new SendBudgets({
      db: h.ctx.tenancy.db,
      settings: sendBudgetSettings(h.ctx.config),
      settingsFor: (scope) => h.ctx.settings.budgets(scope),
      now: () => T0,
    });
  }, 60_000);
  afterAll(() => h.close());

  it('applies the operator’s override to its tenant only', async () => {
    await h.ctx.settings.set(
      acme,
      'budgets',
      { sendsPerMinute: 6, concurrentSends: 2, runSlots: 1 },
      { by: 'operator', operator: true },
    );
    // Six a minute is a burst of one: acme's second send is refused, beta's hundredth is not.
    const first = await budgets.take(acme);
    expect(first.ok).toBe(true);
    if (first.ok) await first.release();
    expect(await budgets.take(acme)).toMatchObject({ ok: false, refusal: { code: 'tenant-send-budget' } });
    for (let n = 0; n < 5; n++) {
      const taken = await budgets.take(beta);
      expect(taken.ok).toBe(true);
      if (taken.ok) await taken.release();
    }
    // Two at once for acme, by the slots alone.
    const held = [await budgets.take(acme, { token: false }), await budgets.take(acme, { token: false })];
    expect(held.every((taken) => taken.ok)).toBe(true);
    expect(await budgets.take(acme, { token: false })).toMatchObject({
      ok: false,
      refusal: { code: 'tenant-send-concurrency' },
    });
    for (const taken of held) if (taken.ok) await taken.release();
    expect((await h.ctx.settings.budgets(acme)).runSlots).toBe(1);
    expect(await h.ctx.settings.budgets(beta)).toEqual({
      sendsPerMinute: h.ctx.config.tenantSendsPerMinute,
      burst: Math.ceil(h.ctx.config.tenantSendsPerMinute / 6),
      concurrentSends: h.ctx.config.tenantConcurrentSends,
      runSlots: h.ctx.config.tenantRunSlots,
    });
  });

  it('refuses a tenant’s own budgets with settings-operator-only, writing nothing', async () => {
    await expect(
      h.ctx.settings.set(beta, 'budgets', { sendsPerMinute: 1_000_000 }, { by: 'u1' }),
    ).rejects.toMatchObject({ code: 'settings-operator-only' });
    await expect(h.ctx.settings.clear(acme, 'budgets', { by: 'u1' })).rejects.toMatchObject({
      code: 'settings-operator-only',
    });
    expect((await h.ctx.settings.view(beta)).budgets).toMatchObject({ value: null, writable: false });
    expect((await h.ctx.settings.view(acme, { operator: true })).budgets.writable).toBe(true);
  });
});
