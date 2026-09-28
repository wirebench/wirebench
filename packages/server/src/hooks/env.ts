/** What every webhook-capture route closes over, built once per server by `module.ts`. */
import type { ServerContext } from '../context.js';
import type { CatchBuckets } from './rate-limit.js';
import type { HooksSettings } from './settings.js';

export type SetTimer = (fn: () => void, ms: number) => { cancel(): void };

export interface HooksEnv {
  readonly ctx: ServerContext;
  readonly settings: HooksSettings;
  /** Injected in tests: a capture's `received_at`, the buckets' refill and the age sweep's cutoff. */
  readonly now: () => Date;
  /** Injected in tests: the configured response delay and the sweep interval. */
  readonly setTimer: SetTimer;
  readonly buckets: CatchBuckets;
  readonly newCaptureId: () => string;
}
