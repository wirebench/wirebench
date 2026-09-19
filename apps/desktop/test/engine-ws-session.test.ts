// @vitest-environment node
/**
 * `EngineService`'s WebSocket session registry against a real server: opening a session and
 * driving it by `sendId`, both live-event orderings, every teardown path — including the two maps
 * (`sends`, `wsSessions`) staying empty afterward — a reused `sendId`, and an `onLive` that throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import { WirebenchError, WsError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';

let server: TestWsServer;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

/** Reads the private maps for the "both empty afterward" and "registered" assertions; test-only. */
function maps(service: EngineService): {
  readonly sends: Map<string, unknown>;
  readonly wsSessions: Map<string, unknown>;
} {
  return service as unknown as { sends: Map<string, unknown>; wsSessions: Map<string, unknown> };
}

function mapSizes(service: EngineService): { sends: number; wsSessions: number } {
  const m = maps(service);
  return { sends: m.sends.size, wsSessions: m.wsSessions.size };
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until `sendId`'s handshake has registered the session in `wsSessions`. */
function waitForOpen(service: EngineService, sendId: string): Promise<void> {
  return waitFor(() => maps(service).wsSessions.has(sendId), `"${sendId}" to register as open`);
}

describe('EngineService.openWsSession', () => {
  it('echoes text and binary, both frames arriving live before the invoke resolves', async () => {
    const service = new EngineService();
    const events: Array<{ event: unknown; resolved: boolean }> = [];
    let resolved = false;
    const promise = service
      .openWsSession(
        { sendId: 's1', requestId: 'q-1', options: { url: `${server.url}/echo` } },
        { onLive: (event) => events.push({ event, resolved }) },
      )
      .then((summary) => {
        resolved = true;
        return summary;
      });

    await waitFor(
      () => events.some((e) => (e.event as { kind?: string }).kind === 'handshake'),
      'the handshake live event',
    );
    service.sendWsMessage('s1', { text: 'hello' });
    await waitFor(
      () =>
        events.some(
          (e) =>
            (e.event as { kind?: string; frame?: { direction?: string; opcode?: string } }).kind === 'frame' &&
            (e.event as { frame: { direction: string; opcode: string } }).frame.direction === 'received' &&
            (e.event as { frame: { direction: string; opcode: string } }).frame.opcode === 'text',
        ),
      'the text echo to arrive live',
    );
    service.closeWs('s1');
    const summary = await promise;

    expect(summary.handshake.status).toBe(101);
    expect(summary.frames.map((f) => [f.direction, f.opcode])).toEqual(
      expect.arrayContaining([
        ['sent', 'text'],
        ['received', 'text'],
      ]),
    );
    expect(summary.closed.by).toBe('client');

    const kinds = events.map((e) => (e.event as { kind: string }).kind);
    expect(kinds).toContain('handshake');
    expect(kinds).toContain('frame');
    expect(kinds).toContain('closed');
    // Every live event fired before the invoke resolved.
    for (const e of events) {
      expect(e.resolved).toBe(false);
    }
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('refuses a message to an unknown sendId with ws-session-unknown', () => {
    const service = new EngineService();
    expect(() => service.sendWsMessage('never-opened', { text: 'x' })).toThrow(WirebenchError);
    try {
      service.sendWsMessage('never-opened', { text: 'x' });
    } catch (error) {
      expect((error as WirebenchError).code).toBe('ws-session-unknown');
    }
  });

  it('answers closeWs twice with { closed: true } then { closed: false }', async () => {
    const service = new EngineService();
    const promise = service.openWsSession({ sendId: 's2', requestId: 'q-1', options: { url: `${server.url}/echo` } });
    await waitForOpen(service, 's2');
    expect(service.closeWs('s2')).toEqual({ closed: true });
    expect(service.closeWs('s2')).toEqual({ closed: false });
    await promise;
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('resolves with closed.by === "error" when request.cancel aborts a hanging handshake', async () => {
    const service = new EngineService();
    const promise = service.openWsSession({ sendId: 's3', requestId: 'q-1', options: { url: `${server.url}/hang` } });
    // `sends` is populated synchronously, before `openWsSession`'s first `await` — no wait needed.
    expect(maps(service).sends.has('s3')).toBe(true);
    expect(service.cancel('s3')).toEqual({ cancelled: true });
    const summary = await promise;
    expect(summary.closed.by).toBe('error');
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('resolves (not rejects) on a refused handshake, and never registers the session', async () => {
    const service = new EngineService();
    const summary = await service.openWsSession({
      sendId: 's4',
      requestId: 'q-1',
      options: { url: `${server.url}/refuse` },
    });
    expect(summary.closed.by).toBe('error');
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('rejects for a synchronous ws-bad-options throw, and still cleans up', async () => {
    const service = new EngineService();
    await expect(
      service.openWsSession({ sendId: 's5', requestId: 'q-1', options: { url: 'not a url' } }),
    ).rejects.toBeInstanceOf(WsError);
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('closeAllWs closes every open session', async () => {
    const service = new EngineService();
    const p1 = service.openWsSession({ sendId: 's6', requestId: 'q-1', options: { url: `${server.url}/echo` } });
    const p2 = service.openWsSession({ sendId: 's7', requestId: 'q-1', options: { url: `${server.url}/echo` } });
    await Promise.all([waitForOpen(service, 's6'), waitForOpen(service, 's7')]);
    service.closeAllWs();
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(e2.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('refuses a reused sendId with ws-session-exists, leaving the first session untouched', async () => {
    const service = new EngineService();
    const events: unknown[] = [];
    const first = service.openWsSession(
      { sendId: 's8', requestId: 'q-1', options: { url: `${server.url}/echo` } },
      { onLive: (event) => events.push(event) },
    );
    await waitForOpen(service, 's8');

    await expect(
      service.openWsSession({ sendId: 's8', requestId: 'q-1', options: { url: `${server.url}/echo` } }),
    ).rejects.toMatchObject({ code: 'ws-session-exists' });

    // The first session is unaffected: it still echoes and closes normally.
    const frame = service.sendWsMessage('s8', { text: 'still alive' });
    expect(frame.text).toBe('still alive');
    await waitFor(
      () =>
        events.some(
          (e) =>
            (e as { kind?: string; frame?: { direction?: string } }).kind === 'frame' &&
            (e as { frame: { direction: string } }).frame.direction === 'received',
        ),
      'the echo of the still-open session',
    );
    service.closeWs('s8');
    const summary = await first;
    expect(summary.closed.by).toBe('client');
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('never lets a throwing onLive affect the session: it still opens, echoes and closes', async () => {
    const service = new EngineService();
    let calls = 0;
    // Test-only observation of what the hook was *called with*, recorded before it throws — this
    // is not something the production code can rely on (that's the whole point of the guard); it's
    // only here to let the test wait for the echo before closing.
    const kinds: string[] = [];
    const promise = service.openWsSession(
      { sendId: 's9', requestId: 'q-1', options: { url: `${server.url}/echo` } },
      {
        onLive: (event) => {
          calls += 1;
          kinds.push(event.kind);
          throw new Error('boom: this live event could never be delivered');
        },
      },
    );
    await waitForOpen(service, 's9');
    const sent = service.sendWsMessage('s9', { text: 'hi' });
    expect(sent.text).toBe('hi');
    await waitFor(
      () => kinds.filter((k) => k === 'frame').length >= 2,
      'both the sent and the echoed frame to arrive (even though delivery then throws)',
    );
    service.closeWs('s9');
    const summary = await promise;
    expect(summary.handshake.status).toBe(101);
    expect(summary.closed.by).toBe('client');
    expect(summary.frames.map((f) => [f.direction, f.opcode])).toEqual(
      expect.arrayContaining([
        ['sent', 'text'],
        ['received', 'text'],
      ]),
    );
    // The handshake, at least one frame and the close all tried to call the throwing hook.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('handles an empty binary message', async () => {
    const service = new EngineService();
    const promise = service.openWsSession({ sendId: 's10', requestId: 'q-1', options: { url: `${server.url}/echo` } });
    await waitForOpen(service, 's10');
    const sent = service.sendWsMessage('s10', { base64: '' });
    expect(sent.opcode).toBe('binary');
    expect(sent.size).toBe(0);
    service.closeWs('s10');
    const summary = await promise;
    expect(summary.frames.some((f) => f.direction === 'sent' && f.opcode === 'binary' && f.size === 0)).toBe(true);
  });
});
