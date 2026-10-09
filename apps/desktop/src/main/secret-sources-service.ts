/**
 * The desktop end of secret sources (secret sources spec D6): one cache for the app, wrapped around every
 * send's getter chain. The mapping and the approval are read from the open workspace when a secret is
 * asked for, so a getter built before an approval still sees it; `noteChange` drops cached values when
 * the mapping, the overrides or the approval change.
 */

import {
  createSourceCache,
  effectiveSecretSources,
  secretPseudoRef,
  secretSourcesHash,
  sourceGetter,
  WirebenchError,
  type FindSourceTool,
  type GetSecret,
  type LocalSecretSources,
  type RunSourceTool,
  type SharedSecretSources,
} from '@wirebench/engine';

export interface SecretSourcesSnapshot {
  readonly shared: SharedSecretSources | undefined;
  readonly local: LocalSecretSources | undefined;
  readonly approvedHash: string | undefined;
}

export interface SecretSourcesServiceDeps {
  /** The open workspace's mapping, overrides and approval; `undefined` when no workspace is open. */
  readonly snapshot: () => SecretSourcesSnapshot | undefined;
  readonly cacheSeconds: () => number;
  readonly onValue: (value: string) => void;
  readonly mask: (text: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly find?: FindSourceTool;
  readonly run?: RunSourceTool;
}

export type SecretSourceTestResult =
  | { readonly ok: true; readonly length: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

const UNTRUSTED_HINT = 'Review and approve them with Secret Sources… (Workspace).';

export class SecretSourcesService {
  private readonly cache = createSourceCache();
  private lastKey: string | undefined;

  constructor(private readonly deps: SecretSourcesServiceDeps) {}

  /** `next` with the open workspace's secret sources in front of it. The snapshot is read per call. */
  wrap(next: GetSecret): GetSecret {
    return async (ref) => {
      const snapshot = this.deps.snapshot();
      return snapshot === undefined ? next(ref) : this.getterFor(snapshot, next)(ref);
    };
  }

  /** Resolves `name` once, to say whether it works. The value itself is never returned. */
  async test(name: string): Promise<SecretSourceTestResult> {
    const snapshot = this.deps.snapshot();
    if (snapshot === undefined || !effectiveSecretSources(snapshot.shared, snapshot.local).has(name)) {
      return { ok: false, code: 'secret-source-unmapped', message: `"${name}" is not mapped to a source.` };
    }
    try {
      const value = await this.getterFor(snapshot, () => Promise.resolve(undefined))(secretPseudoRef(name));
      return { ok: true, length: value?.length ?? 0 };
    } catch (error) {
      if (error instanceof WirebenchError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  /** The names the open workspace maps to a source (shared and local, after overrides), sorted; no values. */
  mappedNames(): string[] {
    const snapshot = this.deps.snapshot();
    return snapshot === undefined ? [] : [...effectiveSecretSources(snapshot.shared, snapshot.local).keys()].sort();
  }

  clear(): void {
    this.cache.clear();
  }

  /** Clears the cache when the mapping, the overrides or the approval differ from the last call. */
  noteChange(): void {
    const snapshot = this.deps.snapshot();
    const key = JSON.stringify([
      secretSourcesHash(snapshot?.shared) ?? null,
      snapshot?.local ?? null,
      snapshot?.approvedHash ?? null,
    ]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.cache.clear();
    }
  }

  private getterFor(snapshot: SecretSourcesSnapshot, next: GetSecret): GetSecret {
    return sourceGetter(next, {
      sources: effectiveSecretSources(snapshot.shared, snapshot.local),
      sharedHash: secretSourcesHash(snapshot.shared),
      trust: { mode: 'approved', hash: snapshot.approvedHash },
      cache: this.cache,
      cacheMs: this.deps.cacheSeconds() * 1000,
      onValue: this.deps.onValue,
      mask: this.deps.mask,
      untrustedHint: () => UNTRUSTED_HINT,
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.find !== undefined ? { find: this.deps.find } : {}),
      ...(this.deps.run !== undefined ? { run: this.deps.run } : {}),
    });
  }
}
