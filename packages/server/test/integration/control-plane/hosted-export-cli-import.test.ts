/**
 * Hosted edition spec §13 criterion 6, end to end through the command line (§22.9, §22.10, §22.14): one tenant of a
 * hosted server with two is exported with `admin tenant export <slug>`, the export verifies offline with
 * `admin audit verify --export`, and `admin tenant import` restores it into an empty self-hosted server. There the
 * chain verifies with `admin audit verify`, the exported tenant's users and workspaces are present and the other
 * tenant's are not, and every workspace syncs.
 */
import { join } from 'node:path';
import type { SyncHeadResponse, SyncPushResponse, SyncSnapshotResponse } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { derivedChainKey } from '../../../src/audit-log/chain/keys.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import type { ServerConfig } from '../../../src/config.js';
import { recordAudit, SYSTEM_SOURCE } from '../../../src/context.js';
import { runAdminTenant } from '../../../src/control-plane/cli.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantDb } from '../../../src/tenancy/tenant-db.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import type { IdentityHarness, SignedInUser } from '../../helpers/identity.js';
import { syncHarness } from '../../helpers/sync.js';
import { manualTimers } from '../../helpers/timers.js';
import { hosted, setEdition, twoTenants, type Tenant, type TwoTenants } from '../tenancy/modules/two-tenants.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

const CHAIN_KEY = 'test-chain-key-for-the-hosted-export-suite';
const AT = '2026-11-05T12:00:00.000Z';

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

/** A team with `admin` as its admin, and a repository-backed workspace per name on it, in `tenant`'s own rows. */
async function teamWithWorkspaces(t: TwoTenants, tenant: Tenant, admin: SignedInUser, names: readonly string[]) {
  const at = t.h.clock.now;
  const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: `${tenant.slug} team`, at });
  await teamsRepo.insertMember(tenant.tdb, { teamId: team.id, userId: admin.user.id, role: 'admin', at });
  const workspaces: string[] = [];
  for (const name of names) {
    const id = newId();
    await teamsRepo.insertWorkspace(tenant.tdb, {
      id,
      name,
      teamId: team.id,
      defaultRole: 'viewer',
      createdBy: null,
      at,
    });
    await t.h.repos.withLock(tenant.scope, id, () => t.h.repos.create(tenant.scope, id));
    workspaces.push(id);
  }
  return { team, workspaces };
}

/** The first commit on `workspaceId`, pushed through the tenant's own host. */
async function push(tenant: Tenant, user: SignedInUser, workspaceId: string, content: string): Promise<string> {
  const pushed = await tenant.call<SyncPushResponse>(user, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
    parent: null,
    commits: [{ subject: 'Start', at: AT, changes: [{ path: 'workspace.yaml', encoding: 'utf8', content }] }],
  });
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
  return pushed.body.head;
}

/** An audit event in `tenant`'s own chain, marked so a test can look for it after an import. */
function audited(t: TwoTenants, tenant: Tenant, note: string): Promise<void> {
  return tenant.tdb.transaction((tx) =>
    recordAudit(t.h.hooks, tx, {
      ...SYSTEM_SOURCE,
      action: 'audit.verified',
      target: { kind: 'server' },
      details: { note },
    }),
  );
}

/** A device token for an imported user, whose own tokens stayed behind (spec §22.10). */
async function tokenFor(h: IdentityHarness, tdb: TenantDb, email: string): Promise<string> {
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

/** Reads `workspaceId`'s head and its snapshot, then pushes one commit on it, which is accepted. */
async function syncs(
  h: IdentityHarness,
  token: string,
  workspaceId: string,
  expected: { readonly head: string | null; readonly content?: string },
) {
  const expectedHead = expected.head;
  const headers = { authorization: `Bearer ${token}` };
  const head = await h.app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/sync/head`, headers });
  expect(head.statusCode, head.body).toBe(200);
  expect(head.json<SyncHeadResponse>().head).toBe(expectedHead);
  const snapshot = await h.app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${workspaceId}/sync/snapshot`,
    headers,
  });
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  const files = snapshot.json<SyncSnapshotResponse>();
  expect(files.head).toBe(expectedHead);
  if (expected.content === undefined) expect(files.files).toEqual([]);
  else expect(files.files).toMatchObject([{ path: 'workspace.yaml', content: expected.content }]);
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
  expect(pushed.json<SyncPushResponse>().head).not.toBe(expectedHead);
}

describeDb('a hosted tenant exported and imported through the command line (spec §13.6, §22.14)', () => {
  describeGit('into an empty self-hosted server', () => {
    let t: TwoTenants;
    let dir: string;
    const closing: (() => Promise<void>)[] = [];
    beforeEach(async () => {
      t = await twoTenants({ modules: (clock) => [teamsModule({ now: () => clock.now }), syncModule()] });
      t.h.hooks.audit.push(auditHook(() => t.h.clock.now));
      dir = await mkTempDir('wbs-hosted-portable-');
    }, SETUP_MS);
    afterEach(async () => {
      for (const close of closing.splice(0).reverse()) await close();
      await t.close();
      await removeTempDir(dir);
    }, SETUP_MS);

    it('exports one tenant, which verifies offline and restores with its chain intact, without the other, and syncs', async () => {
      const { a, b } = t;
      await setEdition(t, a, 'team');
      await setEdition(t, b, 'team');
      // Tenant A: two users, a team, a pushed workspace and an empty one, and an audit event of its own.
      const ann = await a.user({ email: 'ann@acme.test', serverAdmin: true });
      await a.user({ email: 'avi@acme.test' });
      const acme = await teamWithWorkspaces(t, a, ann, ['Acme staging', 'Acme empty']);
      const [pushedWorkspace, emptyWorkspace] = acme.workspaces as [string, string];
      const head = await push(a, ann, pushedWorkspace, 'name: acme\n');
      await audited(t, a, 'acme only');
      // Tenant B: its own user, team, workspace, commit and event, none of which may leave with A.
      const bob = await b.user({ email: 'bob@beta.test', serverAdmin: true });
      const beta = await teamWithWorkspaces(t, b, bob, ['Beta staging']);
      const betaWorkspace = beta.workspaces[0]!;
      await push(b, bob, betaWorkspace, 'name: beta\n');
      await audited(t, b, 'beta only');
      // Each tenant's chain sealed under the key hosted mode derives for it, as the server's sealer seals it.
      await new AuditSealer({
        tenancy: t.h.ctx.tenancy,
        keys: (scope: TenantScope) => derivedChainKey(CHAIN_KEY, scope.tenantId),
        now: () => t.h.clock.now,
        setTimer: manualTimers().setTimer,
        log: t.h.app.log,
      }).runOnce();

      // The operator exports A by its slug on the hosted server.
      const file = join(dir, 'acme.tar.gz');
      const hostedWithControl = (config: ServerConfig): ServerConfig => ({
        ...hosted(config),
        controlDatabaseUrl: t.h.db.controlUrl,
      });
      const exported = io(envOf(t.h));
      expect(
        await runAdminTenant({ command: 'admin-tenant-export', slug: 'acme', out: file }, exported.io, {
          configure: hostedWithControl,
        }),
        exported.stderr(),
      ).toBe(0);
      expect(exported.stdout()).toMatch(/^Exported acme to .*acme\.tar\.gz: \d+ tables, 2 workspaces, sha256 /);

      // It verifies with no database at all.
      const offline = io({});
      expect(await main(['admin', 'audit', 'verify', '--export', file, '--json'], offline.io), offline.stderr()).toBe(
        0,
      );
      expect(JSON.parse(offline.stdout())).toMatchObject({ result: 'intact', unsealed: 0 });

      // Into an empty self-hosted server, whose one tenant it fills.
      const back = await syncHarness();
      closing.push(() => back.close());
      back.hooks.audit.push(auditHook(() => back.clock.now));
      const imported = io(envOf(back));
      expect(await runAdminTenant({ command: 'admin-tenant-import', file }, imported.io), imported.stderr()).toBe(0);
      expect(imported.stdout()).toMatch(/^Imported into default: \d+ rows in \d+ tables, 2 workspaces\n/);

      // The chain, sealed again under the self-hosted server's key from its first event, verifies on its database.
      const verified = io(envOf(back));
      expect(
        await main(['admin', 'audit', 'verify', '--json'], verified.io),
        verified.stdout() + verified.stderr(),
      ).toBe(0);
      expect(JSON.parse(verified.stdout())).toMatchObject({ result: 'intact', firstSeq: '1' });

      // A's users, team, workspaces and events came over; nothing of B's did.
      const emails = await back.tdb.query<{ email: string }>('select email from users order by email');
      expect(emails.rows.map((row) => row.email)).toEqual(['ann@acme.test', 'avi@acme.test']);
      const teams = await back.tdb.query<{ id: string }>('select id from teams');
      expect(teams.rows).toEqual([{ id: acme.team.id }]);
      const workspaces = await back.tdb.query<{ id: string }>('select id from workspaces order by id');
      expect(workspaces.rows.map((row) => row.id)).toEqual([...acme.workspaces].sort());
      const notes = await back.tdb.query<{ note: string }>(
        "select details ->> 'note' as note from audit_events where details ? 'note'",
      );
      expect(notes.rows.map((row) => row.note)).toEqual(['acme only']);
      expect(await back.repos.exists(back.tdb.scope, betaWorkspace)).toBe(false);

      // Every imported workspace syncs: head, snapshot, and a new commit pushed on it.
      const token = await tokenFor(back, back.tdb, ann.user.email);
      await syncs(back, token, pushedWorkspace, { head, content: 'name: acme\n' });
      await syncs(back, token, emptyWorkspace, { head: null });
    });
  });
});
