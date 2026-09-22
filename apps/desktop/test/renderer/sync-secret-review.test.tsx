import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretReviewDialog } from '../../src/renderer/components/secret-review-dialog.js';
import { SyncPanel } from '../../src/renderer/features/sync/sync-panel.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useSecretReviewStore } from '../../src/renderer/state/secret-review.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { SecretFindingWire, SyncStatusWire } from '../../src/shared/wire-types.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

/** An obviously fake finding: the renderer only ever sees its preview. */
const FINDING: SecretFindingWire = {
  id: 'f1',
  location: { kind: 'soap-header', requestId: 'req-1', name: 'Authorization', index: 0 },
  rule: 'bearer',
  label: 'Orders › Request 1 › header Authorization',
  preview: 'not… (20 chars)',
};

const STATUS: SyncStatusWire = {
  kind: 'git',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 1,
  remote: 'https://example.test/repo.git',
  branch: 'main',
};

function projectWire(id = 'p1') {
  return {
    ...NO_REST,
    id,
    name: 'P',
    dir: `/tmp/${id}`,
    dirty: false,
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

/** The IPC a commit and its review touch; each scan answers the next of `scans` (the last one repeats). */
function stubIpc(...scans: (readonly SecretFindingWire[])[]) {
  let call = 0;
  const scan = vi.fn(() => {
    const findings = scans[Math.min(call, scans.length - 1)] ?? [];
    call += 1;
    return Promise.resolve({
      ok: true as const,
      value: {
        findings: [...findings],
        proposedNames: Object.fromEntries(findings.map((f) => [f.id, 'token'])),
        storedNames: [],
      },
    });
  });
  const keep = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const move = vi.fn().mockResolvedValue({ ok: true, value: { moved: ['f1'], stale: [], nameTaken: [] } });
  const save = vi.fn().mockResolvedValue({ ok: true, value: { saved: true, written: 1, removed: 0 } });
  const commit = vi.fn().mockResolvedValue({ ok: true, value: { ...STATUS, uncommitted: 0, ahead: 1 } });
  const log = vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } });
  const conflicts = vi.fn().mockResolvedValue({ ok: true, value: { conflicts: [] } });
  installWirebenchApi({
    project: { save },
    secretScan: { scan, keep, move },
    sync: { commit, log, conflicts },
  });
  return { scan, keep, move, save, commit };
}

beforeEach(() => {
  showToast.mockClear();
  useDraftsStore.getState().reset();
  useProjectStore.setState({ projects: { p1: projectWire() }, projectOf: {}, saveStatus: {} });
  useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
  useSyncStore.setState({ status: STATUS, conflicts: [] });
  useUiStore.setState({ syncPanelOpen: false, conflictResolverOpen: false });
  render(<SecretReviewDialog />);
});

afterEach(async () => {
  act(() => {
    useSecretReviewStore.getState().cancel();
  });
  await Promise.resolve();
  cleanup();
  useSyncStore.getState().reset();
  useWorkspaceStore.setState({ workspace: null });
  useUiStore.setState({ syncPanelOpen: false, conflictResolverOpen: false });
  vi.restoreAllMocks();
});

describe('a manual commit reviews the open projects for secrets first', () => {
  it('commits without a dialog when nothing is found', async () => {
    const ipc = stubIpc([]);

    await useSyncStore.getState().commit('Add invoices');

    expect(ipc.scan).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(ipc.commit).toHaveBeenCalledWith({ message: 'Add invoices' });
    expect(ipc.scan.mock.invocationCallOrder[0]).toBeLessThan(ipc.commit.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not commit on Cancel', async () => {
    const ipc = stubIpc([FINDING]);

    const committing = useSyncStore.getState().commit();
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await committing;

    expect(ipc.commit).not.toHaveBeenCalled();
  });

  it('commits with the findings on Commit anyway, writing nothing first', async () => {
    const ipc = stubIpc([FINDING]);

    const committing = useSyncStore.getState().commit();
    await screen.findByRole('alertdialog');
    expect(ipc.commit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Commit anyway' }));
    await committing;

    expect(ipc.commit).toHaveBeenCalledTimes(1);
    expect(ipc.keep).not.toHaveBeenCalled();
    expect(ipc.move).not.toHaveBeenCalled();
    expect(ipc.save).not.toHaveBeenCalled();
  });

  it('saves a project a Move rewrote before committing, so the commit takes the token, not the value', async () => {
    const ipc = stubIpc([FINDING], []);

    const committing = useSyncStore.getState().commit();
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Move all' }));
    await committing;

    expect(ipc.move).toHaveBeenCalledTimes(1);
    expect(ipc.save).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(ipc.commit).toHaveBeenCalledTimes(1);
    expect(ipc.save.mock.invocationCallOrder[0]).toBeLessThan(ipc.commit.mock.invocationCallOrder[0]!);
  });

  it('does not save a project for a Keep alone', async () => {
    const ipc = stubIpc([FINDING], []);

    const committing = useSyncStore.getState().commit();
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await committing;

    expect(ipc.keep).toHaveBeenCalledTimes(1);
    expect(ipc.save).not.toHaveBeenCalled();
    expect(ipc.commit).toHaveBeenCalledTimes(1);
  });
});

describe('the Sync panel’s held-commit banner', () => {
  it('is not shown while nothing is held', async () => {
    stubIpc([]);
    render(<SyncPanel />);
    act(() => {
      useUiStore.getState().setSyncPanelOpen(true);
    });

    await screen.findByTestId('sync-panel');
    expect(screen.queryByTestId('sync-held-banner')).toBeNull();
  });

  it('says how many possible secrets hold the commit, and Review opens the commit review', async () => {
    const ipc = stubIpc([FINDING]);
    useSyncStore.setState({ status: { ...STATUS, held: { findings: 2 } } });
    render(<SyncPanel />);
    act(() => {
      useUiStore.getState().setSyncPanelOpen(true);
    });

    const banner = await screen.findByTestId('sync-held-banner');
    expect(banner.textContent).toContain('Commit held — 2 possible secrets');

    await userEvent.click(screen.getByRole('button', { name: 'Review' }));

    await screen.findByRole('alertdialog');
    expect(screen.getByRole('button', { name: 'Commit anyway' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Commit anyway' }));
    // Going ahead from the banner commits now — main takes it in place of the held commit.
    await waitFor(() => {
      expect(ipc.commit).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the singular for one possible secret', async () => {
    stubIpc([FINDING]);
    useSyncStore.setState({ status: { ...STATUS, held: { findings: 1 } } });
    render(<SyncPanel />);
    act(() => {
      useUiStore.getState().setSyncPanelOpen(true);
    });

    expect((await screen.findByTestId('sync-held-banner')).textContent).toContain('Commit held — 1 possible secret');
    expect(screen.getByTestId('sync-held-banner').textContent).not.toContain('secrets');
  });
});
