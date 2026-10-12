import * as RadixTooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileActions } from '../../src/renderer/features/ssh/files/file-actions.js';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { localPaneId, useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useTransfersStore } from '../../src/renderer/features/ssh/files/transfers-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { SftpConflictEvent, SftpEntryWire, SftpTransferEvent } from '../../src/shared/sftp-wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const TAB = 'ssh-files:a';
const OK = { ok: true, value: {} };
const LOCAL: SftpEntryWire[] = [
  { name: 'photos', type: 'dir', size: 0, mtime: 0 },
  { name: 'a.txt', type: 'file', size: 5, mtime: 0 },
];
const REMOTE: SftpEntryWire[] = [
  { name: 'logs', type: 'dir', size: 0, mtime: 0, mode: 0o755 },
  { name: 'notes.txt', type: 'file', size: 12, mtime: 0, mode: 0o640 },
];
const sftp = {
  open: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  localHome: vi.fn(),
  copy: vi.fn(),
  resolve: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
};
const listeners = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(sftp)) fn.mockReset().mockResolvedValue(OK);
  sftp.open.mockResolvedValue({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
  sftp.localHome.mockResolvedValue({ ok: true, value: { home: '/Users/me', downloads: '/Users/me/Downloads' } });
  sftp.list.mockImplementation(({ place, path }: { place: { kind: string }; path: string }) =>
    Promise.resolve({ ok: true, value: { path, entries: place.kind === 'local' ? LOCAL : REMOTE } }),
  );
  sftp.copy.mockResolvedValue({ ok: true, value: { transferIds: ['t1'] } });
  listeners.clear();
  installWirebenchApi({
    sftp,
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
  });
  useFilesStore.setState({ panes: {}, activePanes: {}, showHidden: false, dialogs: {}, renaming: {} });
  useTransfersStore.setState({ batches: {}, rows: {}, conflicts: {}, closing: {} });
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    resolved: [],
    panes: {},
    trustPrompt: null,
  });
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'alpha · Files', hostId: 'a' });
});

afterEach(() => {
  cleanup();
});

const pane = (place: 'local' | 'remote') =>
  screen.getAllByTestId('files-pane').find((p) => p.dataset['place'] === place) as HTMLElement;

async function mountTab() {
  render(
    <RadixTooltip.Provider>
      <FilesTab tabId={TAB} hostId="a" />
    </RadixTooltip.Provider>,
  );
  await waitFor(() => {
    expect(within(pane('local')).getByText('a.txt')).toBeDefined();
    expect(within(pane('remote')).getByText('notes.txt')).toBeDefined();
  });
}

/** Copies the local a.txt to the host, as "Copy to other pane" does; returns the batch id main is given. */
async function copyA(): Promise<string> {
  act(() => {
    useFilesStore.getState().select(localPaneId(TAB), ['a.txt']);
  });
  fileActions.copyToOtherPane(localPaneId(TAB));
  await waitFor(() => {
    expect(sftp.copy).toHaveBeenCalled();
  });
  return (sftp.copy.mock.calls.at(-1)?.[0] as { batchId: string }).batchId;
}

function emit(name: 'sftp.transfer', payload: SftpTransferEvent): void;
function emit(name: 'sftp.conflict', payload: SftpConflictEvent): void;
function emit(name: string, payload: unknown): void {
  act(() => {
    listeners.get(name)?.(payload);
  });
}

const transfer = (batchId: string, change: Partial<SftpTransferEvent> = {}): SftpTransferEvent => ({
  transferId: 't1',
  batchId,
  name: 'a.txt',
  state: 'running',
  done: 2,
  total: 5,
  bytesPerSecond: 2048,
  ...change,
});

describe('the local pane', () => {
  it('lists this machine’s home folder without a session', async () => {
    await mountTab();
    expect(sftp.list).toHaveBeenCalledWith({ place: { kind: 'local' }, path: '/Users/me' });
    expect(sftp.open).toHaveBeenCalledTimes(1);
    expect(within(pane('local')).getByText('This machine')).toBeDefined();
  });

  it('Copy to other pane copies the selection into the folder the other pane shows', async () => {
    await mountTab();
    const batchId = await copyA();
    expect(sftp.copy).toHaveBeenCalledWith({
      batchId,
      from: { place: { kind: 'local' }, paths: ['/Users/me/a.txt'] },
      to: { place: { kind: 'remote', sessionId: 's1' }, dir: '/home/me' },
    });
  });
});

describe('the transfers strip', () => {
  it('shows each transfer with its target; Cancel, Retry and Clear done act on them', async () => {
    await mountTab();
    expect(screen.queryByTestId('files-transfers')).toBeNull();
    const batchId = await copyA();
    emit('sftp.transfer', transfer(batchId));
    const strip = screen.getByTestId('files-transfers');
    expect(within(strip).getByText('a.txt')).toBeDefined();
    expect(within(strip).getByText(/→ \/home\/me/)).toBeDefined();
    expect(within(strip).getByText('2.0 KB/s')).toBeDefined();
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel' }));
    expect(sftp.cancel).toHaveBeenCalledWith({ transferId: 't1' });

    emit(
      'sftp.transfer',
      transfer(batchId, { state: 'failed', error: { code: 'sftp-permission-denied', message: 'refused' } }),
    );
    expect(within(strip).getByText('refused')).toBeDefined();
    expect(within(strip).queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: 'Retry' }));
    expect(sftp.retry).toHaveBeenCalledWith({ transferId: 't1' });

    emit('sftp.transfer', transfer(batchId, { transferId: 't2', name: 'b.txt', state: 'done', done: 5 }));
    expect(within(strip).getAllByTestId('files-transfer')).toHaveLength(2);
    fireEvent.click(within(strip).getByRole('button', { name: 'Clear done' }));
    // The failed row stays, with its Retry.
    expect(
      within(strip)
        .getAllByTestId('files-transfer')
        .map((r) => r.dataset['state']),
    ).toEqual(['failed']);
  });

  it('refreshes the receiving pane once its batch is through', async () => {
    await mountTab();
    const batchId = await copyA();
    const remoteLists = () =>
      sftp.list.mock.calls.filter(([request]) => (request as { place: { kind: string } }).place.kind === 'remote')
        .length;
    const before = remoteLists();
    emit('sftp.transfer', transfer(batchId));
    expect(remoteLists()).toBe(before);
    emit('sftp.transfer', transfer(batchId, { state: 'done', done: 5 }));
    await waitFor(() => {
      expect(remoteLists()).toBe(before + 1);
    });
  });

  it('ignores events of a batch this window did not start', async () => {
    await mountTab();
    emit('sftp.transfer', transfer('elsewhere'));
    expect(screen.queryByTestId('files-transfers')).toBeNull();
  });
});

describe('the conflict dialog', () => {
  const conflict = (batchId: string, remaining: number): SftpConflictEvent => ({
    batchId,
    transferId: 't1',
    name: 'a.txt',
    existing: { size: 3, mtime: Date.UTC(2026, 0, 1) },
    incoming: { size: 5, mtime: Date.UTC(2026, 5, 1) },
    remaining,
  });

  it('shows both sides; the box for the other clashes answers them too', async () => {
    await mountTab();
    const batchId = await copyA();
    emit('sftp.conflict', conflict(batchId, 2));
    const dialog = screen.getByTestId('files-conflict');
    expect(within(dialog).getByText('a.txt already exists')).toBeDefined();
    const sides = within(dialog).getAllByTestId('files-conflict-side');
    expect(within(sides[0] as HTMLElement).getByText('3 B')).toBeDefined();
    expect(within(sides[1] as HTMLElement).getByText('5 B')).toBeDefined();
    fireEvent.click(within(dialog).getByLabelText('Do this for the 2 other clashes'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(sftp.resolve).toHaveBeenCalledWith({ batchId, decision: 'replace', applyToRest: true });
    expect(screen.queryByTestId('files-conflict')).toBeNull();
  });

  it('offers no box when no other clash remains, and Escape answers Skip', async () => {
    await mountTab();
    const batchId = await copyA();
    emit('sftp.conflict', conflict(batchId, 0));
    const dialog = screen.getByTestId('files-conflict');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(sftp.resolve).toHaveBeenCalledWith({ batchId, decision: 'skip', applyToRest: false });
  });

  it('Keep both answers keep-both for this clash only', async () => {
    await mountTab();
    const batchId = await copyA();
    emit('sftp.conflict', conflict(batchId, 1));
    fireEvent.click(within(screen.getByTestId('files-conflict')).getByRole('button', { name: 'Keep both' }));
    expect(sftp.resolve).toHaveBeenCalledWith({ batchId, decision: 'keep-both', applyToRest: false });
  });
});

describe('closing the tab', () => {
  it('with copies running, asks first, then cancels them and closes', async () => {
    await mountTab();
    const batchId = await copyA();
    emit('sftp.transfer', transfer(batchId));
    act(() => {
      useEditorsStore.getState().close(TAB);
    });
    expect(useEditorsStore.getState().tabs.some((t) => t.id === TAB)).toBe(true);
    const ask = screen.getByTestId('files-close-confirm');
    fireEvent.click(within(ask).getByTestId('files-close-confirm-ok'));
    expect(sftp.cancel).toHaveBeenCalledWith({ transferId: 't1' });
    expect(useEditorsStore.getState().tabs.some((t) => t.id === TAB)).toBe(false);
  });

  it('with nothing running, closes at once', async () => {
    await mountTab();
    const batchId = await copyA();
    emit('sftp.transfer', transfer(batchId, { state: 'done', done: 5 }));
    act(() => {
      useEditorsStore.getState().close(TAB);
    });
    expect(useEditorsStore.getState().tabs.some((t) => t.id === TAB)).toBe(false);
    expect(screen.queryByTestId('files-close-confirm')).toBeNull();
  });
});
