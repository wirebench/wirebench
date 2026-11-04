/**
 * The check's dependencies as production builds them (hosted edition spec §23.2, §23.4): DNS through the configured
 * servers, the certificate probe the configuration asks for, the server's SMTP sender and the tenant's features from
 * its license state. The module and the admin command both build them here, so `admin domains check` checks a name
 * exactly as the job and `POST …/check` do. Each part can be replaced, for a test.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleConfig } from '../config.js';
import type { LicenseService, ServerHooks } from '../context.js';
import { tenantStopped } from '../tenancy/directory.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { systemLookup, type DnsLookup } from './dns.js';
import type { CertificateProbe, CheckDeps } from './job.js';
import { smtpMailer, type Mailer } from './mail.js';
import { probeFromConfig } from './probe.js';

export interface CheckDepsOverrides {
  readonly now?: () => Date;
  readonly lookup?: DnsLookup;
  /** `null`: no probe, so a verified name waits in `verified`. Omitted: the one the configuration asks for. */
  readonly probe?: CertificateProbe | null;
  /** `null`: nothing is mailed. Omitted: the server's SMTP sender, when one is set. */
  readonly mail?: Mailer | null;
}

export interface CheckDepsInput {
  readonly config: Pick<
    ModuleConfig,
    'mode' | 'appDomain' | 'dnsServers' | 'proxyTlsAddress' | 'proxyTlsCaFile' | 'smtpUrl' | 'smtpFrom'
  >;
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  readonly hooks: ServerHooks;
  /** Read at each check, not once: the licensing module replaces `ctx.license` when it registers. */
  readonly license: () => LicenseService;
  readonly log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
  /** After a name was made live, not live, or released: reloads every instance's tenant map (spec §23.5). */
  readonly hostsChanged?: () => void;
}

/**
 * The deps of {@link CheckDeps} for `input`, with `overrides` in place of any part.
 *
 * @throws Error when `WIREBENCH_SERVER_PROXY_TLS_CA_FILE` cannot be read (`probeFromConfig`).
 */
export async function checkDepsOf(input: CheckDepsInput, overrides: CheckDepsOverrides = {}): Promise<CheckDeps> {
  const { config } = input;
  if (config.appDomain === undefined) throw new Error('custom domains need WIREBENCH_SERVER_APP_DOMAIN');
  const probe = overrides.probe === undefined ? await probeFromConfig(config) : (overrides.probe ?? undefined);
  const mail = overrides.mail === undefined ? smtpMailer(config) : (overrides.mail ?? undefined);
  return {
    tenancy: input.tenancy,
    lookup: overrides.lookup ?? systemLookup(config.dnsServers),
    appDomain: config.appDomain,
    now: overrides.now ?? (() => new Date()),
    hooks: input.hooks,
    features: async (scope) => (await input.license().state(scope)).features,
    stopped: tenantStopped,
    ...(probe !== undefined ? { probe } : {}),
    ...(mail !== undefined ? { mail } : {}),
    log: input.log,
    ...(input.hostsChanged !== undefined ? { hostsChanged: input.hostsChanged } : {}),
  };
}
