/**
 * The server host's `HostOptions.server.connectLive` (hosted edition spec §17.3): a live socket with no
 * network under it. Its near end is what the host's `LiveClient` drives, shaped like the WHATWG socket
 * `connectWebSocket` returns; its far end is handed to the live module's own socket loop, so the token in
 * the first message, every subscribe and the hub's fan-out run exactly as for a socket from a desktop.
 *
 * Each side hears the other on a later microtask, as a real socket's events arrive on a later turn, so
 * a listener added just after a call still hears its answer, and a close the hub sends during an
 * announcement reaches the client only after every listener of that announcement has run.
 */
import { EventEmitter } from 'node:events';
import type { ConnectedWebSocket } from '@wirebench/engine';
import type { LiveConnection } from '../live/socket.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
/** What a dropped connection reports, as `ws` does for one closed without a close frame. */
const ABNORMAL = 1006;

function later(fn: () => void): void {
  void Promise.resolve().then(fn);
}

/** One in-memory connection: both ends share its state, so they can never disagree about it. */
class Pair {
  state = CONNECTING;
  readonly client = new ClientEnd(this);
  readonly server = new ServerEnd(this);
  private closing: Promise<void> | undefined;

  /** Either side closing: both see `CLOSING` now and `close` with `code` on a later turn. */
  close(code: number, reason: string): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.state = CLOSING;
    this.closing = new Promise<void>((resolve) => {
      later(() => {
        this.state = CLOSED;
        this.server.emit('close', code, Buffer.from(reason));
        this.client.dispatchClose(code, reason);
        resolve();
      });
    });
    return this.closing;
  }
}

/** The end the host's live client holds: the members of a WHATWG `WebSocket` it uses. */
class ClientEnd extends EventTarget {
  constructor(private readonly pair: Pair) {
    super();
  }

  get readyState(): number {
    return this.pair.state;
  }

  send(data: string): void {
    if (this.pair.state !== OPEN) throw new Error('the live bridge is not open');
    later(() => {
      if (this.pair.state === OPEN) this.pair.server.emit('message', Buffer.from(data), false);
    });
  }

  close(code = 1000, reason = ''): void {
    void this.pair.close(code, reason);
  }

  dispatchMessage(data: string): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }

  dispatchClose(code: number, reason: string): void {
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code !== ABNORMAL }));
  }
}

/** The end the live module's loop runs on: the members of a `ws` socket it uses. */
class ServerEnd extends EventEmitter implements LiveConnection {
  readonly OPEN = OPEN;

  constructor(private readonly pair: Pair) {
    super();
  }

  get readyState(): number {
    return this.pair.state;
  }

  send(text: string): void {
    if (this.pair.state !== OPEN) return;
    later(() => {
      if (this.pair.state === OPEN) this.pair.client.dispatchMessage(text);
    });
  }

  close(code = 1000, reason = ''): void {
    void this.pair.close(code, reason);
  }

  terminate(): void {
    void this.pair.close(ABNORMAL, '');
  }

  /** The far end answers every ping, as a browser's or undici's socket does. */
  ping(): void {
    later(() => {
      if (this.pair.state === OPEN) this.emit('pong');
    });
  }
}

/**
 * A connected live socket whose far end `serve` runs: the live module's socket loop. `serve` is called
 * before the near end opens, so it has its listeners in place before the client's first message.
 */
export function liveBridge(serve: (connection: LiveConnection) => void): ConnectedWebSocket {
  const pair = new Pair();
  later(() => {
    if (pair.state !== CONNECTING) return;
    pair.state = OPEN;
    serve(pair.server);
    pair.client.dispatchEvent(new Event('open'));
  });
  return {
    // The live client uses `readyState`, `send`, `close` and the three events, which this end has.
    socket: pair.client as unknown as ConnectedWebSocket['socket'],
    refusedStatus: () => undefined,
    dispose: () => (pair.state === CLOSED ? Promise.resolve() : pair.close(1000, '')),
  };
}
