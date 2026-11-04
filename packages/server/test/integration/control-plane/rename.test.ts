/**
 * Rename and the retired slugs (hosted edition spec §22.8; slice 7 Task 7): one control transaction moves the slug and
 * retires the old one with a 30-day redirect. The old host answers `308` to the same path and query on the new host
 * while the redirect lives, `404` after, and its slug is never written again.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import type { ServerConfig } from '../../../src/config.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { REDIRECT_DAYS, TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { TenantResolver } from '../../../src/tenancy/resolve.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const APP_DOMAIN = 'example.test';
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });
const NOW = new Date('2026-11-04T12:00:00.000Z');

describeDb('rename and retired redirects (hosted spec §22.8)', () => {
  let h: IdentityHarness;
  let control: ControlDb;
  let resolver: TenantResolver;
  let lifecycle: TenantLifecycle;
  beforeEach(async () => {
    h = await identityHarness({
      configure: hosted,
      env: { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') },
      onTenantResolver: (made) => {
        resolver = made;
      },
    });
    // The harness registers no audit module: its hook, as the server's audit module pushes it.
    h.hooks.audit.push(auditHook(() => h.clock.now));
    await ensureControlRole(h.db.owner, h.db.controlUrl, h.db.url);
    control = openControlDb(h.db.controlUrl);
    lifecycle = new TenantLifecycle({ control, tenancy: h.ctx.tenancy, hooks: h.hooks, now: () => NOW });
    await lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'operator' });
  });
  afterEach(async () => {
    await control.close();
    await h.close();
  });

  const get = (host: string, url = '/api/v1/meta') => h.app.inject({ method: 'GET', url, headers: { host } });

  it('moves the slug, retires the old one for 30 days, and audits tenant.renamed', async () => {
    const renamed = await lifecycle.rename('acme', 'acme-gmbh');
    expect(renamed).toMatchObject({ slug: 'acme-gmbh' });
    const retired = await control.query<{ slug: string; to: string; days: number; tenant: string }>(
      `select slug, redirect_to as "to", tenant_id::text as tenant,
              extract(epoch from (redirect_until - now())) / 86400 as days from tenant_slugs_retired`,
    );
    // One clock decides: the database's own, 30 days on from the transaction.
    expect(retired.rows).toMatchObject([{ slug: 'acme', to: 'acme-gmbh', tenant: renamed.id }]);
    expect(Number(retired.rows[0]!.days)).toBeGreaterThan(REDIRECT_DAYS - 0.01);
    expect(Number(retired.rows[0]!.days)).toBeLessThanOrEqual(REDIRECT_DAYS);
    const audit = await h.ctx.tenancy
      .db(renamed.scope)
      .query<{ action: string; details: Record<string, unknown> }>(
        "select action, details from audit_events where action = 'tenant.renamed'",
      );
    expect(audit.rows).toMatchObject([{ action: 'tenant.renamed', details: { from: 'acme', to: 'acme-gmbh' } }]);
  });

  it('the old host answers 308 to the same path and query on the new host, uncached; the new host serves', async () => {
    await lifecycle.rename('acme', 'acme-gmbh');
    await resolver.invalidate();
    const res = await get(`acme.${APP_DOMAIN}`, '/sign-in?redirect_to=%2Fworkspaces&x=1');
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`https://acme-gmbh.${APP_DOMAIN}/sign-in?redirect_to=%2Fworkspaces&x=1`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe('');
    expect((await get(`acme-gmbh.${APP_DOMAIN}`)).statusCode).toBe(200);
    // A second rename: the oldest host follows to the newest name, never to a retired one.
    await lifecycle.rename('acme-gmbh', 'acme-ag');
    await resolver.invalidate();
    for (const old of ['acme', 'acme-gmbh']) {
      expect((await get(`${old}.${APP_DOMAIN}`, '/x')).headers.location).toBe(`https://acme-ag.${APP_DOMAIN}/x`);
    }
  });

  it('after the redirect ends the old host is 404 like any unknown name', async () => {
    await lifecycle.rename('acme', 'acme-gmbh');
    await control.query(`update tenant_slugs_retired set redirect_until = now() - interval '1 second'`);
    await resolver.invalidate();
    const res = await get(`acme.${APP_DOMAIN}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
  });

  it('a retired slug is never written again: not by create, not by a rename, not after its redirect', async () => {
    await lifecycle.create({ slug: 'beta', name: 'Beta', edition: 'team', editionSource: 'operator' });
    await lifecycle.rename('acme', 'acme-gmbh');
    await control.query(`update tenant_slugs_retired set redirect_until = now() - interval '1 day'`);
    await expect(
      lifecycle.create({ slug: 'acme', name: 'Again', edition: 'team', editionSource: 'operator' }),
    ).rejects.toMatchObject({ code: 'control-plane-slug-taken' });
    await expect(lifecycle.rename('beta', 'acme')).rejects.toMatchObject({ code: 'control-plane-slug-taken' });
    // Not even back to itself.
    await expect(lifecycle.rename('acme-gmbh', 'acme')).rejects.toMatchObject({ code: 'control-plane-slug-taken' });
    await expect(lifecycle.rename('beta', 'beta')).rejects.toMatchObject({ code: 'control-plane-slug-taken' });
    await expect(lifecycle.rename('beta', 'billing')).rejects.toMatchObject({ code: 'tenancy-slug-reserved' });
    await expect(lifecycle.rename('nobody', 'fresh')).rejects.toMatchObject({ code: 'control-plane-tenant-unknown' });
  });

  it('redirectOf checks the end on a stale map: past `until` it is gone without a reload', async () => {
    await lifecycle.rename('acme', 'acme-gmbh');
    const loaded = await control.query<{ slug: string; to: string; until: Date }>(
      `select slug, redirect_to as "to", redirect_until as "until" from tenant_slugs_retired`,
    );
    const until = loaded.rows[0]!.until.getTime();
    let clock = until - 60_000;
    const stale = new TenantResolver({
      appDomain: APP_DOMAIN,
      directory: {
        hosted: () => Promise.resolve([]),
        onChange: () => () => undefined,
        redirects: () => Promise.resolve([{ slug: 'acme', to: 'acme-gmbh', until: loaded.rows[0]!.until }]),
      },
      now: () => clock,
      log: { warn: () => undefined },
      setInterval: () => ({}),
    });
    await stale.invalidate();
    expect(stale.redirectOf(`acme.${APP_DOMAIN}`)).toBeDefined();
    clock = until + 1;
    // No reload between: the stale entry itself is refused.
    expect(stale.redirectOf(`acme.${APP_DOMAIN}`)).toBeUndefined();
  });
});
