import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  applyRestored,
  DRAFTS_STASH_DEBOUNCE_MS,
  noticeMessage,
  stashDrafts,
  subscribeToDraftStash,
} from '../../src/renderer/state/unsaved-drafts.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

describe('unsaved request drafts across sessions', () => {
  beforeEach(() => {
    showToast.mockClear();
    useDraftsStore.getState().reset();
    useProjectStore.setState({ requests: { r1: makeDraft({ id: 'r1', envelopeXml: '<saved/>' }) } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stashDrafts hands every current draft, of either protocol, to main for the named workspace', async () => {
    const api = installWirebenchApi();
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<unsaved/>' });
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets' });

    await stashDrafts('w1');

    expect(api.workspace.stashDrafts).toHaveBeenCalledWith({
      workspaceId: 'w1',
      requests: { r1: { envelopeXml: '<unsaved/>' } },
      restRequests: { 'rest-1': { url: '/pets' } },
      grpcRequests: {},
    });
  });

  it('stashes shortly after a draft changes, and at once when main asks', () => {
    vi.useFakeTimers();
    const on = vi.fn().mockReturnValue(() => undefined);
    const api = installWirebenchApi({ on });
    const off = subscribeToDraftStash(() => 'w1');

    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<ab/>' });
    expect(api.workspace.stashDrafts).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAFTS_STASH_DEBOUNCE_MS);
    // One send for the burst, carrying the latest edit.
    expect(api.workspace.stashDrafts).toHaveBeenCalledTimes(1);
    expect(api.workspace.stashDrafts).toHaveBeenLastCalledWith({
      workspaceId: 'w1',
      requests: { r1: { envelopeXml: '<ab/>' } },
      restRequests: {},
      grpcRequests: {},
    });

    const flush = (on.mock.calls as [string, (payload: unknown) => void][]).find(
      ([name]) => name === 'workspace.flushDrafts',
    )?.[1];
    expect(flush).toBeDefined();
    flush?.({});
    expect(api.workspace.stashDrafts).toHaveBeenCalledTimes(2);

    off();
  });

  it('stashes nothing while no workspace is open', () => {
    vi.useFakeTimers();
    const api = installWirebenchApi();
    const off = subscribeToDraftStash(() => undefined);

    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<a/>' });
    vi.advanceTimersByTime(DRAFTS_STASH_DEBOUNCE_MS);

    expect(api.workspace.stashDrafts).not.toHaveBeenCalled();
    off();
  });

  it('lays restored drafts back as unsaved edits, and drops the ones whose request is gone', () => {
    installWirebenchApi();

    applyRestored('w1', {
      workspaceId: 'w1',
      drafts: { r1: { envelopeXml: '<restored/>' }, gone: { envelopeXml: '<orphan/>' } },
      restDrafts: {},
      grpcDrafts: {},
      notices: [],
    });

    expect(useProjectStore.getState().requests['r1']?.envelopeXml).toBe('<restored/>');
    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(true);
    expect(useDraftsStore.getState().isRequestDirty('gone')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Restored an unsaved request edit');
    expect(showToast).toHaveBeenCalledWith("Dropped an unsaved request edit: its request doesn't exist anymore");
  });

  it('ignores what was restored for a different workspace', () => {
    applyRestored('w2', {
      workspaceId: 'w1',
      drafts: { r1: { envelopeXml: '<restored/>' } },
      restDrafts: {},
      grpcDrafts: {},
      notices: [],
    });

    expect(useDraftsStore.getState().isRequestDirty('r1')).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows one notice per restored project, naming what changed on disk or was dropped', () => {
    applyRestored('w1', {
      workspaceId: 'w1',
      drafts: {},
      restDrafts: {},
      grpcDrafts: {},
      notices: [
        {
          projectId: 'p1',
          projectName: 'Calculator',
          status: 'restored',
          conflicts: ['interfaces/calc/requests/Add.yaml'],
          dropped: ['interfaces/calc/requests/Old.yaml'],
        },
      ],
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      'Restored unsaved changes in Calculator — also changed on disk, kept yours: Add — deleted on disk, dropped: Old',
    );
  });

  it('says plainly when a project’s unsaved changes could not be restored', () => {
    expect(
      noticeMessage({
        projectId: 'p1',
        projectName: 'Calculator',
        status: 'failed',
        conflicts: [],
        dropped: [],
        message: 'bad yaml',
      }),
    ).toBe("Couldn't restore unsaved changes in Calculator: bad yaml");
    expect(
      noticeMessage({ projectId: 'p1', projectName: 'Calculator', status: 'restored', conflicts: [], dropped: [] }),
    ).toBe('Restored unsaved changes in Calculator');
  });
});
