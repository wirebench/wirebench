/**
 * The share audit rows are written after the route answers (the registry hands them off without waiting). The
 * module keeps the writes: `settled()` resolves only once each has committed, and the module's shutdown waits for
 * them, so a share's rows are neither lost at close nor missing for a reader that waits.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licenseInstallRecorded, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';
import { manualTimers } from '../../helpers/timers.js';

const keys = testKeys();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('terminal share audit writes', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let writes: PendingWrites;
  let base: string;
  let ada: Awaited<ReturnType<typeof signedInUser>>;
  let closed = false;

  beforeEach(async () => {
    const timers = manualTimers();
    closed = false;
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        terminalSharesModule({
          now: () => clock.now,
          setTimer: timers.setTimer,
          onAuditWrites: (made) => {
            writes = made;
          },
        }),
      ],
    });
    const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    ada = await signedInUser(h, { email: 'ada@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [ada] });
    const ws = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'Prod' })).body.id;
    base = `/workspaces/${ws}/terminal-shares`;
    expect(
      (await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) })).status,
    ).toBe(200);
    await licenseInstallRecorded(h);
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

  const startedRows = async (): Promise<number> =>
    Number(
      (
        await h.tdb.query<{ n: string }>(
          "select count(*)::text as n from audit_events where action = 'terminal_share.started'",
        )
      ).rows[0]!.n,
    );

  it('settled() waits for the started row the route answered before', async () => {
    const block = await blockAudit();
    try {
      const res = await call(h, ada, 'POST', base, { hostName: 'web', cols: 80, rows: 24 });
      expect(res.status).toBe(201);
      let done = false;
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
    expect(await startedRows()).toBe(1);
  });

  it("shutdown waits for the shares' audit rows, and none is lost", async () => {
    expect((await call(h, ada, 'POST', base, { hostName: 'web', cols: 80, rows: 24 })).status).toBe(201);
    await writes.settled();
    const block = await blockAudit();
    let closedApp = false;
    // closeAll ends the share, which audits terminal_share.ended; the app must not finish closing before it lands.
    const closing = h.app.close().then(() => {
      closedApp = true;
    });
    await tick();
    expect(closedApp).toBe(false);
    await block.release();
    await closing;
    const ended = await h.tdb.query<{ n: string }>(
      "select count(*)::text as n from audit_events where action = 'terminal_share.ended'",
    );
    expect(ended.rows[0]!.n).toBe('1');
    closed = true;
    await h.close();
  });
});
