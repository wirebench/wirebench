/**
 * `pair()` and `unpair()` against a fake server that checks every signature (hosted edition spec §18.2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pair, unpair, type AgentFetch } from '../src/pair.js';
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
    const { pairingId } = await pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch });
    server.pairings.clear();
    await unpair({ pairingId, store, fetch });
    expect(store.list()).toEqual([]);
  });

  it('keeps the pairing when the server cannot be reached', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    const { pairingId } = await pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch });
    const down: AgentFetch = () => Promise.reject(new Error('offline'));
    await expect(unpair({ pairingId, store, fetch: down })).rejects.toMatchObject({ code: 'unreachable' });
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a wrong code and keeps nothing', async () => {
    const server = await startFakeServer();
    const store = await openPairingStore(fakePlatform());
    await expect(pair({ code: 'WRONG2', serverUrl: server.url, sshOptIn: false, store, fetch })).rejects.toMatchObject({
      code: 'refused',
      status: 401,
    });
    expect(store.list()).toEqual([]);
  });

  it('refuses an answer whose origin is not a plain origin', async () => {
    const server = await startFakeServer();
    server.answerOrigin = 'https://team.example.test/path';
    const store = await openPairingStore(fakePlatform());
    await expect(
      pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch }),
    ).rejects.toMatchObject({ code: 'bad-answer' });
    expect(store.list()).toEqual([]);
  });
});
