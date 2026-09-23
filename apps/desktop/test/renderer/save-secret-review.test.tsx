import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretReviewDialog } from '../../src/renderer/components/secret-review-dialog.js';
import { registerProjectCommands } from '../../src/renderer/commands/register-project-commands.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useSecretReviewStore } from '../../src/renderer/state/secret-review.js';
import { stashDrafts, subscribeToDraftStash } from '../../src/renderer/state/unsaved-drafts.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { SecretFindingWire } from '../../src/shared/wire-types.js';
import { makeDraft, makeInterface } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  NO_REST,
  PROJECT_SETTINGS,
  grpcRequestWire,
  restRequestWire,
  wsRequestWire,
} from '../helpers/wire-defaults.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

const context = { platform: 'linux', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

/** An obviously fake finding: the renderer only ever sees its preview. */
const FINDING: SecretFindingWire = {
  id: 'f1',
  location: { kind: 'soap-header', requestId: 'req-1', name: 'Authorization', index: 0 },
  rule: 'bearer',
  label: 'Orders › Request 1 › header Authorization',
  preview: 'not… (20 chars)',
};

function projectWire(id = 'p1') {
  return {
    ...NO_REST,
    id,
    name: id === 'p1' ? 'P' : 'Q',
    dir: `/tmp/${id}`,
    dirty: true,
    interfaces: [],
    requests: [],
    properties: {},
    disabledProperties: [],
    settings: PROJECT_SETTINGS,
    environments: [],
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
    problems: [],
  };
}

/** The IPC a save and a review touch, with the scan answering `findings`. */
function stubIpc(findings: readonly SecretFindingWire[]) {
  const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
  const save = vi.fn().mockResolvedValue({ ok: true, value: { saved: true, written: 1, removed: 0 } });
  const scan = vi.fn().mockResolvedValue({
    ok: true,
    value: { findings, proposedNames: Object.fromEntries(findings.map((f) => [f.id, 'token'])), storedNames: [] },
  });
  const keep = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const move = vi.fn().mockResolvedValue({ ok: true, value: { moved: [], stale: [], nameTaken: [] } });
  const hold = vi.fn().mockResolvedValue({ ok: true, value: { holdId: 'hold-1' } });
  const release = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const stash = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const close = vi.fn().mockResolvedValue({ ok: true, value: { workspace: null } });
  const list = vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [], suggestions: [] } });
  const api = installWirebenchApi({
    project: { mutate, save },
    secretScan: { scan, keep, move, hold, release },
    workspace: { stashDrafts: stash, close, list },
  });
  return { api, mutate, save, scan, keep, move, hold, release, stash, close };
}

let ipcStubs: ReturnType<typeof stubIpc>;

beforeEach(() => {
  showToast.mockClear();
  resetCommands();
  useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  useDraftsStore.getState().reset();
  useProjectStore.setState({
    projects: { p1: projectWire() },
    requests: { 'req-1': makeDraft() },
    interfaces: { 'if-1': makeInterface() },
    order: [{ projectId: 'p1', interfaceIds: ['if-1'] }],
    projectOf: { 'if-1': 'p1', 'req-1': 'p1' },
    saveStatus: {},
  });
  useEditorsStore.setState({
    tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
    activeId: 'request:req-1',
  });
  registerProjectCommands();
  render(<SecretReviewDialog />);
});

afterEach(async () => {
  act(() => {
    useSecretReviewStore.getState().cancel();
  });
  await Promise.resolve();
  cleanup();
  resetCommands();
  vi.restoreAllMocks();
});

describe('a manual save reviews the project for secrets first', () => {
  it('saves without a dialog when nothing is found', async () => {
    ipcStubs = stubIpc([]);

    await runCommand('item.save', context);

    await waitFor(() => {
      expect(ipcStubs.save).toHaveBeenCalledWith({ projectId: 'p1' });
    });
    expect(ipcStubs.scan).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(ipcStubs.scan.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.save.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('scans after committing the staged edit, so the edit is what gets reviewed', async () => {
    ipcStubs = stubIpc([]);
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<typed/>' });

    await runCommand('item.save', context);

    await waitFor(() => {
      expect(ipcStubs.save).toHaveBeenCalled();
    });
    expect(ipcStubs.mutate.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.scan.mock.invocationCallOrder[0]!);
  });

  it('writes on Save anyway', async () => {
    ipcStubs = stubIpc([FINDING]);

    await runCommand('item.save', context);
    await screen.findByRole('alertdialog');
    expect(ipcStubs.save).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));

    await waitFor(() => {
      expect(ipcStubs.save).toHaveBeenCalledWith({ projectId: 'p1' });
    });
  });

  it('does not write on Cancel', async () => {
    ipcStubs = stubIpc([FINDING]);

    await runCommand('item.save', context);
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ipcStubs.save).not.toHaveBeenCalled();
    expect(useProjectStore.getState().saveStatus['p1']).toBeUndefined();
  });

  it('reviews every open project on Save All, and neither writes nor says "Saved" when cancelled', async () => {
    ipcStubs = stubIpc([FINDING]);
    useProjectStore.setState((state) => ({ projects: { ...state.projects, p2: projectWire('p2') } }));

    await runCommand('project.save', context);
    await screen.findByRole('alertdialog');
    expect(ipcStubs.scan).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(ipcStubs.scan).toHaveBeenCalledWith({ projectId: 'p2' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ipcStubs.save).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith('Saved');
  });

  it('writes every project on Save All once the review goes ahead', async () => {
    ipcStubs = stubIpc([]);
    useProjectStore.setState((state) => ({ projects: { ...state.projects, p2: projectWire('p2') } }));

    await runCommand('project.save', context);

    await waitFor(() => {
      expect(ipcStubs.save).toHaveBeenCalledTimes(2);
    });
    expect(showToast).toHaveBeenCalledWith('Saved');
  });
});

describe('autosave waits for the answer', () => {
  it('holds autosave before committing the staged edit, and releases it only once the review settles', async () => {
    ipcStubs = stubIpc([FINDING]);
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<typed/>' });

    await runCommand('item.save', context);
    await screen.findByRole('alertdialog');

    // Main's autosave is held from before the edit reaches its model, so with autosave on the edit
    // is not written behind the dialog.
    expect(ipcStubs.hold).toHaveBeenCalledWith({ projectIds: ['p1'] });
    expect(ipcStubs.hold.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.mutate.mock.invocationCallOrder[0]!);
    expect(ipcStubs.mutate.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.scan.mock.invocationCallOrder[0]!);
    expect(ipcStubs.release).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(ipcStubs.release).toHaveBeenCalledWith({ holdId: 'hold-1' });
    });
    expect(ipcStubs.save).not.toHaveBeenCalled();
  });
});

describe('a second manual save while a review is open', () => {
  it('is refused with a toast, and leaves its staged edit staged rather than committing it', async () => {
    ipcStubs = stubIpc([FINDING]);
    useProjectStore.setState((state) => ({
      projects: { ...state.projects, p2: projectWire('p2') },
      requests: { ...state.requests, 'req-2': makeDraft({ id: 'req-2' }) },
      projectOf: { ...state.projectOf, 'req-2': 'p2' },
    }));

    await runCommand('item.save', context);
    await screen.findByRole('alertdialog');
    useDraftsStore.getState().stageRequest('req-2', { envelopeXml: '<other/>' });

    await useProjectStore.getState().saveRequest('req-2', { manual: true });

    expect(showToast).toHaveBeenCalledWith('Finish the open secret review first');
    // Nothing reached main for req-2, so its tab still says unsaved — and it is.
    expect(ipcStubs.mutate).not.toHaveBeenCalled();
    expect(useDraftsStore.getState().peekRequest('req-2')).toEqual({ envelopeXml: '<other/>' });
    expect(ipcStubs.hold).toHaveBeenCalledTimes(1);
    expect(ipcStubs.scan).toHaveBeenCalledTimes(1);
    expect(ipcStubs.save).not.toHaveBeenCalled();
    // The open review is still the first save's, and still answers it.
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => {
      expect(ipcStubs.save).toHaveBeenCalledWith({ projectId: 'p1' });
    });
    expect(ipcStubs.save).toHaveBeenCalledTimes(1);
  });

  it('Save All is refused the same way', async () => {
    ipcStubs = stubIpc([FINDING]);

    await runCommand('item.save', context);
    await screen.findByRole('alertdialog');

    await expect(useProjectStore.getState().save(undefined, { manual: true })).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith('Finish the open secret review first');
  });
});

describe('every kind of tab saves manually through the review', () => {
  function seedTab(kind: 'rest' | 'grpc' | 'ws'): string {
    const id = `${kind}-1`;
    if (kind === 'rest') {
      useProjectStore.setState((state) => ({
        restRequests: { [id]: restRequestWire({ id }) },
        projectOf: { ...state.projectOf, [id]: 'p1' },
      }));
      useEditorsStore.setState({
        tabs: [{ id: `rest:${id}`, kind: 'rest-request', title: 'R', restRequestId: id }],
        activeId: `rest:${id}`,
      });
    } else if (kind === 'grpc') {
      useProjectStore.setState((state) => ({
        grpcRequests: { [id]: grpcRequestWire({ id }) },
        projectOf: { ...state.projectOf, [id]: 'p1' },
      }));
      useEditorsStore.setState({
        tabs: [{ id: `grpc:${id}`, kind: 'grpc-request', title: 'G', grpcRequestId: id }],
        activeId: `grpc:${id}`,
      });
    } else {
      useProjectStore.setState((state) => ({
        wsRequests: { [id]: wsRequestWire({ id }) },
        projectOf: { ...state.projectOf, [id]: 'p1' },
      }));
      useEditorsStore.setState({
        tabs: [{ id: `ws:${id}`, kind: 'ws-request', title: 'W', wsRequestId: id }],
        activeId: `ws:${id}`,
      });
    }
    return id;
  }

  it.each([
    ['rest', 'saveRestRequest'],
    ['grpc', 'saveGrpcRequest'],
  ] as const)('item.save on a %s tab asks for a manual save', async (kind, action) => {
    ipcStubs = stubIpc([]);
    const id = seedTab(kind);
    const spy = vi.fn().mockResolvedValue(undefined);
    const original = useProjectStore.getState()[action];
    useProjectStore.setState({ [action]: spy });

    try {
      await runCommand('item.save', context);

      expect(spy).toHaveBeenCalledWith(id, { manual: true });
    } finally {
      useProjectStore.setState({ [action]: original });
    }
  });

  it.each([
    ['rest', (id: string) => useDraftsStore.getState().stageRestRequest(id, { url: '/typed' })],
    ['grpc', (id: string) => useDraftsStore.getState().stageGrpcRequest(id, { message: '{"typed":1}' })],
    ['ws', (id: string) => useDraftsStore.getState().stageWsRequest(id, { url: 'wss://typed.test' })],
  ] as const)(
    'a manual %s save commits its edit under the hold, reviews, and writes only on Save anyway',
    async (kind, stage) => {
      ipcStubs = stubIpc([FINDING]);
      const id = seedTab(kind);
      stage(id);
      const store = useProjectStore.getState();
      const save =
        kind === 'rest' ? store.saveRestRequest : kind === 'grpc' ? store.saveGrpcRequest : store.saveWsRequest;

      let saved!: Promise<void>;
      act(() => {
        saved = save(id, { manual: true });
      });
      await screen.findByRole('alertdialog');
      expect(ipcStubs.hold.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.mutate.mock.invocationCallOrder[0]!);
      expect(ipcStubs.mutate.mock.invocationCallOrder[0]).toBeLessThan(ipcStubs.scan.mock.invocationCallOrder[0]!);
      expect(ipcStubs.save).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
      await saved;

      expect(ipcStubs.save).toHaveBeenCalledWith({ projectId: 'p1' });
      expect(ipcStubs.release).toHaveBeenCalledWith({ holdId: 'hold-1' });
    },
  );
});

describe('the saves nobody asked for never open the review', () => {
  it('a save through the store without `manual` writes straight away', async () => {
    ipcStubs = stubIpc([FINDING]);

    await useProjectStore.getState().save('p1');
    await useProjectStore.getState().saveRequest('req-1');

    expect(ipcStubs.save).toHaveBeenCalledTimes(2);
    expect(ipcStubs.scan).not.toHaveBeenCalled();
    expect(ipcStubs.hold).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('quitting hands the drafts to main and scans nothing', async () => {
    ipcStubs = stubIpc([FINDING]);
    let flush: (() => void) | undefined;
    const on = vi.fn().mockImplementation((name: string, listener: () => void) => {
      if (name === 'workspace.flushDrafts') {
        flush = listener;
      }
      return () => undefined;
    });
    installWirebenchApi({ ...ipcStubs.api, on });
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<unsaved/>' });
    const off = subscribeToDraftStash(() => 'w1');

    flush?.();
    await stashDrafts('w1');
    off();

    expect(ipcStubs.stash).toHaveBeenCalled();
    expect(ipcStubs.scan).not.toHaveBeenCalled();
    expect(ipcStubs.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closing the workspace hands the drafts to main and scans nothing', async () => {
    ipcStubs = stubIpc([FINDING]);
    useWorkspaceStore.setState({ workspace: { id: 'w1' } as never });
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<unsaved/>' });

    await useWorkspaceStore.getState().close();

    expect(ipcStubs.stash).toHaveBeenCalled();
    expect(ipcStubs.close).toHaveBeenCalled();
    expect(ipcStubs.scan).not.toHaveBeenCalled();
    expect(ipcStubs.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
