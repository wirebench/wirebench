// packages/engine/src/secrets/sources/getter.ts
/**
 * The `GetSecret` that answers a `${secret:name}` from its mapped source (secret sources spec D2–D5). A
 * mapped name is answered by its source alone: a failure is an error, never a fall-through to `next`,
 * which may hold a stale value under the same name. Everything else goes to `next` unchanged.
 */

import { WirebenchError } from '../../errors.js';
import type { GetSecret } from '../resolve.js';
import { parseSecretPseudoRef } from '../secret-token.js';
import { secretSourceError, withSource } from './errors.js';
import { findSourceTool, runSourceTool, SOURCE_STDERR_SHOWN, type FindSourceTool, type RunSourceTool } from './exec.js';
import { argvFor, parseSourceOutput } from './kinds.js';
import type { EffectiveSecretSources, SecretSource } from './parse.js';
import { canonicalJson, sharedTrusted, type SecretSourcesTrust } from './trust.js';

interface CacheEntry {
  readonly pending: Promise<string>;
  settledAt?: number;
}

export interface SourceCache {
  clear(): void;
}

class MemorySourceCache implements SourceCache {
  readonly entries = new Map<string, CacheEntry>();
  clear(): void {
    this.entries.clear();
  }
}

/** The in-memory cache a host keeps for as long as it wants values reused. Never written anywhere. */
export function createSourceCache(): SourceCache {
  return new MemorySourceCache();
}

export interface SourceGetterOptions {
  readonly sources: EffectiveSecretSources;
  readonly sharedHash: string | undefined;
  readonly trust: SecretSourcesTrust;
  readonly cache: SourceCache;
  readonly cacheMs: number;
  readonly onValue: (value: string) => void;
  readonly mask?: (text: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly find?: FindSourceTool;
  readonly run?: RunSourceTool;
  readonly now?: () => number;
  readonly untrustedHint?: (hash: string | undefined) => string;
}

async function fetchValue(source: SecretSource, options: SourceGetterOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = argvFor(source, platform);
  const path = await (options.find ?? findSourceTool)(command.tool, { env, platform });
  const result = await (options.run ?? runSourceTool)(path, command.args, { env, platform });
  if (result.exitCode !== 0) {
    const stderr = (options.mask ?? ((text: string) => text))(result.stderr.trim()).slice(0, SOURCE_STDERR_SHOWN);
    throw secretSourceError(
      'secret-source-failed',
      '',
      source.kind,
      `${command.tool} exited with code ${String(result.exitCode)}${stderr.length > 0 ? `: ${stderr}` : '.'}`,
    );
  }
  return parseSourceOutput(source, result.stdout);
}

export function sourceGetter(next: GetSecret, options: SourceGetterOptions): GetSecret {
  const cache = options.cache as MemorySourceCache;
  const now = options.now ?? Date.now;
  return async (ref) => {
    const name = parseSecretPseudoRef(ref);
    const mapped = name === undefined ? undefined : options.sources.get(name);
    if (name === undefined || mapped === undefined) {
      return next(ref);
    }
    const { source, origin } = mapped;
    if (source.kind === 'invalid') {
      throw secretSourceError(
        'secret-source-invalid',
        name,
        'invalid',
        `Secret "${name}": its source is not valid: ${source.reason}.`,
        {
          ...(source.field !== undefined ? { field: source.field } : {}),
        },
      );
    }
    if (origin === 'shared' && !sharedTrusted(options.trust, options.sharedHash)) {
      const hint = options.untrustedHint?.(options.sharedHash) ?? '';
      throw secretSourceError(
        'secret-source-untrusted',
        name,
        source.kind,
        `Secret "${name}" comes from this workspace's shared secret sources, which this machine has not approved.${hint === '' ? '' : ` ${hint}`}`,
      );
    }
    const key = canonicalJson(source);
    const cached = cache.entries.get(key);
    const usable =
      cached !== undefined && (cached.settledAt === undefined || now() - cached.settledAt < options.cacheMs);
    let entry: CacheEntry;
    if (usable) {
      entry = cached;
    } else {
      const created: CacheEntry = { pending: fetchValue(source, options) };
      entry = created;
      cache.entries.set(key, created);
      created.pending.then(
        () => {
          created.settledAt = now();
          if (options.cacheMs <= 0 && cache.entries.get(key) === created) {
            cache.entries.delete(key);
          }
        },
        () => {
          if (cache.entries.get(key) === created) {
            cache.entries.delete(key);
          }
        },
      );
    }
    let value: string;
    try {
      value = await entry.pending;
    } catch (error) {
      throw error instanceof WirebenchError ? withSource(error, name, source.kind) : error;
    }
    options.onValue(value);
    return value;
  };
}
