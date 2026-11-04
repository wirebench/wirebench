/**
 * The control loop (hosted edition spec §22.15): one per instance, a pass every {@link CONTROL_LOOP_MS}, each pass
 * one control transaction under `pg_try_advisory_xact_lock(CONTROL_LOOP_CLASS, hashtext(SERVER_SCHEMA))`, so one
 * instance runs it at a time and another that finds it held skips its turn.
 *
 * A pass runs its {@link LoopStep}s in order, each under a savepoint, and each tenant a step visits under one more
 * (`each`): a failure is logged with the step and the tenant id and rolled back to its savepoint, and the others go
 * on. What must not happen before the commit (an audit row on the app role, the directory's change, a mail) is
 * queued with `afterCommit` and runs once the pass committed; a failed step's or tenant's queue is dropped with it.
 *
 * Later parts add their steps to the list the module builds (signups' expiry, exports, deletions, redirects).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SetTimer } from '../hooks/env.js';
import { realTimer } from '../live/module.js';
import { LOCK_SCHEMA_KEY } from '../tenancy/running-lock.js';
import type { ControlDb } from './control-db.js';
import type { ControlTx } from './slugs.js';

/** The pass's lock class ("WBCL"), beside the server's other advisory-lock classes. */
export const CONTROL_LOOP_CLASS = 0x5742434c;

/** Held until the pass's transaction ends; `ok` is false when another instance holds it. */
export const CONTROL_LOOP_LOCK = `select pg_try_advisory_xact_lock(${String(CONTROL_LOOP_CLASS)}, ${LOCK_SCHEMA_KEY}) as ok`;

export const CONTROL_LOOP_MS = 60_000;

/** What a step is handed for one pass. */
export interface LoopStepContext {
  /** The pass's control transaction, which holds the loop lock. */
  readonly tx: ControlTx;
  /** The pass's one time: every step judges by it. */
  readonly now: Date;
  /**
   * `fn` for one tenant, under a savepoint: a failure is logged with the step and `tenantId`, undone, and the step
   * goes on to the next.
   */
  readonly each: (tenantId: string, fn: () => Promise<void>) => Promise<void>;
  /** Runs `fn` once the pass committed; a failure is logged with the step and `tenantId`. */
  readonly afterCommit: (fn: () => Promise<void>, tenantId?: string) => void;
}

export interface LoopStep {
  /** In the log line of a failure. */
  readonly name: string;
  run(context: LoopStepContext): Promise<void>;
}

export interface ControlLoopOptions {
  readonly control: ControlDb;
  readonly steps: readonly LoopStep[];
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  readonly now?: () => Date;
  readonly setTimer?: SetTimer;
  readonly intervalMs?: number;
}

interface Queued {
  readonly fn: () => Promise<void>;
  readonly step: string;
  readonly tenantId?: string;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export class ControlLoop {
  readonly #options: ControlLoopOptions;
  readonly #now: () => Date;
  readonly #setTimer: SetTimer;
  #timer: { cancel(): void } | undefined;
  #running: Promise<unknown> | undefined;
  #closed = false;

  constructor(options: ControlLoopOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer = options.setTimer ?? realTimer;
  }

  /** Arms the next pass; each pass arms the one after it. */
  start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#running = this.pass()
        .catch((error: unknown) => {
          this.#options.log.error({ reason: codeOf(error) }, 'a control-loop pass failed');
        })
        .finally(() => {
          this.#running = undefined;
          this.start();
        });
    }, this.#options.intervalMs ?? CONTROL_LOOP_MS);
  }

  /** Stops arming passes and waits for one that is running. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#timer?.cancel();
    this.#timer = undefined;
    await this.#running;
  }

  /** One pass; `false` when another instance holds the loop lock and nothing ran. */
  async pass(): Promise<boolean> {
    const { control, steps, log } = this.#options;
    const now = this.#now();
    const queued: Queued[] = [];
    const ran = await control.transaction(async (tx) => {
      const lock = await tx.query<{ ok: boolean }>(CONTROL_LOOP_LOCK);
      if (lock.rows[0]?.ok !== true) return false;
      for (const step of steps) {
        const mark = queued.length;
        const context: LoopStepContext = {
          tx,
          now,
          each: async (tenantId, fn) => {
            const tenantMark = queued.length;
            await tx.query('savepoint control_tenant');
            try {
              await fn();
              await tx.query('release savepoint control_tenant');
            } catch (error) {
              await tx.query('rollback to savepoint control_tenant');
              queued.length = tenantMark;
              log.error(
                { step: step.name, tenantId, reason: codeOf(error) },
                'a control-loop step failed for a tenant',
              );
            }
          },
          afterCommit: (fn, tenantId) => {
            queued.push({ fn, step: step.name, ...(tenantId !== undefined ? { tenantId } : {}) });
          },
        };
        await tx.query('savepoint control_step');
        try {
          await step.run(context);
          await tx.query('release savepoint control_step');
        } catch (error) {
          await tx.query('rollback to savepoint control_step');
          queued.length = mark;
          log.error({ step: step.name, reason: codeOf(error) }, 'a control-loop step failed');
        }
      }
      return true;
    });
    for (const item of queued) {
      try {
        await item.fn();
      } catch (error) {
        log.error(
          {
            step: item.step,
            reason: codeOf(error),
            ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
          },
          'a control-loop step failed after its pass',
        );
      }
    }
    return ran;
  }
}
