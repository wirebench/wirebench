/**
 * `HostInstances` (hosted edition spec §17.3) over fake hosts and fake timers: one instance per user,
 * signed in with its newest socket's token; a session's end closes its sockets `4401` and moves the
 * credential or evicts; the idle time evicts; eviction disposes the host and removes only the scratch
 * directory.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerHost } from '../../../src/host/host-runtime.js';
import { HostInstances, type HostSession, type HostSocketHandle } from '../../../src/host/instances.js';
import { realTimer } from '../../../src/live/module.js';
import { hostDirectories } from '../../../src/host/server-platform.js';

const ALICE = { id: '01JB3Z9K7Q4ZJ6X1V8W2M5N0AA', email: 'alice@example.com' };
const BOB = { id: '01JB3Z9K7Q4ZJ6X1V8W2M5N0BB', email: 'bob@example.com' };
const IDLE_MS = 30 * 60_000;

function fakeHost(): ServerHost & { disposed: number } {
  const host = {
    disposed: 0,
    capabilities: ['send:public'],
    osTheme: 'light' as const,
    channels: () => [],
    attach: () => undefined,
    serve: () => Promise.reject(new Error('unused')),
    detach: () => Promise.resolve(),
    dispose: () => {
      host.disposed += 1;
      return Promise.resolve();
    },
  };
  return host;
}

function socket(token: string, tokenId: string): HostSocketHandle & { closedWith: number[] } {
  const closedWith: number[] = [];
  return { token, tokenId, closedWith, close: (code) => closedWith.push(code) };
}

describe('HostInstances', () => {
  let dataDir: string;
  let made: { userId: string; host: ReturnType<typeof fakeHost>; session: () => HostSession | undefined }[];
  let instances: HostInstances;
  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'wb-host-instances-'));
    made = [];
    instances = new HostInstances({
      dataDir,
      idleMs: IDLE_MS,
      setTimer: realTimer,
      log: () => undefined,
      create: (user, session) => {
        const host = fakeHost();
        made.push({ userId: user.id, host, session });
        return Promise.resolve(host);
      },
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  const credentialOf = (userId: string): string | undefined =>
    made
      .filter((one) => one.userId === userId)
      .at(-1)
      ?.session()?.token;

  it('one instance per user, signed in with the newest socket’s token', async () => {
    const one = socket('token-1', 't1');
    const two = socket('token-2', 't2');
    const first = await instances.open(ALICE, one);
    const second = await instances.open(ALICE, two);
    expect(second).toBe(first);
    expect(made).toHaveLength(1);
    expect(credentialOf(ALICE.id)).toBe('token-2');
    await instances.open(BOB, socket('token-b', 'tb'));
    expect(instances.size).toBe(2);
    // The newest socket closes: the credential is the newest left.
    instances.release(ALICE.id, two);
    expect(credentialOf(ALICE.id)).toBe('token-1');
  });

  it('evicts after the idle time once the last socket closed; a socket in between keeps it', async () => {
    const temp = hostDirectories(dataDir, ALICE.id).temp;
    const checkout = hostDirectories(dataDir, ALICE.id).checkout;
    await mkdir(temp, { recursive: true });
    await mkdir(checkout, { recursive: true });
    const one = socket('token-1', 't1');
    await instances.open(ALICE, one);
    instances.release(ALICE.id, one);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    const back = socket('token-1', 't1');
    await instances.open(ALICE, back);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(instances.size).toBe(1);
    expect(made[0]!.host.disposed).toBe(0);

    instances.release(ALICE.id, back);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(instances.size).toBe(0);
    await vi.waitFor(() => expect(existsSync(temp)).toBe(false));
    expect(made[0]!.host.disposed).toBe(1);
    expect(existsSync(checkout)).toBe(true);
    // A new socket builds a new host.
    await instances.open(ALICE, socket('token-3', 't3'));
    expect(made).toHaveLength(2);
  });

  it('a session’s end closes its sockets 4401 and moves the credential to a live token', async () => {
    const old = socket('token-1', 't1');
    const fresh = socket('token-2', 't2');
    const otherTab = socket('token-2', 't2');
    await instances.open(ALICE, old);
    await instances.open(ALICE, fresh);
    await instances.open(ALICE, otherTab);
    instances.sessionEnded({ tokenId: 't1' });
    expect(old.closedWith).toEqual([4401]);
    expect(fresh.closedWith).toEqual([]);
    expect(credentialOf(ALICE.id)).toBe('token-2');

    // The credential's own session ends; the user still has a socket with another token.
    instances.release(ALICE.id, old);
    const third = socket('token-3', 't3');
    await instances.open(ALICE, third);
    instances.release(ALICE.id, third);
    expect(credentialOf(ALICE.id)).toBe('token-2');
    const fourth = socket('token-4', 't4');
    await instances.open(ALICE, fourth);
    expect(credentialOf(ALICE.id)).toBe('token-4');
    instances.sessionEnded({ tokenId: 't4' });
    expect(fourth.closedWith).toEqual([4401]);
    expect(credentialOf(ALICE.id)).toBe('token-2');
    expect(instances.size).toBe(1);
  });

  it('evicts when the credential’s session ends and no socket has another', async () => {
    const one = socket('token-1', 't1');
    const two = socket('token-1', 't1');
    await instances.open(ALICE, one);
    await instances.open(ALICE, two);
    await instances.open(BOB, socket('token-b', 'tb'));
    instances.sessionEnded({ tokenId: 't1' });
    expect(one.closedWith).toEqual([4401]);
    expect(two.closedWith).toEqual([4401]);
    expect(instances.size).toBe(1);
    await vi.waitFor(() => expect(made[0]!.host.disposed).toBe(1));
    expect(credentialOf(ALICE.id)).toBeUndefined();
  });

  it('a user’s sessions all ending (disabled) closes every socket and evicts; another user’s stay', async () => {
    const one = socket('token-1', 't1');
    const two = socket('token-2', 't2');
    const bob = socket('token-b', 'tb');
    await instances.open(ALICE, one);
    await instances.open(ALICE, two);
    await instances.open(BOB, bob);
    instances.sessionEnded({ userId: ALICE.id });
    expect([one.closedWith, two.closedWith, bob.closedWith]).toEqual([[4401], [4401], []]);
    expect(instances.size).toBe(1);
    // Every session but one (a password change): that one's sockets stay.
    const keep = socket('token-5', 't5');
    const drop = socket('token-6', 't6');
    await instances.open(ALICE, keep);
    await instances.open(ALICE, drop);
    instances.sessionEnded({ userId: ALICE.id, exceptTokenId: 't5' });
    expect([keep.closedWith, drop.closedWith]).toEqual([[], [4401]]);
    expect(credentialOf(ALICE.id)).toBe('token-5');
  });

  it('a socket that arrives during an eviction waits for it, so two hosts never share a checkout', async () => {
    let finish: () => void = () => undefined;
    const slow = fakeHost();
    slow.dispose = () =>
      new Promise<void>((resolve) => {
        finish = () => {
          slow.disposed += 1;
          resolve();
        };
      });
    instances = new HostInstances({
      dataDir,
      idleMs: IDLE_MS,
      setTimer: realTimer,
      log: () => undefined,
      create: () => {
        made.push({ userId: ALICE.id, host: made.length === 0 ? slow : fakeHost(), session: () => undefined });
        return Promise.resolve(made.at(-1)!.host);
      },
    });
    await instances.open(ALICE, socket('token-1', 't1'));
    instances.sessionEnded({ tokenId: 't1' });
    const reopened = instances.open(ALICE, socket('token-2', 't2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(made).toHaveLength(1);
    finish();
    await reopened;
    expect(made).toHaveLength(2);
    expect(slow.disposed).toBe(1);
  });
});
