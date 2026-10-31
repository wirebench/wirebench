/**
 * An alert's run link is its tenant's URL (hosted edition spec §19.5; Task 13 review I1): built from the real
 * `schedulesSettings`, never a stub, in a unit of each of two tenants on a hosted server.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { enqueueAlerts } from '../../../src/schedules/alerts/outbox.js';
import { schedulesSettings } from '../../../src/schedules/settings.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantQuerier } from '../../../src/tenancy/tenant-db.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};
const ACME = scopeOf({ id: '00000000-0000-4000-8000-0000000000a1', slug: 'acme' });
const GLOBEX = scopeOf({ id: '00000000-0000-4000-8000-0000000000b2', slug: 'globex' });

/** A unit of `scope` that answers the schedule's read and keeps the payloads it is asked to insert. */
function unitOf(scope: TenantScope) {
  const payloads: { run: { url: string } }[] = [];
  const tx = {
    scope,
    query: (text: string, params: readonly unknown[] = []) => {
      if (text.includes('from schedules s join workspaces')) {
        return Promise.resolve({
          rows: [
            {
              name: 'Nightly',
              workspaceId: 'W1',
              workspaceName: 'Payments',
              project: 'Billing',
              alerts: { targets: [{ kind: 'webhook' }], muteAfter: 3 },
              alertState: 'ok',
              failureStreak: 0,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('insert into schedule_alert_outbox')) {
        payloads.push(JSON.parse(params[5] as string) as { run: { url: string } });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as TenantQuerier;
  return { tx, payloads };
}

const failedRun = {
  id: 'R1',
  status: 'failed' as const,
  reason: null,
  commit: null,
  environment: 'prod',
  summary: null,
  results: [],
};

describe('an alert’s run link', () => {
  it('hosted: each tenant’s alert links to that tenant’s own host', async () => {
    const config = { ...loadConfig(required, '0.0.0-test'), mode: 'hosted' as const, appDomain: 'example.test' };
    const env = { settings: schedulesSettings(config), now: () => new Date('2026-10-31T00:00:00Z') };
    for (const scope of [ACME, GLOBEX]) {
      const { tx, payloads } = unitOf(scope);
      expect(await enqueueAlerts(tx, env, 'S1', failedRun)).toBe(1);
      expect(payloads.map((payload) => payload.run.url)).toEqual([
        `https://${scope.slug}.example.test/api/v1/workspaces/W1/schedules/S1/runs/R1`,
      ]);
    }
  });

  it('self-hosted: the public URL, for any tenant', async () => {
    const env = {
      settings: schedulesSettings(loadConfig(required, '0.0.0-test')),
      now: () => new Date('2026-10-31T00:00:00Z'),
    };
    const { tx, payloads } = unitOf(ACME);
    await enqueueAlerts(tx, env, 'S1', failedRun);
    expect(payloads[0]!.run.url).toBe('https://wirebench.example.com/api/v1/workspaces/W1/schedules/S1/runs/R1');
  });
});
