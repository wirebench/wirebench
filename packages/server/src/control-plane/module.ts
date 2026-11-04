/**
 * The `control-plane` module (hosted edition spec §22, ADR-0039): the tenants' lifecycle and billing. It is
 * registered in every mode for its migration (`0023`, spec §22.3), and serves nothing outside hosted mode. In hosted
 * mode it takes the control role's pool and the Paddle webhook's secret as its factory's arguments, which `serve.ts`
 * passes through {@link withControlPool}, and refuses to register without them: neither is ever on the shared
 * `ServerContext`. It serves the billing webhook on the entry host (spec §22.5), and runs the control loop
 * (§22.15): the grace sweep, its mails, the tenants' exports and deletions, and the events' retention.
 *
 * A tenant's export (§22.9) is the one thing it does in every mode: a self-hosted server, which has no control loop,
 * runs the queued exports from a timer of the module's own, over its one tenant.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { WirebenchError } from '@wirebench/engine';
import type { ServerConfig } from '../config.js';
import type { ServerContext, ServerModule } from '../context.js';
import { chainKeys } from '../audit-log/chain/keys.js';
import { isDefaultTenant } from '../tenancy/tenancy.js';
import { realTimer } from '../live/module.js';
import { applySubscriptionEvent, recordUnapplied, type ApplyDeps } from './billing/apply.js';
import type { BillingOutcome, MappedEvent } from './billing/events.js';
import { billingEventsRetentionStep, graceSweepStep } from './billing/sweep.js';
import { registerPaddleWebhook } from './billing/webhook.js';
import type { ControlDb } from './control-db.js';
import { TenantDeletion } from './delete.js';
import { ExportRunner, exportsStep } from './export/runner.js';
import { CONTROL_LOOP_MS, ControlLoop, type LoopStep } from './loop.js';
import { mailStep, type ControlSend } from './mail.js';
import { tenantRoutes } from './tenant-routes.js';
import { TenantLifecycle } from './tenants.js';
import type { SetTimer } from '../hooks/env.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';

/** Migration `0023`: the tenants' new columns, the control tables and the three scoped ones. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control-plane/', import.meta.url));

const NAME = 'control-plane';

export interface ControlPlaneOptions {
  /** The control role's pool, hosted mode only: `serve.ts` opens it. */
  readonly control?: ControlDb;
  /** The Paddle notification destination's secret (spec §22.5, §22.16), which `serve.ts` hands over with the pool. */
  readonly paddleWebhookSecret?: string;
  readonly now?: () => Date;
  /** What the webhook applies a verified event with; tests replace it. */
  readonly apply?: (mapped: MappedEvent) => Promise<BillingOutcome>;
  /** The control loop's timer (spec §22.15); tests fire it by hand. */
  readonly setTimer?: SetTimer;
  /** `false` keeps the loop from arming, for a test that runs no pass. */
  readonly startLoop?: boolean;
  /** How the loop's mails go; through the operator's SMTP settings by default. */
  readonly send?: ControlSend;
}

/** Each module's options, so {@link withControlPool} can rebuild it with the pool and keep what a test gave it. */
const optionsOf = new WeakMap<ServerModule, ControlPlaneOptions>();

/**
 * The control pool in hosted mode, or `undefined` on a self-hosted server.
 *
 * @throws WirebenchError `control-plane-control-db-missing` in hosted mode without one
 */
function controlOf(ctx: ServerContext, control: ControlDb | undefined): ControlDb | undefined {
  if (ctx.config.mode !== 'hosted') return undefined;
  if (control === undefined) {
    throw new WirebenchError(
      'control-plane-control-db-missing',
      "hosted mode needs the control role's pool (WIREBENCH_SERVER_CONTROL_DATABASE_URL), which serve opens",
    );
  }
  return control;
}

/** The operator's SMTP settings as the control plane sends with them; `undefined` without them. */
function mailOf(ctx: ServerContext, options: ControlPlaneOptions): { send: ControlSend; mailHost: string } | undefined {
  const { smtpUrl, smtpFrom } = ctx.config;
  if (smtpUrl === undefined || smtpFrom === undefined) return undefined;
  const smtp = { url: smtpUrl, from: smtpFrom };
  return {
    send: options.send ?? ((to, mail) => sendAlertMail(smtp, to, mail)),
    mailHost: new URL(smtpUrl).hostname,
  };
}

/** The exports' runner (spec §22.9), on the context's repositories and git, with each tenant's chain key. */
function exportRunnerOf(ctx: ServerContext, options: ControlPlaneOptions): ExportRunner {
  const configured = ctx.config.auditChainKey;
  const keys =
    configured === undefined
      ? undefined
      : chainKeys(configured, ctx.config.mode, (scope) => isDefaultTenant(ctx.tenancy, scope));
  const mail = mailOf(ctx, options);
  return new ExportRunner({
    db: ctx.tenancy.db,
    repos: ctx.repos,
    git: ctx.git.withPlumbing(),
    dataDir: ctx.config.dataDir,
    version: ctx.config.version,
    chainKeyOf: (scope) => keys?.(scope),
    hooks: ctx.hooks,
    log: ctx.log,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(mail !== undefined ? { mail: { ...mail, config: ctx.config } } : {}),
  });
}

/**
 * A self-hosted server's export job (spec §22.9): every {@link CONTROL_LOOP_MS}, through the job loop, each tenant
 * with an export to run or expire gets one run after its unit. The control loop does this in hosted mode.
 */
function selfHostedExports(
  app: FastifyInstance,
  ctx: ServerContext,
  runner: ExportRunner,
  options: ControlPlaneOptions,
): void {
  const setTimer = options.setTimer ?? realTimer;
  let armed: { cancel(): void } | undefined;
  let running: Promise<unknown> | undefined;
  let closed = false;
  const pass = () =>
    ctx.tenancy.forEachTenant(
      'tenant-exports',
      async (tx, scope) =>
        (await runner.hasWork(tx))
          ? {
              afterUnit: async () => {
                await runner.sweep(scope);
                await runner.runNext(scope);
              },
            }
          : undefined,
      ctx.log,
    );
  const arm = (): void => {
    if (closed) return;
    armed = setTimer(() => {
      armed = undefined;
      running = pass()
        .catch(() => {
          ctx.log.error({ job: 'tenant-exports' }, 'an export pass failed');
        })
        .finally(() => {
          running = undefined;
          arm();
        });
    }, CONTROL_LOOP_MS);
  };
  if (options.startLoop !== false) arm();
  app.addHook('onClose', async () => {
    closed = true;
    armed?.cancel();
    await running;
  });
}

export function controlPlaneModule(options: ControlPlaneOptions = {}): ServerModule {
  // One per server: the routes (register) and the control loop (registerPublic) share it.
  const runners = new WeakMap<ServerContext, ExportRunner>();
  const runnerOf = (ctx: ServerContext): ExportRunner => {
    let runner = runners.get(ctx);
    if (runner === undefined) {
      runner = exportRunnerOf(ctx, options);
      runners.set(ctx, runner);
    }
    return runner;
  };
  const lifecycles = new WeakMap<ServerContext, TenantLifecycle>();
  const lifecycleOf = (ctx: ServerContext, control: ControlDb): TenantLifecycle => {
    let lifecycle = lifecycles.get(ctx);
    if (lifecycle === undefined) {
      lifecycle = new TenantLifecycle({
        control,
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      lifecycles.set(ctx, lifecycle);
    }
    return lifecycle;
  };
  const module: ServerModule = {
    name: NAME,
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
    register: (app, ctx) => {
      // In hosted mode, the check that the pool was handed over; its loop runs the exports there.
      const control = controlOf(ctx, options.control);
      if (control === undefined) selfHostedExports(app, ctx, runnerOf(ctx), options);
      // The tenant's own routes (spec §22.9, §22.11): the exports on every server, billing and deletion hosted.
      tenantRoutes({
        db: ctx.tenancy.db,
        runner: runnerOf(ctx),
        ...(control !== undefined ? { lifecycle: lifecycleOf(ctx, control) } : {}),
        now: options.now ?? (() => new Date()),
      })(app);
      return Promise.resolve();
    },
    registerPublic: (app, ctx) => {
      const control = controlOf(ctx, options.control);
      if (control === undefined) return Promise.resolve();
      const secret = options.paddleWebhookSecret;
      const teamPriceId = ctx.config.paddleTeamPriceId;
      if (secret === undefined || teamPriceId === undefined) {
        throw new WirebenchError(
          'control-plane-paddle-missing',
          'hosted mode needs WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET and WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID',
        );
      }
      const lifecycle = lifecycleOf(ctx, control);
      const deps: ApplyDeps = { control, tenancy: ctx.tenancy, lifecycle, log: ctx.log };
      const apply =
        options.apply ??
        ((mapped: MappedEvent) =>
          mapped.kind === 'unapplied'
            ? recordUnapplied(deps, mapped.event)
            : applySubscriptionEvent(deps, mapped.event));
      const now = options.now;
      registerPaddleWebhook(app, {
        secret,
        teamPriceId,
        apply,
        ...(now !== undefined ? { now: () => now().getTime() } : {}),
      });
      // The control loop (spec §22.15). Later parts add their steps to this list.
      const steps: LoopStep[] = [graceSweepStep(lifecycle)];
      const mail = mailOf(ctx, options);
      if (mail !== undefined) {
        steps.push(
          mailStep({
            tenancy: ctx.tenancy,
            lifecycle,
            config: ctx.config,
            send: mail.send,
            log: ctx.log,
            mailHost: mail.mailHost,
          }),
        );
      }
      steps.push(exportsStep(runnerOf(ctx), (id) => lifecycle.tenantScope(id)));
      // Due deletions (spec §22.11), after the grace sweep and the exports, so a pass never exports a tenant it deletes.
      steps.push(
        new TenantDeletion({
          control,
          db: ctx.tenancy.db,
          lifecycle,
          dataDir: ctx.config.dataDir,
          log: ctx.log,
        }).step(),
      );
      steps.push(billingEventsRetentionStep());
      const loop = new ControlLoop({
        control,
        steps,
        log: ctx.log,
        ...(now !== undefined ? { now } : {}),
        ...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
      });
      if (options.startLoop !== false) loop.start();
      app.addHook('onClose', () => loop.close());
      return Promise.resolve();
    },
  };
  optionsOf.set(module, options);
  return module;
}

/**
 * `modules` with the control-plane entry built on `control` and the webhook secret (spec §22.2, §22.16): how
 * `serve.ts` hands both over, to this one module. Every other entry is returned as it was; without a pool
 * (self-hosted mode) the list is unchanged.
 */
export function withControlPool(
  modules: readonly ServerModule[],
  control: ControlDb | undefined,
  secrets: Pick<ServerConfig, 'paddleWebhookSecret'> = {},
): ServerModule[] {
  if (control === undefined) return [...modules];
  return modules.map((module) =>
    module.name === NAME
      ? controlPlaneModule({
          ...optionsOf.get(module),
          control,
          ...(secrets.paddleWebhookSecret !== undefined ? { paddleWebhookSecret: secrets.paddleWebhookSecret } : {}),
        })
      : module,
  );
}
