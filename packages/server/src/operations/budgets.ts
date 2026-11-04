/**
 * The per-tenant budgets (hosted edition spec §20.7, owner ruling 2), each shared by every instance through the
 * database, with the server-wide defaults of `WIREBENCH_SERVER_TENANT_*` (per-tenant overrides are slice 7's):
 *
 * - **Sends per minute.** One bucket per tenant in the shared limiter (`limiter.ts`), keyed {@link SENDS_BUCKET}:
 *   refilled at the per-minute rate, holding a sixth of it (100 at the default 600). A single send is refused with
 *   `tenant-send-budget` and the bucket's `retryAfterMs`.
 * - **Concurrent sends.** The tenant's numbered rows of `send_slots`, `0` to `N - 1`. A send takes a free one in
 *   one statement (`insert … on conflict do update … where expires_at < now`) and deletes it after; refused with
 *   `tenant-send-concurrency`. The slot is taken before the token, so a send refused for concurrency spends none.
 *   A slot lasts the host's default send deadline plus 30 s ({@link SLOT_HOLD_MS}) and is renewed while its call
 *   runs, so a long send or a run keeps it, and a crashed instance's slots free themselves within that time.
 * - **Runs** (owner ruling 2026-11-04). `runner.run`, `sequence.run` and `request.sendToEnvironments` hold one slot
 *   for the call, and every request inside spends a token as it goes out: the host asks {@link SendBudgets.gate}
 *   before each, inside the call's async context. An empty bucket pauses the run until it refills (the bucket's
 *   retry time, again and again), bounded by the run's own cancel and by its socket's close; it never fails it.
 * - **WebSocket sessions** (owner ruling 2026-11-04). `request.openWs` spends one token and holds a slot only while
 *   it opens: the host tells the gate when the handshake has opened the session, and the slot is freed then.
 * - **Run slots.** The scheduler's claim takes {@link lockRunSlots} and counts the tenant's `running` runs in the
 *   claiming transaction (`schedules/scheduler.ts`), so two instances cannot both claim the last slot.
 *
 * Every charged channel (`send-channels.ts`) called on a browser's host socket is charged here, in the user's
 * tenant. A refusal is the call's reply, as any failed send is: the tab shows its message, which names the retry
 * time.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ModuleConfig } from '../config.js';
import type { HostCallFrame, HostReplyFrame } from '../host/host-runtime.js';
import { realTimer } from '../live/module.js';
import { SERVER_SCHEMA } from '../tenancy/running-lock.js';
import type { TenantScope } from '../tenancy/scope.js';
import { outsideTenantUnit, type TenantDbFactory, type TenantQuerier } from '../tenancy/tenant-db.js';
import { WirebenchError } from '@wirebench/engine';
import type { HostSendGateRequest } from '../host/host-runtime.js';
import { charge, registerBucket, type BucketSize } from './limiter.js';
import { chargeOf, type SendCharge } from './send-channels.js';

/** The sends bucket's key in `limiter_buckets`: its own namespace beside the other limiters' `name/key`. */
export const SENDS_BUCKET = 'budget/sends';
/** The host's default send deadline (the `http.socketTimeoutMs` preference's default). */
export const SEND_DEADLINE_MS = 60_000;
/** A slot lasts the send's deadline plus this, so an instance that died mid-send frees its slots by then. */
export const SLOT_GRACE_MS = 30_000;
export const SLOT_HOLD_MS = SEND_DEADLINE_MS + SLOT_GRACE_MS;
/** A refused concurrent send's retry time: a slot frees whenever any of the tenant's sends ends. */
export const CONCURRENCY_RETRY_MS = 1_000;
/** The longest a paced run sleeps before it looks at its cancel again. */
export const PACE_POLL_MS = 1_000;
/** The advisory-lock class of a tenant's run-slot count; the schema and tenant hash is the other half. */
export const RUN_SLOTS_LOCK_CLASS = 0x57425253; // "WBRS"

export interface SendBudgetSettings {
  readonly sendsPerMinute: number;
  readonly concurrentSends: number;
}

export function sendBudgetSettings(config: ModuleConfig): SendBudgetSettings {
  return { sendsPerMinute: config.tenantSendsPerMinute, concurrentSends: config.tenantConcurrentSends };
}

/** The sends bucket: refilled at the per-minute rate, a sixth of a minute's sends at once (100 of 600). */
export function sendsBucket(perMinute: number): BucketSize {
  return { capacity: Math.max(1, Math.ceil(perMinute / 6)), refillPerMs: perMinute / 60_000 };
}

export type SendRefusalCode = 'tenant-send-budget' | 'tenant-send-concurrency';

export interface SendRefusal {
  readonly code: SendRefusalCode;
  readonly message: string;
  readonly retryAfterMs: number;
}

export type SendTake =
  { readonly ok: true; release(): Promise<void> } | { readonly ok: false; readonly refusal: SendRefusal };

/**
 * `$1` holder, `$2` the tenant's slot count, `$3` the hold in ms. `free` is the slots no live send holds; `pick` one
 * of them at random, so two sends at once rarely race for one. The upsert's update runs only on an expired row, so
 * `taken` is a row exactly when the slot was taken; a race lost to another send is no row with `free` above zero.
 */
const TAKE = `with free as (
  select n::smallint as slot from generate_series(0, $2::int - 1) n
  where not exists (select 1 from send_slots s where s.slot = n and s.expires_at >= statement_timestamp())
), pick as (
  select slot from free order by random() limit 1
), taken as (
  insert into send_slots as s (slot, holder, expires_at)
  select slot, $1::uuid, statement_timestamp() + $3::float8 * interval '1 millisecond' from pick
  on conflict (tenant_id, slot) do update set holder = excluded.holder, expires_at = excluded.expires_at
    where s.expires_at < statement_timestamp()
  returning s.slot
)
select (select slot from taken) as slot, (select count(*) from free)::int as free`;

const RENEW = `update send_slots set expires_at = statement_timestamp() + $3::float8 * interval '1 millisecond'
  where slot = $1 and holder = $2::uuid`;
const FREE = 'delete from send_slots where slot = $1 and holder = $2::uuid';

const LOCK_RUN_SLOTS = `select pg_advisory_xact_lock($1, hashtext((${SERVER_SCHEMA}) || ':' || $2))`;

/**
 * Serialises the run-slot count of `tx`'s tenant until `tx` ends: every instance's claim in that tenant waits here,
 * so the count it reads next is the one it claims against.
 */
export async function lockRunSlots(tx: TenantQuerier): Promise<void> {
  await tx.query(LOCK_RUN_SLOTS, [RUN_SLOTS_LOCK_CLASS, tx.scope.tenantId]);
}

export interface SendBudgetsOptions {
  readonly db: TenantDbFactory;
  readonly settings: SendBudgetSettings;
  /** How long a slot lasts unrenewed; {@link SLOT_HOLD_MS} by default. Tests shorten it. */
  readonly holdMs?: number;
  /** The renewal timer; a test's that never fires stands for an instance that died. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /** Test only: the sends bucket's clock (the database's otherwise). */
  readonly now?: () => number;
  readonly log?: (message: string, error: unknown) => void;
}

/** The call a gate runs inside: what its requests are charged to. */
interface Call {
  readonly scope: TenantScope;
  readonly charge: SendCharge;
  /** Aborted when the call's socket closes: a paced run stops waiting. */
  readonly signal: AbortSignal | undefined;
  /** Frees the call's slot early: a WebSocket session that has opened. */
  readonly release: () => Promise<void>;
}

const stopped = (): WirebenchError =>
  new WirebenchError('cancelled', 'The run stopped while it waited for its team’s send budget.');

/** Sleeps `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });
}

const seconds = (ms: number): string => String(Math.max(1, Math.ceil(ms / 1000)));

export class SendBudgets {
  private readonly holdMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** The charged call the code running now belongs to, for {@link gate}. */
  private readonly calls = new AsyncLocalStorage<Call>();

  constructor(private readonly options: SendBudgetsOptions) {
    this.holdMs = options.holdMs ?? SLOT_HOLD_MS;
    this.setTimer = options.setTimer ?? realTimer;
    registerBucket(sendsBucket(options.settings.sendsPerMinute));
  }

  /**
   * Charges one send to `scope`'s tenant: a slot, which `release` frees, then the sends bucket. A refusal for
   * concurrency spends no token; a refusal for the budget gives the slot back. `token: false` takes the slot alone
   * (a run, whose requests spend their tokens one by one).
   */
  async take(scope: TenantScope, options: { readonly token?: boolean } = {}): Promise<SendTake> {
    const { settings } = this.options;
    const db = this.options.db(scope);
    const holder = randomUUID();
    let release: (() => Promise<void>) | undefined;
    // Each lost race means another send took a slot, so after `concurrentSends` of them none is free.
    for (let attempt = 0; attempt < settings.concurrentSends && release === undefined; attempt++) {
      const { rows } = await outsideTenantUnit(() =>
        db.query<{ slot: number | null; free: number }>(TAKE, [holder, settings.concurrentSends, this.holdMs]),
      );
      const row = rows[0]!;
      if (row.slot !== null) release = this.holding(db, row.slot, holder);
      else if (row.free === 0) break;
    }
    if (release === undefined) {
      return {
        ok: false,
        refusal: {
          code: 'tenant-send-concurrency',
          message: `This team already has ${String(settings.concurrentSends)} requests sending. Try again when one finishes.`,
          retryAfterMs: CONCURRENCY_RETRY_MS,
        },
      };
    }
    if (options.token === false) return { ok: true, release };
    let spent;
    try {
      spent = await this.spend(scope);
    } catch (error) {
      await release();
      throw error;
    }
    if (!spent.ok) {
      await release();
      return {
        ok: false,
        refusal: {
          code: 'tenant-send-budget',
          message: `This team has sent too many requests in the last minute. Try again in ${seconds(spent.retryAfterMs)} s.`,
          retryAfterMs: spent.retryAfterMs,
        },
      };
    }
    return { ok: true, release };
  }

  /**
   * Serves `frame` through `serve`, charged as its channel says (`chargeOf`): a refusal answers the call instead.
   * `signal` is the socket's: aborted when it closes, so a paced run stops waiting. Never rejects, as the host's
   * `serve` never does.
   */
  async around(
    scope: TenantScope,
    frame: HostCallFrame,
    serve: () => Promise<HostReplyFrame>,
    signal?: AbortSignal,
  ): Promise<HostReplyFrame> {
    const charged = chargeOf(frame.channel, frame.request);
    if (charged === undefined) return serve();
    let taken: SendTake;
    try {
      taken = await this.take(scope, { token: charged !== 'run' });
    } catch (error) {
      this.options.log?.('a send could not be charged to its tenant’s budgets', error);
      return {
        id: frame.id,
        ok: false,
        error: { code: 'internal-error', message: 'The send could not be started. Try again in a moment.' },
      };
    }
    if (!taken.ok) {
      const { code, message, retryAfterMs } = taken.refusal;
      return { id: frame.id, ok: false, error: { code, message, details: { retryAfterMs } } };
    }
    try {
      return await this.calls.run({ scope, charge: charged, signal, release: () => taken.release() }, serve);
    } finally {
      await taken.release();
    }
  }

  /**
   * The host's `sendGate`: asked before each request the host puts on the wire. Inside a run's call it spends that
   * request's token, waiting while the bucket is empty; inside a WebSocket open it answers the `opened` that frees
   * the call's slot. Anywhere else (a single send, charged as its call) it does nothing.
   *
   * @throws WirebenchError `cancelled` when the run's socket closed while it waited; `internal-error` when the
   *   budget could not be read. The request fails as one that could not start.
   */
  async gate(send: HostSendGateRequest): Promise<{ readonly opened?: () => void } | undefined> {
    const call = this.calls.getStore();
    if (call === undefined) return undefined;
    if (call.charge === 'session') {
      return send.interactive
        ? {
            opened: () => {
              void call.release();
            },
          }
        : undefined;
    }
    if (call.charge !== 'run') return undefined;
    for (;;) {
      // Cancelled meanwhile: no token, and the host cancels the send before the wire.
      if (send.cancelled()) return undefined;
      if (call.signal?.aborted === true) throw stopped();
      let spent;
      try {
        spent = await this.spend(call.scope);
      } catch (error) {
        this.options.log?.('a run’s request could not be charged to its tenant’s budget', error);
        throw new WirebenchError('internal-error', 'The send could not be started. Try again in a moment.');
      }
      if (spent.ok) return undefined;
      await pause(Math.min(spent.retryAfterMs, PACE_POLL_MS), call.signal);
    }
  }

  /** One token of the tenant's sends bucket. */
  private spend(scope: TenantScope) {
    const { settings } = this.options;
    const db = this.options.db(scope);
    return outsideTenantUnit(() =>
      charge(db, SENDS_BUCKET, {
        ...sendsBucket(settings.sendsPerMinute),
        cost: 1,
        ...(this.options.now !== undefined ? { at: new Date(this.options.now()) } : {}),
      }),
    );
  }

  /** Keeps `slot` renewed until the returned `release` frees it. */
  private holding(db: TenantQuerier, slot: number, holder: string): () => Promise<void> {
    let timer: { cancel(): void } | undefined;
    let released = false;
    const renew = (): void => {
      timer = this.setTimer(
        () => {
          if (released) return;
          void outsideTenantUnit(() => db.query(RENEW, [slot, holder, this.holdMs]))
            .catch((error: unknown) => {
              this.options.log?.('a send slot could not be renewed', error);
            })
            .finally(() => {
              if (!released) renew();
            });
        },
        Math.floor(this.holdMs / 3),
      );
    };
    renew();
    return async () => {
      if (released) return;
      released = true;
      timer?.cancel();
      // A slot that cannot be freed expires on its own.
      await outsideTenantUnit(() => db.query(FREE, [slot, holder])).catch((error: unknown) => {
        this.options.log?.('a send slot could not be freed', error);
      });
    };
  }
}
