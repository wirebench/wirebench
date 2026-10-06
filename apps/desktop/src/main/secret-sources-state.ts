/**
 * What the Secret Sources dialog shows, and the one-entry edit behind its writes (secret sources spec D4,
 * D6; amendment A7). Pure: `WorkspaceService` reads and writes the files around it.
 */

import {
  canonicalJson,
  serializeSecretSources,
  secretSourcesHash,
  type LocalSecretSource,
  type LocalSecretSources,
  type SharedSecretSources,
} from '@wirebench/engine';
import type { SecretSourceEntryWire, SecretSourcesState } from '../shared/wire-types.js';

/** What `secretSourcesState` reads from the open workspace. */
export interface SecretSourcesInputs {
  readonly shared: SharedSecretSources | undefined;
  /** A non-mapping `secretSources` in `workspace.yaml`. */
  readonly sharedRaw: unknown;
  readonly local: LocalSecretSources | undefined;
  /** A non-mapping `secretSources` in `local.yaml`. */
  readonly localRaw: unknown;
  readonly approved: { readonly hash: string; readonly mapping: Readonly<Record<string, unknown>> } | undefined;
}

export const NOTHING_OPEN: SecretSourcesState = { open: false, entries: [], trusted: true, changes: [] };

/**
 * `map` with `previousName` and `name` removed, then `entry` set under `name` unless it is `undefined`.
 * Every other entry is carried over as it is, an invalid one with its raw value included; a null-prototype
 * object and `defineProperty` keep an own `__proto__` entry a key.
 */
export function withSecretSourceEntry<T extends LocalSecretSource>(
  map: Readonly<Record<string, T>> | undefined,
  name: string,
  previousName: string | undefined,
  entry: T | undefined,
): Record<string, T> {
  const next = Object.create(null) as Record<string, T>;
  const put = (key: string, value: T): void => {
    Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
  };
  for (const key of Object.keys(map ?? {})) {
    const value = map?.[key];
    if (key !== name && key !== previousName && value !== undefined) {
      put(key, value);
    }
  }
  if (entry !== undefined) {
    put(name, entry);
  }
  return next;
}

function fieldsOf(source: LocalSecretSource): Record<string, string> {
  const body: unknown = source.kind === 'invalid' ? source.raw : source;
  const fields: Record<string, string> = {};
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (key !== 'kind' && typeof value === 'string') {
        Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return fields;
}

/**
 * A stable text form of an entry. `canonicalJson` throws on what YAML can still hand over in a raw, invalid
 * entry (`.inf`, `.nan`), so those fall back to a key-sorted JSON that writes them as text.
 */
function comparable(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'number' && !Number.isFinite(item)) {
          return String(item);
        }
        if (typeof item === 'bigint') {
          return item.toString();
        }
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const sorted: Record<string, unknown> = {};
          for (const key of Object.keys(item).sort()) {
            Object.defineProperty(sorted, key, {
              value: (item as Record<string, unknown>)[key],
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          return sorted;
        }
        return item;
      }) ?? 'undefined'
    );
  }
}

function problemOf(sharedRaw: unknown, localRaw: unknown): string | undefined {
  const files = [
    ...(sharedRaw !== undefined ? ['workspace.yaml'] : []),
    ...(localRaw !== undefined ? ['local.yaml (this machine)'] : []),
  ];
  if (files.length === 0) {
    return undefined;
  }
  return `secretSources in ${files.join(' and ')} is not a mapping, so it maps nothing. It is kept as it is until you add a source there.`;
}

/** The entries with their origins, the trust state and what changed since this machine's approval. */
export function secretSourcesStateOf(inputs: SecretSourcesInputs): SecretSourcesState {
  const shared = inputs.shared ?? {};
  const local = inputs.local ?? {};
  const entryOf = (name: string, source: LocalSecretSource, origin: 'shared' | 'local'): SecretSourceEntryWire => ({
    name,
    origin,
    kind: source.kind,
    fields: fieldsOf(source),
    ...(source.kind === 'invalid' ? { reason: source.reason } : {}),
    overridden: origin === 'shared' && Object.hasOwn(local, name),
  });
  const entries = [
    ...Object.keys(shared).map((name) => entryOf(name, shared[name] as LocalSecretSource, 'shared')),
    ...Object.keys(local).map((name) => entryOf(name, local[name] as LocalSecretSource, 'local')),
  ];
  const hash = secretSourcesHash(inputs.shared);
  const before = inputs.approved?.mapping ?? {};
  const after = serializeSecretSources(shared);
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = names.flatMap((name): SecretSourcesState['changes'] => {
    if (!Object.hasOwn(before, name)) {
      return [{ name, change: 'added' }];
    }
    if (!Object.hasOwn(after, name)) {
      return [{ name, change: 'removed' }];
    }
    return comparable(before[name]) === comparable(after[name]) ? [] : [{ name, change: 'changed' }];
  });
  const problem = problemOf(inputs.sharedRaw, inputs.localRaw);
  return {
    open: true,
    entries,
    ...(hash !== undefined ? { hash } : {}),
    trusted: hash === undefined || hash === inputs.approved?.hash,
    changes,
    ...(problem !== undefined ? { problem } : {}),
  };
}
