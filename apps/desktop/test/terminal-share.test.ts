// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_SHARE_CLOSE, type ConnectedWebSocket } from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { SessionTap } from '../src/main/ssh-service.js';
import { framesOf, TerminalShareOwner } from '../src/main/terminal-share/owner.js';
import { TerminalShareViewer } from '../src/main/terminal-share/viewer.js';
import type { TerminalShareStateEvent, TerminalShareViewerStateEvent } from '../src/shared/terminal-share-wire.js';

const SHARE = 'abcdefghijklmnopqrstuvwxyz';
const WS = '01HZY3K8J9V7Q2W5N4M6P1R0WS';
const BOB = '01HZY3K8J9V7Q2W5N4M6P1R0BB';
const ME = '01HZY3K8J9V7Q2W5N4M6P1R0ME';
const ORIGIN = 'https://wb.example';

type Listener = (event: { data?: unknown; code?: number }) => void;

/** A WHATWG-like socket the test drives: `serverSends` delivers a message, `serverCloses` closes. */
class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  readonly sent: unknown[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: unknown): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : Buffer.from(data as Uint8Array).toString());
  }
  open(): void {
    this.readyState = 1;
    this.fire('open', {});
  }
  serverSends(message: unknown): void {
    this.fire('message', { data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  serverSendsBinary(text: string): void {
    const bytes = Buffer.from(text);
    this.fire('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  }
  serverCloses(code: number): void {
    this.readyState = 3;
    this.fire('close', { code });
  }
  private fire(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function sockets() {
  const made: FakeSocket[] = [];
  const connect = (url: string): ConnectedWebSocket => {
    const socket = new FakeSocket(url);
    made.push(socket);
    queueMicrotask(() => socket.open());
    return {
      socket: socket as unknown as WebSocket,
      refusedStatus: () => undefined,
      dispose: () => {
        if (socket.readyState === 1) socket.serverCloses(1000);
        return Promise.resolve();
      },
    } as unknown as ConnectedWebSocket;
  };
  return { made, connect };
}

const sender = { id: 1, isDestroyed: () => false } as unknown as WebContents;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function owner() {
  const { made, connect } = sockets();
  const states: TerminalShareStateEvent[] = [];
  let tap: SessionTap | undefined;
  const written: string[] = [];
  const untap = vi.fn();
  const service = new TerminalShareOwner({
    client: {
      createTerminalShare: vi.fn().mockResolvedValue({ shareId: SHARE }),
      meta: vi.fn().mockResolvedValue({ capabilities: ['terminal-sharing'] }),
    },
    accounts: { tokenFor: () => Promise.resolve('wbt_token'), markSignedOut: vi.fn() },
    connect,
    target: () => ({ url: ORIGIN, workspaceId: WS }),
    ssh: {
      tap: (_sender, _sessionId, t) => {
        tap = t;
        return untap;
      },
      write: (_sender, request) => {
        written.push(Buffer.from(request.data, 'base64').toString());
      },
    },
    emit: (_sender, state) => states.push(state),
  });
  const start = async () => {
    const started = service.start(sender, { sessionId: 's1', hostName: 'web', cols: 80, rows: 24 });
    await flush();
    made.at(-1)!.serverSends({ type: 'ready', role: 'owner' });
    return started;
  };
  return { service, made, states, written, untap, start, tap: () => tap! };
}

describe('framesOf', () => {
  it('cuts output into frames the message cap takes', () => {
    expect(framesOf(new Uint8Array(9000)).map((f) => f.length)).toEqual([4096, 4096, 808]);
    expect(framesOf(new Uint8Array(0))).toEqual([]);
  });
});

describe('TerminalShareOwner (#429)', () => {
  it('is available only on a server that relays shared terminals', async () => {
    const o = owner();
    expect(await o.service.available(sender)).toBe(true);
  });

  it('creates the share, authenticates and relays the masked output it is tapped', async () => {
    const o = owner();
    const answer = await o.start();
    expect(answer).toEqual({
      shareId: SHARE,
      invite: `wirebench://terminal-share/${SHARE}?server=https%3A%2F%2Fwb.example&workspace=${WS}`,
    });
    const socket = o.made[0]!;
    expect(socket.url).toBe('wss://wb.example/api/v1/terminal-shares/socket');
    expect(socket.sent[0]).toEqual({ type: 'auth', token: 'wbt_token', workspaceId: WS, shareId: SHARE });
    o.tap().data(Buffer.from('$ ls\r\n'));
    o.tap().resize(100, 30);
    expect(socket.sent.slice(1)).toEqual(['$ ls\r\n', { type: 'resize', cols: 100, rows: 30 }]);
  });

  it('reports presence and control, and writes the holder input to the session', async () => {
    const o = owner();
    await o.start();
    const socket = o.made[0]!;
    socket.serverSends({
      type: 'presence',
      owner: { userId: ME, name: 'Me' },
      viewers: [{ userId: BOB, name: 'Bob', control: false, requesting: true }],
    });
    expect(o.states.at(-1)).toMatchObject({ viewers: [{ userId: BOB, requesting: true }], control: null });
    o.service.grant(sender, 's1', BOB);
    expect(socket.sent.at(-1)).toEqual({ type: 'grant', userId: BOB });
    socket.serverSends({ type: 'control', userId: BOB });
    expect(o.states.at(-1)!.control).toBe(BOB);
    socket.serverSends({ type: 'input', userId: BOB, data: Buffer.from('uptime\r').toString('base64') });
    expect(o.written).toEqual(['uptime\r']);
    o.service.takeBack(sender, 's1');
    o.service.decline(sender, 's1', BOB);
    o.service.remove(sender, 's1', BOB);
    expect(socket.sent.slice(-3)).toEqual([
      { type: 'take-back' },
      { type: 'decline', userId: BOB },
      { type: 'remove', userId: BOB },
    ]);
  });

  it('stops: sends end, untaps and reports the end; a closed session does the same', async () => {
    const o = owner();
    await o.start();
    o.service.stop(sender, 's1');
    expect(o.made[0]!.sent).toContainEqual({ type: 'end' });
    expect(o.untap).toHaveBeenCalled();
    expect(o.states.at(-1)!.ended).toBe('ended');

    const p = owner();
    await p.start();
    p.tap().end();
    expect(p.states.at(-1)!.ended).toBe('ended');
    // A second share of the same session may start once the first ended.
    await expect(p.start()).resolves.toMatchObject({ shareId: SHARE });
  });

  it('refuses a second share of a session, and a socket refused before ready', async () => {
    const o = owner();
    await o.start();
    await expect(
      o.service.start(sender, { sessionId: 's1', hostName: 'web', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      code: 'terminal-share-active',
    });
    const p = owner();
    const started = p.service.start(sender, { sessionId: 's2', hostName: 'web', cols: 80, rows: 24 });
    await flush();
    p.made[0]!.serverCloses(TERMINAL_SHARE_CLOSE.forbidden);
    await expect(started).rejects.toMatchObject({ code: 'terminal-share-forbidden' });
  });
});

function viewer() {
  const { made, connect } = sockets();
  const states: TerminalShareViewerStateEvent[] = [];
  const data: string[] = [];
  const service = new TerminalShareViewer({
    client: { terminalShareInfo: vi.fn().mockResolvedValue({ hostName: 'web', ownerName: 'Alice', viewers: 2 }) },
    accounts: {
      tokenFor: () => Promise.resolve('wbt_token'),
      markSignedOut: vi.fn(),
      list: () => [{ url: ORIGIN, userId: ME }],
    },
    connect,
    emit: {
      data: (_sender, event) => data.push(Buffer.from(event.data, 'base64').toString()),
      state: (_sender, event) => states.push(event),
    },
  });
  const link = `wirebench://terminal-share/${SHARE}?server=https%3A%2F%2Fwb.example&workspace=${WS}`;
  const join = async () => {
    const joined = service.join(sender, { link, viewId: 'v1' });
    await flush();
    const socket = made[0]!;
    socket.serverSends({ type: 'viewer-ready', hostName: 'web', ownerName: 'Alice', cols: 100, rows: 30 });
    socket.serverSendsBinary('$ ls\r\n');
    return joined;
  };
  return { service, made, states, data, link, join };
}

describe('TerminalShareViewer (#429)', () => {
  it('previews a link, and refuses one that is not a share link', async () => {
    const v = viewer();
    expect(await v.service.preview(v.link)).toEqual({
      server: ORIGIN,
      hostName: 'web',
      ownerName: 'Alice',
      viewers: 2,
    });
    await expect(v.service.preview('https://example.com')).rejects.toMatchObject({
      code: 'terminal-share-link-invalid',
    });
  });

  it('joins, shows the replay, and types only while holding control', async () => {
    const v = viewer();
    expect(await v.join()).toEqual({ viewId: 'v1', hostName: 'web', ownerName: 'Alice', cols: 100, rows: 30 });
    const socket = v.made[0]!;
    expect(socket.sent[0]).toEqual({ type: 'auth', token: 'wbt_token', workspaceId: WS, shareId: SHARE });
    expect(v.data).toEqual(['$ ls\r\n']);
    v.service.input(sender, 'v1', 'eA==');
    expect(socket.sent).toHaveLength(1);
    v.service.requestControl(sender, 'v1');
    expect(socket.sent.at(-1)).toEqual({ type: 'request-control' });
    socket.serverSends({
      type: 'presence',
      owner: { userId: BOB, name: 'Alice' },
      viewers: [{ userId: ME, name: 'Me', control: false, requesting: true }],
    });
    expect(v.states.at(-1)).toMatchObject({ requesting: true, self: ME, control: null });
    socket.serverSends({ type: 'control', userId: ME });
    expect(v.states.at(-1)).toMatchObject({ control: ME, requesting: false });
    v.service.input(sender, 'v1', 'eA==');
    expect(socket.sent.at(-1)).toEqual({ type: 'input', data: 'eA==' });
    v.service.release(sender, 'v1');
    expect(socket.sent.at(-1)).toEqual({ type: 'release' });
  });

  it('reports a decline, a resize and the end with its reason', async () => {
    const v = viewer();
    await v.join();
    const socket = v.made[0]!;
    socket.serverSends({ type: 'declined' });
    expect(v.states.at(-1)!.declined).toBe(true);
    socket.serverSends({ type: 'resize', cols: 120, rows: 40 });
    expect(v.states.at(-1)).toMatchObject({ cols: 120, rows: 40 });
    socket.serverSends({ type: 'ended', reason: 'removed' });
    socket.serverCloses(TERMINAL_SHARE_CLOSE.forbidden);
    expect(v.states.at(-1)!.ended).toBe('removed');
  });

  it('a share that ended before joining is a not-found refusal', async () => {
    const v = viewer();
    const joined = v.service.join(sender, { link: v.link, viewId: 'v2' });
    await flush();
    v.made[0]!.serverCloses(TERMINAL_SHARE_CLOSE.notFound);
    await expect(joined).rejects.toMatchObject({ code: 'terminal-share-not-found' });
  });
});
