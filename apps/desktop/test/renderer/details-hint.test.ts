import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));
import { hintDetailsOnce } from '../../src/renderer/features/ssh/details-hint.js';
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
  showToast.mockReset();
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
});
