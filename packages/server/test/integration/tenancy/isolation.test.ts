/**
 * The cross-tenant isolation suite (tenancy Task 19, hosted edition spec §19.13): every table, every route, every
 * socket, every job and the keys, on a hosted server with tenants acme (A) and beta (B), both filled through their own
 * routes and repositories. Positive controls come first, so that the suite cannot pass for the wrong reason:
 * - `fill` counts a row of each tenant's in every scoped table, in that tenant's scope;
 * - every route template answers 2xx as A's admin on A's host before it is sent as B;
 * - as the admin superuser, which bypasses the policy, every scoped table shows rows of both tenants, while the app
 *   role sees only the scope it set;
 * - the table and route sweeps run again on a throwaway schema with the policies disabled, and must fail there.
 *
 * Each module's own two-tenant cases are in `modules/` (Task 18); this suite is the sweep that refuses a table or a
 * route nobody classified.
 */
import { LIVE_CLOSE, LIVE_PATH, TERMINAL_SHARE_CLOSE, TERMINAL_SHARE_PATH } from '@wirebench/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyId } from '../../../src/audit-log/chain/canonical.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { announce } from '../../../src/context.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { Database } from '../../../src/db/querier.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { CaptureSweeper, SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { identitySettings } from '../../../src/identity/env.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { sweepExpired } from '../../../src/identity/sessions.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { AGENT_SWEEP_JOB, sweepAgent } from '../../../src/agent/module.js';
import * as hooksRepo from '../../../src/hooks/repo.js';
import * as schedulesRepo from '../../../src/schedules/repo.js';
import { SSO_SWEEP_JOB, sweepSso } from '../../../src/sso/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { describeDb, TEST_DATABASE_URL } from '../../helpers/database.js';
import {
  chainKeysOf,
  cookie,
  fill as _fill,
  firstCommitFiles,
  isolationWorld,
  sealerOf,
  type Filled,
  type World,
} from './fill.js';
import { openSocket, type Tenant, type TestSocket } from './modules/two-tenants.js';
import { ROUTE_MAP, routeKey, SOCKET_ROUTES, type Ctx } from './route-map.js';

void _fill;

/** What A wrote that a body of B's must never hold, unless the request itself named it. */
function leaks(a: Filled, sent: string, body: string): string[] {
  const found: string[] = [];
  const text = body.toLowerCase();
  if (!sent.toLowerCase().includes('acme') && text.includes('acme')) found.push('"acme"');
  for (const id of a.ids) if (!sent.includes(id) && body.includes(id)) found.push(id);
  return found;
}

/** Every scoped table, in B's scope: a row of A's there is a violation. */
async function tableSweep(w: World): Promise<string[]> {
  const violations: string[] = [];
  for (const table of SCOPED_TABLES) {
    const seen = await w.b.tenant.tdb.query<{ n: string }>(
      `select count(*)::text as n from ${table} where tenant_id = $1`,
      [w.a.tenant.scope.tenantId],
    );
    if (Number(seen.rows[0]!.n) > 0) violations.push(`${table}: ${seen.rows[0]!.n} of A's rows in B's scope`);
  }
  return violations;
}

interface RouteSweep {
  readonly unmapped: string[];
  /** A template that did not answer 2xx as A on A's host: the template is wrong, or A cannot use its own data. */
  readonly controls: string[];
  readonly violations: string[];
}

/** Every email of A's a string holds: what the sweep typed into B's forms. */
const ACME_EMAIL = /[\w.+-]+@acme\.example/gi;

/**
 * A's rows in every scoped table, read as the admin superuser (which the policy does not hold): a count and a digest
 * per table. Read until two reads agree, so a write A's own control set off after its answer (the license listener's
 * audit row) is in it.
 */
async function snapshotOfA(superuser: Database, w: World): Promise<string> {
  const read = async () =>
    JSON.stringify(
      (
        await superuser.query<{ t: string; n: string; h: string }>(
          SCOPED_TABLES.map(
            (table) =>
              `select '${table}' as t, count(*)::text as n, coalesce(md5(string_agg(x::text, ',' order by x::text)), '') as h from ${table} x where tenant_id = $1`,
          ).join(' union all '),
          [w.a.tenant.scope.tenantId],
        )
      ).rows,
    );
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await new Promise((done) => setTimeout(done, 25));
    const next = await read();
    if (next === last) return next;
    last = next;
  }
  return last;
}

/** The admin superuser on the world's schema. */
function superuserOf(w: World): Database {
  const url = new URL(TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${w.t.h.db.schema}`);
  return createDatabase(url.toString());
}

/**
 * Every route the server registered, as A (the control) and then as B with A's ids (the probe). A write probe must also
 * leave A's rows exactly as they were (Task 19 review M3): a handler that changed A's row and then answered 404 would
 * otherwise pass.
 */
async function routeSweep(w: World): Promise<RouteSweep> {
  const result: RouteSweep = { unmapped: [], controls: [], violations: [] };
  const urls = new Map<string, string>();
  for (const registered of w.routes) {
    const key = routeKey(registered);
    if (key !== undefined && !urls.has(key)) urls.set(key, registered.url);
  }
  /** Everything the sweep sent to B: its own audit log may record it. */
  const typed = new Set<string>();
  const superuser = superuserOf(w);
  try {
    for (const [key, url] of urls) {
      const route = ROUTE_MAP[key];
      if (route === undefined) {
        result.unmapped.push(key);
        continue;
      }
      if (route.cls === 'socket') {
        if (!(Object.values(SOCKET_ROUTES) as string[]).includes(key))
          result.unmapped.push(`${key}: a socket with no case`);
        continue;
      }
      if (route.request === undefined) {
        result.unmapped.push(`${key}: no template`);
        continue;
      }
      const ctx = (from: Filled): Ctx => ({ w, url, from, a: w.a });
      // The control: A's admin on A's host.
      const control = await w.a.tenant.inject(await route.request(ctx(w.a)));
      await route.after?.(ctx(w.a));
      if (route.cls === 'federated') {
        if (control.statusCode !== 404) result.controls.push(`${key}: A got ${control.statusCode}, not 404`);
      } else if (control.statusCode >= 400) {
        result.controls.push(`${key}: A got ${control.statusCode} ${control.body.slice(0, 300)}`);
      }
      // The probe: B's admin on B's host, with A's ids.
      const request = await route.request(ctx(w.b));
      const write = !key.startsWith('GET ');
      // A's control (and the template, which may make a fresh row of A's) can leave writes in flight that land
      // during B's probe and would be blamed on B: wait for them, and for B's, before each snapshot.
      if (write) await w.quiet();
      const before = write ? await snapshotOfA(superuser, w) : '';
      const res = await w.b.tenant.inject(request);
      if (write) await w.quiet();
      const after = write ? await snapshotOfA(superuser, w) : '';
      await route.after?.(ctx(w.b));
      const sent = `${request.url as string} ${JSON.stringify(request.payload ?? '')}`;
      for (const email of sent.match(ACME_EMAIL) ?? []) typed.add(email.toLowerCase());
      const status = res.statusCode;
      const emptyList = status < 300 && res.body.trim() === '[]';
      const refused =
        route.refused !== undefined ? route.refused(res) : (route.statuses ?? [404]).includes(status) || emptyList;
      if (route.cls === 'federated' && status !== 404) result.violations.push(`${key}: B got ${status}, not 404`);
      if (route.cls === 'refused' && !refused) {
        result.violations.push(`${key}: B got ${status} ${res.body.slice(0, 300)}`);
      }
      if (route.cls === 'own' && status >= 400) {
        result.violations.push(`${key}: B's own answered ${status} ${res.body.slice(0, 300)}`);
      }
      if (before !== after) result.violations.push(`${key}: B's request changed A's rows`);
      let body = res.body;
      if (route.stripsSent === true) for (const email of typed) body = body.replaceAll(email, '');
      const leaked = leaks(w.a, sent, body);
      if (leaked.length > 0) result.violations.push(`${key}: B's answer holds A's ${leaked.join(', ')}`);
    }
  } finally {
    await superuser.close();
  }
  return result;
}

describeDb('the cross-tenant isolation suite (spec §19.13)', () => {
  let w: World;
  beforeAll(async () => {
    w = await isolationWorld();
  }, 120_000);
  afterAll(() => w.close(), 60_000);

  describe('positive controls', () => {
    it('fill wrote a row of each tenant in every scoped table, counted in its own scope', async () => {
      // `fill` asserted it as it wrote; again here, after the other's fill.
      const { expectFilled } = await import('./fill.js');
      await expectFilled(w.a.tenant);
      await expectFilled(w.b.tenant);
    });

    it('the admin superuser sees both tenants in every scoped table; the app role sees only the scope it set', async () => {
      const superuser = superuserOf(w);
      try {
        const both = [w.a.tenant.scope.tenantId, w.b.tenant.scope.tenantId];
        for (const table of SCOPED_TABLES) {
          const rows = await superuser.query<{ tenant: string }>(
            `select distinct tenant_id::text as tenant from ${table} where tenant_id = any($1::uuid[])`,
            [both],
          );
          expect(rows.rows.map((row) => row.tenant).sort(), table).toEqual([...both].sort());
        }
      } finally {
        await superuser.close();
      }
      for (const [own, other] of [
        [w.a, w.b],
        [w.b, w.a],
      ] as const) {
        for (const table of SCOPED_TABLES) {
          const seen = await own.tenant.tdb.query<{ mine: string; theirs: string }>(
            `select count(*) filter (where tenant_id = $1)::text as mine,
                    count(*) filter (where tenant_id <> $1)::text as theirs from ${table}`,
            [own.tenant.scope.tenantId],
          );
          expect(Number(seen.rows[0]!.mine), `${own.tenant.slug} ${table}`).toBeGreaterThan(0);
          expect(Number(seen.rows[0]!.theirs), `${own.tenant.slug} ${table}`).toBe(0);
        }
        void other;
      }
    });
  });

  describe('every table', () => {
    it("inside B's scope, every scoped table holds none of A's rows", async () => {
      expect(await tableSweep(w)).toEqual([]);
    });

    it('an insert in B naming tenant_id = A fails with 42501, in every scoped table', async () => {
      const passed: string[] = [];
      for (const table of SCOPED_TABLES) {
        try {
          await w.b.tenant.tdb.query(`insert into ${table} (tenant_id) values ($1)`, [w.a.tenant.scope.tenantId]);
          passed.push(`${table}: inserted`);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== '42501') passed.push(`${table}: ${code ?? String(error)}`);
        }
      }
      expect(passed).toEqual([]);
    });

    it("an insert in B naming one of A's ids is refused by the composite key", async () => {
      const at = w.t.h.clock.now;
      const b = w.b.tenant.tdb;
      const refusedBy = async (what: string, insert: () => Promise<unknown>) => {
        await expect(insert(), what).rejects.toMatchObject({ code: '23503' });
      };
      await refusedBy('a member of A’s team', () =>
        teamsRepo.insertMember(b, { teamId: w.a.teamId, userId: w.b.member.user.id, role: 'member', at }),
      );
      await refusedBy('a grant on A’s workspace', () =>
        teamsRepo.upsertGrant(b, { workspaceId: w.a.workspaceId, userId: w.b.member.user.id, role: 'editor', at }),
      );
      await refusedBy('a token of A’s user', () =>
        identityRepo.insertToken(b, {
          id: newId(),
          userId: w.a.admin.user.id,
          tokenHash: mintToken().hash,
          deviceName: 'planted',
          at,
        }),
      );
      await refusedBy('a capture of A’s catch URL', () =>
        hooksRepo.insertCapture(b, {
          id: newId(),
          catchUrlId: w.a.hookId,
          receivedAt: at,
          method: 'POST',
          subpath: '/',
          query: '',
          headers: [],
          body: Buffer.from('{}'),
          bodySize: 2,
          truncated: false,
          sourceIp: '203.0.113.9',
        }),
      );
      await refusedBy('a run of A’s schedule', () =>
        schedulesRepo.insertRun(b, {
          id: newId(),
          scheduleId: w.a.scheduleId,
          trigger: 'manual',
          status: 'queued',
          at,
        }),
      );
    });

    it("B's create with A's workspace id answers 201, as a second repository, and leaves A's (Task 9 review M8)", async () => {
      // Spec §19.6, §19.13: the repository store is led by the tenant, so the answer says nothing of A. A fresh
      // workspace of A's, so the route sweep below, which looks for A's filled ids in B's answers, never meets
      // this one in B's own audit.
      const made = await w.a.tenant.call<{ id: string }>(w.a.admin, 'POST', `/teams/${w.a.teamId}/workspaces`, {
        name: 'acme second',
        id: newId(),
      });
      expect(made.status).toBe(201);
      const id = made.body.id;
      const repos = w.t.h.repos;
      const deletes: number[] = [];
      const res = await w.b.tenant.call<{ id: string }>(w.b.admin, 'POST', `/teams/${w.b.teamId}/workspaces`, {
        name: 'beta copy',
        id,
      });
      try {
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(id);
        expect((await teamsRepo.workspaceById(w.b.tenant.tdb, id))?.name).toBe('beta copy');
        expect((await teamsRepo.workspaceById(w.a.tenant.tdb, id))?.name).toBe('acme second');
        expect(repos.path(w.a.tenant.scope, id)).not.toBe(repos.path(w.b.tenant.scope, id));
        expect(await repos.exists(w.a.tenant.scope, id)).toBe(true);
        expect(await repos.exists(w.b.tenant.scope, id)).toBe(true);
        // A push in B lands in B's repository: A's stays unborn.
        const pushed = await w.b.tenant.call<{ head: string }>(w.b.admin, 'POST', `/workspaces/${id}/sync/commits`, {
          parent: null,
          commits: [{ subject: 'beta', at: new Date().toISOString(), changes: await firstCommitFiles(id) }],
        });
        expect(pushed.status).toBe(201);
        const inA = await w.a.tenant.call<{ head: string | null }>(w.a.admin, 'GET', `/workspaces/${id}/sync/head`);
        expect(inA.status).toBe(200);
        expect(inA.body.head).toBeNull();
      } finally {
        // Best effort, and no assertion in here, so a failure above is the one reported (Task 21 review M4).
        for (const [tenant, admin] of [
          [w.b.tenant, w.b.admin],
          [w.a.tenant, w.a.admin],
        ] as const) {
          deletes.push((await tenant.call(admin, 'DELETE', `/workspaces/${id}`)).status);
        }
      }
      expect(deletes).toEqual([204, 204]);
      expect(await repos.exists(w.b.tenant.scope, id)).toBe(false);
      expect(await repos.exists(w.a.tenant.scope, id)).toBe(false);
      expect(await repos.exists(w.a.tenant.scope, w.a.workspaceId)).toBe(true);
    });
  });

  describe('every route', () => {
    let sweep: RouteSweep;
    beforeAll(async () => {
      sweep = await routeSweep(w);
    }, 120_000);

    it('every route Fastify registered is in the map, and every mapped route is registered', () => {
      expect(sweep.unmapped, 'routes with no class: add each to route-map.ts').toEqual([]);
      const registered = new Set(w.routes.map(routeKey));
      expect(Object.keys(ROUTE_MAP).filter((key) => !registered.has(key))).toEqual([]);
      // Only the three socket routes are left to the socket sweep, each with its case below.
      const sockets = Object.entries(ROUTE_MAP)
        .filter(([, route]) => route.cls === 'socket')
        .map(([key]) => key);
      expect(sockets.sort()).toEqual(Object.values(SOCKET_ROUTES).sort());
    });

    it("the world registers every built-in module, in order, so a new module's routes reach the map", () => {
      expect(w.modules).toEqual(BUILTIN_MODULES.map((module) => module.name));
    });

    it("every template answers 2xx as A's admin on A's host (federated ones 404)", () => {
      expect(sweep.controls).toEqual([]);
    });

    it("sent as B's admin on B's host with A's ids, every route refuses, answers B's own, or is federated, and leaks nothing of A's", () => {
      expect(sweep.violations).toEqual([]);
    });

    it("A's token and A's cookie on B's host answer 401, and an unknown host 404 with an empty body", async () => {
      expect((await w.b.tenant.call(w.a.admin, 'GET', '/me')).status).toBe(401);
      const cookieOnB = await w.b.tenant.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookie(w.b.tenant, w.a.browser).cookie },
      });
      expect(cookieOnB.statusCode).toBe(401);
      for (const url of ['/api/v1/me', '/api/v1/meta', `/hooks/${w.a.hookSecret}`, '/']) {
        const res = await w.t.h.app.inject({ method: 'GET', url, headers: { host: 'nobody.example.test' } });
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).toBe('');
      }
    });
  });

  describe('every socket', () => {
    const sockets: TestSocket[] = [];
    afterAll(async () => {
      for (const socket of sockets) socket.close();
      await Promise.all(sockets.map((socket) => socket.closed));
    });
    const opened = async (tenant: Tenant, path: string, headers: Record<string, string> = {}) => {
      const socket = await openSocket(w.t, tenant, path, headers);
      sockets.push(socket);
      return socket;
    };

    /**
     * One case per socket route, keyed by `SOCKET_ROUTES`: a socket route added there without a case here is a type
     * error (Task 19 fix re-review A).
     */
    const SOCKET_CASES: Record<
      keyof typeof SOCKET_ROUTES,
      { readonly title: string; readonly run: () => Promise<void> }
    > = {
      live: {
        title: "live: B cannot subscribe to A's workspace, and A's announcements never reach B's sockets",
        run: async () => {
          const inB = await opened(w.b.tenant, LIVE_PATH);
          inB.send({ type: 'auth', token: w.b.admin.token });
          await inB.next('ready');
          inB.send({ type: 'subscribe', workspaceId: w.a.workspaceId });
          expect(await inB.next('refused')).toMatchObject({
            workspaceId: w.a.workspaceId,
            code: 'teams-workspace-not-found',
          });
          inB.send({ type: 'subscribe', workspaceId: w.b.workspaceId });
          await inB.next('presence');
          const inA = await opened(w.a.tenant, LIVE_PATH);
          inA.send({ type: 'auth', token: w.a.admin.token });
          await inA.next('ready');
          inA.send({ type: 'subscribe', workspaceId: w.a.workspaceId });
          await inA.next('presence');
          const log = w.t.h.app.log;
          const a = { tenantId: w.a.tenant.scope.tenantId, workspaceId: w.a.workspaceId };
          announce(w.t.h.hooks.headMoved, { ...a, head: 'a'.repeat(40), tokenId: newId() }, log);
          announce(w.t.h.hooks.captureReceived, { ...a, hookId: w.a.hookId, captureId: w.a.captureId }, log);
          announce(w.t.h.hooks.hooksChanged, a, log);
          announce(
            w.t.h.hooks.scheduleRunFinished,
            { ...a, scheduleId: w.a.scheduleId, runId: w.a.runId, status: 'passed' },
            log,
          );
          await inA.next('head');
          await inA.next('schedule-run');
          // B's own head, then: B saw none of A's before it.
          announce(
            w.t.h.hooks.headMoved,
            {
              tenantId: w.b.tenant.scope.tenantId,
              workspaceId: w.b.workspaceId,
              head: 'b'.repeat(40),
              tokenId: newId(),
            },
            log,
          );
          await inB.next('head');
          expect(
            inB.messages.filter((m) => ['head', 'capture', 'hooks', 'schedule-run'].includes(m.type ?? '')),
          ).toEqual([{ type: 'head', workspaceId: w.b.workspaceId, head: 'b'.repeat(40) }]);
          // A's token is no one on B's host.
          const stranger = await opened(w.b.tenant, LIVE_PATH);
          stranger.send({ type: 'auth', token: w.a.admin.token });
          expect(await stranger.closed).toBe(LIVE_CLOSE.unauthenticated);
        },
      },

      host: {
        title: "host: B's host cannot open A's workspace",
        run: async () => {
          const host = await opened(w.b.tenant, '/api/v1/host', cookie(w.b.tenant, w.b.browser));
          await host.next('hello');
          host.send({
            id: 1,
            channel: 'workspace.joinFromServer',
            request: { url: w.b.tenant.origin, workspaceId: w.a.workspaceId },
          });
          expect(await host.waitFor((frame) => frame.id === 1)).toMatchObject({
            ok: false,
            error: { code: 'teams-workspace-not-found' },
          });
        },
      },

      terminalShares: {
        title: "terminal shares: B cannot join A's share, by A's workspace or its own",
        run: async () => {
          for (const [workspaceId, close] of [
            [w.b.workspaceId, TERMINAL_SHARE_CLOSE.notFound],
            [w.a.workspaceId, TERMINAL_SHARE_CLOSE.forbidden],
          ] as const) {
            const viewer = await opened(w.b.tenant, TERMINAL_SHARE_PATH);
            viewer.send({ type: 'auth', token: w.b.admin.token, workspaceId, shareId: w.a.shareId });
            expect(await viewer.closed, workspaceId).toBe(close);
          }
        },
      },
    };
    for (const [name, socketCase] of Object.entries(SOCKET_CASES) as [
      keyof typeof SOCKET_ROUTES,
      (typeof SOCKET_CASES)[keyof typeof SOCKET_ROUTES],
    ][]) {
      it(`${SOCKET_ROUTES[name]} — ${socketCase.title}`, socketCase.run);
    }
  });

  describe('every job', () => {
    /** Runs `job`; every unit it opened names one tenant, and both A's and B's units ran a statement matching `text`. */
    const servesBoth = async (what: string, text: RegExp, job: () => Promise<unknown>) => {
      const entries = w.t.h.statements.entries;
      entries.length = 0;
      await job();
      const units = new Map<number, string>();
      const served = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === 'set-config') units.set(entry.unit, entry.tenantId);
        else {
          expect(units.get(entry.unit), `${what}: ${entry.text}`).toBe(entry.tenantId);
          if (text.test(entry.text)) served.add(entry.tenantId);
        }
      }
      expect(
        [...served].filter((id) => id === w.a.tenant.scope.tenantId || id === w.b.tenant.scope.tenantId).sort(),
        what,
      ).toEqual([w.a.tenant.scope.tenantId, w.b.tenant.scope.tenantId].sort());
    };

    it('each job serves both tenants, every statement in a unit of its own tenant', async () => {
      const ctx = w.t.h.ctx;
      const now = () => w.t.h.clock.now;
      await servesBoth('identity sweep', /delete from device_tokens/, () =>
        sweepExpired({ ctx, settings: identitySettings(ctx.config), now }),
      );
      await servesBoth('SSO sweep', /delete from saml_flows/, () =>
        ctx.tenancy.forEachTenant(SSO_SWEEP_JOB, (tx) => sweepSso(tx, now()), w.t.h.app.log),
      );
      await servesBoth('agent sweep', /delete from agent_pairing_codes/, () =>
        ctx.tenancy.forEachTenant(
          AGENT_SWEEP_JOB,
          async (tx) => {
            await sweepAgent(tx, now());
          },
          w.t.h.app.log,
        ),
      );
      await servesBoth('scheduler pass', /from schedules/, () => w.scheduler().runOnce());
      await servesBoth('alert outbox', /schedule_alert_outbox/, () => w.outbox().runOnce());
      await servesBoth('audit sealer', /audit_chain_anchor/, () => sealerOf(w.t).runOnce());
      // The schedules module's two retention sweeps, as it builds them (it arms them only with its scheduler on).
      for (const [job, deleteBefore, text] of [
        ['schedule-run-retention', schedulesRepo.deleteRunsBefore, /delete from schedule_runs/],
        ['schedule-alert-retention', schedulesRepo.deleteOutboxBefore, /delete from schedule_alert_outbox/],
      ] as const) {
        await servesBoth(job, text, () =>
          new CaptureSweeper({
            target: { tenancy: ctx.tenancy, job, deleteBefore },
            maxAgeDays: 90,
            now,
            setTimer: w.timers.setTimer,
            log: w.t.h.app.log,
          }).runOnce(),
        );
      }
      // The retention sweeps the modules armed on the (manual) ten-minute timer, fired together: captures,
      // session logs and the audit log (which reads each tenant's anchor).
      const retention = [/delete from captures/, /delete from session_logs/, /from audit_chain_anchor/];
      const entries = w.t.h.statements.entries;
      entries.length = 0;
      expect(w.timers.fire(SWEEP_INTERVAL_MS)).toBeGreaterThanOrEqual(retention.length);
      const both = [w.a.tenant.scope.tenantId, w.b.tenant.scope.tenantId];
      const served = (text: RegExp) =>
        new Set(entries.filter((e) => e.kind === 'statement' && text.test(e.text)).map((e) => e.tenantId));
      for (let i = 0; i < 200 && !retention.every((text) => both.every((id) => served(text).has(id))); i++) {
        await new Promise((done) => setTimeout(done, 20));
      }
      for (const text of retention) {
        expect([...served(text)].filter((id) => both.includes(id)).sort(), String(text)).toEqual([...both].sort());
      }
      const units = new Map<number, string>();
      for (const entry of entries) {
        if (entry.kind === 'set-config') units.set(entry.unit, entry.tenantId);
        else expect(units.get(entry.unit), entry.text).toBe(entry.tenantId);
      }
    });

    it('the license listener writes in the announcing tenant only', async () => {
      const licenseId = newId();
      announce(
        w.t.h.hooks.licenseChanged,
        {
          action: 'installed',
          licenseId,
          edition: 'enterprise',
          actorUserId: null,
          tenantId: w.b.tenant.scope.tenantId,
          tenant: w.b.tenant.scope,
        },
        w.t.h.app.log,
      );
      const count = async (f: Filled) =>
        Number(
          (
            await f.tenant.tdb.query<{ n: string }>(
              `select count(*)::text as n from audit_events where action = 'license.installed' and target_id = $1`,
              [licenseId],
            )
          ).rows[0]!.n,
        );
      for (let i = 0; i < 100 && (await count(w.b)) === 0; i++) await new Promise((done) => setTimeout(done, 20));
      expect(await count(w.b)).toBe(1);
      expect(await count(w.a)).toBe(0);
    });

    it("each tenant's chain seals on its own and verifies with its own key, not the other's", async () => {
      await sealerOf(w.t).runOnce();
      const keys = chainKeysOf(w.t);
      for (const [own, other] of [
        [w.a, w.b],
        [w.b, w.a],
      ] as const) {
        expect(await verifyChain(own.tenant.tdb, keys(own.tenant.scope))).toMatchObject({
          kind: 'checked',
          result: 'intact',
        });
        expect(await verifyChain(own.tenant.tdb, keys(other.tenant.scope))).toEqual({
          kind: 'wrong-key',
          chainKeyId: keyId(keys(own.tenant.scope)),
        });
      }
    });
  });

  describe('the keys', () => {
    it("a blob sealed for a user of A opens under neither B's user's key nor another user of A's", () => {
      const root = w.t.h.ctx.config.secretsKey!;
      const sealed = seal(userSecretsKey(root, w.a.browser.user.id), 'acme host secret');
      expect(open(userSecretsKey(root, w.a.browser.user.id), sealed)).toBe('acme host secret');
      expect(() => open(userSecretsKey(root, w.b.browser.user.id), sealed)).toThrow();
      expect(() => open(userSecretsKey(root, w.a.admin.user.id), sealed)).toThrow();
    });
  });
});

describeDb('the isolation sweeps on a schema with the policies disabled (spec §19.13 negative run)', () => {
  let w: World;
  beforeAll(async () => {
    w = await isolationWorld({ policiesDisabled: true });
  }, 120_000);
  afterAll(() => w.close(), 60_000);

  it('the table sweep fails there', async () => {
    expect((await tableSweep(w)).length).toBeGreaterThan(0);
  });

  it('the route sweep fails there', async () => {
    const sweep = await routeSweep(w);
    expect(sweep.unmapped).toEqual([]);
    // Broadly, not by one route: most of the templates that name A's ids reach A's rows there.
    expect(sweep.violations.length, sweep.violations.join('\n')).toBeGreaterThan(30);
  }, 120_000);
});
