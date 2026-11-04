/**
 * What the advisory repository lock costs a push (plan Task 7, hosted edition spec §20.4): the same push, one commit
 * of one file, through `POST …/sync/commits`, on a server whose repository store holds only the in-process queue
 * and on one whose store also takes the database lock. The figures are printed; the budget is loose, since the
 * lock adds two short statements on a pooled connection to work that runs git several times.
 *
 * Runs with a database, and skips with `WIREBENCH_SKIP_PERF=1` as every perf suite does.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SyncPushResponse } from '@wirebench/engine';
import { describeDb } from '../helpers/database.js';
import { syncFixture, type SyncFixture } from '../helpers/sync.js';
import { call } from '../helpers/teams.js';

const SKIP = process.env.WIREBENCH_SKIP_PERF === '1';
const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const WARM_UP = 5;
const PUSHES = 40;
/** The lock may add this much to a push's median before the suite fails: a regression, not a measurement. */
const BUDGET_MS = 25;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** `count` pushes one after another, each on the head the last one made; their times in ms. */
async function pushes(f: SyncFixture, count: number, from: { head: string | null }): Promise<number[]> {
  const times: number[] = [];
  for (let n = 0; n < count; n++) {
    const started = performance.now();
    const res = await call<SyncPushResponse>(f.h, f.editor, 'POST', `/workspaces/${f.workspaceId}/sync/commits`, {
      parent: from.head,
      commits: [
        {
          subject: `Push ${String(n)}`,
          at: '2026-09-24T12:00:00.000Z',
          changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: `n: ${String(n)}\n` }],
        },
      ],
    });
    times.push(performance.now() - started);
    expect(res.status).toBe(201);
    from.head = res.body.head;
  }
  return times;
}

async function measure(f: SyncFixture): Promise<number> {
  const from = { head: null as string | null };
  await pushes(f, WARM_UP, from);
  return median(await pushes(f, PUSHES, from));
}

describeDb('a push with and without the repository lock (plan Task 7 perf)', () => {
  let plain: SyncFixture;
  let locked: SyncFixture;
  beforeAll(async () => {
    if (SKIP) return;
    plain = await syncFixture();
    locked = await syncFixture({ repoLock: {} });
  });
  afterAll(async () => {
    if (SKIP) return;
    await plain.h.close();
    await locked.h.close();
  });

  it.skipIf(SKIP)('the lock adds little to a push', async () => {
    const without = await measure(plain);
    const with_ = await measure(locked);
    say(
      `[perf] repo lock: push median ${without.toFixed(1)} ms in-process only, ${with_.toFixed(1)} ms with the database lock (${PUSHES} pushes each)`,
    );
    expect(with_ - without).toBeLessThan(BUDGET_MS);
  });
});
