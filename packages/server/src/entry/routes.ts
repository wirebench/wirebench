/**
 * The entry's routes (hosted edition spec §21.4), on `app.<app-domain>` only (`ENTRY_ROUTE`). `GET /` is the page.
 * Nothing sets a cookie and nothing signs anyone in.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ENTRY_ROUTE } from '../tenancy/resolve.js';
import { ENTRY_PAGE_CSP, renderEntryPage } from './page.js';

export interface EntryRoutesOptions {
  /** `https://<site-domain>/`. */
  readonly siteUrl: string;
}

export function registerEntryRoutes(app: FastifyInstance, options: EntryRoutesOptions): void {
  const page = (reply: FastifyReply, answered: boolean): FastifyReply =>
    reply
      .code(200)
      .header('content-security-policy', ENTRY_PAGE_CSP)
      .header('referrer-policy', 'same-origin')
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderEntryPage({ siteUrl: options.siteUrl, answered }));

  app.get('/', ENTRY_ROUTE, (_request, reply) => page(reply, false));
}
