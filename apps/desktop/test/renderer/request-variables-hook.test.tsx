import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestVariables } from '../../src/renderer/state/request-variables.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const answer = (name: string) => ({
  ok: true,
  value: {
    entries: [{ name, scope: 'Global', value: 'v', masked: false, shadowed: false, edit: { kind: 'globals' } }],
    secretNames: [],
  },
});

describe('useRequestVariables', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useGlobalsStore.setState({ properties: {}, disabled: [] });
  });

  it('fetches the request’s list, and fetches again when a scope changes', async () => {
    const variables = vi.fn().mockResolvedValueOnce(answer('first')).mockResolvedValueOnce(answer('second'));
    installWirebenchApi({ request: { variables } });

    const { result } = renderHook(() => useRequestVariables('r1'));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.entries[0]?.name).toBe('first'));
    expect(variables).toHaveBeenCalledWith({ requestId: 'r1' });

    act(() => {
      useGlobalsStore.setState({ properties: { added: 'x' } });
    });
    await waitFor(() => expect(result.current?.entries[0]?.name).toBe('second'));
  });

  it('asks nothing without a request, and keeps nothing when main fails', async () => {
    const variables = vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } });
    installWirebenchApi({ request: { variables } });
    const { result: none } = renderHook(() => useRequestVariables(undefined));
    expect(none.current).toBeUndefined();
    expect(variables).not.toHaveBeenCalled();

    const { result } = renderHook(() => useRequestVariables('r2'));
    await waitFor(() => expect(variables).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
