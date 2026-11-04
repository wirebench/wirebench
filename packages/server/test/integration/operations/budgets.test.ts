/**
 * Slice 5 Task 9 (hosted edition spec §20.7): the per-tenant send budgets. Two tenant databases on separate pools
 * stand for two instances. The 101st send of a burst is refused with its retry time; the 17th send at once is refused
 * on either instance; a dead instance's slots free themselves once they expire, and a live one's are renewed; a call
 * on the paired agent's path is never charged; and two tenants' budgets are apart.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { HostReplyFrame } from '../../../src/host/host-runtime.js';
import { SENDS_BUCKET, SendBudgets, sendsBucket, type SendBudgetSettings } from '../../../src/operations/budgets.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { tenantDbFactory, type TenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { collect, collectingMetrics, sweep } from '../../helpers/metrics.js';
import { BUDGET, OUTCOME, TENANT } from '../../../src/operations/metrics/attributes.js';
import { INSTRUMENTS } from '../../../src/operations/metrics/instruments.js';

const DEFAULTS: SendBudgetSettings = { sendsPerMinute: 600, concurrentSends: 16 };
const T0 = Date.parse('2026-11-04T12:00:00.000Z');
/** A renewal timer that never fires: the instance holding the slot has died. */
const dead = (): { cancel(): void } => ({ cancel: () => undefined });
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describeDb('the per-tenant send budgets (hosted spec §20.7)', () => {
  let db: TestDatabase;
  let second: Database;
  let a: TenantDbFactory;
  let b: TenantDbFactory;

  const tenant = async (): Promise<TenantScope> => {
    const id = randomUUID();
    const slug = `t-${id.slice(0, 8)}`;
    await db.owner.query('insert into tenants (id, slug, name) values ($1, $2, $3)', [id, slug, slug]);
    return scopeOf({ id, slug });
  };
  const slotsOf = async (scope: TenantScope): Promise<number> => {
    const { rows } = await a(scope).query<{ n: number }>(
      'select count(*)::int as n from send_slots where expires_at >= now()',
    );
    return rows[0]!.n;
  };

  beforeAll(async () => {
    db = await testDatabase();
    second = createDatabase(db.url);
    a = tenantDbFactory(db);
    b = tenantDbFactory(second);
  });
  afterAll(async () => {
    await second?.close();
    await db?.close();
  });

  it('defaults to 600 a minute with a burst of 100', () => {
    expect(sendsBucket(600)).toEqual({ capacity: 100, refillPerMs: 0.01 });
  });

  it('refuses the 101st send of a burst with its retry time, and leaves another tenant alone', async () => {
    const scope = await tenant();
    const other = await tenant();
    const budgets = new SendBudgets({ db: a, settings: DEFAULTS, now: () => T0 });
    for (let n = 0; n < 100; n++) {
      const taken = await budgets.take(scope);
      expect(taken.ok, `send ${String(n + 1)}`).toBe(true);
      if (taken.ok) await taken.release();
    }
    const refused = await budgets.take(scope);
    // One send's worth at 600 a minute: 100 ms.
    expect(refused).toEqual({
      ok: false,
      refusal: {
        code: 'tenant-send-budget',
        message: expect.stringContaining('Try again in 1 s') as string,
        retryAfterMs: 100,
      },
    });
    const elsewhere = await budgets.take(other);
    expect(elsewhere.ok).toBe(true);
    if (elsewhere.ok) await elsewhere.release();
  });

  it('refuses the 17th concurrent send on either instance', async () => {
    const scope = await tenant();
    const onA = new SendBudgets({ db: a, settings: DEFAULTS });
    const onB = new SendBudgets({ db: b, settings: DEFAULTS });
    const held = await Promise.all(Array.from({ length: 16 }, (_, n) => (n % 2 === 0 ? onA : onB).take(scope)));
    expect(held.every((taken) => taken.ok)).toBe(true);
    expect(await slotsOf(scope)).toBe(16);
    for (const budgets of [onA, onB]) {
      expect(await budgets.take(scope)).toMatchObject({
        ok: false,
        refusal: { code: 'tenant-send-concurrency', retryAfterMs: 1000 },
      });
    }
    // One send ends: its slot is free for the other instance.
    const first = held[0]!;
    if (first.ok) await first.release();
    const next = await onB.take(scope);
    expect(next.ok).toBe(true);
    for (const taken of [...held.slice(1), next]) if (taken.ok) await taken.release();
    expect(await slotsOf(scope)).toBe(0);
  });

  it('frees a dead instance’s slots once they expire, and keeps a live one’s renewed', async () => {
    const scope = await tenant();
    const settings = { ...DEFAULTS, concurrentSends: 2 };
    const crashed = new SendBudgets({ db: a, settings, holdMs: 400, setTimer: dead });
    const live = new SendBudgets({ db: b, settings, holdMs: 400 });
    // Taken and never freed or renewed: the instance died mid-send.
    expect((await crashed.take(scope)).ok).toBe(true);
    // Taken and held, renewed every 133 ms.
    const kept = await live.take(scope);
    expect(kept.ok).toBe(true);
    expect((await live.take(scope)).ok).toBe(false);
    await sleep(700);
    // The dead one's slot expired; the live one's is still held.
    const after = await live.take(scope);
    expect(after.ok).toBe(true);
    expect(await live.take(scope)).toMatchObject({ ok: false, refusal: { code: 'tenant-send-concurrency' } });
    for (const taken of [kept, after]) if (taken.ok) await taken.release();
  });

  it('charges send channels on the host socket and never the paired agent’s path', async () => {
    const scope = await tenant();
    // Six a minute: a burst of one.
    const budgets = new SendBudgets({ db: a, settings: { sendsPerMinute: 6, concurrentSends: 16 }, now: () => T0 });
    let served = 0;
    const serve = async (id: number): Promise<HostReplyFrame> => {
      served++;
      // The slot is held while the send runs.
      expect(await slotsOf(scope)).toBe(id >= 100 ? 1 : 0);
      return { id, ok: true, value: null };
    };
    // `request.route`, `request.bundle`, then `agent.send` on the agent, then the record of what it sent.
    for (const [id, channel] of [
      'request.route',
      'request.bundle',
      'exchanges.recordAgentSend',
      'exchanges.recordAgentFailure',
      'request.wsSend',
    ].entries()) {
      expect(await budgets.around(scope, { id, channel, request: {} }, () => serve(id))).toMatchObject({ ok: true });
    }
    expect(served).toBe(5);
    const { rows } = await a(scope).query('select key from limiter_buckets');
    expect(rows).toEqual([]);

    const sent = await budgets.around(scope, { id: 100, channel: 'request.sendRest', request: {} }, () => serve(100));
    expect(sent).toEqual({ id: 100, ok: true, value: null });
    expect(await slotsOf(scope)).toBe(0);
    const refused = await budgets.around(scope, { id: 101, channel: 'request.send', request: {} }, () => serve(101));
    expect(refused).toEqual({
      id: 101,
      ok: false,
      error: {
        code: 'tenant-send-budget',
        message: 'This team has sent too many requests in the last minute. Try again in 10 s.',
        details: { retryAfterMs: 10_000 },
      },
    });
    expect(served).toBe(6);
  });

  it('counts each charged send by outcome and each refusal by budget, in its tenant (spec §20.8)', async () => {
    const scope = await tenant();
    const { handle, reader } = await collectingMetrics(randomUUID());
    // A burst of one, and one slot.
    const budgets = new SendBudgets({
      db: a,
      settings: { sendsPerMinute: 6, concurrentSends: 1 },
      now: () => T0,
      metrics: handle.metrics,
    });
    const frame = (id: number) => ({ id, channel: 'request.send', request: {} });
    const failed = (id: number): Promise<HostReplyFrame> =>
      Promise.resolve({ id, ok: false, error: { code: 'send-failed', message: 'no route to host' } });
    // An uncharged channel counts nothing.
    await budgets.around(scope, { id: 0, channel: 'request.route', request: {} }, () => failed(0));
    // A send that could not be made, then the bucket is empty.
    await budgets.around(scope, frame(1), () => failed(1));
    await budgets.around(scope, frame(2), () => failed(2));
    // A slot held elsewhere: refused for concurrency.
    const held = await budgets.take(scope, { token: false });
    await budgets.around(scope, frame(3), () => failed(3));
    if (held.ok) await held.release();
    const { points } = await collect(reader);
    expect(sweep(points)).toEqual([]);
    const byOutcome = (points.get(INSTRUMENTS.sends) ?? []).map((p) => [
      p.attributes[TENANT],
      p.attributes[OUTCOME],
      p.value,
    ]);
    expect(byOutcome).toEqual([
      [scope.tenantId, 'failed', 1],
      [scope.tenantId, 'refused', 2],
    ]);
    const byBudget = (points.get(INSTRUMENTS.budgetRefusals) ?? []).map((p) => [p.attributes[BUDGET], p.value]);
    expect(byBudget).toEqual([
      ['sends', 1],
      ['concurrency', 1],
    ]);
    await handle.shutdown();
  });

  it('takes the slot first: a send refused for concurrency spends no token', async () => {
    const scope = await tenant();
    // Six a minute is a burst of one: a token spent by the refused send would leave the next one refused too.
    const budgets = new SendBudgets({ db: a, settings: { sendsPerMinute: 6, concurrentSends: 1 }, now: () => T0 });
    const held = await budgets.take(scope, { token: false });
    expect(held.ok).toBe(true);
    expect(await budgets.take(scope)).toMatchObject({ ok: false, refusal: { code: 'tenant-send-concurrency' } });
    if (held.ok) await held.release();
    const next = await budgets.take(scope);
    expect(next.ok).toBe(true);
    if (next.ok) await next.release();
    // Refused for the budget, the slot it took is given back.
    expect(await budgets.take(scope)).toMatchObject({ ok: false, refusal: { code: 'tenant-send-budget' } });
    expect(await slotsOf(scope)).toBe(0);
  });

  it('charges every request of a run, pausing it while the bucket is empty, under one slot', async () => {
    const scope = await tenant();
    // Sixty a minute: a burst of ten, then one a second.
    const budgets = new SendBudgets({ db: a, settings: { sendsPerMinute: 60, concurrentSends: 16 } });
    const live = { kind: 'rest', interactive: false, cancelled: () => false };
    const sent: number[] = [];
    // Outside any charged call the gate does nothing: a single send was charged as its call.
    expect(await budgets.gate(live)).toBeUndefined();
    const started = performance.now();
    for (const channel of ['runner.run', 'sequence.run', 'request.sendToEnvironments']) {
      const reply = await budgets.around(scope, { id: 1, channel, request: {} }, async () => {
        // One slot for the whole call, and no token for it.
        expect(await slotsOf(scope)).toBe(1);
        for (let n = 0; n < 4; n++) {
          await budgets.gate(live);
          sent.push(Math.round(performance.now() - started));
        }
        return { id: 1, ok: true, value: null };
      });
      expect(reply).toEqual({ id: 1, ok: true, value: null });
    }
    // Twelve requests: ten from the burst, then the run paused for the bucket instead of failing.
    expect(sent).toHaveLength(12);
    expect(sent[11]!).toBeGreaterThanOrEqual(1_500);
    expect(await slotsOf(scope)).toBe(0);
    // The single sends now find the bucket spent by the runs' requests.
    expect(await budgets.around(scope, { id: 2, channel: 'request.sendRest', request: {} }, () => ok(2))).toMatchObject(
      {
        ok: false,
        error: { code: 'tenant-send-budget' },
      },
    );
  });

  it('stops pacing a run on its cancel and on its socket’s close', async () => {
    const scope = await tenant();
    const budgets = new SendBudgets({ db: a, settings: { sendsPerMinute: 6, concurrentSends: 16 } });
    // Spends the burst of one.
    const first = await budgets.take(scope);
    if (first.ok) await first.release();
    let cancelled = false;
    const gone = new AbortController();
    const reply = budgets.around(
      scope,
      { id: 1, channel: 'runner.run', request: {} },
      async () => {
        const started = performance.now();
        setTimeout(() => {
          cancelled = true;
        }, 200);
        // The bucket refills in 10 s; the cancel ends the wait well before.
        expect(await budgets.gate({ kind: 'rest', interactive: false, cancelled: () => cancelled })).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(2_000);
        setTimeout(() => gone.abort(), 100);
        await expect(budgets.gate({ kind: 'rest', interactive: false, cancelled: () => false })).rejects.toMatchObject({
          code: 'cancelled',
        });
        return { id: 1, ok: true, value: null };
      },
      gone.signal,
    );
    expect(await reply).toEqual({ id: 1, ok: true, value: null });
  });

  it('a WebSocket open spends one token and holds a slot only while it opens: 17 open sessions block no send', async () => {
    const scope = await tenant();
    // A fixed clock: no refill between the opens, so the tokens left count them.
    const budgets = new SendBudgets({ db: a, settings: DEFAULTS, now: () => T0 });
    const ends: (() => void)[] = [];
    const opened: Promise<void>[] = [];
    const sessions = Array.from({ length: 17 }, (_, n) => {
      let open!: () => void;
      opened.push(
        new Promise<void>((resolve) => {
          open = resolve;
        }),
      );
      return budgets.around(scope, { id: n, channel: 'request.openWs', request: {} }, async () => {
        // The host's open: the gate answers what to tell once the handshake is done.
        const gate = await budgets.gate({ kind: 'websocket', interactive: true, cancelled: () => false });
        gate?.opened?.();
        open();
        // The call stays pending for the session's life.
        await new Promise<void>((resolve) => ends.push(resolve));
        return { id: n, ok: true, value: null };
      });
    });
    await Promise.all(opened);
    await vi.waitFor(async () => expect(await slotsOf(scope)).toBe(0));
    // An HTTP send goes while all 17 sessions stay open.
    expect(await budgets.around(scope, { id: 99, channel: 'request.sendRest', request: {} }, () => ok(99))).toEqual({
      id: 99,
      ok: true,
      value: null,
    });
    // Each open spent one token: 17 + 1 of the burst of 100.
    const { rows } = await a(scope).query<{ tokens: number }>('select tokens from limiter_buckets where key = $1', [
      SENDS_BUCKET,
    ]);
    expect(rows[0]!.tokens).toBe(82);
    for (const end of ends) end();
    await Promise.all(sessions);
  });
});

const ok = (id: number): Promise<HostReplyFrame> => Promise.resolve({ id, ok: true, value: null });
