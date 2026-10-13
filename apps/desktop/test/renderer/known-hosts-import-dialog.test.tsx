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
  knownHostsImportApply.mockResolvedValue({ ok: true, value: { added: 1, replaced: 0, kept: 1 } });
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
    expect(skipped).toContain('Names no host in hosts.yaml (lines 9, 10)');
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
});
