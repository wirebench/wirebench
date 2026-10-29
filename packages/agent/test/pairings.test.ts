/**
 * The pairing store's file (`userData/agent-pairings.json`, version 1): written only once there is an
 * identity, the key sealed by the platform, read back by a second store over the same directory.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPairingStore, PAIRINGS_FILE } from '../src/pairings.js';
import { cleanUp, fakePlatform, ulidLike } from './helpers.js';

afterEach(cleanUp);

const pairing = (overrides: Partial<{ pairingId: string; port: number }> = {}) => ({
  pairingId: overrides.pairingId ?? ulidLike(),
  serverUrl: 'https://team.example.test',
  origin: 'https://team.example.test',
  email: 'ada@example.test',
  sshOptIn: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  ...(overrides.port === undefined ? {} : { port: overrides.port }),
});

describe('openPairingStore', () => {
  it('writes nothing for an agent that never paired', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(platform.paths.userData(), PAIRINGS_FILE))).toBe(false);
  });

  it('round-trips the identity and the pairings through the platform, with the key sealed', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const { agentId, key } = await store.identity();
    const first = pairing({ port: 47_615 });
    const second = pairing();
    await store.add(first);
    await store.add(second);
    await store.setPort(second.pairingId, 47_616);

    const text = readFileSync(join(platform.paths.userData(), PAIRINGS_FILE), 'utf8');
    const file = JSON.parse(text) as { version: number; agentId: string; privateKeySealed: string };
    expect(file.version).toBe(1);
    expect(file.agentId).toBe(agentId);
    // Sealed by the platform: the PKCS8 text is not in the file, only what `encrypt` made of it.
    expect(text).not.toContain(key.sealable());
    expect(Buffer.from(file.privateKeySealed, 'base64').toString('utf8')).toMatch(/^sealed:/);
    expect(statSync(join(platform.paths.userData(), PAIRINGS_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(platform.paths.userData())).toEqual([PAIRINGS_FILE]);

    const again = await openPairingStore(fakePlatform(undefined, platform.paths.userData()));
    const reread = await again.identity();
    expect(reread.agentId).toBe(agentId);
    expect(reread.key.publicKey).toBe(key.publicKey);
    expect(reread.key.sign('m')).toBe(key.sign('m'));
    expect(again.list()).toEqual([first, { ...second, port: 47_616 }]);

    expect(await again.remove(first.pairingId)).toBe(true);
    expect(await again.remove(first.pairingId)).toBe(false);
    expect((await openPairingStore(platform)).list()).toEqual([{ ...second, port: 47_616 }]);
  });

  it('refuses a file it cannot read rather than replacing it', async () => {
    const platform = fakePlatform();
    writeFileSync(join(platform.paths.userData(), PAIRINGS_FILE), JSON.stringify({ version: 2 }));
    await expect(openPairingStore(platform)).rejects.toThrow(/not a pairings file/);
  });

  it('will not make a key on a platform that cannot keep it secret', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore({ ...platform, secrets: { ...platform.secrets, available: () => false } });
    await expect(store.identity()).rejects.toThrow(/cannot keep the agent key secret/);
  });

  it('refuses a file that is not JSON with the same error, not a raw SyntaxError', async () => {
    const platform = fakePlatform();
    writeFileSync(join(platform.paths.userData(), PAIRINGS_FILE), '{ not json');
    const failure: unknown = await openPairingStore(platform).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SyntaxError);
    expect((failure as Error).message).toMatch(/not a pairings file/);
  });

  it('makes one identity when two first pairings ask at once', async () => {
    const platform = fakePlatform();
    const store = await openPairingStore(platform);
    const [a, b] = await Promise.all([store.identity(), store.identity()]);
    expect(a.agentId).toBe(b.agentId);
    expect(a.key.publicKey).toBe(b.key.publicKey);
    const file = JSON.parse(readFileSync(join(platform.paths.userData(), PAIRINGS_FILE), 'utf8')) as {
      agentId: string;
    };
    expect(file.agentId).toBe(a.agentId);
  });

  it("sees another process's pairings on refresh, and keeps them when it writes", async () => {
    const platform = fakePlatform();
    const here = await openPairingStore(platform);
    const { agentId } = await here.identity();
    const there = await openPairingStore(fakePlatform(undefined, platform.paths.userData()));
    const theirs = pairing();
    await there.add(theirs);
    expect(here.get(theirs.pairingId)).toBeUndefined();
    let changes = 0;
    here.onChange(() => {
      changes += 1;
    });
    await here.refresh();
    expect(here.get(theirs.pairingId)).toEqual(theirs);
    expect(changes).toBe(1);
    await here.refresh();
    expect(changes).toBe(1);

    // A write here starts from the file on disk, so it does not drop what the other process added since.
    const later = pairing();
    await there.add(later);
    const mine = pairing();
    await here.add(mine);
    expect(here.list().map((one) => one.pairingId)).toEqual([theirs.pairingId, later.pairingId, mine.pairingId]);

    await there.refresh();
    await there.remove(theirs.pairingId);
    await here.refresh();
    expect(here.get(theirs.pairingId)).toBeUndefined();
    expect((await there.identity()).agentId).toBe(agentId);
  });

  it('adopts the identity another process made first instead of making a second', async () => {
    const platform = fakePlatform();
    const here = await openPairingStore(platform);
    const there = await openPairingStore(fakePlatform(undefined, platform.paths.userData()));
    const theirs = await there.identity();
    expect((await here.identity()).agentId).toBe(theirs.agentId);
  });

  describe('across processes', () => {
    /** A store whose next write waits, holding the lock, until `release()`; `entered` resolves once it does. */
    async function holding(dir: string) {
      let gate: { entered: () => void; until: Promise<void> } | undefined;
      const store = await openPairingStore(fakePlatform(undefined, dir), {
        whileLocked: async () => {
          const held = gate;
          gate = undefined;
          if (held === undefined) return;
          held.entered();
          await held.until;
        },
      });
      const hold = () => {
        let entered: () => void = () => undefined;
        let release: () => void = () => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const until = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate = { entered, until };
        return { inside, release };
      };
      return { store, hold };
    }

    it('makes one identity and keeps both pairings when two stores write at the same moment', async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const a = await holding(dir);
      const b = await openPairingStore(fakePlatform(undefined, dir));

      const first = a.hold();
      const madeA = a.store.identity();
      await first.inside;
      const madeB = b.identity();
      await new Promise((resolve) => setTimeout(resolve, 50));
      first.release();
      const [ia, ib] = await Promise.all([madeA, madeB]);
      expect(ib.agentId).toBe(ia.agentId);
      expect(ib.key.publicKey).toBe(ia.key.publicKey);

      const one = pairing();
      const two = pairing();
      const second = a.hold();
      const addA = a.store.add(one);
      await second.inside;
      const addB = b.add(two);
      await new Promise((resolve) => setTimeout(resolve, 50));
      second.release();
      await Promise.all([addA, addB]);

      const reread = await openPairingStore(fakePlatform(undefined, dir));
      expect(
        reread
          .list()
          .map((row) => row.pairingId)
          .sort(),
      ).toEqual([one.pairingId, two.pairingId].sort());
      expect((await reread.identity()).agentId).toBe(ia.agentId);
      expect(existsSync(join(dir, `${PAIRINGS_FILE}.lock`))).toBe(false);
    });

    it('takes over a stale lock, and gives up on a live one past its timeout', async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const lockFile = join(dir, `${PAIRINGS_FILE}.lock`);
      const store = await openPairingStore(platform, { lockTimeoutMs: 100 });
      writeFileSync(lockFile, '');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile, old, old);
      await store.identity();
      expect(existsSync(lockFile)).toBe(false);

      writeFileSync(lockFile, '');
      await expect(store.add(pairing())).rejects.toThrow(/being written by another Wirebench process/);
      expect(store.list()).toEqual([]);
    });

    it('starts over with a new identity when the file is deleted while it runs', async () => {
      const platform = fakePlatform();
      const store = await openPairingStore(platform);
      const before = await store.identity();
      await store.add(pairing());
      unlinkSync(join(platform.paths.userData(), PAIRINGS_FILE));
      await store.refresh();
      expect(store.list()).toEqual([]);
      const after = await store.identity();
      expect(after.agentId).not.toBe(before.agentId);
      const next = pairing();
      await store.add(next);
      expect(store.list()).toEqual([next]);
    });

    it('reports a broken file on refresh once per change, keeping the pairings it had', async () => {
      const platform = fakePlatform();
      const store = await openPairingStore(platform);
      await store.identity();
      const kept = pairing();
      await store.add(kept);
      const path = join(platform.paths.userData(), PAIRINGS_FILE);
      writeFileSync(path, 'broken');
      await expect(store.refresh()).rejects.toThrow(/not a pairings file/);
      await expect(store.refresh()).resolves.toBeUndefined();
      expect(store.list()).toEqual([kept]);
      writeFileSync(path, 'broken again');
      await expect(store.refresh()).rejects.toThrow(/not a pairings file/);
      // A write never takes the broken file as empty.
      await expect(store.add(pairing())).rejects.toThrow(/not a pairings file/);
    });
    /** A one-shot gate: `wait()` blocks until `open()`, and `reached` resolves once something waits. */
    function gate() {
      let reach: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        reached,
        open: release,
        wait: () => {
          reach();
          return until;
        },
      };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

    function staleLock(dir: string): string {
      const lockFile = join(dir, `${PAIRINGS_FILE}.lock`);
      writeFileSync(lockFile, 'dead:holder');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile, old, old);
      return lockFile;
    }

    it('lets one of two takers of the same stale lock in at a time', async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const seed = await openPairingStore(platform);
      await seed.identity();
      staleLock(dir);

      let inside = 0;
      let most = 0;
      const takeA = gate();
      const takeB = gate();
      const holdA = gate();
      const enter = async (hold?: () => Promise<void>) => {
        inside += 1;
        most = Math.max(most, inside);
        await hold?.();
        inside -= 1;
      };
      let aHeld = false;
      const a = await openPairingStore(fakePlatform(undefined, dir), {
        beforeTakeover: () => takeA.wait(),
        whileLocked: () => {
          aHeld = true;
          return enter(holdA.wait);
        },
      });
      let bTook = false;
      const b = await openPairingStore(fakePlatform(undefined, dir), {
        beforeTakeover: () => {
          bTook = true;
          return takeB.wait();
        },
        whileLocked: () => enter(),
      });
      const one = pairing();
      const two = pairing();
      const addA = a.add(one);
      const addB = b.add(two);
      // Both judged the same lock stale and wait to rename it.
      await Promise.all([takeA.reached, takeB.reached]);
      takeA.open();
      await holdA.reached;
      expect(aHeld).toBe(true);
      // B acts on its old judgement now: it must not get in beside A.
      takeB.open();
      await settle();
      expect(inside).toBe(1);
      holdA.open();
      await Promise.all([addA, addB]);
      expect(bTook).toBe(true);
      expect(most).toBe(1);
      const reread = await openPairingStore(fakePlatform(undefined, dir));
      expect(
        reread
          .list()
          .map((row) => row.pairingId)
          .sort(),
      ).toEqual([one.pairingId, two.pairingId].sort());
      expect(readdirSync(dir).filter((name) => name.includes('.lock'))).toEqual([]);
    });

    it("leaves its successor's lock in place when it was taken over while it ran", async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const lockFile = join(dir, `${PAIRINGS_FILE}.lock`);
      const seed = await openPairingStore(platform);
      await seed.identity();

      const holdA = gate();
      const a = await openPairingStore(fakePlatform(undefined, dir), { whileLocked: () => holdA.wait() });
      const holdB = gate();
      const b = await openPairingStore(fakePlatform(undefined, dir), { whileLocked: () => holdB.wait() });

      const addA = a.add(pairing());
      await holdA.reached;
      const aToken = readFileSync(lockFile, 'utf8');
      // A has run past the stale age: B takes over.
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile, old, old);
      const addB = b.add(pairing());
      await holdB.reached;
      const bToken = readFileSync(lockFile, 'utf8');
      expect(bToken).not.toBe(aToken);
      expect(bToken).toMatch(new RegExp(`^${String(process.pid)}:`));

      holdA.open();
      await addA;
      expect(readFileSync(lockFile, 'utf8')).toBe(bToken);
      holdB.open();
      await addB;
      expect(existsSync(lockFile)).toBe(false);
    });

    it('puts back a live lock that reused the inode of the stale one it judged', async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const seed = await openPairingStore(platform);
      await seed.identity();
      const lockFile = staleLock(dir);
      const judged = statSync(lockFile);

      let inside = 0;
      let most = 0;
      const enter = async (hold?: () => Promise<void>) => {
        inside += 1;
        most = Math.max(most, inside);
        await hold?.();
        inside -= 1;
      };
      const takeA = gate();
      const takeB = gate();
      const holdA = gate();
      const a = await openPairingStore(fakePlatform(undefined, dir), {
        beforeTakeover: () => takeA.wait(),
        whileLocked: () => enter(holdA.wait),
      });
      const b = await openPairingStore(fakePlatform(undefined, dir), {
        beforeTakeover: () => takeB.wait(),
        whileLocked: () => enter(),
        lockIo: {
          // Whatever B moves aside reports the inode and mtime it judged stale, as a reused inode can.
          stat: async (at) => {
            await Promise.resolve();
            return at.includes('.stale-')
              ? { dev: judged.dev, ino: judged.ino, mtimeMs: judged.mtimeMs }
              : statSync(at);
          },
        },
      });
      const one = pairing();
      const two = pairing();
      const addA = a.add(one);
      const addB = b.add(two);
      await Promise.all([takeA.reached, takeB.reached]);
      takeA.open();
      await holdA.reached;
      const aToken = readFileSync(lockFile, 'utf8');
      takeB.open();
      await settle();
      expect(inside).toBe(1);
      expect(readFileSync(lockFile, 'utf8')).toBe(aToken);
      holdA.open();
      await Promise.all([addA, addB]);
      expect(most).toBe(1);
      const reread = await openPairingStore(fakePlatform(undefined, dir));
      expect(
        reread
          .list()
          .map((row) => row.pairingId)
          .sort(),
      ).toEqual([one.pairingId, two.pairingId].sort());
      expect(readdirSync(dir).filter((name) => name.includes('.lock'))).toEqual([]);
    });

    it("does not remove a successor's lock that replaced its own while it was releasing", async () => {
      const platform = fakePlatform();
      const dir = platform.paths.userData();
      const lockFile = join(dir, `${PAIRINGS_FILE}.lock`);
      const seed = await openPairingStore(platform);
      await seed.identity();

      const holdB = gate();
      const b = await openPairingStore(fakePlatform(undefined, dir), { whileLocked: () => holdB.wait() });
      let addB: Promise<void> | undefined;
      const holdA = gate();
      const a = await openPairingStore(fakePlatform(undefined, dir), {
        whileLocked: () => holdA.wait(),
        lockIo: {
          // A's release reads the lock; just then, past the stale age, B takes over and holds.
          read: async (at) => {
            const text = readFileSync(at, 'utf8');
            if (addB === undefined) {
              addB = b.add(pairing());
              await holdB.reached;
            }
            return text;
          },
        },
      });

      const addA = a.add(pairing());
      await holdA.reached;
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile, old, old);
      holdA.open();
      await addA;
      expect(addB).toBeDefined();
      const bToken = readFileSync(lockFile, 'utf8');
      expect(bToken).toMatch(new RegExp(`^${String(process.pid)}:`));
      holdB.open();
      await addB;
      expect(readdirSync(dir).filter((name) => name.includes('.lock'))).toEqual([]);
    });

    it('keeps the identity it knows when the file turns unreadable, saying so once', async () => {
      const platform = fakePlatform();
      const logs: string[] = [];
      const store = await openPairingStore(platform, { log: (message) => logs.push(message) });
      const known = await store.identity();
      writeFileSync(join(platform.paths.userData(), PAIRINGS_FILE), 'broken');
      expect((await store.identity()).agentId).toBe(known.agentId);
      expect((await store.identity()).agentId).toBe(known.agentId);
      expect(logs).toEqual(['the pairings file could not be read again']);
    });
  });
});
