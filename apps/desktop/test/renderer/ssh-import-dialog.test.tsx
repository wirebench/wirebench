import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const importPreview = vi.fn();
const importApply = vi.fn();
const secretNames = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { importPreview, importApply, secretNames } }),
}));
import { ImportDialog } from '../../src/renderer/features/ssh/import-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const PREVIEW = {
  previewId: 'p1',
  source: '~/.ssh/config',
  group: { id: 'ssh-config', name: 'SSH config', ssh: { user: 'deploy', auth: { kind: 'agent' } } },
  hosts: [
    {
      alias: 'Web',
      id: 'web-2',
      idChangedFrom: 'web',
      status: 'new',
      address: 'web.internal',
      ssh: { auth: { kind: 'key', ref: 'k1' } },
    },
    {
      alias: 'db',
      id: 'db',
      status: 'duplicate',
      duplicateOf: 'db',
      reason: 'already in hosts.yaml as db',
      address: 'db',
      ssh: {},
    },
  ],
  keys: [{ ref: 'k1', display: '~/.ssh/id_ed25519', hosts: ['web-2'], proposedSecret: 'ssh_key_id_ed25519' }],
  report: {
    problems: [],
    skipped: [{ file: '~/.ssh/config', line: 4, keyword: 'localforward', why: 'not imported' }],
    ignored: [{ keyword: 'identitiesonly', count: 2 }],
    notes: ['Authenticate through the SSH agent (no IdentityFile): db'],
  },
};
const LISTED = { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] };

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  secretNames.mockResolvedValue({ ok: true, value: { names: [{ name: 'team_key', local: false, external: true }] } });
  importPreview.mockResolvedValue({ ok: true, value: PREVIEW });
  importApply.mockResolvedValue({ ok: true, value: { ...LISTED, groupId: 'ssh-config', stored: [] } });
  useHostsStore.setState({ importOpen: true });
});

async function openReport() {
  render(<ImportDialog />);
  await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/config' }));
  await screen.findByRole('table', { name: 'Hosts to import' });
}

describe('ImportDialog', () => {
  it('offers the default config or a picked file, and asks main by source only', async () => {
    render(<ImportDialog />);
    importPreview.mockResolvedValueOnce({ ok: true, value: { cancelled: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Choose a file…' }));
    expect(importPreview).toHaveBeenCalledWith({ source: 'pick' });
    expect(screen.getByRole('button', { name: 'Read ~/.ssh/config' })).toBeDefined();
  });

  it('shows hosts, a changed id, the duplicate switch, skipped lines, ignored options and notes', async () => {
    await openReport();
    expect(screen.getByText('(changed)')).toBeDefined();
    expect(screen.getByText('already in hosts.yaml as db')).toBeDefined();
    expect(screen.getByLabelText('Import db anyway')).toBeDefined();
    expect(screen.getByText('~/.ssh/config:4')).toBeDefined();
    expect(screen.getByText('identitiesonly × 2')).toBeDefined();
    expect(screen.getByText('Authenticate through the SSH agent (no IdentityFile): db')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Import 1 host' })).toBeDefined();
  });

  it('defaults every key to the SSH agent, under the consent line', async () => {
    await openReport();
    expect(screen.getByText(/reads a key file only if you choose to store it/)).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Use the SSH agent' }).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 host' }));
    expect(importApply).toHaveBeenCalledWith({
      previewId: 'p1',
      groupName: 'SSH config',
      importDuplicates: [],
      keys: [{ ref: 'k1', choice: { kind: 'agent' } }],
    });
    await waitFor(() => {
      expect(useHostsStore.getState().importOpen).toBe(false);
    });
  });

  it('stores a key under a valid name, refuses a bad one, and imports a duplicate when asked', async () => {
    await openReport();
    await userEvent.click(screen.getByRole('radio', { name: /Store as workspace secret/ }));
    const name = screen.getByLabelText('Secret name for ~/.ssh/id_ed25519');
    await userEvent.clear(name);
    await userEvent.type(name, '1bad name');
    expect(screen.getByRole('alert').textContent).toMatch(/letters, digits/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Import \d host/ }).disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, 'web_key');
    await userEvent.click(screen.getByLabelText('Import db anyway'));
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 hosts' }));
    expect(importApply).toHaveBeenCalledWith(
      expect.objectContaining({
        importDuplicates: ['db'],
        keys: [{ ref: 'k1', choice: { kind: 'store', secret: 'web_key' } }],
      }),
    );
  });

  it('goes back to the start when the preview expired or hosts.yaml changed', async () => {
    await openReport();
    importApply.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-import-stale', message: 'hosts.yaml changed since the preview; preview again' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 host' }));
    expect(await screen.findByText('hosts.yaml changed since the preview; preview again')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Read ~/.ssh/config' })).toBeDefined();
  });
});
