/**
 * The `custom-domains` module (hosted edition spec §23, ADR-0040): a hosted tenant's one name of its own. It registers
 * the four `/api/v1/tenant/domain` routes and, in hosted mode, the check job on a timer. Self-hosted, the routes answer
 * `404 custom-domains-hosted-only` and no job runs.
 *
 * The migration (`0024`) belongs to no module: `allMigrations` loads `migrations/custom-domains/` with the tenancy
 * migrations, in every mode, so the module has no `migrationsDir` of its own.
 */
import type { ServerModule } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { TenantRateLimiter } from '../identity/rate-limit.js';
import { realTimer } from '../live/module.js';
import { tenantHostsChanged } from '../tenancy/tenancy.js';
import { checkDepsOf, type CheckDepsOverrides } from './deps.js';
import { CHECK_JOB, checkPass, PROBE_EVERY_MS, type CheckDeps } from './job.js';
import { domainRoutes } from './routes.js';

/**
 * How often the job's pass runs: no slower than the probe's cadence (spec §23.4), so a verified name is probed every
 * {@link PROBE_EVERY_MS}. A pass only reads each tenant's claim unless a check or a probe is due.
 */
export const CHECK_EVERY_MS = PROBE_EVERY_MS;

/** `POST …/check`: once a minute per tenant (spec §23.2). */
export const CHECK_NOW_EVERY_MS = 60_000;

export interface CustomDomainsOptions extends CheckDepsOverrides {
  readonly setTimer?: SetTimer;
  /** Tests only: names under `.test` may be claimed. */
  readonly allowTestNames?: boolean;
}

export function customDomainsModule(options: CustomDomainsOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'custom-domains',
    async register(app, ctx) {
      const hosted = ctx.config.mode === 'hosted';
      const license = () => ctx.license;
      let check: CheckDeps | undefined;
      if (hosted) {
        check = await checkDepsOf(
          {
            config: ctx.config,
            tenancy: ctx.tenancy,
            hooks: ctx.hooks,
            license,
            log: ctx.log,
            hostsChanged: () => {
              tenantHostsChanged(ctx.tenancy);
            },
          },
          { ...options, now },
        );
      }
      domainRoutes({
        config: ctx.config,
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        license,
        ...(check !== undefined ? { check } : {}),
        limiter: new TenantRateLimiter({
          name: 'custom-domains',
          capacity: 1,
          refillPerMs: 1 / CHECK_NOW_EVERY_MS,
          db: ctx.tenancy.db,
          ...(options.now !== undefined ? { now: () => now().getTime() } : {}),
        }),
        now,
        ...(options.allowTestNames === true ? { allowTestNames: true } : {}),
      })(app);
      if (check === undefined) return;

      // One pass at a time: the next is armed when the last has finished, so a slow pass never overlaps itself.
      const deps = check;
      let timer: { cancel(): void } | undefined;
      let running: Promise<void> | undefined;
      let closed = false;
      const arm = () => {
        timer = setTimer(tick, CHECK_EVERY_MS);
      };
      function tick(): void {
        running = checkPass(deps)
          .then(
            () => undefined,
            (error: unknown) => {
              ctx.log.warn({ err: error, job: CHECK_JOB }, 'custom domains: the check pass failed');
            },
          )
          .finally(() => {
            running = undefined;
            if (!closed) arm();
          });
      }
      arm();
      app.addHook('onClose', async () => {
        closed = true;
        timer?.cancel();
        await running;
      });
    },
  };
}
