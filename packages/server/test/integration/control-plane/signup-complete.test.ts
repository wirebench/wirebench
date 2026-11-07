/**
 * Signup to first sign-in (hosted edition spec §22.6, §13 criterion 5; slice 7 Task 18), end to end with a fake
 * checkout that posts a signed `subscription.created` fixture: the tenant resolves on its host, the status poll says
 * `ready` with its sign-in page, and the chosen email and password sign in. Also: a webhook after the link's expiry
 * still completes, a duplicate makes one tenant, a signup with no password or whose slug was taken since makes none,
 * and the control loop's step removes the signups that will never complete. Every key here is a placeholder.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import type { ServerConfig } from '../../../src/config.js';
import { paddleSignature } from '../../../src/control-plane/billing/signature.js';
import { openControlDb } from '../../../src/control-plane/control-db.js';
import { ControlLoop } from '../../../src/control-plane/loop.js';
import type { ControlMail } from '../../../src/control-plane/mail.js';
import { controlPlaneModule } from '../../../src/control-plane/module.js';
import { signupFinishStep } from '../../../src/control-plane/signup/complete.js';
import { signupExpiryStep } from '../../../src/control-plane/signup/expiry.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import type { EntryQueue } from '../../../src/entry/queue.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantResolver } from '../../../src/tenancy/resolve.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const SECRET = 'pdl_ntfset_test_placeholder_webhook_secret';
const SMTP = { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test' };
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: 'app.test',
  siteDomain: 'site.test',
  paddleEnvironment: 'sandbox',
  paddleClientToken: 'test_placeholdertoken',
  paddleTeamPriceId: 'pri_test_team',
  paddleWebhookSecret: SECRET,
});
const ENTRY = 'app.app.test';
const ORIGIN = 'https://app.app.test';
const FORM = { host: ENTRY, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' };
const PASSWORD = 'correct horse battery staple';
const FIXTURE = fileURLToPath(new URL('../../fixtures/paddle/subscription.created.json', import.meta.url));

describeDb('signup to first sign-in (spec §22.6, §13 criterion 5)', () => {
  let h: IdentityHarness;
  let queue: EntryQueue<unknown>;
  let now = new Date('2026-11-04T10:00:00.000Z');
  let n = 0;
  let resolver: TenantResolver;
  const sent: ControlMail[] = [];
  beforeAll(async () => {
    h = await identityHarness({
      // The browser's form sign-in is the path the status poll's page leads to.
      env: {
        ...SMTP,
        WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
      configure: hosted,
      control: true,
      modules: [
        auditLogModule(),
        controlPlaneModule({
          now: () => now,
          startLoop: false,
          send: (_to, mail) => {
            sent.push(mail);
            return Promise.resolve();
          },
          onSignupQueue: (made) => {
            queue = made as EntryQueue<unknown>;
          },
        }),
      ],
      onTenantResolver: (made) => {
        resolver = made;
      },
      beforeBuild: async (db) => {
        await ensureControlRole(db.owner, db.controlUrl, db.url);
      },
    });
  });
  afterAll(async () => {
    await reader?.close();
    await h.close();
  });
  /** The scoped tables are read on the control role, which alone reads across tenants. */
  let reader: ReturnType<typeof openControlDb> | undefined;
  const control = () => (reader ??= openControlDb(h.db.controlUrl));
  beforeEach(() => {
    now = new Date(now.getTime() + 24 * 3_600_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface Signup {
    readonly token: string;
    readonly slug: string;
    readonly email: string;
    readonly id: string;
  }

  /** Through the form, the mail's link and (unless `password` is false) the password step. */
  async function signup(options: { readonly password?: boolean; readonly seats?: number } = {}): Promise<Signup> {
    n++;
    const slug = `paid${String(n)}`;
    const email = `Owner${String(n)}@Team.test`;
    sent.length = 0;
    await h.app.inject({
      method: 'POST',
      url: '/signup',
      headers: FORM,
      remoteAddress: `10.3.0.${String(n)}`,
      payload: new URLSearchParams({
        email,
        name: `Team ${String(n)}`,
        slug,
        seats: String(options.seats ?? 3),
      }).toString(),
    });
    await queue.idle();
    const token = /\/signup\/([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
    const id = (await h.db.owner.query<{ id: string }>('select id::text from signups where slug = $1', [slug])).rows[0]!
      .id;
    if (options.password !== false) {
      const checkout = await h.app.inject({
        method: 'POST',
        url: `/signup/${token}`,
        headers: FORM,
        payload: new URLSearchParams({ password: PASSWORD }).toString(),
      });
      expect(checkout.statusCode).toBe(200);
      // What the page hands Paddle's overlay as its custom data.
      expect(checkout.body).toContain(`data-signup="${id}"`);
    }
    return { token, slug, email, id };
  }

  /** The fake checkout: Paddle's `subscription.created` for `signupId`, signed as Paddle signs it, at `now`. */
  async function paid(signupId: string, eventId: string, ref: string) {
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: Record<string, unknown> };
    const body = JSON.stringify({
      ...raw,
      event_id: eventId,
      occurred_at: now.toISOString(),
      data: { ...raw.data, id: ref, custom_data: { signup: signupId } },
    });
    const ts = Math.floor(now.getTime() / 1000);
    return h.app.inject({
      method: 'POST',
      url: '/billing/paddle',
      headers: {
        host: ENTRY,
        'content-type': 'application/json',
        'paddle-signature': `ts=${String(ts)};h1=${paddleSignature(SECRET, ts, body)}`,
      },
      payload: body,
    });
  }
  const outcome = async (eventId: string) =>
    (await h.db.owner.query<{ outcome: string }>('select outcome from billing_events where event_id = $1', [eventId]))
      .rows[0]?.outcome;
  const tenantsWith = async (slug: string) =>
    (
      await h.db.owner.query<{ id: string; edition: string; seats: number; edition_source: string; region: string }>(
        'select id::text, edition, seats, edition_source, region from tenants where slug = $1',
        [slug],
      )
    ).rows;
  const status = async (token: string) =>
    (await h.app.inject({ method: 'GET', url: `/signup/${token}/status`, headers: { host: ENTRY } })).json<
      Record<string, string>
    >();

  it('makes the tenant and its first admin, says ready, and signs in with the chosen password', async () => {
    const s = await signup();
    expect(await status(s.token)).toEqual({ status: 'pending' });
    const res = await paid(s.id, 'evt_test_signup_1', 'sub_test_signup_1');
    expect(res.statusCode).toBe(200);
    expect(await outcome('evt_test_signup_1')).toBe('applied');
    // The fixture's Team items: 3 + 2 seats, edition team from the subscription, region eu.
    const [tenant, ...others] = await tenantsWith(s.slug);
    expect(others).toEqual([]);
    expect(tenant).toMatchObject({ edition: 'team', seats: 5, edition_source: 'subscription', region: 'eu' });
    const row = (
      await h.db.owner.query<{ status: string; tenant_id: string; password_hash: string | null }>(
        'select status, tenant_id::text, password_hash from signups where id = $1',
        [s.id],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'completed', tenant_id: tenant!.id, password_hash: null });
    const subscription = await control().query(
      'select provider_ref, seats, status from subscriptions where tenant_id = $1',
      [tenant!.id],
    );
    expect(subscription.rows).toEqual([{ provider_ref: 'sub_test_signup_1', seats: 5, status: 'active' }]);
    const audit = await control().query<{ action: string }>(
      'select action from audit_events where tenant_id = $1 order by action',
      [tenant!.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['tenant.created', 'user.created']);

    const url = `https://${s.slug}.app.test/sign-in`;
    expect(await status(s.token)).toEqual({ status: 'ready', url });

    // The tenant resolves on its host, and the person signs in as its server admin (§13 criterion 5).
    const host = `${s.slug}.app.test`;
    // The directory's change reloads this process's map; it is read again in the background.
    await resolver.invalidate();
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/sign-in/local',
      headers: { host, origin: `https://${host}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: s.email, password: PASSWORD }).toString(),
    });
    expect(signIn.statusCode).toBe(303);
    const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { host, cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: s.email.toLowerCase(), serverAdmin: true } });
  });

  it('completes a signup whose link expired before the payment arrived', async () => {
    const s = await signup();
    now = new Date(now.getTime() + 25 * 3_600_000);
    expect((await paid(s.id, 'evt_test_signup_2', 'sub_test_signup_2')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_2')).toBe('applied');
    expect(await tenantsWith(s.slug)).toHaveLength(1);
    expect((await status(s.token)).status).toBe('ready');
  });

  it('makes one tenant for a duplicate delivery, and for a second created naming the same signup', async () => {
    const s = await signup();
    const first = await paid(s.id, 'evt_test_signup_3', 'sub_test_signup_3');
    const again = await paid(s.id, 'evt_test_signup_3', 'sub_test_signup_3');
    const other = await paid(s.id, 'evt_test_signup_3b', 'sub_test_signup_3b');
    expect([first.statusCode, again.statusCode, other.statusCode]).toEqual([200, 200, 200]);
    expect(await tenantsWith(s.slug)).toHaveLength(1);
    expect(await outcome('evt_test_signup_3')).toBe('applied');
    expect(await outcome('evt_test_signup_3b')).toBe('unmatched');
  });

  it('makes no tenant for a signup with no password yet', async () => {
    const s = await signup({ password: false });
    expect((await paid(s.id, 'evt_test_signup_4', 'sub_test_signup_4')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_4')).toBe('not-applied');
    expect(await tenantsWith(s.slug)).toEqual([]);
  });

  it('makes no tenant when the slug was taken since the form', async () => {
    const s = await signup();
    // An operator's create that slipped past the signup's hold (written straight into the directory).
    await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: s.slug, name: 'Raced' });
    expect((await paid(s.id, 'evt_test_signup_5', 'sub_test_signup_5')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_5')).toBe('not-applied');
    const rows = await h.db.owner.query<{ name: string }>('select name from tenants where slug = $1', [s.slug]);
    expect(rows.rows).toEqual([{ name: 'Raced' }]);
    expect(
      (await h.db.owner.query('select tenant_id from signups where id = $1 and tenant_id is null', [s.id])).rows,
    ).toHaveLength(1);
  });

  /** The seat check, made to throw once: the tenant's transaction (the completion's second half) fails. */
  const failTenantTransactionOnce = () =>
    vi
      .spyOn(h.ctx.license, 'assertSeatAvailable')
      .mockRejectedValueOnce(Object.assign(new Error('injected'), { code: 'injected-seat-check' }));
  const signupRow = async (id: string) =>
    (
      await h.db.owner.query<{ status: string; tenant_id: string | null; has_hash: boolean }>(
        'select status, tenant_id::text, password_hash is not null as has_hash from signups where id = $1',
        [id],
      )
    ).rows[0];
  const usersOf = async (tenantId: string) =>
    (
      await control().query<{ email: string; server_admin: boolean }>(
        'select email, server_admin from users where tenant_id = $1',
        [tenantId],
      )
    ).rows;
  const subscriptionsOf = async (tenantId: string) =>
    (
      await control().query<{ provider_ref: string; seats: number; status: string }>(
        'select provider_ref, seats, status from subscriptions where tenant_id = $1',
        [tenantId],
      )
    ).rows;

  it('answers 5xx when the tenant transaction fails, keeps the signup bound with its hash, and a redelivery finishes it', async () => {
    const s = await signup();
    failTenantTransactionOnce();
    const failed = await paid(s.id, 'evt_test_signup_7', 'sub_test_signup_7');
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(await outcome('evt_test_signup_7')).toBeUndefined();
    const [tenant, ...others] = await tenantsWith(s.slug);
    expect(others).toEqual([]);
    expect(await signupRow(s.id)).toEqual({ status: 'verified', tenant_id: tenant!.id, has_hash: true });
    expect(await usersOf(tenant!.id)).toEqual([]);

    const again = await paid(s.id, 'evt_test_signup_7', 'sub_test_signup_7');
    expect(again.statusCode).toBe(200);
    expect(await outcome('evt_test_signup_7')).toBe('applied');
    expect(await tenantsWith(s.slug)).toHaveLength(1);
    expect(await usersOf(tenant!.id)).toEqual([{ email: s.email.toLowerCase(), server_admin: true }]);
    expect(await subscriptionsOf(tenant!.id)).toEqual([
      { provider_ref: 'sub_test_signup_7', seats: 5, status: 'active' },
    ]);
    expect(await signupRow(s.id)).toEqual({ status: 'completed', tenant_id: tenant!.id, has_hash: false });
  });

  it('answers 5xx when the tenant transaction committed but the control update failed, and a redelivery finishes it', async () => {
    const s = await signup();
    // The signup's `completed` update refused once, by a trigger on this one row.
    await h.db.owner.query(`create or replace function fail_signup_complete() returns trigger language plpgsql as $$
      begin
        if new.status = 'completed' and old.id = '${s.id}'::uuid then raise exception 'injected'; end if;
        return new;
      end $$`);
    await h.db.owner.query(
      'create trigger fail_signup_complete before update on signups for each row execute function fail_signup_complete()',
    );
    try {
      const failed = await paid(s.id, 'evt_test_signup_8', 'sub_test_signup_8');
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await h.db.owner.query('drop trigger fail_signup_complete on signups');
      await h.db.owner.query('drop function fail_signup_complete()');
    }
    expect(await outcome('evt_test_signup_8')).toBeUndefined();
    const [tenant] = await tenantsWith(s.slug);
    expect(await usersOf(tenant!.id)).toHaveLength(1);
    expect(await signupRow(s.id)).toEqual({ status: 'verified', tenant_id: tenant!.id, has_hash: true });

    expect((await paid(s.id, 'evt_test_signup_8', 'sub_test_signup_8')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_8')).toBe('applied');
    expect(await tenantsWith(s.slug)).toHaveLength(1);
    expect(await usersOf(tenant!.id)).toHaveLength(1);
    expect(await subscriptionsOf(tenant!.id)).toHaveLength(1);
    expect(await signupRow(s.id)).toEqual({ status: 'completed', tenant_id: tenant!.id, has_hash: false });
  });

  it('refuses a second created with another ref for a bound, unfinished signup, and the first one still finishes', async () => {
    const s = await signup();
    failTenantTransactionOnce();
    expect((await paid(s.id, 'evt_test_signup_9', 'sub_test_signup_9')).statusCode).toBeGreaterThanOrEqual(500);
    const warn = vi.spyOn(h.app.log, 'warn');
    expect((await paid(s.id, 'evt_test_signup_9b', 'sub_test_signup_9b')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_9b')).toBe('billing-ref-conflict');
    const [tenant, ...others] = await tenantsWith(s.slug);
    expect(others).toEqual([]);
    // Logged by the signup and its tenant, for the operator's refund.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'billing-ref-conflict', signupId: s.id, tenantId: tenant!.id }),
      expect.any(String),
    );
    expect(await subscriptionsOf(tenant!.id)).toEqual([]);
    expect(await signupRow(s.id)).toMatchObject({ status: 'verified', has_hash: true });

    // The first one's retry, same ref, finishes it.
    expect((await paid(s.id, 'evt_test_signup_9', 'sub_test_signup_9')).statusCode).toBe(200);
    expect(await outcome('evt_test_signup_9')).toBe('applied');
    expect(await tenantsWith(s.slug)).toHaveLength(1);
    expect(await usersOf(tenant!.id)).toHaveLength(1);
    expect(await subscriptionsOf(tenant!.id)).toEqual([
      { provider_ref: 'sub_test_signup_9', seats: 5, status: 'active' },
    ]);
  });

  it("the control loop's step finishes a bound signup Paddle stopped retrying, once it is 10 minutes old", async () => {
    const s = await signup();
    failTenantTransactionOnce();
    expect((await paid(s.id, 'evt_test_signup_10', 'sub_test_signup_10')).statusCode).toBeGreaterThanOrEqual(500);
    const [tenant] = await tenantsWith(s.slug);
    const loopControl = openControlDb(h.db.controlUrl);
    try {
      const lifecycle = new TenantLifecycle({ control: loopControl, tenancy: h.ctx.tenancy, hooks: h.ctx.hooks });
      const step = signupFinishStep({
        control: loopControl,
        tenancy: h.ctx.tenancy,
        lifecycle,
        hooks: h.ctx.hooks,
        license: h.ctx.license,
        log: h.app.log,
      });
      const pass = (at: Date) =>
        new ControlLoop({ control: loopControl, steps: [step], log: h.app.log, now: () => at }).pass();
      expect(await pass(new Date(now.getTime() + 5 * 60_000))).toBe(true);
      expect(await signupRow(s.id)).toMatchObject({ status: 'verified', has_hash: true });
      expect(await usersOf(tenant!.id)).toEqual([]);

      await pass(new Date(now.getTime() + 11 * 60_000));
      expect(await signupRow(s.id)).toEqual({ status: 'completed', tenant_id: tenant!.id, has_hash: false });
      expect(await usersOf(tenant!.id)).toEqual([{ email: s.email.toLowerCase(), server_admin: true }]);
      expect(await subscriptionsOf(tenant!.id)).toEqual([
        { provider_ref: 'sub_test_signup_10', seats: 5, status: 'active' },
      ]);
      const audit = await control().query<{ action: string }>(
        'select action from audit_events where tenant_id = $1 order by action',
        [tenant!.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['tenant.created', 'user.created']);

      // Idempotent: another pass changes nothing.
      await pass(new Date(now.getTime() + 20 * 60_000));
      expect(await usersOf(tenant!.id)).toHaveLength(1);
      expect(await subscriptionsOf(tenant!.id)).toHaveLength(1);
    } finally {
      await loopControl.close();
    }
    // A late redelivery finds the signup completed.
    expect((await paid(s.id, 'evt_test_signup_10', 'sub_test_signup_10')).statusCode).toBe(200);
    expect(await usersOf(tenant!.id)).toHaveLength(1);
  });

  it("the control loop's step removes pending signups at expiry and verified ones a week later, freeing the slug", async () => {
    const pending = await signup({ password: false });
    const verified = await signup();
    const done = await signup();
    expect((await paid(done.id, 'evt_test_signup_6', 'sub_test_signup_6')).statusCode).toBe(200);
    const control = openControlDb(h.db.controlUrl);
    const left = async () =>
      (
        await h.db.owner.query<{ slug: string }>('select slug from signups where slug = any($1) order by slug', [
          [pending.slug, verified.slug, done.slug],
        ])
      ).rows.map((r) => r.slug);
    try {
      const pass = (at: Date) =>
        new ControlLoop({ control, steps: [signupExpiryStep()], log: h.app.log, now: () => at }).pass();
      expect(await pass(new Date(now.getTime() + 23 * 3_600_000))).toBe(true);
      expect(await left()).toEqual([pending.slug, verified.slug, done.slug].sort());
      await pass(new Date(now.getTime() + 25 * 3_600_000));
      expect(await left()).toEqual([verified.slug, done.slug].sort());
      await pass(new Date(now.getTime() + 8 * 24 * 3_600_000 + 3_600_000));
      expect(await left()).toEqual([done.slug]);
    } finally {
      await control.close();
    }
    // The pending one's slug is free again.
    now = new Date(now.getTime() + 2 * 24 * 3_600_000);
    const res = await h.app.inject({
      method: 'POST',
      url: '/signup',
      headers: FORM,
      remoteAddress: '10.3.1.1',
      payload: new URLSearchParams({
        email: 'again@team.test',
        name: 'Again',
        slug: pending.slug,
        seats: '1',
      }).toString(),
    });
    expect(res.body).toContain('Check your inbox');
  });
});
