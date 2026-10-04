import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCurrentValuesStore } from '../../src/renderer/state/current-values.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

afterEach(() => {
  showToast.mockClear();
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

  it('toasts a failed set or reset and keeps the mirror as it was', async () => {
    const failure = { ok: false, error: { code: 'current-value-unknown', message: 'No such variable.' } };
    installWirebenchApi({
      currentValues: { set: vi.fn().mockResolvedValue(failure), reset: vi.fn().mockResolvedValue(failure) },
    });
    useCurrentValuesStore.setState({ byScope: { workspace: { host: 'mine' } } });

    await useCurrentValuesStore.getState().set({ scope: 'workspace' }, 'gone', 'x');
    expect(showToast).toHaveBeenCalledWith('No such variable.');
    await useCurrentValuesStore.getState().reset({ scope: 'workspace' }, 'host');
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(useCurrentValuesStore.getState().byScope).toEqual({ workspace: { host: 'mine' } });
  });
});
