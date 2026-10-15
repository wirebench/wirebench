import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
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

function Tab() {
  return (
    <RadixTooltip.Provider>
      <FilesTab tabId={TAB} hostId="a" />
    </RadixTooltip.Provider>
  );
}

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
    panes: {},
    trustPrompt: null,
  });
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'alpha · Files', hostId: 'a' });
});

afterEach(() => {
  cleanup();
});

it('connects on mount and lists the host’s home folder', async () => {
  render(<Tab />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  expect(open).toHaveBeenCalledWith({ hostId: 'a', attemptId: expect.any(String) as unknown });
});

it('a failed open shows the connection screen with its reason, and Retry connects again', async () => {
  open.mockResolvedValueOnce({
    ok: false,
    error: { code: 'sftp-unavailable', message: 'a.example:22 offers no SFTP', details: { host: 'a.example:22' } },
  });
  render(<Tab />);
  expect((await screen.findByTestId('connect-error')).textContent).toMatch(
    /^Signed in, but a\.example:22 offers no SFTP/,
  );
  expect(screen.getByTestId('connect-step-shell').textContent).toContain('Starting SFTP');
  expect(screen.getByTestId('connect-log')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  expect(open).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('connect-screen')).toBeNull();
});

it('a dropped connection says so, keeps the listing dimmed and makes Reconnect the main button (#590)', async () => {
  render(<Tab />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  const at = new Date(2026, 9, 15, 21, 31).getTime();
  vi.spyOn(Date, 'now').mockReturnValue(at);
  act(() => {
    useFilesStore.getState().noteClosed('s1');
  });
  vi.mocked(Date.now).mockRestore();
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  expect(screen.getByTestId('files-lost').textContent).toContain(`Connection to alpha lost · ${time}`);
  expect(screen.queryByTestId('connect-screen')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit host' })).toBeNull();
  const reconnect = screen.getByRole('button', { name: 'Reconnect' });
  expect(reconnect.className).toMatch(/bg-accent/);
  // The last listing stays in view, dimmed and out of reach.
  const listing = screen.getByTestId('files-lost-listing');
  expect(listing.hasAttribute('inert')).toBe(true);
  expect(listing.textContent).toContain('notes.txt');

  fireEvent.click(reconnect);
  await waitFor(() => {
    expect(screen.queryByTestId('files-lost')).toBeNull();
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  expect(open).toHaveBeenCalledTimes(2);
});

it('Open terminal opens or focuses the host’s terminal tab', async () => {
  render(<Tab />);
  fireEvent.click(screen.getByRole('button', { name: /Open terminal/ }));
  const terminal = useEditorsStore.getState().tabs.find((t) => t.kind === 'ssh-terminal');
  expect(terminal?.panes).toMatchObject({ hostId: 'a' });
  expect(useEditorsStore.getState().activeId).toBe(terminal?.id);
  await waitFor(() => {
    expect(list).toHaveBeenCalled();
  });
});

it('closing the tab closes its session; a remount while the tab is open keeps it', async () => {
  const first = render(<Tab />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  first.unmount();
  expect(close).not.toHaveBeenCalled();
  const second = render(<Tab />);
  expect(open).toHaveBeenCalledTimes(1);
  act(() => {
    useEditorsStore.getState().close(TAB);
  });
  second.unmount();
  expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
});

it('a path that does not exist shows the error under the bar and keeps the listing', async () => {
  render(<Tab />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  list.mockResolvedValueOnce({ ok: false, error: { code: 'sftp-not-found', message: '/nope does not exist' } });
  fireEvent.click(screen.getByTestId('files-path-bar'));
  const input = screen.getByTestId('files-path-input');
  fireEvent.change(input, { target: { value: '/nope' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => {
    expect(screen.getByTestId('files-path-error').textContent).toBe('/nope does not exist');
  });
  expect(screen.getByText('notes.txt')).toBeDefined();
});

it('the hidden toggle shows names starting with a dot', async () => {
  list.mockResolvedValue({
    ok: true,
    value: {
      path: '/home/me',
      entries: [
        { name: 'notes.txt', type: 'file', size: 12, mtime: 0, mode: 0o644 },
        { name: '.bashrc', type: 'file', size: 1, mtime: 0, mode: 0o644 },
      ],
    },
  });
  render(<Tab />);
  await waitFor(() => {
    expect(screen.getByText('notes.txt')).toBeDefined();
  });
  expect(screen.queryByText('.bashrc')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
  expect(screen.getByText('.bashrc')).toBeDefined();
});
