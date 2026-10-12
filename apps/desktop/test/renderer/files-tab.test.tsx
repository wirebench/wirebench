import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const open = vi.fn();
const list = vi.fn();
const close = vi.fn();
const TAB = 'ssh-files:a';

beforeEach(() => {
  localStorage.clear();
  open.mockReset().mockResolvedValue({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
  list.mockReset().mockResolvedValue({
    ok: true,
    value: { path: '/home/me', entries: [{ name: 'notes.txt', type: 'file', size: 12, mtime: 0, mode: 0o644 }] },
  });
  close.mockReset().mockResolvedValue({ ok: true, value: {} });
  installWirebenchApi({ sftp: { open, list, close } });
  useFilesStore.setState({ panes: {}, showHidden: false });
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    resolved: [],
    sessions: {},
    trustPrompt: null,
  });
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'alpha · Files', hostId: 'a' });
});

afterEach(() => {
  cleanup();
});

it('connects on mount and lists the host’s home folder', async () => {
  render(<FilesTab tabId={TAB} hostId="a" />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  expect(open).toHaveBeenCalledWith({ hostId: 'a' });
});

it('Open terminal opens or focuses the host’s terminal tab', async () => {
  render(<FilesTab tabId={TAB} hostId="a" />);
  fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }));
  expect(useEditorsStore.getState().activeId).toBe('ssh:a');
  expect(useEditorsStore.getState().tabs.map((t) => t.id)).toEqual([TAB, 'ssh:a']);
  await waitFor(() => {
    expect(list).toHaveBeenCalled();
  });
});

it('closing the tab closes its session; a remount while the tab is open keeps it', async () => {
  const first = render(<FilesTab tabId={TAB} hostId="a" />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  first.unmount();
  expect(close).not.toHaveBeenCalled();
  const second = render(<FilesTab tabId={TAB} hostId="a" />);
  expect(open).toHaveBeenCalledTimes(1);
  act(() => {
    useEditorsStore.getState().close(TAB);
  });
  second.unmount();
  expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
});
