/**
 * `license.installed` and `license.removed` are written after the license route answers, from its announcement.
 * The audit-log module keeps those writes: `settled()` resolves only once each has committed, and its shutdown
 * waits for them, so the row is neither lost at close nor missing for a reader that waits.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const keys = testKeys();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('license change audit writes', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let writes: PendingWrites;
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let closed = false;

  beforeEach(async () => {
    closed = false;
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({
          now: () => clock.now,
          onLicenseWrites: (made) => {
            writes = made;
          },
        }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  });
  afterEach(async () => {
    if (!closed) await h.close();
  });

  /** Holds every insert into audit_events until `release`. */
  async function blockAudit() {
    const blocker = createDatabase(h.db.ownerUrl, { max: 1 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unit = blocker.transaction(async (tx) => {
      await tx.query('lock table audit_events in exclusive mode');
      locked();
      await held;
    });
    await isLocked;
    return {
      release: async () => {
        release();
        await unit;
        await blocker.close();
      },
    };
  }

  const rows = async (action: string): Promise<string> =>
    (await h.tdb.query<{ n: string }>('select count(*)::text as n from audit_events where action = $1', [action]))
      .rows[0]!.n;

  it('settled() waits for the license.installed row the route answered before', async () => {
    const block = await blockAudit();
    let done = false;
    try {
      const put = await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
      expect(put.status).toBe(200);
      const settling = writes.settled().then(() => {
        done = true;
      });
      await tick();
      expect(done).toBe(false);
      await block.release();
      await settling;
    } catch (error) {
      await block.release();
      throw error;
    }
    expect(await rows('license.installed')).toBe('1');
  });

  it('shutdown waits for a license.removed row still being written', async () => {
    expect(
      (await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) })).status,
    ).toBe(200);
    await writes.settled();
    const block = await blockAudit();
    let closedApp = false;
    let closing: Promise<void> | undefined;
    try {
      expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
      closing = h.app.close().then(() => {
        closedApp = true;
      });
      await tick();
      expect(closedApp).toBe(false);
    } finally {
      await block.release();
    }
    await closing;
    expect(await rows('license.removed')).toBe('1');
    closed = true;
    await h.close();
  });
});
