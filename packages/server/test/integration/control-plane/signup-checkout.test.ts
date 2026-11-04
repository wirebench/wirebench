/**
 * The signup's password and checkout steps (hosted edition spec §22.6; slice 7 Task 17): `GET` and `POST
 * /signup/:token`, then `GET /signup/:token/status`. An unknown, expired or used link shows one page; the password
 * minimum; the checkout page's policy names Paddle's origins only and a nonce, never `'unsafe-inline'` for scripts;
 * the status poll says `pending`, `ready` or `expired` and nothing more. Every key here is a placeholder.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH } from '@wirebench/engine';
import type { ServerConfig } from '../../../src/config.js';
import type { ControlMail } from '../../../src/control-plane/mail.js';
import { controlPlaneModule } from '../../../src/control-plane/module.js';
import { PADDLE_JS } from '../../../src/control-plane/signup/page.js';
import type { EntryQueue } from '../../../src/entry/queue.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
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
const PASSWORD = 'correct horse battery staple';

describeDb('the signup password and checkout steps (spec §22.6)', () => {
  let h: IdentityHarness;
  let queue: EntryQueue<unknown>;
  let now = new Date('2026-11-04T10:00:00.000Z');
  let n = 0;
  const sent: ControlMail[] = [];
  beforeAll(async () => {
    h = await identityHarness({
      env: SMTP,
      configure: hosted,
      control: true,
      modules: [
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
      beforeBuild: async (db) => {
        await ensureControlRole(db.owner, db.controlUrl, db.url);
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    now = new Date(now.getTime() + 24 * 3_600_000);
    n++;
  });

  /** A fresh signup's token, through the form and its mail. */
  async function signup(seats = 4): Promise<{ token: string; slug: string }> {
    n++;
    const slug = `checkout${String(n)}`;
    sent.length = 0;
    const res = await h.app.inject({
      method: 'POST',
      url: '/signup',
      headers: FORM,
      remoteAddress: `10.2.0.${String(n)}`,
      payload: new URLSearchParams({
        email: `owner${String(n)}@team.test`,
        name: 'Team <b>',
        slug,
        seats: String(seats),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    await queue.idle();
    const token = /\/signup\/([A-Za-z0-9_-]{43})/.exec(sent[0]!.text)![1]!;
    return { token, slug };
  }
  const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { host: ENTRY } });
  const postPassword = (token: string, password: string, headers: Record<string, string> = FORM) =>
    h.app.inject({
      method: 'POST',
      url: `/signup/${token}`,
      headers,
      payload: new URLSearchParams({ password }).toString(),
    });
  const status = async (token: string) => (await get(`/signup/${token}/status`)).json<Record<string, string>>();

  it('shows the password step and the price summary for an open link, escaping the name', async () => {
    const { token, slug } = await signup(4);
    const res = await get(`/signup/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain(`minlength="${String(MIN_PASSWORD_LENGTH)}"`);
    expect(res.body).toContain('4 seats');
    expect(res.body).toContain(`https://${slug}.app.test`);
    expect(res.body).toContain('Team &lt;b&gt;');
    expect(res.body).not.toContain(PADDLE_JS);
  });

  it('shows one page for an unknown, a malformed, an expired and a used link', async () => {
    const used = await signup();
    expect((await postPassword(used.token, PASSWORD)).statusCode).toBe(200);
    // Used up: the webhook completed it.
    await h.db.owner.query(
      `update signups set status = 'completed', tenant_id = gen_random_uuid(), password_hash = null where slug = $1`,
      [used.slug],
    );
    const late = await signup();
    now = new Date(now.getTime() + 24 * 3_600_000 + 1);
    const pages = [
      await get(`/signup/${'A'.repeat(43)}`),
      await get('/signup/not-a-token'),
      await get(`/signup/${late.token}`),
      await get(`/signup/${used.token}`),
      await postPassword(late.token, PASSWORD),
      await postPassword(used.token, PASSWORD),
    ];
    for (const res of pages) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(pages[0]!.body);
    }
    expect(pages[0]!.body).toContain('This link has expired');
  });

  it('refuses a password under the minimum and keeps the link open', async () => {
    const { token } = await signup();
    const res = await postPassword(token, 'x'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`at least ${String(MIN_PASSWORD_LENGTH)} characters`);
    expect(res.body).not.toContain(PADDLE_JS);
    const row = await h.db.owner.query<{ status: string; password_hash: string | null }>(
      'select status, password_hash from signups where token_hash is not null and slug = $1',
      [`checkout${String(n)}`],
    );
    expect(row.rows[0]).toEqual({ status: 'pending', password_hash: null });
    expect((await get(`/signup/${token}`)).statusCode).toBe(200);
  });

  it('refuses a password post from another origin, or none', async () => {
    const { token } = await signup();
    for (const origin of ['https://evil.test', undefined]) {
      const headers: Record<string, string> = { ...FORM };
      if (origin === undefined) delete headers.origin;
      else headers.origin = origin;
      expect((await postPassword(token, PASSWORD, headers)).statusCode).toBe(403);
    }
    expect((await get(`/signup/${token}`)).statusCode).toBe(200);
  });

  it("stores the password's scrypt hash, and renders the checkout with Paddle's origins only", async () => {
    const { token, slug } = await signup(6);
    const res = await postPassword(token, PASSWORD);
    expect(res.statusCode).toBe(200);
    const row = (
      await h.db.owner.query<{ id: string; status: string; password_hash: string }>(
        'select id::text, status, password_hash from signups where slug = $1',
        [slug],
      )
    ).rows[0]!;
    expect(row.status).toBe('verified');
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(PASSWORD);

    const csp = String(res.headers['content-security-policy']);
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)![1]!;
    expect(csp).toBe(
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://cdn.paddle.com`,
        "style-src 'unsafe-inline'",
        'frame-src https://sandbox-buy.paddle.com',
        "connect-src 'self' https://sandbox-checkout-service.paddle.com",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    // Two scripts, both under the nonce: Paddle.js from its CDN, and the page's own.
    const scripts = [...res.body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual([`<script src="${PADDLE_JS}" nonce="${nonce}">`, `<script nonce="${nonce}">`]);
    expect(res.body).toContain('data-environment="sandbox"');
    expect(res.body).toContain('data-token="test_placeholdertoken"');
    expect(res.body).toContain('data-price="pri_test_team"');
    expect(res.body).toContain('data-seats="6"');
    expect(res.body).toContain(`data-signup="${row.id}"`);
    expect(res.body).toContain(`data-status="/signup/${token}/status"`);
    expect(res.body).toContain("Paddle.Environment.set('sandbox')");
    expect(res.body).toContain('customData: { signup: d.signup }');
    // A fresh nonce each time the page is rendered.
    const other = await signup();
    const again = await postPassword(other.token, PASSWORD);
    expect(String(again.headers['content-security-policy'])).not.toContain(nonce);
  });

  it('answers the status poll: pending until completed, ready with the URL, expired for anything unknown', async () => {
    const { token, slug } = await signup();
    expect(await status(token)).toEqual({ status: 'pending' });
    await postPassword(token, PASSWORD);
    expect(await status(token)).toEqual({ status: 'pending' });
    // Past the link's expiry a verified signup may still be paid for: still pending.
    now = new Date(now.getTime() + 25 * 3_600_000);
    expect(await status(token)).toEqual({ status: 'pending' });
    expect(await status('A'.repeat(43))).toEqual({ status: 'expired' });
    expect(await status('short')).toEqual({ status: 'expired' });
    await h.db.owner.query(
      `update signups set status = 'completed', tenant_id = gen_random_uuid(), password_hash = null where slug = $1`,
      [slug],
    );
    const ready = await get(`/signup/${token}/status`);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.json()).toEqual({ status: 'ready', url: `https://${slug}.app.test/sign-in` });
  });

  it('answers expired for a pending link past its expiry', async () => {
    const { token } = await signup();
    now = new Date(now.getTime() + 24 * 3_600_000 + 1);
    expect(await status(token)).toEqual({ status: 'expired' });
  });

  it('renders the checkout again, with a fresh nonce, for a verified link, and the expired page once completed', async () => {
    const { token, slug } = await signup(5);
    const nonceOf = (csp: unknown) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(String(csp))![1]!;
    const first = await postPassword(token, PASSWORD);
    const reload = await get(`/signup/${token}`);
    expect(reload.statusCode).toBe(200);
    expect(reload.body).toContain(
      `<script src="${PADDLE_JS}" nonce="${nonceOf(reload.headers['content-security-policy'])}">`,
    );
    expect(reload.body).toContain('data-seats="5"');
    expect(reload.body).toContain(`data-status="/signup/${token}/status"`);
    expect(reload.headers['cache-control']).toBe('no-store');
    const again = await get(`/signup/${token}`);
    const nonces = [first, reload, again].map((res) => nonceOf(res.headers['content-security-policy']));
    expect(new Set(nonces).size).toBe(3);
    // Past the link's expiry it may still be paid for, so the checkout still opens; past the grace, it does not.
    now = new Date(now.getTime() + 25 * 3_600_000);
    expect((await get(`/signup/${token}`)).body).toContain(PADDLE_JS);
    now = new Date(now.getTime() + 8 * 24 * 3_600_000);
    expect((await get(`/signup/${token}`)).statusCode).toBe(404);
    now = new Date(now.getTime() - 8 * 24 * 3_600_000);
    await h.db.owner.query(
      `update signups set status = 'completed', tenant_id = gen_random_uuid(), password_hash = null where slug = $1`,
      [slug],
    );
    const done = await get(`/signup/${token}`);
    expect(done.statusCode).toBe(404);
    expect(done.body).toContain('This link has expired');
    expect(done.body).not.toContain(PADDLE_JS);
  });
});
