import { beforeEach, describe, expect, it } from 'vitest';
import { closeTabs, closeTargets, useUnsavedCloseStore } from '../../src/renderer/shell/tab-close.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore, type EditorTab } from '../../src/renderer/state/editors.js';

function rest(id: string): EditorTab {
  return { id: `rest:${id}`, kind: 'rest-request', title: id, restRequestId: id };
}

const ids = (): string[] => useEditorsStore.getState().tabs.map((tab) => tab.id);

/** Lets the close loop run up to its next question (or to its end). */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('closeTargets (#679)', () => {
  const tabs = ['a', 'b', 'c', 'd'].map(rest);
  const dirty = (tab: EditorTab): boolean => tab.id === 'rest:c';
  const targets = (id: string | undefined, scope: Parameters<typeof closeTargets>[2]): string[] =>
    closeTargets(tabs, id, scope, dirty);

  it('this closes the one tab', () => {
    expect(targets('rest:b', 'this')).toEqual(['rest:b']);
  });

  it('others closes every tab but the one', () => {
    expect(targets('rest:b', 'others')).toEqual(['rest:a', 'rest:c', 'rest:d']);
  });

  it('right closes the tabs after the one, and nothing after the last or an unknown tab', () => {
    expect(targets('rest:b', 'right')).toEqual(['rest:c', 'rest:d']);
    expect(targets('rest:d', 'right')).toEqual([]);
    expect(targets(undefined, 'right')).toEqual([]);
  });

  it('saved closes every tab without unsaved edits', () => {
    expect(targets('rest:b', 'saved')).toEqual(['rest:a', 'rest:b', 'rest:d']);
  });

  it('all closes every tab', () => {
    expect(targets(undefined, 'all')).toEqual(['rest:a', 'rest:b', 'rest:c', 'rest:d']);
  });
});

describe('closeTabs asks about unsaved edits (#679)', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    useDraftsStore.getState().reset();
    useUnsavedCloseStore.setState({ question: undefined, resolve: undefined });
    for (const id of ['a', 'b', 'c']) useEditorsStore.getState().open(rest(id));
    useDraftsStore.getState().stageRestRequest('b', { url: 'https://example.test/edited' });
  });

  it('closes saved tabs without asking', async () => {
    await closeTabs(['rest:a', 'rest:c']);
    expect(ids()).toEqual(['rest:b']);
    expect(useUnsavedCloseStore.getState().question).toBeUndefined();
  });

  it('Cancel keeps the dirty tab and stops the rest of the batch', async () => {
    const done = closeTabs(['rest:a', 'rest:b', 'rest:c']);
    await settle();
    expect(useUnsavedCloseStore.getState().question).toEqual({ name: 'b' });
    expect(useEditorsStore.getState().activeId).toBe('rest:b');
    useUnsavedCloseStore.getState().answer('cancel');
    await done;
    expect(ids()).toEqual(['rest:b', 'rest:c']);
    expect(useDraftsStore.getState().isRestRequestDirty('b')).toBe(true);
  });

  it("Don't save throws the edit away and closes on through the batch", async () => {
    const done = closeTabs(['rest:a', 'rest:b', 'rest:c']);
    await settle();
    useUnsavedCloseStore.getState().answer('discard');
    await done;
    expect(ids()).toEqual([]);
    expect(useDraftsStore.getState().isRestRequestDirty('b')).toBe(false);
  });
});
