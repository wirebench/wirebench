/**
 * Slice 5 Task 13 (hosted edition spec §20.8): the instruments over an in-memory reader. Each instrument of the table
 * records with exactly its attributes; the process's holder is `service.instance.id`; the attribute sweep allows only
 * the closed set and refuses a URL, an email or a slug; and a request through the server records its route template
 * and its tenant's id, never the URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, deliverRemote } from '../../../src/context.js';
import {
  attributeProblem,
  BUDGET,
  METHOD,
  OUTCOME,
  POOL,
  ROUTE,
  RUN_STATUS,
  STATUS_CLASS,
  TENANT,
} from '../../../src/operations/metrics/attributes.js';
import { INSTRUMENTS } from '../../../src/operations/metrics/instruments.js';
import { buildServer } from '../../../src/server.js';
import { FAKE_DEFAULT_TENANT, testContext } from '../../helpers/context.js';
import { collect, collectingMetrics, sweep } from '../../helpers/metrics.js';

const HOLDER = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();

/** Each instrument's attribute keys, exactly as spec §20.8's table lists them. */
const TABLE: Record<string, readonly string[]> = {
  [INSTRUMENTS.httpRequests]: [TENANT, ROUTE, METHOD, STATUS_CLASS],
  [INSTRUMENTS.httpDuration]: [TENANT, ROUTE, METHOD],
  [INSTRUMENTS.liveSockets]: [TENANT],
  [INSTRUMENTS.hostInstances]: [TENANT],
  [INSTRUMENTS.sends]: [TENANT, OUTCOME],
  [INSTRUMENTS.budgetRefusals]: [TENANT, BUDGET],
  [INSTRUMENTS.scheduleRuns]: [TENANT, RUN_STATUS],
  [INSTRUMENTS.repoLockWait]: [TENANT],
  [INSTRUMENTS.busDropped]: [],
  [INSTRUMENTS.busLag]: [],
  [INSTRUMENTS.instances]: [],
  [INSTRUMENTS.dbPoolWaiting]: [POOL],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the instruments (spec §20.8)', () => {
  it('records every instrument of the table with exactly its attributes', async () => {
    const { handle, reader } = await collectingMetrics(HOLDER);
    const m = handle.metrics;
    m.observe('liveSockets', () => new Map([[T1, 3]]));
    m.observe('hostInstances', () => new Map([[T2, 1]]));
    m.observe('busDropped', () => 4);
    m.observe('instances', () => Promise.resolve(2));
    m.observe('poolWaiting', () => ({ app: 5, lock: 1 }));
    m.httpRequest({ tenantId: T1, route: '/api/v1/workspaces/:id', method: 'GET', statusCode: 204, durationMs: 12 });
    m.send(T1, 'ok');
    m.send(T1, 'refused');
    m.budgetRefusal(T1, 'sends');
    m.scheduleRun(T2, 'passed');
    m.repoLockWait(T2, 30);
    m.busLag(7);
    const { points } = await collect(reader);
    expect([...points.keys()].sort()).toEqual(Object.values(INSTRUMENTS).sort());
    for (const [name, keys] of Object.entries(TABLE)) {
      for (const point of points.get(name)!) {
        expect(Object.keys(point.attributes).sort(), name).toEqual([...keys].sort());
      }
    }
    expect(points.get(INSTRUMENTS.httpRequests)![0]!.attributes).toEqual({
      [TENANT]: T1,
      [ROUTE]: '/api/v1/workspaces/:id',
      [METHOD]: 'GET',
      [STATUS_CLASS]: '2xx',
    });
    expect(points.get(INSTRUMENTS.sends)!.map((p) => [p.attributes[OUTCOME], p.value])).toEqual([
      ['ok', 1],
      ['refused', 1],
    ]);
    expect(points.get(INSTRUMENTS.liveSockets)![0]).toMatchObject({ attributes: { [TENANT]: T1 }, value: 3 });
    expect(points.get(INSTRUMENTS.hostInstances)![0]).toMatchObject({ attributes: { [TENANT]: T2 }, value: 1 });
    expect(points.get(INSTRUMENTS.busDropped)![0]!.value).toBe(4);
    expect(points.get(INSTRUMENTS.instances)![0]!.value).toBe(2);
    expect(points.get(INSTRUMENTS.dbPoolWaiting)!.map((p) => [p.attributes[POOL], p.value])).toEqual([
      ['app', 5],
      ['lock', 1],
    ]);
    expect(points.get(INSTRUMENTS.scheduleRuns)![0]!.attributes).toEqual({ [TENANT]: T2, [RUN_STATUS]: 'passed' });
    expect(points.get(INSTRUMENTS.budgetRefusals)![0]!.attributes).toEqual({ [TENANT]: T1, [BUDGET]: 'sends' });
    expect(sweep(points)).toEqual([]);
    await handle.shutdown();
  });

  it('names the process by its holder, its version and the default service name', async () => {
    const { handle, reader } = await collectingMetrics(HOLDER, '9.9.9');
    const { resource } = await collect(reader);
    expect(resource.attributes['service.instance.id']).toBe(HOLDER);
    expect(resource.attributes['service.version']).toBe('9.9.9');
    expect(resource.attributes['service.name']).toBe('wirebench-server');
    await handle.shutdown();
  });

  it('takes the operator’s service name and resource attributes, but never in place of the holder', async () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'acme-server');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'deployment.environment=prod,service.instance.id=spoofed');
    const { handle, reader } = await collectingMetrics(HOLDER);
    const { resource } = await collect(reader);
    expect(resource.attributes['service.name']).toBe('acme-server');
    expect(resource.attributes['deployment.environment']).toBe('prod');
    expect(resource.attributes['service.instance.id']).toBe(HOLDER);
    await handle.shutdown();
  });

  it('turns anything out of shape into its closed value: no slug, URL, email or unknown method is recorded', async () => {
    const { handle, reader } = await collectingMetrics(HOLDER);
    handle.metrics.httpRequest({
      tenantId: 'acme-secret',
      route: 'https://acme.example/x?token=s3cret',
      method: 'BREW',
      statusCode: 999,
      durationMs: 1,
    });
    handle.metrics.httpRequest({
      tenantId: undefined,
      route: '/u/ana@example.com',
      method: 'GET',
      statusCode: 404,
      durationMs: 1,
    });
    handle.metrics.send('acme-secret', 'ok');
    const { points } = await collect(reader);
    expect(sweep(points)).toEqual([]);
    const values = [...points.values()].flatMap((list) => list.flatMap((p) => Object.values(p.attributes)));
    for (const leaked of ['acme', 'token', 's3cret', 'example', 'BREW']) {
      expect(values.join(' ')).not.toContain(leaked);
    }
    expect(points.get(INSTRUMENTS.httpRequests)!.map((p) => p.attributes)).toEqual([
      { [TENANT]: 'none', [ROUTE]: 'unmatched', [METHOD]: '_OTHER', [STATUS_CLASS]: '5xx' },
      { [TENANT]: 'none', [ROUTE]: 'unmatched', [METHOD]: 'GET', [STATUS_CLASS]: '4xx' },
    ]);
    await handle.shutdown();
  });
});

describe('the attribute sweep (spec §20.8)', () => {
  it('fails on a key outside the closed set, or a value shaped like a URL, an email or a slug', () => {
    expect(attributeProblem('user.email', 'x')).toMatch(/not one of/);
    expect(attributeProblem('http.url', '/x')).toMatch(/not one of/);
    expect(attributeProblem(TENANT, 'acme-corp')).toMatch(/out of its shape/);
    expect(attributeProblem(TENANT, 'Acme Corp')).toMatch(/out of its shape/);
    expect(attributeProblem(ROUTE, 'https://acme.example/x')).toMatch(/URL or an email/);
    expect(attributeProblem(ROUTE, '//acme.example/x')).toMatch(/URL or an email/);
    expect(attributeProblem(ROUTE, '/x?token=1')).toMatch(/URL or an email/);
    expect(attributeProblem(ROUTE, '/u/ana@example.com')).toMatch(/URL or an email/);
    expect(attributeProblem(OUTCOME, 'maybe')).toMatch(/out of its shape/);
    expect(attributeProblem(BUDGET, 'acme-sends')).toMatch(/out of its shape/);
    expect(attributeProblem(TENANT, T1)).toBeUndefined();
    expect(attributeProblem(TENANT, 'none')).toBeUndefined();
    expect(attributeProblem(ROUTE, '/api/v1/workspaces/:workspaceId/sync/head')).toBeUndefined();
    expect(attributeProblem(ROUTE, '/hooks/*')).toBeUndefined();
  });
});

describe('the HTTP instruments through the server (spec §20.8)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wbs-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records the route template and the tenant’s id, `none` on an unscoped route, and never the URL', async () => {
    const { handle, reader } = await collectingMetrics(HOLDER);
    const ctx = await testContext({ dataDir, metrics: handle.metrics });
    const app = await buildServer(ctx, {
      modules: [
        {
          name: 'identity',
          register: (api) => {
            api.get('/things/:thingId', () => Promise.resolve({ ok: true }));
            return Promise.resolve();
          },
        },
      ],
    });
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/api/v1/things/01J8ZC5Q0V7R3T9XK2M4N6P8QA?token=s3cret' });
    await app.inject({ method: 'GET', url: '/nowhere/ana@example.com?secret=1' });
    const { points } = await collect(reader);
    expect(sweep(points)).toEqual([]);
    const requests = points.get(INSTRUMENTS.httpRequests)!.map((p) => p.attributes);
    expect(requests).toEqual(
      expect.arrayContaining([
        { [TENANT]: 'none', [ROUTE]: '/healthz', [METHOD]: 'GET', [STATUS_CLASS]: '2xx' },
        {
          [TENANT]: FAKE_DEFAULT_TENANT.id,
          [ROUTE]: '/api/v1/things/:thingId',
          [METHOD]: 'GET',
          [STATUS_CLASS]: '2xx',
        },
        { [TENANT]: FAKE_DEFAULT_TENANT.id, [ROUTE]: 'unmatched', [METHOD]: 'GET', [STATUS_CLASS]: '4xx' },
      ]),
    );
    expect(requests).toHaveLength(3);
    expect(points.get(INSTRUMENTS.httpDuration)).toHaveLength(3);
    await app.close();
    await handle.shutdown();
  });

  it('counts each scheduled run this process finished, and not another instance’s', async () => {
    const { handle, reader } = await collectingMetrics(HOLDER);
    const ctx = await testContext({ dataDir, metrics: handle.metrics });
    const app = await buildServer(ctx, { modules: [] });
    const event = {
      tenantId: T1,
      workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
      scheduleId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
      runId: '01J8ZC5Q0V7R3T9XK2M4N6P8QC',
      status: 'failed',
    } as const;
    announce(ctx.hooks.scheduleRunFinished, event, app.log);
    // As the bus delivers a peer's: `remote` and `cluster` listeners only.
    deliverRemote(ctx.hooks.scheduleRunFinished, event, app.log);
    const { points } = await collect(reader);
    expect(points.get(INSTRUMENTS.scheduleRuns)!.map((p) => [p.attributes, p.value])).toEqual([
      [{ [TENANT]: T1, [RUN_STATUS]: 'failed' }, 1],
    ]);
    await app.close();
    await handle.shutdown();
  });
});

describe('the SDK’s place (spec §20.8)', () => {
  it('is imported only under src/operations/metrics/', () => {
    const src = join(import.meta.dirname, '../../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          path.endsWith('.ts') &&
          !path.includes(join('operations', 'metrics')) &&
          readFileSync(path, 'utf8').includes("'@opentelemetry/")
        )
          offenders.push(path);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
