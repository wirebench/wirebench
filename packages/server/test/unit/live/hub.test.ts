import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  liveServerMessageSchema,
  type LiveServerMessage,
  type WorkspaceRole,
} from '@wirebench/engine';
import { LiveHub, type LiveSession, type LiveSocket } from '../../../src/live/hub.js';
import type { Effective } from '../../../src/teams/roles.js';

const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ANA = '01J8ZD0000000000000000A001';
const BEN = '01J8ZD0000000000000000B002';
const CAT = '01J8ZD0000000000000000C003';
const WS_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const WS_B = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_C = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_D = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const TEAM = '01J8ZC5Q0V7R3T9XK2M4N6P8T1';
const HEAD = 'c'.repeat(40);
const NAMES: Readonly<Record<string, string>> = { [ANA]: 'Ana', [BEN]: 'Ben', [CAT]: 'Cat' };
const ENDED: LiveServerMessage[] = [{ type: 'session-ended' }];

/** `n` distinct workspace ids on `TEAMS_ID_PATTERN`. */
const workspaceIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `01J8ZC5Q0V7R3T9XK2M4N6${String(i).padStart(4, '0')}`);

const presence = (workspaceId: string, ...userIds: string[]): LiveServerMessage => ({
  type: 'presence',
  workspaceId,
  users: userIds.map((id) => ({ id, name: NAMES[id] ?? id })),
});
const head = (workspaceId: string): LiveServerMessage => ({ type: 'head', workspaceId, head: HEAD });
const access = (workspaceId: string): LiveServerMessage => ({ type: 'access', workspaceId });

/** A `ws` socket as the hub sees it. Every message it is sent must parse as the wire union (§4). */
class FakeSocket implements LiveSocket {
  readonly sent: LiveServerMessage[] = [];
  closed: { readonly code: number; readonly reason?: string } | undefined;
  terminated = false;
  pings = 0;
  /** Makes `send` throw, as `ws` does for a socket that died between two frames. */
  failSend = false;

  get isOpen(): boolean {
    return this.closed === undefined && !this.terminated;
  }
  send(text: string): void {
    if (this.failSend) throw new Error('write after end');
    this.sent.push(liveServerMessageSchema.parse(JSON.parse(text)));
  }
  close(code: number, reason?: string): void {
    this.closed = reason === undefined ? { code } : { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  /** The messages since the last `take()`, which it clears. */
  take(): LiveServerMessage[] {
    return this.sent.splice(0);
  }
}

interface Timer {
  readonly at: number;
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** Injected time (Global Constraints: never sleep in a test). */
function fakeClock() {
  let now = T0;
  const timers: Timer[] = [];
  return {
    now: (): number => now,
    setTimer: (fn: () => void, ms: number): { cancel(): void } => {
      const timer: Timer = { at: now + ms, ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    /** Moves time forward, running each due timer at its own time, including any a timer arms. */
    advance: (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
      }
      now = until;
    },
    /** The delays of the timers still armed. */
    armed: (): number[] => timers.filter((t) => !t.cancelled).map((t) => t.ms),
  };
}

function fakeLog(warnings: unknown[][]): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const log = {
    level: 'warn',
    fatal: quiet,
    error: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    warn: (...args: unknown[]): void => {
      warnings.push(args);
    },
    child: (): unknown => log,
  };
  return log as unknown as FastifyBaseLogger;
}

function fixture() {
  const clock = fakeClock();
  const warnings: unknown[][] = [];
  const roles = new Map<string, WorkspaceRole>();
  const teams = new Map<string, readonly string[]>();
  const roleCalls: string[] = [];
  const teamCalls: string[] = [];
  let gate: Promise<void> | undefined;
  let failure: Error | undefined;
  const hub = new LiveHub({
    effectiveRole: async (userId: string, workspaceId: string): Promise<Effective> => {
      roleCalls.push(`${userId} ${workspaceId}`);
      if (gate !== undefined) await gate;
      if (failure !== undefined) throw failure;
      const role = roles.get(`${userId} ${workspaceId}`);
      return role === undefined ? { role: 'none' } : { role, source: 'grant' };
    },
    workspaceIdsOfTeam: (teamId: string): Promise<string[]> => {
      teamCalls.push(teamId);
      return failure === undefined ? Promise.resolve([...(teams.get(teamId) ?? [])]) : Promise.reject(failure);
    },
    log: fakeLog(warnings),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return {
    hub,
    clock,
    warnings,
    roleCalls,
    teamCalls,
    grant: (userId: string, workspaceId: string, role: WorkspaceRole | 'none'): void => {
      if (role === 'none') roles.delete(`${userId} ${workspaceId}`);
      else roles.set(`${userId} ${workspaceId}`, role);
    },
    team: (teamId: string, ids: readonly string[]): void => {
      teams.set(teamId, ids);
    },
    /** Holds every role query until `release()`, to see what the hub does meanwhile. */
    hold: (): { release(): void } => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return {
        release: () => {
          gate = undefined;
          open();
        },
      };
    },
    /** Makes every query reject with `error`, or succeed again with `undefined`. */
    fail: (error: Error | undefined): void => {
      failure = error;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

interface SessionOptions {
  readonly name?: string;
  readonly expiresAt?: number;
}

function session(userId: string, tokenId: string, options: SessionOptions = {}): LiveSession {
  return {
    tokenId,
    userId,
    name: options.name ?? NAMES[userId] ?? userId,
    expiresAt: options.expiresAt ?? T0 + 180 * DAY,
  };
}

/** An admitted socket, its `ready` already taken. */
function open(f: Fixture, userId: string, tokenId: string, options: SessionOptions = {}): FakeSocket {
  const socket = new FakeSocket();
  expect(f.hub.admit(socket, session(userId, tokenId, options))).toBe('ok');
  expect(socket.take()).toEqual([{ type: 'ready' }]);
  return socket;
}

/** An admitted socket subscribed to `workspaceId` at `role`, its own messages taken. */
async function joined(
  f: Fixture,
  userId: string,
  tokenId: string,
  workspaceId: string,
  role: WorkspaceRole = 'viewer',
  options: SessionOptions = {},
): Promise<FakeSocket> {
  f.grant(userId, workspaceId, role);
  const socket = open(f, userId, tokenId, options);
  await f.hub.subscribe(socket, workspaceId);
  expect(socket.take().map((m) => m.type)).toEqual(['presence']);
  return socket;
}

function settle(...sockets: FakeSocket[]): void {
  for (const socket of sockets) socket.take();
}

describe('LiveHub — admit (§3.3)', () => {
  it("refuses a user's 33rd socket with 4429 and keeps nothing of it", () => {
    const f = fixture();
    const sockets = Array.from({ length: LIVE_LIMITS.maxSocketsPerUser }, (_, i) => open(f, ANA, `tok-ana-${i}`));
    const extra = new FakeSocket();
    expect(f.hub.admit(extra, session(ANA, 'tok-ana-extra'))).toBe('too-many-sockets');
    expect(extra.closed?.code).toBe(LIVE_CLOSE.tooManySockets);
    expect(extra.sent).toEqual([]);
    expect(sockets.every((socket) => socket.isOpen)).toBe(true);
    open(f, BEN, 'tok-ben'); // the limit is per user
    f.hub.remove(sockets[0]!);
    open(f, ANA, 'tok-ana-again'); // a closed socket makes room
  });
});

describe('LiveHub — subscribe (§3.1)', () => {
  it('refuses a workspace the user cannot see, as HTTP does, and sends it nothing later', async () => {
    const f = fixture();
    const ana = open(f, ANA, 'tok-ana');
    await f.hub.subscribe(ana, WS_A);
    expect(ana.take()).toEqual([{ type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' }]);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.sent).toEqual([]);
  });

  it('admits a viewer with the presence list, and a repeat is a no-op', async () => {
    const f = fixture();
    f.grant(ANA, WS_A, 'viewer');
    const ana = open(f, ANA, 'tok-ana');
    await f.hub.subscribe(ana, WS_A);
    expect(ana.take()).toEqual([presence(WS_A, ANA)]);
    await f.hub.subscribe(ana, WS_A);
    expect(ana.sent).toEqual([]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`]);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_A)]);
  });

  it("refuses a session's 201st subscription across its sockets without a query; another session still subscribes", async () => {
    const f = fixture();
    const ids = workspaceIds(LIVE_LIMITS.maxSubscriptionsPerSession + 1);
    for (const id of ids) f.grant(ANA, id, 'viewer');
    const first = open(f, ANA, 'tok-ana');
    const second = open(f, ANA, 'tok-ana');
    const half = LIVE_LIMITS.maxSubscriptionsPerSession / 2;
    for (const id of ids.slice(0, half)) await f.hub.subscribe(first, id);
    for (const id of ids.slice(half, 2 * half)) await f.hub.subscribe(second, id);
    settle(first, second);
    f.roleCalls.length = 0;

    const over = ids[LIVE_LIMITS.maxSubscriptionsPerSession]!;
    await f.hub.subscribe(second, over);
    expect(second.take()).toEqual([{ type: 'refused', workspaceId: over, code: 'live-too-many-subscriptions' }]);
    expect(f.roleCalls).toEqual([]);

    const desk = open(f, ANA, 'tok-ana-desk');
    await f.hub.subscribe(desk, over);
    expect(desk.take()).toEqual([presence(over, ANA)]);
  });

  it('counts again after the query, so two subscribes racing for the last slot admit one', async () => {
    const f = fixture();
    const ids = workspaceIds(LIVE_LIMITS.maxSubscriptionsPerSession + 1);
    for (const id of ids) f.grant(ANA, id, 'viewer');
    const ana = open(f, ANA, 'tok-ana');
    for (const id of ids.slice(0, -2)) await f.hub.subscribe(ana, id);
    ana.take();
    const [last, extra] = ids.slice(-2) as [string, string];
    await Promise.all([f.hub.subscribe(ana, last), f.hub.subscribe(ana, extra)]);
    expect(ana.take()).toEqual([
      presence(last, ANA),
      { type: 'refused', workspaceId: extra, code: 'live-too-many-subscriptions' },
    ]);
  });

  it('drops a subscribe whose socket closed while the role query ran', async () => {
    const f = fixture();
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    f.grant(ANA, WS_A, 'editor');
    const ana = open(f, ANA, 'tok-ana');
    const gate = f.hold();
    const pending = f.hub.subscribe(ana, WS_A);
    f.hub.remove(ana);
    gate.release();
    await pending;
    expect(ana.sent).toEqual([]);
    expect(ben.sent).toEqual([]);
  });

  it('logs a failed role query without the token and closes that socket 1011', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    ana.take();
    f.fail(new Error('connection reset'));
    await f.hub.subscribe(ana, WS_B);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.serverError);
    expect(ana.sent).toEqual([]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(f.warnings).toHaveLength(1);
    expect(JSON.stringify(f.warnings)).not.toContain('tok-ana');
  });
});

describe('LiveHub — presence (§3.1)', () => {
  it('goes to everyone when a user arrives or leaves, sorted by name then id, recipient included', async () => {
    const f = fixture();
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    expect(ben.take()).toEqual([presence(WS_A, ANA, BEN)]);

    const cat = await joined(f, CAT, 'tok-cat', WS_A, 'viewer', { name: 'ana' });
    const all: LiveServerMessage = {
      type: 'presence',
      workspaceId: WS_A,
      users: [
        { id: ANA, name: 'Ana' },
        { id: CAT, name: 'ana' },
        { id: BEN, name: 'Ben' },
      ],
    };
    expect(ben.take()).toEqual([all]);
    expect(ana.take()).toEqual([all]);

    f.hub.unsubscribe(cat, WS_A);
    expect(cat.sent).toEqual([]); // unsubscribe is silent to the one leaving
    expect(ben.take()).toEqual([presence(WS_A, ANA, BEN)]);

    f.hub.remove(ana);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(cat.sent).toEqual([]);
  });

  it('a second device of the same user changes nothing for the others', async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    laptop.take();

    const desk = open(f, ANA, 'tok-ana-desk');
    await f.hub.subscribe(desk, WS_A);
    expect(desk.take()).toEqual([presence(WS_A, ANA, BEN)]);
    expect([...laptop.sent, ...ben.sent]).toEqual([]);

    f.hub.remove(desk);
    expect([...laptop.sent, ...ben.sent]).toEqual([]);
    f.hub.remove(laptop);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
  });
});

describe('LiveHub — headMoved (§3.1, §3.2)', () => {
  it("reaches every subscriber of the workspace except the pushing session's sockets", async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A, 'editor');
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A, 'editor');
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const cat = await joined(f, CAT, 'tok-cat', WS_B);
    settle(laptop, desk, ben, cat);

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ana-laptop' });
    expect(laptop.sent).toEqual([]);
    expect(desk.take()).toEqual([head(WS_A)]); // the same user on another device still hears it
    expect(ben.take()).toEqual([head(WS_A)]);
    expect(cat.sent).toEqual([]);
  });
});

describe('LiveHub — accessChanged (§3.2, §3.3)', () => {
  it('returns at once, re-resolves each (user, workspace) once, messages only changed roles, and drops none', async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A, 'editor');
    settle(laptop, desk, ben);
    f.roleCalls.length = 0;

    f.grant(ANA, WS_A, 'editor');
    const gate = f.hold();
    f.hub.accessChanged({ workspaceId: WS_A });
    expect(laptop.sent).toEqual([]); // the check runs in the background
    gate.release();
    await f.hub.idle();
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${BEN} ${WS_A}`]);
    expect(laptop.take()).toEqual([access(WS_A)]);
    expect(desk.take()).toEqual([access(WS_A)]);
    expect(ben.sent).toEqual([]);

    // The new role was recorded, so the same event again messages nobody.
    f.hub.accessChanged({ workspaceId: WS_A });
    await f.hub.idle();
    expect([...laptop.sent, ...desk.sent, ...ben.sent]).toEqual([]);

    f.grant(ANA, WS_A, 'none');
    f.hub.accessChanged({ workspaceId: WS_A });
    await f.hub.idle();
    expect(laptop.take()).toEqual([access(WS_A)]);
    expect(desk.take()).toEqual([access(WS_A)]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(laptop.isOpen).toBe(true); // dropped from the workspace, not disconnected

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-cat' });
    expect([...laptop.sent, ...desk.sent]).toEqual([]);
    expect(ben.take()).toEqual([head(WS_A)]);
  });

  it('scopes a team change with one query, intersected with what is subscribed, and to the user named', async () => {
    const f = fixture();
    f.team(TEAM, [WS_A, WS_B, WS_D]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.grant(ANA, WS_B, 'viewer');
    await f.hub.subscribe(ana, WS_B);
    f.grant(ANA, WS_C, 'viewer');
    await f.hub.subscribe(ana, WS_C);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);
    f.roleCalls.length = 0;

    for (const id of [WS_A, WS_B, WS_C]) f.grant(ANA, id, 'none');
    f.hub.accessChanged({ teamId: TEAM, userId: ANA }); // Ana removed from the team
    await f.hub.idle();
    expect(f.teamCalls).toEqual([TEAM]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${ANA} ${WS_B}`]);
    expect(ana.take()).toEqual([access(WS_A), access(WS_B)]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    // WS_C belongs to another team, so that subscription stands.
    f.hub.headMoved({ workspaceId: WS_C, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_C)]);
  });

  it("with only a user, re-checks that user's subscriptions everywhere and nobody else's", async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.grant(ANA, WS_B, 'viewer');
    await f.hub.subscribe(ana, WS_B);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);
    f.roleCalls.length = 0;

    f.grant(ANA, WS_A, 'admin'); // made a server admin (R4)
    f.grant(ANA, WS_B, 'admin');
    f.hub.accessChanged({ userId: ANA });
    await f.hub.idle();
    expect(f.teamCalls).toEqual([]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${ANA} ${WS_B}`]);
    expect(ana.take()).toEqual([access(WS_A), access(WS_B)]);
    expect(ben.sent).toEqual([]);
  });

  it('logs a failed query, ends that check, and leaves every subscription as it was', async () => {
    const f = fixture();
    f.team(TEAM, [WS_A]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.fail(new Error('connection reset'));
    f.hub.accessChanged({ teamId: TEAM });
    await f.hub.idle();
    expect(f.warnings).toHaveLength(1);
    expect(ana.sent).toEqual([]);

    f.fail(undefined);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_A)]);
  });

  it('makes no query at all while nothing is subscribed', () => {
    const f = fixture();
    open(f, ANA, 'tok-ana');
    f.hub.accessChanged({ teamId: TEAM });
    f.hub.accessChanged({ userId: ANA });
    expect(f.teamCalls).toEqual([]);
    expect(f.roleCalls).toEqual([]);
  });
});

describe('LiveHub — sessionEnded (§3.1, §3.2)', () => {
  it("ends a token's sockets, or a user's minus the one excepted, with session-ended then 4401", async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A);
    const phone = await joined(f, ANA, 'tok-ana-phone', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(laptop, desk, phone, ben);

    f.hub.sessionEnded({ tokenId: 'tok-ana-laptop' }); // signed out, or that device removed
    expect(laptop.take()).toEqual(ENDED);
    expect(laptop.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect([...desk.sent, ...phone.sent, ...ben.sent]).toEqual([]); // Ana is still here on two devices

    f.hub.sessionEnded({ userId: ANA, exceptTokenId: 'tok-ana-desk' }); // password changed on the desk
    expect(phone.take()).toEqual(ENDED);
    expect(phone.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(desk.isOpen).toBe(true);
    expect([...desk.sent, ...ben.sent]).toEqual([]);

    f.hub.sessionEnded({ userId: ANA }); // disabled, or a reset accepted
    expect(desk.take()).toEqual(ENDED);
    expect(desk.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    // The sockets' own close events arrive later and change nothing.
    f.hub.remove(laptop);
    f.hub.remove(desk);
    expect(ben.sent).toEqual([]);
  });
});

describe('LiveHub — dead sockets and heartbeat (§3.3)', () => {
  it('terminates a socket whose send throws, removes it, and still reaches the rest', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const cat = await joined(f, CAT, 'tok-cat', WS_A);
    settle(ana, ben, cat);

    ben.failSend = true;
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.terminated).toBe(true);
    expect(ana.take()).toEqual([head(WS_A), presence(WS_A, ANA, CAT)]);
    expect(cat.take()).toEqual([head(WS_A), presence(WS_A, ANA, CAT)]);

    ben.failSend = false;
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.sent).toEqual([]); // no longer indexed
  });

  it('treats a socket that is no longer open the same way', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    ben.closed = { code: 1006 }; // the peer vanished; its close event has not arrived yet
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.terminated).toBe(true);
    expect(ana.take()).toEqual([head(WS_A), presence(WS_A, ANA)]);
  });

  it('pings every socket and terminates one that did not answer the previous ping', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    f.hub.heartbeat();
    expect([ana.pings, ben.pings]).toEqual([1, 1]);
    f.hub.pong(ana);
    f.hub.heartbeat();
    expect(ben.terminated).toBe(true);
    expect([ana.pings, ben.pings]).toEqual([2, 1]);
    expect(ana.take()).toEqual([presence(WS_A, ANA)]);

    f.hub.pong(ana);
    f.hub.heartbeat();
    expect(ana.isOpen).toBe(true);
    expect(ana.pings).toBe(3);
  });
});

describe('LiveHub — maximum age (§3.3)', () => {
  it('ends a session at its deadline, and a removed socket leaves no timer behind', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A, 'viewer', { expiresAt: T0 + HOUR });
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    f.clock.advance(HOUR - 1);
    expect(ana.isOpen).toBe(true);
    f.clock.advance(1);
    expect(ana.take()).toEqual(ENDED);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    f.hub.remove(ben);
    expect(f.clock.armed()).toEqual([]);
  });

  it('waits out a 180-day maximum age in steps a timer can hold', () => {
    const f = fixture();
    const ana = open(f, ANA, 'tok-ana', { expiresAt: T0 + 180 * DAY });
    expect(Math.max(...f.clock.armed())).toBeLessThanOrEqual(2 ** 31 - 1);
    f.clock.advance(180 * DAY - 1);
    expect(ana.isOpen).toBe(true);
    f.clock.advance(1);
    expect(ana.take()).toEqual(ENDED);
  });
});

describe('LiveHub — closeAll (§3.3, §5.1)', () => {
  it('closes every socket 1001, drops every timer, and turns later calls into no-ops', async () => {
    const f = fixture();
    f.team(TEAM, [WS_A]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_B);
    settle(ana, ben);

    f.hub.closeAll();
    expect([ana.closed?.code, ben.closed?.code]).toEqual([LIVE_CLOSE.goingAway, LIVE_CLOSE.goingAway]);
    expect(f.clock.armed()).toEqual([]);

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    f.hub.accessChanged({ teamId: TEAM });
    f.hub.sessionEnded({ userId: ANA });
    f.hub.heartbeat();
    f.hub.remove(ana);
    await f.hub.idle();
    expect([...ana.sent, ...ben.sent]).toEqual([]);
    expect([ana.pings, ben.pings]).toEqual([0, 0]);
    expect(f.teamCalls).toEqual([]);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.goingAway);

    const late = new FakeSocket(); // authenticated while the server was closing
    expect(f.hub.admit(late, session(CAT, 'tok-cat'))).toBe('ok');
    expect(late.closed?.code).toBe(LIVE_CLOSE.goingAway);
    expect(late.sent).toEqual([]);
  });
});
