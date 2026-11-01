/**
 * Seals committed audit rows into the keyed chain (issue #210, audit-chain spec §3.2). Each pass is one
 * transaction: it takes the chain's advisory lock, reads (or creates) the anchor, checks the key and the anchor's MAC, then
 * claims up to a batch of unsealed rows in `(at, id)` order and links each to the head. Rows another
 * transaction has not committed are invisible to the claim, so only committed rows are ever sealed.
 * Inserts never touch the lock, so no audited action waits on a pass.
 *
 * The loop has the forwarder's shape: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and waits for a pass under way, and `runOnce` is one pass, which tests drive directly.
 *
 * One chain per tenant (hosted edition spec §19.7, §19.8 guard 6): a pass goes through the job loop and seals
 * each tenant's rows under that tenant's lock and key, in a savepoint of the tenant's unit, so a failure rolls
 * back only that tenant's batch. What is logged once (a failure, a refused key or anchor) is remembered per
 * tenant, and each line names the tenant. The next pass comes after the shortest of the tenants' delays.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SetTimer } from '../../hooks/env.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import {
  chainHead,
  claimUnsealed,
  insertGenesis,
  readAnchor,
  sealRows,
  setAnchorHead,
  type ChainLink,
  type RowSeal,
} from '../repo.js';
import { anchorMacValid, keyId, link } from './canonical.js';
import type { ChainKeys } from './keys.js';
import { tryLockChain } from './lock.js';

/** The sealer's name in the job loop's log lines. */
export const SEALER_JOB = 'audit-sealer';

export const SEAL_BATCH = 500;
/** The next pass after one that sealed a full batch: a backlog is drained without waiting. */
export const SEAL_BACKLOG_MS = 0;
/** The next pass after one that sealed a partial batch. */
export const SEAL_BUSY_MS = 2_000;
/** The next pass when nothing was unsealed, the chain lock was held (another pass or a retention batch), the key was refused, or the anchor failed its MAC check. */
export const SEAL_IDLE_MS = 5_000;
/** The first wait after a failure; it doubles up to {@link SEAL_BACKOFF_MAX_MS}. */
export const SEAL_BACKOFF_MIN_MS = 5_000;
export const SEAL_BACKOFF_MAX_MS = 300_000;

export interface SealerDeps {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  /**
   * Each tenant's key, from `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` (`keys.ts`). It stays in this process: never
   * logged, never sent to the database.
   */
  readonly keys: ChainKeys;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production seals {@link SEAL_BATCH} at a time. */
  readonly batchSize?: number;
}

export type SealOutcome = 'sealed' | 'idle' | 'busy-elsewhere' | 'wrong-key' | 'bad-anchor' | 'failed' | 'stopped';

export interface SealPass {
  /** With one tenant, its outcome; with several, the most telling of theirs (`sealed` first, then `failed`…). */
  readonly outcome: SealOutcome;
  /** Rows sealed in this pass, in every tenant. */
  readonly sealed: number;
  /** When the loop passes next, the shortest of the tenants' delays; 0 once stopped. */
  readonly nextDelayMs: number;
}

/** What one tenant's chain remembers between passes, so each refusal or failure is logged once. */
interface TenantState {
  failures: number;
  /** The anchor key id last refused. */
  refusedKeyId: string | undefined;
  /** The anchor state last refused for a failing MAC. */
  refusedAnchor: string | undefined;
}

/** Which outcome a pass over several tenants reports: the first of these any tenant had. */
const OUTCOME_ORDER: readonly SealOutcome[] = ['sealed', 'failed', 'wrong-key', 'bad-anchor', 'busy-elsewhere', 'idle'];

type Sealing =
  | { readonly kind: 'busy-elsewhere' }
  | { readonly kind: 'wrong-key'; readonly chainKeyId: string }
  /**
   * `state` names the anchor's stored fields, so one state is logged once. `anchorSeq` is null when the
   * anchor is gone while rows are sealed: a genesis is never re-created over them.
   */
  | { readonly kind: 'bad-anchor'; readonly anchorSeq: bigint | null; readonly state: string }
  | { readonly kind: 'sealed'; readonly sealed: number; readonly full: boolean; readonly head: ChainLink };

export class AuditSealer {
  private timer: { cancel(): void } | undefined;
  private running: Promise<SealPass> | undefined;
  private stopped = false;
  /** Passes whose job loop could not run at all (the tenant list unreadable). */
  private failures = 0;
  private readonly states = new Map<string, TenantState>();

  constructor(private readonly deps: SealerDeps) {}

  /** Passes now, then again after each pass's `nextDelayMs`. */
  start(): void {
    this.tick();
  }

  /** One pass. A pass under way is returned, not doubled. */
  runOnce(): Promise<SealPass> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Cancels the timer and waits for a pass under way, which commits its batch. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private tick(): void {
    if (this.stopped) return;
    void this.runOnce()
      .then(
        (pass) => {
          this.arm(pass.nextDelayMs);
        },
        (error: unknown) => {
          // A pass handles its own failures; this is the last guard so nothing can end the loop.
          this.arm(SEAL_BACKOFF_MIN_MS);
          this.deps.log.error({ reason: reasonOf(error) }, 'audit chain pass failed unexpectedly');
        },
      )
      // The timer is already re-armed; only a throwing logger lands here.
      .catch(() => undefined);
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.tick();
    }, delayMs);
  }

  private async pass(): Promise<SealPass> {
    if (this.stopped) return { outcome: 'stopped', sealed: 0, nextDelayMs: 0 };
    const passes = new Map<string, SealPass>();
    // A unit that failed to commit sealed nothing, whatever its savepoint said. The job loop's error line is
    // taken here, so a failing tenant is logged once (below), not once per pass.
    const unitFailures = new Map<string, unknown>();
    const loopLog = {
      error: (fields: { readonly err?: unknown; readonly tenantId?: string }) => {
        if (fields.tenantId !== undefined) unitFailures.set(fields.tenantId, fields.err);
      },
    };
    try {
      await this.deps.tenancy.forEachTenant(
        SEALER_JOB,
        async (_tx, scope) => {
          const state = this.stateOf(scope.tenantId);
          const key = this.deps.keys(scope);
          let result: Sealing;
          try {
            result = await this.deps.tenancy.db(scope).transaction((tx) => this.seal(tx, key));
          } catch (error) {
            passes.set(scope.tenantId, this.failed(state, scope.tenantId, error));
            return;
          }
          passes.set(scope.tenantId, this.settled(state, scope.tenantId, result));
        },
        loopLog,
      );
    } catch (error) {
      // The job loop itself failed (the tenant list unreadable): one line, then back off.
      if (this.failures === 0) this.deps.log.warn({ reason: reasonOf(error) }, 'audit chain sealing failing');
      this.failures += 1;
      return { outcome: 'failed', sealed: 0, nextDelayMs: backoff(this.failures) };
    }
    if (this.failures > 0) this.deps.log.info({ failures: this.failures }, 'audit chain sealing recovered');
    this.failures = 0;
    for (const [tenantId, error] of unitFailures)
      passes.set(tenantId, this.failed(this.stateOf(tenantId), tenantId, error));
    if (passes.size === 0) return { outcome: 'idle', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
    const all = [...passes.values()];
    const outcome = OUTCOME_ORDER.find((candidate) => all.some((pass) => pass.outcome === candidate)) ?? 'idle';
    return {
      outcome,
      sealed: all.reduce((sum, pass) => sum + pass.sealed, 0),
      nextDelayMs: Math.min(...all.map((pass) => pass.nextDelayMs)),
    };
  }

  private stateOf(tenantId: string): TenantState {
    let state = this.states.get(tenantId);
    if (state === undefined) {
      state = { failures: 0, refusedKeyId: undefined, refusedAnchor: undefined };
      this.states.set(tenantId, state);
    }
    return state;
  }

  private failed(state: TenantState, tenantId: string, error: unknown): SealPass {
    // One line when sealing starts failing, never one per failure. Only the error's class and message.
    if (state.failures === 0) this.deps.log.warn({ tenantId, reason: reasonOf(error) }, 'audit chain sealing failing');
    state.failures += 1;
    return { outcome: 'failed', sealed: 0, nextDelayMs: backoff(state.failures) };
  }

  private settled(state: TenantState, tenantId: string, result: Sealing): SealPass {
    if (state.failures > 0) this.deps.log.info({ tenantId, failures: state.failures }, 'audit chain sealing recovered');
    state.failures = 0;
    switch (result.kind) {
      case 'busy-elsewhere':
        return { outcome: 'busy-elsewhere', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
      case 'wrong-key':
        // The anchor's key id only: it is a truncated hash, and the key itself is never logged.
        if (state.refusedKeyId !== result.chainKeyId) {
          this.deps.log.error(
            { tenantId, chainKeyId: result.chainKeyId },
            `audit chain key does not match the chain's key id ${result.chainKeyId}`,
          );
        }
        state.refusedKeyId = result.chainKeyId;
        return { outcome: 'wrong-key', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
      case 'bad-anchor':
        if (state.refusedAnchor !== result.state) {
          this.deps.log.error(
            { tenantId, anchorSeq: result.anchorSeq?.toString() ?? null },
            'audit chain anchor fails its check: run wirebench-server admin audit verify',
          );
        }
        state.refusedAnchor = result.state;
        return { outcome: 'bad-anchor', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
      case 'sealed':
        state.refusedKeyId = undefined;
        state.refusedAnchor = undefined;
        if (result.sealed === 0) return { outcome: 'idle', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
        this.deps.log.info(
          { tenantId, sealed: result.sealed },
          `audit chain sealed to ${result.head.seq.toString()}:${result.head.hash.toString('hex')}`,
        );
        return { outcome: 'sealed', sealed: result.sealed, nextDelayMs: result.full ? SEAL_BACKLOG_MS : SEAL_BUSY_MS };
    }
  }

  /** The pass's transaction: §3.2 steps 1 to 6; the caller's commit is step 7. */
  private async seal(tx: TenantQuerier, key: string): Promise<Sealing> {
    if (!(await tryLockChain(tx))) return { kind: 'busy-elsewhere' };
    let anchor = await readAnchor(tx);
    if (anchor === undefined) {
      // A genesis only starts a chain: over sealed rows it would re-sign whatever removed the anchor.
      if ((await chainHead(tx)) !== undefined) return { kind: 'bad-anchor', anchorSeq: null, state: 'missing' };
      anchor = await insertGenesis(tx, key);
    }
    // Before any row is touched: a wrong key must not extend the chain with links verify would reject.
    if (anchor.keyId !== keyId(key)) return { kind: 'wrong-key', chainKeyId: anchor.keyId };
    // Nor may an edited anchor (moved forward, or head_seq lowered) be re-signed by sealing past it.
    if (!anchorMacValid(key, anchor)) {
      const state = [anchor.seq, anchor.hash.toString('hex'), anchor.headSeq, anchor.mac.toString('hex')].join(':');
      return { kind: 'bad-anchor', anchorSeq: anchor.seq, state };
    }
    // Linked to the highest sealed row's hash, or the anchor's; numbered past `head_seq` too, so rows
    // removed from outside (the newest, or all of them) leave a gap verify reports, never a reused seq.
    const last: ChainLink = (await chainHead(tx)) ?? { seq: anchor.seq, hash: anchor.hash };
    let head: ChainLink = { seq: last.seq > anchor.headSeq ? last.seq : anchor.headSeq, hash: last.hash };
    const batch = this.deps.batchSize ?? SEAL_BATCH;
    const rows = await claimUnsealed(tx, batch);
    const seals: RowSeal[] = [];
    for (const row of rows) {
      /* c8 ignore next -- id is the primary key */
      if (row.id === null) throw new Error('an audit event has no id');
      const seq = head.seq + 1n;
      const hash = link(key, head.hash, seq, row);
      seals.push({ id: row.id, seq, hash });
      head = { seq, hash };
    }
    if (seals.length > 0) {
      await sealRows(tx, seals);
      await setAnchorHead(tx, key, anchor, head.seq);
    }
    return { kind: 'sealed', sealed: rows.length, full: rows.length >= batch, head };
  }
}

/** 5 s after the first failure, doubling, capped at 300 s. */
export function backoff(failures: number): number {
  return Math.min(SEAL_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), SEAL_BACKOFF_MAX_MS);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
