/**
 * Every IPC channel and event, pinned by name (kind modules spec §4.3). `ipc.ts` composes its
 * registries from core parts and each kind's fragment; this keeps a slice of that work from
 * dropping, renaming or moving a channel. Each one is also reached by the path its name spells,
 * which is how `preload/build-api.ts` and the renderer address it.
 */
import { describe, expect, it } from 'vitest';
import { channels, events } from '@wirebench/wire/ipc';
import pinned from './fixtures/ipc-names.json' with { type: 'json' };

/** `path → name` for every channel or event under `node`. */
function namesOf(node: unknown, path = '', out: Record<string, string> = {}): Record<string, string> {
  if (node !== null && typeof node === 'object') {
    const named = node as { readonly name?: unknown };
    if (typeof named.name === 'string' && ('request' in node || 'payload' in node)) {
      out[path] = named.name;
      return out;
    }
    for (const [key, value] of Object.entries(node)) namesOf(value, path === '' ? key : `${path}.${key}`, out);
  }
  return out;
}

describe.each([
  ['channels', channels, pinned.channels],
  ['events', events, pinned.events],
] as const)('the %s registry', (_label, registry, expected) => {
  const found = namesOf(registry);

  it('has exactly the pinned names', () => {
    expect(Object.values(found).sort()).toEqual(expected);
  });

  it('reaches each one by the path its name spells', () => {
    for (const [path, name] of Object.entries(found)) expect(path).toBe(name);
  });
});
