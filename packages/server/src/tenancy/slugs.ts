/**
 * Tenant slugs (hosted edition spec §3.6, §19.2, §21.2): the syntax `tenants.slug` checks, and the names no tenant
 * may take. The list is a frozen literal so start-up imports nothing for it; a unit test keeps it in step with the
 * app's areas and protocol kinds. It is checked on every slug write, never by the database: the list changes with the
 * app, and an existing tenant whose slug a later list reserves keeps it.
 */

/** The `tenants.slug` check of migration `0020`: 3–40 characters, `[a-z0-9-]`, no `-` at either end. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // §3.6
  'app',
  'api',
  'www',
  'docs',
  'status',
  'admin',
  'agent',
  'mail',
  'help',
  'support',
  'billing',
  'login',
  'signup',
  // the areas
  'explorer',
  'environments',
  'search',
  'history',
  'wss',
  'ssh',
  // the protocol kinds, and protocol names that are not kinds of their own
  'soap',
  'rest',
  'grpc',
  'ws',
  'websocket',
  'mcp',
  'graphql',
  'http',
  'https',
  'telnet',
  'serial',
  'sftp',
  // infrastructure
  'mx',
  'smtp',
  'imap',
  'pop',
  'ns1',
  'ns2',
  'cdn',
  'static',
  'assets',
  'autoconfig',
  'autodiscover',
  'dev',
  'staging',
  'test',
  'default',
  // brand
  'wirebench',
  'verathic',
]);

export type SlugCheck = 'ok' | 'slug-invalid' | 'slug-reserved';

/** Whether `slug` may be written for a new tenant: §19.2's syntax first, then the reserved list. */
export function checkSlug(slug: string): SlugCheck {
  if (!SLUG_PATTERN.test(slug)) return 'slug-invalid';
  return RESERVED_SLUGS.has(slug) ? 'slug-reserved' : 'ok';
}
