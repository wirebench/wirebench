/**
 * Slice 5 Task 4 (hosted edition spec §20.3): the live hub in a fleet. Presence crosses instances as user ids, and
 * each hub sends the union with the names it looks up in the tenant; a holder's lists go on its `presenceReset` or
 * when its instance row dies; a resync sends each subscribed socket `head`, `access` and `presence`, the messages
 * every desktop already parses.
 */
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { liveServerMessageSchema, type LiveServerMessage } from '@wirebench/engine';
import type { PresenceChangedEvent, PresenceResetEvent } from '../../../src/context.js';
import { LiveHub, type LiveSession, type LiveSocket } from '../../../src/live/hub.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';

const TENANT = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });
const TENANT_TWO = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'two' });
const HERE = '00000000-0000-4000-8000-0000000000a1';
const THERE = '00000000-0000-4000-8000-0000000000b2';
const ELSEWHERE = '00000000-0000-4000-8000-0000000000c3';
const ANA = '01J8ZD0000000000000000A001';
const BEN = '01J8ZD0000000000000000B002';
const CAT = '01J8ZD0000000000000000C003';
const WS_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const WS_B = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const HEAD = 'c'.repeat(40);
const NAMES: Readonly<Record<string, string>> = { [ANA]: 'Ana', [BEN]: 'Ben', [CAT]: 'Cat' };

class FakeSocket implements LiveSocket {
  readonly sent: LiveServerMessage[] = [];
  closed: number | undefined;
  get isOpen(): boolean {
    return this.closed === undefined;
  }
  send(text: string): void {
    this.sent.push(liveServerMessageSchema.parse(JSON.parse(text)));
  }
  close(code: number): void {
    this.closed = code;
  }
  terminate(): void {
    this.closed = 1006;
  }
  ping(): void {}
  take(): LiveServerMessage[] {
    return this.sent.splice(0);
  }
}

const quiet = (): void => undefined;
const log = { warn: quiet, info: quiet, debug: quiet, error: quiet, child: () => log } as unknown as FastifyBaseLogger;

function fixture(options: { heads?: Record<string, string | null> } = {}) {
  const announced: (PresenceChangedEvent | PresenceResetEvent)[] = [];
  const nameQueries: string[][] = [];
  const headQueries: string[] = [];
  const hub = new LiveHub({
    effectiveRole: () => Promise.resolve({ role: 'editor', source: 'grant' }),
    workspaceIdsOfTeam: () => Promise.resolve([]),
    log,
    now: () => 0,
    setTimer: () => ({ cancel: quiet }),
    cluster: {
      holder: HERE,
      announcePresence: (event) => announced.push(event),
      announceReset: (event) => announced.push(event),
      displayNames: (ids) => {
        nameQueries.push([...ids]);
        return Promise.resolve(new Map(ids.flatMap((id) => (NAMES[id] ? [[id, NAMES[id]] as const] : []))));
      },
      headOf: (workspaceId) => {
        headQueries.push(workspaceId);
        const heads = options.heads ?? {};
        return Promise.resolve(workspaceId in heads ? heads[workspaceId]! : HEAD);
      },
    },
  });
  let token = 0;
  const connect = async (userId: string, workspaceId: string, tenant: TenantScope = TENANT): Promise<FakeSocket> => {
    const socket = new FakeSocket();
    token += 1;
    const session: LiveSession = {
      tokenId: `01J8ZE00000000000000000T${String(token).padStart(2, '0')}`,
      userId,
      name: NAMES[userId]!,
      expiresAt: Number.MAX_SAFE_INTEGER,
      tenant,
    };
    hub.admit(socket, session);
    await hub.subscribe(socket, workspaceId);
    socket.take();
    return socket;
  };
  return { hub, announced, nameQueries, headQueries, connect };
}

const users = (...ids: string[]) => ids.map((id) => ({ id, name: NAMES[id]! }));
const remote = (holder: string, workspaceId: string, ...ids: string[]): PresenceChangedEvent => ({
  tenantId: TENANT.tenantId,
  workspaceId,
  holder,
  users: ids,
});

describe('the live hub across instances (spec §20.3)', () => {
  it('announces its own users of a room as ids when they arrive and leave', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    const ben = await f.connect(BEN, WS_A);
    expect(f.announced).toEqual([remote(HERE, WS_A, ANA), remote(HERE, WS_A, ANA, BEN)]);
    f.announced.length = 0;
    f.hub.remove(ben);
    f.hub.unsubscribe(ana, WS_A);
    expect(f.announced).toEqual([remote(HERE, WS_A, ANA), remote(HERE, WS_A)]);
    // Ids only: never the display name.
    expect(JSON.stringify(f.announced)).not.toContain('Ana');
  });

  it('sends the union of its own users and the other holders’, with names it looks up once', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    f.hub.presenceChanged(remote(THERE, WS_A, BEN));
    await f.hub.idle();
    expect(ana.take()).toEqual([{ type: 'presence', workspaceId: WS_A, users: users(ANA, BEN) }]);
    f.hub.presenceChanged(remote(ELSEWHERE, WS_A, BEN, CAT));
    await f.hub.idle();
    expect(ana.take()).toEqual([{ type: 'presence', workspaceId: WS_A, users: users(ANA, BEN, CAT) }]);
    expect(f.nameQueries).toEqual([[BEN], [CAT]]);
    // A newcomer here sees everyone at once.
    const late = new FakeSocket();
    f.hub.admit(late, {
      tokenId: '01J8ZE0000000000000000LATE',
      userId: CAT,
      name: 'Cat',
      expiresAt: 1e15,
      tenant: TENANT,
    });
    await f.hub.subscribe(late, WS_A);
    expect(late.take().at(-1)).toEqual({ type: 'presence', workspaceId: WS_A, users: users(ANA, BEN, CAT) });
  });

  it('ignores its own announcements, and another tenant’s room is another room', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    f.hub.presenceChanged(remote(HERE, WS_A, BEN));
    f.hub.presenceChanged({ ...remote(THERE, WS_A, BEN), tenantId: TENANT_TWO.tenantId });
    await f.hub.idle();
    expect(ana.take()).toEqual([]);
    expect(f.nameQueries).toEqual([]);
  });

  it('drops a holder’s lists on its presenceReset, and answers with its own lists', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    await f.connect(BEN, WS_B);
    f.hub.presenceChanged(remote(THERE, WS_A, CAT));
    await f.hub.idle();
    ana.take();
    f.announced.length = 0;
    f.hub.presenceReset({ holder: THERE });
    await f.hub.idle();
    expect(ana.take()).toEqual([{ type: 'presence', workspaceId: WS_A, users: users(ANA) }]);
    // The holder that reset learns this hub's rooms again.
    expect(f.announced).toEqual(expect.arrayContaining([remote(HERE, WS_A, ANA), remote(HERE, WS_B, BEN)]));
    expect(f.announced).toHaveLength(2);
  });

  it('drops the lists of a holder whose instance row is gone', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    f.hub.presenceChanged(remote(THERE, WS_A, BEN));
    f.hub.presenceChanged(remote(ELSEWHERE, WS_A, CAT));
    await f.hub.idle();
    ana.take();
    expect(f.hub.otherHolders()).toEqual(new Set([THERE, ELSEWHERE]));
    f.hub.keepHolders(new Set([HERE, ELSEWHERE]));
    expect(ana.take()).toEqual([{ type: 'presence', workspaceId: WS_A, users: users(ANA, CAT) }]);
    expect(f.hub.otherHolders()).toEqual(new Set([ELSEWHERE]));
  });

  it('after a lost bus: presenceReset and its own lists, then head, access and presence to every socket', async () => {
    const f = fixture({ heads: { [WS_B]: null } });
    const ana = await f.connect(ANA, WS_A);
    const ben = await f.connect(BEN, WS_B);
    f.hub.presenceChanged(remote(THERE, WS_A, CAT));
    await f.hub.idle();
    ana.take();
    f.announced.length = 0;
    f.hub.listened({ reconnected: true });
    await f.hub.idle();
    expect(f.announced[0]).toEqual({ holder: HERE });
    expect(f.announced.slice(1)).toEqual(expect.arrayContaining([remote(HERE, WS_A, ANA), remote(HERE, WS_B, BEN)]));
    // One head query per room. The other holders' lists may be stale: they come back as answers to the reset.
    expect(f.headQueries.sort()).toEqual([WS_A, WS_B]);
    expect(ana.take().slice(0, 3)).toEqual([
      { type: 'head', workspaceId: WS_A, head: HEAD },
      { type: 'access', workspaceId: WS_A },
      { type: 'presence', workspaceId: WS_A, users: users(ANA) },
    ]);
    // An unborn branch has no head to send.
    expect(ben.take().slice(0, 2)).toEqual([
      { type: 'access', workspaceId: WS_B },
      { type: 'presence', workspaceId: WS_B, users: users(BEN) },
    ]);
  });

  it('on the first listen, only asks the others for their lists', async () => {
    const f = fixture();
    f.hub.listened({ reconnected: false });
    await f.hub.idle();
    expect(f.announced).toEqual([{ holder: HERE }]);
    expect(f.headQueries).toEqual([]);
  });

  it('a resync event resyncs that tenant’s rooms only', async () => {
    const f = fixture();
    const ana = await f.connect(ANA, WS_A);
    const other = await f.connect(BEN, WS_A, TENANT_TWO);
    f.hub.resync({ tenantId: TENANT.tenantId });
    await f.hub.idle();
    expect(
      ana
        .take()
        .slice(0, 3)
        .map((m) => m.type),
    ).toEqual(['head', 'access', 'presence']);
    expect(other.take()).toEqual([]);
  });

  it('says presenceReset when it closes', async () => {
    const f = fixture();
    await f.connect(ANA, WS_A);
    f.announced.length = 0;
    f.hub.closeAll();
    expect(f.announced).toEqual([{ holder: HERE }]);
  });
});
