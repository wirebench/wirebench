import { scopeOf } from '../../../src/tenancy/scope.js';
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_LIMITS,
  terminalShareServerMessageSchema,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import {
  ReplayBuffer,
  ShareRegistry,
  type ShareAuditEvent,
  type ShareIdentity,
  type SharePeer,
} from '../../../src/terminal-shares/registry.js';

class FakePeer implements SharePeer {
  readonly texts: TerminalShareServerMessage[] = [];
  readonly binaries: Buffer[] = [];
  closed: { code: number; reason: string } | undefined;
  terminated = false;
  pings = 0;
  sendText(text: string): void {
    this.texts.push(terminalShareServerMessageSchema.parse(JSON.parse(text)));
  }
  sendBinary(data: Buffer): void {
    this.binaries.push(Buffer.from(data));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  get isOpen(): boolean {
    return this.closed === undefined && !this.terminated;
  }
  last<T extends TerminalShareServerMessage['type']>(type: T): Extract<TerminalShareServerMessage, { type: T }> {
    const found = this.texts.filter((m) => m.type === type).at(-1);
    if (found === undefined) throw new Error(`no ${type} message`);
    return found as Extract<TerminalShareServerMessage, { type: T }>;
  }
}

const OWNER = '01HZY3K8J9V7Q2W5N4M6P1R0AA';
const BOB = '01HZY3K8J9V7Q2W5N4M6P1R0BB';
const CAROL = '01HZY3K8J9V7Q2W5N4M6P1R0CC';
const WS = '01HZY3K8J9V7Q2W5N4M6P1R0WS';

function who(userId: string, name: string, extra: Partial<ShareIdentity> = {}): ShareIdentity {
  return {
    userId,
    name,
    tokenId: `tok-${name}`,
    expiresAt: 10_000_000,
    source: { actor: { kind: 'user', userId, email: `${name}@x`, tokenId: `tok-${name}` } },
    ...extra,
  };
}

function setup() {
  let clock = 1000;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const audits: ShareAuditEvent[] = [];
  const access = new Map<string, boolean>();
  let next = 0;
  const registry = new ShareRegistry({
    canView: (userId) => Promise.resolve(access.get(userId) ?? true),
    audit: (event) => audits.push(event),
    newShareId: () => `share${String(next++).padStart(21, 'a')}`,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });
  const shareId = registry.create({
    workspaceId: WS,
    hostName: 'web',
    cols: 80,
    rows: 24,
    ownerId: OWNER,
    ownerName: 'Alice',
    source: who(OWNER, 'alice').source,
    tenant: scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' }),
  });
  const owner = new FakePeer();
  const actions = (): string[] => audits.map((a) => a.action);
  return {
    registry,
    shareId,
    owner,
    audits,
    actions,
    access,
    timers,
    tick: (ms: number) => {
      clock += ms;
    },
    attachOwner: () => registry.attach(owner, who(OWNER, 'alice'), WS, shareId),
    join: (userId: string, name: string, extra: Partial<ShareIdentity> = {}) => {
      const peer = new FakePeer();
      return { peer, outcome: registry.attach(peer, who(userId, name, extra), WS, shareId) };
    },
  };
}

describe('ReplayBuffer', () => {
  it('keeps the last cap bytes across pushes', () => {
    const replay = new ReplayBuffer(5);
    replay.push(Buffer.from('abc'));
    replay.push(Buffer.from('defg'));
    expect(replay.contents().toString()).toBe('cdefg');
    replay.push(Buffer.from('0123456789'));
    expect(replay.contents().toString()).toBe('56789');
  });
});

describe('ShareRegistry (team sessions spec B1)', () => {
  it('starts a share, attaches the owner and refuses a second owner socket', () => {
    const s = setup();
    expect(s.attachOwner()).toBe('owner');
    expect(s.owner.texts[0]).toEqual({ type: 'ready', role: 'owner' });
    expect(s.registry.attach(new FakePeer(), who(OWNER, 'alice'), WS, s.shareId)).toBe('owner-taken');
    expect(s.registry.attach(new FakePeer(), who(BOB, 'bob'), 'other', s.shareId)).toBe('not-found');
    expect(s.actions()).toEqual(['terminal_share.started']);
    expect(s.audits[0]).toMatchObject({ workspaceId: WS, shareId: s.shareId, details: { hostName: 'web' } });
  });

  it('drops a share whose owner never attaches', () => {
    const s = setup();
    s.timers[0]!.fn();
    expect(s.registry.size).toBe(0);
    expect(s.audits.at(-1)).toMatchObject({ action: 'terminal_share.ended', details: { reason: 'owner-left' } });
  });

  it('relays output, replays the recent screen to a late joiner, and announces presence', () => {
    const s = setup();
    s.attachOwner();
    expect(s.registry.output(s.owner, Buffer.from('$ ls\r\n'))).toBe('ok');
    const bob = s.join(BOB, 'bob');
    expect(bob.outcome).toBe('viewer');
    expect(bob.peer.texts[0]).toEqual({
      type: 'viewer-ready',
      hostName: 'web',
      ownerName: 'Alice',
      cols: 80,
      rows: 24,
    });
    expect(bob.peer.binaries.map(String)).toEqual(['$ ls\r\n']);
    s.registry.output(s.owner, Buffer.from('a.txt\r\n'));
    expect(bob.peer.binaries.map(String)).toEqual(['$ ls\r\n', 'a.txt\r\n']);
    expect(s.owner.last('presence').viewers).toEqual([{ userId: BOB, name: 'bob', control: false, requesting: false }]);
    // A viewer may not send output.
    expect(s.registry.output(bob.peer, Buffer.from('x'))).toBe('bad');
    expect(s.actions()).toEqual(['terminal_share.started', 'terminal_share.joined']);
  });

  it('control: request, grant, input to the owner, take back', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    const data = Buffer.from('ls\r').toString('base64');
    // Input before control is dropped.
    s.registry.message(bob.peer, { type: 'input', data });
    expect(s.owner.texts.some((m) => m.type === 'input')).toBe(false);
    // A grant without a request does nothing.
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    expect(bob.peer.last('control').userId).toBeNull();
    s.registry.message(bob.peer, { type: 'request-control' });
    expect(s.owner.last('presence').viewers[0]).toMatchObject({ requesting: true });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    expect(bob.peer.last('control').userId).toBe(BOB);
    s.registry.message(bob.peer, { type: 'input', data });
    expect(s.owner.last('input')).toEqual({ type: 'input', userId: BOB, data });
    s.registry.message(s.owner, { type: 'take-back' });
    expect(bob.peer.last('control').userId).toBeNull();
    expect(s.actions().slice(2)).toEqual(['terminal_share.control_granted', 'terminal_share.control_returned']);
    expect(s.audits.at(-1)!.details).toMatchObject({ userId: BOB, by: 'owner' });
  });

  it('one holder at a time: granting another moves control', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    const carol = s.join(CAROL, 'carol');
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    s.registry.message(carol.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: CAROL });
    expect(bob.peer.last('control').userId).toBe(CAROL);
    const viewers = s.owner.last('presence').viewers;
    expect(viewers.filter((v) => v.control).map((v) => v.userId)).toEqual([CAROL]);
  });

  it('declines a request, and a holder can release', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'decline', userId: BOB });
    expect(bob.peer.texts.some((m) => m.type === 'declined')).toBe(true);
    expect(s.owner.last('presence').viewers[0]).toMatchObject({ requesting: false });
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    s.registry.message(bob.peer, { type: 'release' });
    expect(s.owner.last('control').userId).toBeNull();
    expect(s.audits.at(-1)!.details).toMatchObject({ by: 'viewer' });
  });

  it('caps a holder input rate', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    for (let i = 0; i < TERMINAL_SHARE_LIMITS.inputsPerSecond + 10; i += 1) {
      s.registry.message(bob.peer, { type: 'input', data: 'eA==' });
    }
    expect(s.owner.texts.filter((m) => m.type === 'input')).toHaveLength(TERMINAL_SHARE_LIMITS.inputsPerSecond);
    s.tick(1000);
    s.registry.message(bob.peer, { type: 'input', data: 'eA==' });
    expect(s.owner.texts.filter((m) => m.type === 'input')).toHaveLength(TERMINAL_SHARE_LIMITS.inputsPerSecond + 1);
  });

  it('refuses messages of the other role', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    expect(s.registry.message(bob.peer, { type: 'grant', userId: BOB })).toBe('bad');
    expect(s.registry.message(bob.peer, { type: 'end' })).toBe('bad');
    expect(s.registry.message(s.owner, { type: 'request-control' })).toBe('bad');
    expect(s.registry.message(new FakePeer(), { type: 'ping' })).toBe('bad');
    expect(s.registry.message(bob.peer, { type: 'ping' })).toBe('ok');
    expect(bob.peer.last('pong')).toEqual({ type: 'pong' });
  });

  it('removes a viewer, who loses control and cannot come back', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    s.registry.message(s.owner, { type: 'remove', userId: BOB });
    expect(bob.peer.last('ended').reason).toBe('removed');
    expect(bob.peer.closed?.code).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    expect(s.owner.last('control').userId).toBeNull();
    expect(s.owner.last('presence').viewers).toEqual([]);
    expect(s.join(BOB, 'bob').outcome).toBe('removed');
    expect(s.registry.info(WS, s.shareId, BOB)).toBeUndefined();
    expect(s.actions()).toContain('terminal_share.viewer_removed');
  });

  it('caps the viewers', () => {
    const s = setup();
    s.attachOwner();
    for (let i = 0; i < TERMINAL_SHARE_LIMITS.maxViewers; i += 1) expect(s.join(BOB, `v${i}`).outcome).toBe('viewer');
    expect(s.join(CAROL, 'carol').outcome).toBe('full');
    expect(s.registry.info(WS, s.shareId, CAROL)).toEqual({ hostName: 'web', ownerName: 'Alice', viewers: 20 });
  });

  it('ends for everyone when the owner ends it or leaves', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(s.owner, { type: 'end' });
    expect(bob.peer.last('ended').reason).toBe('ended');
    expect(bob.peer.closed?.code).toBe(TERMINAL_SHARE_CLOSE.ended);
    expect(s.owner.closed?.code).toBe(TERMINAL_SHARE_CLOSE.ended);
    expect(s.registry.size).toBe(0);
    expect(s.audits.at(-1)).toMatchObject({ action: 'terminal_share.ended', details: { reason: 'ended', viewers: 1 } });

    const t = setup();
    t.attachOwner();
    const carol = t.join(CAROL, 'carol');
    t.registry.detach(t.owner);
    expect(carol.peer.last('ended').reason).toBe('owner-left');
  });

  it('a viewer leaving while holding control returns it', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(bob.peer, { type: 'request-control' });
    s.registry.message(s.owner, { type: 'grant', userId: BOB });
    s.registry.detach(bob.peer);
    expect(s.owner.last('control').userId).toBeNull();
    expect(s.audits.at(-1)!.details).toMatchObject({ by: 'left' });
  });

  it('a lost access closes that viewer; the owner losing it ends the share', async () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    const carol = s.join(CAROL, 'carol');
    s.access.set(BOB, false);
    await s.registry.recheck();
    expect(bob.peer.last('ended').reason).toBe('access');
    expect(bob.peer.closed?.code).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    expect(carol.peer.closed).toBeUndefined();
    s.access.set(OWNER, false);
    await s.registry.recheck();
    expect(carol.peer.last('ended').reason).toBe('access');
    expect(s.registry.size).toBe(0);
  });

  it('an ended device token closes its sockets', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.sessionEnded({ tokenId: 'tok-bob' });
    expect(bob.peer.last('ended').reason).toBe('revoked');
    expect(bob.peer.closed?.code).toBe(TERMINAL_SHARE_CLOSE.unauthenticated);
    s.registry.sessionEnded({ userId: OWNER, exceptTokenId: 'tok-alice' });
    expect(s.registry.size).toBe(1);
    s.registry.sessionEnded({ userId: OWNER });
    expect(s.registry.size).toBe(0);
  });

  it('heartbeat: pings, drops a socket that missed its pong, and ends at token max age', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.heartbeat();
    expect(bob.peer.pings).toBe(1);
    expect(s.owner.pings).toBe(1);
    s.registry.pong(s.owner);
    s.registry.heartbeat();
    expect(bob.peer.terminated).toBe(true);
    expect(s.owner.terminated).toBe(false);
    s.tick(20_000_000);
    s.registry.pong(s.owner);
    s.registry.heartbeat();
    expect(s.registry.size).toBe(0);
    expect(s.audits.at(-1)).toMatchObject({ action: 'terminal_share.ended', details: { reason: 'revoked' } });
  });

  it('resize reaches viewers and late joiners', () => {
    const s = setup();
    s.attachOwner();
    const bob = s.join(BOB, 'bob');
    s.registry.message(s.owner, { type: 'resize', cols: 120, rows: 40 });
    expect(bob.peer.last('resize')).toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(s.join(CAROL, 'carol').peer.texts[0]).toMatchObject({ cols: 120, rows: 40 });
  });
});
