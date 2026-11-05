/**
 * The control plane's tenant routes with two tenants (slice 7 Task 24, hosted edition spec §22.9, §22.11, §22.13):
 * each tenant's server admins see and download their own exports only, ask for their own deletion only (typing their
 * own slug), and read their own billing; a member who is no server admin, and nobody signed in, reach none of it. On
 * a self-hosted server the export routes are served and the hosted-only ones are not.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  tenantBillingWireSchema,
  tenantExportRequestedWireSchema,
  tenantExportsListResponseWireSchema,
} from '@wirebench/wire/wire-base';
import { auditHook } from '../../../../src/audit-log/hook.js';
import type { ControlMail } from '../../../../src/control-plane/mail.js';
import { controlPlaneModule } from '../../../../src/control-plane/module.js';
import { EXPORT_DOWNLOADS } from '../../../../src/control-plane/tenant-routes.js';
import { tenantRoot } from '../../../../src/tenancy/paths.js';
import { ensureControlRole } from '../../../../src/tenancy/roles.js';
import { describeDb } from '../../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../../helpers/identity.js';
import { twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

const EXPORT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const EXPORT_B = '0b0b0b0b-0000-4000-8000-00000000000b';

/** A ready export of `tenant`'s, its row and its file. */
async function readyExport(dataDir: string, tenant: Pick<Tenant, 'tdb' | 'scope'>, id: string, body: string) {
  const dir = join(tenantRoot(dataDir, tenant.scope), 'exports');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.tar.gz`), body);
  await tenant.tdb.query(
    `insert into tenant_exports (id, requested_by, status, size_bytes, sha256, ready_at, expires_at)
     values ($1, 'operator', 'ready', $2, 'x', now(), now() + interval '7 days')`,
    [id, Buffer.byteLength(body)],
  );
}

describeDb('the tenant routes, two tenants (spec §22.9, §22.11)', () => {
  let t: TwoTenants;
  let adminA: SignedInUser;
  let adminB: SignedInUser;
  let memberA: SignedInUser;
  const sent: { to: readonly string[]; mail: ControlMail }[] = [];
  beforeAll(async () => {
    t = await twoTenants({
      env: { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'wirebench@mail.test' },
      modules: () => [
        controlPlaneModule({
          startLoop: false,
          send: (to, mail) => {
            sent.push({ to, mail });
            return Promise.resolve();
          },
        }),
      ],
    });
    await ensureControlRole(t.h.db.owner, t.h.db.controlUrl, t.h.db.url);
    // The audit module is not in this server: its hook records what the routes audit.
    t.h.hooks.audit.push(auditHook(() => new Date()));
    adminA = await t.a.user({ email: 'admin@acme.example', serverAdmin: true });
    adminB = await t.b.user({ email: 'admin@beta.example', serverAdmin: true });
    memberA = await t.a.user({ email: 'member@acme.example' });
    await readyExport(t.h.dataDir, t.a, EXPORT_A, 'acme export bytes');
    await readyExport(t.h.dataDir, t.b, EXPORT_B, 'beta export bytes');
    await t.a.tdb.query(
      `insert into subscriptions (provider, provider_ref, plan, seats, status, past_due_since, last_event_at)
       values ('paddle', 'sub_test_acme', 'team', 5, 'past_due', now() - interval '4 days', now())`,
    );
  }, SETUP_MS);
  afterAll(() => t.close(), SETUP_MS);

  it("lists and serves a tenant's own exports only", async () => {
    const listA = await t.a.call<{ exports: { id: string }[] }>(adminA, 'GET', '/tenant/exports');
    expect(listA.body.exports.map((row) => row.id)).toEqual([EXPORT_A]);
    // The desktop's wire schema reads the answer whole: nothing it would drop, nothing it would refuse.
    expect(tenantExportsListResponseWireSchema.parse(listA.body)).toEqual(listA.body);
    expect(listA.body.exports[0]).toMatchObject({ requestedBy: 'operator' });
    const listB = await t.b.call<{ exports: { id: string }[] }>(adminB, 'GET', '/tenant/exports');
    expect(listB.body.exports.map((row) => row.id)).toEqual([EXPORT_B]);
    const own = await t.a.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${EXPORT_A}/file`,
      headers: adminA.headers,
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe('acme export bytes');
    // Recorded in A's chain, by whom.
    const audited = await t.a.tdb.query<{ details: Record<string, unknown> }>(
      "select details from audit_events where action = 'tenant.export_downloaded'",
    );
    expect(audited.rows.map((row) => row.details)).toEqual([
      expect.objectContaining({ exportId: EXPORT_A, by: adminA.user.id }) as unknown,
    ]);
    expect(own.headers['content-disposition']).toMatch(
      /^attachment; filename="wirebench-export-acme-\d{8}T\d{6}Z\.tar\.gz"$/,
    );
    // B's admin, A's id, on B's host: B has no such export.
    const cross = await t.b.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${EXPORT_A}/file`,
      headers: adminB.headers,
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.body).not.toContain('acme');
    // A's admin's token on B's host is no session there.
    const wrongHost = await t.b.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${EXPORT_B}/file`,
      headers: adminA.headers,
    });
    expect(wrongHost.statusCode).toBe(401);
  });

  it('answers 404 for an export past its seven days, and for one whose file is gone', async () => {
    const expired = '0c0c0c0c-0000-4000-8000-00000000000c';
    await readyExport(t.h.dataDir, t.a, expired, 'old bytes');
    await t.a.tdb.query("update tenant_exports set expires_at = now() - interval '1 minute' where id = $1", [expired]);
    const old = await t.a.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${expired}/file`,
      headers: adminA.headers,
    });
    expect(old.statusCode).toBe(404);
    const gone = '0d0d0d0d-0000-4000-8000-00000000000d';
    await readyExport(t.h.dataDir, t.a, gone, 'gone bytes');
    await unlink(join(tenantRoot(t.h.dataDir, t.a.scope), 'exports', `${gone}.tar.gz`));
    const missing = await t.a.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${gone}/file`,
      headers: adminA.headers,
    });
    expect(missing.statusCode).toBe(404);
    await t.a.tdb.query('delete from tenant_exports where id = any($1::text[])', [[expired, gone]]);
  });

  it('answers 429 once a server admin downloads too often, per admin', async () => {
    const busy = await t.a.user({ email: 'busy@acme.example', serverAdmin: true });
    const download = () =>
      t.a.inject({ method: 'GET', url: `/api/v1/tenant/exports/${EXPORT_A}/file`, headers: busy.headers });
    for (let i = 0; i < EXPORT_DOWNLOADS.capacity; i++) expect((await download()).statusCode).toBe(200);
    const refused = await download();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    // Another admin's bucket is untouched.
    const other = await t.a.inject({
      method: 'GET',
      url: `/api/v1/tenant/exports/${EXPORT_A}/file`,
      headers: adminA.headers,
    });
    expect(other.statusCode).toBe(200);
  });

  it('serves server admins only, behind a session', async () => {
    expect((await t.a.call(memberA, 'GET', '/tenant/exports')).status).toBe(403);
    expect((await t.a.call(undefined, 'GET', '/tenant/exports')).status).toBe(401);
    expect((await t.a.call(memberA, 'GET', `/tenant/exports/${EXPORT_A}/file`)).status).toBe(403);
    expect((await t.a.call(undefined, 'GET', `/tenant/exports/${EXPORT_A}/file`)).status).toBe(401);
    expect((await t.a.call(memberA, 'POST', '/tenant/exports')).status).toBe(403);
    expect((await t.a.call(memberA, 'GET', '/tenant/billing')).status).toBe(403);
    expect((await t.a.call(memberA, 'POST', '/tenant/deletion', { slug: 'acme' })).status).toBe(403);
  });

  it('queues one export at a time per tenant', async () => {
    const first = await t.a.call<{ export: { id: string; status: string } }>(adminA, 'POST', '/tenant/exports');
    expect(first).toMatchObject({ status: 202, body: { export: { status: 'queued', requestedBy: 'admin' } } });
    expect(tenantExportRequestedWireSchema.parse(first.body)).toEqual(first.body);
    // The list names the requester by display name, and the operator's as `operator`.
    const listed = await t.a.call<{ exports: { id: string; requestedBy: string | null }[] }>(
      adminA,
      'GET',
      '/tenant/exports',
    );
    expect(listed.body.exports.map((row) => [row.id, row.requestedBy])).toEqual([
      [first.body.export.id, 'admin'],
      [EXPORT_A, 'operator'],
    ]);
    // An account no longer on the server is nobody's name.
    await t.a.tdb.query("update tenant_exports set requested_by = 'gone-user' where id = $1", [first.body.export.id]);
    const orphaned = await t.a.call<{ exports: { id: string; requestedBy: string | null }[] }>(
      adminA,
      'GET',
      '/tenant/exports',
    );
    expect(orphaned.body.exports[0]).toMatchObject({ id: first.body.export.id, requestedBy: null });
    expect((await t.a.call<{ code: string }>(adminA, 'POST', '/tenant/exports')).body.code).toBe(
      'control-plane-export-running',
    );
    // B's queue is its own.
    expect((await t.b.call(adminB, 'POST', '/tenant/exports')).status).toBe(202);
    await t.a.tdb.query("delete from tenant_exports where status = 'queued'");
    await t.b.tdb.query("delete from tenant_exports where status = 'queued'");
  });

  it("reads a tenant's own billing", async () => {
    // A team's name is not its slug: the screen shows one and confirms the deletion with the other.
    await t.h.db.query("update tenants set name = 'Acme Ltd' where slug = 'acme'");
    const enabled = Number(
      (await t.a.tdb.query<{ n: number }>('select count(*)::int as n from users where disabled_at is null')).rows[0]!.n,
    );
    const a = await t.a.call<{
      slug: string;
      name: string;
      activeMembers: number;
      subscription: { status: string; pastDueDaysLeft: number; pastDueSince: string | null } | null;
    }>(adminA, 'GET', '/tenant/billing');
    expect(a.body).toMatchObject({ slug: 'acme', name: 'Acme Ltd', activeMembers: enabled });
    expect(enabled).toBeGreaterThanOrEqual(2);
    expect(a.body.subscription).toMatchObject({ status: 'past_due', seats: 5, pastDueDaysLeft: 10 });
    expect(Date.now() - Date.parse(a.body.subscription!.pastDueSince!)).toBeGreaterThan(3.9 * 24 * 60 * 60 * 1000);
    expect(tenantBillingWireSchema.parse(a.body)).toEqual(a.body);
    // A disabled account holds no seat.
    await t.a.tdb.query('update users set disabled_at = now() where id = $1', [memberA.user.id]);
    const fewer = await t.a.call<{ activeMembers: number }>(adminA, 'GET', '/tenant/billing');
    expect(fewer.body.activeMembers).toBe(enabled - 1);
    await t.a.tdb.query('update users set disabled_at = null where id = $1', [memberA.user.id]);
    const b = await t.b.call<{ subscription: unknown }>(adminB, 'GET', '/tenant/billing');
    expect(b).toMatchObject({
      status: 200,
      body: { slug: 'beta', name: 'beta', activeMembers: 1, subscription: null, deletion: null },
    });
    expect(tenantBillingWireSchema.parse(b.body)).toEqual(b.body);
  });

  it("asks for a tenant's own deletion only, confirmed by its slug, and cancels it", async () => {
    // Typing the other tenant's slug confirms nothing.
    const wrong = await t.b.call<{ code: string }>(adminB, 'POST', '/tenant/deletion', { slug: 'acme' });
    expect(wrong).toMatchObject({ status: 400, body: { code: 'control-plane-deletion-unconfirmed' } });
    const asked = await t.b.call<{ deletion: { deletingAt: string } }>(adminB, 'POST', '/tenant/deletion', {
      slug: 'beta',
    });
    expect(asked.status).toBe(202);
    // Every server admin of B is told, and nobody of A.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['admin@beta.example']);
    expect(sent[0]!.mail.subject).toMatch(/^The Wirebench team beta will be deleted on \d{4}-\d{2}-\d{2}$/);
    expect(sent[0]!.mail.text).toContain('https://beta.example.test/settings');
    expect(asked.body.deletion.deletingAt).toEqual(expect.any(String));
    const rows = await t.h.db.query<{ slug: string; deleting: boolean }>(
      'select slug, deleting_at is not null as deleting from tenants where slug in ($1, $2) order by slug',
      ['acme', 'beta'],
    );
    expect(rows.rows).toEqual([
      { slug: 'acme', deleting: false },
      { slug: 'beta', deleting: true },
    ]);
    const billing = await t.b.call<{ deletion: unknown }>(adminB, 'GET', '/tenant/billing');
    expect(billing.body.deletion).toMatchObject({ deletingAt: asked.body.deletion.deletingAt });
    expect(await t.b.call(adminB, 'DELETE', '/tenant/deletion')).toMatchObject({
      status: 200,
      body: { cancelled: true },
    });
    expect(await t.b.call(adminB, 'DELETE', '/tenant/deletion')).toMatchObject({
      status: 200,
      body: { cancelled: false },
    });
  });
});

describeDb('the tenant routes, self-hosted (spec §22.9)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeAll(async () => {
    h = await identityHarness({ modules: () => [controlPlaneModule({ startLoop: false })] });
    admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
  }, SETUP_MS);
  afterAll(() => h.close(), SETUP_MS);

  const send = (method: 'GET' | 'POST' | 'DELETE', url: string) =>
    h.app.inject({ method, url: `/api/v1${url}`, headers: admin.headers });

  describe('export routes', () => {
    it('are served', async () => {
      expect((await send('GET', '/tenant/exports')).statusCode).toBe(200);
      const asked = await send('POST', '/tenant/exports');
      expect(asked.statusCode).toBe(202);
      expect(tenantExportRequestedWireSchema.parse(asked.json())).toEqual(asked.json());
      const listed = await send('GET', '/tenant/exports');
      expect(tenantExportsListResponseWireSchema.parse(listed.json())).toEqual(listed.json());
      expect(listed.json()).toMatchObject({ exports: [{ requestedBy: 'admin' }] });
    });
  });

  it('serves no billing and no deletion', async () => {
    expect((await send('GET', '/tenant/billing')).statusCode).toBe(404);
    expect((await send('POST', '/tenant/deletion')).statusCode).toBe(404);
    expect((await send('DELETE', '/tenant/deletion')).statusCode).toBe(404);
  });
});
