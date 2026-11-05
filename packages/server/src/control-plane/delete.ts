/**
 * A tenant's deletion (hosted edition spec §22.11), the control loop's step for every tenant whose `deleting_at` has
 * passed. It waits while the tenant's subscription is `active`, `trialing` or `past_due`, logging
 * `deletion-subscription-active` once a day, so a customer is never billed for a deleted team. Then, each step
 * idempotent, so a crash anywhere is resumed by the next pass:
 *
 * 1. in the pass's control transaction, status `deleting` and the audit chain's last link (its sequence, hash and key
 *    id, read on the control role before any row goes) into `tenant_deletions`; once the pass commits, the
 *    directory's change is announced, so every instance's resolver drops the tenant and its jobs pass it over;
 * 2. every scoped table's rows deleted in reverse foreign-key order, one unit of the tenant per table, on the app role;
 * 3. `<dataDir>/tenants/<id>/` removed (repositories, checkouts, temporary files, exports), through `tenantRootById`'s
 *    checks, so nothing outside the tenant's own directory is ever touched;
 * 4. the check, on the control role: every scoped table holds no row of the tenant. A row found logs
 *    `deletion-incomplete` by table and tenant id, and the next pass starts again from step 2. My call: the check
 *    gates the last step, rather than following it, because the tenants row's foreign keys would refuse its removal
 *    over a remaining row anyway, and once it is gone a row of the tenant can no longer be found by its tenant;
 * 5. one control transaction: `tenant_deletions.deleted_at` set, the slug retired with no redirect (and every
 *    redirect to it ended), the `tenants` row removed, which removes the data key and, by its foreign key, the custom
 *    names in `tenant_hosts`; then every key cache dropped through the directory's change. The check runs once more.
 */
import { rm } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { tenantRootById } from '../tenancy/paths.js';
import type { TenantDbFactory } from '../tenancy/tenant-db.js';
import type { ControlDb } from './control-db.js';
import { foreignKeyOrder } from './export/import.js';
import type { LoopStep } from './loop.js';
import type { ControlTx } from './slugs.js';
import type { TenantLifecycle } from './tenants.js';

/** The subscription states a deletion waits for the customer to end at the provider (spec §22.11). */
export const BILLED_STATES: readonly string[] = ['active', 'trialing', 'past_due'];

/** Where a deletion's `deletion-subscription-active` line is claimed once a day: the mails' own provider. */
const WAIT_LOG_PROVIDER = 'wirebench';

export type DeletionStep = 'deleting' | 'rows' | 'files' | 'check' | 'removed';

export interface DeletionDeps {
  readonly control: ControlDb;
  readonly db: TenantDbFactory;
  readonly lifecycle: TenantLifecycle;
  readonly dataDir: string;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** A test's crash: called after each step. */
  readonly afterStep?: (step: DeletionStep, tenantId: string) => Promise<void> | void;
}

/** The scoped tables, from the catalog: every table the forced policy holds. */
async function scopedTables(query: (text: string) => Promise<{ rows: { table: string }[] }>): Promise<string[]> {
  return (
    await query(
      `select relname as table from pg_class
        where relnamespace = to_regnamespace(current_schema()) and relkind = 'r' and relforcerowsecurity
        order by 1`,
    )
  ).rows.map((row) => row.table);
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export class TenantDeletion {
  readonly #deps: DeletionDeps;

  constructor(deps: DeletionDeps) {
    this.#deps = deps;
  }

  /**
   * Step 1 in `tx`, the pass's: the tenant `deleting`, its chain's last link recorded. `undefined` when it already
   * was.
   */
  async #begin(tx: ControlTx, id: string, now: Date): Promise<(() => Promise<void>) | undefined> {
    const head = await tx.query<{ seq: string | null; hash: string | null; keyId: string | null }>(
      `select coalesce(
                (select chain_seq::text from audit_events where tenant_id = $1::uuid and chain_seq is not null
                  order by chain_seq desc limit 1),
                (select seq::text from audit_chain_anchor where tenant_id = $1::uuid)) as seq,
              coalesce(
                (select encode(chain_hash, 'hex') from audit_events where tenant_id = $1::uuid and chain_seq is not null
                  order by chain_seq desc limit 1),
                (select encode(hash, 'hex') from audit_chain_anchor where tenant_id = $1::uuid)) as hash,
              (select key_id from audit_chain_anchor where tenant_id = $1::uuid) as "keyId"`,
      [id],
    );
    const link = head.rows[0];
    await tx.query(
      `insert into tenant_deletions (tenant_id, slug, requested_at, deleted_at, chain_seq, chain_hash, chain_key_id)
       select id, slug, coalesce(deletion_requested_at, $2::timestamptz), $2::timestamptz, $3::bigint, $4, $5
         from tenants where id = $1::uuid
       on conflict (tenant_id) do nothing`,
      [id, now, link?.seq ?? null, link?.hash ?? null, link?.keyId ?? null],
    );
    const change = await this.#deps.lifecycle.markDeletingWithin(tx, id);
    return change === undefined ? undefined : () => change.after();
  }

  /** Steps 2 to 5 for the tenant `id`, already `deleting`; `false` when the check found rows and it must run again. */
  async finish(id: string, now: Date): Promise<boolean> {
    const { lifecycle, dataDir, log } = this.#deps;
    const scope = await lifecycle.deletingScope(id);
    if (scope !== undefined) {
      const tenantDb = this.#deps.db(scope);
      const tables = await scopedTables((text) => tenantDb.query<{ table: string }>(text));
      const order = await tenantDb.transaction((tx) => foreignKeyOrder(tx, tables));
      for (const table of order.reverse()) await tenantDb.query(`delete from ${quoted(table)}`);
      await this.#deps.afterStep?.('rows', id);
      await rm(tenantRootById(dataDir, id), { recursive: true, force: true });
      await this.#deps.afterStep?.('files', id);
      const left = await this.#remaining(id);
      await this.#deps.afterStep?.('check', id);
      if (left.length > 0) {
        for (const { table, rows } of left) {
          log.error({ tenantId: id, table, rows, code: 'deletion-incomplete' }, 'deletion-incomplete: rows are left');
        }
        return false;
      }
      await lifecycle.removeDeleted(id, now);
      await this.#deps.afterStep?.('removed', id);
    }
    const after = await this.#remaining(id);
    for (const { table, rows } of after) {
      log.error({ tenantId: id, table, rows, code: 'deletion-incomplete' }, 'deletion-incomplete: rows are left');
    }
    return after.length === 0;
  }

  /** Every scoped table that still holds a row of `id`, read on the control role, past the policy. */
  async #remaining(id: string): Promise<{ table: string; rows: number }[]> {
    const tables = await scopedTables((text) => this.#deps.control.query<{ table: string }>(text));
    const left: { table: string; rows: number }[] = [];
    for (const table of tables) {
      const rows = await this.#deps.control.query<{ n: string }>(
        `select count(*)::text as n from ${quoted(table)} where tenant_id = $1::uuid`,
        [id],
      );
      const n = Number(rows.rows[0]?.n ?? 0);
      if (n > 0) left.push({ table, rows: n });
    }
    return left;
  }

  /** The control loop's step (spec §22.15): every due deletion, a waiting one logged at most once a day. */
  step(): LoopStep {
    return {
      name: 'tenant-deletions',
      run: async ({ tx, now, each, afterCommit }) => {
        const due = await tx.query<{ id: string; status: string; subscription: string | null }>(
          `select t.id::text as id, t.status, s.status as subscription from tenants t
             left join subscriptions s on s.tenant_id = t.id
            where t.deleting_at is not null and t.deleting_at <= $1::timestamptz
            order by t.deleting_at, t.id for no key update of t skip locked`,
          [now],
        );
        for (const row of due.rows) {
          await each(row.id, async () => {
            if (row.status !== 'deleting' && row.subscription !== null && BILLED_STATES.includes(row.subscription)) {
              const claimed = await tx.query(
                `insert into billing_events (provider, event_id, event_type, occurred_at, outcome)
                 values ($1, $2, 'deletion.waiting', $3::timestamptz, 'logged') on conflict do nothing returning event_id`,
                [WAIT_LOG_PROVIDER, `deletion-wait:${row.id}:${now.toISOString().slice(0, 10)}`, now],
              );
              if (claimed.rows.length === 1) {
                this.#deps.log.warn(
                  { tenantId: row.id, subscription: row.subscription, code: 'deletion-subscription-active' },
                  'deletion-subscription-active: the deletion waits until the subscription is canceled at the provider',
                );
              }
              return;
            }
            if (row.status !== 'deleting') {
              const announce = await this.#begin(tx, row.id, now);
              if (announce !== undefined) afterCommit(announce, row.id);
              afterCommit(async () => this.#deps.afterStep?.('deleting', row.id), row.id);
            }
            afterCommit(async () => {
              await this.finish(row.id, now);
            }, row.id);
          });
        }
      },
    };
  }
}
