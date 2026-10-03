/**
 * Seals committed audit rows into the keyed chain (issue #210, audit-chain spec §3.2). Each pass is one
 * transaction: it takes the chain's advisory lock, reads (or creates) the anchor, checks the key, then
 * claims up to a batch of unsealed rows in `(at, id)` order and links each to the head. Rows another
 * transaction has not committed are invisible to the claim, so only committed rows are ever sealed.
 * Inserts never touch the lock, so no audited action waits on a pass.
 *
 * The loop has the forwarder's shape: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and waits for a pass under way, and `runOnce` is one pass, which tests drive directly.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Querier } from '../../context.js';
import type { SetTimer } from '../../hooks/env.js';
import { chainHead, claimUnsealed, insertGenesis, readAnchor, sealRow, type ChainLink } from '../repo.js';
import { genesisHash, keyId, link } from './canonical.js';

export const SEAL_BATCH = 500;
/** The next pass while the last one sealed something. */
export const SEAL_BUSY_MS = 2_000;
/** The next pass when nothing was unsealed, another instance held the lock, or the key was refused. */
export const SEAL_IDLE_MS = 5_000;
/** The first wait after a failure; it doubles up to {@link SEAL_BACKOFF_MAX_MS}. */
export const SEAL_BACKOFF_MIN_MS = 5_000;
export const SEAL_BACKOFF_MAX_MS = 300_000;
/**
 * The transaction-scoped advisory lock every sealer takes first (the ASCII of "wbaudcha"). Only sealers
 * take it, so it serialises passes across server instances and nothing else.
 */
export const AUDIT_CHAIN_LOCK_ID = 0x7762617564636861n;

export interface SealerDeps {
  readonly db: Database;
  /** `WIREBENCH_SERVER_AUDIT_CHAIN_KEY`. It stays in this process: never logged, never sent to the database. */
  readonly key: string;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production seals {@link SEAL_BATCH} at a time. */
  readonly batchSize?: number;
}

export type SealOutcome = 'sealed' | 'idle' | 'busy-elsewhere' | 'wrong-key' | 'failed' | 'stopped';

export interface SealPass {
  readonly outcome: SealOutcome;
  /** Rows sealed in this pass. */
  readonly sealed: number;
  /** When the loop passes next; 0 once stopped. */
  readonly nextDelayMs: number;
}

type Sealing =
  | { readonly kind: 'busy-elsewhere' }
  | { readonly kind: 'wrong-key'; readonly chainKeyId: string }
  | { readonly kind: 'sealed'; readonly sealed: number; readonly head: ChainLink };

export class AuditSealer {
  private timer: { cancel(): void } | undefined;
  private running: Promise<SealPass> | undefined;
  private stopped = false;
  private failures = 0;
  /** The anchor key id last refused, so a refusal is logged once, not once per pass. */
  private refusedKeyId: string | undefined;
  private readonly keyId: string;

  constructor(private readonly deps: SealerDeps) {
    this.keyId = keyId(deps.key);
  }

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
    let result: Sealing;
    try {
      result = await this.deps.db.transaction((tx) => this.seal(tx));
    } catch (error) {
      // One line when sealing starts failing, never one per failure. Only the error's class and message.
      if (this.failures === 0) this.deps.log.warn({ reason: reasonOf(error) }, 'audit chain sealing failing');
      this.failures += 1;
      return { outcome: 'failed', sealed: 0, nextDelayMs: backoff(this.failures) };
    }
    if (this.failures > 0) this.deps.log.info({ failures: this.failures }, 'audit chain sealing recovered');
    this.failures = 0;
    switch (result.kind) {
      case 'busy-elsewhere':
        return { outcome: 'busy-elsewhere', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
      case 'wrong-key':
        // The anchor's key id only: it is a truncated hash, and the key itself is never logged.
        if (this.refusedKeyId !== result.chainKeyId) {
          this.deps.log.error(
            { chainKeyId: result.chainKeyId },
            `audit chain key does not match the chain's key id ${result.chainKeyId}`,
          );
        }
        this.refusedKeyId = result.chainKeyId;
        return { outcome: 'wrong-key', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
      case 'sealed':
        this.refusedKeyId = undefined;
        if (result.sealed === 0) return { outcome: 'idle', sealed: 0, nextDelayMs: SEAL_IDLE_MS };
        this.deps.log.info(
          { sealed: result.sealed },
          `audit chain sealed to ${result.head.seq.toString()}:${result.head.hash.toString('hex')}`,
        );
        return { outcome: 'sealed', sealed: result.sealed, nextDelayMs: SEAL_BUSY_MS };
    }
  }

  /** The pass's transaction: §3.2 steps 1 to 6; the caller's commit is step 7. */
  private async seal(tx: Querier): Promise<Sealing> {
    const lock = await tx.query<{ locked: boolean }>('select pg_try_advisory_xact_lock($1::bigint) as locked', [
      AUDIT_CHAIN_LOCK_ID.toString(),
    ]);
    if (lock.rows[0]?.locked !== true) return { kind: 'busy-elsewhere' };
    const anchor = (await readAnchor(tx)) ?? (await insertGenesis(tx, genesisHash(this.deps.key), this.keyId));
    // Before any row is touched: a wrong key must not extend the chain with links verify would reject.
    if (anchor.keyId !== this.keyId) return { kind: 'wrong-key', chainKeyId: anchor.keyId };
    let head: ChainLink = (await chainHead(tx)) ?? { seq: anchor.seq, hash: anchor.hash };
    const rows = await claimUnsealed(tx, this.deps.batchSize ?? SEAL_BATCH);
    for (const row of rows) {
      /* c8 ignore next -- id is the primary key */
      if (row.id === null) throw new Error('an audit event has no id');
      const seq = head.seq + 1n;
      const hash = link(this.deps.key, head.hash, seq, row);
      await sealRow(tx, row.id, seq, hash);
      head = { seq, hash };
    }
    return { kind: 'sealed', sealed: rows.length, head };
  }
}

/** 5 s after the first failure, doubling, capped at 300 s. */
export function backoff(failures: number): number {
  return Math.min(SEAL_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), SEAL_BACKOFF_MAX_MS);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
