/**
 * SSO, session logs and the local agent with two tenants under the forced policy (tenancy Task 18; Task 15's
 * listed cases). Hosted mode serves no SAML or SCIM route until slice 7 gives each tenant its own identity provider
 * (`sso/hosted.test.ts`), so those cases run at the repository level, in each tenant's unit; slice 7 must run them
 * again through the routes. Session logs and the agent are served, and run through their routes on each host.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { agentRedeemMessage } from '@wirebench/engine';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentModule, sweepAgent } from '../../../../src/agent/module.js';
import * as agentRepo from '../../../../src/agent/repo.js';
import { CaptureSweeper } from '../../../../src/hooks/sweep.js';
import { hashSecret, mintToken, newId } from '../../../../src/identity/tokens.js';
import { licensingModule } from '../../../../src/licensing/module.js';
import { sessionLogsModule, SESSION_LOG_SWEEP_JOB } from '../../../../src/session-logs/module.js';
import * as logsRepo from '../../../../src/session-logs/repo.js';
import { SSO_SWEEP_JOB, ssoModule, sweepSso } from '../../../../src/sso/module.js';
import * as ssoRepo from '../../../../src/sso/repo.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { describeDb } from '../../../helpers/database.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { license, testKeys } from '../../../helpers/licensing.js';
import { quietLog } from '../../../helpers/schedule-runs.js';
import { manualTimers } from '../../../helpers/timers.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const keys = testKeys();
const DAY = 86_400_000;
const COOKIE = '__Host-wb_session';
const ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};

interface Cast {
  readonly root: SignedInUser;
  /** A browser session: the agent's codes and nonces are made from a tab. */
  readonly tab: SignedInUser;
}

function agentKey(): { readonly publicKey: string; sign(message: string): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

describeDb('SSO, session logs and the agent in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const timers = manualTimers();
  const workspaceId = newId();
  const casts: Partial<Record<'acme' | 'beta', Cast>> = {};
  const cast = (tenant: Tenant) => casts[tenant.slug]!;
  beforeAll(async () => {
    t = await twoTenants({
      env: ENV,
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
        sessionLogsModule({ now: () => clock.now, setTimer: timers.setTimer }),
        agentModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      const root = await tenant.user({ email: 'root@example.com', serverAdmin: true });
      const installed = await tenant.call(root, 'PUT', '/license', {
        license: license(keys, { edition: 'enterprise' }),
      });
      expect(installed.status).toBe(200);
      const tab = await tenant.user({ email: 'tab@example.com', kind: 'browser' });
      const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: 'Ops', at: t.h.clock.now });
      await teamsRepo.insertMember(tenant.tdb, {
        teamId: team.id,
        userId: root.user.id,
        role: 'admin',
        at: t.h.clock.now,
      });
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id: workspaceId,
        name: `Prod ${tenant.slug}`,
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
      await tenant.tdb.query('update workspaces set record_session_logs = true where id = $1', [workspaceId]);
      casts[tenant.slug] = { root, tab };
    }
  });
  afterAll(() => t.close());

  // ---- SSO, at the repository level ---------------------------------------------------------

  it('one SAML (entity_id, name_id) links a user in each tenant', async () => {
    const entityId = 'https://idp.example.test/entity';
    const nameId = 'ada@example.test';
    for (const tenant of [t.a, t.b]) {
      await ssoRepo.insertSamlIdentity(tenant.tdb, {
        entityId,
        nameId,
        userId: cast(tenant).root.user.id,
        at: t.h.clock.now,
      });
    }
    expect(await ssoRepo.samlIdentityOf(t.a.tdb, entityId, nameId)).toEqual({ userId: cast(t.a).root.user.id });
    expect(await ssoRepo.samlIdentityOf(t.b.tdb, entityId, nameId)).toEqual({ userId: cast(t.b).root.user.id });
  });

  it("A's SAML flow, by relay state or id, is unknown on B, and its grant redeems nothing there", async () => {
    const id = newId();
    const relayState = `relay-${newId()}`;
    await ssoRepo.insertSamlFlow(t.a.tdb, {
      id,
      requestId: `_req${newId()}`,
      codeChallenge: 'c'.repeat(43),
      loopbackPort: 49152,
      deviceName: 'Mac',
      relayState,
      createdAt: t.h.clock.now,
      expiresAt: new Date(t.h.clock.now.getTime() + 600_000),
    });
    expect(await ssoRepo.samlFlowByRelayState(t.b.tdb, relayState)).toBeUndefined();
    expect(await ssoRepo.samlFlowById(t.b.tdb, id)).toBeUndefined();
    const grant = 'g'.repeat(64);
    expect(await ssoRepo.grantSamlFlow(t.b.tdb, id, grant, cast(t.b).root.user.id)).toBe(false);
    expect(await ssoRepo.grantSamlFlow(t.a.tdb, id, grant, cast(t.a).root.user.id)).toBe(true);
    expect(await ssoRepo.claimGrantedSamlFlow(t.b.tdb, id, grant)).toBe(false);
    expect(await ssoRepo.claimGrantedSamlFlow(t.a.tdb, id, grant)).toBe(true);
  });

  // The SCIM users and groups halves need the SCIM base, which hosted mode serves from slice 7 (Task 18 review M2).
  it("A's SCIM token hash is unknown on B, and B lists none of A's tokens", async () => {
    const minted = mintToken();
    await ssoRepo.insertScimToken(t.a.tdb, {
      id: newId(),
      name: 'IdP',
      tokenHash: minted.hash,
      createdBy: null,
      at: t.h.clock.now,
    });
    expect(await ssoRepo.scimTokenByHash(t.b.tdb, minted.hash)).toBeUndefined();
    expect(await ssoRepo.scimTokenByHash(t.a.tdb, minted.hash)).toBeDefined();
    expect(await ssoRepo.listScimTokens(t.b.tdb)).toEqual([]);
    // The SCIM base is not served hosted (spec §19.1): A's token on B's host, and on A's, is a 404, not a list.
    for (const tenant of [t.a, t.b]) {
      const res = await tenant.inject({
        method: 'GET',
        url: '/scim/v2/Users',
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("the SSO sweep in A's unit deletes only A's expired SAML flows; the job loop then sweeps B's", async () => {
    const expired = new Date(t.h.clock.now.getTime() - 60_000);
    for (const tenant of [t.a, t.b]) {
      await ssoRepo.insertSamlFlow(tenant.tdb, {
        id: newId(),
        requestId: `_req${newId()}`,
        codeChallenge: 'c'.repeat(43),
        loopbackPort: 49152,
        deviceName: 'Mac',
        relayState: `relay-${newId()}`,
        createdAt: expired,
        expiresAt: expired,
      });
    }
    const expiredIn = (tenant: Tenant) => countIn(tenant, 'saml_flows', 'expires_at < $1', [t.h.clock.now]);
    // The delete names no tenant: in A's unit it must leave B's.
    await t.a.tdb.transaction((tx) => sweepSso(tx, t.h.clock.now));
    expect(await expiredIn(t.a)).toBe(0);
    expect(await expiredIn(t.b)).toBe(1);
    await t.h.ctx.tenancy.forEachTenant(SSO_SWEEP_JOB, (tx) => sweepSso(tx, t.h.clock.now), t.h.app.log);
    expect(await expiredIn(t.b)).toBe(0);
  });

  // ---- session logs, through the routes ---------------------------------------------------------

  const openLog = async (tenant: Tenant, at = t.h.clock.now) =>
    (
      await logsRepo.openLog(tenant.tdb, {
        id: newId(),
        workspaceId,
        userId: cast(tenant).root.user.id,
        clientLogId: `20261101T000000Z-${newId().slice(-8)}`,
        hostId: 'host-1',
        hostName: 'web',
        address: '10.0.0.1',
        port: 22,
        user: 'ops',
        startedAt: at.toISOString(),
        at,
      })
    ).log;

  it("B cannot list, read or delete A's session log by id, under the workspace id both tenants have", async () => {
    const log = await openLog(t.a);
    const base = `/workspaces/${workspaceId}/session-logs`;
    const listed = await t.b.call<{ logs?: { id: string }[] }>(cast(t.b).root, 'GET', base);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(log.id);
    expect((await t.b.call(cast(t.b).root, 'GET', `${base}/${log.id}/text`)).status).toBe(404);
    expect((await t.b.call(cast(t.b).root, 'DELETE', `${base}/${log.id}`)).status).toBe(404);
    expect(
      (
        await t.b.call(cast(t.b).root, 'POST', `${base}/${log.id}/end`, {
          endedAt: t.h.clock.now.toISOString(),
          reason: 'closed',
        })
      ).status,
    ).toBe(404);
    expect(await countIn(t.a, 'session_logs', 'id = $1', [log.id])).toBe(1);
    // A's own reaches it.
    expect(JSON.stringify((await t.a.call(cast(t.a).root, 'GET', base)).body)).toContain(log.id);
    expect((await t.a.call(cast(t.a).root, 'GET', `${base}/${log.id}/text`)).status).toBe(200);
  });

  it("the session-log sweep deletes old logs in each tenant, and a batch of one in A's unit deletes one of A's", async () => {
    const old = new Date(t.h.clock.now.getTime() - 400 * DAY);
    const oldLogs: Record<string, string[]> = { acme: [], beta: [] };
    const fresh: Record<string, string> = {};
    for (const tenant of [t.a, t.b]) {
      // B's are the older: a delete that crossed tenants would take B's first.
      const at = tenant === t.b ? new Date(old.getTime() - DAY) : old;
      for (let i = 0; i < 3; i += 1) oldLogs[tenant.slug]!.push((await openLog(tenant, at)).id);
      fresh[tenant.slug] = (await openLog(tenant)).id;
    }
    const cutoff = new Date(t.h.clock.now.getTime() - 365 * DAY);
    // The delete names no tenant and limits in a sub-select: the policy must hold both.
    expect(await t.a.tdb.transaction((tx) => logsRepo.removeLogsBefore(tx, cutoff, 1))).toBe(1);
    expect(await countIn(t.a, 'session_logs', 'id = any($1)', [oldLogs.acme])).toBe(2);
    expect(await countIn(t.b, 'session_logs', 'id = any($1)', [oldLogs.beta])).toBe(3);
    await new CaptureSweeper({
      target: { tenancy: t.h.ctx.tenancy, job: SESSION_LOG_SWEEP_JOB, deleteBefore: logsRepo.removeLogsBefore },
      maxAgeDays: 365,
      now: () => t.h.clock.now,
      setTimer: timers.setTimer,
      log: quietLog(),
    }).runOnce();
    for (const tenant of [t.a, t.b]) {
      expect(await countIn(tenant, 'session_logs', 'id = any($1)', [oldLogs[tenant.slug]])).toBe(0);
      expect(await countIn(tenant, 'session_logs', 'id = $1', [fresh[tenant.slug]])).toBe(1);
    }
  });

  // ---- the agent, through the routes ------------------------------------------------------------

  const browser = (tenant: Tenant) => ({ cookie: `${COOKIE}=${cast(tenant).tab.token}`, origin: tenant.origin });
  const newCode = async (tenant: Tenant): Promise<string> => {
    const res = await tenant.inject({ method: 'POST', url: '/api/v1/agent/pairing-codes', headers: browser(tenant) });
    expect(res.statusCode).toBe(201);
    return res.json<{ code: string }>().code;
  };
  const pair = (tenant: Tenant, code: string, key: ReturnType<typeof agentKey>) =>
    tenant.inject({
      method: 'POST',
      url: '/api/v1/agent/pairings',
      payload: { code, agentId: 'agent-1', publicKey: key.publicKey, port: 47615, sshOptIn: false },
    });
  const redeem = (tenant: Tenant, nonce: string, pairingId: string, key: ReturnType<typeof agentKey>) => {
    const timestamp = t.h.clock.now.toISOString();
    return tenant.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces/redeem',
      headers: {
        'x-wirebench-agent-pairing': pairingId,
        'x-wirebench-agent-timestamp': timestamp,
        'x-wirebench-agent-signature': key.sign(agentRedeemMessage(nonce, pairingId, timestamp)),
      },
      payload: { nonce },
    });
  };

  it("a code made in A cannot pair on B's host, and A's pairing and nonce are unknown on B", async () => {
    const key = agentKey();
    const code = await newCode(t.a);
    const onB = await pair(t.b, code, key);
    expect(onB.json<{ code: string }>().code).toBe('agent-pairing-code-invalid');
    // B's attempt did not spend A's code.
    const paired = await pair(t.a, code, key);
    expect(paired.statusCode).toBe(201);
    const pairingId = paired.json<{ pairingId: string }>().pairingId;
    // A's pairing id: B's tab cannot list it, ask a nonce for it, or delete it.
    const listed = await t.b.inject({ method: 'GET', url: '/api/v1/agent/pairings', headers: browser(t.b) });
    expect(JSON.stringify(listed.json())).not.toContain(pairingId);
    const nonceOnB = await t.b.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: browser(t.b),
      payload: { pairingId },
    });
    expect(nonceOnB.statusCode).toBe(404);
    expect(
      (await t.b.inject({ method: 'DELETE', url: `/api/v1/agent/pairings/${pairingId}`, headers: browser(t.b) }))
        .statusCode,
    ).toBe(404);
    // A's nonce, signed by A's agent, redeems nothing on B's host and stays live in A.
    const issued = await t.a.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: browser(t.a),
      payload: { pairingId },
    });
    expect(issued.statusCode).toBe(201);
    const nonce = issued.json<{ nonce: string }>().nonce;
    expect((await redeem(t.b, nonce, pairingId, key)).statusCode).toBe(404);
    expect(
      await agentRepo.takeNonce(t.b.tdb, { nonceHash: hashSecret(nonce), pairingId, now: t.h.clock.now }),
    ).toBeUndefined();
    const redeemed = await redeem(t.a, nonce, pairingId, key);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json<{ userId: string }>().userId).toBe(cast(t.a).tab.user.id);
  });

  it('the agent sweep deletes expired codes and nonces in each tenant only', async () => {
    const past = new Date(t.h.clock.now.getTime() - 60_000);
    for (const tenant of [t.a, t.b]) {
      await agentRepo.replaceCode(tenant.tdb, {
        userId: cast(tenant).root.user.id,
        codeHash: `expired-${tenant.slug}-${newId()}`,
        expiresAt: past,
      });
      const pairing = await agentRepo.upsertPairing(tenant.tdb, {
        id: newId(),
        userId: cast(tenant).root.user.id,
        agentId: `agent-sweep-${tenant.slug}`,
        publicKey: agentKey().publicKey,
        port: 47615,
        sshOptIn: false,
        at: t.h.clock.now,
      });
      await agentRepo.insertNonce(tenant.tdb, {
        nonceHash: `expired-${tenant.slug}-${newId()}`,
        pairingId: pairing.id,
        userId: cast(tenant).root.user.id,
        expiresAt: past,
      });
    }
    const expired = (tenant: Tenant, table: string) => countIn(tenant, table, 'expires_at <= $1', [t.h.clock.now]);
    await t.a.tdb.transaction((tx) => sweepAgent(tx, t.h.clock.now));
    for (const table of ['agent_pairing_codes', 'agent_nonces']) {
      expect(await expired(t.a, table), table).toBe(0);
      expect(await expired(t.b, table), table).toBe(1);
    }
    await t.h.ctx.tenancy.forEachTenant(
      'agent-sweep',
      (tx) => sweepAgent(tx, t.h.clock.now).then(() => undefined),
      t.h.app.log,
    );
    for (const table of ['agent_pairing_codes', 'agent_nonces']) expect(await expired(t.b, table), table).toBe(0);
  });
});
