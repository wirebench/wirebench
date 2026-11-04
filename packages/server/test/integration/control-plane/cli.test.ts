/**
 * `wirebench-server admin tenant …` (hosted edition spec §22.14; slice 7 Task 8) against a hosted test schema: each
 * command, the self-hosted refusals, the first admin's invitation mailed or printed, and the bus announcement a
 * running instance hears.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminTenantCommand } from '../../../src/args.js';
import type { ServerConfig } from '../../../src/config.js';
import { cluster, serverHooks } from '../../../src/context.js';
import { runAdminTenant, type InvitationMail } from '../../../src/control-plane/cli.js';
import { createDatabase, openSession } from '../../../src/db/pool.js';
import type { Database } from '../../../src/db/querier.js';
import { main } from '../../../src/main.js';
import { NotificationBus } from '../../../src/operations/bus.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

const APP_DOMAIN = 'example.test';
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

describeDb('admin tenant (hosted spec §22.14)', () => {
  let db: TestDatabase;
  /** The control role: past the policy, so the checks read every tenant's rows. */
  let control: Database;
  beforeEach(async () => {
    db = await testDatabase();
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    control = createDatabase(db.controlUrl);
  });
  afterEach(async () => {
    await control.close();
    await db.close();
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => err.push(t) },
        env: {
          WIREBENCH_SERVER_DATABASE_URL: db.url,
          WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_SECRETS_KEY: SECRETS_KEY,
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
        },
      },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  };
  const hosted =
    (extra: Partial<ServerConfig> = {}) =>
    (config: ServerConfig): ServerConfig => ({
      ...config,
      mode: 'hosted',
      appDomain: APP_DOMAIN,
      controlDatabaseUrl: db.controlUrl,
      ...extra,
    });
  const run = async (command: AdminTenantCommand, options: Parameters<typeof runAdminTenant>[2] = {}) => {
    const out = io();
    const code = await runAdminTenant(command, out.io, { configure: hosted(), ...options });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  };
  const create = (slug: string, options: Parameters<typeof runAdminTenant>[2] = {}) =>
    run(
      {
        command: 'admin-tenant-create',
        slug,
        name: `${slug} GmbH`,
        email: `admin@${slug}.example`,
        edition: 'team',
        seats: 5,
      },
      options,
    );
  /** Exit 1 with `code` first on stderr. */
  const expectRefused = (result: { code: number; stderr: string }, code: string): void => {
    expect(result.code).toBe(1);
    expect(result.stderr.startsWith(`${code}: `), result.stderr).toBe(true);
  };
  const row = async (slug: string) =>
    (
      await control.query<Record<string, unknown>>(
        `select slug, status, suspended_reason, edition, edition_source, seats, deletion_requested_by, deleting_at
         from tenants where slug = $1`,
        [slug],
      )
    ).rows[0];

  it('refuses every command on a self-hosted server with admin-tenant-hosted-only', async () => {
    for (const argv of [
      ['admin', 'tenant', 'list'],
      ['admin', 'tenant', 'create', '--slug', 'acme', '--name', 'Acme', '--email', 'a@acme.example'],
      ['admin', 'tenant', 'set-edition', 'acme', 'enterprise'],
      ['admin', 'tenant', 'suspend', 'acme'],
      ['admin', 'tenant', 'resume', 'acme'],
      ['admin', 'tenant', 'rename', 'acme', 'acme-ag'],
      ['admin', 'tenant', 'delete', 'acme'],
    ]) {
      const out = io();
      expect(await main(argv, out.io), argv.join(' ')).toBe(2);
      expect(out.stderr()).toMatch(/^admin-tenant-hosted-only: /);
    }
    expect((await control.query('select slug from tenants')).rows).toEqual([{ slug: 'default' }]);
  });

  it('create without SMTP prints the server-admin invitation, in the new tenant, on its host', async () => {
    const made = await create('acme');
    expect(made).toMatchObject({ code: 0, stderr: '' });
    expect(made.stdout).toContain('Created acme: active, team (operator), 5 seats');
    expect(made.stdout).toContain('No SMTP is configured');
    expect(made.stdout).toMatch(/\nhttps:\/\/acme\.example\.test\/invite\/[A-Za-z0-9_-]{43}\n/);
    expect(await row('acme')).toMatchObject({ edition: 'team', edition_source: 'operator', seats: 5 });
    const invitations = await control.query<{ email: string; server_admin: boolean; tenant: string }>(
      `select i.email, i.server_admin, t.slug as tenant from invitations i join tenants t on t.id = i.tenant_id`,
    );
    expect(invitations.rows).toEqual([{ email: 'admin@acme.example', server_admin: true, tenant: 'acme' }]);
    const audit = await control.query<{ action: string }>(
      `select a.action from audit_events a join tenants t on t.id = a.tenant_id where t.slug = 'acme' order by a.action`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['tenant.created', 'user.invited']);
    // A taken slug is refused.
    expectRefused(await create('acme'), 'control-plane-slug-taken');
  });

  it('create with SMTP mails the invitation through the operator’s SMTP and prints no link', async () => {
    const sent: { to: string; subject: string; text: string; from: string }[] = [];
    const mail: InvitationMail = (smtp, to, message) => {
      sent.push({ to, from: smtp.from, ...message });
      return Promise.resolve();
    };
    const made = await create('acme', {
      configure: hosted({ smtpUrl: 'smtp://mail.test:587', smtpFrom: 'ops@wirebench.test' }),
      mail,
    });
    expect(made.code).toBe(0);
    expect(made.stdout).toContain('Mailed a server-admin invitation to admin@acme.example');
    expect(made.stdout).not.toContain('/invite/');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'admin@acme.example', from: 'ops@wirebench.test' });
    expect(sent[0]!.text).toMatch(/https:\/\/acme\.example\.test\/invite\/[A-Za-z0-9_-]{43}/);
  });

  it('list, set-edition, suspend, resume, rename and delete', async () => {
    await create('acme');
    await create('beta');
    const listed = await run({ command: 'admin-tenant-list' });
    expect(listed.code).toBe(0);
    const lines = listed.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^SLUG\s+STATUS\s+EDITION\s+SEATS\s+SUBSCRIPTION\s+DELETION$/);
    expect(lines.slice(1).map((line) => line.split(/\s+/)[0])).toEqual(['acme', 'beta']);
    expect(lines[1]).toMatch(/^acme\s+active\s+team \(operator\)\s+5\s+-\s+-$/);
    expect(listed.stdout).not.toContain('@');

    expect(
      await run({
        command: 'admin-tenant-set-edition',
        slug: 'acme',
        edition: 'enterprise',
        seats: 40,
        subscription: false,
      }),
    ).toMatchObject({ code: 0 });
    expect(await row('acme')).toMatchObject({ edition: 'enterprise', seats: 40, edition_source: 'operator' });
    expectRefused(
      await run({ command: 'admin-tenant-set-edition', slug: 'acme', subscription: true }),
      'control-plane-no-subscription',
    );

    expect(await run({ command: 'admin-tenant-suspend', slug: 'acme' })).toMatchObject({ code: 0 });
    expect(await row('acme')).toMatchObject({ status: 'suspended', suspended_reason: 'operator' });
    expect((await run({ command: 'admin-tenant-list' })).stdout).toMatch(/\nacme\s+suspended \(operator\)\s/);
    expect(await run({ command: 'admin-tenant-resume', slug: 'acme' })).toMatchObject({ code: 0 });
    expect(await row('acme')).toMatchObject({ status: 'active', suspended_reason: null });
    expect((await run({ command: 'admin-tenant-resume', slug: 'acme' })).stdout).toBe('acme was not suspended\n');

    const renamed = await run({ command: 'admin-tenant-rename', slug: 'beta', to: 'beta-ag' });
    expect(renamed).toMatchObject({ code: 0 });
    expect(renamed.stdout).toContain('https://beta-ag.example.test');
    expect(await row('beta')).toBeUndefined();
    expectRefused(await run({ command: 'admin-tenant-rename', slug: 'acme', to: 'beta' }), 'control-plane-slug-taken');

    const deleted = await run({ command: 'admin-tenant-delete', slug: 'acme', cancel: false });
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain('--cancel');
    expect(await row('acme')).toMatchObject({ status: 'active', deletion_requested_by: 'operator' });
    expect((await row('acme'))?.['deleting_at']).toBeInstanceOf(Date);
    expect(await run({ command: 'admin-tenant-delete', slug: 'acme', cancel: true })).toMatchObject({ code: 0 });
    expect(await row('acme')).toMatchObject({ deletion_requested_by: null, deleting_at: null });

    expectRefused(await run({ command: 'admin-tenant-suspend', slug: 'nobody' }), 'control-plane-tenant-unknown');
  });

  it('a running instance hears the write on the bus', async () => {
    const hooks = serverHooks();
    const heard: unknown[] = [];
    hooks.tenantsChanged.push(cluster((event) => heard.push(event)));
    const bus = new NotificationBus({
      db,
      holder: randomUUID(),
      hooks,
      open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
      scopeFor: () => Promise.resolve(undefined),
      log: Fastify({ logger: false }).log,
    });
    await bus.start();
    try {
      await create('acme');
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), { timeout: 2_000, interval: 20 });
    } finally {
      await bus.stop(0);
    }
  });

  it('a hosted configuration without the control URL is refused before anything is opened', async () => {
    const out = io();
    expect(
      await runAdminTenant({ command: 'admin-tenant-list' }, out.io, {
        configure: (config) => {
          const withoutUrl = { ...hosted()(config) };
          Reflect.deleteProperty(withoutUrl, 'controlDatabaseUrl');
          return withoutUrl;
        },
      }),
    ).toBe(2);
    expect(out.stderr()).toContain('WIREBENCH_SERVER_CONTROL_DATABASE_URL');
  });
});
