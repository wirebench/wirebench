import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_DISCONNECTED,
  createSocketTransport,
  hostSocketUrl,
  type SocketTransportOptions,
} from '../../src/browser/socket-transport.js';
import { FakeSocket } from './fake-socket.js';

const URL = 'wss://acme.example.test/api/v1/host';

function transport(options: Omit<SocketTransportOptions, 'createSocket'> = {}) {
  return createSocketTransport(URL, { ...options, createSocket: FakeSocket.create });
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hostSocketUrl', () => {
  it('uses wss: for an https page and ws: otherwise, on the same host', () => {
    expect(hostSocketUrl({ protocol: 'https:', host: 'acme.example.test' })).toBe(URL);
    expect(hostSocketUrl({ protocol: 'http:', host: 'localhost:8080' })).toBe('ws://localhost:8080/api/v1/host');
  });
});

describe('createSocketTransport', () => {
  it('opens the socket at once and resolves ready with the hello, dropping capabilities it does not know', async () => {
    const t = transport();
    expect(FakeSocket.last().url).toBe(URL);

    FakeSocket.last().hello(['send:public', 'teleport'], 'light');

    await expect(t.ready).resolves.toEqual({
      type: 'hello',
      host: 'browser',
      capabilities: ['send:public'],
      osTheme: 'light',
    });
  });

  it('sends { id, channel, request } and answers each call by its id, in any order', async () => {
    const t = transport();
    const socket = FakeSocket.last();
    socket.hello();

    const first = t.invoke('app.version', undefined);
    const second = t.invoke('history.list', { limit: 5 });
    expect(socket.sent).toEqual([
      { id: 1, channel: 'app.version' },
      { id: 2, channel: 'history.list', request: { limit: 5 } },
    ]);

    socket.receive({ id: 2, ok: false, error: { code: 'not-found', message: 'gone' } });
    socket.receive({ id: 1, ok: true, value: { version: '6.1.0' } });

    await expect(first).resolves.toEqual({ ok: true, value: { version: '6.1.0' } });
    await expect(second).resolves.toEqual({ ok: false, error: { code: 'not-found', message: 'gone' } });
  });

  it('passes host-busy through as the failed result it is', async () => {
    const t = transport();
    FakeSocket.last().hello();
    const call = t.invoke('app.version', undefined);
    FakeSocket.last().receive({ id: 1, ok: false, error: { code: 'host-busy', message: 'At most 64' } });
    await expect(call).resolves.toEqual({ ok: false, error: { code: 'host-busy', message: 'At most 64' } });
  });

  it('fans an event out to every listener of its name, and not after unsubscribing', () => {
    const t = transport();
    FakeSocket.last().hello();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    const offA = t.on('theme.changed', a);
    t.on('theme.changed', b);
    t.on('history.changed', other);

    FakeSocket.last().receive({ event: 'theme.changed', payload: { theme: 'dark' } });
    offA();
    FakeSocket.last().receive({ event: 'theme.changed', payload: { theme: 'light' } });

    expect(a.mock.calls).toEqual([[{ theme: 'dark' }]]);
    expect(b.mock.calls).toEqual([[{ theme: 'dark' }], [{ theme: 'light' }]]);
    expect(other).not.toHaveBeenCalled();
  });

  it('answers calls pending at a drop host-disconnected, and calls made while down at once', async () => {
    const t = transport();
    const socket = FakeSocket.last();
    socket.hello();
    const pending = t.invoke('app.version', undefined);

    socket.drop();

    await expect(pending).resolves.toEqual(HOST_DISCONNECTED);
    await expect(t.invoke('app.version', undefined)).resolves.toEqual(HOST_DISCONNECTED);
    expect(socket.sent).toHaveLength(1);
  });

  it('re-sends nothing on reconnect, and keeps event listeners', async () => {
    const t = transport();
    FakeSocket.last().hello();
    const listener = vi.fn();
    t.on('history.changed', listener);
    void t.invoke('app.version', undefined);

    FakeSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeSocket.last();
    expect(FakeSocket.all).toHaveLength(2);
    second.hello();
    expect(second.sent).toEqual([]);

    second.receive({ event: 'history.changed', payload: { count: 1 } });
    expect(listener).toHaveBeenCalledWith({ count: 1 });

    const call = t.invoke('app.version', undefined);
    second.receive({ id: second.sent[0]?.id, ok: true, value: 'back' });
    await expect(call).resolves.toEqual({ ok: true, value: 'back' });
  });

  it('waits 1 s, doubling to 30 s, between failed attempts, and starts again at 1 s after a hello', async () => {
    transport();
    FakeSocket.last().hello();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const count = FakeSocket.all.length;
      FakeSocket.last().drop();
      let waited = 0;
      while (FakeSocket.all.length === count) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    FakeSocket.last().hello();
    FakeSocket.last().drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(9);
  });

  it('tells onClosed the code and whether a hello came on that socket', async () => {
    const onClosed = vi.fn();
    transport({ onClosed });
    FakeSocket.last().drop(4429);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello();
    FakeSocket.last().drop(1001);

    expect(onClosed.mock.calls).toEqual([
      [4429, false],
      [1001, true],
    ]);
  });

  it('reports each hello to onHello, the first included', async () => {
    const onHello = vi.fn();
    transport({ onHello });
    FakeSocket.last().hello(['files']);
    FakeSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello(['ssh']);
    expect(onHello.mock.calls.map(([hello]) => (hello as { capabilities: string[] }).capabilities)).toEqual([
      ['files'],
      ['ssh'],
    ]);
  });

  it('stops for good on close(): the socket is closed, pending calls answered, no reconnect', async () => {
    const t = transport();
    const socket = FakeSocket.last();
    socket.hello();
    const pending = t.invoke('app.version', undefined);

    t.close();

    expect(socket.closedWith).toBe(1000);
    await expect(pending).resolves.toEqual(HOST_DISCONNECTED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a listener that calls close() from onClosed cancels the scheduled reconnect', async () => {
    const t = transport({
      onClosed: () => {
        t.close();
      },
    });
    FakeSocket.last().drop(4401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('ignores frames that are not JSON objects and replies to no pending call', async () => {
    const t = transport();
    const socket = FakeSocket.last();
    socket.hello();
    const call = t.invoke('app.version', undefined);
    socket.onmessage?.({ data: 'not json' });
    socket.onmessage?.({ data: new ArrayBuffer(2) });
    socket.receive([1, 2]);
    socket.receive({ id: 99, ok: true, value: 'stray' });
    socket.receive({ id: 1, ok: false });

    await expect(call).resolves.toEqual({
      ok: false,
      error: { code: 'internal-error', message: 'The server sent a reply the client cannot read' },
    });
  });

  it('does not count a hello-typed frame it cannot read as the hello', async () => {
    const onClosed = vi.fn();
    const onHello = vi.fn();
    transport({ onClosed, onHello });
    FakeSocket.last().receive({ type: 'hello', host: 'browser' });
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHello).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith(1006, false);
  });

  it('retries with the same backoff when opening a socket throws, and tells onOpenFailed', async () => {
    const onOpenFailed = vi.fn();
    let throws = 2;
    const t = createSocketTransport(URL, {
      onOpenFailed,
      createSocket: (url) => {
        if (throws > 0) {
          throws -= 1;
          throw new Error('blocked');
        }
        return FakeSocket.create(url);
      },
    });
    expect(onOpenFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(onOpenFailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onOpenFailed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.last().hello();
    await expect(t.ready).resolves.toMatchObject({ type: 'hello' });
  });
});
