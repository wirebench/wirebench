/**
 * The billing webhook (hosted edition spec §22.5; slice 7 Task 13): `POST /billing/paddle` on `app.<app-domain>`
 * only, its raw body checked before it is parsed. `401` and an empty body for a bad signature, `200` once applied or
 * a duplicate, `500` on a database failure or an event about a subscription not known yet (so Paddle retries after
 * its `created`). Every key and id here is a placeholder.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { controlPlaneModule } from '../../../src/control-plane/module.js';
import { paddleSignature } from '../../../src/control-plane/billing/signature.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const PADDLE_TEST_SETTINGS = {
  paddleEnvironment: 'sandbox',
  paddleClientToken: 'test_placeholdertoken',
  paddleTeamPriceId: 'pri_test_team',
  paddleWebhookSecret: 'pdl_ntfset_test_placeholder_webhook_secret',
} as const;
const SECRET = PADDLE_TEST_SETTINGS.paddleWebhookSecret;
const SMTP = { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test' };
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: 'app.test',
  siteDomain: 'site.test',
  ...PADDLE_TEST_SETTINGS,
});
const ENTRY = 'app.app.test';
const fixture = (type: string): string => fileURLToPath(new URL(`../../fixtures/paddle/${type}.json`, import.meta.url));

/** The `type` fixture's body with a fresh event id, `occurred_at` now, and `data` changed by `data`. */
function bodyOf(type: string, eventId: string, data: Record<string, unknown>): string {
  const raw = JSON.parse(readFileSync(fixture(type), 'utf8')) as { data: Record<string, unknown> };
  return JSON.stringify({
    ...raw,
    event_id: eventId,
    occurred_at: new Date().toISOString(),
    data: { ...raw.data, ...data },
  });
}

/** A `created` for the signup row `signupId`, with a fresh event id. */
const createdFor = (signupId: string, eventId: string, ref?: string): string =>
  bodyOf('subscription.created', eventId, {
    custom_data: { signup: signupId },
    ...(ref !== undefined ? { id: ref } : {}),
  });

const signed = (body: string, ts = Math.floor(Date.now() / 1000), secret: string = SECRET) => ({
  'content-type': 'application/json',
  'paddle-signature': `ts=${String(ts)};h1=${paddleSignature(secret, ts, body)}`,
});

describeDb('the billing webhook (spec §22.5)', () => {
  let h: IdentityHarness;
  let tenantId: string;
  let betaId: string;
  /** Signup rows bound to each tenant: how a tenant's subscription is attached (spec §22.5). */
  const signups = { acme: randomUUID(), beta: randomUUID() };
  const lines: string[] = [];
  beforeAll(async () => {
    h = await identityHarness({
      env: { ...SMTP, WIREBENCH_SERVER_LOG_LEVEL: 'info' },
      configure: hosted,
      control: true,
      modules: [controlPlaneModule()],
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString('utf8'));
          done();
        },
      }),
      beforeBuild: async (db, ctx) => {
        await ensureControlRole(db.owner, db.controlUrl, db.url);
        const made = await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({
          slug: 'acme',
          name: 'Acme',
          edition: 'team',
          editionSource: 'subscription',
        });
        tenantId = made.id;
        const beta = await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({
          slug: 'beta',
          name: 'Beta',
          edition: 'team',
          editionSource: 'subscription',
        });
        betaId = beta.id;
        for (const [slug, id, tenant] of [
          ['acme', signups.acme, tenantId],
          ['beta', signups.beta, betaId],
        ] as const) {
          await db.owner.query(
            `insert into signups (id, email_lower, name, slug, seats, token_hash, status, tenant_id, expires_at)
             values ($1::uuid, 'owner@site.test', $2, $2, 1, $3, 'verified', $4::uuid, now() + interval '1 day')`,
            [id, slug, `hash-${id}`, tenant],
          );
        }
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (body: string, headers: Record<string, string>, host = ENTRY) =>
    h.app.inject({ method: 'POST', url: '/billing/paddle', headers: { ...headers, host }, payload: body });

  it('applies a signed event, and answers a replay 200 with nothing done', async () => {
    const body = createdFor(signups.acme, 'evt_test_web_1');
    const res = await post(body, signed(body));
    expect([res.statusCode, res.body]).toEqual([200, '']);
    const seats = await h.db.owner.query<{ seats: number }>('select seats from tenants where id = $1', [tenantId]);
    expect(seats.rows[0]?.seats).toBe(5);
    const again = await post(body, signed(body));
    expect(again.statusCode).toBe(200);
    const rows = await h.db.owner.query('select outcome from billing_events where event_id = $1', ['evt_test_web_1']);
    expect(rows.rows).toEqual([{ outcome: 'applied' }]);
  });

  it('answers 401 and an empty body to an unsigned, a wrongly signed, a stale or a changed event', async () => {
    const body = createdFor(signups.acme, 'evt_test_web_2');
    const stale = Math.floor(Date.now() / 1000) - 600;
    for (const headers of [
      { 'content-type': 'application/json' },
      signed(body, undefined, 'pdl_ntfset_test_some_other_secret'),
      signed(body, stale),
      { ...signed(body), 'paddle-signature': 'ts=1;h1=nothex' },
    ]) {
      const res = await post(body, headers);
      expect([res.statusCode, res.body]).toEqual([401, '']);
    }
    const changed = await post(body.replace('"quantity":3', '"quantity":30'), signed(body));
    expect(changed.statusCode).toBe(401);
    expect(
      await h.db.owner.query('select 1 from billing_events where event_id = $1', ['evt_test_web_2']),
    ).toMatchObject({
      rows: [],
    });
    const logged = lines.join('');
    expect(logged).toContain('billing-signature-missing');
    expect(logged).toContain('billing-signature-mismatch');
    expect(logged).toContain('billing-signature-stale');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(signed(body)['paddle-signature']);
  });

  it('reads any content type raw, and refuses a body over 1 MiB', async () => {
    const body = createdFor(signups.acme, 'evt_test_web_3');
    const res = await post(body, { ...signed(body), 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(200);
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect((await post(big, signed(big))).statusCode).toBe(413);
  });

  it('answers 200 to a signed body that is not an event, and to a type it ignores', async () => {
    const junk = 'not json';
    expect((await post(junk, signed(junk))).statusCode).toBe(200);
    const other = JSON.stringify({
      event_id: 'evt_test_web_4',
      event_type: 'transaction.completed',
      occurred_at: new Date().toISOString(),
      data: {},
    });
    expect((await post(other, signed(other))).statusCode).toBe(200);
    const rows = await h.db.owner.query('select outcome from billing_events where event_id = $1', ['evt_test_web_4']);
    expect(rows.rows).toEqual([{ outcome: 'ignored' }]);
  });

  it('refuses two Paddle-Signature headers as malformed', async () => {
    const body = createdFor(signups.acme, 'evt_test_web_7');
    const one = signed(body)['paddle-signature'];
    const res = await h.app.inject({
      method: 'POST',
      url: '/billing/paddle',
      headers: { 'content-type': 'application/json', 'paddle-signature': [one, one], host: ENTRY },
      payload: body,
    });
    expect([res.statusCode, res.body]).toEqual([401, '']);
    expect(lines.join('')).toContain('billing-signature-malformed');
  });

  it('answers 500 to a cancel before its created, so the retry after the created applies it', async () => {
    const ref = 'sub_test_web_late';
    // The created happened first; Paddle delivers the cancel first all the same.
    const created = createdFor(signups.beta, 'evt_test_web_9', ref);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const canceled = bodyOf('subscription.canceled', 'evt_test_web_8', { id: ref });
    const first = await post(canceled, signed(canceled));
    expect([first.statusCode, first.body]).toEqual([500, '']);
    const outcome = (eventId: string) =>
      h.db.owner.query('select outcome from billing_events where event_id = $1', [eventId]);
    expect((await outcome('evt_test_web_8')).rows).toEqual([]);
    expect((await post(created, signed(created))).statusCode).toBe(200);
    expect((await post(canceled, signed(canceled))).statusCode).toBe(200);
    expect((await outcome('evt_test_web_8')).rows).toEqual([{ outcome: 'applied' }]);
    const beta = await h.db.owner.query('select status, suspended_reason from tenants where id = $1', [betaId]);
    expect(beta.rows[0]).toEqual({ status: 'suspended', suspended_reason: 'canceled' });
    expect(lines.join('')).toContain('billing-ref-unknown');
  });

  it('is not on a tenant host', async () => {
    const body = createdFor(signups.acme, 'evt_test_web_5');
    expect((await post(body, signed(body), 'acme.app.test')).statusCode).toBe(404);
  });
});

describeDb('the billing webhook on a database failure (spec §22.5)', () => {
  let h: IdentityHarness;
  beforeAll(async () => {
    h = await identityHarness({
      env: SMTP,
      configure: hosted,
      control: true,
      modules: [
        controlPlaneModule({
          apply: () => Promise.reject(Object.assign(new Error('connection terminated'), { code: '57P01' })),
        }),
      ],
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers 500 with an empty body, so Paddle retries', async () => {
    const body = createdFor('9b1f0c3e-6c1d-4c8e-9a51-2f4b7d0e1a23', 'evt_test_web_6');
    const res = await h.app.inject({
      method: 'POST',
      url: '/billing/paddle',
      headers: { ...signed(body), host: ENTRY },
      payload: body,
    });
    expect([res.statusCode, res.body]).toEqual([500, '']);
  });
});
