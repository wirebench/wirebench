import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { leaves, onePane, split } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import {
  closeTabs,
  closeTargets,
  useLiveCloseStore,
  useUnsavedCloseStore,
} from '../../src/renderer/shell/tab-close.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore, type EditorTab } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';

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

describe('closeTabs asks once before ending live sessions (S53)', () => {
  const update = vi.fn(() => Promise.resolve(undefined));
  const withPreference = (confirmCloseSessions: boolean): void => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, confirmCloseSessions },
      },
      loaded: true,
      update,
    });
  };

  beforeEach(() => {
    update.mockClear();
    withPreference(true);
    useEditorsStore.getState().reset();
    useDraftsStore.getState().reset();
    useLiveCloseStore.setState({ question: undefined, resolve: undefined });
    const one = onePane('a');
    const first = leaves(one)[0]?.paneId ?? '';
    const two = split(one, first, 'row', 'a');
    const [left, right] = leaves(two).map((leaf) => leaf.paneId);
    const solo = leaves(onePane('b'))[0]?.paneId ?? '';
    useHostsStore.setState({
      panes: {
        [left ?? '']: { hostId: 'a', state: 'open' },
        [right ?? '']: { hostId: 'a', state: 'connecting' },
      },
    });
    useEditorsStore.getState().open({ id: 'ssh-terminal:t1', kind: 'ssh-terminal', title: 'alpha', panes: two });
    useEditorsStore.getState().open({
      id: 'ssh-terminal:t2',
      kind: 'ssh-terminal',
      title: 'beta',
      panes: { kind: 'pane', paneId: solo, hostId: 'b' },
    });
    useEditorsStore.getState().open(rest('a'));
  });

  it('asks once for the whole batch, counting the sessions and tabs that are live', async () => {
    const closing = closeTabs(['ssh-terminal:t1', 'ssh-terminal:t2', 'rest:a']);
    await settle();
    expect(useLiveCloseStore.getState().question).toEqual({ sessions: 2, tabs: 1, name: 'alpha' });
    useLiveCloseStore.getState().answer({ close: true, dontAskAgain: false });
    await closing;
    expect(ids()).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('names every host when one tab holds sessions on more than one (#720)', async () => {
    const one = onePane('a');
    const first = leaves(one)[0]?.paneId ?? '';
    const mixed = split(one, first, 'row', 'b');
    const [left, right] = leaves(mixed).map((leaf) => leaf.paneId);
    useHostsStore.setState({
      resolved: [
        { id: 'a', name: 'box' },
        { id: 'b', name: 'box-2' },
      ] as never,
      panes: {
        [left ?? '']: { hostId: 'a', state: 'open' },
        [right ?? '']: { hostId: 'b', state: 'open' },
      },
    });
    useEditorsStore.getState().open({ id: 'ssh-terminal:t3', kind: 'ssh-terminal', title: 'Box pair', panes: mixed });
    const closing = closeTabs(['ssh-terminal:t3']);
    await settle();
    expect(useLiveCloseStore.getState().question).toEqual({ sessions: 2, tabs: 1, name: 'box and box-2' });
    useLiveCloseStore.getState().answer({ close: false, dontAskAgain: false });
    await closing;
  });

  it('Cancel keeps every tab in the batch', async () => {
    const closing = closeTabs(['rest:a', 'ssh-terminal:t1']);
    await settle();
    useLiveCloseStore.getState().answer({ close: false, dontAskAgain: false });
    await closing;
    expect(ids()).toEqual(['ssh-terminal:t1', 'ssh-terminal:t2', 'rest:a']);
  });

  it("Don't ask again turns the preference off", async () => {
    const closing = closeTabs(['ssh-terminal:t1']);
    await settle();
    useLiveCloseStore.getState().answer({ close: true, dontAskAgain: true });
    await closing;
    expect(update).toHaveBeenCalledWith({ terminal: { confirmCloseSessions: false } });
  });

  it('does not ask for tabs with no live session, or with the preference off', async () => {
    await closeTabs(['ssh-terminal:t2']);
    expect(useLiveCloseStore.getState().question).toBeUndefined();
    withPreference(false);
    await closeTabs(['ssh-terminal:t1']);
    expect(useLiveCloseStore.getState().question).toBeUndefined();
    expect(ids()).toEqual(['rest:a']);
  });
});
