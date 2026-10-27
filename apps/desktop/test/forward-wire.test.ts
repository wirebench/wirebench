// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { channels, events } from '@wirebench/wire/ipc';
import { FORWARD_EVENTS_PER_SECOND } from '@wirebench/wire/ssh-defaults';

describe('forward wire', () => {
  it('each request schema refuses an unknown key', () => {
    const requests: [{ safeParse(value: unknown): { success: boolean } }, Record<string, unknown>][] = [
      [channels.forward.list.request, {}],
      [channels.forward.start.request, { hostId: 'a', ruleId: 'grafana' }],
      [channels.forward.stop.request, { hostId: 'a', ruleId: 'grafana' }],
      [channels.forward.stopAll.request, {}],
      [channels.forward.freePort.request, { near: 5432 }],
    ];
    for (const [schema, valid] of requests) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    }
  });

  it('a start port is 1 to 65535', () => {
    const start = channels.forward.start.request;
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', port: 1 }).success).toBe(true);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', port: 65535 }).success).toBe(true);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', port: 0 }).success).toBe(false);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', port: 65536 }).success).toBe(false);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', port: 80.5 }).success).toBe(false);
  });

  it('confirmBind accepts only true', () => {
    const start = channels.forward.start.request;
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', confirmBind: true }).success).toBe(true);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', confirmBind: false }).success).toBe(false);
    expect(start.safeParse({ hostId: 'a', ruleId: 'r', confirmBind: 'yes' }).success).toBe(false);
  });

  it('freePort near is a port', () => {
    expect(channels.forward.freePort.request.safeParse({ near: 0 }).success).toBe(false);
    expect(channels.forward.freePort.response.safeParse({ port: 5433 }).success).toBe(true);
  });

  it('the state event carries every status of the runner', () => {
    const base = { hostId: 'a', ruleId: 'r', origin: 'manual', port: 3000 };
    const statuses = [
      { state: 'starting' },
      { state: 'running', listening: { address: '127.0.0.1', port: 3000 }, connections: 2 },
      { state: 'running', listening: { address: '127.0.0.1', port: 3000 }, connections: 0, lastError: 'refused' },
      { state: 'reconnecting', attempt: 2, nextInMs: 2000 },
      { state: 'failed', error: { code: 'ssh-forward-port-in-use', message: 'taken', details: { port: 3000 } } },
      { state: 'stopped' },
    ];
    for (const status of statuses) {
      expect(events.forward.state.payload.safeParse({ ...base, status }).success).toBe(true);
    }
    expect(
      events.forward.state.payload.safeParse({ ...base, origin: 'auto', status: { state: 'stopped' }, changed: true })
        .success,
    ).toBe(true);
    expect(
      events.forward.state.payload.safeParse({ ...base, origin: 'other', status: { state: 'stopped' } }).success,
    ).toBe(false);
  });

  it('the list answer holds states', () => {
    expect(
      channels.forward.list.response.safeParse({
        forwards: [{ hostId: 'a', ruleId: 'r', origin: 'auto', port: 1, status: { state: 'starting' }, removed: true }],
      }).success,
    ).toBe(true);
  });

  it('caps connection-count events at four a second', () => {
    expect(FORWARD_EVENTS_PER_SECOND).toBe(4);
  });
});
