import * as RadixTooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: toast }));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { fileActions } from '../../src/renderer/features/ssh/files/file-actions.js';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { getCommand, listCommands, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { SftpEntryWire } from '../../src/shared/sftp-wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const TAB = 'ssh-files:a';
const PLACE = { kind: 'remote', sessionId: 's1' };
const OK = { ok: true, value: {} };
const sftp = {
  open: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  chmod: vi.fn(),
};
let entries: SftpEntryWire[] = [];

beforeEach(() => {
  localStorage.clear();
  toast.mockReset();
  entries = [
    { name: 'logs', type: 'dir', size: 0, mtime: 0, mode: 0o755 },
    { name: 'notes.txt', type: 'file', size: 12, mtime: 0, mode: 0o640 },
  ];
  for (const fn of Object.values(sftp)) fn.mockReset().mockResolvedValue(OK);
  sftp.open.mockResolvedValue({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
  sftp.list.mockImplementation(() => Promise.resolve({ ok: true, value: { path: '/home/me', entries } }));
  installWirebenchApi({ sftp });
  useFilesStore.setState({ panes: {}, showHidden: false, dialogs: {}, renaming: {} });
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [] },
    resolved: [],
    panes: {},
    trustPrompt: null,
  });
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'a · Files', hostId: 'a' });
});

afterEach(() => {
  cleanup();
});

async function mountTab() {
  render(
    <RadixTooltip.Provider>
      <FilesTab tabId={TAB} hostId="a" />
    </RadixTooltip.Provider>,
  );
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
}

const row = (name: string) => screen.getAllByTestId('files-row').find((r) => r.dataset['name'] === name) as HTMLElement;
const list = () => screen.getByTestId('files-list');

describe('rename in place', () => {
  it('F2 renames the selected entry; Enter commits and the pane refreshes', async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    fireEvent.keyDown(list(), { key: 'F2' });
    const field = screen.getByTestId<HTMLInputElement>('files-rename');
    expect(field.value).toBe('notes.txt');
    entries = [entries[0] as SftpEntryWire, { ...(entries[1] as SftpEntryWire), name: 'todo.txt' }];
    fireEvent.change(field, { target: { value: 'todo.txt' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(sftp.rename).toHaveBeenCalledWith({ place: PLACE, from: '/home/me/notes.txt', to: '/home/me/todo.txt' });
    });
    await waitFor(() => {
      expect(useFilesStore.getState().panes[TAB]?.selected).toEqual(['todo.txt']);
    });
    expect(screen.queryByTestId('files-rename')).toBeNull();
  });

  it('Escape cancels', async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    fireEvent.keyDown(list(), { key: 'F2' });
    const field = screen.getByTestId('files-rename');
    fireEvent.change(field, { target: { value: 'other' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByTestId('files-rename')).toBeNull();
    expect(sftp.rename).not.toHaveBeenCalled();
  });

  it('refuses an empty name or one containing /', async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    fireEvent.keyDown(list(), { key: 'F2' });
    const field = screen.getByTestId('files-rename');
    for (const value of ['', 'a/b']) {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(field.getAttribute('aria-invalid')).toBe('true');
    }
    expect(screen.getByTestId('files-rename')).toBeDefined();
    expect(sftp.rename).not.toHaveBeenCalled();
  });

  it('a refused rename shows the reason as a toast', async () => {
    sftp.rename.mockResolvedValueOnce({ ok: false, error: { code: 'sftp-exists', message: '/home/me/logs exists' } });
    await mountTab();
    fireEvent.click(row('notes.txt'));
    fireEvent.keyDown(list(), { key: 'F2' });
    const field = screen.getByTestId('files-rename');
    fireEvent.change(field, { target: { value: 'logs' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith('/home/me/logs exists');
    });
    expect(sftp.list.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('delete', () => {
  it('Delete asks, listing the names and saying folders go with their contents', async () => {
    await mountTab();
    fireEvent.click(row('logs'));
    fireEvent.click(row('notes.txt'), { metaKey: true });
    fireEvent.keyDown(list(), { key: 'Delete' });
    const dialog = screen.getByTestId('files-delete');
    expect(within(dialog).getByText('logs')).toBeDefined();
    expect(within(dialog).getByText('notes.txt')).toBeDefined();
    expect(within(dialog).getByText(/Folders are deleted with everything in them/)).toBeDefined();
    fireEvent.click(screen.getByTestId('files-delete-confirm'));
    await waitFor(() => {
      expect(sftp.remove).toHaveBeenCalledWith({
        place: PLACE,
        paths: ['/home/me/logs', '/home/me/notes.txt'],
        recursive: true,
      });
    });
  });

  it('a file alone says nothing about folders', async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    fireEvent.keyDown(list(), { key: 'Delete' });
    expect(screen.queryByText(/Folders are deleted/)).toBeNull();
  });
});

describe('new folder and permissions', () => {
  it('New folder makes a free name, selects it and starts renaming it', async () => {
    entries.push({ name: 'New folder', type: 'dir', size: 0, mtime: 0, mode: 0o755 });
    await mountTab();
    entries = [...entries, { name: 'New folder 2', type: 'dir', size: 0, mtime: 0, mode: 0o755 }];
    act(() => {
      fileActions.newFolder(TAB);
    });
    await waitFor(() => {
      expect(screen.getByTestId<HTMLInputElement>('files-rename').value).toBe('New folder 2');
    });
    expect(sftp.mkdir).toHaveBeenCalledWith({ place: PLACE, path: '/home/me/New folder 2' });
    expect(useFilesStore.getState().panes[TAB]?.selected).toEqual(['New folder 2']);
  });

  it('Permissions… sends the new mode', async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    act(() => {
      fileActions.permissions(TAB);
    });
    fireEvent.change(screen.getByLabelText('Octal mode'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(sftp.chmod).toHaveBeenCalledWith({ place: PLACE, path: '/home/me/notes.txt', mode: 0o600 });
    });
  });
});

describe('the sftp commands', () => {
  beforeEach(() => {
    resetCommands();
    registerSshCommands(vi.fn());
  });

  it('are listed only while a Files tab is in front', async () => {
    await mountTab();
    const ids = () =>
      listCommands({} as never)
        .map((c) => c.id)
        .filter((id) => id.startsWith('sftp.'));
    expect(ids().sort()).toEqual(
      [
        'sftp.refresh',
        'sftp.newFolder',
        'sftp.rename',
        'sftp.delete',
        'sftp.permissions',
        'sftp.copyToOtherPane',
        'sftp.toggleHidden',
        'sftp.focusPathBar',
      ].sort(),
    );
    act(() => {
      useEditorsStore.getState().showStart();
    });
    expect(ids()).toEqual([]);
  });

  it('sftp.focusPathBar (⌘L) opens the path field; sftp.toggleHidden flips the toggle', async () => {
    await mountTab();
    expect(getCommand('sftp.focusPathBar')?.shortcut).toBe('Mod+L');
    await act(async () => {
      await runCommand('sftp.focusPathBar', {} as never);
    });
    expect(document.activeElement).toBe(screen.getByTestId('files-path-input'));
    await act(async () => {
      await runCommand('sftp.toggleHidden', {} as never);
    });
    expect(useFilesStore.getState().showHidden).toBe(true);
  });
});

describe('the toolbar (#537)', () => {
  const tool = (name: string) =>
    within(screen.getByTestId('files-toolbar')).getByRole<HTMLButtonElement>('button', { name });

  it('acts on the selection of the pane in use, each button only when the selection allows it', async () => {
    await mountTab();
    expect(tool('New folder').disabled).toBe(false);
    expect(tool('Rename').disabled).toBe(true);
    expect(tool('Delete…').disabled).toBe(true);
    fireEvent.click(row('notes.txt'));
    expect(tool('Rename').disabled).toBe(false);
    expect(tool('Copy to other pane').disabled).toBe(false);
    fireEvent.click(tool('Permissions…'));
    expect(useFilesStore.getState().dialogs[TAB]).toMatchObject({ kind: 'permissions', name: 'notes.txt' });
    act(() => {
      useFilesStore.getState().setDialog(TAB, undefined);
    });
    fireEvent.click(tool('Delete…'));
    expect(useFilesStore.getState().dialogs[TAB]).toMatchObject({ kind: 'delete', names: ['notes.txt'] });
  });

  it("dims the selection of the pane not in use, and this machine's pane has no Permissions", async () => {
    await mountTab();
    fireEvent.click(row('notes.txt'));
    expect(row('notes.txt').className).toContain('var(--color-accent)');
    act(() => {
      useFilesStore.getState().setActivePane(`${TAB}#local`);
    });
    expect(row('notes.txt').className).toContain('var(--color-hairline-strong)');
    expect(within(screen.getByTestId('files-toolbar')).queryByRole('button', { name: 'Permissions…' })).toBeNull();
  });
});
