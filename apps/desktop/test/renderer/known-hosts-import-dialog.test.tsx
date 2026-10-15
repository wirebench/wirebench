import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const knownHostsImportPreview = vi.fn();
const knownHostsImportApply = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { knownHostsImportPreview, knownHostsImportApply } }),
}));
import { KnownHostsImportDialog } from '../../src/renderer/features/ssh/known-hosts-import-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const ED = 'ssh-ed25519';
const PREVIEW = {
  previewId: 'p1',
  source: '~/.ssh/known_hosts',
  add: [{ host: 'web.internal:22', keyType: ED, fingerprint: 'SHA256:new-web', names: ['Web'], line: 3 }],
  conflicts: [
    {
      host: 'db.internal:2222',
      keyType: ED,
      fingerprint: 'SHA256:file-db',
      previous: 'SHA256:stored-db',
      names: ['DB'],
      line: 5,
    },
  ],
  trusted: [{ host: 'ci.internal:22', keyType: ED, fingerprint: 'SHA256:ci', names: ['CI'], line: 4 }],
  unsaved: [] as {
    host: string;
    address: string;
    port: number;
    keys: { keyType: string; fingerprint: string; line: number }[];
  }[],
  skipped: [
    { line: 7, reason: 'cert-authority' },
    { line: 8, reason: 'revoked' },
    { line: 9, reason: 'no-host' },
    { line: 10, reason: 'no-host' },
  ],
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  knownHostsImportPreview.mockResolvedValue({ ok: true, value: PREVIEW });
  knownHostsImportApply.mockResolvedValue({ ok: true, value: { added: 1, replaced: 0, kept: 1, hostsAdded: 0 } });
  useHostsStore.setState({ knownHostsImportOpen: true });
});

async function openReport() {
  render(<KnownHostsImportDialog />);
  await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' }));
  await screen.findByRole('table', { name: 'Keys to trust' });
}

describe('KnownHostsImportDialog', () => {
  it('offers the default file or a picked one, and asks main by source only', async () => {
    render(<KnownHostsImportDialog />);
    knownHostsImportPreview.mockResolvedValueOnce({ ok: true, value: { cancelled: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Choose a file…' }));
    expect(knownHostsImportPreview).toHaveBeenCalledWith({ source: 'pick' });
    expect(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' })).toBeDefined();
  });

  it('shows a read error and stays on the first step', async () => {
    knownHostsImportPreview.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-known-hosts-unreadable', message: '~/.ssh/known_hosts could not be read (ENOENT)' },
    });
    render(<KnownHostsImportDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' }));
    expect((await screen.findByRole('alert')).textContent).toBe('~/.ssh/known_hosts could not be read (ENOENT)');
  });

  it('lists the keys to trust, the conflicts with both fingerprints, and what is not imported', async () => {
    await openReport();
    expect(screen.getByText('web.internal:22')).toBeDefined();
    expect(screen.getByText('SHA256:stored-db')).toBeDefined();
    expect(screen.getByText('SHA256:file-db')).toBeDefined();
    expect(screen.getByText('1 key already trusted.')).toBeDefined();
    const skipped = screen.getByRole('region', { name: 'Not imported' }).textContent ?? '';
    expect(skipped).toContain('@cert-authority');
    expect(skipped).toContain('(line 7)');
    expect(skipped).toContain('@revoked');
    expect(skipped).toContain('Hashed or wildcard names that match no host in hosts.yaml (lines 9, 10)');
  });

  it('trusts the new keys and leaves a conflict alone unless chosen', async () => {
    await openReport();
    const revision = useHostsStore.getState().knownHostsRevision;
    await userEvent.click(screen.getByRole('button', { name: 'Trust 1 key' }));
    expect(knownHostsImportApply).toHaveBeenCalledWith({ previewId: 'p1', replace: [] });
    await waitFor(() => {
      expect(useHostsStore.getState().knownHostsImportOpen).toBe(false);
    });
    // The Known hosts list and the menu count read again.
    expect(useHostsStore.getState().knownHostsRevision).toBe(revision + 1);
  });

  it('replacing a conflict needs the changed-key confirmation first', async () => {
    await openReport();
    await userEvent.click(screen.getByLabelText(`Replace the ${ED} key of db.internal:2222`));
    await userEvent.click(screen.getByRole('button', { name: 'Trust 2 keys' }));
    expect(knownHostsImportApply).not.toHaveBeenCalled();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Replace and trust' });
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText('SHA256:stored-db')).toBeDefined();
    await userEvent.click(screen.getByRole('checkbox', { name: 'I understand these keys changed' }));
    await userEvent.click(confirm);
    expect(knownHostsImportApply).toHaveBeenCalledWith({
      previewId: 'p1',
      replace: [{ host: 'db.internal:2222', keyType: ED }],
    });
  });

  it('goes back to the start when the preview expired', async () => {
    await openReport();
    knownHostsImportApply.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-import-expired', message: 'This import preview has expired; preview the file again' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Trust 1 key' }));
    expect(await screen.findByText('This import preview has expired; preview the file again')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' })).toBeDefined();
  });

  it('with nothing to trust or add, offers only Close', async () => {
    knownHostsImportPreview.mockResolvedValueOnce({ ok: true, value: { ...PREVIEW, add: [], conflicts: [] } });
    render(<KnownHostsImportDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: /^Trust/ })).toBeNull();
    expect(useHostsStore.getState().knownHostsImportOpen).toBe(false);
    expect(knownHostsImportApply).not.toHaveBeenCalled();
  });
});

describe('KnownHostsImportDialog unsaved hosts (#572)', () => {
  const UNSAVED = {
    ...PREVIEW,
    add: [],
    conflicts: [],
    unsaved: [
      {
        host: 'new.example.org:2222',
        address: 'new.example.org',
        port: 2222,
        keys: [
          { keyType: ED, fingerprint: 'SHA256:new-ed', line: 11 },
          { keyType: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:new-ecdsa', line: 12 },
        ],
      },
      { host: 'other.example.org:22', address: 'other.example.org', port: 22, keys: [] },
    ],
  };
  const GROUPS = {
    version: 1 as const,
    hosts: [],
    groups: [{ id: 'lab', name: 'Lab', tags: [], ssh: {}, groups: [], hosts: [] }],
  };

  async function openUnsaved() {
    knownHostsImportPreview.mockResolvedValueOnce({ ok: true, value: UNSAVED });
    render(<KnownHostsImportDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' }));
    return screen.findByRole('region', { name: 'Not in hosts.yaml' });
  }

  beforeEach(() => {
    useHostsStore.setState({ file: GROUPS, refresh: vi.fn().mockResolvedValue(undefined) });
  });

  it('lists each unsaved server with its address, port and keys, none ticked', async () => {
    const region = await openUnsaved();
    expect(region.textContent).toContain('new.example.org');
    expect(region.textContent).toContain('2222');
    expect(region.textContent).toContain('SHA256:new-ed');
    expect(region.textContent).toContain('ecdsa-sha2-nistp256 (line 12)');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Add new.example.org:2222' }).checked).toBe(false);
    // Nothing is added unasked: with none ticked there is nothing to apply.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Trust 0 keys' }).disabled).toBe(true);
  });

  it('adds only the ticked server, into the group picked, and reads the hosts again', async () => {
    knownHostsImportApply.mockResolvedValueOnce({
      ok: true,
      value: { added: 2, replaced: 0, kept: 0, hostsAdded: 1 },
    });
    await openUnsaved();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Add new.example.org:2222' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Add to group' }), 'lab');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 host and trust its keys' }));
    expect(knownHostsImportApply).toHaveBeenCalledWith({
      previewId: 'p1',
      replace: [],
      addHosts: ['new.example.org:2222'],
      group: 'lab',
    });
    await waitFor(() => {
      expect(useHostsStore.getState().refresh).toHaveBeenCalled();
    });
  });

  it('names both when saved hosts gain keys too, and adds to the top level by default', async () => {
    knownHostsImportPreview.mockResolvedValueOnce({ ok: true, value: { ...UNSAVED, add: PREVIEW.add } });
    render(<KnownHostsImportDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Read ~/.ssh/known_hosts' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Add other.example.org:22' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Add new.example.org:2222' }));
    await userEvent.click(screen.getByRole('button', { name: 'Trust 1 key and add 2 hosts' }));
    expect(knownHostsImportApply).toHaveBeenCalledWith({
      previewId: 'p1',
      replace: [],
      addHosts: ['new.example.org:2222', 'other.example.org:22'],
    });
  });
});
