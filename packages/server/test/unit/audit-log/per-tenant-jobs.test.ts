/**
 * The audit sealer and forwarder over a fake job loop of two tenants (Task 14 review M1, M3, M5): each tenant is
 * sealed with its own key and forwarded under its own license to its own sink; a dead sink stops only its own
 * tenant's batch, with its own backoff (spec §19.12 M1, §22.12); a stop ends the pass; and a batch whose unit failed
 * to commit is not counted as sent.
 */
import type { AuditEvent } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
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
    /** Tenant one's sink instead, beside the default one for tenant two. */
    readonly sinkOne?: (events: AuditEvent[]) => Promise<void>;
    /** Tenants that forward nowhere. */
    readonly noSink?: readonly string[];
    readonly failCommit?: string;
    /** The lease release fails, as a database gone away would. */
    readonly failRelease?: boolean;
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
        if (options.failRelease === true && text.startsWith('update audit_forward_queue set lease_id = null')) {
          throw new Error('connection lost');
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
    const one: ForwardSink | undefined =
      options.sinkOne === undefined ? undefined : { send: options.sinkOne, close: () => Promise.resolve() };
    const { lines, log } = recordingLog();
    let at = Date.parse('2026-10-31T00:00:00Z');
    const clock = { advance: (ms: number) => (at += ms) };
    const forwarder = new AuditForwarder({
      tenancy,
      sinkFor: (scope) =>
        Promise.resolve(
          options.noSink?.includes(scope.tenantId) === true
            ? undefined
            : scope.tenantId === ONE.tenantId && one !== undefined
              ? one
              : sink,
        ),
      license: () => license,
      now: () => new Date(at),
      ...noTimer,
      log,
    });
    const claimsIn = (slug: string) =>
      statements.filter((entry) => entry.tenant === slug && entry.text.includes('from audit_forward_queue q')).length;
    return { forwarder, sent, lines, claimsIn, queues, clock };
  }

  it('reads each tenant’s own license: an unlicensed tenant is never claimed from', async () => {
    const { forwarder, sent, claimsIn } = cast({ licensed: [TWO.tenantId] });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(sent).toEqual(['E2']);
    expect(claimsIn('one')).toBe(0);
  });

  it('a dead sink stops only its own tenant’s batch: the other tenant’s goes out (§19.12 M1)', async () => {
    const { forwarder, sent, claimsIn, queues, lines, clock } = cast({
      sinkOne: () => Promise.reject(new Error('down')),
    });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(sent).toEqual(['E2']);
    expect(queues.get(ONE.tenantId)).toEqual(['E1']);
    expect(lines.filter((line) => line.level === 'warn').map((line) => line.args[0])).toEqual([
      { tenantId: ONE.tenantId, reason: 'Error: down' },
    ]);
    // Tenant one waits out its own backoff; tenant two is claimed on every pass meanwhile.
    clock.advance(1_000);
    await forwarder.runOnce();
    expect(claimsIn('one')).toBe(1);
    expect(claimsIn('two')).toBe(2);
    clock.advance(5_000);
    await forwarder.runOnce();
    expect(claimsIn('one')).toBe(2);
  });

  it('a slow collector holds back only its own tenant: the next tenant is claimed and sent while it is out', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const made = cast({ sinkOne: () => slow });
    const pass = made.forwarder.runOnce();
    // Tenant one's send is still out; tenant two's has gone through all the same.
    await vi.waitFor(() => expect(made.sent).toEqual(['E2']));
    expect(made.queues.get(ONE.tenantId)).toEqual(['E1']);
    release();
    // The pass waits for the send it started, and counts it.
    expect(await pass).toMatchObject({ outcome: 'sent', sent: 2 });
    expect(made.queues.get(ONE.tenantId)).toEqual([]);
  });

  it('forgets a tenant’s backoff when its setting changes, or when it forwards nowhere any more', async () => {
    const noSink: string[] = [];
    const { forwarder, claimsIn, clock } = cast({ sinkOne: () => Promise.reject(new Error('down')), noSink });
    await forwarder.runOnce();
    clock.advance(1_000);
    await forwarder.runOnce();
    expect(claimsIn('one')).toBe(1);
    // A new destination is tried at once.
    forwarder.forget(ONE.tenantId);
    await forwarder.runOnce();
    expect(claimsIn('one')).toBe(2);
    // Failing again, then forwarding nowhere: the backoff goes with the sink, so a later one starts afresh.
    noSink.push(ONE.tenantId);
    await forwarder.runOnce();
    noSink.length = 0;
    await forwarder.runOnce();
    expect(claimsIn('one')).toBe(3);
  });

  it('answers failed, backing off, when every tenant’s sink is down; a tenant with no sink is never claimed', async () => {
    const { forwarder, claimsIn } = cast({ sink: () => Promise.reject(new Error('down')), noSink: [TWO.tenantId] });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'failed', sent: 0, nextDelayMs: 5_000 });
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

  it('warns, naming the tenant and no event, when a failed send cannot free its lease (Task 17 review M4)', async () => {
    const { forwarder, lines } = cast({ sinkOne: () => Promise.reject(new Error('down')), failRelease: true });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    const freed = lines.filter(
      (line) => line.level === 'warn' && String(line.args[1]).includes('could not free a lease'),
    );
    expect(freed).toHaveLength(1);
    expect(freed[0]!.args[0]).toEqual({ tenantId: ONE.tenantId, reason: 'Error: connection lost' });
    expect(JSON.stringify(lines)).not.toContain('E1');
  });

  it('a batch whose unit failed to commit is not counted as sent, and the failure is logged', async () => {
    const { forwarder, lines } = cast({ failCommit: ONE.tenantId });
    expect(await forwarder.runOnce()).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(lines.filter((line) => line.level === 'warn').map((line) => line.args[1])).toEqual([
      'audit forwarding failing',
    ]);
  });
});
