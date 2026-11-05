/**
 * The tenant's own control-plane routes (hosted edition spec §22.9, §22.11, §22.13), on its host, for its server
 * admins only, each in the request's tenant:
 *
 * - `GET /tenant/billing` (hosted): the team's slug and name, its enabled accounts (the seat count), the plan, seats, status, period end and, while past due, the days left before the
 *   grace sweep suspends the team; and any deletion asked for, for the settings screen's banner;
 * - `GET /tenant/exports`, `POST /tenant/exports` and `GET /tenant/exports/:id/file` (every server): the exports,
 *   asking for one, and its file, served to a signed-in server admin only, behind the session or the device token,
 *   never a token in the URL (§6);
 * - `POST /tenant/deletion` and `DELETE /tenant/deletion` (hosted): asking for the deletion, with the slug typed as the
 *   confirmation, and cancelling it until it runs.
 *
 * Nothing here runs on the control role: the deletion goes through `TenantLifecycle`, as the operator's does, and
 * every read is a unit of the request's tenant.
 */
import { open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { auditSource, recordAudit, type ServerHooks } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { RateLimiter } from '../identity/rate-limit.js';
import { countEnabledUsers } from '../licensing/seats.js';
import { problem } from '../problem.js';
import type { TenantDbFactory, TenantQuerier } from '../tenancy/tenant-db.js';
import { DAY_MS, GRACE_DAYS } from './billing/sweep.js';
import type { ExportRow, ExportRunner } from './export/runner.js';
import { mailDeletionRequested, type DeletionMailDeps } from './deletion-mail.js';
import type { TenantLifecycle } from './tenants.js';

export interface TenantRoutesDeps {
  readonly db: TenantDbFactory;
  readonly runner: ExportRunner;
  /** Where `tenant.export_downloaded` is recorded. */
  readonly hooks: ServerHooks;
  /** Hosted mode only: the billing and deletion routes are not registered without it. */
  readonly lifecycle?: TenantLifecycle;
  readonly now: () => Date;
  /** The deletion request's mail to every server admin (spec §22.11). */
  readonly deletionMail: Omit<DeletionMailDeps, 'db' | 'log'>;
}

/**
 * Who asked for each export, for the list's *By* column: the user's display name, else their email, or `operator`;
 * `null` for an account no longer on the server.
 */
async function requesters(db: TenantQuerier, rows: readonly ExportRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.requestedBy).filter((id) => id !== 'operator'))];
  const names = new Map<string, string>([['operator', 'operator']]);
  if (ids.length === 0) return names;
  const found = await db.query<{ id: string; name: string }>(
    `select id, coalesce(nullif(btrim(display_name), ''), email) as name from users where id = any($1::text[])`,
    [ids],
  );
  for (const row of found.rows) names.set(row.id, row.name);
  return names;
}

function exportView(row: ExportRow, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    status: row.status,
    requestedBy: names.get(row.requestedBy) ?? null,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    error: row.error,
    requestedAt: row.requestedAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

const iso = (at: Date | null | undefined): string | null => (at === null || at === undefined ? null : at.toISOString());

/** `wirebench-export-<slug>-<utc>.tar.gz` (spec §22.9), from the time the export was ready. */
function fileName(slug: string, at: Date | null): string {
  const stamp = (at ?? new Date(0))
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `wirebench-export-${slug}-${stamp}.tar.gz`;
}

/** Export downloads per server admin: each streams the whole tenant, so a script cannot pull it in a loop. */
export const EXPORT_DOWNLOADS = { capacity: 10, refillPerMs: 10 / 60_000 } as const;

export function tenantRoutes(deps: TenantRoutesDeps) {
  return (app: FastifyInstance): void => {
    const lifecycle = deps.lifecycle;
    const downloads = new RateLimiter({ ...EXPORT_DOWNLOADS, now: () => deps.now().getTime() });

    app.get('/tenant/exports', { preHandler: requireServerAdmin }, async (request) => {
      const rows = await deps.runner.list(request.tenant);
      const names = await requesters(deps.db(request.tenant), rows);
      return { exports: rows.map((row) => exportView(row, names)) };
    });

    app.post('/tenant/exports', { preHandler: requireServerAdmin }, async (request, reply) => {
      // The control loop (or a self-hosted server's export timer) runs it within a minute.
      const row = await deps.runner.request(request.tenant, request.caller!.id);
      const names = await requesters(deps.db(request.tenant), [row]);
      return reply.code(202).send({ export: exportView(row, names) });
    });

    app.get('/tenant/exports/:id/file', { preHandler: requireServerAdmin }, async (request, reply) => {
      const allowed = downloads.take(`${request.tenant.tenantId}:${request.caller!.id}`);
      if (!allowed.allowed) {
        return reply
          .code(429)
          .header('cache-control', 'no-store')
          .header('retry-after', String(allowed.retryAfterSeconds))
          .send();
      }
      const { id } = request.params as { id: string };
      const { row, path } = await deps.runner.ready(request.tenant, id);
      // Opened before anything is sent: a file the sweep removed under a row not yet marked is a 404, and once open it
      // stays readable to the end, whatever the sweep does.
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw problem('control-plane-export-unknown', 'no export has that id', 404);
        }
        throw error;
      }
      let size: number;
      try {
        size = (await file.stat()).size;
        // Who took the tenant's data away, and when (spec §22.9): it holds every password hash.
        await deps.db(request.tenant).transaction((tx) =>
          recordAudit(deps.hooks, tx, {
            ...auditSource(request),
            action: 'tenant.export_downloaded',
            target: { kind: 'tenant', id: request.tenant.tenantId },
            details: { exportId: row.id, sizeBytes: size, by: request.caller!.id },
          }),
        );
      } catch (error) {
        await file.close();
        throw error;
      }
      const stream = file.createReadStream();
      stream.on('error', (error) => {
        // Headers are out by now: the connection is cut, and the reason logged without the path.
        request.log.warn(
          { exportId: row.id, code: (error as NodeJS.ErrnoException).code },
          'an export download failed',
        );
      });
      void reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${fileName(request.tenant.slug, row.readyAt)}"`)
        .header('cache-control', 'no-store')
        .header('content-length', String(size));
      return reply.send(stream);
    });

    if (lifecycle === undefined) return;

    app.get('/tenant/billing', { preHandler: requireServerAdmin }, async (request) => {
      const db = deps.db(request.tenant);
      const tenant = (
        await db.query<{
          slug: string;
          name: string;
          edition: string;
          seats: number | null;
          editionSource: string;
          status: string;
          suspendedReason: string | null;
          deletionRequestedAt: Date | null;
          deletingAt: Date | null;
        }>(
          `select slug, name, edition, seats, edition_source as "editionSource", status, suspended_reason as "suspendedReason",
                  deletion_requested_at as "deletionRequestedAt", deleting_at as "deletingAt"
             from tenants where id = $1::uuid`,
          [request.tenant.tenantId],
        )
      ).rows[0];
      const subscription = (
        await db.query<{
          plan: string;
          seats: number;
          status: string;
          currentPeriodEnd: Date | null;
          pastDueSince: Date | null;
        }>(
          `select plan, seats, status, current_period_end as "currentPeriodEnd", past_due_since as "pastDueSince"
             from subscriptions`,
        )
      ).rows[0];
      // The count the seat cap compares (licensing §3.4): every enabled account of the tenant, server admins included.
      const activeMembers = await countEnabledUsers(db);
      const pastDueSince = subscription?.status === 'past_due' ? subscription.pastDueSince : null;
      const daysLeft =
        pastDueSince === null || pastDueSince === undefined
          ? null
          : Math.max(0, Math.ceil((pastDueSince.getTime() + GRACE_DAYS * DAY_MS - deps.now().getTime()) / DAY_MS));
      return {
        // The slug the deletion's confirmation is compared with, and the name the screen shows: a custom domain
        // (§23) says neither.
        slug: request.tenant.slug,
        name: tenant?.name ?? request.tenant.slug,
        activeMembers,
        edition: tenant?.edition ?? null,
        editionSource: tenant?.editionSource ?? null,
        status: tenant?.status ?? null,
        suspendedReason: tenant?.suspendedReason ?? null,
        subscription:
          subscription === undefined
            ? null
            : {
                plan: subscription.plan,
                seats: subscription.seats,
                status: subscription.status,
                currentPeriodEnd: iso(subscription.currentPeriodEnd),
                pastDueSince: iso(pastDueSince),
                pastDueDaysLeft: daysLeft,
              },
        deletion:
          tenant?.deletingAt === null || tenant?.deletingAt === undefined
            ? null
            : { requestedAt: iso(tenant.deletionRequestedAt), deletingAt: iso(tenant.deletingAt) },
      };
    });

    app.post('/tenant/deletion', { preHandler: requireServerAdmin }, async (request, reply) => {
      const body = request.body as { slug?: unknown } | undefined;
      if (typeof body?.slug !== 'string' || body.slug !== request.tenant.slug) {
        throw problem('control-plane-deletion-unconfirmed', "type the team's slug to confirm its deletion", 400);
      }
      const actor = { source: auditSource(request), by: request.caller!.id };
      const row = await lifecycle.requestDeletion(request.tenant.slug, actor);
      if (row?.deletingAt !== undefined && row.deletingAt !== null) {
        await mailDeletionRequested({ ...deps.deletionMail, db: deps.db, log: request.log }, request.tenant, {
          teamName: row.name,
          deletingAt: row.deletingAt,
          by: request.caller!.email,
        });
      }
      const current = row ?? (await lifecycle.current(request.tenant.tenantId));
      return reply.code(202).send({
        deletion: { requestedAt: iso(current?.deletionRequestedAt), deletingAt: iso(current?.deletingAt) },
      });
    });

    app.delete('/tenant/deletion', { preHandler: requireServerAdmin }, async (request) => {
      const actor = { source: auditSource(request), by: request.caller!.id };
      const row = await lifecycle.cancelDeletion(request.tenant.slug, actor);
      return { cancelled: row !== undefined };
    });
  };
}
