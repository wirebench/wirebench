/**
 * What the shared limiter costs a sign-in (plan Task 8, hosted edition spec §20.7): `POST /auth/local/sign-in`
 * charges two buckets (the address and the email) before it checks the password. The median is printed; the budget is
 * loose, since a sign-in also runs scrypt and opens its own units.
 *
 * Runs with a database, and skips with `WIREBENCH_SKIP_PERF=1` as every perf suite does.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeDb } from '../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../helpers/identity.js';

const SKIP = process.env.WIREBENCH_SKIP_PERF === '1';
const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const PASSWORD = 'correct horse battery';
const WARM_UP = 5;
const SIGN_INS = 40;
/** A sign-in's median may not pass this: a regression, not a measurement. */
const BUDGET_MS = 250;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describeDb('a sign-in through the limiter (plan Task 8 perf)', () => {
  let h: IdentityHarness;
  beforeAll(async () => {
    if (SKIP) return;
    h = await identityHarness();
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
  });
  afterAll(async () => {
    if (!SKIP) await h.close();
  });

  const signIns = async (count: number): Promise<number[]> => {
    const times: number[] = [];
    for (let n = 0; n < count; n++) {
      // A minute apart on the harness clock, so neither the address's nor the email's bucket runs dry.
      h.clock.advance(60_000);
      const started = performance.now();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/local/sign-in',
        payload: { email: 'alice@example.com', password: PASSWORD, device: { name: 'Perf' } },
        remoteAddress: '10.0.0.1',
      });
      times.push(performance.now() - started);
      expect(res.statusCode).toBe(201);
    }
    return times;
  };

  it.skipIf(SKIP)('the limiter adds little to a sign-in', async () => {
    await signIns(WARM_UP);
    const taken = median(await signIns(SIGN_INS));
    say(`[perf] limiter: sign-in median ${taken.toFixed(1)} ms (${String(SIGN_INS)} sign-ins)`);
    expect(taken).toBeLessThan(BUDGET_MS);
  });
});
