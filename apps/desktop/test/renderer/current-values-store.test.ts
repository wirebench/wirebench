import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCurrentValuesStore } from '../../src/renderer/state/current-values.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  useCurrentValuesStore.setState({ byScope: {} });
});

describe('useCurrentValuesStore', () => {
  it('asks main for every change and mirrors its answer by scope', async () => {
    const answer = { ok: true, value: { scopes: [{ key: { scope: 'workspace' }, values: { host: 'mine' } }] } };
    const set = vi.fn().mockResolvedValue(answer);
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { scopes: [] } });
    installWirebenchApi({ currentValues: { set, reset } });

    await useCurrentValuesStore.getState().set({ scope: 'workspace' }, 'host', 'mine');
    expect(set).toHaveBeenCalledWith({ key: { scope: 'workspace' }, name: 'host', value: 'mine' });
    expect(useCurrentValuesStore.getState().byScope).toEqual({ workspace: { host: 'mine' } });

    await useCurrentValuesStore.getState().reset({ scope: 'workspace' });
    expect(reset).toHaveBeenCalledWith({ key: { scope: 'workspace' } });
    expect(useCurrentValuesStore.getState().byScope).toEqual({});
  });
});
