import type { SocketLike } from '../../src/browser/socket-transport.js';

/** A WebSocket stand-in the tests drive by hand: open it, push frames, drop it. */
export class FakeSocket implements SocketLike {
  static readonly all: FakeSocket[] = [];
  /** The agent sockets, kept apart so `last()` stays the server's. */
  static readonly agents: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.all.length = 0;
    FakeSocket.agents.length = 0;
  }

  static lastAgent(): FakeSocket {
    const socket = FakeSocket.agents.at(-1);
    if (socket === undefined) throw new Error('no agent socket was opened');
    return socket;
  }

  static readonly createAgent = (url: string): FakeSocket => new FakeSocket(url, FakeSocket.agents);

  static last(): FakeSocket {
    const socket = FakeSocket.all.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  }

  static readonly create = (url: string): FakeSocket => new FakeSocket(url);

  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: { id: number; channel: string; request?: unknown; [key: string]: unknown }[] = [];
  closedWith: number | undefined;

  constructor(
    readonly url: string,
    list: FakeSocket[] = FakeSocket.all,
  ) {
    list.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeSocket['sent'][number]);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  /** Opens the socket (the transport's `onopen` runs) without a hello yet. */
  open(): void {
    if (this.readyState === 1) return;
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Opens the socket and sends the server's hello. */
  hello(capabilities: readonly string[] = ['send:public'], osTheme: 'dark' | 'light' = 'light'): void {
    this.open();
    this.receive({ type: 'hello', host: 'browser', capabilities, osTheme });
  }

  /** Opens the socket and sends a paired agent's hello. */
  agentHello(capabilities: readonly string[] = ['send:public', 'send:private']): void {
    this.open();
    this.receive({ type: 'hello', host: 'agent', capabilities, sshOptIn: false });
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The socket closes from the far side (`1006`: it never opened, or the network went). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
