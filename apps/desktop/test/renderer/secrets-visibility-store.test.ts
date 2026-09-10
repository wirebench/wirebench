import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('useSecretsVisibilityStore', () => {
  beforeEach(() => {
    useSecretsVisibilityStore.setState({ show: false });
  });

  it('mirrors whatever main reports rather than deciding the value itself', async () => {
    // Main is the authority: it answers `false` even though the renderer asked for `true`
    // (a policy could refuse), and the store must show what main says.
    const setShowSecrets = vi.fn().mockResolvedValue({ ok: true, value: { show: false } });
    installWirebenchApi({ secrets: { setShowSecrets } });

    await useSecretsVisibilityStore.getState().setShow(true);

    expect(setShowSecrets).toHaveBeenCalledWith({ show: true });
    expect(useSecretsVisibilityStore.getState().show).toBe(false);
  });

  it('toggles through main and reflects the new value', async () => {
    const setShowSecrets = vi.fn().mockResolvedValue({ ok: true, value: { show: true } });
    installWirebenchApi({ secrets: { setShowSecrets } });

    await useSecretsVisibilityStore.getState().toggle();

    expect(setShowSecrets).toHaveBeenCalledWith({ show: true });
    expect(useSecretsVisibilityStore.getState().show).toBe(true);
  });

  it('refresh() reads the flag back from main', async () => {
    installWirebenchApi({
      secrets: { getShowSecrets: vi.fn().mockResolvedValue({ ok: true, value: { show: true } }) },
    });

    await useSecretsVisibilityStore.getState().refresh();

    expect(useSecretsVisibilityStore.getState().show).toBe(true);
  });

  it('leaves the flag alone when main fails the call', async () => {
    installWirebenchApi({
      secrets: { setShowSecrets: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }) },
    });

    await useSecretsVisibilityStore.getState().setShow(true);

    expect(useSecretsVisibilityStore.getState().show).toBe(false);
  });
});
