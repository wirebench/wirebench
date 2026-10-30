/**
 * The generator of the frozen `0019` fixture (hosted edition spec §19.13). It is not a test of this tree:
 * `make-fixture-0019.ts` copies it into a worktree of commit `e9bdc5af1`, the last schema at `0019`, and runs
 * it there with vitest, so every row and file is written by that commit's own modules, repositories and host.
 * What it writes is checked in, and the suites only ever read that.
 *
 * Every table gets realistic rows, through the routes where a route is the natural writer and through the
 * module's own repository where the route needs an outside party (an identity provider, an SSH host, the
 * agent). The audit chain is sealed with a test key and then grows an unsealed tail, as on a live server.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRestRequest, entry, type RestRequestDef, type SyncPushResponse } from '@wirebench/engine';
import { agentModule } from '../../../src/agent/module.js';
import * as agentRepo from '../../../src/agent/repo.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ciTokensModule } from '../../../src/ci-tokens/module.js';
import { hooksModule } from '../../../src/hooks/module.js';
import { seal as sealHookSecret } from '../../../src/hooks/secret-box.js';
import * as hooksRepo from '../../../src/hooks/repo.js';
import { hostDirectories } from '../../../src/host/server-platform.js';
import { hostModule } from '../../../src/host/module.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { licensingModule } from '../../../src/licensing/module.js';
import * as licensingRepo from '../../../src/licensing/repo.js';
import { liveModule } from '../../../src/live/module.js';
import { enqueueAlerts } from '../../../src/schedules/alerts/outbox.js';
import { schedulesModule } from '../../../src/schedules/module.js';
import * as schedulesRepo from '../../../src/schedules/repo.js';
import { sealValue } from '../../../src/schedules/seal.js';
import { sessionLogsModule } from '../../../src/session-logs/module.js';
import * as sessionLogsRepo from '../../../src/session-logs/repo.js';
import { ssoModule } from '../../../src/sso/module.js';
import * as ssoRepo from '../../../src/sso/repo.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { allMigrations } from '../../../src/serve.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { browserBuildFixture } from '../../helpers/browser-build.js';
import { TEST_DATABASE_URL } from '../../helpers/database.js';
import { identityHarness, signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { browserUser, openHost, PUBLIC_URL } from '../../helpers/host.js';
import { license, testKeys } from '../../helpers/licensing.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { manualTimers } from '../../helpers/timers.js';
import { call } from '../../helpers/teams.js';

/** The keys every sealed value of the fixture is under; `Fixture` exports them with the plaintexts. */
export const FIXTURE_KEYS = {
  /** `WIREBENCH_SERVER_SECRETS_KEY`: the root of each user's `secrets.json` and cookie-jar key (slice 2). */
  secretsKey: Buffer.alloc(32, 0x51).toString('base64'),
  /** `WIREBENCH_SERVER_AUDIT_CHAIN_KEY`. */
  auditChainKey: 'fixture-0019-audit-chain-key-0123456789abcdef',
  /** `WIREBENCH_SERVER_HOOKS_SECRET_KEY`: catch-URL signature secrets. */
  hooksSecretKey: Buffer.alloc(32, 0x52).toString('base64'),
  /** `WIREBENCH_SERVER_SCHEDULES_SECRET_KEY`: schedule secrets and alert URLs. */
  schedulesSecretKey: Buffer.alloc(32, 0x53).toString('base64'),
} as const;

/** The plaintexts behind the sealed values, so later tasks can prove a re-wrap kept them. */
export const FIXTURE_PLAINTEXTS = {
  /** In Alice's `secrets.json`, under the label below. */
  hostSecret: 'sk-fixture-0123456789abcdef',
  hostSecretLabel: 'wirebench-secret:project-billing:API_KEY',
  /** The cookie each jar holds, one per workspace Alice sent from. */
  cookies: { staging: 'session=staging-cookie-0019', billing: 'session=billing-cookie-0019' },
  /** A catch URL's signature secret. */
  hookSignatureSecret: 'whsec_fixture0019signingsecret',
  /** A schedule's `API_KEY` and its Slack alert URL. */
  scheduleSecret: 'sk-schedule-fixture-0019',
  slackUrl: 'https://hooks.slack.example.test/services/T000/B000/fixture0019',
} as const;

const AT = '2026-09-24T12:00:00.000Z';
const OUT = process.env.WIREBENCH_FIXTURE_OUT;

/** `pg_dump`, or the command in `WIREBENCH_FIXTURE_PG_DUMP` (say `docker exec <container> pg_dump -U wirebench -d wirebench`). */
function pgDump(args: readonly string[]): string {
  const prefix = process.env.WIREBENCH_FIXTURE_PG_DUMP?.split(' ').filter((part) => part !== '');
  const [command, ...rest] = prefix ?? ['pg_dump', `--dbname=${TEST_DATABASE_URL!}`];
  return execFileSync(command!, [...rest, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The dump as plain statements for the loader: `pg_dump`'s session settings, comments and psql commands dropped, and the
 * generator's schema name removed so the rows load into whatever schema the loader's search path names.
 */
function portableDump(dump: string, schema: string): string {
  return `${dump
    .split('\n')
    // `\restrict` and `\unrestrict` are psql meta-commands, which newer pg_dump releases add.
    .filter((line) => !/^(SET |SELECT pg_catalog\.set_config|--|\\)/.test(line))
    .join('\n')
    .replaceAll(`INSERT INTO ${schema}.`, 'INSERT INTO ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/**
 * The name the fixture's requests send to, and its fixed port. Nothing in the fixture names the generating
 * machine's address: the host refuses loopback, so the target listens on a LAN address, and the name is resolved
 * to it in this process only (`resolveCookieHost`). The port is fixed so that a regeneration writes the same URLs.
 */
export const COOKIE_HOST = 'cookies.fixture.test';
export const COOKIE_PORT = 47019;

/** A target that sets one cookie per request, at `http://cookies.fixture.test:47019`. */
async function cookieTarget(): Promise<{ readonly base: string; close(): Promise<void> }> {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((one) => one?.family === 'IPv4' && !one.internal)?.address;
  if (lan === undefined) throw new Error('the fixture needs a non-loopback IPv4 address to send to');
  const target: Server = createServer((request, response) => {
    // The workspace is read from the path, so each jar gets its own synthetic cookie.
    const workspace: keyof typeof FIXTURE_PLAINTEXTS.cookies = request.url?.startsWith('/billing')
      ? 'billing'
      : 'staging';
    const cookie = FIXTURE_PLAINTEXTS.cookies[workspace];
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${cookie}; Path=/; Max-Age=31536000` });
    response.end('{"ok":true}');
  });
  await new Promise<void>((done, fail) => {
    target.once('error', fail);
    target.listen(COOKIE_PORT, lan, done);
  });
  const restore = resolveCookieHost(lan);
  return {
    base: `http://${COOKIE_HOST}:${String(COOKIE_PORT)}`,
    close: async () => {
      restore();
      target.closeAllConnections();
      await new Promise<void>((done) => target.close(() => done()));
    },
  };
}

/**
 * Resolves `COOKIE_HOST` to `address` for every lookup in this process: `node:dns`'s callback `lookup` (what
 * sockets and the egress check use) and `node:dns/promises`'s (what the host's send route uses). The builtins'
 * ES module bindings follow through `syncBuiltinESMExports`. Returns the undo.
 */
function resolveCookieHost(address: string): () => void {
  const require = createRequire(import.meta.url);
  const dns = require('node:dns') as typeof import('node:dns');
  const original = dns.lookup;
  const originalPromise = dns.promises.lookup;
  const answer = (all: boolean) => (all ? [{ address, family: 4 }] : { address, family: 4 });
  const patched = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (hostname !== COOKIE_HOST) return (original as (...args: unknown[]) => void)(hostname, options, callback);
    const found = answer(all);
    process.nextTick(() => (Array.isArray(found) ? cb(null, found) : cb(null, found.address, found.family)));
  }) as typeof dns.lookup;
  dns.lookup = patched;
  dns.promises.lookup = (async (hostname: string, options?: unknown) =>
    hostname === COOKIE_HOST
      ? answer(typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true)
      : (originalPromise as (...args: unknown[]) => Promise<unknown>)(hostname, options)) as typeof dns.promises.lookup;
  syncBuiltinESMExports();
  return () => {
    dns.lookup = original;
    dns.promises.lookup = originalPromise;
    syncBuiltinESMExports();
  };
}

/** Replaces every `from` with `to` in `bytes`, at the byte level, so no encoding is assumed for the rest. */
function replaceBytes(bytes: Buffer, from: Buffer, to: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = bytes.indexOf(from); at !== -1; at = bytes.indexOf(from, start)) {
    parts.push(bytes.subarray(start, at), to);
    start = at + from.length;
  }
  parts.push(bytes.subarray(start));
  return Buffer.concat(parts);
}

/** What the loader puts the new data directory's path back in for: git configs name it absolutely. */
export const DATA_DIR_PLACEHOLDER = '@WIREBENCH_FIXTURE_DATA_DIR@';

/** Replaces the data directory's absolute path in every file that names it, so the tarball loads anywhere. */
async function placeholderPaths(dataDir: string): Promise<string[]> {
  // Longest first: on macOS the real path `/private/var/…` contains the given `/var/…`.
  const prefixes = [...new Set([dataDir, await realpath(dataDir)])].sort((a, b) => b.length - a.length);
  const changed: string[] = [];
  for (const item of await readdir(dataDir, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue;
    const path = join(item.parentPath, item.name);
    const bytes = await readFile(path);
    if (!prefixes.some((prefix) => bytes.includes(Buffer.from(prefix, 'utf8')))) continue;
    let next: Buffer = bytes;
    for (const prefix of prefixes) {
      next = replaceBytes(next, Buffer.from(prefix, 'utf8'), Buffer.from(DATA_DIR_PLACEHOLDER, 'utf8'));
    }
    await writeFile(path, next);
    changed.push(path.slice(dataDir.length + 1).split('\\').join('/'));
  }
  return changed.sort();
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

it.runIf(OUT !== undefined)(
  'writes the 0019 fixture',
  async () => {
    const keys = testKeys();
    const timers = manualTimers();
    const build = await browserBuildFixture();
    const target = await cookieTarget();
    const h = await identityHarness({
      env: {
        WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
        WIREBENCH_SERVER_SECRETS_KEY: FIXTURE_KEYS.secretsKey,
        WIREBENCH_SERVER_AUDIT_CHAIN_KEY: FIXTURE_KEYS.auditChainKey,
        WIREBENCH_SERVER_HOOKS_SECRET_KEY: FIXTURE_KEYS.hooksSecretKey,
        WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: FIXTURE_KEYS.schedulesSecretKey,
        // Queued, never delivered: the forwarder's timer is manual.
        WIREBENCH_SERVER_AUDIT_FORWARD_URL: 'https://siem.example.test/ingest',
      },
      modules: (clock) => {
        const now = () => clock.now;
        return [
          licensingModule({ now, publicKeys: [keys.publicKey] }),
          teamsModule({ now }),
          syncModule(),
          hooksModule({ now, setTimer: timers.setTimer }),
          ciTokensModule({ now }),
          liveModule({ now, setTimer: timers.setTimer }),
          schedulesModule({ now, setTimer: timers.setTimer, startScheduler: false }),
          auditLogModule({ now, setTimer: timers.setTimer }),
          ssoModule({ now, sweepIntervalMs: 0 }),
          sessionLogsModule({ now, setTimer: timers.setTimer }),
          terminalSharesModule({ now, setTimer: timers.setTimer }),
          hostModule({ now, setTimer: timers.setTimer, browserRoot: build.root }),
          agentModule({ now, sweepIntervalMs: 0 }),
        ];
      },
    });
    const ids: Record<string, string[]> = {};
    const note = (table: string, id: string) => (ids[table] ??= []).push(id);
    try {
      await h.app.listen({ host: '127.0.0.1', port: 0 });
      const port = (h.app.server.address() as AddressInfo).port;
      const at = h.clock.now;

      // ---- identity: an admin with a password, a browser user, members, an invitation, sign-in flows.
      const admin = await signedInUser(h, { email: 'Admin@example.com', password: 'fixture-password-0019', serverAdmin: true });
      const alice = await browserUser(h, 'alice@example.com', { serverAdmin: true });
      const editor = await signedInUser(h, { email: 'editor@example.com', password: 'editor-password-0019' });
      const viewer = await signedInUser(h, { email: 'viewer@example.com', deviceName: 'viewer laptop' });
      // A disabled user, whose row the partial and unique keys must carry over as it is.
      const leaver = await signedInUser(h, { email: 'leaver@example.com', password: 'leaver-password-0019', disabled: true });
      for (const user of [admin, alice, editor, viewer, leaver]) note('users', user.user.id);
      const installed = await call(h, admin, 'PUT', '/license', {
        license: license(keys, { edition: 'enterprise', seats: 100 }),
      });
      expect(installed.status, JSON.stringify(installed.body)).toBeLessThan(300);
      const invited = await call<{ id: string }>(h, admin, 'POST', '/invitations', {
        email: 'newcomer@example.com',
        serverAdmin: false,
      });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      // An accepted invitation beside the open one: `invitations_one_open_per_email` covers only open ones.
      const joined = await call<{ url: string }>(h, admin, 'POST', '/invitations', {
        email: 'joined@example.com',
        serverAdmin: false,
      });
      expect(joined.status, JSON.stringify(joined.body)).toBe(201);
      const accepted = await call<{ user: { id: string } }>(h, undefined, 'POST', '/invitations/accept', {
        secret: new URL(joined.body.url).pathname.split('/').pop()!,
        displayName: 'Joined',
        password: 'joined-password-0019',
        device: { name: 'joined laptop' },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
      note('users', accepted.body.user.id);
      // Run at `e9bdc5af1`, whose repository takes a plain querier; this tree's takes a tenant one, so the
      // harness's database is cast for both to compile.
      await identityRepo.insertOidcIdentity(h.db as never, {
        issuer: 'https://idp.example.test',
        subject: 'oidc-subject-editor',
        userId: editor.user.id,
        at,
      });
      await identityRepo.insertFlow(h.db as never, {
        id: newId(),
        codeChallenge: sha256('verifier-0019'),
        loopbackPort: 53682,
        deviceName: 'pending laptop',
        state: randomBytes(16).toString('hex'),
        nonce: randomBytes(16).toString('hex'),
        createdAt: at,
        expiresAt: new Date(at.getTime() + 10 * 60_000),
      });
      await h.db.query(
        `insert into browser_flows (id, provider, state_hash, nonce, code_verifier, redirect_to, expires_at, created_at)
         values ($1, 'oidc', $2, $3, $4, '/', $5, $6)`,
        [newId(), sha256('browser-state-0019'), 'nonce-0019', 'verifier-0019', new Date(at.getTime() + 600_000), at],
      );

      // ---- teams and workspaces, through the routes: two with repositories, one deleted into tmp/removed-….
      const team = await call<{ id: string }>(h, admin, 'POST', '/teams', { name: 'Payments QA' });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      const teamId = team.body.id;
      note('teams', teamId);
      for (const [user, role] of [
        [alice, 'admin'],
        [editor, 'member'],
        [viewer, 'member'],
      ] as const) {
        await teamsRepo.insertMember(h.db, { teamId, userId: user.user.id, role, at });
      }
      const teamInvite = await call(h, alice, 'POST', `/teams/${teamId}/invitations`, {
        email: 'contractor@example.com',
        role: 'member',
      });
      expect(teamInvite.status, JSON.stringify(teamInvite.body)).toBe(201);
      const workspace = async (name: string) => {
        const made = await call<{ id: string }>(h, alice, 'POST', `/teams/${teamId}/workspaces`, { name });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        note('workspaces', made.body.id);
        return made.body.id;
      };
      const staging = await workspace('Staging');
      const billing = await workspace('Billing');
      const retired = await workspace('Retired');
      for (const workspaceId of [staging, billing]) {
        await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at });
      }
      expect((await call(h, alice, 'DELETE', `/workspaces/${retired}`)).status).toBeLessThan(300);

      // ---- sync: each workspace gets commits whose requests send to the cookie target.
      const push = async (workspaceId: string, requests: RestRequestDef[]) => {
        const changes = (await workspaceSnapshot(requests)).map((file) =>
          file.path === 'workspace.yaml'
            ? {
                path: file.path,
                encoding: 'utf8' as const,
                content: Buffer.from(file.content, 'base64').toString('utf8').replace('workspace-smoke', workspaceId),
              }
            : file,
        );
        const pushed = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
          parent: null,
          commits: [{ subject: 'Start', at: AT, changes }],
        });
        expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
      };
      await push(staging, [
        { ...createRestRequest('Health', { id: 'req-health', url: `${target.base}/staging` }), headers: [entry('X-Key', '${secret:API_KEY}')] },
      ]);
      await push(billing, [createRestRequest('Invoices', { id: 'req-invoices', url: `${target.base}/billing` })]);

      // ---- the host: Alice opens both server workspaces, stores a secret, and each send leaves a cookie jar.
      const client = await openHost({ port }, alice);
      await client.waitFor((frame) => frame.type === 'hello');
      for (const [workspaceId, requestId] of [
        [staging, 'req-health'],
        [billing, 'req-invoices'],
      ] as const) {
        const opened = await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        if (workspaceId === staging) {
          const stored = await client.call('secrets.set', {
            value: FIXTURE_PLAINTEXTS.hostSecret,
            label: FIXTURE_PLAINTEXTS.hostSecretLabel,
          });
          expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true });
        }
        const sent = await client.call('request.sendRest', { sendId: `send-${requestId}`, requestId });
        expect(sent, JSON.stringify(sent).slice(0, 2000)).toMatchObject({ ok: true, value: { http: { status: 200 } } });
      }
      client.close();
      await client.closed;

      // ---- webhook capture: a signed catch URL and two captures through the public route.
      const hook = await call<{ id: string; url: string }>(h, editor, 'POST', `/workspaces/${staging}/hooks`, {
        name: 'Payments callback',
      });
      expect(hook.status, JSON.stringify(hook.body)).toBe(201);
      await hooksRepo.updateCatchUrl(h.db, hook.body.id, {
        signature: {
          scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', prefix: 'sha256=' },
          sealedSecret: sealHookSecret(Buffer.from(FIXTURE_KEYS.hooksSecretKey, 'base64'), FIXTURE_PLAINTEXTS.hookSignatureSecret),
          hint: 'whsec_…cret',
        },
      });
      const secret = new URL(hook.body.url).pathname.split('/').pop()!;
      for (const body of ['{"event":"invoice.paid"}', '{"event":"invoice.failed"}']) {
        const captured = await h.app.inject({
          method: 'POST',
          url: `/hooks/${secret}/events`,
          headers: { 'content-type': 'application/json' },
          payload: body,
        });
        expect(captured.statusCode, captured.body).toBeLessThan(300);
      }
      // Then the catch URL rejects unverified requests: an unsigned one is answered 401 and stored as rejected.
      await hooksRepo.updateCatchUrl(h.db, hook.body.id, { rejectUnverified: true });
      const rejected = await h.app.inject({
        method: 'POST',
        url: `/hooks/${secret}/events`,
        headers: { 'content-type': 'application/json' },
        payload: '{"event":"invoice.forged"}',
      });
      expect(rejected.statusCode, rejected.body).toBe(401);

      // ---- CI tokens, through the route.
      const ci = await call(h, alice, 'POST', `/workspaces/${staging}/ci-tokens`, { name: 'nightly pipeline' });
      expect(ci.status, JSON.stringify(ci.body)).toBe(201);
      // A revoked token, whose name the partial unique index leaves free.
      const old = await call<{ id: string }>(h, alice, 'POST', `/workspaces/${staging}/ci-tokens`, { name: 'old pipeline' });
      expect(old.status, JSON.stringify(old.body)).toBe(201);
      const revoked = await call(h, alice, 'DELETE', `/workspaces/${staging}/ci-tokens/${old.body.id}`);
      expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);

      // ---- scheduled runs: a schedule with a sealed secret and a Slack alert, a failed run with results.
      const schedulesKey = Buffer.from(FIXTURE_KEYS.schedulesSecretKey, 'base64');
      const scheduleId = newId();
      await schedulesRepo.insertSchedule(h.db, {
        id: scheduleId,
        workspaceId: staging,
        name: 'Nightly health',
        cron: '0 3 * * *',
        timeZone: 'Europe/Vienna',
        target: { project: 'Billing', environment: 'prod' },
        options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
        alerts: {
          targets: [
            { kind: 'slack', url: sealValue(schedulesKey, FIXTURE_PLAINTEXTS.slackUrl), host: 'hooks.slack.example.test' },
            { kind: 'email', to: ['qa@example.com'] },
          ],
          muteAfter: 3,
        },
        enabled: true,
        nextRunAt: new Date('2026-09-25T01:00:00.000Z'),
        createdBy: admin.user.id,
        at,
      });
      await schedulesRepo.setScheduleSecrets(h.db, scheduleId, { API_KEY: sealValue(schedulesKey, FIXTURE_PLAINTEXTS.scheduleSecret) }, at);
      const runId = newId();
      await schedulesRepo.insertRun(h.db, { id: runId, scheduleId, trigger: 'schedule', status: 'running', at });
      const finished: schedulesRepo.FinishedRun = {
        status: 'failed',
        reason: null,
        commit: 'c'.repeat(40),
        environment: 'prod',
        summary: { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 412 },
        results: [
          { name: 'Health', status: 'passed', durationMs: 120 },
          { name: 'Invoices', status: 'failed', durationMs: 292, error: 'expected 200, got 503' },
        ],
        at,
      };
      await h.db.transaction(async (tx) => {
        expect(await schedulesRepo.finishRun(tx, runId, finished)).toBe(true);
        await enqueueAlerts(tx, { settings: { linkUrl: PUBLIC_URL }, now: () => at }, scheduleId, {
          id: runId,
          ...finished,
        });
      });

      // ---- SSO: a SAML identity and flow, a SCIM token, a provisioned user in a group linked to the team.
      await ssoRepo.insertSamlIdentity(h.db, {
        entityId: 'https://idp.example.test/saml',
        nameId: 'viewer-name-id',
        userId: viewer.user.id,
        at,
      });
      await ssoRepo.insertSamlFlow(h.db, {
        id: newId(),
        requestId: `_${randomBytes(16).toString('hex')}`,
        codeChallenge: sha256('saml-verifier-0019'),
        loopbackPort: 53683,
        deviceName: 'saml laptop',
        relayState: randomBytes(16).toString('hex'),
        createdAt: at,
        expiresAt: new Date(at.getTime() + 600_000),
      });
      await ssoRepo.insertScimToken(h.db, { id: newId(), name: 'Entra provisioning', tokenHash: mintToken().hash, createdBy: admin.user.id, at });
      await ssoRepo.upsertScimUser(h.db, viewer.user.id, 'entra-viewer-0019', at);
      const groupId = newId();
      await ssoRepo.insertScimGroup(h.db, { id: groupId, displayName: 'QA Engineers', externalId: 'entra-group-0019', at });
      await ssoRepo.setGroupTeam(h.db, groupId, teamId, at);
      await ssoRepo.addGroupMembers(h.db, groupId, [viewer.user.id]);
      await ssoRepo.insertProvisioned(h.db, { teamId, userId: viewer.user.id, groupId });

      // ---- session logs: one ended log with two chunks.
      const opened = await sessionLogsRepo.openLog(h.db, {
        id: newId(),
        workspaceId: staging,
        userId: editor.user.id,
        clientLogId: '20260924T110000Z-a1b2c3d4',
        hostId: 'host-prod-db',
        hostName: 'prod-db',
        address: 'db.internal.example.test',
        port: 22,
        user: 'deploy',
        startedAt: '2026-09-24T11:00:00.000Z',
        at,
      });
      await sessionLogsRepo.appendChunk(h.db, { logId: opened.log.id, offset: 0, data: Buffer.from('$ uptime\r\n'), truncated: false, at });
      await sessionLogsRepo.appendChunk(h.db, {
        logId: opened.log.id,
        offset: 10,
        data: Buffer.from(' 11:00:01 up 12 days\r\n'),
        truncated: false,
        at,
      });
      await sessionLogsRepo.endLog(h.db, { logId: opened.log.id, endedAt: at, exitCode: 0, signal: null, reason: 'exit', at });

      // ---- the local agent: a pairing, an unused code and a nonce.
      const pairing = await agentRepo.upsertPairing(h.db, {
        id: newId(),
        userId: alice.user.id,
        agentId: 'agent-fixture-0019',
        publicKey: randomBytes(32).toString('base64'),
        port: 47011,
        sshOptIn: true,
        at,
      });
      await agentRepo.replaceCode(h.db, { userId: editor.user.id, codeHash: sha256('code-0019'), expiresAt: new Date(at.getTime() + 600_000) });
      await agentRepo.insertNonce(h.db, {
        nonceHash: sha256('nonce-0019'),
        pairingId: pairing.id,
        userId: alice.user.id,
        expiresAt: new Date(at.getTime() + 60_000),
      });

      // ---- the audit chain: seal what the routes recorded, then leave an unsealed tail.
      const sealer = new AuditSealer({
        db: h.db,
        key: FIXTURE_KEYS.auditChainKey,
        now: () => h.clock.now,
        setTimer: timers.setTimer,
        log: h.app.log,
      });
      const sealed = await sealer.runOnce();
      expect(sealed.outcome, JSON.stringify(sealed)).toBe('sealed');
      h.clock.advance(60_000);
      expect((await call(h, alice, 'POST', `/teams/${teamId}/workspaces`, { name: 'After the seal' })).status).toBe(201);

      // ---- scratch the file step deletes: a staging directory and a stray file.
      const { checkout } = hostDirectories(h.dataDir, alice.user.id);
      await writeFile(join(h.dataDir, 'tmp', 'scratch-0019.txt'), 'scratch\n');

      // Every table holds rows, or the fixture is not worth checking in.
      const tables = await h.db.query<{ table: string }>(
        `select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r' order by 1`,
      );
      const empty: string[] = [];
      for (const { table } of tables.rows) {
        if ((await h.db.query(`select 1 from ${table} limit 1`)).rowCount === 0) empty.push(table);
      }
      expect(tables.rowCount).toBe(37);
      // The edge rows the tenancy migrations must carry over (review of Task 3, M4).
      expect((await h.db.query('select 1 from users where disabled_at is not null')).rowCount).toBe(1);
      expect((await h.db.query('select 1 from ci_tokens where revoked_at is not null')).rowCount).toBe(1);
      expect((await h.db.query('select 1 from invitations where accepted_at is not null')).rowCount).toBe(1);
      expect((await h.db.query('select 1 from captures where rejected')).rowCount).toBe(1);
      expect(empty).toEqual([]);

      const chain = (
        await h.db.query<{ first: string; last: string; unsealed: string }>(
          `select min(chain_seq)::text as first, max(chain_seq)::text as last,
             count(*) filter (where chain_seq is null)::text as unsealed from audit_events`,
        )
      ).rows[0]!;
      for (const table of ['agent_pairings', 'ci_tokens', 'catch_urls', 'schedules', 'session_logs', 'invitations']) {
        for (const row of (await h.db.query<{ id: string }>(`select id::text as id from ${table} order by 1`)).rows) {
          note(table, row.id);
        }
      }

      // Stop the server, so the host flushes, before reading the database and the data directory.
      await h.app.close();
      const dump = pgDump([
        '--data-only',
        '--column-inserts',
        '--no-owner',
        '--no-privileges',
        `--schema=${h.db.schema}`,
        `--exclude-table-data=${h.db.schema}.schema_migrations`,
      ]);
      await writeFile(join(OUT!, 'seed-0019.sql'), portableDump(dump, h.db.schema));
      const withPlaceholder = await placeholderPaths(h.dataDir);
      execFileSync('tar', ['-C', h.dataDir, '-czf', join(OUT!, 'data-dir-0019.tar.gz'), '.'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      await writeFile(
        join(OUT!, 'fixture-0019.json'),
        `${JSON.stringify(
          {
            commit: process.env.WIREBENCH_FIXTURE_COMMIT ?? 'unknown',
            ids: { ...ids, teams: [teamId], scim_groups: [groupId], schedule_runs: [runId] },
            users: {
              admin: admin.user.id,
              alice: alice.user.id,
              editor: editor.user.id,
              viewer: viewer.user.id,
              leaver: leaver.user.id,
              joined: accepted.body.user.id,
            },
            workspaces: { staging, billing, retired },
            dataDirPlaceholder: { token: DATA_DIR_PLACEHOLDER, files: withPlaceholder },
            migrations: (await allMigrations(BUILTIN_MODULES)).map((m) => ({
              version: m.version,
              name: m.name,
              sha256: sha256(m.sql),
            })),
            checkout: checkout.slice(h.dataDir.length + 1).split('\\').join('/'),
            chain: { firstSeq: chain.first, lastSeq: chain.last, unsealed: Number(chain.unsealed) },
            keys: FIXTURE_KEYS,
            plaintexts: FIXTURE_PLAINTEXTS,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await target.close();
      await h.close();
      await build.remove();
    }
  },
  300_000,
);
