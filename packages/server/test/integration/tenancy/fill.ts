/**
 * The isolation suite's world (tenancy Task 19, hosted edition spec §19.13): a hosted server with every built-in
 * module, tenants acme (A) and beta (B), and `fill`, which puts rows of a tenant's in every scoped table through its
 * own routes and repositories and asserts each table holds one. Everything a tenant writes carries its slug (`acme…`
 * names, `@acme.example` emails), so a body that holds "acme" holds A's data.
 *
 * `fresh` makes a new row of a tenant's for a route template that uses one up (a delete, an accept, a rotate), so
 * the positive control and the probe never share it.
 */
import { markStepsDone } from '../../helpers/tenancy.js';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { RouteOptions } from 'fastify';
import { expect } from 'vitest';
import { agentModule } from '../../../src/agent/module.js';
import { chainKeys } from '../../../src/audit-log/chain/keys.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ciTokensModule } from '../../../src/ci-tokens/module.js';
import { hooksModule } from '../../../src/hooks/module.js';
import { hostModule } from '../../../src/host/module.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { licensingModule } from '../../../src/licensing/module.js';
import { liveModule } from '../../../src/live/module.js';
import type { AlertOutbox, DeliverAlert } from '../../../src/schedules/alerts/outbox.js';
import { schedulesModule } from '../../../src/schedules/module.js';
import type { Scheduler } from '../../../src/schedules/scheduler.js';
import { sessionLogsModule } from '../../../src/session-logs/module.js';
import { ssoModule } from '../../../src/sso/module.js';
import * as ssoRepo from '../../../src/sso/repo.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { isDefaultTenant } from '../../../src/tenancy/tenancy.js';
import { browserBuildFixture, type BrowserBuildFixture } from '../../helpers/browser-build.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { testDatabase } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { license, testKeys } from '../../helpers/licensing.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { SCHEDULES_KEY } from '../../helpers/schedules.js';
import { manualTimers, type ManualTimers } from '../../helpers/timers.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './modules/two-tenants.js';

export const PASSWORD = 'isolation password 0019';
export const CHAIN_KEY = 'test-chain-key-0123456789abcdefghij';
const AT = '2026-09-24T12:00:00.000Z';

export interface AgentKey {
  readonly publicKey: string;
  sign(message: string): string;
}

export function agentKey(): AgentKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** What `fill` made in one tenant: the ids a template sends, and every id a leaked body would carry. */
export interface Filled {
  readonly tenant: Tenant;
  /** A server admin with a password and a bearer token. */
  readonly admin: SignedInUser;
  /** A server admin's browser session: the cookie routes'. */
  readonly browser: SignedInUser;
  /** A team member with a password and a grant. */
  readonly member: SignedInUser;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly inviteSecret: string;
  readonly hookId: string;
  readonly hookSecret: string;
  readonly captureId: string;
  readonly ciToken: string;
  readonly scheduleId: string;
  readonly runId: string;
  readonly shareId: string;
  readonly sessionLogId: string;
  readonly pairingId: string;
  readonly agent: AgentKey;
  /** Every id of the tenant's this fill wrote or read back. */
  readonly ids: Set<string>;
}

export interface World {
  readonly t: TwoTenants;
  readonly a: Filled;
  readonly b: Filled;
  /** Every route the server registered. */
  readonly routes: readonly RouteOptions[];
  /** The modules the world registered, by name, in order: identity (the harness's) first. */
  readonly modules: readonly string[];
  readonly timers: ManualTimers;
  scheduler(): Scheduler;
  outbox(): AlertOutbox;
  /**
   * Waits for the writes a request led to but did not wait for: the terminal shares' and the license changes' audit
   * rows, and the scheduler pass a Run now kicked. A snapshot of A's rows taken before this can miss a row A's own request is still writing.
   */
  quiet(): Promise<void>;
  close(): Promise<void>;
}

/** The license key pair the world's licensing module trusts. */
export const LICENSE_KEYS = testKeys();
const keys = LICENSE_KEYS;

/**
 * Builds the world. With `policiesDisabled`, a throwaway schema whose scoped tables have row-level security
 * disabled (spec §19.13's negative run): the sweeps must fail there.
 */
export async function isolationWorld(options: { readonly policiesDisabled?: boolean } = {}): Promise<World> {
  const routes: RouteOptions[] = [];
  const timers = manualTimers();
  let scheduler: Scheduler | undefined;
  let outbox: AlertOutbox | undefined;
  let shareAudits: PendingWrites | undefined;
  let licenseAudits: PendingWrites | undefined;
  const deliver: DeliverAlert = () => Promise.resolve();
  const modules: string[] = [];
  const build: BrowserBuildFixture = await browserBuildFixture();
  const db = await testDatabase();
  if (options.policiesDisabled === true) {
    for (const table of SCOPED_TABLES) await db.owner.query(`alter table ${table} disable row level security`);
  }
  const t = await twoTenants({
    db,
    onRoute: (route) => routes.push(route),
    env: {
      WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
      WIREBENCH_SERVER_SECRETS_KEY: randomBytes(32).toString('base64'),
      WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: SCHEDULES_KEY,
      WIREBENCH_SERVER_AUDIT_CHAIN_KEY: CHAIN_KEY,
      WIREBENCH_SERVER_HOST_IDLE_MINUTES: '30',
    },
    modules: (clock) => {
      const now = () => clock.now;
      const list = [
        licensingModule({ now, publicKeys: [keys.publicKey] }),
        teamsModule({ now }),
        syncModule(),
        hooksModule({ now, setTimer: timers.setTimer }),
        ciTokensModule({ now }),
        liveModule({ now, setTimer: timers.setTimer }),
        schedulesModule({
          now,
          setTimer: timers.setTimer,
          startScheduler: false,
          execute: () => Promise.resolve(),
          deliver,
          onScheduler: (made) => {
            scheduler = made;
          },
          onOutbox: (made) => {
            outbox = made;
          },
        }),
        auditLogModule({
          now,
          setTimer: timers.setTimer,
          onLicenseWrites: (made) => {
            licenseAudits = made;
          },
        }),
        ssoModule({ now, sweepIntervalMs: 0 }),
        sessionLogsModule({ now, setTimer: timers.setTimer }),
        terminalSharesModule({
          now,
          setTimer: timers.setTimer,
          onAuditWrites: (made) => {
            shareAudits = made;
          },
        }),
        hostModule({ now, setTimer: timers.setTimer, browserRoot: build.root }),
        agentModule({ now, sweepIntervalMs: 0 }),
      ];
      modules.push('identity', ...list.map((module) => module.name));
      return list;
    },
  });
  // The host probes need the migration's steps done, as a start-up leaves them (spec §19.10).
  await markStepsDone(t.h.db.owner);
  const a = await fill(t, t.a);
  const b = await fill(t, t.b);
  return {
    t,
    a,
    b,
    routes,
    modules,
    timers,
    scheduler: () => scheduler!,
    outbox: () => outbox!,
    quiet: async () => {
      // Until all three are idle in one pass: one may start a write in another (Task 22 review m8).
      for (;;) {
        await shareAudits?.settled();
        await licenseAudits?.settled();
        await scheduler?.idle();
        const busy = (shareAudits?.pending ?? 0) + (licenseAudits?.pending ?? 0) + (scheduler?.running ?? 0);
        if (busy === 0) return;
      }
    },
    close: async () => {
      // Injected sockets stay in the WebSocket server's client set: the live module's grace timer is manual here.
      let closed = false;
      const closing = t.close().then(() => {
        closed = true;
      });
      for (let i = 0; i < 200 && !closed; i++) {
        timers.fire(2_000);
        await new Promise((done) => setTimeout(done, 25));
      }
      await closing;
      await db.close();
      await build.remove();
    },
  };
}

/** Bearer headers of `user`. */
export const bearer = (user: SignedInUser) => ({ authorization: `Bearer ${user.token}` });

/** A browser session's cookie and `Origin` on `tenant`'s host. */
export const cookie = (tenant: Tenant, user: SignedInUser) => ({
  cookie: `${sessionCookieName(tenant.origin)}=${user.token}`,
  origin: tenant.origin,
});

async function ok<T>(request: Promise<{ readonly status: number; readonly body: T }>, what: string): Promise<T> {
  const res = await request;
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

/** The files of a first commit of `workspaceId`, its `workspace.yaml` naming the server workspace. */
export async function firstCommitFiles(workspaceId: string) {
  return (await workspaceSnapshot([])).map((file) =>
    file.path === 'workspace.yaml'
      ? {
          path: file.path,
          encoding: 'utf8' as const,
          content: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
            .toString('utf8')
            .replace('workspace-smoke', workspaceId),
        }
      : file,
  );
}

/** Rows of `tenant`'s in every scoped table, through its routes where it has one and its repositories elsewhere. */
export async function fill(t: TwoTenants, tenant: Tenant): Promise<Filled> {
  const slug = tenant.slug;
  const at = t.h.clock.now;
  const ids = new Set<string>();
  const note = <T extends string>(id: T): T => {
    ids.add(id);
    return id;
  };
  const admin = await tenant.user({ email: `admin@${slug}.example`, password: PASSWORD, serverAdmin: true });
  const browser = await tenant.user({ email: `tab@${slug}.example`, kind: 'browser', serverAdmin: true });
  const member = await tenant.user({ email: `member@${slug}.example`, password: PASSWORD });
  for (const user of [admin, browser, member]) {
    note(user.user.id);
    note(user.tokenId);
  }
  const call = <T>(method: Parameters<Tenant['call']>[1], path: string, payload?: object) =>
    tenant.call<T>(admin, method, path, payload);

  // ---- licensing, identity
  await ok(call('PUT', '/license', { license: license(keys, { edition: 'enterprise', seats: 500 }) }), 'license');
  const invitation = await ok(
    call<{ id: string; url: string }>('POST', '/invitations', { email: `invitee@${slug}.example` }),
    'invitation',
  );
  note(invitation.id);
  await identityRepo.insertOidcIdentity(tenant.tdb, {
    issuer: 'https://idp.example.test',
    subject: `${slug}-subject`,
    userId: member.user.id,
    at,
  });
  await identityRepo.insertFlow(tenant.tdb, {
    id: note(newId()),
    codeChallenge: sha256(`${slug}-verifier`),
    loopbackPort: 53682,
    deviceName: `${slug} laptop`,
    state: randomBytes(16).toString('hex'),
    nonce: randomBytes(16).toString('hex'),
    createdAt: at,
    expiresAt: new Date(at.getTime() + 600_000),
  });
  await tenant.tdb.query(
    `insert into browser_flows (id, provider, state_hash, redirect_to, expires_at, created_at)
     values ($1, 'oidc', $2, '/', $3, $4)`,
    [note(newId()), sha256(`${slug}-browser-state`), new Date(at.getTime() + 600_000), at],
  );

  // ---- teams and the workspace, through the routes
  const team = await ok(call<{ id: string }>('POST', '/teams', { name: `${slug} payments` }), 'team');
  note(team.id);
  await ok(call('POST', `/teams/${team.id}/members`, { email: member.user.email, role: 'member' }), 'member');
  note(
    (
      await ok(
        call<{ id: string }>('POST', `/teams/${team.id}/invitations`, {
          email: `contractor@${slug}.example`,
          role: 'member',
        }),
        'team invitation',
      )
    ).id,
  );
  const workspace = await ok(
    call<{ id: string }>('POST', `/teams/${team.id}/workspaces`, { name: `${slug} staging` }),
    'workspace',
  );
  const workspaceId = note(workspace.id);
  await ok(call('PUT', `/workspaces/${workspaceId}/access/${member.user.id}`, { role: 'editor' }), 'grant');
  await ok(
    call('PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: true, recordSessionLogs: true }),
    'recording',
  );
  const pushed = await ok(
    call<{ head: string }>('POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: `${slug} start`, at: AT, changes: await firstCommitFiles(workspaceId) }],
    }),
    'push',
  );
  note(pushed.head);

  // ---- webhook capture and CI tokens
  const hook = await ok(
    call<{ id: string; url: string }>('POST', `/workspaces/${workspaceId}/hooks`, { name: `${slug} callback` }),
    'hook',
  );
  note(hook.id);
  const hookSecret = new URL(hook.url).pathname.split('/').pop()!;
  const captured = await tenant.inject({
    method: 'POST',
    url: `/hooks/${hookSecret}/events`,
    headers: { 'content-type': 'application/json' },
    payload: `{"tenant":"${slug}"}`,
  });
  expect(captured.statusCode).toBeLessThan(300);
  const captures = await ok(
    call<{ id: string }[]>('GET', `/workspaces/${workspaceId}/hooks/${hook.id}/captures`),
    'captures',
  );
  const captureId = note(captures[0]!.id);
  const ci = await ok(
    call<{ id: string; token: string }>('POST', `/workspaces/${workspaceId}/ci-tokens`, { name: `${slug} pipeline` }),
    'ci token',
  );
  note(ci.id);

  // ---- scheduled runs: a schedule with a webhook alert, a run started by Run now, a result and an alert row
  const schedule = await ok(
    call<{ id: string }>('POST', `/workspaces/${workspaceId}/schedules`, {
      name: `${slug} nightly`,
      schedule: '@daily',
      target: { project: 'Billing' },
      alerts: { targets: [{ kind: 'webhook', url: `https://hooks.example.test/${slug}`, secret: `${slug}-shh` }] },
    }),
    'schedule',
  );
  const scheduleId = note(schedule.id);
  const run = await ok(call<{ id: string }>('POST', `/workspaces/${workspaceId}/schedules/${scheduleId}/runs`), 'run');
  const runId = note(run.id);
  await tenant.tdb.query(`insert into schedule_results (run_id, ordinal, result) values ($1, 0, $2)`, [
    runId,
    JSON.stringify({
      path: `${slug}/health`,
      group: slug,
      name: `${slug} health`,
      protocol: 'rest',
      outcome: 'passed',
    }),
  ]);
  await tenant.tdb.query(
    `insert into schedule_alert_outbox (id, schedule_id, run_id, target_index, kind, payload, state, created_at)
     values ($1, $2, $3, 0, 'failure', $4, 'delivered', $5)`,
    [note(newId()), scheduleId, runId, JSON.stringify({ tenant: slug }), at],
  );

  // ---- terminal shares (in memory) and session logs
  const share = await ok(
    call<{ shareId: string }>('POST', `/workspaces/${workspaceId}/terminal-shares`, {
      hostName: `${slug}-web`,
      cols: 80,
      rows: 24,
    }),
    'share',
  );
  const opened = await ok(
    call<{ id: string }>('POST', `/workspaces/${workspaceId}/session-logs`, sessionLogBody(slug)),
    'session log',
  );
  const sessionLogId = note(opened.id);
  await ok(
    call('POST', `/workspaces/${workspaceId}/session-logs/${sessionLogId}/chunks`, {
      offset: 0,
      data: Buffer.from(`$ ${slug} uptime\r\n`).toString('base64'),
    }),
    'chunk',
  );

  // ---- SSO, at the repository level (not served hosted until slice 7)
  await ssoRepo.insertSamlIdentity(tenant.tdb, {
    entityId: 'https://idp.example.test/saml',
    nameId: `${slug}-name-id`,
    userId: member.user.id,
    at,
  });
  await ssoRepo.insertSamlFlow(tenant.tdb, {
    id: note(newId()),
    requestId: `_${randomBytes(16).toString('hex')}`,
    codeChallenge: sha256(`${slug}-saml`),
    loopbackPort: 53683,
    deviceName: `${slug} saml laptop`,
    relayState: randomBytes(16).toString('hex'),
    createdAt: at,
    expiresAt: new Date(at.getTime() + 600_000),
  });
  await ssoRepo.insertScimToken(tenant.tdb, {
    id: note(newId()),
    name: `${slug} provisioning`,
    tokenHash: mintToken().hash,
    createdBy: admin.user.id,
    at,
  });
  await ssoRepo.upsertScimUser(tenant.tdb, member.user.id, `${slug}-external`, at);
  const groupId = note(newId());
  await ssoRepo.insertScimGroup(tenant.tdb, { id: groupId, displayName: `${slug} engineers`, externalId: null, at });
  await ssoRepo.setGroupTeam(tenant.tdb, groupId, team.id, at);
  await ssoRepo.addGroupMembers(tenant.tdb, groupId, [member.user.id]);
  await ssoRepo.insertProvisioned(tenant.tdb, { teamId: team.id, userId: member.user.id, groupId });

  // ---- the local agent, through the routes: a pairing, a nonce, and a code left unused
  const agent = agentKey();
  const code = await tenant.inject({
    method: 'POST',
    url: '/api/v1/agent/pairing-codes',
    headers: cookie(tenant, browser),
  });
  expect(code.statusCode, code.body).toBe(201);
  const paired = await tenant.inject({
    method: 'POST',
    url: '/api/v1/agent/pairings',
    payload: {
      code: code.json<{ code: string }>().code,
      agentId: `${slug}-agent`,
      publicKey: agent.publicKey,
      port: 47615,
      sshOptIn: false,
    },
  });
  expect(paired.statusCode, paired.body).toBe(201);
  const pairingId = note(paired.json<{ pairingId: string }>().pairingId);
  const nonce = await tenant.inject({
    method: 'POST',
    url: '/api/v1/agent/nonces',
    headers: cookie(tenant, browser),
    payload: { pairingId },
  });
  expect(nonce.statusCode, nonce.body).toBe(201);
  expect(
    (await tenant.inject({ method: 'POST', url: '/api/v1/agent/pairing-codes', headers: cookie(tenant, browser) }))
      .statusCode,
  ).toBe(201);

  // ---- the host's lease table, used from Part E: a row by hand
  await tenant.tdb.query(
    `insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at) values ($1, $2, $3, $3, $4)`,
    [browser.user.id, `${slug}-holder`, at, new Date(at.getTime() + 60_000)],
  );

  // ---- the audit log: forward one recorded event (no sink is configured), so the queue holds a row too
  // Named by tenant: the negative run's schema has the policy off.
  const event = (
    await tenant.tdb.query<{ id: string }>('select id from audit_events where tenant_id = $1 order by id limit 1', [
      tenant.scope.tenantId,
    ])
  ).rows[0]!;
  await tenant.tdb.query('insert into audit_forward_queue (event_id) values ($1)', [event.id]);
  // Seal what the routes recorded, so the tenant's chain anchor exists.
  await sealerOf(t).runOnce();

  await expectFilled(tenant);
  return {
    tenant,
    admin,
    browser,
    member,
    teamId: team.id,
    workspaceId,
    inviteSecret: new URL(invitation.url).pathname.split('/').pop()!,
    hookId: hook.id,
    hookSecret,
    captureId,
    ciToken: ci.token,
    scheduleId,
    runId,
    shareId: share.shareId,
    sessionLogId,
    pairingId,
    agent,
    ids,
  };
}

export function sessionLogBody(slug: string) {
  return {
    clientLogId: `20261101T000000Z-${randomBytes(4).toString('hex')}`,
    hostId: `${slug}-host`,
    hostName: `${slug}-web`,
    address: '10.0.0.1',
    port: 22,
    user: 'ops',
    startedAt: AT,
  };
}

/** The positive control of spec §19.13: at least one row in every scoped table, counted in the tenant's own scope. */
export async function expectFilled(tenant: Tenant): Promise<void> {
  const empty: string[] = [];
  for (const table of SCOPED_TABLES) if ((await countIn(tenant, table)) === 0) empty.push(table);
  expect(empty, `scoped tables with no row of ${tenant.slug}'s`).toEqual([]);
}

/** An audit sealer over the server's tenancy, with the module's own key for each tenant. */
export function sealerOf(t: TwoTenants): AuditSealer {
  return new AuditSealer({
    tenancy: t.h.ctx.tenancy,
    keys: chainKeysOf(t),
    now: () => t.h.clock.now,
    setTimer: () => ({ cancel: () => undefined }),
    log: t.h.app.log,
  });
}

/** Each tenant's chain key, as the audit module derives it. */
export function chainKeysOf(t: TwoTenants) {
  return chainKeys(CHAIN_KEY, t.h.ctx.config.mode, (scope) => isDefaultTenant(t.h.ctx.tenancy, scope));
}

// ---- fresh rows a template uses up --------------------------------------------------------------

/** Notes `id` in `f.ids`, so the leak check knows a row the sweep made in A (Task 19 review M2). */
const noted = (f: Filled, id: string): string => {
  f.ids.add(id);
  return id;
};

export const fresh = {
  /** A user of `tenant`'s with a password, and a token of their own; its ids go into `ids` when given (A's). */
  async user(tenant: Tenant, kind?: 'browser', ids?: Set<string>): Promise<SignedInUser> {
    const user = await tenant.user({
      email: `u-${newId().toLowerCase()}@${tenant.slug}.example`,
      password: PASSWORD,
      ...(kind !== undefined ? { kind } : {}),
    });
    ids?.add(user.user.id);
    ids?.add(user.tokenId);
    return user;
  },
  /** Another device token of one of `f`'s users. */
  async token(f: Filled, user: SignedInUser): Promise<string> {
    const id = noted(f, newId());
    await identityRepo.insertToken(f.tenant.tdb, {
      id,
      userId: user.user.id,
      tokenHash: mintToken().hash,
      deviceName: `${f.tenant.slug} spare`,
      at: new Date(),
    });
    return id;
  },
  async invitation(f: Filled): Promise<{ id: string; secret: string }> {
    const made = await ok(
      f.tenant.call<{ id: string; url: string }>(f.admin, 'POST', '/invitations', {
        email: `i-${newId().toLowerCase()}@${f.tenant.slug}.example`,
      }),
      'fresh invitation',
    );
    return { id: noted(f, made.id), secret: new URL(made.url).pathname.split('/').pop()! };
  },
  async team(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', '/teams', { name: `${f.tenant.slug} t-${newId()}` }),
      'fresh team',
    );
    return noted(f, made.id);
  },
  async member(f: Filled): Promise<SignedInUser> {
    const user = await fresh.user(f.tenant, undefined, f.ids);
    await ok(
      f.tenant.call(f.admin, 'POST', `/teams/${f.teamId}/members`, { email: user.user.email, role: 'member' }),
      'fresh member',
    );
    return user;
  },
  async teamInvitation(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/teams/${f.teamId}/invitations`, {
        email: `ti-${newId().toLowerCase()}@${f.tenant.slug}.example`,
        role: 'member',
      }),
      'fresh team invitation',
    );
    return noted(f, made.id);
  },
  async workspace(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/teams/${f.teamId}/workspaces`, {
        name: `${f.tenant.slug} w-${newId()}`,
      }),
      'fresh workspace',
    );
    return noted(f, made.id);
  },
  async hook(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/workspaces/${f.workspaceId}/hooks`, {
        name: `${f.tenant.slug} h-${newId()}`,
      }),
      'fresh hook',
    );
    return noted(f, made.id);
  },
  async ciToken(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/workspaces/${f.workspaceId}/ci-tokens`, {
        name: `${f.tenant.slug} c-${newId()}`,
      }),
      'fresh ci token',
    );
    return noted(f, made.id);
  },
  async schedule(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/workspaces/${f.workspaceId}/schedules`, {
        name: `${f.tenant.slug} s-${newId()}`,
        schedule: '@daily',
        target: { project: 'Billing' },
      }),
      'fresh schedule',
    );
    return noted(f, made.id);
  },
  async queuedRun(f: Filled): Promise<{ scheduleId: string; runId: string }> {
    const scheduleId = await fresh.schedule(f);
    const run = await ok(
      f.tenant.call<{ id: string }>(f.admin, 'POST', `/workspaces/${f.workspaceId}/schedules/${scheduleId}/runs`),
      'fresh run',
    );
    return { scheduleId, runId: noted(f, run.id) };
  },
  async sessionLog(f: Filled): Promise<string> {
    const made = await ok(
      f.tenant.call<{ id: string }>(
        f.admin,
        'POST',
        `/workspaces/${f.workspaceId}/session-logs`,
        sessionLogBody(f.tenant.slug),
      ),
      'fresh session log',
    );
    return noted(f, made.id);
  },
  async code(f: Filled): Promise<string> {
    const res = await f.tenant.inject({
      method: 'POST',
      url: '/api/v1/agent/pairing-codes',
      headers: cookie(f.tenant, f.browser),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ code: string }>().code;
  },
  async pairing(f: Filled): Promise<{ pairingId: string; key: AgentKey }> {
    const key = agentKey();
    const res = await f.tenant.inject({
      method: 'POST',
      url: '/api/v1/agent/pairings',
      payload: {
        code: await fresh.code(f),
        agentId: `agent-${newId()}`,
        publicKey: key.publicKey,
        port: 47615,
        sshOptIn: false,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { pairingId: noted(f, res.json<{ pairingId: string }>().pairingId), key };
  },
  async nonce(f: Filled, pairingId = f.pairingId): Promise<string> {
    const res = await f.tenant.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: cookie(f.tenant, f.browser),
      payload: { pairingId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ nonce: string }>().nonce;
  },
};
