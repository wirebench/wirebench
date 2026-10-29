/**
 * `pair()` and `unpair()` against a fake server that checks every signature (hosted edition spec §18.2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { normaliseServerUrl, pair, redeemNonce, reportPort, unpair, type AgentFetch } from '../src/pair.js';
import { openPairingStore } from '../src/pairings.js';
import { cleanUp, fakePlatform, startFakeServer } from './helpers.js';

afterEach(cleanUp);

const fetch: AgentFetch = (url, init) => globalThis.fetch(url, init);

describe('pair and unpair', () => {
  it('pairs with a code, keeps the pairing, then unpairs signed at the server and here', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const result = await pair({
      code: server.code,
      serverUrl: `${server.url}/`,
      sshOptIn: true,
      store,
      fetch,
      port: 47_620,
    });
    expect(result).toMatchObject({ origin: server.origin, email: server.email });
    expect(result.pairingId).toMatch(/^[0-9A-Z]{26}$/);

    const sent = JSON.parse(server.seen[0]?.body ?? '{}') as Record<string, unknown>;
    const { agentId, key } = await store.identity();
    expect(sent).toEqual({ code: server.code, agentId, publicKey: key.publicKey, port: 47_620, sshOptIn: true });
    expect(Date.parse(store.get(result.pairingId)?.createdAt ?? '')).not.toBeNaN();
    expect(store.list()).toEqual([
      {
        pairingId: result.pairingId,
        serverUrl: server.url,
        origin: server.origin,
        email: server.email,
        sshOptIn: true,
        createdAt: store.get(result.pairingId)?.createdAt,
        port: 47_620,
      },
    ]);

    await unpair({ pairingId: result.pairingId, store, fetch });
    expect(server.seen.at(-1)).toMatchObject({ method: 'DELETE', signed: true, body: '' });
    expect(server.pairings.size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('forgets a pairing the server no longer knows (404)', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: server.url,
      sshOptIn: false,
      store,
      fetch,
      port: 47_615,
    });
    server.pairings.clear();
    await unpair({ pairingId, store, fetch });
    expect(store.list()).toEqual([]);
  });

  it('keeps the pairing when the server cannot be reached', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: server.url,
      sshOptIn: false,
      store,
      fetch,
      port: 47_615,
    });
    const down: AgentFetch = () => Promise.reject(new Error('offline'));
    await expect(unpair({ pairingId, store, fetch: down })).rejects.toMatchObject({ code: 'unreachable' });
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a wrong code and keeps nothing', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    await expect(
      pair({ code: 'WRONG2', serverUrl: server.url, sshOptIn: false, store, fetch, port: 47_615 }),
    ).rejects.toMatchObject({
      code: 'refused',
      status: 401,
    });
    expect(store.list()).toEqual([]);
  });

  it("refuses an answer naming another server's origin, and keeps nothing", async () => {
    const server = await startFakeServer();
    server.answerOrigin = 'https://team.example.test';
    const store = await openPairingStore(fakePlatform());
    await expect(
      pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch, port: 47_615 }),
    ).rejects.toMatchObject({ code: 'bad-answer' });
    expect(store.list()).toEqual([]);
  });

  it('pairs with the origin of the address typed, dropping a path', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: `${server.url}/some/page?x=1#y`,
      sshOptIn: false,
      store,
      fetch,
      port: 47_615,
    });
    expect(store.get(pairingId)).toMatchObject({ serverUrl: server.origin, origin: server.origin });
    expect(server.seen[0]?.path).toBe('/api/v1/agent/pairings');
  });

  it('refuses http:// for a server off this machine, before sending the code', async () => {
    const store = await openPairingStore(fakePlatform());
    let sent = 0;
    const counting: AgentFetch = () => {
      sent += 1;
      return Promise.reject(new Error('not reached'));
    };
    for (const serverUrl of ['http://team.example.test', 'http://10.0.0.5:8080', 'http://[fe80::1]', 'ftp://x']) {
      await expect(
        pair({ code: 'ABCDEF', serverUrl, sshOptIn: false, store, fetch: counting, port: 47_615 }),
        serverUrl,
      ).rejects.toMatchObject({ code: 'unreachable' });
    }
    expect(sent).toBe(0);
    expect(normaliseServerUrl('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(normaliseServerUrl('http://127.0.0.2')).toBe('http://127.0.0.2');
    expect(normaliseServerUrl('http://[::1]:9/')).toBe('http://[::1]:9');
    expect(normaliseServerUrl('https://team.example.test/wb/')).toBe('https://team.example.test');
  });

  it('refuses an answer whose origin is not a plain origin', async () => {
    const server = await startFakeServer();
    server.answerOrigin = 'https://team.example.test/path';
    const store = await openPairingStore(fakePlatform());
    await expect(
      pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch, port: 47_615 }),
    ).rejects.toMatchObject({ code: 'bad-answer' });
    expect(store.list()).toEqual([]);
  });
});

describe('a pairing the server no longer holds', () => {
  async function paired() {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: server.url,
      sshOptIn: false,
      store,
      fetch,
      port: 47_615,
    });
    return { server, store, pairingId, pairing: store.get(pairingId)! };
  }

  it('is removed here when a port report or a redeem gets agent-pairing-unknown', async () => {
    const reported = await paired();
    reported.server.pairings.clear();
    await expect(reportPort(reported.pairing, 47_620, reported.store, fetch)).rejects.toMatchObject({
      code: 'unpaired',
      status: 404,
    });
    expect(reported.store.list()).toEqual([]);

    const redeemed = await paired();
    const nonce = redeemed.server.nonce(redeemed.pairingId);
    redeemed.server.pairings.clear();
    await expect(redeemNonce(redeemed.pairing, nonce, redeemed.store, fetch)).rejects.toMatchObject({
      code: 'unpaired',
    });
    expect(redeemed.store.list()).toEqual([]);
  });

  it('is kept for any other answer: none, a 5xx, a refused signature, a bare 404', async () => {
    const { server, store, pairingId, pairing } = await paired();
    const down: AgentFetch = () => Promise.reject(new Error('offline'));
    await expect(reportPort(pairing, 47_620, store, down)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(redeemNonce(pairing, server.nonce(pairingId), store, down)).rejects.toMatchObject({
      code: 'unreachable',
    });
    for (const answer of [
      { status: 503, body: { code: 'unavailable', message: 'Try later' } },
      { status: 401, body: { code: 'agent-signature-invalid' } },
      { status: 404 },
      { status: 404, body: { code: 'not-found' } },
    ]) {
      server.signedAnswer = answer;
      await expect(reportPort(pairing, 47_620, store, fetch), String(answer.status)).rejects.toMatchObject({
        code: 'refused',
        status: answer.status,
      });
      await expect(redeemNonce(pairing, server.nonce(pairingId), store, fetch)).rejects.toMatchObject({
        code: 'refused',
      });
    }
    expect(store.list()).toHaveLength(1);
  });
});
