/**
 * The hosted recipe end to end (hosted edition spec §22.17, §11's control-plane line; slice 7 Task 33): a hosted server
 * started from its environment, as an operator starts one, through `loadConfig` and `serve`'s own start-up, on a real
 * listener, with mail through a real SMTP conversation and a fake Paddle that posts signed webhook fixtures. A team
 * signs up, pays, signs in, makes a working team (a team, a workspace, a first push read back), is suspended when its
 * subscription is canceled, is exported by the operator (and the export verifies offline) and is deleted, leaving no
 * row on the control role and no directory.
 *
 * Success criterion 5 (§13.5): signup to a working team in under five minutes with no operator. A clock runs from the
 * form's first post to the snapshot read back; the SMTP sink and the fake Paddle stand in for the person's steps, so
 * the bound shows no step waits on a slow job, and no operator command and no control-loop tick runs in between. The
 * webhook finishes the signup itself (`signupCompleter`); the loop's `signup-finish` step, which picks up a signup
 * bound 10 minutes ago, is only the fallback when Paddle stops retrying.
 *
 * The fake signs each fixture as Paddle documents it: `Paddle-Signature: ts=<unix>;h1=<hex>`, HMAC-SHA256 over
 * `<ts>:<raw body>` under the notification destination's secret, a placeholder here. No real key, no real domain: the
 * host names go in `Host`, so nothing resolves. The control loop's clock and timer are the one thing injected, so the
 * 14 days before a deletion pass in a moment.
 *
 * It runs in CI's `hosted-e2e` job (`WIREBENCH_SERVER_HOSTED_E2E=1`) and skips elsewhere: the per-part suites cover
 * each step on its own, and this one only shows that the real start-up wires them together.
 */
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paddleSignature } from '../../../src/control-plane/billing/signature.js';
import { CONTROL_LOOP_MS } from '../../../src/control-plane/loop.js';
import { controlPlaneModule } from '../../../src/control-plane/module.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { hostModule } from '../../../src/host/module.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { browserBuildFixture, type BrowserBuildFixture } from '../../helpers/browser-build.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { hostedEnv, TEST_APP_DOMAIN, TEST_ENTRY_HOST, TEST_PADDLE_WEBHOOK_SECRET } from '../../helpers/hosted-env.js';
import { freePort } from '../../helpers/net.js';
import { smtpSink, type SmtpSink } from '../../helpers/smtp-sink.js';
import { manualTimers } from '../../helpers/timers.js';

const describeHosted = process.env.WIREBENCH_SERVER_HOSTED_E2E === '1' ? describeDb : describe.skip;

const FIXTURES = fileURLToPath(new URL('../../fixtures/paddle/', import.meta.url));
const PASSWORD = 'correct horse battery staple';
const SLUG = 'acme';
const EMAIL = 'owner@customer.test';
const HOST = `${SLUG}.${TEST_APP_DOMAIN}`;
const DAY_MS = 24 * 3_600_000;
/** Success criterion 5 (spec §13.5): signup to a working team in under five minutes. */
const WORKING_TEAM_WITHIN_MS = 5 * 60_000;

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** One HTTP request to the listener, `Host` set as the proxy in front would pass it. */
function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Retries `fn` until it returns a value, for what reaches another part of the server through the bus. */
async function eventually<T>(fn: () => Promise<T | undefined>, what: string, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A message's text as sent: quoted-printable soft breaks and escapes undone. */
function textOf(data: string): string {
  return data
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

describeHosted('the hosted server end to end (spec §22.17)', () => {
  let db: TestDatabase;
  let dataDir: string;
  let browser: BrowserBuildFixture;
  let smtp: SmtpSink;
  let control: ControlDb;
  let running: RunningServer;
  let env: Record<string, string>;
  let port: number;
  /** The control plane's clock, moved forward for the deletion's 14 days. */
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const timers = manualTimers();
  let signupId = '';
  let tenantId = '';
  let cookie = '';
  let n = 0;
  /** When the signup form was first posted (`performance.now()`), for criterion 5. */
  let startedAt = 0;
  /** Operator commands run, and control-loop ticks fired: neither may come between the form and a working team. */
  let operatorCommands = 0;
  let loopTicks = 0;

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir();
    browser = await browserBuildFixture();
    smtp = await smtpSink();
    port = await freePort();
    env = hostedEnv({
      db,
      dataDir,
      port,
      internalPort: await freePort(),
      smtpPort: smtp.port,
    });
    // The production list, with the browser build's stand-in and the control plane's clock and timer.
    const modules = BUILTIN_MODULES.map((module) => {
      if (module.name === 'host') return hostModule({ browserRoot: browser.root });
      if (module.name === 'control-plane') return controlPlaneModule({ now, setTimer: timers.setTimer });
      return module;
    });
    running = await startServer(
      env,
      { stdout: { write: () => true }, stderr: { write: () => true }, env },
      { modules, signals: new EventEmitter(), exit: vi.fn() },
    );
    control = openControlDb(db.controlUrl);
  }, 120_000);
  afterAll(async () => {
    await running?.close();
    await control?.close();
    await smtp?.close();
    await browser?.remove();
    await db?.close();
    await removeTempDir(dataDir);
  });

  const form = (host: string) => ({
    host,
    origin: `https://${host}`,
    'content-type': 'application/x-www-form-urlencoded',
  });
  /** Paddle's `subscription.*` fixture, for this subscription, signed as Paddle signs it, posted to the webhook. */
  const webhook = async (type: string, ref: string, data: Record<string, unknown> = {}) => {
    n++;
    const raw = JSON.parse(await readFile(join(FIXTURES, `subscription.${type}.json`), 'utf8')) as {
      data: Record<string, unknown>;
    };
    const at = now();
    const body = JSON.stringify({
      ...raw,
      event_id: `evt_test_e2e_${String(n)}`,
      occurred_at: at.toISOString(),
      data: { ...raw.data, id: ref, ...data },
    });
    const ts = Math.floor(at.getTime() / 1000);
    return http(
      port,
      'POST',
      '/billing/paddle',
      {
        host: TEST_ENTRY_HOST,
        'content-type': 'application/json',
        'paddle-signature': `ts=${String(ts)};h1=${paddleSignature(TEST_PADDLE_WEBHOOK_SECRET, ts, body)}`,
      },
      body,
    );
  };
  const cli = async (argv: readonly string[]) => {
    operatorCommands++;
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...argv], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      env: { ...env },
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };
  const signIn = () =>
    http(
      port,
      'POST',
      '/sign-in/local',
      form(HOST),
      new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
    );

  it('signs up and pays: the signup form, its mail, the password step and a signed subscription.created', async () => {
    startedAt = performance.now();
    const posted = await http(
      port,
      'POST',
      '/signup',
      form(TEST_ENTRY_HOST),
      new URLSearchParams({ email: EMAIL, name: 'Acme', slug: SLUG, seats: '3' }).toString(),
    );
    expect(posted.status).toBeLessThan(400);
    const mail = await eventually(
      () => Promise.resolve(smtp.messages.find((message) => message.to.includes(EMAIL))),
      'the signup mail',
    );
    const token = /\/signup\/([A-Za-z0-9_-]{43})/.exec(textOf(mail.data))![1]!;
    const checkout = await http(
      port,
      'POST',
      `/signup/${token}`,
      form(TEST_ENTRY_HOST),
      new URLSearchParams({ password: PASSWORD }).toString(),
    );
    expect(checkout.status).toBe(200);
    // The id Paddle's overlay carries back as its custom data.
    signupId = /data-signup="([0-9a-f-]{36})"/.exec(checkout.body)![1]!;

    const paid = await webhook('created', 'sub_test_e2e', { custom_data: { signup: signupId } });
    expect(paid.status).toBe(200);
    // The webhook finishes the signup before it answers: ready on the first poll, with no loop tick in between.
    const polled = await http(port, 'GET', `/signup/${token}/status`, { host: TEST_ENTRY_HOST });
    const status = JSON.parse(polled.body) as { status: string; url?: string };
    expect(status.status).toBe('ready');
    expect(status.url).toBe(`https://${HOST}/sign-in`);
    const row = await control.query<{ id: string; edition: string; status: string }>(
      'select id::text, edition, status from tenants where slug = $1',
      [SLUG],
    );
    expect(row.rows).toMatchObject([{ edition: 'team', status: 'active' }]);
    tenantId = row.rows[0]!.id;
  });

  it('signs in on the team’s own host as its server admin', async () => {
    // The directory's change reaches the resolver over the bus.
    const signedIn = await eventually(async () => {
      const res = await signIn();
      return res.status === 303 && res.headers['set-cookie'] !== undefined ? res : undefined;
    }, 'the sign-in');
    cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    const me = await http(port, 'GET', '/api/v1/me', { host: HOST, cookie });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ user: { email: EMAIL, serverAdmin: true } });
  });

  it('makes a working team within five minutes of the form, with no operator: a team, a workspace, a first push', async () => {
    const api = (method: string, path: string, body?: unknown) =>
      http(
        port,
        method,
        `/api/v1${path}`,
        {
          host: HOST,
          cookie,
          // A cookie write carries the tenant's own Origin, as the browser client sends it (§17.2).
          ...(body !== undefined ? { origin: `https://${HOST}`, 'content-type': 'application/json' } : {}),
        },
        body !== undefined ? JSON.stringify(body) : undefined,
      );
    // A signup makes the tenant and its first user, no team: the new admin makes one.
    const team = await api('POST', '/teams', { name: 'Payments QA' });
    expect(team.status, team.body).toBe(201);
    const teamId = (JSON.parse(team.body) as { id: string }).id;
    const workspace = await api('POST', `/teams/${teamId}/workspaces`, { name: 'Orders API' });
    expect(workspace.status, workspace.body).toBe(201);
    expect(JSON.parse(workspace.body)).toMatchObject({ teamId, myRole: 'admin' });
    const ws = `/workspaces/${(JSON.parse(workspace.body) as { id: string }).id}`;
    const empty = await api('GET', `${ws}/sync/head`);
    expect(JSON.parse(empty.body)).toMatchObject({ head: null, commits: 0 });
    const pushed = await api('POST', `${ws}/sync/commits`, {
      parent: null,
      commits: [
        {
          subject: 'First commit',
          at: new Date().toISOString(),
          changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: Orders API\n' }],
        },
      ],
    });
    expect(pushed.status, pushed.body).toBe(201);
    const { head } = JSON.parse(pushed.body) as { head: string };
    const read = await api('GET', `${ws}/sync/head`);
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ head, commits: 1, role: 'admin' });
    const snapshot = await api('GET', `${ws}/sync/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(JSON.parse(snapshot.body)).toEqual({
      head,
      files: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: Orders API\n' }],
    });
    const elapsed = performance.now() - startedAt;
    expect(startedAt).toBeGreaterThan(0);
    expect(elapsed, `${String(Math.round(elapsed))} ms from the form to a working team`).toBeLessThan(
      WORKING_TEAM_WITHIN_MS,
    );
    // Nothing between the form and here waited on an operator or on the control loop.
    expect(operatorCommands).toBe(0);
    expect(loopTicks).toBe(0);
  });

  it('is suspended when its subscription is canceled: the API refuses, and no one signs in', async () => {
    expect((await webhook('canceled', 'sub_test_e2e')).status).toBe(200);
    const refused = await eventually(async () => {
      const res = await http(port, 'GET', '/api/v1/me', { host: HOST, cookie });
      return res.status === 403 ? res : undefined;
    }, 'the suspension');
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'tenant-suspended', reason: 'canceled' });
    const again = await signIn();
    expect(again.headers['set-cookie']).toBeUndefined();
    const tenant = await control.query('select status, suspended_reason from tenants where id = $1', [tenantId]);
    expect(tenant.rows).toEqual([{ status: 'suspended', suspended_reason: 'canceled' }]);
  });

  it('is exported by the operator while suspended, and the export verifies offline', async () => {
    const file = join(dataDir, 'acme-export.tar.gz');
    const exported = await cli(['admin', 'tenant', 'export', SLUG, '--out', file]);
    expect(exported.code, exported.stderr).toBe(0);
    await access(file);
    const verified = await cli(['admin', 'audit', 'verify', '--export', file]);
    expect(verified.code, verified.stdout + verified.stderr).toBe(0);
  });

  it('is deleted 14 days after the operator asks: no row of it on the control role, no directory, no host', async () => {
    const asked = await cli(['admin', 'tenant', 'delete', SLUG]);
    expect(asked.code, asked.stderr).toBe(0);
    const root = join(dataDir, 'tenants', tenantId);
    await access(root);
    offsetMs = 15 * DAY_MS;
    await eventually(
      async () => {
        loopTicks += timers.fire(CONTROL_LOOP_MS);
        const left = await control.query('select 1 from tenants where id = $1', [tenantId]);
        return left.rowCount === 0 ? true : undefined;
      },
      'the deletion',
      300,
    );
    // Every table the policy holds, read past it on the control role.
    const tables = await control.query<{ table: string }>(
      `select relname as table from pg_class
        where relnamespace = to_regnamespace(current_schema()) and relkind = 'r' and relforcerowsecurity`,
    );
    expect(tables.rows.length).toBeGreaterThan(10);
    for (const { table } of tables.rows) {
      const rows = await control.query(`select 1 from "${table}" where tenant_id = $1 limit 1`, [tenantId]);
      expect(rows.rowCount, table).toBe(0);
    }
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const retired = await control.query('select redirect_to from tenant_slugs_retired where slug = $1', [SLUG]);
    expect(retired.rows).toEqual([{ redirect_to: null }]);
    const gone = await eventually(async () => {
      const res = await http(port, 'GET', '/api/v1/me', { host: HOST, cookie });
      return res.status === 404 ? res : undefined;
    }, 'the host to go');
    expect(gone.status).toBe(404);
  });
});
