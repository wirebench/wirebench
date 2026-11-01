/**
 * The audit sealer and forwarder over a fake job loop of two tenants (Task 14 review M1, M3, M5): each tenant is
 * sealed with its own key and forwarded under its own license; a failed send or a stop ends the pass rather than
 * waiting on every tenant; and a batch whose unit failed to commit is not counted as sent.
 */
import type { AuditEvent } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { keyId } from '../../../src/audit-log/chain/canonical.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { AuditForwarder, type ForwardSink } from '../../../src/audit-log/forward/forwarder.js';
import { permissiveLicense, type LicenseService } from '../../../src/context.js';
import { STOP_PASS } from '../../../src/tenancy/jobs.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantQuerier } from '../../../src/tenancy/tenant-db.js';
import type { Tenancy } from '../../../src/tenancy/tenancy.js';

const ONE = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'one' });
const TWO = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'two' });
const SCOPES = [ONE, TWO];

type Handler = (scope: TenantScope, text: string, params: readonly unknown[]) => unknown[];

function recordingLog() {
  const lines: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, args });
    };
  const logger = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
  return { lines, log: logger as unknown as FastifyBaseLogger };
}

/** A job loop over two tenants whose units answer from `handler`; `failCommit` names a tenant whose unit fails. */
function fakeTenancy(handler: Handler, options: { readonly failCommit?: string } = {}) {
  const statements: { tenant: string; text: string }[] = [];
  const unit = (scope: TenantScope): TenantQuerier =>
    ({
      scope,
      query: (text: string, params: readonly unknown[] = []) => {
        statements.push({ tenant: scope.slug, text });
        const rows = handler(scope, text, params);
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    }) as unknown as TenantQuerier;
  const tenancy: Pick<Tenancy, 'db' | 'forEachTenant'> = {
    // A unit of `failCommit`'s tenant opened after the job loop's (the forwarder's delete) fails to commit.
    db: (scope: TenantScope) => ({
      ...unit(scope),
      transaction: async <T>(fn: (tx: TenantQuerier) => Promise<T>) => {
        const result = await fn(unit(scope));
        if (options.failCommit === scope.tenantId) throw new Error('the commit failed');
        return result;
      },
    }),
    // As `tenancy/jobs.ts` runs it: the function in the tenant's unit, then its `afterUnit` outside it.
    forEachTenant: async (job, fn, log) => {
      const failed: string[] = [];
      for (const scope of SCOPES) {
        try {
          const committed = await fn(unit(scope), scope);
          const outcome = typeof committed === 'object' ? await committed.afterUnit() : committed;
          if (outcome === STOP_PASS) break;
        } catch (error) {
          failed.push(scope.tenantId);
          log.error({ err: error, job, tenantId: scope.tenantId }, 'a job failed for one tenant');
        }
      }
      return { served: SCOPES.length - failed.length, failed };
    },
  };
  return { tenancy, statements };
}

const noTimer = { setTimer: () => ({ cancel: () => undefined }) };

describe('the sealer over two tenants', () => {
  it('gives each tenant’s genesis its own key, never another tenant’s', async () => {
    const anchors = new Map<string, Record<string, unknown>>();
    const { tenancy } = fakeTenancy((scope, text, params) => {
      if (text.includes('pg_try_advisory_xact_lock')) return [{ locked: true }];
      if (text.includes('insert into audit_chain_anchor')) {
        anchors.set(scope.tenantId, { seq: '0', hash: params[0], key_id: params[1], head_seq: '0', mac: params[2] });
        return [];
      }
      if (text.includes('from audit_chain_anchor')) {
        const anchor = anchors.get(scope.tenantId);
        return anchor === undefined ? [] : [anchor];
      }
      return [];
    });
    const keys = {
      [ONE.tenantId]: 'key-of-tenant-one-0123456789abcdef',
      [TWO.tenantId]: 'key-of-tenant-two-0123456789abcdef',
    };
    const sealer = new AuditSealer({
      tenancy,
      keys: (scope) => keys[scope.tenantId]!,
      now: () => new Date('2026-10-31T00:00:00Z'),
      ...noTimer,
      log: recordingLog().log,
    });
    expect(await sealer.runOnce()).toMatchObject({ outcome: 'idle', sealed: 0 });
    expect(anchors.get(ONE.tenantId)?.['key_id']).toBe(keyId(keys[ONE.tenantId]!));
    expect(anchors.get(TWO.tenantId)?.['key_id']).toBe(keyId(keys[TWO.tenantId]!));
  });
});

describe('the forwarder over two tenants', () => {
  const eventRow = (id: string) => ({
    id,
    at: '2026-10-31T00:00:00.000Z',
    actorKind: 'system',
    action: 'team.created',
    targetKind: 'team',
    details: {},
  });

  /** Each tenant's queue, its license, and the sink. */
  function cast(options: {
    readonly licensed?: readonly string[];
    readonly sink?: (events: AuditEvent[]) => Promise<void>;
    readonly failCommit?: string;
  }) {
    const queues = new Map<string, string[]>([
      [ONE.tenantId, ['E1']],
      [TWO.tenantId, ['E2']],
    ]);
    const { tenancy, statements } = fakeTenancy(
      (scope, text, params) => {
        if (text.includes('from audit_forward_queue q join audit_events')) {
          return (queues.get(scope.tenantId) ?? []).map(eventRow);
        }
        if (text.startsWith('delete from audit_forward_queue')) {
          const ids = params[0] as string[];
          queues.set(
            scope.tenantId,
            (queues.get(scope.tenantId) ?? []).filter((id) => !ids.includes(id)),
          );
        }
        return [];
      },
      options.failCommit !== undefined ? { failCommit: options.failCommit } : {},
    );
    const licensedTenants = options.licensed ?? [ONE.tenantId, TWO.tenantId];
    const license: LicenseService = {
      ...permissiveLicense(),
      state: (of) =>
        Promise.resolve({
          edition: 'enterprise',
          status: 'active',
          seats: { used: 0, limit: null },
          features: licensedTenants.includes((of as TenantScope).tenantId) ? ['audit-log'] : [],
        }),
    };
    const sent: string[] = [];
    const sink: ForwardSink = {
      send:
        options.sink ??
        ((events) => {
          sent.push(...events.map((event) => event.id));
          return Promise.resolve();
        }),
      close: () => Promise.resolve(),
    };
    const { lines, log } = recordingLog();
    const forwarder = new AuditForwarder({
      tenancy,
      sink,
      license: () => license,
      now: () => new Date('2026-10-31T00:00:00Z'),
      ...noTimer,
      log,
    });
    const claimsIn = (slug: string) =>
      statements.filter((entry) => entry.tenant === slug && entry.text.includes('from audit_forward_queue q')).length;
    return { forwarder, sent, lines, claimsIn, queues };
  }

  it('reads each tenant’s own license: an unlicensed tenant is never claimed from', async () => {
    const { forwarder, sent, claimsIn } = cast({ licensed: [TWO.tenantId] });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(sent).toEqual(['E2']);
    expect(claimsIn('one')).toBe(0);
  });

  it('ends the pass after a failed send: the next tenant does not wait on the same sink', async () => {
    const { forwarder, claimsIn } = cast({ sink: () => Promise.reject(new Error('down')) });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'failed', sent: 0 });
    expect(claimsIn('one')).toBe(1);
    expect(claimsIn('two')).toBe(0);
  });

  it('a stop during a tenant’s send ends the pass after that tenant’s batch', async () => {
    const ref: { forwarder?: AuditForwarder } = {};
    let stopping: Promise<void> | undefined;
    const sent: string[] = [];
    const made = cast({
      sink: (events) => {
        sent.push(...events.map((event) => event.id));
        stopping ??= ref.forwarder!.stop();
        return Promise.resolve();
      },
    });
    ref.forwarder = made.forwarder;
    expect(await made.forwarder.runOnce()).toMatchObject({ sent: 1 });
    await stopping;
    expect(sent).toEqual(['E1']);
    expect(made.claimsIn('two')).toBe(0);
    expect(made.queues.get(ONE.tenantId)).toEqual([]);
  });

  it('a batch whose unit failed to commit is not counted as sent, and the failure is logged', async () => {
    const { forwarder, lines } = cast({ failCommit: ONE.tenantId });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(lines.filter((line) => line.level === 'warn').map((line) => line.args[1])).toEqual([
      'audit forwarding failing',
    ]);
  });
});
