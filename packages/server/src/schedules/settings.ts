/** The scheduled-runs module's configuration (scheduled-runs spec §7), read once at registration. */
import type { ModuleConfig } from '../config.js';
import type { TenantScope } from '../tenancy/scope.js';
import { tenantUrl } from '../tenancy/urls.js';

const MIB = 1024 * 1024;

export interface SchedulesSettings {
  /** `false`: neither the scheduler nor the routes exist. */
  readonly enabled: boolean;
  /** Seals secrets and alert URLs; absent, they are refused. */
  readonly secretKey?: Buffer;
  readonly concurrency: number;
  readonly maxAgeDays: number;
  readonly maxSnapshotBytes: number;
  /** Hosts Slack, Teams and webhook alerts may go to; absent, any https host. */
  readonly alertHosts?: readonly string[];
  /** Email alerts; absent, an email target is refused. */
  readonly smtp?: { readonly url: string; readonly from: string };
  /** The origin of the run link in an alert: the run's tenant's URL (spec §19.5). */
  readonly linkUrl: (scope: TenantScope) => string;
}

export function schedulesSettings(config: ModuleConfig): SchedulesSettings {
  return {
    enabled: config.schedulesEnabled,
    ...(config.schedulesSecretKey !== undefined ? { secretKey: Buffer.from(config.schedulesSecretKey, 'base64') } : {}),
    concurrency: config.schedulesConcurrency,
    maxAgeDays: config.schedulesMaxAgeDays,
    maxSnapshotBytes: config.schedulesMaxSnapshotMb * MIB,
    ...(config.schedulesAlertHosts !== undefined ? { alertHosts: config.schedulesAlertHosts } : {}),
    ...(config.smtpUrl !== undefined && config.smtpFrom !== undefined
      ? { smtp: { url: config.smtpUrl, from: config.smtpFrom } }
      : {}),
    linkUrl: (scope) => tenantUrl(config, scope),
  };
}

/** Whether alerts may go to `host` under the allow-list: an exact name, or `*.domain` for it and below. */
export function alertHostAllowed(settings: Pick<SchedulesSettings, 'alertHosts'>, host: string): boolean {
  const allowed = settings.alertHosts;
  if (allowed === undefined) {
    return true;
  }
  const name = host.toLowerCase();
  return allowed.some((pattern) =>
    pattern.startsWith('*.') ? name === pattern.slice(2) || name.endsWith(pattern.slice(1)) : name === pattern,
  );
}
