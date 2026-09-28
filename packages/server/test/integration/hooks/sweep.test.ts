import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/hooks/repo.js';
import { SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, newCapture, seedCatchUrl, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const DAY = 24 * 60 * 60 * 1000;

describeDb('the age sweep (§3.4)', () => {
  let h: HooksHarness;
  let hookId: string;
  beforeEach(async () => {
    h = await hooksHarness({ env: { WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '7' } });
    const team = await seedTeam(h, { name: 'Payments QA' });
    const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
    hookId = (await seedCatchUrl(h, workspaceId, 'Payments')).id;
  });
  afterEach(() => h.close());

  it('every ten minutes deletes what is strictly older than the maximum age, and keeps the boundary', async () => {
    const cutoff = new Date(h.clock.now.getTime() - 7 * DAY);
    const older = newCapture(hookId, { receivedAt: new Date(cutoff.getTime() - 1) });
    const boundary = newCapture(hookId, { receivedAt: cutoff });
    const fresh = newCapture(hookId, { receivedAt: h.clock.now });
    for (const capture of [older, boundary, fresh]) await repo.insertCapture(h.db, capture);
    expect(h.timers.fire(SWEEP_INTERVAL_MS)).toBe(1);
    await expect
      .poll(async () => (await repo.listCaptures(h.db, hookId, {}, 10)).map((c) => c.id))
      .toEqual([fresh.id, boundary.id]);
    h.clock.advance(1);
    expect(h.timers.fire(SWEEP_INTERVAL_MS)).toBe(1);
    await expect.poll(async () => (await repo.listCaptures(h.db, hookId, {}, 10)).map((c) => c.id)).toEqual([fresh.id]);
  });
});
