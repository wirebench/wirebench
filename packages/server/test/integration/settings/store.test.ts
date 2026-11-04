/**
 * Slice 7 Task 25 (hosted edition spec §22.12): the per-tenant settings store. A secret goes in sealed under the
 * tenant's data key and never comes back out of anything the API reads; a self-hosted server answers its environment
 * and never reads the table; two tenants' settings stay apart; and a write on one instance drops the other's cache
 * through the notification bus.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { openSession } from '../../../src/db/pool.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { openSecret } from '../../../src/settings/store.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { manualTimers } from '../../helpers/timers.js';

const log = Fastify({ logger: false }).log;
const ROOT = Buffer.alloc(32, 7);
const ENV = {
  WIREBENCH_SERVER_SECRETS_KEY: ROOT.toString('base64'),
  WIREBENCH_SERVER_SMTP_URL: 'smtp://operator:operator-pass@mail.operator.test:587',
  WIREBENCH_SERVER_SMTP_FROM: 'alerts@operator.test',
  WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS: '400',
  WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '7',
};
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });
/** Shaped like nothing else in the suite, so a search for it finds only a leak. */
const CLIENT_SECRET = 'oidc-client-secret-7f3a91c2e4b8';
const SMTP_PASSWORD = 'smtp-pass-5d2e8b1f';
const OIDC = {
  issuer: 'https://idp.acme.test',
  clientId: 'wirebench',
  clientSecret: CLIENT_SECRET,
  scopes: ['openid', 'email'],
  displayName: 'Acme SSO',
};

/** One statement in `scope`'s unit, as the app role: what a row looks like to that tenant. */
const inTenant = <R extends Record<string, unknown>>(
  h: IdentityHarness,
  scope: TenantScope,
  text: string,
  params: readonly unknown[] = [],
) =>
  h.db.transaction(async (tx) => {
    await tx.query("select set_config('wirebench.tenant_id', $1, true)", [scope.tenantId]);
    return tx.query<R>(text, params);
  });

describeDb('the settings store (spec §22.12)', () => {
  describe('hosted', () => {
    let h: IdentityHarness;
    let acme: TenantScope;
    let beta: TenantScope;
    beforeEach(async () => {
      h = await identityHarness({
        env: ENV,
        configure: hosted,
        beforeBuild: async (db, ctx) => {
          const admin = new TenantAdmin(db, directoryOf(ctx.tenancy));
          acme = (await admin.create({ slug: 'acme', name: 'Acme' })).scope;
          beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
        },
      });
    }, 60_000);
    afterEach(() => h.close());

    it('seals a secret and never reads it back: the view says set, the row holds no plain text', async () => {
      await h.ctx.settings.set(acme, 'oidc', OIDC, { by: 'u1' });
      await h.ctx.settings.set(
        acme,
        'smtp',
        { url: `smtps://acme-mailer:${SMTP_PASSWORD}@mail.acme.test:465`, from: 'ops@acme.test' },
        { by: 'u1' },
      );
      const view = await h.ctx.settings.view(acme);
      expect(view.oidc.value).toEqual({ ...OIDC, clientSecret: { set: true } });
      expect(view.smtp.value).toEqual({
        url: 'smtps://mail.acme.test:465',
        from: 'ops@acme.test',
        credentials: { set: true },
      });
      const shown = JSON.stringify(view);
      for (const secret of [CLIENT_SECRET, SMTP_PASSWORD, 'acme-mailer']) expect(shown).not.toContain(secret);

      const rows = await inTenant<{ section: string; value: unknown; sealed: Buffer | null }>(
        h,
        acme,
        'select section, value, sealed from tenant_settings order by section',
      );
      expect(rows.rows.map((row) => row.section)).toEqual(['oidc', 'smtp']);
      for (const row of rows.rows) {
        const stored = `${JSON.stringify(row.value)} ${row.sealed?.toString('latin1') ?? ''}`;
        for (const secret of [CLIENT_SECRET, SMTP_PASSWORD, 'acme-mailer']) expect(stored).not.toContain(secret);
        expect(row.sealed).not.toBeNull();
      }

      // Saving the plain fields again keeps the stored secret.
      await h.ctx.settings.set(acme, 'oidc', { ...OIDC, clientSecret: undefined, displayName: 'Acme' }, { by: 'u1' });
      expect(await h.ctx.settings.of(acme, 'oidc')).toMatchObject({ clientSecret: CLIENT_SECRET, displayName: 'Acme' });
      // The module's read has the opened values, credentials back in the URL.
      expect((await h.ctx.settings.smtp(acme))?.url).toBe(`smtps://acme-mailer:${SMTP_PASSWORD}@mail.acme.test:465`);
    });

    it('keeps two tenants apart: one tenant’s row neither reads nor opens in the other', async () => {
      await h.ctx.settings.set(acme, 'oidc', OIDC, { by: 'u1' });
      expect((await h.ctx.settings.view(beta)).oidc.value).toBeNull();
      expect(await h.ctx.settings.of(beta, 'oidc')).toBeUndefined();
      // A's row copied into B's tenant, as a restore gone wrong would: its sealed bytes do not open under B's key.
      const row = (
        await inTenant<{ value: unknown; sealed: Buffer }>(
          h,
          acme,
          "select value, sealed from tenant_settings where section = 'oidc'",
        )
      ).rows[0]!;
      expect(() => openSecret(Buffer.alloc(32, 9), 'oidc', row.sealed)).toThrow();
      await inTenant(
        h,
        beta,
        "insert into tenant_settings (section, value, sealed, updated_by) values ('oidc', $1::jsonb, $2, 'test')",
        [JSON.stringify(row.value), row.sealed],
      );
      // Beta's cache is dropped as a write of its own would: the copy reads as having no secret.
      h.ctx.hooks.tenantSettingsChanged.all().forEach((listener) => listener.fn({ tenantId: beta.tenantId }));
      const copied = await h.ctx.settings.view(beta);
      expect(copied.oidc.value).toMatchObject({ clientSecret: { set: false } });
      expect((await h.ctx.settings.of(beta, 'oidc'))?.clientSecret).toBeUndefined();
    });

    it('clamps a tenant’s retention to the operator’s maxima and falls back to the operator’s SMTP', async () => {
      expect(await h.ctx.settings.smtp(beta)).toEqual({
        url: ENV.WIREBENCH_SERVER_SMTP_URL,
        from: ENV.WIREBENCH_SERVER_SMTP_FROM,
      });
      await h.ctx.settings.set(acme, 'retention', { auditMaxAgeDays: 3000, hooksMaxAgeDays: 2 }, { by: 'u1' });
      const retention = await h.ctx.settings.retention(acme);
      expect(retention.auditMaxAgeDays).toBe(400);
      expect(retention.hooksMaxAgeDays).toBe(2);
      expect((await h.ctx.settings.retention(beta)).hooksMaxAgeDays).toBe(7);
    });

    it('refuses a tenant’s budgets, and an input out of shape, without writing', async () => {
      await expect(h.ctx.settings.set(acme, 'budgets', { sendsPerMinute: 10_000 }, { by: 'u1' })).rejects.toMatchObject(
        {
          code: 'settings-operator-only',
        },
      );
      await expect(
        h.ctx.settings.set(acme, 'smtp', { url: 'smtp://x', from: 'not an email' }, { by: 'u1' }),
      ).rejects.toMatchObject({
        code: 'settings-invalid',
      });
      await h.ctx.settings.set(acme, 'budgets', { sendsPerMinute: 60 }, { by: 'operator', operator: true });
      expect(await h.ctx.settings.budgets(acme)).toMatchObject({ sendsPerMinute: 60, burst: 10 });
      expect(await h.ctx.settings.clear(acme, 'retention', { by: 'u1' })).toBe(false);
    });
  });

  describe('self-hosted', () => {
    let h: IdentityHarness;
    beforeEach(async () => {
      h = await identityHarness({
        env: {
          ...ENV,
          WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test',
          WIREBENCH_SERVER_OIDC_CLIENT_ID: 'wb',
          WIREBENCH_SERVER_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        },
        // Discovery is not this suite's: a provider that is never called.
        provider: {
          issuer: 'https://idp.test',
          authorizationUrl: () => '',
          exchange: () => Promise.reject(new Error('unused')),
        },
      });
    }, 60_000);
    afterEach(() => h.close());

    it('answers the environment, read-only, and never reads the table', async () => {
      h.statements.entries.length = 0;
      const view = await h.ctx.settings.view(h.tdb.scope);
      expect(view.oidc).toEqual({
        source: 'environment',
        writable: false,
        value: {
          issuer: 'https://idp.test',
          clientId: 'wb',
          scopes: ['openid', 'email', 'profile'],
          displayName: 'OIDC',
          clientSecret: { set: true },
        },
      });
      expect(view.smtp.value).toEqual({
        url: 'smtp://mail.operator.test:587',
        from: 'alerts@operator.test',
        credentials: { set: true },
      });
      expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(view)).not.toContain('operator-pass');
      await expect(h.ctx.settings.set(h.tdb.scope, 'oidc', OIDC, { by: 'u1' })).rejects.toMatchObject({
        code: 'settings-environment',
      });
      await expect(h.ctx.settings.clear(h.tdb.scope, 'smtp', { by: 'u1' })).rejects.toMatchObject({
        code: 'settings-environment',
      });
      expect((await h.ctx.settings.retention(h.tdb.scope)).auditMaxAgeDays).toBe(400);
      expect(h.statements.entries.filter((entry) => entry.text.includes('tenant_settings'))).toEqual([]);
    });
  });

  describe('two instances', () => {
    let db: TestDatabase;
    let dataDir: string;
    const nodes: { h: IdentityHarness; bus: NotificationBus; registry: InstanceRegistry }[] = [];
    beforeEach(async () => {
      db = await testDatabase();
      dataDir = await mkTempDir();
    }, 60_000);
    afterEach(async () => {
      for (const node of nodes.splice(0)) {
        await node.h.close();
        await node.bus.stop(0);
        await node.registry.stop();
      }
      await db.close();
      await removeTempDir(dataDir);
    });

    const node = async () => {
      const holder = randomUUID();
      const registry = new InstanceRegistry({
        db,
        holder,
        mode: 'multi',
        url: 'http://127.0.0.1:1',
        version: '0.0.0-test',
        setTimer: manualTimers().setTimer,
        log: () => undefined,
      });
      await registry.start();
      const signals = new BusSignals();
      const h = await identityHarness({ db, dataDir, env: ENV, configure: hosted, instance: registry, bus: signals });
      const bus = new NotificationBus({
        db,
        holder,
        hooks: h.hooks,
        open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
        scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
        log,
        retryDelayMs: 50,
        maxRetryDelayMs: 200,
      });
      signals.attach(bus);
      await bus.start();
      nodes.push({ h, bus, registry });
      return h;
    };

    it('a write on one drops the other’s cache through the bus', async () => {
      const a = await node();
      const b = await node();
      const { scope } = await new TenantAdmin(db, directoryOf(a.ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
      // B reads first, so it holds the tenant's settings (none) in its cache.
      expect(await b.ctx.settings.of(scope, 'oidc')).toBeUndefined();
      const changes: unknown[] = [];
      b.ctx.settings.onChanged((change) => changes.push(change));
      await a.ctx.settings.set(scope, 'oidc', OIDC, { by: 'u1' });
      await vi.waitFor(
        async () => {
          expect((await b.ctx.settings.of(scope, 'oidc'))?.displayName).toBe('Acme SSO');
        },
        { timeout: 2_000, interval: 20 },
      );
      expect(changes).toContainEqual({ tenantId: scope.tenantId, section: 'oidc' });
    });
  });
});
