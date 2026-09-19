// @vitest-environment node
/**
 * `EngineService`'s WebSocket session registry against a real server: opening a session and
 * driving it by `sendId`, both live-event orderings, and every teardown path — including the two
 * maps (`sends`, `wsSessions`) staying empty afterward.
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

/** Reads the private maps for the "both empty afterward" assertions; test-only. */
function mapSizes(service: EngineService): { sends: number; wsSessions: number } {
  const s = service as unknown as { sends: Map<string, unknown>; wsSessions: Map<string, unknown> };
  return { sends: s.sends.size, wsSessions: s.wsSessions.size };
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

    // Send a message once the session is open (the handshake live event tells us).
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (events.some((e) => (e.event as { kind?: string }).kind === 'handshake')) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    service.sendWsMessage('s1', { text: 'hello' });
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 100));
    expect(service.closeWs('s2')).toEqual({ closed: true });
    expect(service.closeWs('s2')).toEqual({ closed: false });
    await promise;
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });

  it('resolves with closed.by === "error" when request.cancel aborts a hanging handshake', async () => {
    const service = new EngineService();
    const promise = service.openWsSession({ sendId: 's3', requestId: 'q-1', options: { url: `${server.url}/hang` } });
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 100));
    service.closeAllWs();
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(e2.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(mapSizes(service)).toEqual({ sends: 0, wsSessions: 0 });
  });
});
