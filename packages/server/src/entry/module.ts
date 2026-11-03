/**
 * The `entry` module (hosted edition spec §21.4, ADR-0038): `app.<app-domain>`, where a person who does not know
 * their team's address asks for it by email. Registered in hosted mode only; a self-hosted server has no such name.
 * It needs the server's SMTP settings, since the page promises a message.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerModule } from '../context.js';
import { entryHostOf } from '../tenancy/resolve.js';
import { EntryQueue } from './queue.js';
import { registerEntryRoutes } from './routes.js';

export interface EntryModuleOptions {
  /** What a queued address leads to; tests replace it. */
  readonly run?: (address: string) => Promise<void>;
  readonly queueLimit?: number;
  readonly now?: () => number;
  /** The module's queue, for a test that waits for it. */
  readonly onQueue?: (queue: EntryQueue) => void;
}

export function entryModule(options: EntryModuleOptions = {}): ServerModule {
  return {
    name: 'entry',
    register: () => Promise.resolve(),
    registerPublic: (app, ctx) => {
      if (ctx.config.mode !== 'hosted') return Promise.resolve();
      if (ctx.config.smtpUrl === undefined || ctx.config.smtpFrom === undefined) {
        throw new WirebenchError(
          'entry-smtp-missing',
          'hosted mode needs WIREBENCH_SERVER_SMTP_URL and WIREBENCH_SERVER_SMTP_FROM: app.<app-domain> mails people the links of their teams',
        );
      }
      if (ctx.config.siteDomain === undefined) {
        throw new WirebenchError('domains-site-domain-missing', 'hosted mode needs WIREBENCH_SERVER_SITE_DOMAIN');
      }
      const queue = new EntryQueue({
        run: options.run ?? (() => Promise.resolve()),
        log: ctx.log,
        ...(options.queueLimit !== undefined ? { limit: options.queueLimit } : {}),
      });
      options.onQueue?.(queue);
      app.addHook('onClose', () => queue.close());
      registerEntryRoutes(app, {
        entryHost: entryHostOf(ctx.config),
        siteUrl: `https://${ctx.config.siteDomain}/`,
        queue,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      return Promise.resolve();
    },
  };
}
