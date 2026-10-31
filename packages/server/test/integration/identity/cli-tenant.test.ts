/**
 * `--tenant <slug>` on the admin command line (hosted edition spec §19.11): hosted mode requires it and works in
 * the tenant it names; self-hosted mode refuses it as a usage error. Hosted mode comes through `runAdmin`'s test
 * seam, since `loadConfig` refuses it (§19.1).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { runAdmin } from '../../../src/identity/cli.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

describeDb('admin --tenant (spec §19.11)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
    const tenancy = createTenancy(db);
    await directoryOf(tenancy).load();
    await new TenantAdmin(db, directoryOf(tenancy)).create({ slug: 'acme', name: 'Acme' });
  });
  afterAll(() => db.close());

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
});
