// @vitest-environment node
/**
 * The desktop app as this machine's agent (hosted edition spec §18.2, §18.5): no listener without a pairing,
 * one after *Pair this machine…*, none again after the last pairing goes (unpaired here, or answered unknown by
 * its server after an unpairing in the tab); the `machineAgent.*` channels on the desktop's own table, and no
 * `agent.*` channel there at all. Its pairings file is its own: `wirebench agent` keeps another.
 */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunningAgent, StartAgentOptions } from '@wirebench/agent';
import { generateId } from '@wirebench/engine';
import { createHost, type Host } from '../../../../packages/host/src/host/create-host.js';
import { createFakePlatform, fakeCaller } from '../../../../packages/host/test/helpers/fake-platform.js';
import { MachineAgent } from '../../src/main/machine-agent.js';

const SERVER = 'https://wirebench.example.test';
const GOOD_CODE = 'ABC234';

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether `port` on 127.0.0.1 can be listened on now: nothing else holds it. */
async function free(port: number): Promise<boolean> {
  const server = createServer();
  const listened = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true));
  });
  if (listened) await new Promise<void>((resolve) => server.close(() => resolve()));
  return listened;
}

const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});

/**
 * A server that pairs `GOOD_CODE`, refuses any other code with 404, and accepts an unpairing and a port.
 * `unknownPairings` answers every signed call as a server that no longer holds the pairing; `failSigned`
 * answers them `503`.
 */
function fakeServer() {
  const calls: { method: string; url: string }[] = [];
  const state = { unknownPairings: false, failSigned: false };
  const answer = (url: string, init: RequestInit): Response => {
    calls.push({ method: init.method ?? 'GET', url });
    if (init.method === 'POST' && url.endsWith('/api/v1/agent/pairings')) {
      const body = JSON.parse(init.body as string) as { code: string };
      if (body.code !== GOOD_CODE) return new Response('{}', { status: 404 });
      return Response.json({ pairingId: generateId(), origin: SERVER, email: 'ada@example.test' }, { status: 201 });
    }
    if (init.method === 'DELETE' || init.method === 'PATCH') {
      if (state.unknownPairings) {
        return Response.json({ code: 'agent-pairing-unknown', message: 'Not paired any more.' }, { status: 404 });
      }
      if (state.failSigned) return Response.json({ code: 'unavailable', message: 'Try later' }, { status: 503 });
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  };
  const fetch = (url: string, init: RequestInit): Promise<Response> => Promise.resolve(answer(url, init));
  return Object.assign(state, { fetch, calls });
}

/** A `startAgent` that listens nowhere: records each start and close. */
function fakeStart() {
  const started: StartAgentOptions[] = [];
  let closed = 0;
  const start = (options: StartAgentOptions): Promise<RunningAgent> => {
    started.push(options);
    return Promise.resolve({
      port: 47616,
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
  };
  return { start, started, closed: () => closed };
}

async function setUp() {
  const platform = createFakePlatform();
  const host = await createHost(platform);
  hosts.push(host);
  const server = fakeServer();
  const agent = fakeStart();
  const machine = await MachineAgent.open({ host, platform, fetch: server.fetch, start: agent.start });
  machine.register(host.handlers);
  const call = async (channel: string, request: unknown): Promise<unknown> =>
    await host.handlers.get(channel)!(request, fakeCaller(1));
  return { platform, host, machine, agent, server, call };
}

describe('the desktop agent', () => {
  it('opens no listener and serves no agent.* channel without a pairing', async () => {
    const { host, machine, agent, call } = await setUp();
    await machine.sync();
    expect(agent.started).toEqual([]);
    expect(machine.port).toBeUndefined();
    const names = [...host.handlers.keys()];
    expect(names.filter((name) => name.startsWith('agent.'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('machineAgent.')).sort()).toEqual([
      'machineAgent.pair',
      'machineAgent.setAllowedSystemNames',
      'machineAgent.status',
      'machineAgent.unpair',
    ]);
    await expect(call('machineAgent.status', undefined)).resolves.toEqual({
      ok: true,
      value: { pairings: [], paired: false, allowedSystemNames: [] },
    });
  });

  it('starts the agent when it pairs, with team secrets on, and stops it when the last pairing goes', async () => {
    const { machine, agent, call } = await setUp();
    const paired = await call('machineAgent.pair', { serverUrl: `${SERVER}/some/path`, code: ` ${GOOD_CODE} ` });
    expect(paired).toMatchObject({ ok: true, value: { origin: SERVER, email: 'ada@example.test' } });
    expect(agent.started).toHaveLength(1);
    // One flag for the hello and the sends: the handlers say they resolve team secrets.
    expect(agent.started[0]?.handlers?.resolvesTeamSecrets).toBe(true);
    expect(agent.started[0]?.handlers?.has('agent.send')).toBe(true);
    expect(machine.port).toBe(47616);
    const status = (await call('machineAgent.status', undefined)) as {
      value: { port: number; pairings: { pairingId: string; origin: string }[] };
    };
    expect(status.value.port).toBe(47616);
    expect(status.value.pairings).toMatchObject([{ origin: SERVER, email: 'ada@example.test', sshOptIn: false }]);

    const pairingId = status.value.pairings[0]!.pairingId;
    await expect(call('machineAgent.unpair', { pairingId })).resolves.toMatchObject({
      ok: true,
      value: { pairings: [], paired: true },
    });
    expect(agent.closed()).toBe(1);
    expect(machine.port).toBeUndefined();
  });

  it('answers a refused code with the server’s reason and keeps nothing', async () => {
    const { machine, agent, call } = await setUp();
    const refused = (await call('machineAgent.pair', { serverUrl: SERVER, code: 'WRONG1' })) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('agent-refused');
    expect(refused.error.message).toContain('refused the pairing code');
    expect(agent.started).toEqual([]);
    expect(machine.port).toBeUndefined();
  });

  it('keeps the allowlist with the pairings: refused before the first, round-tripped after', async () => {
    const { call } = await setUp();
    await expect(call('machineAgent.setAllowedSystemNames', { names: ['CI_REGION'] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent-not-paired' },
    });
    await call('machineAgent.pair', { serverUrl: SERVER, code: GOOD_CODE });
    await expect(
      call('machineAgent.setAllowedSystemNames', { names: ['CI_REGION', 'BUILD_ID', 'CI_REGION'] }),
    ).resolves.toMatchObject({ ok: true, value: { allowedSystemNames: ['CI_REGION', 'BUILD_ID'] } });
    await expect(call('machineAgent.status', undefined)).resolves.toMatchObject({
      value: { allowedSystemNames: ['CI_REGION', 'BUILD_ID'] },
    });
    await expect(call('machineAgent.setAllowedSystemNames', { names: ['not a name'] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
  });

  it('starts at launch when the profile already holds a pairing, and stops at quit', async () => {
    const platform = createFakePlatform();
    const host = await createHost(platform);
    hosts.push(host);
    const server = fakeServer();
    const firstRun = fakeStart();
    const first = await MachineAgent.open({ host, platform, fetch: server.fetch, start: firstRun.start });
    await first.pair({ serverUrl: SERVER, code: GOOD_CODE });
    await first.close();
    expect(firstRun.closed()).toBe(1);

    const secondRun = fakeStart();
    const second = await MachineAgent.open({ host, platform, fetch: server.fetch, start: secondRun.start });
    await second.sync();
    expect(secondRun.started).toHaveLength(1);
    await second.close();
    expect(secondRun.closed()).toBe(1);
  });

  it('stops listening when its server answers that the last pairing was unpaired in the tab', async () => {
    const platform = createFakePlatform();
    const host = await createHost(platform);
    hosts.push(host);
    const port = await freePort();
    const server = fakeServer();
    const machine = await MachineAgent.open({ host, platform, fetch: server.fetch, ports: [port] });
    await machine.pair({ serverUrl: SERVER, code: GOOD_CODE });
    expect(machine.port).toBe(port);
    await machine.close();

    // Unpaired in the tab while the app was closed: at the next start the port report gets the server's
    // `agent-pairing-unknown`, and the agent removes the pairing, which stops the listener.
    server.unknownPairings = true;
    const again = await MachineAgent.open({ host, platform, fetch: server.fetch, ports: [port] });
    await again.sync();
    await vi.waitFor(async () => {
      expect((await again.status()).pairings).toEqual([]);
      expect(again.port).toBeUndefined();
    });
    expect(await free(port)).toBe(true);
    await again.close();
  });

  it('keeps the pairing and listens on when the server only fails for now', async () => {
    const platform = createFakePlatform();
    const host = await createHost(platform);
    hosts.push(host);
    const port = await freePort();
    const server = fakeServer();
    const machine = await MachineAgent.open({ host, platform, fetch: server.fetch, ports: [port] });
    await machine.pair({ serverUrl: SERVER, code: GOOD_CODE });
    server.failSigned = true;
    await machine.close();
    const again = await MachineAgent.open({ host, platform, fetch: server.fetch, ports: [port] });
    await again.sync();
    await vi.waitFor(() => expect(server.calls.filter((one) => one.method === 'PATCH').length).toBeGreaterThan(1));
    expect((await again.status()).pairings).toHaveLength(1);
    expect(again.port).toBe(port);
    await again.close();
  });

  it('says plainly that a machine without secret storage cannot pair', async () => {
    const platform = createFakePlatform({
      secrets: { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' },
    });
    const host = await createHost(platform);
    hosts.push(host);
    const machine = await MachineAgent.open({ host, platform, fetch: fakeServer().fetch, start: fakeStart().start });
    await expect(machine.pair({ serverUrl: SERVER, code: GOOD_CODE })).rejects.toMatchObject({
      code: 'agent-no-secret-storage',
      message: 'This machine cannot keep the agent key secret, so it cannot pair',
    });
  });

  it('keeps the pairing when the agent cannot start, and shows it off', async () => {
    const platform = createFakePlatform();
    const host = await createHost(platform);
    hosts.push(host);
    const machine = await MachineAgent.open({
      host,
      platform,
      fetch: fakeServer().fetch,
      start: () => Promise.reject(new Error('No port from 47615 to 47634 is free on 127.0.0.1')),
    });
    await expect(machine.pair({ serverUrl: SERVER, code: GOOD_CODE })).resolves.toMatchObject({ origin: SERVER });
    const status = await machine.status();
    expect(status.port).toBeUndefined();
    expect(status.pairings).toHaveLength(1);
  });

  it('listens on a real port after pairing and releases it after the last unpairing', async () => {
    const platform = createFakePlatform();
    const host = await createHost(platform);
    hosts.push(host);
    const port = await freePort();
    const machine = await MachineAgent.open({ host, platform, fetch: fakeServer().fetch, ports: [port] });
    const { pairingId } = await machine.pair({ serverUrl: SERVER, code: GOOD_CODE });
    expect(machine.port).toBe(port);
    expect(await free(port)).toBe(false);
    await machine.unpair({ pairingId });
    expect(machine.port).toBeUndefined();
    expect(await free(port)).toBe(true);
    await machine.close();
  });
});
