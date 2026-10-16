import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteSecret } = vi.hoisted(() => ({ deleteSecret: vi.fn() }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { deleteSecret } }) }));
import {
  deleteHost,
  deleteHostDescription,
  HostDeleteDialog,
  ownPasswordSecret,
  sessionCount,
  sessionsOf,
} from '../../src/renderer/features/ssh/host-delete.js';
import { useHostDelete } from '../../src/renderer/features/ssh/host-delete-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { HostsFileWire } from '../../src/shared/ssh-wire.js';

const FILE = {
  version: 1,
  groups: [],
  hosts: [
    { id: 'web-1', name: 'web-1', address: '10.0.0.1', tags: [], ssh: {} },
    { id: 'db', name: 'db', address: '10.0.0.2', tags: [], ssh: {} },
  ],
} as unknown as HostsFileWire;

const save = vi.fn<(file: HostsFileWire) => Promise<boolean>>();

/** A one-pane tab on web-1, a split of web-1 and db, and web-1's Files tab. */
function openTabs(): void {
  useEditorsStore.setState({
    tabs: [
      {
        id: 'ssh-terminal:one',
        kind: 'ssh-terminal',
        title: 'web-1',
        panes: { kind: 'pane', paneId: 'p1', hostId: 'web-1' },
      },
      {
        id: 'ssh-terminal:two',
        kind: 'ssh-terminal',
        title: 'mixed',
        panes: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'pane', paneId: 'p2', hostId: 'web-1' },
          b: { kind: 'pane', paneId: 'p3', hostId: 'db' },
        },
      },
      { id: 'ssh-files:web-1', kind: 'ssh-files', title: 'web-1 · Files', hostId: 'web-1' },
    ] as never,
    activeId: 'ssh-terminal:one',
  });
}

beforeEach(() => {
  deleteSecret.mockReset().mockResolvedValue({ ok: true, value: {} });
  save.mockReset().mockResolvedValue(true);
  useHostsStore.setState({ file: FILE, save });
  openTabs();
});
afterEach(() => {
  cleanup();
  useHostDelete.getState().cancel();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
});

describe("a host's open sessions", () => {
  it('counts each terminal pane on the host, in any tab, and its Files tab', () => {
    const sessions = sessionsOf('web-1');
    expect(sessions.panes).toEqual([
      { tabId: 'ssh-terminal:one', paneId: 'p1' },
      { tabId: 'ssh-terminal:two', paneId: 'p2' },
    ]);
    expect(sessions.filesTab).toBe('ssh-files:web-1');
    expect(sessionCount(sessions)).toBe(3);
    expect(sessionCount(sessionsOf('db'))).toBe(1);
    expect(sessionCount(sessionsOf('nowhere'))).toBe(0);
  });

  it('names them in the confirm', () => {
    expect(deleteHostDescription(1)).toBe('1 open session will close.');
    expect(deleteHostDescription(3)).toBe('3 open sessions will close.');
    expect(deleteHostDescription(0)).toContain('No sessions are open on it.');
  });

  it('names the rules that leave each forwarding group', () => {
    expect(deleteHostDescription(1, [{ name: 'Backend', rules: ['redis'] }])).toBe(
      '1 open session will close. Its rule redis leaves forwarding group Backend.',
    );
    expect(
      deleteHostDescription(0, [
        { name: 'Dev', rules: ['pg', 'grafana', 'api'] },
        { name: 'Ops', rules: ['ssh', 'web'] },
      ]),
    ).toBe(
      'It is removed from hosts.yaml. No sessions are open on it. Its rules pg, grafana and api leave forwarding group Dev. Its rules ssh and web leave forwarding group Ops.',
    );
  });
});

describe('deleteHost', () => {
  it('saves the file without the host, then closes its panes and Files tab and nothing else', async () => {
    await deleteHost('web-1');
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].hosts.map((h) => h.id)).toEqual(['db']);
    const { tabs } = useEditorsStore.getState();
    // The one-pane tab and the Files tab close; the split keeps its db pane.
    expect(tabs.map((t) => t.id)).toEqual(['ssh-terminal:two']);
    expect(tabs[0]?.panes).toEqual({ kind: 'pane', paneId: 'p3', hostId: 'db' });
  });

  it('takes its rules out of their forwarding groups in the same save', async () => {
    useHostsStore.setState({
      file: {
        ...FILE,
        forwardGroups: [
          {
            id: 'backend',
            name: 'Backend',
            rules: [
              { host: 'web-1', rule: 'redis' },
              { host: 'db', rule: 'pg' },
            ],
          },
        ],
      },
    });
    await deleteHost('web-1');
    expect(save.mock.calls[0]?.[0].forwardGroups).toEqual([
      { id: 'backend', name: 'Backend', rules: [{ host: 'db', rule: 'pg' }] },
    ]);
  });

  it('closes nothing when the save fails', async () => {
    save.mockResolvedValue(false);
    await deleteHost('web-1');
    expect(useEditorsStore.getState().tabs).toHaveLength(3);
  });
});

describe('HostDeleteDialog', () => {
  it('asks before deleting, and Cancel leaves everything as it was', () => {
    render(<HostDeleteDialog />);
    expect(screen.queryByTestId('host-delete-dialog')).toBeNull();
    act(() => {
      useHostDelete.getState().ask('db');
    });
    const dialog = screen.getByTestId('host-delete-dialog');
    expect(dialog.textContent).toContain('Delete db?');
    expect(dialog.textContent).toContain('1 open session will close.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useHostDelete.getState().hostId).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('names the forwarding groups its rules leave', () => {
    useHostsStore.setState({
      file: { ...FILE, forwardGroups: [{ id: 'backend', name: 'Backend', rules: [{ host: 'db', rule: 'redis' }] }] },
    });
    render(<HostDeleteDialog />);
    act(() => {
      useHostDelete.getState().ask('db');
    });
    expect(screen.getByTestId('host-delete-dialog').textContent).toContain(
      'Its rule redis leaves forwarding group Backend.',
    );
  });

  it("deletes on confirm and closes the host's tabs", async () => {
    render(<HostDeleteDialog />);
    act(() => {
      useHostDelete.getState().ask('web-1');
    });
    expect(screen.getByTestId('host-delete-dialog').textContent).toContain('3 open sessions will close.');
    fireEvent.click(screen.getByTestId('host-delete-confirm'));
    await waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((t) => t.id)).toEqual(['ssh-terminal:two']);
    });
    expect(useHostDelete.getState().hostId).toBeNull();
  });
});

describe("deleting a host's password secret (#594)", () => {
  const withPasswords = (identitySecret?: string): HostsFileWire =>
    ({
      version: 1,
      groups: [],
      hosts: [
        {
          id: 'web-1',
          name: 'web-1',
          address: '10.0.0.1',
          tags: [],
          ssh: { auth: { kind: 'password', secret: 'web_pw' } },
        },
        {
          id: 'db',
          name: 'db',
          address: '10.0.0.2',
          tags: [],
          ssh: { auth: { kind: 'password', secret: 'shared_pw' } },
        },
        {
          id: 'db-2',
          name: 'db-2',
          address: '10.0.0.3',
          tags: [],
          ssh: { auth: { kind: 'password', secret: 'shared_pw' } },
        },
      ],
      ...(identitySecret === undefined
        ? {}
        : { identities: [{ id: 'i', name: 'I', auth: { kind: 'password', secret: identitySecret } }] }),
    }) as unknown as HostsFileWire;

  it('offers only a secret no other host, group or identity names', () => {
    expect(ownPasswordSecret(withPasswords(), 'web-1')).toBe('web_pw');
    expect(ownPasswordSecret(withPasswords(), 'db')).toBeUndefined();
    expect(ownPasswordSecret(withPasswords('web_pw'), 'web-1')).toBeUndefined();
    expect(ownPasswordSecret(FILE, 'web-1')).toBeUndefined();
  });

  it('the confirm deletes the secret only when the box is ticked', async () => {
    useHostsStore.setState({ file: withPasswords() });
    render(<HostDeleteDialog />);
    act(() => {
      useHostDelete.getState().ask('web-1');
    });
    const box = screen.getByTestId<HTMLInputElement>('host-delete-secret');
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('host-delete-dialog').textContent).toContain('Also delete its password secret web_pw');
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('host-delete-confirm'));
    await waitFor(() => {
      expect(deleteSecret).toHaveBeenCalledWith({ name: 'web_pw' });
    });
  });

  it('leaves the secret when the box is not ticked', async () => {
    useHostsStore.setState({ file: withPasswords() });
    await deleteHost('web-1');
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
