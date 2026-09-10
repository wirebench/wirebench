import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorsStore } from '../../src/renderer/state/editors.js';

describe('useEditorsStore', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
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
