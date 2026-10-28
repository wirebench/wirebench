/**
 * `runHostSocket` (hosted edition spec §5.2, §17.3) over a fake `ws` and a fake host: a socket the server
 * ends stops at once, not when the peer answers the close (a `ws` keeps emitting `message` while
 * closing), a socket ended while its host is still being built never joins it, and the calls queued
 * before the host is ready are bounded in bytes as well as in number.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { HOST_CLOSE, HOST_LIMITS } from '../../../src/host/errors.js';
import type { HostCaller, HostCallFrame, ServerHost } from '../../../src/host/host-runtime.js';
import { runHostSocket, type HostSocketDeps } from '../../../src/host/socket.js';

/** The part of a `ws` socket `runHostSocket` uses; `close` only starts the handshake, as the real one does. */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    if (this.readyState === this.OPEN) this.readyState = this.CLOSING;
  }
  /** The peer's frame arriving. */
  frame(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
  /** The handshake finished (or `ws`'s close timeout ran out). */
  finish(): void {
    this.readyState = this.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

function fakeHost(): ServerHost & { attached: HostCaller[]; served: HostCallFrame[]; detached: number[] } {
  const host = {
    attached: [] as HostCaller[],
    served: [] as HostCallFrame[],
    detached: [] as number[],
    capabilities: ['send:public'],
    osTheme: 'light' as const,
    channels: () => [],
    attach: (caller: HostCaller) => {
      host.attached.push(caller);
    },
    serve: (_caller: HostCaller, frame: HostCallFrame) => {
      host.served.push(frame);
      return Promise.resolve({ id: frame.id, ok: true as const, value: null });
    },
    detach: (callerId: number) => {
      host.detached.push(callerId);
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };
  return host;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function run(ws: FakeWs, host: Promise<ServerHost | undefined>, closed: () => void = () => undefined) {
  const deps: HostSocketDeps = {
    host,
    callerId: 7,
    allowed: () => true,
    log: () => undefined,
    onClosed: closed,
  };
  return runHostSocket(ws as unknown as WebSocket, deps);
}

const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

describe('runHostSocket', () => {
  it('serves no frame that arrives while the socket is closing, even before its close event', async () => {
    const ws = new FakeWs();
    const host = fakeHost();
    run(ws, Promise.resolve(host));
    await flush();
    expect(ws.sent[0]).toMatchObject({ type: 'hello' });
    ws.close(HOST_CLOSE.unauthenticated, 'session ended');
    ws.frame({ id: 1, channel: 'secrets.set', request: {} });
    await flush();
    expect(host.served).toEqual([]);
  });

  it('ends at once: no call runs and no push goes out after end(), the scope is detached before the peer answers', async () => {
    const ws = new FakeWs();
    const host = fakeHost();
    let closed = 0;
    const socket = run(ws, Promise.resolve(host), () => {
      closed += 1;
    });
    await flush();
    const caller = host.attached[0]!;
    socket.end(HOST_CLOSE.unauthenticated, 'session ended');
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.unauthenticated, reason: 'session ended' }]);
    expect(caller.isClosed()).toBe(true);
    const before = ws.sent.length;
    caller.send('preferences.changed', {});
    ws.frame({ id: 2, channel: 'secrets.set', request: {} });
    await flush();
    expect(host.served).toEqual([]);
    expect(ws.sent).toHaveLength(before);
    expect(host.detached).toEqual([7]);
    expect(closed).toBe(1);
    // The handshake finishing later changes nothing.
    ws.finish();
    await flush();
    expect(host.detached).toEqual([7]);
    expect(closed).toBe(1);
  });

  it('a socket ended while its host is being built never joins it nor says hello', async () => {
    const ws = new FakeWs();
    const host = fakeHost();
    const building = deferred<ServerHost | undefined>();
    let closed = 0;
    const socket = run(ws, building.promise, () => {
      closed += 1;
    });
    ws.frame({ id: 3, channel: 'app.version' });
    socket.end(HOST_CLOSE.unauthenticated, 'session ended');
    building.resolve(host);
    await flush();
    expect(host.attached).toEqual([]);
    expect(host.served).toEqual([]);
    expect(ws.sent).toEqual([]);
    expect(closed).toBe(1);
  });

  it(`closes ${HOST_CLOSE.tooBig} once the calls waiting for the host pass ${HOST_LIMITS.maxQueuedBytes} bytes`, async () => {
    const ws = new FakeWs();
    const host = fakeHost();
    const building = deferred<ServerHost | undefined>();
    run(ws, building.promise);
    const request = 'x'.repeat(8 * 1024 * 1024);
    let id = 0;
    while (ws.closes.length === 0 && id < 64) ws.frame({ id: id++, channel: 'app.version', request });
    expect(ws.closes).toEqual([{ code: HOST_CLOSE.tooBig, reason: 'too much queued' }]);
    // The eighth frame of a little over 8 MiB is the one that passes 64 MiB.
    expect(id).toBe(HOST_LIMITS.maxQueuedBytes / (8 * 1024 * 1024));
    building.resolve(host);
    await flush();
    expect(host.served).toEqual([]);
    expect(host.attached).toEqual([]);
  });
});
