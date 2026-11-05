/**
 * `admin tenant export` and `admin tenant import` from the command line (slice 7 Task 22, hosted edition spec §22.9,
 * §22.10, §22.14), on a self-hosted server, where they are the two `admin tenant` commands that run: an export of its
 * one tenant verifies offline, imports into an empty server and prints what did not come back, and is refused by a
 * server that has users.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runAdminTenant } from '../../../src/control-plane/cli.js';
import { main } from '../../../src/main.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { syncHarness } from '../../helpers/sync.js';
import { CHAIN_KEY, exportFixture, type ExportFixture } from './export-fixture.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

/** The command line's environment for the server `h` runs. */
function envOf(h: IdentityHarness): Record<string, string> {
  return {
    WIREBENCH_SERVER_DATABASE_URL: h.db.url,
    WIREBENCH_SERVER_MIGRATION_DATABASE_URL: h.db.ownerUrl,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: h.dataDir,
    WIREBENCH_SERVER_AUDIT_CHAIN_KEY: CHAIN_KEY,
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  };
}

function io(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describeDb('admin tenant export and import (spec §22.14)', () => {
  describeGit('on a self-hosted server', () => {
    let x: ExportFixture;
    let dir: string;
    beforeEach(async () => {
      x = await exportFixture();
      dir = await mkTempDir('wbs-portable-');
    }, SETUP_MS);
    afterEach(async () => {
      await x.f.h.close();
      await removeTempDir(dir);
    }, SETUP_MS);

    it('exports its one tenant, which verifies offline and imports into an empty server', async () => {
      const out = join(dir, 'team.tar.gz');
      const exported = io(envOf(x.f.h));
      expect(await runAdminTenant({ command: 'admin-tenant-export', out }, exported.io)).toBe(0);
      expect(exported.stdout()).toMatch(
        /^Exported default to .*team\.tar\.gz: \d+ tables, 2 workspaces, sha256 [0-9a-f]{64}\n/,
      );
      const verified = io({});
      expect(await main(['admin', 'audit', 'verify', '--export', out], verified.io)).toBe(0);

      const back = await syncHarness();
      try {
        const imported = io(envOf(back));
        expect(
          await runAdminTenant({ command: 'admin-tenant-import', file: out }, imported.io),
          imported.stderr(),
        ).toBe(0);
        expect(imported.stdout()).toContain('Imported into default:');
        expect(imported.stdout()).toContain(`schedules ${x.scheduleId}: disabled`);
        expect(imported.stdout()).toContain(`catch_urls ${x.catchUrlId}: signature secret`);
        const users = await back.tdb.query<{ n: string }>('select count(*)::text as n from users');
        expect(users.rows[0]!.n).toBe('4');
      } finally {
        await back.close();
      }
    });

    it('refuses an import into a server that has users, and a slug, which a self-hosted server has no use for', async () => {
      const out = join(dir, 'team.tar.gz');
      expect(await runAdminTenant({ command: 'admin-tenant-export', out }, io(envOf(x.f.h)).io)).toBe(0);
      const refused = io(envOf(x.f.h));
      expect(await runAdminTenant({ command: 'admin-tenant-import', file: out }, refused.io)).toBe(1);
      expect(refused.stderr()).toMatch(/^import-target-not-empty: /);
      const slug = io(envOf(x.f.h));
      expect(await runAdminTenant({ command: 'admin-tenant-export', slug: 'acme', out }, slug.io)).toBe(2);
      expect(slug.stderr()).toMatch(/^admin-tenant-hosted-only: /);
    });
  });
});
