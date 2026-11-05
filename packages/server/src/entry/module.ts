/**
 * The `entry` module (hosted edition spec §21.4, ADR-0038): `app.<app-domain>`, where a person who does not know
 * their team's address asks for it by email. Registered in hosted mode only; a self-hosted server has no such name.
 * It needs the server's SMTP settings, since the page promises a message: `loadConfig` refuses hosted mode without
 * them (`hostedProblems`, spec §22.1), so the check below only guards a configuration a test built directly.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerModule } from '../context.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';
import { entryHostOf } from '../tenancy/resolve.js';
import { primaryUrl } from '../tenancy/urls.js';
import { teamsOf } from './lookup.js';
import { renderEntryMail, type EntryMail } from './mail.js';
import { EntryQueue } from './queue.js';
import { registerEntryRoutes } from './routes.js';

/** Sends one message through the server's SMTP settings; tests replace it. */
export type EntrySend = (
  smtp: { readonly url: string; readonly from: string },
  to: string,
  mail: EntryMail,
) => Promise<void>;

const smtpSend: EntrySend = (smtp, to, mail) => sendAlertMail(smtp, [to], mail);

export interface EntryModuleOptions {
  readonly send?: EntrySend;
  /** What a queued address leads to, in place of the lookup and the mail; tests replace it. */
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
      // Moved into the configuration (spec §22.1), same code; kept for a configuration that did not come from it.
      if (ctx.config.smtpUrl === undefined || ctx.config.smtpFrom === undefined) {
        throw new WirebenchError(
          'entry-smtp-missing',
          'hosted mode needs WIREBENCH_SERVER_SMTP_URL and WIREBENCH_SERVER_SMTP_FROM: app.<app-domain> mails people the links of their teams',
        );
      }
      if (ctx.config.siteDomain === undefined) {
        throw new WirebenchError('domains-site-domain-missing', 'hosted mode needs WIREBENCH_SERVER_SITE_DOMAIN');
      }
      const smtp = { url: ctx.config.smtpUrl, from: ctx.config.smtpFrom };
      const entryHost = entryHostOf(ctx.config);
      const siteUrl = `https://${ctx.config.siteDomain}/`;
      const send = options.send ?? smtpSend;
      const config = ctx.config;
      const log = ctx.log;
      // The lookup and the mail (spec §21.4). The log line holds a count and a time, never the address or a slug.
      const lookUpAndMail = async (address: string): Promise<void> => {
        const started = Date.now();
        const matches = await teamsOf(ctx.tenancy, address, log);
        if (matches.length > 0) {
          const teams = matches.map((match) => ({ name: match.name, url: primaryUrl(config, match.scope) }));
          try {
            await send(smtp, address, renderEntryMail({ teams, entryHost, siteUrl }));
          } catch {
            // A mail server's refusal quotes the recipient ("550 … <someone@…>: Recipient address rejected"), so
            // the error itself is never logged: only the mail host, which names no one.
            log.warn({ mailHost: new URL(smtp.url).hostname }, 'an entry message could not be sent');
          }
        }
        log.info({ matched: matches.length, ms: Date.now() - started }, 'an entry lookup finished');
      };
      const queue = new EntryQueue({
        run: options.run ?? lookUpAndMail,
        log: ctx.log,
        ...(options.queueLimit !== undefined ? { limit: options.queueLimit } : {}),
      });
      options.onQueue?.(queue);
      app.addHook('onClose', () => queue.close());
      registerEntryRoutes(app, {
        entryHost,
        siteUrl,
        queue,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      return Promise.resolve();
    },
  };
}
