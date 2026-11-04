/**
 * Slice 7 Task 22 (hosted edition spec §22.10, §13 criterion 6): an export of a self-hosted server imports into a
 * hosted one and back into an empty self-hosted one, and every workspace syncs after; the audit chain is sealed again
 * under each target's key and `tenant.imported` keeps the source's seal; a non-empty target and a broken chain are
 * refused; an import a crash stopped half-way through its tables resumes.
 */
import { join } from 'node:path';
import type { SyncHeadResponse, SyncPushResponse } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { derivedChainKey } from '../../../src/audit-log/chain/keys.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { writeExport } from '../../../src/control-plane/export/export.js';
import { importHosted, importSelfHosted, type ImportDeps } from '../../../src/control-plane/export/import.js';
import { readTarGz, writeTarGz, type TarSource } from '../../../src/control-plane/export/tar.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { syncHarness } from '../../helpers/sync.js';
import { hosted } from '../tenancy/modules/two-tenants.js';
import { CHAIN_KEY, exportFixture, type ExportFixture } from './export-fixture.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

const AT = '2026-11-04T13:00:00.000Z';

/** What an import into `h`'s tenants needs. */
function importDeps(h: IdentityHarness, key: (scope: TenantScope) => string): ImportDeps {
  return {
    db: h.ctx.tenancy.db,
    repos: h.repos,
    git: h.ctx.git.withPlumbing(),
    dataDir: h.dataDir,
    hooks: h.hooks,
    chainKeyOf: key,
  };
}

/** A device token for an imported user, whose own tokens stayed behind (spec §22.10). */
async function tokenFor(h: IdentityHarness, scope: TenantScope, email: string): Promise<string> {
  const tdb = h.ctx.tenancy.db(scope);
  const user = (await tdb.query<{ id: string }>('select id from users where email = $1', [email])).rows[0]!;
  const { token, hash } = mintToken();
  await identityRepo.insertToken(tdb, {
    id: newId(),
    userId: user.id,
    tokenHash: hash,
    deviceName: 'after import',
    at: h.clock.now,
  });
  return token;
}

/** Reads `workspaceId`'s head and pushes one commit on it, on `host`. */
async function syncs(
  h: IdentityHarness,
  host: string | undefined,
  token: string,
  workspaceId: string,
  expectedHead: string,
) {
  const headers = { authorization: `Bearer ${token}`, ...(host !== undefined ? { host } : {}) };
  const head = await h.app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/sync/head`, headers });
  expect(head.statusCode, head.body).toBe(200);
  expect(head.json<SyncHeadResponse>().head).toBe(expectedHead);
  const pushed = await h.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/sync/commits`,
    headers,
    payload: {
      parent: expectedHead,
      commits: [
        {
          subject: 'After import',
          at: AT,
          changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: moved\n' }],
        },
      ],
    },
  });
  expect(pushed.statusCode, pushed.body).toBe(201);
  return pushed.json<SyncPushResponse>().head;
}

async function exportOf(x: { h: IdentityHarness; scope: TenantScope; key: string }, out: string) {
  return writeExport(
    {
      db: x.h.ctx.tenancy.db,
      repos: x.h.repos,
      git: x.h.ctx.git.withPlumbing(),
      dataDir: x.h.dataDir,
      version: '0.0.0-test',
      chainKey: x.key,
      now: () => x.h.clock.now,
    },
    x.scope,
    out,
  );
}

describeDb('a tenant import (spec §22.10)', () => {
  describeGit('round trips', () => {
    let x: ExportFixture;
    let dir: string;
    const closing: (() => Promise<void>)[] = [];
    beforeEach(async () => {
      x = await exportFixture();
      dir = await mkTempDir('wbs-import-');
    }, SETUP_MS);
    afterEach(async () => {
      for (const close of closing.splice(0).reverse()) await close();
      await x.f.h.close();
      await removeTempDir(dir);
    }, SETUP_MS);

    /** A hosted server with sync, its control role granted, and a lifecycle on it. */
    const hostedTarget = async () => {
      const h = await identityHarness({
        configure: hosted,
        control: true,
        modules: (clock) => [teamsModule({ now: () => clock.now }), syncModule()],
      });
      h.hooks.audit.push(auditHook(() => h.clock.now));
      await ensureControlRole(h.db.owner, h.db.controlUrl, h.db.url);
      const control: ControlDb = openControlDb(h.db.controlUrl);
      closing.push(async () => {
        await control.close();
        await h.close();
      });
      const lifecycle = new TenantLifecycle({
        control,
        tenancy: h.ctx.tenancy,
        hooks: h.hooks,
        now: () => h.clock.now,
      });
      return { h, lifecycle };
    };

    it('goes self-hosted → hosted → self-hosted, and every workspace syncs after each', async () => {
      const first = join(dir, 'first.tar.gz');
      await exportOf({ h: x.f.h, scope: x.scope, key: CHAIN_KEY }, first);

      // Into a hosted server: a new tenant, suspended while it imports, active after.
      const target = await hostedTarget();
      const keyOf = (scope: TenantScope) => derivedChainKey(CHAIN_KEY, scope.tenantId);
      const into = await importHosted(importDeps(target.h, keyOf), target.lifecycle, first, {
        slug: 'moved',
        name: 'Moved',
      });
      expect(into.tenant).toMatchObject({
        slug: 'moved',
        status: 'active',
        editionSource: 'operator',
        edition: 'team',
      });
      expect(into.report.notRestored).toEqual(
        expect.arrayContaining([
          { table: 'catch_urls', id: x.catchUrlId, what: 'signature secret' },
          { table: 'schedules', id: x.scheduleId, what: 'disabled' },
        ]),
      );
      const hostedDb = target.h.ctx.tenancy.db(into.scope);
      expect(
        (await hostedDb.query<{ enabled: boolean }>('select enabled from schedules where id = $1', [x.scheduleId]))
          .rows,
      ).toEqual([{ enabled: false }]);
      // The catch URL came back at a new address: a fresh secret, never the old one, never blank.
      const secret = (
        await hostedDb.query<{ secret: string }>('select secret from catch_urls where id = $1', [x.catchUrlId])
      ).rows[0]!.secret;
      expect(secret).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(secret).not.toBe('C'.repeat(26));
      // The chain, sealed again under the hosted tenant's key from the first event, verifies; the source's seal is kept.
      const verified = await verifyChain(hostedDb, keyOf(into.scope));
      expect(verified).toMatchObject({ kind: 'checked', result: 'intact', firstSeq: 1n });
      const imported = await hostedDb.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where action = 'tenant.imported'",
      );
      expect(imported.rows[0]!.details).toMatchObject({
        sourceTenantId: x.scope.tenantId,
        sourceLastSeq: expect.any(String) as string,
      });
      const hostedToken = await tokenFor(target.h, into.scope, x.f.admin.user.email);
      const hostedHead = await syncs(target.h, 'moved.example.test', hostedToken, x.pushedWorkspace, x.head);

      // Out of the hosted server and into an empty self-hosted one.
      const second = join(dir, 'second.tar.gz');
      await exportOf({ h: target.h, scope: into.scope, key: keyOf(into.scope) }, second);
      const back = await syncHarness();
      closing.push(() => back.close());
      back.hooks.audit.push(auditHook(() => back.clock.now));
      const report = await importSelfHosted(
        importDeps(back, () => 'another-servers-chain-key'),
        back.tdb.scope,
        second,
      );
      expect(report.resumed).toBe(false);
      expect(await verifyChain(back.tdb, 'another-servers-chain-key')).toMatchObject({ result: 'intact' });
      const backToken = await tokenFor(back, back.tdb.scope, x.f.admin.user.email);
      await syncs(back, undefined, backToken, x.pushedWorkspace, hostedHead);
      // The empty workspace came back as an empty repository.
      expect(await back.repos.exists(back.tdb.scope, x.emptyWorkspace)).toBe(true);
    });

    it('refuses a target that is not empty', async () => {
      const file = join(dir, 'x.tar.gz');
      await exportOf({ h: x.f.h, scope: x.scope, key: CHAIN_KEY }, file);
      await expect(
        importSelfHosted(
          importDeps(x.f.h, () => CHAIN_KEY),
          x.scope,
          file,
        ),
      ).rejects.toMatchObject({
        code: 'import-target-not-empty',
      });
    });

    it('refuses a broken chain, naming the event, before it writes anything', async () => {
      const file = join(dir, 'x.tar.gz');
      await exportOf({ h: x.f.h, scope: x.scope, key: CHAIN_KEY }, file);
      const sources: TarSource[] = [];
      for await (const entry of readTarGz(file)) {
        const data = await entry.buffer();
        sources.push({
          name: entry.name,
          data:
            entry.name === 'tables/audit_events.ndjson'
              ? Buffer.from(data.toString('utf8').replace('zoë', 'zoe'))
              : data,
        });
      }
      const edited = join(dir, 'edited.tar.gz');
      await writeTarGz(edited, sources);
      const back = await syncHarness();
      closing.push(() => back.close());
      await expect(
        importSelfHosted(
          importDeps(back, () => CHAIN_KEY),
          back.tdb.scope,
          edited,
        ),
      ).rejects.toMatchObject({
        code: 'import-chain-broken',
        message: expect.stringMatching(/edited at seq \d+ \(event \w+\)/) as string,
      });
      expect((await back.tdb.query<{ n: string }>('select count(*)::text as n from users')).rows[0]!.n).toBe('0');
    });

    it('refuses an audit event no link vouches for, added to the file after the export', async () => {
      const file = join(dir, 'x.tar.gz');
      await exportOf({ h: x.f.h, scope: x.scope, key: CHAIN_KEY }, file);
      const sources: TarSource[] = [];
      for await (const entry of readTarGz(file)) {
        const data = await entry.buffer();
        const forged = JSON.stringify({ id: '01JFORGED00000000000000000', action: 'user.created', chain_seq: null });
        sources.push({
          name: entry.name,
          data: entry.name === 'tables/audit_events.ndjson' ? Buffer.concat([data, Buffer.from(`${forged}\n`)]) : data,
        });
      }
      const edited = join(dir, 'forged.tar.gz');
      await writeTarGz(edited, sources);
      const back = await syncHarness();
      closing.push(() => back.close());
      await expect(
        importSelfHosted(
          importDeps(back, () => CHAIN_KEY),
          back.tdb.scope,
          edited,
        ),
      ).rejects.toMatchObject({
        code: 'import-chain-broken',
        message: expect.stringContaining('no link of its chain vouches for') as string,
      });
    });

    it('resumes an import a crash stopped half-way through its tables', async () => {
      const file = join(dir, 'x.tar.gz');
      await exportOf({ h: x.f.h, scope: x.scope, key: CHAIN_KEY }, file);
      const back = await syncHarness();
      closing.push(() => back.close());
      back.hooks.audit.push(auditHook(() => back.clock.now));
      const deps = importDeps(back, () => CHAIN_KEY);
      await expect(
        importSelfHosted(
          {
            ...deps,
            afterTable: (table) => {
              if (table === 'workspaces') throw new Error('crash');
            },
          },
          back.tdb.scope,
          file,
        ),
      ).rejects.toThrow('crash');
      // Users are in: a fresh import would be refused, this one resumes.
      expect(Number((await back.tdb.query<{ n: string }>('select count(*)::text as n from users')).rows[0]!.n)).toBe(4);
      const report = await importSelfHosted(deps, back.tdb.scope, file);
      expect(report.resumed).toBe(true);
      expect(Number((await back.tdb.query<{ n: string }>('select count(*)::text as n from users')).rows[0]!.n)).toBe(4);
      expect(
        Number((await back.tdb.query<{ n: string }>('select count(*)::text as n from workspaces')).rows[0]!.n),
      ).toBe(2);
      const token = await tokenFor(back, back.tdb.scope, x.f.admin.user.email);
      await syncs(back, undefined, token, x.pushedWorkspace, x.head);
    });
  });
});
