import { beforeEach, describe, expect, it } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';

/**
 * The draft store holds edits made in an editor tab until the user saves them. It is the only
 * place an unsaved edit exists, so the two things that matter are that successive edits to one
 * request accumulate rather than replace, and that clearing a draft after a save cannot throw
 * away a keystroke that landed while that save was in flight.
 */
describe('drafts store', () => {
  beforeEach(() => {
    useDraftsStore.setState({ requests: {} });
  });

  it('reports nothing dirty to begin with', () => {
    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(false);
    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual([]);
  });

  it('marks a request dirty once an edit is staged', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });

    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(true);
    expect(useDraftsStore.getState().isRequestDirty('r2')).toBe(false);
    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual(['r1']);
  });

  it('accumulates successive edits instead of replacing them', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    useDraftsStore.getState().stageRequest('r1', { name: 'Renamed' });

    expect(useDraftsStore.getState().peekRequest('r1')).toEqual({ envelopeXml: '<a/>', name: 'Renamed' });
  });

  it('keeps each request separate', () => {
    useDraftsStore.getState().stageRequest('r1', { name: 'One' });
    useDraftsStore.getState().stageRequest('r2', { name: 'Two' });

    expect(useDraftsStore.getState().peekRequest('r1')).toEqual({ name: 'One' });
    expect(useDraftsStore.getState().peekRequest('r2')).toEqual({ name: 'Two' });
  });

  it('clears a draft that was saved unchanged', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    const committed = useDraftsStore.getState().peekRequest('r1');

    useDraftsStore.getState().clearRequestIfUnchanged('r1', committed);

    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(false);
  });

  it('keeps a keystroke that landed while the save was in flight', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    const committed = useDraftsStore.getState().peekRequest('r1');

    // The user carries on typing before the save resolves.
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<ab/>' });
    useDraftsStore.getState().clearRequestIfUnchanged('r1', committed);

    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(true);
    expect(useDraftsStore.getState().peekRequest('r1')).toEqual({ envelopeXml: '<ab/>' });
  });

  it('discards a draft outright when its tab is closed without saving', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });

    useDraftsStore.getState().discardRequest('r1');

    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(false);
  });

  it('reset forgets every draft', () => {
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    useDraftsStore.getState().stageRequest('r2', { name: 'Renamed' });

    useDraftsStore.getState().reset();

    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual([]);
  });
});

/**
 * The REST half of the drafts store. It is deliberately a separate map: the two patch shapes have
 * nothing in common, and a request of one protocol must never be reported dirty because the other's
 * map holds its id.
 */
describe('REST drafts', () => {
  beforeEach(() => {
    useDraftsStore.getState().reset();
  });

  it('merges a REST patch over what is already staged', () => {
    useDraftsStore.getState().stageRestRequest('rest-1', { method: 'POST' });
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets' });

    expect(useDraftsStore.getState().peekRestRequest('rest-1')).toEqual({ method: 'POST', url: '/pets' });
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(true);
    expect(useDraftsStore.getState().dirtyRestRequestIds()).toEqual(['rest-1']);
  });

  it("keeps the two protocols' maps apart", () => {
    useDraftsStore.getState().stageRestRequest('id-1', { url: '/pets' });

    expect(useDraftsStore.getState().isRequestDirty('id-1')).toBe(false);
    expect(useDraftsStore.getState().isRestRequestDirty('id-1')).toBe(true);
  });

  it('clears after a save, unless the user typed again while it was in flight', () => {
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets' });
    const committed = useDraftsStore.getState().peekRestRequest('rest-1');

    useDraftsStore.getState().stageRestRequest('rest-1', { method: 'POST' });
    useDraftsStore.getState().clearRestRequestIfUnchanged('rest-1', committed);
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(true);

    useDraftsStore
      .getState()
      .clearRestRequestIfUnchanged('rest-1', useDraftsStore.getState().peekRestRequest('rest-1'));
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(false);
  });

  it('discards a REST draft outright, and forgets both maps on reset', () => {
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets' });
    useDraftsStore.getState().discardRestRequest('rest-1');
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(false);

    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<a/>' });
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets' });
    useDraftsStore.getState().reset();
    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual([]);
    expect(useDraftsStore.getState().dirtyRestRequestIds()).toEqual([]);
  });
});
