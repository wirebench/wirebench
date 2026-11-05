/**
 * A tenant worth exporting (slice 7 Tasks 20–22): the sync fixture's self-hosted server, with a pushed workspace and an
 * empty one, a catch URL with a sealed signature secret, a schedule with sealed secrets and alert targets, a setting
 * with a sealed field, and an audit chain sealed under {@link CHAIN_KEY}. The sealed values are marked, so a test can
 * look for them in an archive's bytes.
 */
import type { SyncChange, SyncPushResponse } from '@wirebench/engine';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { recordAudit, SYSTEM_SOURCE } from '../../../src/context.js';
import { ExportRunner, type ExportRunnerDeps } from '../../../src/control-plane/export/runner.js';
import { newId } from '../../../src/identity/tokens.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { syncFixture, seedSyncWorkspace, type SyncFixture } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';
import { manualTimers } from '../../helpers/timers.js';

export const CHAIN_KEY = 'test-chain-key-for-the-export-suite';

/** What must never be in an export: each sealed value the fixture wrote. */
export const SEALED_MARKERS = ['SEALED-SIGNATURE', 'SEALED-SCHEDULE-SECRET', 'SEALED-ALERT-URL', 'SEALED-SETTING'];

const AT = '2026-11-04T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });

export interface ExportFixture {
  readonly f: SyncFixture;
  readonly scope: TenantScope;
  readonly pushedWorkspace: string;
  readonly emptyWorkspace: string;
  readonly head: string;
  readonly catchUrlId: string;
  readonly scheduleId: string;
  /** Seals what is unsealed in the default tenant's chain. */
  seal(): Promise<void>;
  runner(overrides?: Partial<ExportRunnerDeps>): ExportRunner;
}

export async function exportFixture(): Promise<ExportFixture> {
  const f = await syncFixture();
  const h = f.h;
  h.hooks.audit.push(auditHook(() => h.clock.now));
  const scope = h.tdb.scope;
  const pushed = await call<SyncPushResponse>(h, f.admin, 'POST', `/workspaces/${f.workspaceId}/sync/commits`, {
    parent: null,
    commits: [{ subject: 'Start', at: AT, changes: [text('workspace.yaml', 'name: staging\n')] }],
  });
  if (pushed.status !== 201) throw new Error(`push: ${String(pushed.status)} ${JSON.stringify(pushed.body)}`);
  // A password hash, which an export carries so people sign in after an import.
  await h.tdb.query("insert into local_credentials (user_id, password_hash) values ($1, 'test-password-hash')", [
    f.admin.user.id,
  ]);
  const team = await seedTeam(h, { name: 'Ops', admins: [f.admin] });
  const emptyWorkspace = await seedSyncWorkspace(h, { team, name: 'Empty' });
  const catchUrlId = newId();
  await h.tdb.query(
    `insert into catch_urls (id, workspace_id, name, secret, signature, signature_secret, signature_hint)
     values ($1, $2, 'Callback', $3, '{"kind":"hmac-sha256"}', $4, 'TURE')`,
    [catchUrlId, f.workspaceId, 'C'.repeat(26), Buffer.from('SEALED-SIGNATURE')],
  );
  const scheduleId = newId();
  await h.tdb.query(
    `insert into schedules (id, workspace_id, name, cron, time_zone, target, options, alerts, secrets)
     values ($1, $2, 'Nightly', '0 3 * * *', 'UTC', '{"kind":"project"}', '{}', $3::jsonb, $4::jsonb)`,
    [
      scheduleId,
      f.workspaceId,
      JSON.stringify({ targets: [{ kind: 'webhook', url: 'SEALED-ALERT-URL' }], muteAfter: 3 }),
      JSON.stringify({ API_KEY: 'SEALED-SCHEDULE-SECRET' }),
    ],
  );
  await h.tdb.query(
    `insert into tenant_settings (section, value, sealed, updated_by) values ('oidc', '{"issuer":"https://idp.test"}', $1, 'operator')`,
    [Buffer.from('SEALED-SETTING')],
  );
  await h.tdb.transaction((tx) =>
    recordAudit(h.hooks, tx, {
      ...SYSTEM_SOURCE,
      action: 'audit.verified',
      target: { kind: 'server' },
      details: { note: 'zoë ü', n: 1.5, list: ['b', 1, true] },
      ip: '2001:db8::7',
    }),
  );
  const timers = manualTimers();
  const sealer = new AuditSealer({
    tenancy: h.ctx.tenancy,
    keys: () => CHAIN_KEY,
    now: () => h.clock.now,
    setTimer: timers.setTimer,
    log: h.app.log,
  });
  const seal = async (): Promise<void> => {
    await sealer.runOnce();
  };
  await seal();
  return {
    f,
    scope,
    pushedWorkspace: f.workspaceId,
    emptyWorkspace,
    head: pushed.body.head,
    catchUrlId,
    scheduleId,
    seal,
    runner: (overrides = {}) =>
      new ExportRunner({
        db: h.ctx.tenancy.db,
        repos: h.repos,
        git: h.ctx.git.withPlumbing(),
        dataDir: h.dataDir,
        version: '0.0.0-test',
        chainKeyOf: () => CHAIN_KEY,
        hooks: h.hooks,
        log: h.app.log,
        now: () => h.clock.now,
        ...overrides,
      }),
  };
}
