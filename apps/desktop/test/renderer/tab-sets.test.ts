/**
 * Editor tabs in sets, one per activity-bar area: which set a tab joins, what each area shows,
 * how each set keeps its own active tab, and how the sidebar and the strip follow each other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEditorsStore, type EditorTab } from '../../src/renderer/state/editors.js';
import { syncTabSetsWithSidebar } from '../../src/renderer/state/tab-set-sync.js';
import { tabSetForView, tabSetOf, viewForTabSet } from '../../src/renderer/state/tab-sets.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

const request = (id: string): EditorTab => ({ id, kind: 'rest-request', title: id, restRequestId: id });
const terminal = (id: string): EditorTab => ({ id, kind: 'ssh-terminal', title: id, hostId: id });
const environment = (id: string): EditorTab => ({ id, kind: 'environment', title: id, environmentId: id });

beforeEach(() => {
  useEditorsStore.getState().reset();
});

describe('tab sets', () => {
  it('puts a tab in a set by what it is', () => {
    expect(tabSetOf(terminal('t'))).toBe('ssh');
    expect(tabSetOf(environment('e'))).toBe('environments');
    expect(tabSetOf({ kind: 'history' })).toBe('history');
    expect(tabSetOf(request('r'))).toBe('explorer');
    expect(tabSetOf({ kind: 'grpc-request' })).toBe('explorer');
    expect(tabSetOf({ kind: 'diff' })).toBe('explorer');
    // History's Compare is a diff too, but it says where it belongs.
    expect(tabSetOf({ kind: 'diff', set: 'history' })).toBe('history');
  });

  it("shows Explorer's set in the areas that open nothing of their own", () => {
    expect(tabSetForView('search')).toBe('explorer');
    expect(tabSetForView('wss')).toBe('explorer');
    expect(tabSetForView('ssh')).toBe('ssh');
    expect(viewForTabSet('explorer', 'search')).toBe('search');
    expect(viewForTabSet('explorer', 'ssh')).toBe('explorer');
  });
});

describe('the editors store, in sets', () => {
  it('keeps one active tab per set and returns to it', () => {
    const editors = useEditorsStore.getState();
    editors.open(request('a'));
    editors.open(request('b'));
    editors.open(terminal('t'));
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'ssh', activeId: 't' });

    useEditorsStore.getState().showSet('explorer');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'explorer', activeId: 'b' });

    useEditorsStore.getState().showSet('ssh');
    expect(useEditorsStore.getState().activeId).toBe('t');
  });

  it('shows a set with nothing open as no active tab', () => {
    useEditorsStore.getState().open(request('a'));
    useEditorsStore.getState().showSet('environments');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'environments', activeId: undefined });
  });

  it("closing the active tab falls back to a neighbour in its own set, never another set's tab", () => {
    const editors = useEditorsStore.getState();
    editors.open(request('a'));
    editors.open(terminal('t'));
    editors.open(request('b'));

    useEditorsStore.getState().close('b');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'explorer', activeId: 'a' });

    useEditorsStore.getState().close('a');
    expect(useEditorsStore.getState().activeId).toBeUndefined();
    expect(useEditorsStore.getState().activeBySet.ssh).toBe('t');
  });

  it("closing a tab of a hidden set leaves the shown set's active tab alone", () => {
    const editors = useEditorsStore.getState();
    editors.open(terminal('t'));
    editors.open(request('a'));

    useEditorsStore.getState().close('t');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'explorer', activeId: 'a' });
    expect(useEditorsStore.getState().activeBySet.ssh).toBeUndefined();
  });

  it("moves a tab among its own set's tabs, leaving the other sets' tabs in place", () => {
    const editors = useEditorsStore.getState();
    editors.open(request('a'));
    editors.open(terminal('t'));
    editors.open(request('b'));
    editors.open(request('c'));

    // Index 0 of Explorer's strip, which reads a, b, c: the terminal does not count.
    useEditorsStore.getState().move('c', 0);
    expect(useEditorsStore.getState().tabs.map((t) => t.id)).toEqual(['c', 't', 'a', 'b']);
  });

  it('Start clears only the shown set', () => {
    const editors = useEditorsStore.getState();
    editors.open(terminal('t'));
    editors.open(request('a'));
    useEditorsStore.getState().showStart();
    expect(useEditorsStore.getState().activeBySet).toEqual({ ssh: 't' });
  });
});

describe('the sidebar and the strip, in step', () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    useUiStore.setState({ sidebar: { ...DEFAULT_UI_STATE.sidebar, view: 'explorer' } });
    stop = syncTabSetsWithSidebar();
  });

  afterEach(() => {
    stop();
  });

  it("choosing an area shows that area's tabs", () => {
    useEditorsStore.getState().open(request('a'));
    useEditorsStore.getState().open(terminal('t'));
    useUiStore.getState().setSidebarView('explorer');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'explorer', activeId: 'a' });

    useUiStore.getState().setSidebarView('ssh');
    expect(useEditorsStore.getState()).toMatchObject({ displayedSet: 'ssh', activeId: 't' });
  });

  it("opening a tab of another set brings that set's area into view", () => {
    useEditorsStore.getState().open(terminal('t'));
    expect(useUiStore.getState().sidebar.view).toBe('ssh');

    useEditorsStore.getState().open(environment('e'));
    expect(useUiStore.getState().sidebar.view).toBe('environments');
  });

  it("stays in Search when a request opens, since Search shows Explorer's tabs", () => {
    useUiStore.getState().setSidebarView('search');
    useEditorsStore.getState().open(request('a'));
    expect(useUiStore.getState().sidebar.view).toBe('search');
    expect(useEditorsStore.getState().activeId).toBe('a');
  });
});
