// @vitest-environment node
/**
 * The desktop app as this machine's agent (hosted edition spec §18.2, §18.5): no listener without a pairing,
 * one after *Pair this machine…*, none again after the last pairing goes; the `machineAgent.*` channels on the
 * desktop's own table, and no `agent.*` channel there at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningAgent, StartAgentOptions } from '@wirebench/agent';
import { generateId } from '@wirebench/engine';
import { createHost, type Host } from '../../../../packages/host/src/host/create-host.js';
import { createFakePlatform, fakeCaller } from '../../../../packages/host/test/helpers/fake-platform.js';
import { MachineAgent } from '../../src/main/machine-agent.js';

const SERVER = 'https://wirebench.example.test';
const GOOD_CODE = 'ABC234';

const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});

/** A server that pairs `GOOD_CODE`, refuses any other code with 404, and accepts an unpairing. */
function fakeServer() {
  const calls: { method: string; url: string }[] = [];
  const answer = (url: string, init: RequestInit): Response => {
    calls.push({ method: init.method ?? 'GET', url });
    if (init.method === 'POST' && url.endsWith('/api/v1/agent/pairings')) {
      const body = JSON.parse(init.body as string) as { code: string };
      if (body.code !== GOOD_CODE) return new Response('{}', { status: 404 });
      return Response.json({ pairingId: generateId(), origin: SERVER, email: 'ada@example.test' }, { status: 201 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  const fetch = (url: string, init: RequestInit): Promise<Response> => Promise.resolve(answer(url, init));
  return { fetch, calls };
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
  return { host, machine, agent, server, call };
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
    expect(agent.started[0]).toMatchObject({ teamSecrets: true });
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
});
