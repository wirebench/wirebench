/**
 * Everything one host holds in memory that used to be a module variable, so a process can run more
 * than one host without them sharing secrets, batches, outboxes or open calls. Built once per host
 * (`createHostState()`) and handed to the pieces that need it through their `deps`.
 *
 * Not here on purpose: `serial-session.ts`'s lazy import promise and `script-host.ts`'s weak type
 * cache. Both are caches of something immutable or keyed by objects, so sharing them is safe.
 */
import type { AuditOutbox } from '../audit/outbox.js';
import { Redactor } from './redactor.js';

export interface HostState {
  /** The secret values this host handed to sends, and the masking built on them. */
  readonly redactor: Redactor;
  /** The child send ids of every environment fan-out still running, keyed by its batch id. */
  readonly multiEnvBatches: Map<string, readonly string[]>;
  /** One audit outbox per folder for this host: two instances could pick the same sequence number. */
  readonly auditOutboxes: Map<string, AuditOutbox>;
  /**
   * The `request.openWs` and editor REST sends still running, each settling only once its History
   * entry has been written, with the request each belongs to.
   */
  readonly openCalls: {
    readonly ws: Map<Promise<unknown>, string>;
    readonly rest: Map<Promise<unknown>, string>;
  };
  /** The end-to-end test's trust anchors, read once from the environment; `undefined` until read. */
  e2eTrustAnchors: readonly string[] | undefined;
}

export function createHostState(): HostState {
  return {
    redactor: new Redactor(),
    multiEnvBatches: new Map(),
    auditOutboxes: new Map(),
    openCalls: { ws: new Map(), rest: new Map() },
    e2eTrustAnchors: undefined,
  };
}
