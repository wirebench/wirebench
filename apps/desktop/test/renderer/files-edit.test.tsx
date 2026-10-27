import * as RadixTooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditsStore } from '../../src/renderer/features/ssh/files/edits-store.js';
import { fileActions } from '../../src/renderer/features/ssh/files/file-actions.js';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useTransfersStore } from '../../src/renderer/features/ssh/files/transfers-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { EDIT_ASK_ABOVE_BYTES } from '@wirebench/wire/sftp-defaults';
import type { SftpEditEvent, SftpEntryWire } from '@wirebench/wire/sftp-wire';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const TAB = 'ssh-files:a';
const OK = { ok: true, value: {} };
const LOCAL: SftpEntryWire[] = [{ name: 'a.txt', type: 'file', size: 5, mtime: 0 }];
const REMOTE: SftpEntryWire[] = [
  { name: 'logs', type: 'dir', size: 0, mtime: 0, mode: 0o755 },
  { name: 'app.conf', type: 'file', size: 12, mtime: 0, mode: 0o640 },
  { name: 'huge.log', type: 'file', size: EDIT_ASK_ABOVE_BYTES + 1, mtime: 0, mode: 0o640 },
];
const sftp = {
  open: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  localHome: vi.fn(),
  edit: vi.fn(),
  editReply: vi.fn(),
  endEdit: vi.fn(),
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
  sftp.edit.mockResolvedValue({ ok: true, value: { editId: 'e1' } });
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
  useEditsStore.setState({ edits: {}, large: {} });
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
const row = (place: 'local' | 'remote', name: string) =>
  within(pane(place))
    .getAllByTestId('files-row')
    .find((r) => r.dataset['name'] === name) as HTMLElement;

async function mountTab() {
  render(
    <RadixTooltip.Provider>
      <FilesTab tabId={TAB} hostId="a" />
    </RadixTooltip.Provider>,
  );
  await waitFor(() => {
    expect(within(pane('local')).getByText('a.txt')).toBeDefined();
    expect(within(pane('remote')).getByText('app.conf')).toBeDefined();
  });
}

function emit(payload: SftpEditEvent): void {
  act(() => {
    listeners.get('sftp.edit')?.(payload);
  });
}

/** Opens app.conf with Enter, as the list's keyboard does, and waits for the banner. */
async function editAppConf(): Promise<void> {
  fireEvent.click(row('remote', 'app.conf'));
  fireEvent.keyDown(within(pane('remote')).getByTestId('files-list'), { key: 'Enter' });
  await waitFor(() => {
    expect(screen.getByTestId('files-edit-banner')).toBeDefined();
  });
}

describe('Files: editing in the system editor', () => {
  it('Enter on a host’s file calls sftp.edit with the session and its path', async () => {
    await mountTab();
    await editAppConf();
    expect(sftp.edit).toHaveBeenCalledWith({ sessionId: 's1', path: '/home/me/app.conf' });
  });

  it('a folder still opens, and a file of this machine is not edited', async () => {
    await mountTab();
    fireEvent.doubleClick(row('local', 'a.txt'));
    fireEvent.doubleClick(row('remote', 'logs'));
    await waitFor(() => {
      expect(sftp.list).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/me/logs' }));
    });
    expect(sftp.edit).not.toHaveBeenCalled();
  });

  it('Open / Edit edits the one selected file', async () => {
    await mountTab();
    act(() => {
      useFilesStore.getState().select(TAB, ['app.conf']);
    });
    fileActions.open(TAB);
    await waitFor(() => {
      expect(sftp.edit).toHaveBeenCalledWith({ sessionId: 's1', path: '/home/me/app.conf' });
    });
  });

  it('a file above 50 MB asks first, then sends confirmedLarge', async () => {
    await mountTab();
    fireEvent.doubleClick(row('remote', 'huge.log'));
    const dialog = await screen.findByTestId('files-edit-large');
    expect(sftp.edit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('files-edit-large-ok'));
    await waitFor(() => {
      expect(sftp.edit).toHaveBeenCalledWith({ sessionId: 's1', path: '/home/me/huge.log', confirmedLarge: true });
    });
  });

  it('declining the large-file question edits nothing', async () => {
    await mountTab();
    fireEvent.doubleClick(row('remote', 'huge.log'));
    await screen.findByTestId('files-edit-large');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('files-edit-large')).toBeNull();
    });
    expect(sftp.edit).not.toHaveBeenCalled();
  });

  it('a refused edit shows no banner', async () => {
    sftp.edit.mockResolvedValue({ ok: false, error: { code: 'sftp-edit-open-failed', message: 'No app opens it' } });
    await mountTab();
    fireEvent.doubleClick(row('remote', 'app.conf'));
    await waitFor(() => {
      expect(sftp.edit).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('files-edit-banner')).toBeNull();
  });

  it('the banner counts open edits and shows each file’s last state', async () => {
    sftp.edit.mockResolvedValueOnce({ ok: true, value: { editId: 'e1' } });
    sftp.edit.mockResolvedValueOnce({ ok: true, value: { editId: 'e2' } });
    await mountTab();
    await editAppConf();
    expect(screen.getByTestId('files-edit-banner').textContent).toContain('1 file open in an editor · uploads on save');
    fireEvent.doubleClick(row('remote', 'huge.log'));
    fireEvent.click(await screen.findByTestId('files-edit-large-ok'));
    await waitFor(() => {
      expect(screen.getByTestId('files-edit-banner').textContent).toContain('2 files open in an editor');
    });
    const first = () => screen.getAllByTestId('files-edit')[0] as HTMLElement;
    emit({ editId: 'e1', state: 'uploading' });
    expect(first().dataset['state']).toBe('uploading');
    emit({ editId: 'e1', state: 'uploaded' });
    expect(first().textContent).toContain('Uploaded');
    emit({ editId: 'e1', state: 'failed', error: { code: 'sftp-permission-denied', message: 'Permission denied' } });
    expect(first().textContent).toContain('Permission denied');
  });

  it('remote-changed shows Overwrite and Keep remote inline and sends the answer', async () => {
    await mountTab();
    await editAppConf();
    emit({ editId: 'e1', state: 'remote-changed' });
    fireEvent.click(within(screen.getByTestId('files-edit')).getByRole('button', { name: 'Overwrite' }));
    expect(sftp.editReply).toHaveBeenCalledWith({ editId: 'e1', decision: 'overwrite' });
    emit({ editId: 'e1', state: 'remote-changed' });
    fireEvent.click(within(screen.getByTestId('files-edit')).getByRole('button', { name: 'Keep remote' }));
    expect(sftp.editReply).toHaveBeenLastCalledWith({ editId: 'e1', decision: 'keep-remote' });
    expect(screen.getByTestId('files-edit').dataset['state']).toBe('kept');
  });

  it('Stop editing calls sftp.endEdit and the banner goes', async () => {
    await mountTab();
    await editAppConf();
    fireEvent.click(within(screen.getByTestId('files-edit')).getByRole('button', { name: 'Stop editing' }));
    expect(sftp.endEdit).toHaveBeenCalledWith({ editId: 'e1' });
    expect(screen.queryByTestId('files-edit-banner')).toBeNull();
  });

  it('the session closing drops its edits', async () => {
    await mountTab();
    await editAppConf();
    act(() => {
      listeners.get('sftp.closed')?.({ sessionId: 's1' });
    });
    expect(screen.queryByTestId('files-edit-banner')).toBeNull();
  });

  it('closing the tab ends every edit', async () => {
    await mountTab();
    await editAppConf();
    act(() => {
      useEditorsStore.getState().close(TAB);
    });
    cleanup();
    expect(sftp.endEdit).toHaveBeenCalledWith({ editId: 'e1' });
    expect(useEditsStore.getState().edits).toEqual({});
  });
});
