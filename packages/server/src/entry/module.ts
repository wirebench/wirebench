/**
 * The `entry` module (hosted edition spec §21.4, ADR-0038): `app.<app-domain>`, where a person who does not know
 * their team's address asks for it by email. Registered in hosted mode only; a self-hosted server has no such name.
 * It needs the server's SMTP settings, since the page promises a message.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerModule } from '../context.js';
import { registerEntryRoutes } from './routes.js';

export function entryModule(): ServerModule {
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
      registerEntryRoutes(app, { siteUrl: `https://${ctx.config.siteDomain}/` });
      return Promise.resolve();
    },
  };
}
