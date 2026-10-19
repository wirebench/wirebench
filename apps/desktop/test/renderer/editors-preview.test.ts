import { beforeEach, describe, expect, it } from 'vitest';
import { previewing, useEditorsStore, type EditorTab } from '../../src/renderer/state/editors.js';

/** A REST request tab, the commonest thing a click in the Explorer opens. */
function rest(id: string): EditorTab {
  return { id: `rest:${id}`, kind: 'rest-request', title: id, restRequestId: id };
}

const ids = (): string[] => useEditorsStore.getState().tabs.map((tab) => tab.id);

describe('preview tabs (#679)', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
  });

  it('a preview open adds one tab and marks it the preview', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    expect(ids()).toEqual(['rest:a']);
    expect(useEditorsStore.getState().previewId).toBe('rest:a');
    expect(useEditorsStore.getState().activeId).toBe('rest:a');
  });

  it('the next preview replaces the last one, in its place on the strip', () => {
    const store = useEditorsStore.getState();
    store.open(rest('kept'));
    previewing(() => {
      store.open(rest('a'));
    });
    store.open(rest('also-kept'));
    previewing(() => {
      store.open(rest('b'));
    });
    previewing(() => {
      store.open(rest('c'));
    });
    expect(ids()).toEqual(['rest:kept', 'rest:c', 'rest:also-kept']);
    expect(useEditorsStore.getState().previewId).toBe('rest:c');
    expect(useEditorsStore.getState().activeId).toBe('rest:c');
  });

  it('three single clicks leave one tab', () => {
    for (const id of ['a', 'b', 'c']) {
      previewing(() => {
        useEditorsStore.getState().open(rest(id));
      });
    }
    expect(ids()).toEqual(['rest:c']);
  });

  it('opening the preview again outside previewing keeps it (a double-click)', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().open(rest('a'));
    expect(useEditorsStore.getState().previewId).toBeUndefined();
    previewing(() => {
      useEditorsStore.getState().open(rest('b'));
    });
    expect(ids()).toEqual(['rest:a', 'rest:b']);
  });

  it('a preview open of a tab already open only selects it, keeping it as it was', () => {
    const store = useEditorsStore.getState();
    store.open(rest('kept'));
    previewing(() => {
      store.open(rest('a'));
    });
    previewing(() => {
      store.open(rest('kept'));
    });
    expect(ids()).toEqual(['rest:kept', 'rest:a']);
    expect(useEditorsStore.getState().previewId).toBe('rest:a');
    expect(useEditorsStore.getState().activeId).toBe('rest:kept');
  });

  it('a plain open never replaces the preview', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().open(rest('b'));
    expect(ids()).toEqual(['rest:a', 'rest:b']);
    expect(useEditorsStore.getState().previewId).toBe('rest:a');
  });

  it('pin keeps the preview, and pin of another tab changes nothing', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().pin('rest:other');
    expect(useEditorsStore.getState().previewId).toBe('rest:a');
    useEditorsStore.getState().pin('rest:a');
    expect(useEditorsStore.getState().previewId).toBeUndefined();
  });

  it('pinEntity keeps the preview only when it edits that request (a send)', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().pinEntity('b');
    expect(useEditorsStore.getState().previewId).toBe('rest:a');
    useEditorsStore.getState().pinEntity('a');
    expect(useEditorsStore.getState().previewId).toBeUndefined();
  });

  it('closing the preview forgets it, so the next preview adds a tab', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().close('rest:a');
    expect(useEditorsStore.getState().previewId).toBeUndefined();
    useEditorsStore.getState().open(rest('kept'));
    previewing(() => {
      useEditorsStore.getState().open(rest('b'));
    });
    expect(ids()).toEqual(['rest:kept', 'rest:b']);
  });

  it('reset forgets the preview', () => {
    previewing(() => {
      useEditorsStore.getState().open(rest('a'));
    });
    useEditorsStore.getState().reset();
    expect(useEditorsStore.getState().previewId).toBeUndefined();
  });

  it('previewing ends with its callback, even when it throws', () => {
    expect(() =>
      previewing(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    useEditorsStore.getState().open(rest('a'));
    expect(useEditorsStore.getState().previewId).toBeUndefined();
  });
});
