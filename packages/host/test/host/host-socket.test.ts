/**
 * The shared host socket loop (hosted edition spec §5.2, §17.3, §18.3) over a fake socket: the frames,
 * the hello, the calls queued before the host is ready, the in-flight cap, bad frames and a refusing
 * `beforeReady`.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  HOST_CLOSE,
  HOST_LIMITS,
  runHostSocket,
  type CallFrame,
  type Caller,
  type HostSocketOptions,
  type HostSocketReady,
  type WebSocketLike,
} from '../../src/index.js';
import type { ReplyFrame } from '../../src/host/serve-call.js';

class FakeWs extends EventEmitter implements WebSocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    if (this.readyState === this.OPEN) this.readyState = 2;
  }
  text(value: string): void {
    this.emit('message', Buffer.from(value), false);
  }
  frame(value: unknown): void {
    this.text(JSON.stringify(value));
  }
}

const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeReady(
  reply: (frame: CallFrame) => Promise<ReplyFrame> = (frame) =>
    Promise.resolve({ id: frame.id, ok: true, value: null }),
) {
  const ready = {
    attached: 0,
    served: [] as CallFrame[],
    callers: [] as Caller[],
    detached: 0,
    hello: { type: 'hello', host: 'agent' },
    attach: () => {
      ready.attached += 1;
    },
    serve: (caller: Caller, frame: CallFrame) => {
      ready.callers.push(caller);
      ready.served.push(frame);
      return reply(frame);
    },
    detach: () => {
      ready.detached += 1;
      return Promise.resolve();
    },
  };
  return ready satisfies HostSocketReady;
}

function run(ws: FakeWs, ready: Promise<HostSocketReady | undefined>, extra: Partial<HostSocketOptions> = {}) {
  const events = { closed: 0, logs: [] as string[] };
  const socket = runHostSocket(ws, {
    ready,
    callerId: 3,
    limits: HOST_LIMITS,
    log: (message) => events.logs.push(message),
    onClosed: () => {
      events.closed += 1;
    },
    ...extra,
  });
  return { socket, events };
}

describe('runHostSocket (shared)', () => {
  it('says hello once the host is ready, then answers a call by id', async () => {
    const ws = new FakeWs();
    const ready = fakeReady();
    run(ws, Promise.resolve(ready));
    await flush();
    expect(ws.sent).toEqual([{ type: 'hello', host: 'agent' }]);
    expect(ready.attached).toBe(1);
    ws.frame({ id: 5, channel: 'app.version' });
    await flush();
    expect(ready.served).toEqual([{ id: 5, channel: 'app.version', request: undefined }]);
    expect(ws.sent[1]).toEqual({ id: 5, ok: true, value: null });
  });

  it('pushes an event frame through the caller it hands the host', async () => {
    const ws = new FakeWs();
    const ready = fakeReady();
    run(ws, Promise.resolve(ready));
    await flush();
    ws.frame({ id: 1, channel: 'a.b' });
    await flush();
    ready.callers[0]?.send('preferences.changed', { x: 1 });
    expect(ws.sent.at(-1)).toEqual({ event: 'preferences.changed', payload: { x: 1 } });
  });

  it('queues calls that come before the host is ready and serves them in order after the hello', async () => {
    const ws = new FakeWs();
    const ready = fakeReady();
    const building = deferred<HostSocketReady | undefined>();
    run(ws, building.promise);
    ws.frame({ id: 1, channel: 'a.one' });
    ws.frame({ id: 2, channel: 'a.two' });
    await flush();
    expect(ready.served).toEqual([]);
    building.resolve(ready);
    await flush();
    expect(ws.sent[0]).toEqual({ type: 'hello', host: 'agent' });
    expect(ready.served.map((frame) => frame.id)).toEqual([1, 2]);
  });

  it(`closes ${HOST_CLOSE.tooBig} once the queued calls pass maxQueuedBytes`, async () => {
    const ws = new FakeWs();
    const ready = fakeReady();
    const building = deferred<HostSocketReady | undefined>();
    run(ws, building.promise, { limits: { maxInFlight: 64, maxQueuedBytes: 1000 } });
    const request = 'x'.repeat(400);
    ws.frame({ id: 1, channel: 'a.b', request });
    ws.frame({ id: 2, channel: 'a.b', request });
    ws.frame({ id: 3, channel: 'a.b', request });
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.tooBig, reason: 'too much queued' }]);
    building.resolve(ready);
    await flush();
    expect(ready.served).toEqual([]);
    expect(ready.attached).toBe(0);
  });

  it('answers host-busy past maxInFlight and stays open', async () => {
    const ws = new FakeWs();
    const gate = deferred<ReplyFrame>();
    const ready = fakeReady(() => gate.promise);
    run(ws, Promise.resolve(ready), { limits: { maxInFlight: 2, maxQueuedBytes: 1000 } });
    await flush();
    ws.frame({ id: 1, channel: 'a.b' });
    ws.frame({ id: 2, channel: 'a.b' });
    ws.frame({ id: 3, channel: 'a.b' });
    await flush();
    expect(ws.sent.at(-1)).toMatchObject({ id: 3, ok: false, error: { code: 'host-busy' } });
    expect(ws.closes).toEqual([]);
    expect(ready.served.map((frame) => frame.id)).toEqual([1, 2]);
    gate.resolve({ id: 0, ok: true, value: null });
    await flush();
    ws.frame({ id: 4, channel: 'a.b' });
    await flush();
    expect(ready.served.map((frame) => frame.id)).toEqual([1, 2, 4]);
  });

  it('answers host-busy to a queued call past the in-flight count', () => {
    const ws = new FakeWs();
    const building = deferred<HostSocketReady | undefined>();
    run(ws, building.promise, { limits: { maxInFlight: 1, maxQueuedBytes: 1000 } });
    ws.frame({ id: 1, channel: 'a.b' });
    ws.frame({ id: 2, channel: 'a.b' });
    expect(ws.sent).toMatchObject([{ id: 2, ok: false, error: { code: 'host-busy' } }]);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[]'],
    ['a missing channel', JSON.stringify({ id: 1 })],
    ['a negative id', JSON.stringify({ id: -1, channel: 'a.b' })],
    ['an extra field', JSON.stringify({ id: 1, channel: 'a.b', extra: 1 })],
  ])('closes %s with %i', async (_name, text) => {
    const ws = new FakeWs();
    const ready = fakeReady();
    const { events } = run(ws, Promise.resolve(ready));
    await flush();
    ws.text(text);
    await flush();
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.badFrame, reason: 'bad frame' }]);
    expect(ready.served).toEqual([]);
    expect(ready.detached).toBe(1);
    expect(events.closed).toBe(1);
  });

  it('closes a binary frame 4400', async () => {
    const ws = new FakeWs();
    run(ws, Promise.resolve(fakeReady()));
    await flush();
    ws.emit('message', Buffer.from('{"id":1,"channel":"a.b"}'), true);
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.badFrame, reason: 'bad frame' }]);
  });

  it('closes 1001 when no host was built and 1011 when building failed', async () => {
    const none = new FakeWs();
    run(none, Promise.resolve(undefined));
    await flush();
    expect(none.closes).toEqual([{ code: HOST_CLOSE.goingAway, reason: 'no host' }]);
    const failed = new FakeWs();
    const { events } = run(failed, Promise.reject(new Error('boom')));
    await flush();
    expect(failed.closes).toEqual([{ code: HOST_CLOSE.serverError, reason: 'server error' }]);
    expect(events.logs).toEqual(['a host could not be started']);
  });

  describe('beforeReady', () => {
    it('takes the first frame, whatever its shape, before the hello; then calls flow', async () => {
      const ws = new FakeWs();
      const ready = fakeReady();
      const seen: unknown[] = [];
      run(ws, Promise.resolve(ready), {
        beforeReady: (frame) => {
          seen.push(frame);
          return Promise.resolve(true);
        },
      });
      await flush();
      expect(ws.sent).toEqual([]);
      expect(ready.attached).toBe(0);
      ws.frame({ type: 'auth', token: 't' });
      await flush();
      expect(seen).toEqual([{ type: 'auth', token: 't' }]);
      expect(ws.sent).toEqual([{ type: 'hello', host: 'agent' }]);
      ws.frame({ id: 1, channel: 'a.b' });
      await flush();
      expect(ready.served).toHaveLength(1);
    });

    it('waits for the host too when it passes first', async () => {
      const ws = new FakeWs();
      const ready = fakeReady();
      const building = deferred<HostSocketReady | undefined>();
      run(ws, building.promise, { beforeReady: () => Promise.resolve(true) });
      ws.frame({ type: 'auth' });
      await flush();
      expect(ws.sent).toEqual([]);
      building.resolve(ready);
      await flush();
      expect(ws.sent).toEqual([{ type: 'hello', host: 'agent' }]);
    });

    it('closes 4401 when it refuses, and nothing is attached, said or served', async () => {
      const ws = new FakeWs();
      const ready = fakeReady();
      const { events } = run(ws, Promise.resolve(ready), { beforeReady: () => Promise.resolve(false) });
      await flush();
      ws.frame({ type: 'auth', token: 'wrong' });
      await flush();
      ws.frame({ id: 1, channel: 'a.b' });
      await flush();
      expect(ws.closes).toEqual([{ code: HOST_CLOSE.unauthenticated, reason: 'unauthenticated' }]);
      expect(ws.sent).toEqual([]);
      expect(ready.served).toEqual([]);
      expect(ready.attached).toBe(0);
      expect(events.closed).toBe(1);
    });

    it('closes 4401 when it throws, logging without the frame', async () => {
      const ws = new FakeWs();
      const { events } = run(ws, Promise.resolve(fakeReady()), {
        beforeReady: () => Promise.reject(new Error('down')),
      });
      ws.frame({ type: 'auth', token: 'secret-token' });
      await flush();
      expect(ws.closes).toEqual([{ code: HOST_CLOSE.unauthenticated, reason: 'unauthenticated' }]);
      expect(JSON.stringify(events.logs)).not.toContain('secret-token');
    });

    it('closes 4400 for a first frame that is not JSON or binary, or a second while it is pending', () => {
      const text = new FakeWs();
      run(text, Promise.resolve(fakeReady()), { beforeReady: () => Promise.resolve(true) });
      text.text('nope');
      expect(text.closes).toEqual([{ code: HOST_CLOSE.badFrame, reason: 'bad frame' }]);
      const pending = new FakeWs();
      const hold = deferred<boolean>();
      run(pending, Promise.resolve(fakeReady()), { beforeReady: () => hold.promise });
      pending.frame({ type: 'auth' });
      pending.frame({ id: 1, channel: 'a.b' });
      expect(pending.closes).toEqual([{ code: HOST_CLOSE.badFrame, reason: 'bad frame' }]);
    });
  });

  it('end() stops serving at once, detaches once and runs onClosed once', async () => {
    const ws = new FakeWs();
    const ready = fakeReady();
    const { socket, events } = run(ws, Promise.resolve(ready));
    await flush();
    socket.end(HOST_CLOSE.unauthenticated, 'session ended');
    socket.end(HOST_CLOSE.unauthenticated, 'again');
    ws.frame({ id: 1, channel: 'a.b' });
    ws.emit('close');
    await flush();
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.unauthenticated, reason: 'session ended' }]);
    expect(ready.served).toEqual([]);
    expect(ready.detached).toBe(1);
    expect(events.closed).toBe(1);
  });
});
