/**
 * The tenants' exports as jobs (hosted edition spec §22.9, §22.15): a server admin asks for one, the runner writes
 * it to `<tenantRoot>/exports/<id>.tar.gz`, and the requester is mailed a link to the settings screen when it is
 * ready. A `tenant_exports` row is `queued`, `running`, `ready`, `failed` or `expired`.
 *
 * - **One at a time per tenant.** Asking while one is queued or running is refused (`control-plane-export-running`),
 *   and the claim that moves a row to `running` takes a transaction lock of the tenant's
 *   ({@link EXPORT_LOCK_CLASS}), checks that none runs, and claims the oldest queued, so two instances never run two.
 * - **At most three kept.** Once one is ready, the ready ones past the newest {@link EXPORT_KEEP} expire.
 * - **Seven days.** A ready export expires {@link EXPORT_DAYS} after it was made: the sweep deletes the file and
 *   marks the row.
 * - **A running export holds a lease.** Its claim sets `expires_at` to {@link EXPORT_STALE_MS} on, so a `running`
 *   row a dead process left is `failed` by the sweep once the lease ends, counted from the claim, not the request.
 *   The row turns `ready` only while it is still `running`, and an export of a tenant being deleted fails.
 *   (`expires_at` means "until when this state holds" in both states, so no column was added.)
 *
 * In hosted mode the control loop runs it ({@link exportsStep}); a self-hosted server, which has no control loop,
 * runs the same functions from the module's own timer.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCli } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, SYSTEM_SOURCE, type ServerHooks } from '../../context.js';
import { problem } from '../../problem.js';
import type { RepoStore } from '../../repos/repo-store.js';
import { SERVER_SCHEMA } from '../../tenancy/running-lock.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantDbFactory, TenantQuerier } from '../../tenancy/tenant-db.js';
import { tenantUrl } from '../../tenancy/urls.js';
import type { ModuleConfig } from '../../config.js';
import type { LoopStep } from '../loop.js';
import type { ControlSend } from '../mail.js';
import { exportsDir, writeExport, type ExportManifest } from './export.js';

export const EXPORT_KEEP = 3;
export const EXPORT_DAYS = 7;
/** A `running` export older than this was left by a process that died. */
export const EXPORT_STALE_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The claim's lock class ("WBEX"); the second key hashes the schema and the tenant. */
export const EXPORT_LOCK_CLASS = 0x57424558;

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export type ExportRow = {
  readonly id: string;
  /** A user id, or `operator`. */
  readonly requestedBy: string;
  readonly status: ExportStatus;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  /** A failure's code; never its message. */
  readonly error: string | null;
  readonly requestedAt: Date;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
};

const COLUMNS = `id, requested_by as "requestedBy", status, size_bytes::float8 as "sizeBytes", sha256, error,
  requested_at as "requestedAt", ready_at as "readyAt", expires_at as "expiresAt"`;

/** An export id: what `randomUUID` mints, so it is safe in a path. */
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ExportRunnerDeps {
  readonly db: TenantDbFactory;
  readonly repos: Pick<RepoStore, 'exists' | 'path' | 'withLock'>;
  /** With plumbing (`bundle`). */
  readonly git: Pick<GitCli, 'run'>;
  readonly dataDir: string;
  readonly version: string;
  readonly chainKeyOf: (scope: TenantScope) => string | undefined;
  readonly hooks: ServerHooks;
  readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  readonly now?: () => Date;
  /** The ready mail; none without SMTP. */
  readonly mail?: {
    readonly send: ControlSend;
    readonly config: Pick<ModuleConfig, 'mode' | 'appDomain'>;
    /** The SMTP host, for a failure's log line; the URL may hold a password. */
    readonly mailHost: string;
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : 'export-failed';
}

/** Takes the tenant's export lock for the unit: claims and requests wait on each other. */
async function lockExports(tx: TenantQuerier): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock($1::int, hashtext(coalesce(${SERVER_SCHEMA}, '') || ':' || $2::text))`, [
    EXPORT_LOCK_CLASS,
    tx.scope.tenantId,
  ]);
}

export class ExportRunner {
  readonly #deps: ExportRunnerDeps;
  readonly #now: () => Date;

  constructor(deps: ExportRunnerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Where `id`'s file is, or would be. */
  path(scope: TenantScope, id: string): string {
    if (!EXPORT_ID.test(id)) throw problem('control-plane-export-unknown', 'no export has that id', 404);
    return join(exportsDir(this.#deps.dataDir, scope), `${id}.tar.gz`);
  }

  /**
   * Queues an export of `scope` for `requestedBy` (a user id, or `operator`).
   *
   * @throws WirebenchError `control-plane-export-running` (409) while one is queued or running
   */
  async request(scope: TenantScope, requestedBy: string): Promise<ExportRow> {
    return this.#deps.db(scope).transaction(async (tx) => {
      await lockExports(tx);
      const busy = await tx.query("select 1 from tenant_exports where status in ('queued', 'running') limit 1");
      if (busy.rows.length > 0) {
        throw problem('control-plane-export-running', 'an export of this team is already queued or running', 409);
      }
      const rows = await tx.query<ExportRow>(
        `insert into tenant_exports (id, requested_by, status, requested_at) values ($1, $2, 'queued', $3::timestamptz)
         returning ${COLUMNS}`,
        [randomUUID(), requestedBy, this.#now()],
      );
      return rows.rows[0]!;
    });
  }

  /** Every export not expired, newest first. */
  async list(scope: TenantScope): Promise<ExportRow[]> {
    const rows = await this.#deps
      .db(scope)
      .query<ExportRow>(
        `select ${COLUMNS} from tenant_exports where status <> 'expired' order by requested_at desc, id desc`,
      );
    return rows.rows;
  }

  /**
   * A ready export's row and file, while it has not expired: one past `expires_at` is gone even before the sweep
   * removes its file.
   *
   * @throws WirebenchError `control-plane-export-unknown` (404) for an id this tenant has no ready export of
   */
  async ready(scope: TenantScope, id: string): Promise<{ readonly row: ExportRow; readonly path: string }> {
    const path = this.path(scope, id);
    const row = (
      await this.#deps
        .db(scope)
        .query<ExportRow>(
          `select ${COLUMNS} from tenant_exports where id = $1 and status = 'ready' and expires_at > $2::timestamptz`,
          [id, this.#now()],
        )
    ).rows[0];
    if (row === undefined) throw problem('control-plane-export-unknown', 'no export has that id', 404);
    return { row, path };
  }

  /** Claims the oldest queued export, if none runs; `undefined` when nothing was claimed. */
  async #claim(scope: TenantScope): Promise<ExportRow | undefined> {
    return this.#deps.db(scope).transaction(async (tx) => {
      await lockExports(tx);
      const running = await tx.query("select 1 from tenant_exports where status = 'running' limit 1");
      if (running.rows.length > 0) return undefined;
      const rows = await tx.query<ExportRow>(
        `update tenant_exports set status = 'running', error = null, expires_at = $1::timestamptz
          where id = (select id from tenant_exports where status = 'queued' order by requested_at, id limit 1)
          returning ${COLUMNS}`,
        [new Date(this.#now().getTime() + EXPORT_STALE_MS)],
      );
      return rows.rows[0];
    });
  }

  /**
   * Runs the oldest queued export of `scope`, if none is running: writes it, marks it ready, expires what is past
   * the three kept, records `tenant.exported` and mails the requester. A failure marks it `failed` with its code.
   * `undefined` when there was nothing to run.
   */
  async runNext(scope: TenantScope): Promise<ExportRow | undefined> {
    const claimed = await this.#claim(scope);
    if (claimed === undefined) return undefined;
    const path = this.path(scope, claimed.id);
    const db = this.#deps.db(scope);
    let manifest: ExportManifest;
    let row: ExportRow;
    try {
      await this.#refuseDeleting(scope);
      const result = await writeExport(
        {
          db: this.#deps.db,
          repos: this.#deps.repos,
          git: this.#deps.git,
          dataDir: this.#deps.dataDir,
          version: this.#deps.version,
          chainKey: this.#deps.chainKeyOf(scope),
          now: this.#now,
        },
        scope,
        path,
      );
      manifest = result.manifest;
      const now = this.#now();
      row = await db.transaction(async (tx) => {
        await this.#refuseDeleting(scope, tx);
        const updated = await tx.query<ExportRow>(
          `update tenant_exports set status = 'ready', size_bytes = $2, sha256 = $3, ready_at = $4::timestamptz,
             expires_at = $5::timestamptz where id = $1 and status = 'running' returning ${COLUMNS}`,
          [claimed.id, result.size, result.sha256, now, new Date(now.getTime() + EXPORT_DAYS * DAY_MS)],
        );
        // The sweep failed it while it ran (its lease ended): its file goes, and so does this result.
        if (updated.rows.length === 0) {
          throw problem('control-plane-export-interrupted', 'the export ran past its lease and was failed', 409);
        }
        await recordAudit(this.#deps.hooks, tx, {
          // The job writes it, for whoever asked: `details.by` names them, as the lifecycle's rows do.
          ...SYSTEM_SOURCE,
          action: 'tenant.exported',
          target: { kind: 'tenant', id: scope.tenantId },
          details: { exportId: claimed.id, sizeBytes: result.size, sha256: result.sha256, by: claimed.requestedBy },
        });
        return updated.rows[0]!;
      });
    } catch (error) {
      await rm(path, { force: true });
      await db.query("update tenant_exports set status = 'failed', error = $2 where id = $1", [
        claimed.id,
        codeOf(error),
      ]);
      this.#deps.log.error(
        { tenantId: scope.tenantId, exportId: claimed.id, reason: codeOf(error) },
        'an export failed',
      );
      return { ...claimed, status: 'failed', error: codeOf(error) };
    }
    await this.#keepNewest(scope);
    await this.#mailReady(scope, row, manifest.tenant.name);
    return row;
  }

  /**
   * @throws WirebenchError `control-plane-tenant-deleting` once the tenant is being deleted: its export would hold
   *   what the deletion is removing
   */
  async #refuseDeleting(scope: TenantScope, tx?: TenantQuerier): Promise<void> {
    const db = tx ?? this.#deps.db(scope);
    const status = (
      await db.query<{ status: string }>('select status from tenants where id = $1::uuid', [scope.tenantId])
    ).rows[0]?.status;
    if (status === undefined || status === 'deleting') {
      throw problem('control-plane-tenant-deleting', 'the team is being deleted', 409);
    }
  }

  /** Expires the ready exports past the newest {@link EXPORT_KEEP}. */
  async #keepNewest(scope: TenantScope): Promise<void> {
    const older = await this.#deps
      .db(scope)
      .query<{ id: string }>(
        `select id from tenant_exports where status = 'ready' order by ready_at desc, id desc offset ${String(EXPORT_KEEP)}`,
      );
    for (const { id } of older.rows) await this.#expire(scope, id);
  }

  async #expire(scope: TenantScope, id: string): Promise<void> {
    await rm(this.path(scope, id), { force: true });
    await this.#deps.db(scope).query("update tenant_exports set status = 'expired' where id = $1", [id]);
  }

  /** Expires the ready exports past their seven days, and fails a `running` one a dead process left. */
  async sweep(scope: TenantScope): Promise<void> {
    const now = this.#now();
    const due = await this.#deps
      .db(scope)
      .query<{ id: string }>(
        "select id from tenant_exports where status = 'ready' and expires_at <= $1::timestamptz order by id",
        [now],
      );
    for (const { id } of due.rows) await this.#expire(scope, id);
    const stale = await this.#deps.db(scope).query<{ id: string }>(
      `update tenant_exports set status = 'failed', error = 'export-interrupted'
          where status = 'running' and expires_at <= $1::timestamptz returning id`,
      [now],
    );
    for (const { id } of stale.rows) await rm(this.path(scope, id), { force: true });
  }

  /** Whether `scope` has an export to run or to expire. */
  async hasWork(tx: TenantQuerier): Promise<boolean> {
    const rows = await tx.query(
      `select 1 from tenant_exports where status in ('queued', 'running')
          or (status = 'ready' and expires_at <= $1::timestamptz) limit 1`,
      [this.#now()],
    );
    return rows.rows.length > 0;
  }

  async #mailReady(scope: TenantScope, row: ExportRow, teamName: string): Promise<void> {
    const mail = this.#deps.mail;
    if (mail === undefined || row.requestedBy === 'operator') return;
    const to = (
      await this.#deps
        .db(scope)
        .query<{ email: string }>('select email from users where id = $1 and disabled_at is null', [row.requestedBy])
    ).rows[0]?.email;
    if (to === undefined) return;
    const name = teamName.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
    try {
      await mail.send([to], {
        subject: `The export of the Wirebench team ${name} is ready`,
        text: [
          `The export of the Wirebench team "${name}" is ready.`,
          '',
          `Download it from the team's settings: ${tenantUrl(mail.config, scope)}/settings`,
          `It is kept for ${String(EXPORT_DAYS)} days. It holds the team's data, password hashes and captures included: keep it as safe as the team's database.`,
          '',
        ].join('\n'),
      });
    } catch {
      // A refusal can quote a recipient: only the mail host is logged.
      this.#deps.log.warn(
        { tenantId: scope.tenantId, exportId: row.id, mailHost: mail.mailHost },
        "an export's ready mail could not be sent",
      );
    }
  }
}

/**
 * The control loop's export step (spec §22.15): every tenant with an export to run or to expire, found on the control
 * role in the pass's transaction, then run one at a time once the pass committed, each in its tenant's units.
 */
export function exportsStep(runner: ExportRunner, scopeFor: (tenantId: string) => Promise<TenantScope>): LoopStep {
  return {
    name: 'tenant-exports',
    run: async ({ tx, now, afterCommit }) => {
      const due = await tx.query<{ id: string }>(
        `select distinct e.tenant_id::text as id from tenant_exports e join tenants t on t.id = e.tenant_id
          where t.status <> 'deleting'
            and (e.status in ('queued', 'running') or (e.status = 'ready' and e.expires_at <= $1::timestamptz))
          order by 1`,
        [now],
      );
      for (const { id } of due.rows) {
        afterCommit(async () => {
          const scope = await scopeFor(id);
          await runner.sweep(scope);
          await runner.runNext(scope);
        }, id);
      }
    },
  };
}
