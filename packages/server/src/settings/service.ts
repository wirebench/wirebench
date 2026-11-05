/**
 * `ctx.settings` (hosted edition spec §22.12): each tenant's settings, as the modules read them and the API shows them.
 *
 * - **Hosted**, `tenant_settings` is the only source. A tenant's rows are read once, in its unit, opened, and cached
 *   until `tenantSettingsChanged` names it: a write here announces it after it committed, and the bus carries it to
 *   every other instance, whose `cluster` listener drops the same entry. A bus that listens again after a loss may have
 *   missed one, so every entry is dropped then. The environment's SMTP is the fallback sender, its retention values
 *   are each setting's default and maximum, and its budgets are the defaults (§20.7).
 * - **Self-hosted**, the default tenant's settings are the environment and the table is never read: every section
 *   reads as `source: 'environment'`, and a write is refused with `settings-environment`. The SAML provider and the
 *   forward sink are still read from the environment at start-up by their modules, which ask {@link TenantSettings.of}
 *   only in hosted mode.
 *
 * A secret field is opened here for the module that needs it and nowhere else: {@link TenantSettings.view}, what the
 * API answers, shows each as `{ set: boolean }`, and nothing logs a value.
 */
import type { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { ModuleConfig } from '../config.js';
import { announce, cluster, type ServerHooks } from '../context.js';
import type { BusEvents } from '../operations/bus.js';
import { problem } from '../problem.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import {
  OPERATOR_ONLY_SECTIONS,
  SECRET_AGAIN,
  SECTION_INPUTS,
  SETTINGS_SECTIONS,
  keptSecretRedirected,
  resolveSection,
  splitSection,
  splitUrlCredentials,
  viewSection,
  type SectionValues,
  type SettingsSection,
  type SplitSection,
} from './sections.js';
import { openSecret, readSections, removeSection, sealSecret, writeSection } from './store.js';

export type SettingsSource = 'environment' | 'tenant';

/** One section as the API shows it. `value` is `null` when the section is not set. */
export interface SectionState {
  readonly source: SettingsSource;
  /** Whether the caller's role may write it: never in self-hosted mode, and `budgets` only for the operator. */
  readonly writable: boolean;
  readonly value: Readonly<Record<string, unknown>> | null;
  readonly updatedAt?: string;
}

export type SettingsView = { readonly [S in SettingsSection]: SectionState };

/** The retention a tenant's sweeps use: its own values, each at most the operator's (spec §22.12). */
export interface EffectiveRetention {
  readonly auditMaxAgeDays: number;
  readonly hooksMaxAgeDays: number;
  readonly hooksKeep: number;
  readonly schedulesMaxAgeDays: number;
  readonly sessionLogMaxMb: number;
}

/** The budgets a tenant's sends and runs are held to (spec §20.7): its override, else the operator's defaults. */
export interface EffectiveBudgets {
  readonly sendsPerMinute: number;
  /** The sends bucket's capacity: a sixth of the per-minute rate unless set. */
  readonly burst: number;
  readonly concurrentSends: number;
  readonly runSlots: number;
}

export interface SmtpSettings {
  readonly url: string;
  readonly from: string;
}

/** What changed: one tenant's section, one tenant's every section, or (no `tenantId`) every tenant's. */
export interface SettingsChange {
  readonly tenantId?: string;
  readonly section?: SettingsSection;
}

export interface WriteOptions {
  /** Who wrote it, for `updated_by`: a user id, or `operator`. */
  readonly by: string;
  /** The operator's own write (`admin tenant settings`): the only one `budgets` takes. */
  readonly operator?: boolean;
  /** Runs in the write's unit after the row: the audit event, which commits or rolls back with it. */
  readonly within?: (tx: TenantQuerier) => Promise<void>;
}

/**
 * The reads below take `within`, the tenant's unit a caller already has open (the audit hook's, a sweep's, the
 * scheduler's claim): on a cache miss the rows are read through it rather than through a second pooled connection,
 * which a pool full of such units would wait on for ever.
 */
export interface TenantSettings {
  readonly source: SettingsSource;
  /**
   * `section` of `scope`'s tenant with its secrets opened, or `undefined` when it is not set. For a module only:
   * never answer it on the API or log it.
   */
  of<S extends SettingsSection>(
    scope: TenantScope,
    section: S,
    within?: TenantQuerier,
  ): Promise<SectionValues[S] | undefined>;
  /** Every section as the API shows it: plain fields, secrets as `{ set }`. */
  view(scope: TenantScope, options?: { readonly operator?: boolean }): Promise<SettingsView>;
  /**
   * Validates `input` against the section's shape and stores it, sealing its secrets; a secret left out keeps the
   * stored one.
   *
   * @throws WirebenchError `settings-environment` (409) in self-hosted mode; `settings-operator-only` (403) for
   *   `budgets` without `operator`; `settings-invalid` (400) when `input` is not the section's shape.
   */
  set(scope: TenantScope, section: SettingsSection, input: unknown, options: WriteOptions): Promise<void>;
  /** Removes `section`; whether there was one. Refused as {@link set} is. */
  clear(scope: TenantScope, section: SettingsSection, options: WriteOptions): Promise<boolean>;
  retention(scope: TenantScope, within?: TenantQuerier): Promise<EffectiveRetention>;
  budgets(scope: TenantScope, within?: TenantQuerier): Promise<EffectiveBudgets>;
  /** The tenant's own SMTP when it set one, else the operator's, else `undefined`. */
  smtp(scope: TenantScope): Promise<SmtpSettings | undefined>;
  /** Runs `listener` after each change this process learns of: its own writes, another instance's, a missed bus. */
  onChanged(listener: (change: SettingsChange) => void): void;
}

/** Warnings only: a tenant and a section, never a value. */
export interface SettingsLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface TenantSettingsDeps {
  readonly config: ModuleConfig;
  readonly tenancy: Pick<Tenancy, 'db' | 'dataKey'>;
  readonly hooks: ServerHooks;
  readonly bus: BusEvents;
  /** A getter: `buildServer` gives the context its logger after the service is made. */
  readonly log?: () => SettingsLog | undefined;
}

interface Entry {
  readonly value: Readonly<Record<string, unknown>>;
  readonly secret: Readonly<Record<string, string>> | undefined;
  readonly updatedAt: Date;
}

type Loaded = ReadonlyMap<SettingsSection, Entry>;

export const settingsEnvironment = (): WirebenchError =>
  problem(
    'settings-environment',
    'This server’s settings are set by its environment; change them there and restart the server.',
    409,
  );

export const settingsOperatorOnly = (): WirebenchError =>
  problem('settings-operator-only', 'Only the operator of this service can change these settings.', 403);

export const settingsInvalid = (message: string): WirebenchError => problem('settings-invalid', message, 400);

/** The issues of a refused input, by path and rule, never the value. */
function describeIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}

const defaultBurst = (perMinute: number): number => Math.max(1, Math.ceil(perMinute / 6));

const quiet: SettingsLog = { warn: () => undefined };

export function createTenantSettings(deps: TenantSettingsDeps): TenantSettings {
  return deps.config.mode === 'hosted' ? new HostedSettings(deps) : new EnvironmentSettings(deps);
}

/** The environment's values, which hosted mode keeps as defaults and maxima. */
function environmentRetention(config: ModuleConfig): EffectiveRetention {
  return {
    auditMaxAgeDays: config.auditMaxAgeDays,
    hooksMaxAgeDays: config.hooksMaxAgeDays,
    hooksKeep: config.hooksKeep,
    schedulesMaxAgeDays: config.schedulesMaxAgeDays,
    sessionLogMaxMb: config.sessionLogMaxMb,
  };
}

function environmentBudgets(config: ModuleConfig): EffectiveBudgets {
  return {
    sendsPerMinute: config.tenantSendsPerMinute,
    burst: defaultBurst(config.tenantSendsPerMinute),
    concurrentSends: config.tenantConcurrentSends,
    runSlots: config.tenantRunSlots,
  };
}

function environmentSmtp(config: ModuleConfig): SmtpSettings | undefined {
  return config.smtpUrl !== undefined && config.smtpFrom !== undefined
    ? { url: config.smtpUrl, from: config.smtpFrom }
    : undefined;
}

abstract class Base {
  protected readonly listeners: ((change: SettingsChange) => void)[] = [];

  constructor(protected readonly deps: TenantSettingsDeps) {}

  onChanged(listener: (change: SettingsChange) => void): void {
    this.listeners.push(listener);
  }

  protected log(): SettingsLog {
    return this.deps.log?.() ?? quiet;
  }

  protected tell(change: SettingsChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.log().warn({ err: error }, 'a settings listener failed');
      }
    }
  }
}

/** Self-hosted: the environment, read-only. */
class EnvironmentSettings extends Base implements TenantSettings {
  readonly source = 'environment' as const;

  of<S extends SettingsSection>(_scope: TenantScope, section: S): Promise<SectionValues[S] | undefined> {
    const { config } = this.deps;
    let value: SectionValues[SettingsSection] | undefined;
    switch (section) {
      case 'oidc':
        value =
          config.oidcIssuer === undefined || config.oidcClientId === undefined || config.oidcClientSecret === undefined
            ? undefined
            : {
                issuer: config.oidcIssuer,
                clientId: config.oidcClientId,
                clientSecret: config.oidcClientSecret,
                scopes: config.oidcScopes,
                displayName: config.oidcDisplayName,
              };
        break;
      case 'smtp':
        value = environmentSmtp(config);
        break;
      case 'retention':
        value = environmentRetention(config);
        break;
      case 'budgets':
        value = environmentBudgets(config);
        break;
      // The SAML provider and the forward sink are read at start-up by their modules (a file path, a fetched URL).
      default:
        value = undefined;
    }
    return Promise.resolve(value as SectionValues[S] | undefined);
  }

  view(): Promise<SettingsView> {
    const { config } = this.deps;
    const state = (value: Record<string, unknown> | null): SectionState => ({
      source: 'environment',
      writable: false,
      value,
    });
    const smtp = config.smtpUrl === undefined ? undefined : splitUrlCredentials(config.smtpUrl);
    return Promise.resolve({
      oidc: state(
        config.oidcIssuer === undefined
          ? null
          : {
              issuer: config.oidcIssuer,
              clientId: config.oidcClientId ?? null,
              scopes: config.oidcScopes,
              displayName: config.oidcDisplayName,
              clientSecret: { set: config.oidcClientSecret !== undefined },
            },
      ),
      saml: state(
        config.samlIdpMetadata === undefined
          ? null
          : {
              // A file path or a URL, read at start-up: the environment never holds the document itself.
              idpMetadataSource: config.samlIdpMetadata,
              displayName: config.samlDisplayName,
              ...(config.samlEmailAttribute !== undefined ? { emailAttribute: config.samlEmailAttribute } : {}),
              ...(config.samlNameAttribute !== undefined ? { nameAttribute: config.samlNameAttribute } : {}),
              clockSkewSeconds: config.samlClockSkewSeconds,
            },
      ),
      auditForward: state(
        config.auditForwardUrl === undefined
          ? null
          : {
              url: config.auditForwardUrl,
              ...(config.auditForwardCaFile !== undefined ? { caFile: config.auditForwardCaFile } : {}),
              token: { set: config.auditForwardToken !== undefined },
            },
      ),
      smtp: state(
        smtp === undefined
          ? null
          : { url: smtp.bare, from: config.smtpFrom ?? null, credentials: { set: smtp.username !== undefined } },
      ),
      retention: state({ ...environmentRetention(config) }),
      budgets: state({ ...environmentBudgets(config) }),
    });
  }

  set(): Promise<void> {
    return Promise.reject(settingsEnvironment());
  }

  clear(): Promise<boolean> {
    return Promise.reject(settingsEnvironment());
  }

  retention(): Promise<EffectiveRetention> {
    return Promise.resolve(environmentRetention(this.deps.config));
  }

  budgets(): Promise<EffectiveBudgets> {
    return Promise.resolve(environmentBudgets(this.deps.config));
  }

  smtp(): Promise<SmtpSettings | undefined> {
    return Promise.resolve(environmentSmtp(this.deps.config));
  }
}

/** Hosted: the table, cached per tenant and kept in step through the bus. */
class HostedSettings extends Base implements TenantSettings {
  readonly source = 'tenant' as const;
  readonly #cache = new Map<string, Promise<Loaded>>();

  constructor(deps: TenantSettingsDeps) {
    super(deps);
    // `cluster`: this process's own writes and every other instance's both drop the entry here.
    deps.hooks.tenantSettingsChanged.push(
      cluster(({ tenantId, section }) => {
        this.#cache.delete(tenantId);
        this.tell({ tenantId, ...(section !== undefined ? { section: section as SettingsSection } : {}) });
      }),
    );
    deps.bus.onListen(({ reconnected }) => {
      if (!reconnected) return;
      this.#cache.clear();
      this.tell({});
    });
  }

  async of<S extends SettingsSection>(
    scope: TenantScope,
    section: S,
    within?: TenantQuerier,
  ): Promise<SectionValues[S] | undefined> {
    const entry = (await this.#load(scope, within)).get(section);
    return entry === undefined ? undefined : resolveSection(section, entry.value, entry.secret);
  }

  async view(scope: TenantScope, options: { readonly operator?: boolean } = {}): Promise<SettingsView> {
    const loaded = await this.#load(scope);
    const view: Partial<Record<SettingsSection, SectionState>> = {};
    for (const section of SETTINGS_SECTIONS) {
      const entry = loaded.get(section);
      view[section] = {
        source: 'tenant',
        writable: options.operator === true || !OPERATOR_ONLY_SECTIONS.has(section),
        value: entry === undefined ? null : viewSection(section, entry.value, entry.secret),
        ...(entry !== undefined ? { updatedAt: entry.updatedAt.toISOString() } : {}),
      };
    }
    return view as SettingsView;
  }

  async set(scope: TenantScope, section: SettingsSection, input: unknown, options: WriteOptions): Promise<void> {
    if (OPERATOR_ONLY_SECTIONS.has(section) && options.operator !== true) throw settingsOperatorOnly();
    const parsed = SECTION_INPUTS[section].safeParse(input);
    if (!parsed.success)
      throw settingsInvalid(`The ${section} settings are not valid: ${describeIssues(parsed.error)}`);
    const entry = (await this.#load(scope)).get(section);
    if (entry !== undefined && keptSecretRedirected(section, parsed.data as never, entry))
      throw settingsInvalid(SECRET_AGAIN[section]!);
    let split: SplitSection;
    try {
      split = splitSection(section, parsed.data as never, entry?.secret);
    } catch {
      throw settingsInvalid(`The ${section} settings are not valid: the URL does not parse`);
    }
    const sealed =
      split.secret === undefined ? null : sealSecret(await this.deps.tenancy.dataKey(scope), section, split.secret);
    await this.deps.tenancy.db(scope).transaction(async (tx) => {
      await writeSection(tx, { section, value: split.value, sealed, updatedBy: options.by });
      await options.within?.(tx);
    });
    this.#changed(scope, section);
  }

  async clear(scope: TenantScope, section: SettingsSection, options: WriteOptions): Promise<boolean> {
    if (OPERATOR_ONLY_SECTIONS.has(section) && options.operator !== true) throw settingsOperatorOnly();
    const removed = await this.deps.tenancy.db(scope).transaction(async (tx) => {
      const gone = await removeSection(tx, section);
      if (gone) await options.within?.(tx);
      return gone;
    });
    if (removed) this.#changed(scope, section);
    return removed;
  }

  async retention(scope: TenantScope, within?: TenantQuerier): Promise<EffectiveRetention> {
    const maxima = environmentRetention(this.deps.config);
    const own = (await this.of(scope, 'retention', within)) ?? {};
    const clamp = (key: keyof EffectiveRetention): number => Math.min(own[key] ?? maxima[key], maxima[key]);
    return {
      auditMaxAgeDays: clamp('auditMaxAgeDays'),
      hooksMaxAgeDays: clamp('hooksMaxAgeDays'),
      hooksKeep: clamp('hooksKeep'),
      schedulesMaxAgeDays: clamp('schedulesMaxAgeDays'),
      sessionLogMaxMb: clamp('sessionLogMaxMb'),
    };
  }

  async budgets(scope: TenantScope, within?: TenantQuerier): Promise<EffectiveBudgets> {
    const defaults = environmentBudgets(this.deps.config);
    const own = (await this.of(scope, 'budgets', within)) ?? {};
    const sendsPerMinute = own.sendsPerMinute ?? defaults.sendsPerMinute;
    return {
      sendsPerMinute,
      burst: own.burst ?? defaultBurst(sendsPerMinute),
      concurrentSends: own.concurrentSends ?? defaults.concurrentSends,
      runSlots: own.runSlots ?? defaults.runSlots,
    };
  }

  async smtp(scope: TenantScope): Promise<SmtpSettings | undefined> {
    return (await this.of(scope, 'smtp')) ?? environmentSmtp(this.deps.config);
  }

  #changed(scope: TenantScope, section: SettingsSection): void {
    // Dropped here at once too, so this process's next read is the new row whatever the listeners do.
    this.#cache.delete(scope.tenantId);
    announce(
      this.deps.hooks.tenantSettingsChanged,
      { tenantId: scope.tenantId, section },
      this.log() as unknown as FastifyBaseLogger,
    );
  }

  #load(scope: TenantScope, within?: TenantQuerier): Promise<Loaded> {
    let loading = this.#cache.get(scope.tenantId);
    if (loading === undefined) {
      const started = this.#read(scope, within);
      loading = started;
      this.#cache.set(scope.tenantId, started);
      // A failed read is not kept: the next one tries again.
      started.catch(() => {
        if (this.#cache.get(scope.tenantId) === started) this.#cache.delete(scope.tenantId);
      });
    }
    return loading;
  }

  async #read(scope: TenantScope, within: TenantQuerier | undefined): Promise<Loaded> {
    // Through the caller's open unit when it has one (it is this tenant's: its scope is the same), else a unit of its own.
    const rows =
      within !== undefined && within.scope.tenantId === scope.tenantId
        ? await readSections(within)
        : await this.deps.tenancy.db(scope).transaction((tx) => readSections(tx));
    const loaded = new Map<SettingsSection, Entry>();
    let dataKey: Buffer | undefined;
    for (const row of rows) {
      let secret: Record<string, string> | undefined;
      if (row.sealed !== null) {
        try {
          dataKey ??= await this.deps.tenancy.dataKey(scope);
          secret = openSecret(dataKey, row.section, row.sealed);
        } catch (error) {
          // Never the value: the tenant and the section only. The section reads as having no secret.
          this.log().warn(
            { tenantId: scope.tenantId, section: row.section, reason: error instanceof Error ? error.name : 'error' },
            'a tenant setting’s secret does not open; it reads as not set',
          );
        }
      }
      loaded.set(row.section, { value: row.value, secret, updatedAt: row.updatedAt });
    }
    return loaded;
  }
}
