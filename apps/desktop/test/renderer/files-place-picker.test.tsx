import * as RadixTooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileActions } from '../../src/renderer/features/ssh/files/file-actions.js';
import { FilesTab } from '../../src/renderer/features/ssh/files/files-tab.js';
import { localPaneId, useFilesStore } from '../../src/renderer/features/ssh/files/files-store.js';
import { placeOptions } from '../../src/renderer/features/ssh/files/place-picker.js';
import { useTransfersStore } from '../../src/renderer/features/ssh/files/transfers-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { HostsFileWire } from '@wirebench/wire/ssh-wire';
import type { SftpEntryWire } from '@wirebench/wire/sftp-wire';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const TAB = 'ssh-files:a';
const LOCAL = localPaneId(TAB);
const OK = { ok: true, value: {} };
const host = (id: string, name: string) => ({ id, name, address: `${id}.example`, tags: [], ssh: {} });
const FILE = {
  version: 1,
  hosts: [host('d', 'delta'), host('a', 'alpha')],
  groups: [
    {
      id: 'prod',
      name: 'Prod',
      hosts: [host('b', 'beta')],
      groups: [{ id: 'eu', name: 'EU', hosts: [host('c', 'gamma')], groups: [] }],
    },
  ],
} as unknown as HostsFileWire;
const LISTING: Record<string, SftpEntryWire[]> = {
  local: [{ name: 'a.txt', type: 'file', size: 5, mtime: 0 }],
  s1: [{ name: 'alpha.log', type: 'file', size: 1, mtime: 0 }],
  s2: [{ name: 'beta.log', type: 'file', size: 1, mtime: 0 }],
  s3: [{ name: 'third.log', type: 'file', size: 1, mtime: 0 }],
};
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

let sessions = 0;
beforeEach(() => {
  localStorage.clear();
  sessions = 0;
  for (const fn of Object.values(sftp)) fn.mockReset().mockResolvedValue(OK);
  sftp.open.mockImplementation(({ hostId }: { hostId: string }) => {
    sessions += 1;
    return Promise.resolve({ ok: true, value: { sessionId: `s${String(sessions)}`, home: `/home/${hostId}` } });
  });
  sftp.localHome.mockResolvedValue({ ok: true, value: { home: '/Users/me', downloads: '/Users/me/Downloads' } });
  sftp.list.mockImplementation(({ place, path }: { place: { kind: string; sessionId?: string }; path: string }) =>
    Promise.resolve({
      ok: true,
      value: { path, entries: LISTING[place.kind === 'local' ? 'local' : (place.sessionId ?? '')] ?? [] },
    }),
  );
  sftp.copy.mockResolvedValue({ ok: true, value: { transferIds: ['t1'] } });
  installWirebenchApi({ sftp, on: vi.fn(() => () => undefined) });
  useFilesStore.setState({ panes: {}, activePanes: {}, showHidden: false, dialogs: {}, renaming: {} });
  useTransfersStore.setState({ batches: {}, rows: {}, conflicts: {}, closing: {} });
  useEditorsStore.getState().reset();
  useHostsStore.setState({ file: FILE, resolved: [], panes: {}, trustPrompt: null });
  useEditorsStore.getState().open({ id: TAB, kind: 'ssh-files', title: 'alpha · Files', hostId: 'a' });
});

afterEach(() => {
  cleanup();
});

/** The pane whose place picker reads `label`. */
const paneNamed = (label: string) =>
  screen
    .getAllByTestId('files-pane')
    .find((p) => within(p).getByTestId('files-place').textContent.includes(label)) as HTMLElement;

async function mountTab() {
  render(
    <RadixTooltip.Provider>
      <FilesTab tabId={TAB} hostId="a" />
    </RadixTooltip.Provider>,
  );
  await waitFor(() => {
    expect(within(paneNamed('This machine')).getByText('a.txt')).toBeDefined();
    expect(within(paneNamed('alpha')).getByText('alpha.log')).toBeDefined();
  });
}

function openPicker(pane: HTMLElement) {
  const trigger = within(pane).getByTestId('files-place');
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

/** Opens a pane's place picker and chooses the option reading `label`. */
async function pick(pane: HTMLElement, label: string) {
  openPicker(pane);
  const option = await screen.findByRole('menuitem', { name: new RegExp(label) });
  fireEvent.click(option);
}

describe('placeOptions', () => {
  it('lists this machine first, then every host by group path and name', () => {
    expect(placeOptions(FILE, '').map((o) => [o.label, o.path])).toEqual([
      ['This machine', ''],
      ['alpha', ''],
      ['delta', ''],
      ['beta', 'Prod'],
      ['gamma', 'Prod / EU'],
    ]);
  });

  it('filters on the name and the group path, ignoring case', () => {
    expect(placeOptions(FILE, 'eu').map((o) => o.label)).toEqual(['gamma']);
    expect(placeOptions(FILE, 'PROD').map((o) => o.label)).toEqual(['beta', 'gamma']);
    expect(placeOptions(FILE, 'mach').map((o) => o.label)).toEqual(['This machine']);
  });
});

describe('the place picker', () => {
  it('shows the options and narrows them as the filter is typed', async () => {
    await mountTab();
    openPicker(paneNamed('alpha'));
    const filter = await screen.findByRole('textbox', { name: 'Filter places' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'This machine',
      'alpha',
      'delta',
      'betaProd',
      'gammaProd / EU',
    ]);
    fireEvent.change(filter, { target: { value: 'gam' } });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['gammaProd / EU']);
  });

  it("choosing a host opens that pane's own session and closes its previous one", async () => {
    await mountTab();
    await pick(paneNamed('alpha'), 'beta');
    await waitFor(() => {
      expect(within(paneNamed('beta')).getByText('beta.log')).toBeDefined();
    });
    expect(sftp.close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(sftp.open).toHaveBeenLastCalledWith({ hostId: 'b', attemptId: expect.any(String) as unknown });
    expect(useFilesStore.getState().panes[TAB]?.place).toEqual({ kind: 'remote', hostId: 'b', sessionId: 's2' });
    expect(useFilesStore.getState().panes[TAB]?.path).toBe('/home/b');
  });

  it('switches the local pane to a host and back to this machine', async () => {
    await mountTab();
    await pick(paneNamed('This machine'), 'beta');
    await waitFor(() => {
      expect(within(paneNamed('beta')).getByText('beta.log')).toBeDefined();
    });
    expect(sftp.close).not.toHaveBeenCalled();
    await pick(paneNamed('beta'), 'This machine');
    await waitFor(() => {
      expect(within(paneNamed('This machine')).getByText('a.txt')).toBeDefined();
    });
    expect(sftp.close).toHaveBeenCalledWith({ sessionId: 's2' });
    expect(useFilesStore.getState().panes[LOCAL]?.place).toEqual({ kind: 'local' });
  });

  it('both panes on the same host each hold their own session', async () => {
    await mountTab();
    await pick(paneNamed('This machine'), 'alpha');
    await waitFor(() => {
      expect(useFilesStore.getState().panes[LOCAL]?.status).toBe('idle');
    });
    const { panes } = useFilesStore.getState();
    expect(panes[TAB]?.place).toEqual({ kind: 'remote', hostId: 'a', sessionId: 's1' });
    expect(panes[LOCAL]?.place).toEqual({ kind: 'remote', hostId: 'a', sessionId: 's2' });
    expect(sftp.open).toHaveBeenCalledTimes(2);
  });

  it("opens the trust prompt for the pane's own connect, and the retry opens its session", async () => {
    await mountTab();
    sftp.open.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'ssh-host-key-new',
        message: 'New host key',
        details: { host: 'b.example', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' },
      },
    });
    await pick(paneNamed('This machine'), 'beta');
    await waitFor(() => {
      expect(useHostsStore.getState().trustPrompt).toMatchObject({ paneId: LOCAL, hostId: 'b' });
    });
    const prompt = useHostsStore.getState().trustPrompt as unknown as { retry: () => void };
    act(() => {
      prompt.retry();
    });
    await waitFor(() => {
      expect(within(paneNamed('beta')).getByText('beta.log')).toBeDefined();
    });
  });

  it('a session that opens after the pane moved on is closed, not used', async () => {
    await mountTab();
    let finish: (value: unknown) => void = () => undefined;
    sftp.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await pick(paneNamed('alpha'), 'beta');
    await pick(paneNamed('beta'), 'gamma');
    await waitFor(() => {
      expect(useFilesStore.getState().panes[TAB]?.status).toBe('idle');
    });
    await act(async () => {
      finish({ ok: true, value: { sessionId: 'late', home: '/home/b' } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(sftp.close).toHaveBeenCalledWith({ sessionId: 'late' });
    });
    expect(useFilesStore.getState().panes[TAB]?.place).toMatchObject({ hostId: 'c' });
  });

  it('copies between two hosts with both sessions named', async () => {
    await mountTab();
    await pick(paneNamed('This machine'), 'beta');
    await waitFor(() => {
      expect(within(paneNamed('beta')).getByText('beta.log')).toBeDefined();
    });
    act(() => {
      useFilesStore.getState().select(LOCAL, ['beta.log']);
    });
    fileActions.copyToOtherPane(LOCAL);
    await waitFor(() => {
      expect(sftp.copy).toHaveBeenCalled();
    });
    expect(sftp.copy.mock.calls[0]?.[0]).toMatchObject({
      from: { place: { kind: 'remote', sessionId: 's2' }, paths: ['/home/b/beta.log'] },
      to: { place: { kind: 'remote', sessionId: 's1' }, dir: '/home/a' },
    });
  });

  it('closing the tab closes both panes’ sessions', async () => {
    await mountTab();
    await pick(paneNamed('This machine'), 'beta');
    await waitFor(() => {
      expect(within(paneNamed('beta')).getByText('beta.log')).toBeDefined();
    });
    act(() => {
      useFilesStore.getState().close(TAB);
    });
    expect(sftp.close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(sftp.close).toHaveBeenCalledWith({ sessionId: 's2' });
  });
});
