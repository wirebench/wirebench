import type { SocketLike } from '../../src/browser/socket-transport.js';

/** A WebSocket stand-in the tests drive by hand: open it, push frames, drop it. */
export class FakeSocket implements SocketLike {
  static readonly all: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.all.length = 0;
  }

  static last(): FakeSocket {
    const socket = FakeSocket.all.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  }

  static readonly create = (url: string): FakeSocket => new FakeSocket(url);

  readyState = 0;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: { id: number; channel: string; request?: unknown }[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id: number; channel: string; request?: unknown });
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  /** Opens the socket and sends the server's hello. */
  hello(capabilities: readonly string[] = ['send:public'], osTheme: 'dark' | 'light' = 'light'): void {
    this.readyState = 1;
    this.receive({ type: 'hello', host: 'browser', capabilities, osTheme });
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
