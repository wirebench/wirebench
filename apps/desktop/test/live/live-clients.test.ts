// @vitest-environment node
/**
 * `LiveClients` (live-updates spec §3.4, §5.3, §11): one client per server origin, bound to that
 * account's token, token check and meta; closed on sign-out or removal, reconnected on a new
 * token, reopened after a session ended once the account signs in again, and closed on the last
 * unsubscribe and at quit. The sockets are fakes opened, answered and closed by hand.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedWebSocket, MetaResponse, ServerAccount } from '@wirebench/engine';
import type { LiveEvent } from '../../src/main/live/live-client.js';
import { LiveClients } from '../../src/main/live/live-clients.js';
import { Inbox, manualTimers } from './live-test-helpers.js';

const A = 'https://a.test';
const B = 'https://b.test';
const WS_1 = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_2 = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const REF_A1 = `sec_${'a'.repeat(26)}`;
const REF_A2 = `sec_${'b'.repeat(26)}`;
const REF_B = `sec_${'c'.repeat(26)}`;
const TOKEN_A1 = `wbs_${'A'.repeat(43)}`;
const TOKEN_A2 = `wbs_${'B'.repeat(43)}`;
const TOKEN_B = `wbs_${'C'.repeat(43)}`;
const USER = '01J8ZC5Q0V7R3T9XK2M4N6P8S1';
const ANA = '01J8ZC5Q0V7R3T9XK2M4N6P8S2';
const noop = (): void => undefined;

function account(url: string, tokenRef: string, extra: Partial<ServerAccount> = {}): ServerAccount {
  return {
    url,
    userId: USER,
    email: 'ada@example.com',
    displayName: 'Ada',
    deviceName: 'laptop',
    tokenRef,
    addedAt: '2026-09-26T09:00:00.000Z',
    ...extra,
  };
}

/** A socket the test opens, answers and closes by hand; it records what the client sent. */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    super();
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  /** The client's close: recorded, and answered at once as a server would. */
  close(code?: number): void {
    this.closedWith = code;
    this.end(code ?? 1005);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(message: object): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(message) }));
  }

  /** The server's close. */
  end(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

function harness(initial: readonly ServerAccount[]) {
  let current = initial;
  const listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  /** The token behind each ref, as the secret store holds it. */
  const secrets = new Map([
    [REF_A1, TOKEN_A1],
    [REF_A2, TOKEN_A2],
    [REF_B, TOKEN_B],
  ]);
  const accounts = {
    tokenFor: vi.fn((url: string): Promise<string | undefined> => {
      const found = current.find((server) => server.url === url);
      return Promise.resolve(found === undefined || found.signedOut === true ? undefined : secrets.get(found.tokenRef));
    }),
    refresh: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
    list: (): readonly ServerAccount[] => current,
    onChange: (listener: (servers: readonly ServerAccount[]) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  /** What `AccountService.persist` does: replace the list in memory, then tell every listener. */
  const setAccounts = (next: readonly ServerAccount[]): void => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const meta = vi.fn((url: string) =>
    Promise.resolve<MetaResponse>({
      name: 'wirebench-server',
      version: '1.0.0',
      apiVersion: 1,
      publicUrl: url,
      auth: { local: true, oidc: false },
      capabilities: ['sync', 'live'],
    }),
  );
  const sockets = new Inbox<FakeSocket>();
  const timers = manualTimers();
  const live = new LiveClients({
    accounts,
    client: { meta },
    connect: (wsUrl) => {
      const socket = new FakeSocket(wsUrl);
      sockets.push(socket);
      return {
        socket: socket as unknown as ConnectedWebSocket['socket'],
        dispose: () => Promise.resolve(),
        refusedStatus: () => undefined,
      };
    },
    setTimer: timers.setTimer,
    random: () => 1,
  });
  return { accounts, setAccounts, listeners, meta, sockets, timers, live };
}

/** Opens the socket, checks the token in `auth`, and answers `ready`. */
function admit(socket: FakeSocket, token: string): void {
  socket.open();
  expect(socket.sent[0]).toEqual({ type: 'auth', token });
  socket.receive({ type: 'ready' });
}

const toA = (socket: FakeSocket): boolean => socket.url === 'wss://a.test/api/v1/live';
const toB = (socket: FakeSocket): boolean => socket.url === 'wss://b.test/api/v1/live';
const isEnded = (event: LiveEvent): boolean => event.kind === 'state' && event.state === 'ended';

describe('LiveClients (live-updates §3.4)', () => {
  it('keeps one client per server origin, bound to that account', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    h.live.subscribe('https://A.test/', WS_2, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    expect(h.sockets.all).toHaveLength(2);
    expect(a.sent).toEqual([
      { type: 'auth', token: TOKEN_A1 },
      { type: 'subscribe', workspaceId: WS_1 },
      { type: 'subscribe', workspaceId: WS_2 },
    ]);
    expect(b.sent).toEqual([
      { type: 'auth', token: TOKEN_B },
      { type: 'subscribe', workspaceId: WS_1 },
    ]);
    expect(h.meta.mock.calls.map(([url]) => url).sort()).toEqual([A, B]);
    expect(h.accounts.tokenFor.mock.calls.map(([url]) => url).sort()).toEqual([A, B]);
    a.receive({
      type: 'presence',
      workspaceId: WS_1,
      users: [
        { id: ANA, name: 'Ana' },
        { id: USER, name: 'Ada' },
      ],
    });
    expect(await events.take((event) => event.kind === 'message')).toEqual({
      kind: 'message',
      message: { type: 'presence', workspaceId: WS_1, users: [{ id: ANA, name: 'Ana' }] },
    });
  });

  it('closes the client on sign-out and reconnects with the new token on the next sign-in', async () => {
    const h = harness([account(A, REF_A1)]);
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    h.setAccounts([account(A, REF_A1, { signedOut: true })]);
    expect(first.closedWith).toBe(1000);
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'off' });
    h.setAccounts([account(A, REF_A2)]);
    const second = await h.sockets.take();
    admit(second, TOKEN_A2);
    expect(second.sent.at(-1)).toEqual({ type: 'subscribe', workspaceId: WS_1 });
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'connected' });
  });

  it('reconnects on a new token, and ignores a change that keeps it', async () => {
    const h = harness([account(A, REF_A1)]);
    h.live.subscribe(A, WS_1, noop);
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    h.setAccounts([account(A, REF_A1, { displayName: 'Ada Lovelace' })]);
    expect(first.closedWith).toBeUndefined();
    h.setAccounts([account(A, REF_A2)]);
    expect(first.closedWith).toBe(1000);
    admit(await h.sockets.take(), TOKEN_A2);
    expect(h.sockets.all).toHaveLength(2);
  });

  it('closes only the client of a removed account', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    h.live.subscribe(A, WS_1, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    h.setAccounts([account(B, REF_B)]);
    expect(a.closedWith).toBe(1000);
    expect(b.closedWith).toBeUndefined();
    expect(h.timers.live()).toEqual([30_000]); // B's heartbeat only: nothing retries A
  });

  it('after 4401 runs the token check, reports ended, and reopens only on a fresh sign-in', async () => {
    const h = harness([account(A, REF_A1)]);
    // As AccountService.refresh does when the server confirms identity-unauthenticated.
    h.accounts.refresh.mockImplementation((url) => {
      h.setAccounts([account(url, REF_A1, { signedOut: true })]);
      return Promise.resolve();
    });
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    first.receive({ type: 'session-ended' });
    first.end(4401);
    await events.take(isEnded);
    expect(h.accounts.refresh).toHaveBeenCalledWith(A);
    expect(events.all.map((event) => (event.kind === 'state' ? event.state : event.message.type))).toEqual([
      'connecting',
      'connected',
      'off',
      'ended',
    ]);
    expect(h.sockets.all).toHaveLength(1);
    expect(h.timers.live()).toEqual([]);
    h.setAccounts([account(A, REF_A2)]);
    admit(await h.sockets.take(), TOKEN_A2);
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'connected' });
  });

  it('closes the client on the last unsubscribe, and the next subscribe opens a fresh one', async () => {
    const h = harness([account(A, REF_A1)]);
    const off1 = h.live.subscribe(A, WS_1, noop);
    const off2 = h.live.subscribe(A, WS_2, noop);
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    off1();
    expect(first.sent.at(-1)).toEqual({ type: 'unsubscribe', workspaceId: WS_1 });
    expect(first.closedWith).toBeUndefined();
    off2();
    off2();
    expect(first.closedWith).toBe(1000);
    expect(h.timers.live()).toEqual([]);
    h.live.subscribe(A, WS_1, noop);
    admit(await h.sockets.take(), TOKEN_A1);
    expect(h.meta).toHaveBeenCalledTimes(2);
  });

  it('closeAll closes every socket and stops following the accounts', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    h.live.subscribe(A, WS_1, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    await h.live.closeAll();
    expect([a.closedWith, b.closedWith]).toEqual([1000, 1000]);
    expect(h.listeners.size).toBe(0);
    expect(h.timers.live()).toEqual([]);
  });
});
