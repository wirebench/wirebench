/**
 * `--tenant <slug>` on the admin command line (hosted edition spec §19.11): hosted mode requires it and works in
 * the tenant it names; self-hosted mode refuses it as a usage error. Hosted mode comes through `runAdmin`'s test
 * seam, since `loadConfig` refuses it (§19.1).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { runAdmin } from '../../../src/identity/cli.js';
import { newId } from '../../../src/identity/tokens.js';
import * as schedulesRepo from '../../../src/schedules/repo.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { license, PAYLOAD, testKeys } from '../../helpers/licensing.js';

const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

describeDb('admin --tenant (spec §19.11)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tenancy: Tenancy;
  let beta: TenantScope;
  let dir: string;
  const keys = testKeys();
  beforeAll(async () => {
    db = await testDatabase();
    dir = await mkTempDir();
    tenancy = createTenancy(db);
    await directoryOf(tenancy).load();
    const admin = new TenantAdmin(db, directoryOf(tenancy));
    await admin.create({ slug: 'acme', name: 'Acme' });
    beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
  });
  afterAll(async () => {
    await db.close();
    await removeTempDir(dir);
  });
  const options = { configure: hosted, publicKeys: [keys.publicKey] };

  const io = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
        env: {
          WIREBENCH_SERVER_DATABASE_URL: db.url,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
        },
      },
      stdout: () => stdout.join(''),
      stderr: () => stderr.join(''),
    };
  };

  it('hosted: admin invite --tenant acme invites into acme, with acme’s URL', async () => {
    const out = io();
    const code = await runAdmin(
      { command: 'admin-invite', email: 'ada@example.com', serverAdmin: true, tenant: 'acme' },
      out.io,
      { configure: hosted },
    );
    expect(code, out.stderr()).toBe(0);
    expect(out.stdout()).toMatch(/\nhttps:\/\/acme\.example\.test\/invite\/[A-Za-z0-9_-]{43}\n/);
    const listed = io();
    expect(
      await runAdmin({ command: 'admin-list-invitations', tenant: 'acme' }, listed.io, { configure: hosted }),
    ).toBe(0);
    expect(listed.stdout()).toContain('ada@example.com');
  });

  it('hosted: the SCIM commands are refused, as SCIM is not served there (Task 15 review M2)', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-scim-token-list', tenant: 'acme' }, out.io, { configure: hosted })).toBe(1);
    expect(out.stderr()).toContain('sso-scim-hosted-off');
  });

  it('hosted: a slug no tenant has is refused', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-list-invitations', tenant: 'nobody' }, out.io, { configure: hosted })).toBe(
      1,
    );
    expect(out.stderr()).toContain('tenancy-tenant-unknown');
  });

  it('hosted: without --tenant, a usage error', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-list-invitations' }, out.io, { configure: hosted })).toBe(2);
    expect(out.stderr()).toContain('--tenant <slug> is required in hosted mode');
    expect(out.stderr()).toContain('try --help');
  });

  it('self-hosted: --tenant is a usage error, and without it the default tenant answers', async () => {
    const refused = io();
    expect(await runAdmin({ command: 'admin-list-invitations', tenant: 'acme' }, refused.io)).toBe(2);
    expect(refused.stderr()).toContain('--tenant applies to hosted mode only');
    const plain = io();
    expect(await runAdmin({ command: 'admin-list-invitations' }, plain.io)).toBe(0);
  });

  it('hosted: --tenant default is unknown, as the resolver serves no default tenant (Task 16 review M2)', async () => {
    const out = io();
    expect(
      await runAdmin(
        { command: 'admin-invite', email: 'lost@example.com', serverAdmin: false, tenant: 'default' },
        out.io,
        { configure: hosted },
      ),
    ).toBe(1);
    expect(out.stderr()).toContain('tenancy-tenant-unknown');
    expect(out.stdout()).toBe('');
  });

  it('hosted: a license installed with --tenant acme is acme’s alone (Task 16 review M3)', async () => {
    const path = join(dir, 'team.lic');
    await writeFile(path, `${license(keys)}\n`);
    expect(await runAdmin({ command: 'admin-license-install', file: path, tenant: 'acme' }, io().io, options)).toBe(0);
    const inAcme = io();
    expect(await runAdmin({ command: 'admin-license-show', tenant: 'acme' }, inAcme.io, options)).toBe(0);
    expect(inAcme.stdout()).toContain('Team (active)');
    const inBeta = io();
    expect(await runAdmin({ command: 'admin-license-show', tenant: 'beta' }, inBeta.io, options)).toBe(0);
    expect(inBeta.stdout()).toContain('Community (none)');
    expect(inBeta.stdout()).not.toContain(PAYLOAD.id);
  });

  it('hosted: admin schedules list --tenant lists that tenant’s schedules only (Task 16 review M3)', async () => {
    const tdb = tenancy.db(beta);
    const team = await teamsRepo.insertTeam(tdb, { id: newId(), name: 'Beta team', at: new Date() });
    const workspaceId = newId();
    await teamsRepo.insertWorkspace(tdb, {
      id: workspaceId,
      name: 'Beta staging',
      teamId: team.id,
      defaultRole: 'viewer',
      createdBy: null,
      at: new Date(),
    });
    await schedulesRepo.insertSchedule(tdb, {
      id: newId(),
      workspaceId,
      name: 'Beta nightly',
      cron: '0 2 * * *',
      timeZone: 'UTC',
      target: { project: 'Billing' },
      options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
      alerts: { targets: [], muteAfter: 3 },
      enabled: true,
      nextRunAt: null,
      createdBy: null,
      at: new Date(),
    });
    const inAcme = io();
    expect(await runAdmin({ command: 'admin-schedules-list', tenant: 'acme' }, inAcme.io, options)).toBe(0);
    expect(inAcme.stdout()).not.toContain('Beta nightly');
    const inBeta = io();
    expect(await runAdmin({ command: 'admin-schedules-list', tenant: 'beta' }, inBeta.io, options)).toBe(0);
    expect(inBeta.stdout()).toContain('Beta nightly');
  });

  it('hosted: admin audit export --tenant exports that tenant’s events only (Task 16 review M3)', async () => {
    // Its own events, whatever ran before it: an invitation in each tenant.
    for (const [email, tenant] of [
      ['audit-acme@example.com', 'acme'],
      ['audit-beta@example.com', 'beta'],
    ] as const) {
      expect(await runAdmin({ command: 'admin-invite', email, serverAdmin: false, tenant }, io().io, options)).toBe(0);
    }
    const exported = async (tenant: string) => {
      const out = io();
      expect(await runAdmin({ command: 'admin-audit-export', tenant }, out.io, options), out.stderr()).toBe(0);
      return out.stdout();
    };
    const fromAcme = await exported('acme');
    const fromBeta = await exported('beta');
    // Each tenant's export has its own invitation's event, and never the other's.
    const invitedIn = (exported: string) =>
      exported
        .split('\n')
        .filter((line) => line.includes('user.invited'))
        .map((line) => (JSON.parse(line) as { target: { id: string } }).target.id);
    const acmeInvited = invitedIn(fromAcme);
    const betaInvited = invitedIn(fromBeta);
    expect(acmeInvited.length).toBeGreaterThan(0);
    expect(betaInvited.length).toBeGreaterThan(0);
    expect(acmeInvited.filter((id) => betaInvited.includes(id))).toEqual([]);
    expect(fromAcme).toContain('audit-acme@example.com');
    expect(fromBeta).toContain('audit-beta@example.com');
    expect(fromAcme).not.toContain('audit-beta');
    expect(fromBeta).not.toContain('audit-acme');
  });
});
