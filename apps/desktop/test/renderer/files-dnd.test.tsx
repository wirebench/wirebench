import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { useTransfersStore } from '../../src/renderer/features/ssh/files/transfers-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { SftpEntryWire } from '@wirebench/wire/sftp-wire';
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
const sftp = { open: vi.fn(), list: vi.fn(), close: vi.fn(), localHome: vi.fn(), copy: vi.fn() };

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(sftp)) fn.mockReset().mockResolvedValue(OK);
  sftp.open.mockResolvedValue({ ok: true, value: { sessionId: 's1', home: '/home/me' } });
  sftp.localHome.mockResolvedValue({ ok: true, value: { home: '/Users/me', downloads: '/Users/me/Downloads' } });
  sftp.list.mockImplementation(({ place, path }: { place: { kind: string }; path: string }) =>
    Promise.resolve({ ok: true, value: { path, entries: place.kind === 'local' ? LOCAL : REMOTE } }),
  );
  sftp.copy.mockResolvedValue({ ok: true, value: { transferIds: ['t1'] } });
  installWirebenchApi({ sftp });
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
    expect(within(pane('remote')).getByText('notes.txt')).toBeDefined();
  });
}

/** A browser's DataTransfer as far as the panes use it: types, files and data set while dragging. */
function dataTransfer(options: { files?: File[] } = {}) {
  const data = new Map<string, string>();
  const files = options.files ?? [];
  return {
    get types() {
      return [...data.keys(), ...(files.length > 0 ? ['Files'] : [])];
    },
    files,
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

/** Drags a row of one pane and drops it on `target`. */
function drag(from: HTMLElement, target: HTMLElement) {
  const transfer = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });
  fireEvent.dragEnd(from, { dataTransfer: transfer });
}

it('a selection dragged onto the other pane is copied into the folder it shows', async () => {
  await mountTab();
  drag(row('local', 'a.txt'), pane('remote'));
  await waitFor(() => {
    expect(sftp.copy).toHaveBeenCalledWith({
      batchId: expect.any(String) as string,
      from: { place: { kind: 'local' }, paths: ['/Users/me/a.txt'] },
      to: { place: { kind: 'remote', sessionId: 's1' }, dir: '/home/me' },
    });
  });
});

it('dropped onto a folder row of the other pane, it goes into that folder', async () => {
  await mountTab();
  fireEvent.click(row('remote', 'notes.txt'));
  drag(row('remote', 'notes.txt'), row('local', 'photos'));
  await waitFor(() => {
    expect(sftp.copy).toHaveBeenCalledWith({
      batchId: expect.any(String) as string,
      from: { place: { kind: 'remote', sessionId: 's1' }, paths: ['/home/me/notes.txt'] },
      to: { place: { kind: 'local' }, dir: '/Users/me/photos' },
    });
  });
});

it('a drop on the pane it came from does nothing', async () => {
  await mountTab();
  drag(row('local', 'a.txt'), pane('local'));
  drag(row('local', 'a.txt'), row('local', 'photos'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sftp.copy).not.toHaveBeenCalled();
});

it('files dropped from the OS onto the host’s pane are uploaded there by path', async () => {
  await mountTab();
  const transfer = dataTransfer({ files: [new File(['x'], 'x.txt'), new File(['y'], 'y.txt')] });
  fireEvent.dragOver(pane('remote'), { dataTransfer: transfer });
  fireEvent.drop(pane('remote'), { dataTransfer: transfer });
  await waitFor(() => {
    expect(sftp.copy).toHaveBeenCalledWith({
      batchId: expect.any(String) as string,
      from: { place: { kind: 'local' }, paths: ['/dropped/x.txt', '/dropped/y.txt'] },
      to: { place: { kind: 'remote', sessionId: 's1' }, dir: '/home/me' },
    });
  });
});

it('files dropped from the OS onto this machine’s pane do nothing', async () => {
  await mountTab();
  const transfer = dataTransfer({ files: [new File(['x'], 'x.txt')] });
  fireEvent.dragOver(pane('local'), { dataTransfer: transfer });
  fireEvent.drop(pane('local'), { dataTransfer: transfer });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sftp.copy).not.toHaveBeenCalled();
});
