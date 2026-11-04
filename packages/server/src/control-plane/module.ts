/**
 * The `control-plane` module (hosted edition spec §22, ADR-0039): the tenants' lifecycle and billing. It is
 * registered in every mode for its migration (`0023`, spec §22.3), and serves nothing outside hosted mode. In hosted
 * mode it takes the control role's pool and the Paddle webhook's secret as its factory's arguments, which `serve.ts`
 * passes through {@link withControlPool}, and refuses to register without them: neither is ever on the shared
 * `ServerContext`. It serves the billing webhook on the entry host (spec §22.5), and runs the control loop
 * (§22.15): the grace sweep, its mails and the events' retention.
 */
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { ServerConfig } from '../config.js';
import type { ServerContext, ServerModule } from '../context.js';
import { applySubscriptionEvent, recordUnapplied, type ApplyDeps } from './billing/apply.js';
import type { BillingOutcome, MappedEvent } from './billing/events.js';
import { billingEventsRetentionStep, graceSweepStep } from './billing/sweep.js';
import { registerPaddleWebhook } from './billing/webhook.js';
import type { ControlDb } from './control-db.js';
import { ControlLoop, type LoopStep } from './loop.js';
import { mailStep, type ControlSend } from './mail.js';
import { TenantLifecycle } from './tenants.js';
import type { SetTimer } from '../hooks/env.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';
import { EntryQueue } from '../entry/queue.js';
import { entryHostOf } from '../tenancy/resolve.js';
import { signupCompleter } from './signup/complete.js';
import { signupExpiryStep } from './signup/expiry.js';
import { registerSignupRoutes, renderSignupMail, type SignupMailItem } from './signup/routes.js';

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
  /** How the loop's and the signup's mails go; through the operator's SMTP settings by default. */
  readonly send?: ControlSend;
  /** The signup's mail queue (spec §22.6), for a test that waits for it. */
  readonly onSignupQueue?: (queue: EntryQueue<SignupMailItem>) => void;
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

export function controlPlaneModule(options: ControlPlaneOptions = {}): ServerModule {
  const module: ServerModule = {
    name: NAME,
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
    register: (_app, ctx) => {
      // Nothing outside hosted mode; in hosted mode, the check that the pool was handed over.
      void controlOf(ctx, options.control);
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
      const lifecycle = new TenantLifecycle({
        control,
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      const deps: ApplyDeps = {
        control,
        tenancy: ctx.tenancy,
        lifecycle,
        log: ctx.log,
        completeSignup: signupCompleter({
          control,
          tenancy: ctx.tenancy,
          lifecycle,
          hooks: ctx.hooks,
          license: ctx.license,
          log: ctx.log,
          ...(options.now !== undefined ? { now: options.now } : {}),
        }),
      };
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
      const { smtpUrl, smtpFrom } = ctx.config;
      if (smtpUrl !== undefined && smtpFrom !== undefined) {
        const smtp = { url: smtpUrl, from: smtpFrom };
        const send = options.send ?? ((to, mail) => sendAlertMail(smtp, to, mail));
        const mailHost = new URL(smtpUrl).hostname;
        // Signup (spec §22.6): it mails, so it needs the operator's SMTP settings, which the entry already requires
        // in hosted mode. The mail goes out after the answer, as the entry's does.
        const entryHost = entryHostOf(ctx.config);
        const { paddleEnvironment, paddleClientToken } = ctx.config;
        if (paddleEnvironment === undefined || paddleClientToken === undefined) {
          throw new WirebenchError(
            'control-plane-paddle-missing',
            "hosted mode needs WIREBENCH_SERVER_PADDLE_ENVIRONMENT and WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN: the signup's checkout opens Paddle.js",
          );
        }
        const log = ctx.log;
        const signupMails = new EntryQueue<SignupMailItem>({
          run: async (item) => {
            try {
              await send([item.to], renderSignupMail({ link: item.link, entryHost }));
            } catch {
              // A refusal quotes the recipient, so only the mail host is logged.
              log.warn({ mailHost }, 'a signup message could not be sent');
            }
          },
          log,
        });
        options.onSignupQueue?.(signupMails);
        app.addHook('onClose', () => signupMails.close());
        registerSignupRoutes(app, {
          control,
          entryHost,
          appDomain: entryHost.slice('app.'.length),
          queue: signupMails,
          paddle: { environment: paddleEnvironment, clientToken: paddleClientToken, priceId: teamPriceId },
          ...(now !== undefined ? { now } : {}),
        });
        steps.push(
          mailStep({
            tenancy: ctx.tenancy,
            lifecycle,
            config: ctx.config,
            send,
            log: ctx.log,
            mailHost,
          }),
        );
      }
      steps.push(billingEventsRetentionStep(), signupExpiryStep());
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
