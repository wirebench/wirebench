import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** Sets `preferences.ui.confirmOnDelete` on the mirror. */
function confirmOnDelete(value: boolean): void {
  usePreferencesStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, confirmOnDelete: value },
    },
    loaded: true,
  });
}

describe('explorerActions deletion', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState({ confirmDeleteRequestId: undefined, confirmRemoveInterfaceId: undefined });
  });

  it('asks first when confirmOnDelete is on', () => {
    confirmOnDelete(true);
    const removeRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest('req-1');

    expect(useUiStore.getState().confirmDeleteRequestId).toBe('req-1');
    expect(removeRequest).not.toHaveBeenCalled();
  });

  it('deletes straight away when confirmOnDelete is off', () => {
    confirmOnDelete(false);
    const removeRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest('req-1');

    expect(removeRequest).toHaveBeenCalledWith('req-1');
    expect(useUiStore.getState().confirmDeleteRequestId).toBeUndefined();
  });

  it('applies the same preference to removing an interface', () => {
    confirmOnDelete(false);
    const removeInterface = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeInterface });

    explorerActions.removeInterface('iface-1');

    expect(removeInterface).toHaveBeenCalledWith('iface-1');
    expect(useUiStore.getState().confirmRemoveInterfaceId).toBeUndefined();
  });

  it('is a no-op without an id', () => {
    confirmOnDelete(false);
    const removeRequest = vi.fn();
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest(undefined);
    explorerActions.removeInterface(undefined);

    expect(removeRequest).not.toHaveBeenCalled();
  });
});
