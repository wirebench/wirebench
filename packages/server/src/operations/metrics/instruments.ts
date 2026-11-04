/**
 * The server's instruments (hosted edition spec §20.8's table), and the one object every recording line goes through.
 * Every attribute is made by `attributes.ts`'s builders, so nothing outside its closed set reaches a data point.
 *
 * Over the no-op meter (no endpoint set, `sdk.ts`) every call here does nothing, and an observable's source is never
 * read: nothing collects. So a recording line needs no `if`, and a gauge whose source costs a query (the instance
 * count) costs nothing while metrics are off.
 */
import type { Attributes, Meter, ObservableResult } from '@opentelemetry/api';
import type { ScheduleRunStatus } from '@wirebench/engine';
import {
  BUDGET,
  METHOD,
  methodValue,
  OUTCOME,
  POOL,
  POOLS,
  ROUTE,
  routeValue,
  RUN_STATUS,
  STATUS_CLASS,
  statusClassValue,
  TENANT,
  tenantValue,
  type BudgetName,
  type PoolName,
  type SendOutcome,
} from './attributes.js';

/** The instruments' names, exactly as spec §20.8 lists them. */
export const INSTRUMENTS = {
  httpRequests: 'wirebench.http.requests',
  httpDuration: 'wirebench.http.duration',
  liveSockets: 'wirebench.live.sockets',
  hostInstances: 'wirebench.host.instances',
  sends: 'wirebench.sends',
  budgetRefusals: 'wirebench.budget.refusals',
  scheduleRuns: 'wirebench.schedules.runs',
  repoLockWait: 'wirebench.repo.lock.wait',
  busDropped: 'wirebench.bus.dropped',
  busLag: 'wirebench.bus.lag',
  instances: 'wirebench.instances',
  dbPoolWaiting: 'wirebench.db.pool.waiting',
} as const;

/** What the observable instruments read at each collection; each is set once, by the module that owns the count. */
export interface MetricSources {
  /** Open live sockets, by tenant id. */
  liveSockets?: () => ReadonlyMap<string, number>;
  /** Running host instances, by tenant id. */
  hostInstances?: () => ReadonlyMap<string, number>;
  /** The bus's dropped payloads since start (`NotificationBus.stats().dropped`). */
  busDropped?: () => number;
  /** The live `server_instances` rows (`InstanceRegistry.live()`). */
  instances?: () => Promise<number>;
  /** Requests waiting for a connection, by pool. */
  poolWaiting?: () => Readonly<Record<PoolName, number>>;
}

export interface HttpRequestRecord {
  readonly tenantId: string | undefined;
  /** Fastify's route template (`request.routeOptions.url`), never the URL. */
  readonly route: string | undefined;
  readonly method: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

const tenantOf = (tenantId: string | undefined): Attributes => ({ [TENANT]: tenantValue(tenantId) });

/** Reports each tenant's count from `source`, or nothing when it is not set or throws. */
function observeByTenant(result: ObservableResult, source: (() => ReadonlyMap<string, number>) | undefined): void {
  if (source === undefined) return;
  for (const [tenantId, count] of source()) result.observe(count, tenantOf(tenantId));
}

export class ServerMetrics {
  readonly #sources: MetricSources = {};
  readonly #httpRequests;
  readonly #httpDuration;
  readonly #sends;
  readonly #budgetRefusals;
  readonly #scheduleRuns;
  readonly #repoLockWait;
  readonly #busLag;

  constructor(meter: Meter) {
    this.#httpRequests = meter.createCounter(INSTRUMENTS.httpRequests, { description: 'HTTP requests answered' });
    this.#httpDuration = meter.createHistogram(INSTRUMENTS.httpDuration, {
      description: 'Time to answer an HTTP request',
      unit: 'ms',
    });
    this.#sends = meter.createCounter(INSTRUMENTS.sends, { description: 'Sends charged to a tenant, by outcome' });
    this.#budgetRefusals = meter.createCounter(INSTRUMENTS.budgetRefusals, {
      description: 'Sends refused by a tenant budget',
    });
    this.#scheduleRuns = meter.createCounter(INSTRUMENTS.scheduleRuns, { description: 'Scheduled runs finished' });
    this.#repoLockWait = meter.createHistogram(INSTRUMENTS.repoLockWait, {
      description: 'Time waited for a repository lock',
      unit: 'ms',
    });
    this.#busLag = meter.createHistogram(INSTRUMENTS.busLag, {
      description: 'Time from a bus notification being sent to it being heard',
      unit: 'ms',
    });
    meter
      .createObservableGauge(INSTRUMENTS.liveSockets, { description: 'Open live-update sockets' })
      .addCallback((result) => {
        observeByTenant(result, this.#sources.liveSockets);
      });
    meter
      .createObservableGauge(INSTRUMENTS.hostInstances, { description: 'Running host instances' })
      .addCallback((result) => {
        observeByTenant(result, this.#sources.hostInstances);
      });
    meter
      .createObservableCounter(INSTRUMENTS.busDropped, { description: 'Bus payloads dropped from a full queue' })
      .addCallback((result) => {
        const source = this.#sources.busDropped;
        if (source !== undefined) result.observe(source());
      });
    meter
      .createObservableGauge(INSTRUMENTS.instances, { description: 'Live server instances' })
      .addCallback(async (result) => {
        const source = this.#sources.instances;
        if (source !== undefined) result.observe(await source());
      });
    meter
      .createObservableGauge(INSTRUMENTS.dbPoolWaiting, { description: 'Requests waiting for a database connection' })
      .addCallback((result) => {
        const source = this.#sources.poolWaiting;
        if (source === undefined) return;
        const waiting = source();
        for (const pool of POOLS) result.observe(waiting[pool], { [POOL]: pool });
      });
  }

  /** Sets what an observable instrument reads; a later call replaces it. */
  observe<K extends keyof MetricSources>(key: K, source: NonNullable<MetricSources[K]>): void {
    this.#sources[key] = source;
  }

  httpRequest(record: HttpRequestRecord): void {
    const attributes = {
      [TENANT]: tenantValue(record.tenantId),
      [ROUTE]: routeValue(record.route),
      [METHOD]: methodValue(record.method),
    };
    this.#httpRequests.add(1, { ...attributes, [STATUS_CLASS]: statusClassValue(record.statusCode) });
    this.#httpDuration.record(record.durationMs, attributes);
  }

  send(tenantId: string, outcome: SendOutcome): void {
    this.#sends.add(1, { ...tenantOf(tenantId), [OUTCOME]: outcome });
  }

  budgetRefusal(tenantId: string, budget: BudgetName): void {
    this.#budgetRefusals.add(1, { ...tenantOf(tenantId), [BUDGET]: budget });
  }

  scheduleRun(tenantId: string, status: ScheduleRunStatus): void {
    this.#scheduleRuns.add(1, { ...tenantOf(tenantId), [RUN_STATUS]: status });
  }

  repoLockWait(tenantId: string, ms: number): void {
    this.#repoLockWait.record(ms, tenantOf(tenantId));
  }

  /** A notification heard from another instance, `ms` after it was sent; a clock skew below zero counts as zero. */
  busLag(ms: number): void {
    this.#busLag.record(Math.max(0, ms));
  }
}
