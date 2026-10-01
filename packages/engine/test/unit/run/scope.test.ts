import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope, scopeWith } from '../../../src/run/scope.js';

const context: RunContext = {
  project: createProject('P', { id: 'p1' }),
  projectDir: '/nowhere',
  overrides: {},
  host: { getSecret: () => Promise.resolve(undefined) },
};

describe('createRunScope', () => {
  it('carries the context it was given', () => {
    expect(createRunScope(context).context).toBe(context);
  });

  it('loads a key once and hands every caller the same value', async () => {
    const scope = createRunScope(context);
    const load = vi.fn(() => Promise.resolve({ loaded: true }));
    const first = await scope.memo('soap:i1:definition', load);
    const second = await scope.memo('soap:i1:definition', load);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps each key apart', async () => {
    const scope = createRunScope(context);
    expect(await scope.memo('rest:a1:openapi', () => Promise.resolve('a'))).toBe('a');
    expect(await scope.memo('rest:a2:openapi', () => Promise.resolve('b'))).toBe('b');
  });

  it('remembers a load that rejected, and rejects again without loading', async () => {
    const scope = createRunScope(context);
    const load = vi.fn(() => Promise.reject(new Error('no cache')));
    await expect(scope.memo('grpc:a1:proto-set', load)).rejects.toThrow('no cache');
    await expect(scope.memo('grpc:a1:proto-set', load)).rejects.toThrow('no cache');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not share its cache with another scope', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    await createRunScope(context).memo('k', load);
    await createRunScope(context).memo('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('scopeWith', () => {
  it('swaps the context and keeps the cache', async () => {
    const scope = createRunScope(context);
    const other: RunContext = { ...context, timeoutMs: 5 };
    const derived = scopeWith(scope, other);
    const load = vi.fn(() => Promise.resolve('once'));
    await scope.memo('k', load);
    expect(await derived.memo('k', load)).toBe('once');
    expect(load).toHaveBeenCalledTimes(1);
    expect(derived.context).toBe(other);
    expect(scope.context).toBe(context);
  });
});
