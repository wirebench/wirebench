/**
 * The agent's loopback server over real sockets on 127.0.0.1 (hosted edition spec §18.3), against a fake
 * Wirebench Server that checks every signature: the refusals of the plan's review focus (a foreign,
 * missing or `null` Origin, DNS rebinding, a call before auth, a replayed nonce, a late auth frame, a
 * refused channel), the port fallback, the preflight and the port report.
 */
import { writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_CLOSE } from '@wirebench/host';
import { pair, unpair, type AgentFetch } from '../src/pair.js';
import { openPairingStore, PAIRINGS_FILE, type PairingStore } from '../src/pairings.js';
import {
  AGENT_CALLER_ID_BASE,
  AgentPortsBusyError,
  startAgent,
  type RunningAgent,
  type StartAgentOptions,
} from '../src/server.js';
import { AGENT_PORTS } from '../src/ports.js';
import {
  cleanUp,
  fakeHost,
  fakePlatform,
  onCleanUp,
  openSocket,
  rawUpgrade,
  rawUpgradeStatus,
  registryChannelNames,
  startFakeServer,
  type FakeServer,
} from './helpers.js';

afterEach(cleanUp);

const fetch: AgentFetch = (url, init) => globalThis.fetch(url, init);

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Holds `port` on 127.0.0.1 until clean-up. */
async function occupy(port: number): Promise<NetServer> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  onCleanUp(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

interface Setup {
  readonly server: FakeServer;
  readonly store: PairingStore;
  readonly pairingId: string;
  readonly port: number;
  readonly agent: RunningAgent;
}

async function setUp(extra: Partial<StartAgentOptions> = {}, sshOptIn = false): Promise<Setup> {
  const server = await startFakeServer();
  const platform = fakePlatform();
  const store = await openPairingStore(platform);
  const port = await freePort();
  const { pairingId } = await pair({ code: server.code, serverUrl: server.url, sshOptIn, store, fetch, port });
  const agent = await startAgent({
    host: fakeHost(registryChannelNames()),
    platform,
    store,
    fetch,
    ports: [port],
    ...extra,
  });
  onCleanUp(() => agent.close());
  return { server, store, pairingId, port: agent.port, agent };
}

/** An authenticated socket, past its hello. */
async function authed(setup: Setup) {
  const socket = openSocket(setup.port, { origin: setup.server.origin });
  socket.send({ type: 'auth', pairingId: setup.pairingId, nonce: setup.server.nonce(setup.pairingId) });
  const hello = await socket.next();
  let id = 0;
  const call = async (channel: string, request?: unknown) => {
    id += 1;
    socket.send({ id, channel, request });
    return socket.next();
  };
  return { socket, hello, call };
}

describe('startAgent', () => {
  it('lets a paired tab in after the agent redeems its nonce, then serves agent.hello', async () => {
    const setup = await setUp({}, true);
    const { hello, call } = await authed(setup);
    expect(hello).toEqual({
      type: 'hello',
      host: 'agent',
      capabilities: ['send:public', 'send:private', 'kerberos'],
      sshOptIn: true,
    });
    expect(setup.server.seen.filter((one) => one.path.endsWith('/redeem'))).toEqual([
      expect.objectContaining({ signed: true }),
    ]);
    expect(await call('agent.hello')).toEqual({
      id: 1,
      ok: true,
      value: { capabilities: ['send:public', 'send:private', 'kerberos'], version: '9.9.9-test', sshOptIn: true },
    });
  });

  it('answers host-capability-missing for every registry channel, though the host would serve each', async () => {
    const setup = await setUp();
    const { call } = await authed(setup);
    const names = registryChannelNames();
    const served: string[] = [];
    for (const name of names) {
      const reply = (await call(name)) as { ok: boolean; error?: { code: string } };
      if (reply.ok || reply.error?.code !== 'host-capability-missing') served.push(name);
    }
    expect(served).toEqual([]);
    expect(await call('agent.nothing')).toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'agent' } },
    });
  });

  it('runs an embedder handler for agent.* with a caller id far above any window id', async () => {
    const setup = await setUp({
      handlers: new Map([
        ['agent.whoami', (_request, { caller, pairing }) => Promise.resolve([caller.id, pairing.pairingId])],
      ]),
    });
    const first = await authed(setup);
    const second = await authed(setup);
    const [a] = ((await first.call('agent.whoami')) as { value: [number, string] }).value;
    const [b, pairingId] = ((await second.call('agent.whoami')) as { value: [number, string] }).value;
    expect(a).toBeGreaterThanOrEqual(AGENT_CALLER_ID_BASE);
    expect(b).toBe(a + 1);
    expect(pairingId).toBe(setup.pairingId);
  });

  it.each([
    ['a foreign Origin', 'https://elsewhere.example.test'],
    ['no Origin', undefined],
    ['a null Origin', 'null'],
  ])('closes 4403 before any frame for %s', async (_label, origin) => {
    const setup = await setUp();
    const socket = openSocket(setup.port, origin === undefined ? {} : { origin });
    socket.send({ type: 'auth', pairingId: setup.pairingId, nonce: setup.server.nonce(setup.pairingId) });
    expect(await socket.closed).toEqual({ code: HOST_CLOSE.forbidden });
    expect(socket.frames).toEqual([]);
    expect(setup.server.seen.filter((one) => one.path.endsWith('/redeem'))).toEqual([]);
  });

  it('refuses an upgrade whose Host is not the loopback address and port, before the handshake', async () => {
    const setup = await setUp();
    for (const host of [
      'evil.example.test',
      `evil.example.test:${String(setup.port)}`,
      '127.0.0.1',
      `127.0.0.1:${String(setup.port + 1)}`,
      `[::1]:${String(setup.port)}`,
    ]) {
      const socket = openSocket(setup.port, { origin: setup.server.origin, host });
      expect(await socket.closed, host).toEqual({ status: 403 });
    }
    const local = await authed({ ...setup });
    expect(local.hello).toMatchObject({ type: 'hello' });
    const named = openSocket(setup.port, { origin: setup.server.origin, host: `localhost:${String(setup.port)}` });
    named.send({ type: 'auth', pairingId: setup.pairingId, nonce: setup.server.nonce(setup.pairingId) });
    expect(await named.next()).toMatchObject({ type: 'hello' });
  });

  it('closes 4401 for a call before auth, and serves nothing', async () => {
    const setup = await setUp();
    const socket = openSocket(setup.port, { origin: setup.server.origin });
    socket.send({ id: 1, channel: 'agent.hello' });
    expect(await socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
    expect(socket.frames).toEqual([]);
  });

  it('closes 4401 for a replayed nonce: the server refuses its second redeem', async () => {
    const setup = await setUp();
    const nonce = setup.server.nonce(setup.pairingId);
    const first = openSocket(setup.port, { origin: setup.server.origin });
    first.send({ type: 'auth', pairingId: setup.pairingId, nonce });
    expect(await first.next()).toMatchObject({ type: 'hello' });
    const replay = openSocket(setup.port, { origin: setup.server.origin });
    replay.send({ type: 'auth', pairingId: setup.pairingId, nonce });
    expect(await replay.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
    expect(replay.frames).toEqual([]);
  });

  it('closes 4401 for a pairing of another origin, an unknown pairing or a frame of another shape', async () => {
    const setup = await setUp();
    const other = await startFakeServer();
    const { pairingId: otherId } = await pair({
      code: other.code,
      serverUrl: other.url,
      sshOptIn: false,
      store: setup.store,
      fetch,
      port: setup.port,
    });
    const frames = [
      { type: 'auth', pairingId: otherId, nonce: other.nonce(otherId) },
      { type: 'auth', pairingId: '01JUNKJUNKJUNKJUNKJUNKJUNK', nonce: 'n' },
      { type: 'auth', pairingId: setup.pairingId, nonce: setup.server.nonce(setup.pairingId), extra: 1 },
    ];
    for (const frame of frames) {
      const socket = openSocket(setup.port, { origin: setup.server.origin });
      socket.send(frame);
      expect(await socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
    }
    // The other server's nonce was never sent to the other server: the agent redeems only at the pairing's own.
    expect(other.seen.filter((one) => one.path.endsWith('/redeem'))).toEqual([]);
  });

  it('closes 4401 when no auth frame comes before the deadline', async () => {
    const setup = await setUp({ authTimeoutMs: 50 });
    const socket = openSocket(setup.port, { origin: setup.server.origin });
    expect(await socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
  });

  it('takes the next port when the first is busy, and gives up past the last', async () => {
    const busy = await freePort();
    await occupy(busy);
    const next = await freePort();
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const agent = await startAgent({ host: fakeHost(), platform, store, fetch, ports: [busy, next] });
    onCleanUp(() => agent.close());
    expect(agent.port).toBe(next);
    await expect(startAgent({ host: fakeHost(), platform, store, fetch, ports: [busy] })).rejects.toBeInstanceOf(
      AgentPortsBusyError,
    );
    expect(AGENT_PORTS[0]).toBe(47_615);
    expect(AGENT_PORTS.at(-1)).toBe(47_634);
    expect(AGENT_PORTS).toHaveLength(20);
  });

  it('answers the private-network preflight for a paired origin only, and 404 for anything else', async () => {
    const setup = await setUp();
    const base = `http://127.0.0.1:${String(setup.port)}`;
    const paired = await globalThis.fetch(`${base}/host`, {
      method: 'OPTIONS',
      headers: { origin: setup.server.origin },
    });
    expect(paired.status).toBe(204);
    expect(paired.headers.get('access-control-allow-origin')).toBe(setup.server.origin);
    expect(paired.headers.get('access-control-allow-private-network')).toBe('true');
    expect(paired.headers.get('vary')).toBe('Origin');
    const foreign = await globalThis.fetch(`${base}/host`, {
      method: 'OPTIONS',
      headers: { origin: 'https://elsewhere.example.test' },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    for (const path of ['/', '/host', '/pairings']) {
      const plain = await globalThis.fetch(`${base}${path}`);
      expect(plain.status, path).toBe(404);
      expect(await plain.text()).toBe('');
    }
    const elsewhere = openSocket(setup.port, { origin: setup.server.origin, path: '/other' });
    expect(await elsewhere.closed).toEqual({ status: 404 });
  });

  it('tells a pairing whose server knows another port the new one, signed', async () => {
    const server = await startFakeServer();
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: server.url,
      sshOptIn: false,
      store,
      fetch,
      port: 47_615,
    });
    expect(store.get(pairingId)?.port).toBe(47_615);
    const port = await freePort();
    const agent = await startAgent({ host: fakeHost(), platform, store, fetch, ports: [port] });
    await agent.close();
    expect(server.seen.at(-1)).toMatchObject({ method: 'PATCH', signed: true, body: JSON.stringify({ port }) });
    expect(server.pairings.get(pairingId)?.port).toBe(port);
    expect(store.get(pairingId)?.port).toBe(port);

    // Told once: a restart on the same port sends nothing.
    const count = server.seen.length;
    const again = await startAgent({ host: fakeHost(), platform, store, fetch, ports: [port] });
    await again.close();
    expect(server.seen).toHaveLength(count);
  });

  it('starts with no pairings, and closes its sockets 1001', async () => {
    const setup = await setUp();
    const { socket } = await authed(setup);
    const platform = fakePlatform();
    const empty = await startAgent({
      host: fakeHost(),
      platform,
      store: await openPairingStore(platform),
      fetch,
      ports: [await freePort()],
    });
    await empty.close();
    await setup.agent.close();
    expect(await socket.closed).toEqual({ code: HOST_CLOSE.goingAway });
  });

  it('reaches no host channel by an agent.* name: only the agent handlers answer', async () => {
    const server = await startFakeServer();
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const port = await freePort();
    const { pairingId } = await pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store, fetch, port });
    const agent = await startAgent({
      host: fakeHost(['agent.secret', 'agent.send', 'fs.openText']),
      platform,
      store,
      fetch,
      ports: [port],
    });
    onCleanUp(() => agent.close());
    const { call } = await authed({ server, store, pairingId, port, agent });
    for (const channel of ['agent.secret', 'agent.send', 'fs.openText']) {
      expect(await call(channel), channel).toMatchObject({ ok: false, error: { code: 'host-capability-missing' } });
    }
  });

  it("ends a pairing's open sockets 4401 when it is unpaired here, and leaves the others", async () => {
    const setup = await setUp();
    const other = await startFakeServer();
    const { pairingId: otherId } = await pair({
      code: other.code,
      serverUrl: other.url,
      sshOptIn: false,
      store: setup.store,
      fetch,
      port: setup.port,
    });
    const doomed = await authed(setup);
    const kept = await authed({ ...setup, server: other, pairingId: otherId });
    await unpair({ pairingId: setup.pairingId, store: setup.store, fetch });
    expect(await doomed.socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
    expect(await kept.call('agent.hello')).toMatchObject({ ok: true });
  });

  it('takes a pairing another process made, and ends its sockets when another process removes it', async () => {
    const server = await startFakeServer();
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    await store.identity();
    const port = await freePort();
    const agent = await startAgent({ host: fakeHost(), platform, store, fetch, ports: [port], refreshIntervalMs: 50 });
    onCleanUp(() => agent.close());

    // `wirebench agent pair` in a second process, over the same file.
    const elsewhere = await openPairingStore(fakePlatform(undefined, platform.paths.userData()));
    const { pairingId } = await pair({
      code: server.code,
      serverUrl: server.url,
      sshOptIn: false,
      store: elsewhere,
      fetch,
      port,
    });
    const preflight = await globalThis.fetch(`http://127.0.0.1:${String(port)}/host`, {
      method: 'OPTIONS',
      headers: { origin: server.origin },
    });
    expect(preflight.status).toBe(204);
    const tab = await authed({ server, store, pairingId, port, agent });
    expect(tab.hello).toMatchObject({ type: 'hello' });

    await elsewhere.remove(pairingId);
    expect(await tab.socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
  });

  it('aborts the redeem when the socket closes before the server answers', async () => {
    const setup = await setUp({ authTimeoutMs: 100 });
    setup.server.holdRedeem = true;
    const socket = openSocket(setup.port, { origin: setup.server.origin });
    socket.send({ type: 'auth', pairingId: setup.pairingId, nonce: setup.server.nonce(setup.pairingId) });
    expect(await socket.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
    await expect.poll(() => setup.server.abortedRedeems, { timeout: 2_000 }).toBe(1);
  });

  it('refuses every other spelling of the loopback Host, and a missing one', async () => {
    const setup = await setUp();
    const port = String(setup.port);
    const origin = setup.server.origin;
    for (const host of [
      `LOCALHOST:${port}`,
      `127.0.0.1.:${port}`,
      `localhost.:${port}`,
      `[::1]:${port}`,
      `127.0.0.1:${port}.`,
    ]) {
      expect(await rawUpgradeStatus(setup.port, { Host: host, Origin: origin }), host).toBe(403);
    }
    // Node answers an HTTP/1.1 request with no Host itself (400); either way it never upgrades.
    expect([400, 403]).toContain(await rawUpgradeStatus(setup.port, { Origin: origin }));
    expect(await rawUpgradeStatus(setup.port, { Host: `127.0.0.1:${port}`, Origin: origin })).toBe(101);
    expect(await rawUpgradeStatus(setup.port, { Host: `localhost:${port}`, Origin: origin })).toBe(101);
  });

  it('refuses an upgrade that was waiting on the file once close() has started', async () => {
    const server = await startFakeServer();
    const platform = fakePlatform();
    const real = await openPairingStore(platform);
    const port = await freePort();
    await pair({ code: server.code, serverUrl: server.url, sshOptIn: false, store: real, fetch, port });
    const gate: { until?: Promise<void> } = {};
    let entered: () => void = () => undefined;
    const store: PairingStore = {
      ...real,
      refresh: async () => {
        if (gate.until !== undefined) {
          entered();
          await gate.until;
        }
        return real.refresh();
      },
    };
    const agent = await startAgent({ host: fakeHost(), platform, store, fetch, ports: [port] });
    let open: () => void = () => undefined;
    gate.until = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const answer = rawUpgrade(port, { Host: `127.0.0.1:${String(port)}`, Origin: server.origin });
    await inside;
    const closed = agent.close();
    open();
    // The agent's own refusal (an empty body), not one from the WebSocket server after it closed.
    const { status, head } = await answer;
    expect(status).toBe(503);
    expect(head).toContain('Content-Length: 0');
    expect(head).not.toContain('text/html');
    await closed;
  });

  it('logs a broken pairings file once per change while it polls', async () => {
    const logs: string[] = [];
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    await store.identity();
    const agent = await startAgent({
      host: fakeHost(),
      platform,
      store,
      fetch,
      ports: [await freePort()],
      refreshIntervalMs: 10,
      log: (message) => logs.push(message),
    });
    onCleanUp(() => agent.close());
    const path = join(platform.paths.userData(), PAIRINGS_FILE);
    writeFileSync(path, 'broken');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs).toEqual(['the pairings file could not be read again']);
    writeFileSync(path, 'broken, differently');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs).toHaveLength(2);
  });
});
