import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showToast, dismissToast } = vi.hoisted(() => ({
  showToast: vi.fn<(message: string, action?: unknown) => number>(() => 7),
  dismissToast: vi.fn(),
}));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, dismissToast }));
import { hintDetailsOnce } from '../../src/renderer/features/ssh/details-hint.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

beforeEach(() => {
  showToast.mockClear();
  dismissToast.mockClear();
  useEditorsStore.setState({ activeId: 'ssh-home' });
  useHostsStore.setState({ dialog: null });
  useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
});

describe('hintDetailsOnce (#594)', () => {
  it('says where Host details are on the first pick only', () => {
    const storage = memoryStorage();
    hintDetailsOnce(storage);
    hintDetailsOnce(storage);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[1]).toMatchObject({ label: 'Show details' });
  });
  it('says nothing once the panel has been shown or put away by hand', () => {
    useUiStore.getState().setHostDetailsOpen(false);
    hintDetailsOnce(memoryStorage());
    expect(showToast).not.toHaveBeenCalled();
  });
  it('goes once another tab comes to the front (S41)', () => {
    hintDetailsOnce(memoryStorage());
    useEditorsStore.setState({ activeId: 'ssh-terminal:t1' });
    expect(dismissToast).toHaveBeenCalledWith(7);
  });
  it('goes once a host form opens, and only once (S41)', () => {
    hintDetailsOnce(memoryStorage());
    useHostsStore.setState({ dialog: { mode: 'new-host' } as never });
    useEditorsStore.setState({ activeId: 'ssh-terminal:t1' });
    expect(dismissToast).toHaveBeenCalledTimes(1);
  });
  it('stays while the Hosts view is what is in front', () => {
    hintDetailsOnce(memoryStorage());
    useHostsStore.setState({ selectedHostId: 'a' });
    expect(dismissToast).not.toHaveBeenCalled();
  });
});
