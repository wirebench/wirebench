import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorsStore } from '../../src/renderer/state/editors.js';

describe('useEditorsStore', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
  });

  it('open adds a new tab and activates it', () => {
    useEditorsStore.getState().open({ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' });

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeId).toBe('request:req-1');
  });

  it('open on an already-open tab just activates it, without duplicating', () => {
    const store = useEditorsStore.getState();
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
    store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(activeId).toBe('a');
  });

  it('close removes a tab and falls back to a neighbour when it was active', () => {
    const store = useEditorsStore.getState();
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
    store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });

    useEditorsStore.getState().close('b');

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(['a']);
    expect(activeId).toBe('a');
  });

  it('close on a non-active tab leaves the active tab untouched', () => {
    const store = useEditorsStore.getState();
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
    store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });
    store.activate('a');

    useEditorsStore.getState().close('b');

    expect(useEditorsStore.getState().activeId).toBe('a');
  });

  it('move reorders tabs, clamps to the ends, and keeps the active tab', () => {
    const store = useEditorsStore.getState();
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
    store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });
    store.open({ id: 'c', kind: 'request', title: 'C', requestId: 'c' });
    const ids = () => useEditorsStore.getState().tabs.map((tab) => tab.id);

    useEditorsStore.getState().move('c', 0);
    expect(ids()).toEqual(['c', 'a', 'b']);
    useEditorsStore.getState().move('c', 99);
    expect(ids()).toEqual(['a', 'b', 'c']);
    useEditorsStore.getState().move('a', -5);
    expect(ids()).toEqual(['a', 'b', 'c']);
    useEditorsStore.getState().move('missing', 0);
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useEditorsStore.getState().activeId).toBe('c');
  });

  it('activate switches to an already-open tab; ignores unknown ids', () => {
    const store = useEditorsStore.getState();
    store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
    store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });

    store.activate('a');
    expect(useEditorsStore.getState().activeId).toBe('a');

    store.activate('nope');
    expect(useEditorsStore.getState().activeId).toBe('a');
  });
});

describe('Form view type persistence', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
  });

  it('defaults to "full" for a request that has never set one', () => {
    expect(useEditorsStore.getState().formViewTypeFor('req-1')).toBe('full');
  });

  it('remembers the view type per request id, independent of other requests', () => {
    const store = useEditorsStore.getState();
    store.setFormViewType('req-1', 'required');
    store.setFormViewType('req-2', 'non-empty');

    expect(useEditorsStore.getState().formViewTypeFor('req-1')).toBe('required');
    expect(useEditorsStore.getState().formViewTypeFor('req-2')).toBe('non-empty');
    expect(useEditorsStore.getState().formViewTypeFor('req-3')).toBe('full');
  });
});

describe('environment tabs', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('opens an environment tab carrying its environment id', () => {
    useEditorsStore.getState().open({ id: 'env:e1', kind: 'environment', title: 'uat', environmentId: 'e1' });
    const [tab] = useEditorsStore.getState().tabs;
    expect(tab?.kind).toBe('environment');
    expect(tab?.environmentId).toBe('e1');
    expect(useEditorsStore.getState().activeId).toBe('env:e1');
  });
});
