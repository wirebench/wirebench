import { generateKeyPairSync, sign } from 'node:crypto';
import { AGENT_PAIRING_CODE_PATTERN, agentRedeemMessage, agentRequestMessage } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentModule, sweepAgent } from '../../../src/agent/module.js';
import type { AgentUnpaired, AuditInput } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';
const COOKIE = '__Host-wb_session';
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};

interface AgentKey {
  readonly publicKey: string;
  sign(message: string): string;
}

function agentKey(): AgentKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

describeDb('local-agent pairing (hosted edition spec §18.2)', () => {
  let h: IdentityHarness;
  let audits: AuditInput[];
  let unpaired: AgentUnpaired[];
  let alice: SignedInUser;
  let key: AgentKey;

  beforeEach(async () => {
    h = await identityHarness({
      env: BROWSER_ENV,
      modules: (clock) => [agentModule({ now: () => clock.now, sweepIntervalMs: 0 })],
    });
    audits = recordingAudit(h.hooks);
    unpaired = [];
    h.hooks.agentUnpaired.push((event) => {
      unpaired.push(event);
    });
    alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
    key = agentKey();
  });
  afterEach(() => h.close());

  /** A tab's cookie and `Origin`; `null` sends no `Origin` at all. */
  const browser = (user: SignedInUser, origin: string | null = PUBLIC_URL) => ({
    cookie: `${COOKIE}=${user.token}`,
    ...(origin !== null ? { origin } : {}),
  });

  const newCode = async (user = alice): Promise<string> => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/agent/pairing-codes', headers: browser(user) });
    expect(res.statusCode).toBe(201);
    return res.json<{ code: string }>().code;
  };

  const pair = (code: string, options: { key?: AgentKey; agentId?: string; remoteAddress?: string } = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/pairings',
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
      payload: {
        code,
        agentId: options.agentId ?? 'agent-1',
        publicKey: (options.key ?? key).publicKey,
        port: 47615,
        sshOptIn: false,
      },
    });

  const paired = async (user = alice, options: { key?: AgentKey; agentId?: string } = {}): Promise<string> => {
    const res = await pair(await newCode(user), options);
    expect(res.statusCode).toBe(201);
    return res.json<{ pairingId: string }>().pairingId;
  };

  const issueNonce = async (pairingId: string, user = alice): Promise<string> => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: browser(user),
      payload: { pairingId },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ nonce: string }>().nonce;
  };

  const redeem = (
    nonce: string,
    pairingId: string,
    options: { key?: AgentKey; timestamp?: string; signedPairing?: string } = {},
  ) => {
    const timestamp = options.timestamp ?? h.clock.now.toISOString();
    const signature = (options.key ?? key).sign(
      agentRedeemMessage(nonce, options.signedPairing ?? pairingId, timestamp),
    );
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces/redeem',
      headers: {
        'x-wirebench-agent-pairing': pairingId,
        'x-wirebench-agent-timestamp': timestamp,
        'x-wirebench-agent-signature': signature,
      },
      payload: { nonce },
    });
  };

  const signed = (method: 'DELETE' | 'PATCH', pairingId: string, options: { key?: AgentKey; path?: string } = {}) => {
    const path = `/api/v1/agent/pairings/${pairingId}`;
    const timestamp = h.clock.now.toISOString();
    return {
      'x-wirebench-agent-pairing': pairingId,
      'x-wirebench-agent-timestamp': timestamp,
      'x-wirebench-agent-signature': (options.key ?? key).sign(
        agentRequestMessage(method, options.path ?? path, pairingId, timestamp),
      ),
    };
  };

  const codeOf = (res: { json: <T>() => T }) => res.json<{ code: string }>().code;

  // ---- codes ---------------------------------------------------------------------------

  it('gives a browser user a six-character code, and a new code replaces the old one', async () => {
    const first = await newCode();
    expect(first).toMatch(AGENT_PAIRING_CODE_PATTERN);
    const second = await newCode();
    const stale = await pair(first);
    expect(stale.statusCode).toBe(400);
    expect(codeOf(stale)).toBe('agent-pairing-code-invalid');
    expect((await pair(second)).statusCode).toBe(201);
    const stored = await h.db.query('select code_hash from agent_pairing_codes');
    expect(JSON.stringify(stored.rows)).not.toContain(second);
  });

  it('refuses a code request from another origin, without one, and from a bearer caller', async () => {
    for (const origin of [null, 'https://evil.test', 'null']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/agent/pairing-codes',
        headers: browser(alice, origin),
      });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('identity-origin-refused');
    }
    const desktop = await signedInUser(h, { email: 'desk@example.com' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/agent/pairing-codes', headers: desktop.headers });
    expect(res.statusCode).toBe(401);
  });

  // ---- pairing -------------------------------------------------------------------------

  it('pairs an agent with the code, answers the public URL, and audits agent.paired', async () => {
    const code = await newCode();
    const res = await pair(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`);
    expect(res.statusCode).toBe(201);
    const { pairingId, origin } = res.json<{ pairingId: string; origin: string }>();
    expect(origin).toBe(PUBLIC_URL);
    expect(audits.find((e) => e.action === 'agent.paired')).toMatchObject({
      actor: { kind: 'user', userId: alice.user.id, email: 'alice@example.com' },
      target: { kind: 'agent-pairing', id: pairingId },
      details: { agentId: 'agent-1', port: 47615, sshOptIn: false },
    });
    // Single use: the same code again is wrong.
    expect(codeOf(await pair(code))).toBe('agent-pairing-code-invalid');
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/agent/pairings', headers: browser(alice) });
    expect(list.json()).toEqual({
      pairings: [
        {
          id: pairingId,
          agentId: 'agent-1',
          port: 47615,
          sshOptIn: false,
          createdAt: h.clock.now.toISOString(),
          lastSeenAt: h.clock.now.toISOString(),
        },
      ],
    });
  });

  it('refuses an expired code', async () => {
    const code = await newCode();
    h.clock.advance(10 * 60 * 1000);
    const res = await pair(code);
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('agent-pairing-code-invalid');
  });

  it('stops an address on the fifth wrong attempt, for the life of a code', async () => {
    const code = await newCode();
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let i = 0; i < 4; i++)
      expect(codeOf(await pair(wrong, { remoteAddress: '203.0.113.9' }))).toBe('agent-pairing-code-invalid');
    expect(codeOf(await pair(wrong, { remoteAddress: '203.0.113.9' }))).toBe('agent-pairing-code-invalid');
    // Five spent: even the right code is refused from that address until the window refills.
    const blocked = await pair(code, { remoteAddress: '203.0.113.9' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // The guesses were never tied to the code, so the user's own agent still pairs.
    expect((await pair(code, { remoteAddress: '198.51.100.7' })).statusCode).toBe(201);
  });

  it('refuses a public key that is not Ed25519, without spending the code', async () => {
    const code = await newCode();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const res = await pair(code, { key: { publicKey: rsa, sign: () => '' } });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('invalid-request');
    expect((await pair(code)).statusCode).toBe(201);
  });

  it('pairing the same agent again keeps its pairing id and takes the new key', async () => {
    const first = await paired();
    const newKey = agentKey();
    const again = await paired(alice, { key: newKey });
    expect(again).toBe(first);
    const nonce = await issueNonce(first);
    expect((await redeem(nonce, first)).statusCode).toBe(401);
    expect((await redeem(nonce, first, { key: newKey })).statusCode).toBe(200);
  });

  // ---- nonces --------------------------------------------------------------------------

  it('redeems a nonce once, answering the tab’s user, and audits it without the nonce', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    const res = await redeem(nonce, pairingId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: alice.user.id, email: 'alice@example.com', displayName: 'alice' });
    expect(audits.find((e) => e.action === 'agent.nonce.redeemed')).toMatchObject({
      actor: { kind: 'user', userId: alice.user.id },
      target: { kind: 'agent-pairing', id: pairingId },
    });
    const replay = await redeem(nonce, pairingId);
    expect(replay.statusCode).toBe(401);
    expect(codeOf(replay)).toBe('agent-nonce-invalid');
    expect(audits.find((e) => e.action === 'agent.nonce.refused')).toMatchObject({
      target: { kind: 'agent-pairing', id: pairingId },
      details: { reason: 'nonce' },
    });
    expect(JSON.stringify(audits)).not.toContain(nonce);
  });

  it('refuses a nonce request from another origin, or for a pairing that is not the caller’s', async () => {
    const pairingId = await paired();
    const foreign = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: browser(alice, 'https://evil.test'),
      payload: { pairingId },
    });
    expect(foreign.statusCode).toBe(403);
    const bob = await signedInUser(h, { email: 'bob@example.com', kind: 'browser' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/nonces',
      headers: browser(bob),
      payload: { pairingId },
    });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('agent-pairing-unknown');
  });

  it('refuses an expired nonce', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    h.clock.advance(60_000);
    const res = await redeem(nonce, pairingId);
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('agent-nonce-invalid');
  });

  it('refuses a bad signature without burning the nonce', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    const forged = await redeem(nonce, pairingId, { key: agentKey() });
    expect(forged.statusCode).toBe(401);
    expect(codeOf(forged)).toBe('agent-signature-invalid');
    expect(audits.at(-1)).toMatchObject({ action: 'agent.nonce.refused', details: { reason: 'signature' } });
    expect((await redeem(nonce, pairingId)).statusCode).toBe(200);
  });

  it('refuses a timestamp more than 60 s old or ahead', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    for (const offset of [-61_000, 61_000]) {
      const timestamp = new Date(h.clock.now.getTime() + offset).toISOString();
      const res = await redeem(nonce, pairingId, { timestamp });
      expect(res.statusCode).toBe(401);
      expect(codeOf(res)).toBe('agent-signature-invalid');
      expect(audits.at(-1)).toMatchObject({ action: 'agent.nonce.refused', details: { reason: 'timestamp' } });
    }
    expect((await redeem(nonce, pairingId)).statusCode).toBe(200);
  });

  it('refuses an unknown pairing, missing headers, and a nonce issued for another pairing', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    const unknown = await redeem(nonce, '01JZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(unknown.statusCode).toBe(404);
    expect(codeOf(unknown)).toBe('agent-pairing-unknown');
    const bare = await h.app.inject({ method: 'POST', url: '/api/v1/agent/nonces/redeem', payload: { nonce } });
    expect(bare.statusCode).toBe(401);
    expect(codeOf(bare)).toBe('agent-signature-invalid');
    const otherKey = agentKey();
    const other = await paired(alice, { key: otherKey, agentId: 'agent-2' });
    const crossed = await redeem(nonce, other, { key: otherKey });
    expect(crossed.statusCode).toBe(401);
    expect(codeOf(crossed)).toBe('agent-nonce-invalid');
    expect((await redeem(nonce, pairingId)).statusCode).toBe(200);
  });

  // ---- unpairing and port --------------------------------------------------------------

  it('unpairs from the browser: deletes the row, audits, announces agentUnpaired', async () => {
    const pairingId = await paired();
    const nonce = await issueNonce(pairingId);
    const foreign = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/agent/pairings/${pairingId}`,
      headers: browser(alice, 'https://evil.test'),
    });
    expect(foreign.statusCode).toBe(403);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/agent/pairings/${pairingId}`,
      headers: browser(alice),
    });
    expect(res.statusCode).toBe(204);
    expect(unpaired).toEqual([{ pairingId, userId: alice.user.id }]);
    expect(audits.find((e) => e.action === 'agent.unpaired')).toMatchObject({
      actor: { kind: 'user', userId: alice.user.id },
      details: { by: 'user' },
    });
    expect(codeOf(await redeem(nonce, pairingId))).toBe('agent-pairing-unknown');
    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/agent/pairings/${pairingId}`,
      headers: browser(alice),
    });
    expect(again.statusCode).toBe(404);
  });

  it('unpairs from the agent with a signed DELETE, and refuses a signature over another path', async () => {
    const pairingId = await paired();
    const url = `/api/v1/agent/pairings/${pairingId}`;
    const wrongPath = await h.app.inject({
      method: 'DELETE',
      url,
      headers: signed('DELETE', pairingId, { path: '/api/v1/agent/pairings/other' }),
    });
    expect(wrongPath.statusCode).toBe(401);
    expect(codeOf(wrongPath)).toBe('agent-signature-invalid');
    const res = await h.app.inject({ method: 'DELETE', url, headers: signed('DELETE', pairingId) });
    expect(res.statusCode).toBe(204);
    expect(unpaired).toEqual([{ pairingId, userId: alice.user.id }]);
    expect(audits.find((e) => e.action === 'agent.unpaired')).toMatchObject({
      actor: { kind: 'user', userId: alice.user.id },
      details: { by: 'agent', agentId: 'agent-1' },
    });
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/agent/pairings', headers: browser(alice) });
    expect(list.json()).toEqual({ pairings: [] });
  });

  it('refuses an unpair with neither a session nor a signature', async () => {
    const pairingId = await paired();
    const res = await h.app.inject({ method: 'DELETE', url: `/api/v1/agent/pairings/${pairingId}` });
    expect(res.statusCode).toBe(401);
    expect(unpaired).toEqual([]);
  });

  it('takes the agent’s new port from a signed PATCH only', async () => {
    const pairingId = await paired();
    const url = `/api/v1/agent/pairings/${pairingId}`;
    const unsigned = await h.app.inject({ method: 'PATCH', url, headers: browser(alice), payload: { port: 47616 } });
    expect(unsigned.statusCode).toBe(401);
    const forged = await h.app.inject({
      method: 'PATCH',
      url,
      headers: signed('PATCH', pairingId, { key: agentKey() }),
      payload: { port: 47616 },
    });
    expect(codeOf(forged)).toBe('agent-signature-invalid');
    h.clock.advance(5_000);
    const res = await h.app.inject({
      method: 'PATCH',
      url,
      headers: signed('PATCH', pairingId),
      payload: { port: 47616 },
    });
    expect(res.statusCode).toBe(204);
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/agent/pairings', headers: browser(alice) });
    expect(list.json<{ pairings: { port: number; lastSeenAt: string }[] }>().pairings[0]).toMatchObject({
      port: 47616,
      lastSeenAt: h.clock.now.toISOString(),
    });
  });

  // ---- sweep ---------------------------------------------------------------------------

  it('sweeps expired codes and nonces', async () => {
    const pairingId = await paired();
    await newCode();
    await issueNonce(pairingId);
    expect(await sweepAgent(h.db, h.clock.now)).toEqual({ codes: 0, nonces: 0 });
    h.clock.advance(10 * 60 * 1000);
    expect(await sweepAgent(h.db, h.clock.now)).toEqual({ codes: 1, nonces: 1 });
  });
});

describeDb('the agent module with the browser client off', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness({ modules: [agentModule({ sweepIntervalMs: 0 })] });
  });
  afterEach(() => h.close());

  it('registers no routes', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/agent/pairings', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
