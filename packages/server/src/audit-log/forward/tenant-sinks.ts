/**
 * Each hosted tenant's forward sink (hosted edition spec §22.12), built from its `auditForward` setting on first use
 * and kept until the setting changes on any instance, when the old one is closed. A tenant without the setting has
 * none: its events are neither queued nor sent.
 */
import type { EgressPolicy } from '@wirebench/engine';
import type { TenantSettings } from '../../settings/service.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import type { ForwardSink } from './forwarder.js';
import { sinkFromSettings } from './sink.js';

export class TenantSinks {
  readonly #cache = new Map<string, Promise<ForwardSink | undefined>>();

  constructor(
    private readonly settings: TenantSettings,
    private readonly egress: EgressPolicy,
    /** Builds a sink from a setting; a test's fake, else {@link sinkFromSettings}. */
    private readonly build: typeof sinkFromSettings = sinkFromSettings,
  ) {
    settings.onChanged(({ tenantId }) => {
      for (const id of tenantId === undefined ? [...this.#cache.keys()] : [tenantId]) this.#drop(id);
    });
  }

  /** `within`: the tenant's unit the caller has open, which a settings read on a cache miss goes through. */
  sinkFor(scope: TenantScope, within?: TenantQuerier): Promise<ForwardSink | undefined> {
    let held = this.#cache.get(scope.tenantId);
    if (held === undefined) {
      const made = this.settings
        .of(scope, 'auditForward', within)
        .then((setting) => (setting === undefined ? undefined : this.build(setting, this.egress)));
      held = made;
      this.#cache.set(scope.tenantId, made);
      made.catch(() => {
        if (this.#cache.get(scope.tenantId) === made) this.#cache.delete(scope.tenantId);
      });
    }
    return held;
  }

  /** Whether `scope`'s tenant forwards anywhere: the audit hook queues its events only then. */
  async forwards(scope: TenantScope, within?: TenantQuerier): Promise<boolean> {
    return (await this.settings.of(scope, 'auditForward', within)) !== undefined;
  }

  async close(): Promise<void> {
    const held = [...this.#cache.values()];
    this.#cache.clear();
    for (const sink of await Promise.allSettled(held)) {
      if (sink.status === 'fulfilled') await sink.value?.close().catch(() => undefined);
    }
  }

  #drop(tenantId: string): void {
    const held = this.#cache.get(tenantId);
    this.#cache.delete(tenantId);
    void held?.then((sink) => sink?.close()).catch(() => undefined);
  }
}
