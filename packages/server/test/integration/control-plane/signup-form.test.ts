/**
 * The signup form and its mail (hosted edition spec §22.6; slice 7 Task 16): `GET` and `POST /signup` on
 * `app.<app-domain>` only. The `Origin` check, the body limit, both rate limits (the slug's refusals spend them too),
 * a taken, reserved, retired or invalid slug shown again with its reason, the same answer for an address with or
 * without teams, and the mail's link holding the token once. Every key and address here is a placeholder.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { ControlMail } from '../../../src/control-plane/mail.js';
import { controlPlaneModule } from '../../../src/control-plane/module.js';
import { signupTokenHash } from '../../../src/control-plane/signup/repo.js';
import { SIGNUP_SENT, SIGNUP_PAGE_CSP } from '../../../src/control-plane/signup/page.js';
import type { EntryQueue } from '../../../src/entry/queue.js';
import * as repo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const SMTP = { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.test:2525', WIREBENCH_SERVER_SMTP_FROM: 'teams@site.test' };
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: 'app.test',
  siteDomain: 'site.test',
  paddleEnvironment: 'sandbox',
  paddleClientToken: 'test_placeholdertoken',
  paddleTeamPriceId: 'pri_test_team',
  paddleWebhookSecret: 'pdl_ntfset_test_placeholder_webhook_secret',
});
const ENTRY = 'app.app.test';
const ORIGIN = 'https://app.app.test';
const FORM = { host: ENTRY, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' };

describeDb('the signup form (spec §22.6)', () => {
  let h: IdentityHarness;
  let queue: EntryQueue<unknown>;
  let now = new Date('2026-11-04T10:00:00.000Z');
  let ip = 0;
  const sent: { to: readonly string[]; mail: ControlMail }[] = [];
  beforeAll(async () => {
    h = await identityHarness({
      env: SMTP,
      configure: hosted,
      control: true,
      modules: [
        controlPlaneModule({
          now: () => now,
          startLoop: false,
          send: (to, mail) => {
            sent.push({ to, mail });
            return Promise.resolve();
          },
          onSignupQueue: (made) => {
            queue = made as EntryQueue<unknown>;
          },
        }),
      ],
      beforeBuild: async (db, ctx) => {
        await ensureControlRole(db.owner, db.controlUrl, db.url);
        const acme = await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({
          slug: 'acme',
          name: 'Acme',
          edition: 'team',
          editionSource: 'subscription',
        });
        // An address that already has a team: the answer must not say so.
        await ctx.tenancy.db(acme.scope).transaction((tx) =>
          repo.insertUser(tx, {
            id: newId(),
            email: 'member@acme.test',
            displayName: 'member',
            serverAdmin: false,
            at: new Date(),
          }),
        );
        await db.owner.query(`insert into tenant_slugs_retired (slug, tenant_id) values ('oldname', $1::uuid)`, [
          acme.id,
        ]);
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await queue.idle();
    sent.length = 0;
    // A day on, so no bucket of one test limits the next; a fresh client address too.
    now = new Date(now.getTime() + 24 * 3_600_000);
    ip++;
  });

  const fields = (input: Partial<Record<'email' | 'name' | 'slug' | 'seats', string>>): string =>
    new URLSearchParams({ email: 'new@team.test', name: 'New team', slug: 'newteam', seats: '3', ...input }).toString();
  const post = (payload: string, headers: Record<string, string> = FORM, from = `10.1.0.${String(ip)}`) =>
    h.app.inject({ method: 'POST', url: '/signup', headers, payload, remoteAddress: from });
  const signupsOf = async (slug: string) =>
    (
      await h.db.owner.query<{ id: string; token_hash: string; email_lower: string; seats: number; expires_at: Date }>(
        'select id::text, token_hash, email_lower, seats, expires_at from signups where slug = $1',
        [slug],
      )
    ).rows;

  it('serves the form on the entry host only, with the sign-in policy and no cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/signup', headers: { host: ENTRY } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(SIGNUP_PAGE_CSP);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('action="/signup"');
    const tenant = await h.app.inject({ method: 'POST', url: '/signup', headers: { ...FORM, host: 'acme.app.test' } });
    expect(tenant.body).not.toContain(SIGNUP_SENT);
  });

  it('inserts the signup, answers "Check your inbox", and mails the link with the token once', async () => {
    const res = await post(fields({ email: 'Owner@Team.test', slug: 'teamone', seats: '7' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain(SIGNUP_SENT);
    const [row, ...more] = await signupsOf('teamone');
    expect(more).toEqual([]);
    expect(row).toMatchObject({ email_lower: 'owner@team.test', seats: 7 });
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row!.expires_at.getTime() - now.getTime()).toBe(24 * 3_600_000);
    await queue.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['owner@team.test']);
    const links = sent[0]!.mail.text.match(/https:\/\/app\.app\.test\/signup\/([A-Za-z0-9_-]+)/g) ?? [];
    expect(links).toHaveLength(1);
    const token = links[0]!.split('/').pop()!;
    expect(token).toHaveLength(43);
    // Only the token's hash is stored.
    expect(row!.token_hash).toBe(signupTokenHash(token));
    expect(row!.token_hash).not.toContain(token);
  });

  it('answers the same, byte for byte, for an address with teams and one without', async () => {
    const known = await post(fields({ email: 'member@acme.test', slug: 'knownone' }));
    ip++;
    const unknown = await post(fields({ email: 'nobody@team.test', slug: 'unknownone' }));
    expect(known.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    await queue.idle();
    expect(sent.map((s) => s.to[0])).toEqual(['member@acme.test', 'nobody@team.test']);
  });

  it('refuses another origin, or none, with 403 and does nothing', async () => {
    for (const origin of ['https://evil.test', 'https://acme.app.test', undefined]) {
      const headers: Record<string, string> = { ...FORM };
      if (origin === undefined) delete headers.origin;
      else headers.origin = origin;
      const res = await post(fields({ slug: 'originless' }), headers);
      expect(res.statusCode, String(origin)).toBe(403);
    }
    expect(await signupsOf('originless')).toEqual([]);
  });

  it('refuses a body over 4 KiB', async () => {
    const res = await post(fields({ name: 'x'.repeat(4200) }));
    expect(res.statusCode).toBe(413);
  });

  it('shows the form again for a taken, held, retired, reserved or invalid slug, and mails nothing', async () => {
    await post(fields({ slug: 'heldone' }));
    for (const [slug, reason] of [
      ['acme', 'taken'],
      ['heldone', 'taken'],
      ['oldname', 'taken'],
      ['www', 'reserved'],
      ['-bad', 'lower-case letters'],
    ] as const) {
      ip++;
      const res = await post(fields({ email: `probe-${slug}@team.test`, slug }));
      expect(res.statusCode).toBe(200);
      expect(res.body, slug).toContain(reason);
      expect(res.body).toContain('<form');
      expect(res.body).not.toContain(SIGNUP_SENT);
    }
    expect(await signupsOf('heldone')).toHaveLength(1);
    await queue.idle();
    expect(sent).toHaveLength(1);
  });

  it('shows the form again for a bad address, name or seat count, escaping what was typed', async () => {
    for (const [input, reason] of [
      [{ email: 'not an address' }, 'valid email'],
      [{ name: '' }, 'team name'],
      [{ name: 'x'.repeat(81) }, 'team name'],
      [{ name: 'two\nlines' }, 'team name'],
      [{ seats: '0' }, 'Seats'],
      [{ seats: '501' }, 'Seats'],
      [{ seats: '2.5' }, 'Seats'],
      [{ email: '<b>@x.test', name: '<script>' }, 'valid email'],
    ] as const) {
      ip++;
      const res = await post(fields({ slug: 'fieldsone', ...input }));
      expect(res.body, JSON.stringify(input)).toContain(reason);
      expect(res.body).not.toContain('<script>');
      expect(res.body).not.toContain('<b>@');
    }
    expect(await signupsOf('fieldsone')).toEqual([]);
  });

  it('answers "Check your inbox" over the client limit and does nothing, slug probes counted', async () => {
    for (const slug of ['acme', 'oldname', 'www', 'acme']) await post(fields({ email: `p-${slug}@x.test`, slug }));
    await post(fields({ slug: 'clientfive' }));
    const over = await post(fields({ slug: 'clientsix' }));
    expect(over.body).toContain(SIGNUP_SENT);
    expect(await signupsOf('clientfive')).toHaveLength(1);
    expect(await signupsOf('clientsix')).toEqual([]);
    // Over the limit, a taken slug is not answered either.
    expect((await post(fields({ slug: 'acme' }))).body).toContain(SIGNUP_SENT);
  });

  it('takes one address at most three times an hour, whatever the client', async () => {
    for (let i = 0; i < 5; i++) {
      ip++;
      const res = await post(fields({ email: 'same@team.test', slug: `sameaddr${String(i)}` }));
      expect(res.body).toContain(SIGNUP_SENT);
    }
    const rows = await h.db.owner.query("select 1 from signups where email_lower = 'same@team.test'");
    expect(rows.rows).toHaveLength(3);
    await queue.idle();
    expect(sent.filter((s) => s.to[0] === 'same@team.test')).toHaveLength(3);
  });

  it('creates at most ten signups a day per client address, refusals not counted, then inserts nothing', async () => {
    const tick = () => {
      // A minute apart, so the per-minute client bucket never limits; the daily one barely refills.
      now = new Date(now.getTime() + 60_000);
    };
    for (const slug of ['acme', 'oldname', 'www']) {
      tick();
      await post(fields({ email: `refused-${slug}@cap.test`, slug }));
    }
    for (let i = 0; i < 10; i++) {
      tick();
      const res = await post(fields({ email: `cap${String(i)}@cap.test`, slug: `capped${String(i)}` }));
      expect(res.body).toContain(SIGNUP_SENT);
    }
    tick();
    const over = await post(fields({ email: 'cap10@cap.test', slug: 'capped10' }));
    expect(over.body).toContain(SIGNUP_SENT);
    expect(await signupsOf('capped9')).toHaveLength(1);
    expect(await signupsOf('capped10')).toEqual([]);
    await queue.idle();
    expect(sent.filter((s) => s.to[0] === 'cap10@cap.test')).toEqual([]);
    // Another address is not limited by it.
    expect((await post(fields({ email: 'other@cap.test', slug: 'cappedother' }), FORM, '10.9.9.9')).body).toContain(
      SIGNUP_SENT,
    );
    expect(await signupsOf('cappedother')).toHaveLength(1);
    // A day on, the address may create again.
    now = new Date(now.getTime() + 24 * 3_600_000);
    await post(fields({ email: 'cap11@cap.test', slug: 'capped11' }));
    expect(await signupsOf('capped11')).toHaveLength(1);
  });
});
